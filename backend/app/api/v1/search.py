import logging
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from app.database import get_db
from app.schemas.card import SearchRequest, SearchResult, CardOut
from app.services.card_matcher import CardMatcherService
from app.services.image_hasher import compute_phash

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/search", tags=["search"])

_matcher = CardMatcherService()


@router.post("", response_model=SearchResult)
async def search_cards(req: SearchRequest, db: AsyncSession = Depends(get_db)):
    if not req.ocr_text.strip():
        raise HTTPException(status_code=400, detail="ocr_text is required")

    if req.game not in ("pokemon", "onepiece"):
        raise HTTPException(status_code=400, detail="game must be 'pokemon' or 'onepiece'")

    if req.language not in ("en", "ja"):
        raise HTTPException(status_code=400, detail="language must be 'en' or 'ja'")

    cards, query_used = await _matcher.search_cards(
        ocr_text=req.ocr_text,
        game=req.game,
        language=req.language,
        db=db,
    )

    return SearchResult(
        candidates=[CardOut.model_validate(c) for c in cards],
        query_used=query_used,
    )
