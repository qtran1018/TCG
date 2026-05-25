import asyncio
import json
import logging
import re
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import select, desc, func, or_
from sqlalchemy.ext.asyncio import AsyncSession
from app.database import get_db
from app.models.card import Card, ScanHistory
from app.schemas.card import (
    BatchPricesItem,
    BatchPricesItemSlim,
    BatchPricesRequest,
    BatchPricesResponse,
    CardOut,
    CardOutLite,
    CardWithPrice,
    HistoryEntry,
    PriceOut,
    PriceOutSlim,
    ScanHistoryCreate,
)
from app.services import matcher as _matcher

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/cards", tags=["cards"])


@router.get("/search", response_model=list[CardOutLite])
async def search_cards(
    q: str = Query(..., min_length=2, max_length=100),
    language: str = Query("en"),
    game: str = Query("pokemon"),
    limit: int = Query(20, le=50),
    db: AsyncSession = Depends(get_db),
):
    q_lower = q.strip().lower()
    if not q_lower:
        return []

    lang = "ja" if language == "ja" else "en"
    tokens = q_lower.split()

    # Separate exclusion terms (e.g. "-detective" → exclude "detective" from name)
    exclude_terms = [t[1:] for t in tokens if t.startswith("-") and len(t) > 1]
    tokens = [t for t in tokens if not t.startswith("-")]

    # If last token is a pure number, treat it as a card number filter
    card_num: str | None = None
    if tokens and re.fullmatch(r"\d+", tokens[-1]):
        card_num = tokens[-1]
        tokens = tokens[:-1]
    q_lower = " ".join(tokens) if tokens else q_lower

    # If the query is only exclusion terms, return empty (nothing to search for)
    if not tokens and not card_num:
        return []

    first_token = tokens[0] if tokens else q_lower
    set_hint = " ".join(tokens[1:]) if len(tokens) >= 2 else None

    if lang == "en":
        sim_name = func.similarity(func.lower(Card.name), q_lower)
        sim_set = func.similarity(func.lower(Card.set_name), q_lower)
        if len(tokens) >= 2:
            first_word_match = func.similarity(
                first_token, func.split_part(func.lower(Card.name), " ", 1)
            )
            name_score = sim_name * first_word_match
            # Additively boost cards whose set name matches the non-name tokens
            # e.g. "suicune prism" → "prism" boosts Prismatic Evolutions cards
            sim_set_hint = func.word_similarity(set_hint, func.lower(Card.set_name))
            score = name_score + sim_set_hint * 0.5
        else:
            name_score = sim_name
            score = name_score
        score = func.greatest(score, sim_set * 0.6)
        base_where = [Card.game == game, Card.language == "en", or_(sim_name > 0.1, sim_set > 0.2)]
        if card_num:
            base_where.append(or_(Card.card_number == card_num, Card.card_number.ilike(f"{card_num}/%")))
        for ex in exclude_terms:
            base_where.append(~func.lower(Card.name).ilike(f"%{ex}%"))
        stmt = (
            select(Card)
            .where(*base_where)
            .order_by(score.desc())
            .limit(limit)
        )
    else:
        sim_en = func.similarity(func.lower(Card.name), q_lower)
        sim_ja = func.coalesce(func.similarity(Card.name_ja, q_lower), 0.0)
        sim_set = func.similarity(func.lower(Card.set_name), q_lower)
        if len(tokens) >= 2:
            first_word_match = func.similarity(
                first_token, func.split_part(func.lower(Card.name), " ", 1)
            )
            name_score = func.greatest(sim_en, sim_ja) * first_word_match
            sim_set_hint = func.word_similarity(set_hint, func.lower(Card.set_name))
            best = name_score + sim_set_hint * 0.5
        else:
            name_score = func.greatest(sim_en, sim_ja)
            best = name_score
        best = func.greatest(best, sim_set * 0.6)
        base_where = [
            Card.game == game,
            Card.language == "ja",
            or_(sim_en > 0.1, sim_ja > 0.1, sim_set > 0.2),
        ]
        if card_num:
            base_where.append(or_(Card.card_number == card_num, Card.card_number.ilike(f"{card_num}/%")))
        for ex in exclude_terms:
            base_where.append(~func.lower(Card.name).ilike(f"%{ex}%"))
        stmt = (
            select(Card)
            .where(*base_where)
            .order_by(best.desc())
            .limit(limit)
        )

    rows = await db.execute(stmt)
    return [CardOutLite.model_validate(c) for c in rows.scalars().all()]


