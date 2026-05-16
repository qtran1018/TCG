import base64
import hashlib
import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import Float, cast, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.card import Card
from app.schemas.card import BatchSearchItem, BatchSearchResult, CardOut
from app.services.cache import search_cache
from app.services.card_embedder import embed_image, is_ready

router = APIRouter(prefix="/match-image", tags=["match-image"])
logger = logging.getLogger(__name__)

_SIMILARITY_THRESHOLD = 0.70  # cosine similarity; below this → no match


class MatchImageRequest(BaseModel):
    crops: list[str]  # base64-encoded JPEG/PNG, one per detected card region (max 10)


@router.post("", response_model=BatchSearchResult)
async def match_image(req: MatchImageRequest, db: AsyncSession = Depends(get_db)):
    if not is_ready():
        raise HTTPException(
            status_code=503,
            detail="Image matching not ready — run scripts/build_embeddings.py first",
        )
    if not req.crops:
        return BatchSearchResult(results=[])
    if len(req.crops) > 10:
        raise HTTPException(status_code=422, detail="Maximum 10 crops per request")

    results: list[BatchSearchItem] = []
    for crop_b64 in req.crops:
        try:
            image_bytes = base64.b64decode(crop_b64)
        except Exception:
            results.append(BatchSearchItem(candidates=[], query_used="image:decode_error"))
            continue

        cache_key = hashlib.sha256(image_bytes).hexdigest()
        cached = await search_cache.get("embedding", cache_key)
        if cached is not None:
            results.append(BatchSearchItem(**cached))
            continue

        embedding = embed_image(image_bytes)
        if embedding is None:
            results.append(BatchSearchItem(candidates=[], query_used="image:no_pca"))
            continue

        embedding_list = embedding.tolist()
        distance_col = cast(Card.embedding.op("<=>")(embedding_list), Float).label("distance")
        stmt = (
            select(
                Card.id, Card.game, Card.language, Card.name, Card.name_ja,
                Card.set_name, Card.set_code, Card.card_number, Card.rarity,
                Card.image_url, Card.image_url_hi, Card.external_id,
                Card.phash, Card.pricecharting_id, Card.pricecharting_url,
                Card.created_at, distance_col,
            )
            .where(Card.embedding.isnot(None))
            .order_by(distance_col)
            .limit(10)
        )
        rows = (await db.execute(stmt)).mappings().all()

        candidates: list[CardOut] = []
        best_similarity = 0.0
        for row in rows:
            similarity = 1.0 - float(row["distance"])
            logger.info(
                "  candidate: %s | %s #%s | sim=%.4f %s",
                row["name"], row["set_name"], row["card_number"], similarity,
                "✓" if similarity >= _SIMILARITY_THRESHOLD else "✗ below threshold",
            )
            if similarity < _SIMILARITY_THRESHOLD:
                break
            candidates.append(CardOut.model_validate(dict(row)))
            best_similarity = max(best_similarity, similarity)

        query_used = f"image:{best_similarity:.2f}" if candidates else "image:no_match"
        logger.info("match-image: similarity=%.3f candidates=%d", best_similarity, len(candidates))

        item = BatchSearchItem(candidates=candidates, query_used=query_used)
        await search_cache.set("embedding", cache_key, ttl=3600, value=item.model_dump())
        results.append(item)

    return BatchSearchResult(results=results)
