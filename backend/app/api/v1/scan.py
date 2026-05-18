import asyncio
import base64
import hashlib
import logging
import re

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import Float, cast, select

from app.database import AsyncSessionLocal
from app.models.card import Card
from app.schemas.card import BatchSearchItem, CardOut
from app.services.cache import search_cache
from app.services.card_embedder import compute_phash, embed_batch
from app.services.card_matcher import CardMatcherService

router = APIRouter(prefix="/scan", tags=["scan"])
logger = logging.getLogger(__name__)

_matcher = CardMatcherService()
_VALID_GAMES = {"pokemon", "onepiece"}
_VALID_LANGUAGES = {"en", "ja"}
_SIM_THRESHOLD = 0.65
_SIM_FLOOR = 0.50   # below this, don't show image results at all
_PHASH_STRONG = 20
_IMAGE_MIN_SIM_WITH_OCR = 0.83
_RRF_K = 60


# ---------------------------------------------------------------------------
# Request / response schemas
# ---------------------------------------------------------------------------

class OcrHint(BaseModel):
    raw_text: str | None = None
    language: str = "en"
    game: str = "pokemon"


class ScanRequest(BaseModel):
    crops: list[str]           # base64-encoded JPEG, one per detected card region
    ocr_hints: list[OcrHint]   # parallel to crops; padded with defaults if shorter
    scan_mode: str = "combined"  # "ocr" | "image" | "combined"


class ScanResultItem(BaseModel):
    crop_index: int
    candidates: list[CardOut]
    query_used: str
    match_source: str  # "ocr" | "image" | "both" | "none"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _hamming(a: str | None, b: str | None) -> int:
    if not a or not b:
        return 999
    try:
        import imagehash
        return imagehash.hex_to_hash(a) - imagehash.hex_to_hash(b)
    except Exception:
        return 999


def _normalize_number(n: str) -> str:
    return re.sub(r"^0+", "", n) or "0"


def _rrf_merge(
    image_candidates: list[CardOut],
    ocr_candidates: list[CardOut],
    ocr_query: str,
    image_sim: float,
    scan_mode: str,
) -> tuple[list[CardOut], str]:
    use_image = scan_mode in ("image", "combined")
    if scan_mode == "combined":
        has_good_ocr = bool(ocr_candidates)
        use_image = not has_good_ocr or image_sim >= _IMAGE_MIN_SIM_WITH_OCR

    score_map: dict[int, tuple[float, CardOut]] = {}

    def add(candidates: list[CardOut], weight: float) -> None:
        for rank, card in enumerate(candidates):
            delta = weight / (rank + _RRF_K)
            if card.id in score_map:
                score_map[card.id] = (score_map[card.id][0] + delta, card)
            else:
                score_map[card.id] = (delta, card)

    if use_image and image_candidates:
        add(image_candidates, 1.0)
    if ocr_candidates:
        add(ocr_candidates, 2.0)

    merged = [card for _, card in sorted(score_map.values(), key=lambda x: -x[0])]

    # Promote cards whose number matches OCR-extracted card number
    m = re.search(r"#(\w+)", ocr_query)
    if m:
        ocr_num = _normalize_number(m.group(1))
        matching = [c for c in merged if c.card_number and _normalize_number(c.card_number) == ocr_num]
        rest = [c for c in merged if not (c.card_number and _normalize_number(c.card_number) == ocr_num)]
        merged = matching + rest

    has_img = use_image and bool(image_candidates)
    has_ocr = bool(ocr_candidates)
    source = "both" if (has_img and has_ocr) else "image" if has_img else "ocr" if has_ocr else "none"
    return merged, source


async def _vector_search(
    embedding,
    query_phash: str | None,
    img_bytes: bytes,
) -> tuple[list[CardOut], float, str]:
    """pgvector nearest-neighbor search + phash re-ranking. Returns (candidates, best_sim, query_used)."""
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
    async with AsyncSessionLocal() as db:
        rows = (await db.execute(stmt)).mappings().all()

    scored: list[tuple[tuple, float, bool, dict]] = []
    for row in rows:
        sim = 1.0 - float(row["distance"])
        h = _hamming(query_phash, row["phash"])
        phash_strong = h <= _PHASH_STRONG
        passes_clip = sim >= _SIM_THRESHOLD
        if not phash_strong and not passes_clip:
            logger.debug("Below threshold: sim=%.3f hamming=%d", sim, h)
        scored.append(((0 if phash_strong else 1, -sim), sim, phash_strong, dict(row)))

    scored.sort(key=lambda x: x[0])
    best_sim = max((s for _, s, _, _ in scored), default=0.0)
    # Return top 5 as candidates for swap options, but only if above the floor.
    # Below _SIM_FLOOR results are too unreliable to be useful even as alternates.
    if best_sim >= _SIM_FLOOR:
        candidates = [CardOut.model_validate(row) for _, _, _, row in scored[:5]]
    else:
        candidates = []
        logger.info("Image search: below floor (best_sim=%.3f, floor=%.2f) — no candidates", best_sim, _SIM_FLOOR)
    if _SIM_FLOOR <= best_sim < _SIM_THRESHOLD:
        logger.info("Image search: low confidence (best_sim=%.3f, threshold=%.2f)", best_sim, _SIM_THRESHOLD)
    used_phash = scored[0][2] if scored else False

    if used_phash:
        query_used = f"image:{best_sim:.2f}+phash"
    elif candidates:
        query_used = f"image:{best_sim:.2f}"
    else:
        query_used = "image:no_match"

    # Cache result
    item = BatchSearchItem(candidates=candidates, query_used=query_used)
    key = hashlib.sha256(img_bytes).hexdigest()
    await search_cache.set("embedding", key, ttl=3600, value=item.model_dump(mode="json"))
    return candidates, best_sim, query_used