@router.get("/{card_id}", response_model=CardWithPrice)
async def get_card(
    card_id: int,
    scan_type: str = "raw",
    language: str | None = None,
    card_number: str | None = None,
    force_refresh: bool = Query(False),
    skip_price: bool = Query(False),
    variant: str = Query("normal"),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Card).where(Card.id == card_id))
    card = result.scalar_one_or_none()
    if not card:
        raise HTTPException(status_code=404, detail="Card not found")

    if skip_price:
        return CardWithPrice(card=CardOut.model_validate(card), price=None)

    # Fetch fresh price (cached internally). Pass scan language to override card.language
    # for price URL building — e.g. Japanese scan of an English-stored card.
    # ja_card_number is the OCR-read number from the physical card; the English DB
    # record may carry a different number so the JP PriceCharting URL needs the OCR value.
    price_dict = await _matcher.get_prices(
        card, scan_type,
        language_override=language,
        ja_card_number=card_number if language == "ja" else None,
        force_refresh=force_refresh,
        variant=variant,
    )
    await db.commit()

    price_out = None
    if price_dict:
        price_out = PriceOut(
            **price_dict,
            fetched_at=datetime.utcnow(),
        )

    return CardWithPrice(card=CardOut.model_validate(card), price=price_out)


@router.post("/prices", response_model=BatchPricesResponse)
async def batch_prices(req: BatchPricesRequest, db: AsyncSession = Depends(get_db)):
    """Fetch prices for multiple cards in one call.

    Cache hits resolve immediately in parallel; cache misses serialize through
    the scraper's rate limiter (3s/domain), so worst-case latency is
    `(misses) * rate_limit + slowest_scrape`. Mobile saves the N HTTP
    round-trips of calling /cards/{id} one at a time.
    """
    card_ids = list(dict.fromkeys(req.card_ids))[:25]  # de-dupe, cap
    if not card_ids:
        return BatchPricesResponse(items=[])

    result = await db.execute(select(Card).where(Card.id.in_(card_ids)))
    cards_by_id: dict[int, Card] = {c.id: c for c in result.scalars().all()}

    async def fetch_one(card_id: int) -> BatchPricesItem:
        card = cards_by_id.get(card_id)
        if not card:
            return BatchPricesItem(card_id=card_id, error="not_found")
        try:
            ja_card_number = req.ja_card_numbers.get(card_id) if req.ja_card_numbers else None
            price_dict = await _matcher.get_prices(
                card, req.scan_type,
                language_override=card.language,
                ja_card_number=ja_card_number if card.language == "ja" else None,
            )
        except Exception as e:
            logger.exception("Batch price fetch failed for card %d", card_id)
            return BatchPricesItem(
                card_id=card_id,
                card=CardOut.model_validate(card),
                error=type(e).__name__,
            )
        price_out = (
            PriceOut(**price_dict, fetched_at=datetime.utcnow()) if price_dict else None
        )
        return BatchPricesItem(
            card_id=card_id,
            card=CardOut.model_validate(card),
            price=price_out,
        )

    items = await asyncio.gather(*[fetch_one(cid) for cid in card_ids])
    await db.commit()
    return BatchPricesResponse(items=list(items))


