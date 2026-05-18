import base64
import hashlib
import logging

import imagehash
from fastapi import APIRouter, Depends, HTTPException
from PIL import Image
from pydantic import BaseModel
from sqlalchemy import Float, cast, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.card import Card
from app.schemas.card import BatchSearchItem, BatchSearchResult, CardOut
from app.services.cache import search_cache
from app.services.card_embedder import compute_phash, embed_batch

router = APIRouter(prefix="/match-image", tags=["match-image"])
logger = logging.getLogger(__name__)

_SIMILARITY_THRESHOLD = 0.75
_PHASH_STRONG = 20  # Hamming distance — lower = more similar; ≤20 treated as strong match


def _hamming(a: str, b: str) -> int:
    try:
        return imagehash.hex_to_hash(a) - imagehash.hex_to_hash(b)
    except Exception:
        return 999


class MatchImageRequest(BaseModel):
    crops: list[str]  # base64-encoded JPEG/PNG, one per detected card region (max 10)


@router.post("", response_model=BatchSearchResult)
async def match_image(req: MatchImageRequest, db: AsyncSession = Depends(get_db)):
    if not req.crops:
        return BatchSearchResult(results=[])
    if len(req.crops) > 10:
        raise HTTPException(status_code=422, detail="Maximum 10 crops per request")

    # Decode all crops upfront
    decoded: list[bytes | None] = []
    for crop_b64 in req.crops:
        try:
            decoded.append(base64.b64decode(crop_b64))
        except Exception:
            decoded.append(None)

    # Check cache; collect indices that still need embedding
    results: list[BatchSearchItem | None] = [None] * len(decoded)
    cache_keys: list[str | None] = []
    to_embed: list[tuple[int, bytes]] = []

    for i, img_bytes in enumerate(decoded):
        if img_bytes is None:
            results[i] = BatchSearchItem(candidates=[], query_used="image:decode_error")
            cache_keys.append(None)
            continue
        key = hashlib.sha256(img_bytes).hexdigest()
        cache_keys.append(key)
        cached = await search_cache.get("embedding", key)
        if cached is not None:
            results[i] = BatchSearchItem(**cached)
        else:
            to_embed.append((i, img_bytes))

    # Batch-embed all uncached crops in one forward pass
    if to_embed:
        embeddings = embed_batch([b for _, b in to_embed])
        for (idx, img_bytes), embedding in zip(to_embed, embeddings):
            # Compute query phash for re-ranking
            query_phash = compute_phash(img_bytes)

            embedding_list = embedding.tolist()
            distance_col = cast(Card.embedding.op("<=>")(embedding_list), Float).label("distance")
            # Retrieve top 10 regardless of threshold — phash may rescue below-threshold hits
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

            # Score each candidate: phash Hamming distance + CLIP similarity
            scored: list[tuple[float, int, dict]] = []  # (sort_key, rank, row)
            for rank, row in enumerate(rows):
                similarity = 1.0 - float(row["distance"])
                hamming = _hamming(query_phash, row["phash"]) if (query_phash and row["phash"]) else 999
                phash_strong = hamming <= _PHASH_STRONG
                passes_clip = similarity >= _SIMILARITY_THRESHOLD

                logger.info(
                    "  candidate: %s | %s #%s | sim=%.4f hamming=%d %s",
                    row["name"], row["set_name"], row["card_number"],
                    similarity, hamming,
                    "PHASH+CLIP" if (phash_strong and passes_clip)
                    else "PHASH" if phash_strong
                    else "CLIP" if passes_clip
                    else "skip",
                )

                if not phash_strong and not passes_clip:
                    continue

                # Sort key: phash-strong matches first (0), then by CLIP similarity desc
                sort_key = (0 if phash_strong else 1, -similarity)
                scored.append((sort_key, rank, dict(row), similarity, phash_strong))

            scored.sort(key=lambda x: x[0])

            candidates: list[CardOut] = []
            best_similarity = 0.0
            used_phash = False
            for sort_key, rank, row, similarity, phash_strong in scored:
                candidates.append(CardOut.model_validate(row))
                best_similarity = max(best_similarity, similarity)
                if phash_strong and similarity < _SIMILARITY_THRESHOLD:
                    used_phash = True

            if used_phash:
                query_used = f"image:{best_similarity:.2f}+phash"
            elif candidates:
                query_used = f"image:{best_similarity:.2f}"
            else:
                query_used = "image:no_match"

            logger.info(
                "match-image crop %d: sim=%.3f candidates=%d phash_rescue=%s",
                idx, best_similarity, len(candidates), used_phash,
            )

            item = BatchSearchItem(candidates=candidates, query_used=query_used)
            await search_cache.set("embedding", cache_keys[idx], ttl=3600, value=item.model_dump(mode="json"))
            results[idx] = item

    return BatchSearchResult(results=results)