async def _batch_image_search(
    imgs: list[bytes | None],
) -> dict[int, tuple[list[CardOut], float, str]]:
    """
    Batch embed all crops in one CLIP forward pass, then run pgvector searches.
    Each search gets its own DB session so they can run concurrently.
    Returns {crop_index: (candidates, best_sim, query_used)}.
    """
    results: dict[int, tuple[list[CardOut], float, str]] = {}
    to_embed: list[tuple[int, bytes]] = []

    for i, img_bytes in enumerate(imgs):
        if img_bytes is None:
            continue
        key = hashlib.sha256(img_bytes).hexdigest()
        cached = await search_cache.get("embedding", key)
        if cached is not None:
            item = BatchSearchItem(**cached)
            m = re.search(r"image:([\d.]+)", item.query_used)
            results[i] = (item.candidates, float(m.group(1)) if m else 0.0, item.query_used)
        else:
            to_embed.append((i, img_bytes))

    if to_embed:
        # One CLIP forward pass for all uncached crops
        batch_embeddings = embed_batch([b for _, b in to_embed])

        # Parallel pgvector searches — each _vector_search opens its own session
        async def search_one(idx: int, img_bytes: bytes, embedding) -> tuple[int, tuple[list[CardOut], float, str]]:
            query_phash = compute_phash(img_bytes)
            result = await _vector_search(embedding, query_phash, img_bytes)
            return idx, result

        vector_results = await asyncio.gather(*[
            search_one(idx, img_bytes, emb)
            for (idx, img_bytes), emb in zip(to_embed, batch_embeddings)
        ])
        results.update(dict(vector_results))

    return results


async def _ocr_search_one(
    hint: OcrHint,
) -> tuple[list[CardOut], str]:
    """Search by OCR text. Opens its own DB session so callers can run concurrently."""
    if not hint.raw_text or not hint.raw_text.strip():
        return [], ""
    game = hint.game if hint.game in _VALID_GAMES else "pokemon"
    language = hint.language if hint.language in _VALID_LANGUAGES else "en"
    try:
        async with AsyncSessionLocal() as db:
            cards, query_used = await _matcher.search_cards(
                ocr_text=hint.raw_text,
                game=game,
                language=language,
                db=db,
            )
        return [CardOut.model_validate(c) for c in cards], query_used
    except Exception:
        logger.exception("OCR search failed for text: %s", (hint.raw_text or "")[:60])
        return [], ""


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------

@router.post("")
async def scan(req: ScanRequest):
    """
    Combined card identification endpoint. Accepts crops + OCR hints, returns NDJSON stream
    of results — one JSON object per crop as it completes. Replaces the separate
    /detect + /match-image + /search/batch pipeline.

    Flow:
      1. Batch CLIP embed all crops in one forward pass (fast)
      2. Parallel pgvector searches for all crops
      3. Parallel OCR searches for all crops
      4. Per-crop RRF merge, streamed as NDJSON
    """
    crops = req.crops[:10]
    hints = list(req.ocr_hints[:10])
    while len(hints) < len(crops):
        hints.append(OcrHint())

    async def generate():
        # Decode all crops
        imgs: list[bytes | None] = []
        for b64 in crops:
            try:
                imgs.append(base64.b64decode(b64))
            except Exception:
                imgs.append(None)

        # Phase 1+2: batch CLIP embed + parallel pgvector searches
        image_results: dict[int, tuple[list[CardOut], float, str]] = {}
        if req.scan_mode in ("image", "combined"):
            try:
                image_results = await _batch_image_search(imgs)
            except Exception:
                logger.exception("Batch image search failed")

        # Phase 3: parallel OCR searches — each opens its own session
        ocr_results: list[tuple[list[CardOut], str]] = [([], "")] * len(crops)
        if req.scan_mode in ("ocr", "combined"):
            try:
                gathered = await asyncio.gather(*[
                    _ocr_search_one(hints[i]) for i in range(len(crops))
                ])
                ocr_results = list(gathered)
            except Exception:
                logger.exception("Batch OCR search failed")

        # Phase 4: merge + stream per crop
        for i in range(len(crops)):
            image_candidates, image_sim, image_query = image_results.get(i, ([], 0.0, "image:no_match"))
            ocr_candidates, ocr_query = ocr_results[i]

            if req.scan_mode == "ocr":
                result = ScanResultItem(
                    crop_index=i,
                    candidates=ocr_candidates,
                    query_used=ocr_query or "unknown",
                    match_source="ocr" if ocr_candidates else "none",
                )
            elif req.scan_mode == "image":
                result = ScanResultItem(
                    crop_index=i,
                    candidates=image_candidates,
                    query_used=image_query,
                    match_source="image" if image_sim >= _SIM_THRESHOLD else ("image:low" if image_candidates else "none"),
                )
            else:
                merged, source = _rrf_merge(image_candidates, ocr_candidates, ocr_query, image_sim, req.scan_mode)
                result = ScanResultItem(
                    crop_index=i,
                    candidates=merged,
                    query_used=ocr_query if ocr_candidates else image_query,
                    match_source=source,
                )

            yield result.model_dump_json() + "\n"

    return StreamingResponse(generate(), media_type="application/x-ndjson")
