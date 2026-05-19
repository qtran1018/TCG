import logging
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession
from app.database import get_db
from app.models.card import Card, ScanHistory
from app.schemas.card import CardOut, CardWithPrice, PriceOut, HistoryEntry, ScanHistoryCreate
from app.services import matcher as _matcher
from app.services.ja_image_lookup import find_ja_image

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/cards", tags=["cards"])


@router.get("/{card_id}", response_model=CardWithPrice)
async def get_card(
    card_id: int,
    scan_type: str = "raw",
    language: str | None = None,
    kana_name: str | None = None,
    set_total: int | None = None,
    card_number: str | None = None,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Card).where(Card.id == card_id))
    card = result.scalar_one_or_none()
    if not card:
        raise HTTPException(status_code=404, detail="Card not found")

    # Fetch fresh price (cached internally). Pass scan language to override card.language
    # for price URL building — e.g. Japanese scan of an English-stored card.
    price_dict = await _matcher.get_prices(card, scan_type, language_override=language)
    await db.commit()

    price_out = None
    if price_dict:
        price_out = PriceOut(
            **price_dict,
            fetched_at=datetime.utcnow(),
        )

    # For Japanese scans, look up the Japanese card image
    ja_image_url: str | None = None
    if language == "ja" and kana_name:
        ja_image_url = find_ja_image(kana_name, set_total, card_number)

    return CardWithPrice(card=CardOut.model_validate(card), price=price_out, ja_image_url=ja_image_url)


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
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(ScanHistory)
        .order_by(desc(ScanHistory.scanned_at))
        .offset(offset)
        .limit(limit)
    )
    return [HistoryEntry.model_validate(r) for r in result.scalars().all()]