@router.post("/prices/stream")
async def batch_prices_stream(req: BatchPricesRequest, db: AsyncSession = Depends(get_db)):
    """Stream prices for multiple cards as NDJSON.

    Each card resolves independently — cache hits emit immediately, scrape
    misses follow as they complete. Client receives a JSON object per line
    with the same BatchPricesItem shape as /prices.
    """
    card_ids = list(dict.fromkeys(req.card_ids))[:25]
    if not card_ids:
        async def _empty():
            return
            yield  # noqa: unreachable — makes this an async generator
        return StreamingResponse(_empty(), media_type="application/x-ndjson")

    result = await db.execute(select(Card).where(Card.id.in_(card_ids)))
    cards_by_id: dict[int, Card] = {c.id: c for c in result.scalars().all()}

    async def fetch_one(card_id: int) -> BatchPricesItem:
        card = cards_by_id.get(card_id)
        if not card:
            return BatchPricesItem(card_id=card_id, error="not_found")
        try:
            ja_card_number = req.ja_card_numbers.get(card_id) if req.ja_card_numbers else None
            price_dict = await _matcher.get_prices(
                card, req.scan_type,
                language_override=card.language,
                ja_card_number=ja_card_number if card.language == "ja" else None,
            )
        except Exception as e:
            logger.exception("Stream price fetch failed for card %d", card_id)
            return BatchPricesItem(
                card_id=card_id,
                card=CardOut.model_validate(card),
                error=type(e).__name__,
            )
        price_out = (
            PriceOut(**price_dict, fetched_at=datetime.utcnow()) if price_dict else None
        )
        return BatchPricesItem(
            card_id=card_id,
            card=CardOut.model_validate(card),
            price=price_out,
        )

    async def fetch_one_at(idx: int, card_id: int) -> tuple[int, BatchPricesItem]:
        return (idx, await fetch_one(card_id))

    async def generate():
        # All fetches run concurrently but results are emitted in the original
        # request order — completed-out-of-order items are buffered until their
        # predecessors have been yielded, so the client sees top-to-bottom loading.
        tasks = [asyncio.ensure_future(fetch_one_at(i, cid)) for i, cid in enumerate(card_ids)]
        pending: dict[int, str] = {}
        next_emit = 0
        for fut in asyncio.as_completed(tasks):
            idx, item = await fut
            # Convert to slim schema: strip chart history, cap recent_sales at 3.
            # The batch prices UI only shows the current price and the most recent
            # sale — sending full history (60–100 entries) wastes 90–97% of bandwidth.
            slim_price: PriceOutSlim | None = None
            if item.price:
                slim_price = PriceOutSlim(
                    **item.price.model_dump(exclude={"price_history_ungraded", "price_history_graded", "recent_sales"}),
                    recent_sales=item.price.recent_sales[:3],
                )
            slim = BatchPricesItemSlim(
                card_id=item.card_id,
                card=item.card,
                price=slim_price,
                error=item.error,
            )
            pending[idx] = slim.model_dump_json() + "\n"
            while next_emit in pending:
                yield pending.pop(next_emit)
                next_emit += 1
        await db.commit()

    return StreamingResponse(generate(), media_type="application/x-ndjson")


@router.post("/history", status_code=201)
async def save_history(
    req: ScanHistoryCreate,
    db: AsyncSession = Depends(get_db),
):
    entry = ScanHistory(**req.model_dump())
    db.add(entry)
    await db.commit()
    return {"id": entry.id}


@router.get("/history/list", response_model=list[HistoryEntry])
async def get_history(
    limit: int = Query(default=50, le=200),
    offset: int = Query(default=0),
    before_id: int | None = Query(default=None, description="Keyset cursor: return rows with id < before_id"),
    db: AsyncSession = Depends(get_db),
):
    """List scan history.

    Supports two pagination modes:
    - Keyset (preferred): pass `before_id`=last seen id; rows ordered by id DESC.
      Stable under concurrent inserts; O(log n) per page via PK index.
    - Offset (legacy): omit `before_id`; uses offset/limit on `scanned_at`.
    """
    stmt = select(ScanHistory)
    if before_id is not None:
        stmt = stmt.where(ScanHistory.id < before_id).order_by(desc(ScanHistory.id)).limit(limit)
    else:
        stmt = stmt.order_by(desc(ScanHistory.scanned_at)).offset(offset).limit(limit)
    result = await db.execute(stmt)
    return [HistoryEntry.model_validate(r) for r in result.scalars().all()]
