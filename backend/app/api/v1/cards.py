import asyncio
import logging
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession
from app.database import get_db
from app.models.card import Card, ScanHistory
from app.schemas.card import (
    BatchPricesItem,
    BatchPricesRequest,
    BatchPricesResponse,
    CardOut,
    CardWithPrice,
    HistoryEntry,
    PriceOut,
    ScanHistoryCreate,
)
from app.services import matcher as _matcher

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/cards", tags=["cards"])


@router.get("/{card_id}", response_model=CardWithPrice)
async def get_card(
    card_id: int,
    scan_type: str = "raw",
    language: str | None = None,
    card_number: str | None = None,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Card).where(Card.id == card_id))
    card = result.scalar_one_or_none()
    if not card:
        raise HTTPException(status_code=404, detail="Card not found")

    # Fetch fresh price (cached internally). Pass scan language to override card.language
    # for price URL building — e.g. Japanese scan of an English-stored card.
    # ja_card_number is the OCR-read number from the physical card; the English DB
    # record may carry a different number so the JP PriceCharting URL needs the OCR value.
    price_dict = await _matcher.get_prices(
        card, scan_type,
        language_override=language,
        ja_card_number=card_number if language == "ja" else None,
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
