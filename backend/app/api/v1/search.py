import logging
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from app.database import get_db
from app.schemas.card import (
    SearchRequest, SearchResult, CardOut,
    BatchSearchRequest, BatchSearchResult, BatchSearchItem,
)
from app.services.card_matcher import CardMatcherService
from app.services.image_hasher import compute_phash

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/search", tags=["search"])

_matcher = CardMatcherService()

VALID_GAMES = {"pokemon", "onepiece"}
VALID_LANGUAGES = {"en", "ja"}


@router.post("", response_model=SearchResult)
async def search_cards(req: SearchRequest, db: AsyncSession = Depends(get_db)):
    if not req.ocr_text.strip():
        raise HTTPException(status_code=400, detail="ocr_text is required")
    if req.game not in VALID_GAMES:
        raise HTTPException(status_code=400, detail="game must be 'pokemon' or 'onepiece'")
    if req.language not in VALID_LANGUAGES:
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


@router.post("/batch", response_model=BatchSearchResult)
async def batch_search_cards(req: BatchSearchRequest, db: AsyncSession = Depends(get_db)):
    if not req.queries:
        raise HTTPException(status_code=400, detail="queries must not be empty")

    results: list[BatchSearchItem] = []
    for item in req.queries[:10]:  # hard cap — never more than 10 cards per batch
        if not item.ocr_text.strip():
            continue
        game = item.game if item.game in VALID_GAMES else "pokemon"
        language = item.language if item.language in VALID_LANGUAGES else "en"

        try:
            cards, query_used = await _matcher.search_cards(
                ocr_text=item.ocr_text,
                game=game,
                language=language,
                db=db,
            )
            results.append(BatchSearchItem(
                candidates=[CardOut.model_validate(c) for c in cards],
                query_used=query_used,
            ))
        except Exception:
            logger.exception("Batch search failed for query: %s", item.ocr_text[:60])

    return BatchSearchResult(results=results)
