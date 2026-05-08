import logging
from fastapi import APIRouter, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from fastapi import Depends
from app.database import get_db
from app.models.card import Card
from app.schemas.card import PSACertRequest, PSACertResult, CardOut, PriceOut
from app.scrapers.psa import PSAScraper
from app.services.card_matcher import CardMatcherService
from app.services.cache import price_cache
from datetime import datetime

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/psa", tags=["psa"])

_psa = PSAScraper()
_matcher = CardMatcherService()


@router.post("/cert", response_model=PSACertResult)
async def lookup_psa_cert(req: PSACertRequest, db: AsyncSession = Depends(get_db)):
    cert = req.cert_number.strip()
    if not cert:
        raise HTTPException(status_code=400, detail="cert_number is required")

    cache_key = f"psa:cert:{cert}"
    cached = await price_cache.get(cache_key)
    if cached:
        return PSACertResult(**cached)

    try:
        cert_data = await _psa.lookup_cert(cert)
    except Exception as e:
        logger.error("PSA lookup failed for cert %s: %s", cert, e)
        raise HTTPException(status_code=502, detail="PSA cert lookup failed")

    # Attempt to match cert card to our DB
    card_out = None
    price_out = None
    if cert_data.card_name:
        cards, _ = await _matcher.search_cards(
            ocr_text=cert_data.card_name,
            game=req.game,
            language="en",
            db=db,
        )
        if cards:
            matched = cards[0]
            card_out = CardOut.model_validate(matched)
            price_dict = await _matcher.get_prices(matched, "psa")
            await db.commit()
            if price_dict:
                price_out = PriceOut(**price_dict, fetched_at=datetime.utcnow())

    result = PSACertResult(
        cert_number=cert,
        grade=cert_data.grade,
        card_name=cert_data.card_name,
        set_name=cert_data.set_name,
        year=cert_data.year,
        population=cert_data.population,
        card=card_out,
        price=price_out,
    )

    await price_cache.set(cache_key, ttl=3600, value=result.model_dump())
    return result
