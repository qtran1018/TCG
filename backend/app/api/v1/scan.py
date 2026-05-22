import asyncio
import base64
import hashlib
import io
import logging
import re

import imagehash
from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from PIL import Image
from pydantic import BaseModel
from sqlalchemy import Float, cast, select, text

from app.constants import VALID_GAMES, VALID_LANGUAGES
from app.database import AsyncSessionLocal
from app.models.card import Card
from app.schemas.card import CardOutLite
from app.services.cache import search_cache
from app.services import matcher as _matcher
from app.services.card_embedder import compute_phash, embed_batch

router = APIRouter(prefix="/scan", tags=["scan"])
logger = logging.getLogger(__name__)
_SIM_THRESHOLD = 0.65
_SIM_FLOOR = 0.50   # below this, don't show image results at all
_PHASH_STRONG = 20
_IMAGE_MIN_SIM_WITH_OCR = 0.83
_RRF_K = 60
_IMAGE_CACHE_TTL = 3600


# ---------------------------------------------------------------------------
# Request / response schemas
# ---------------------------------------------------------------------------

class OcrHint(BaseModel):
    raw_text: str | None = None
    language: str = "en"
    game: str = "pokemon"


class Box(BaseModel):
    left: int
    top: int
    width: int
    height: int


class ScanRequest(BaseModel):
    # Two input modes (mutually exclusive, image+boxes wins if both present):
    #
    # (a) Legacy — client pre-crops each region and base64-encodes N JPEGs.
    #     Useful when on-device YOLO ran and crops are already sliced in memory.
    #
    # (b) Server-side crop — client sends ONE full-image base64 + box coords.
    #     Eliminates N client-side JPEG re-encodes + base64 conversions on the phone
    #     (~500ms–1s saved on 12 cards). PIL crop on the server is ~5ms per box.
    crops: list[str] | None = None
    image: str | None = None
    boxes: list[Box] | None = None
    ocr_hints: list[OcrHint]   # parallel to crops/boxes; padded with defaults if shorter
    scan_mode: str = "combined"  # "ocr" | "image" | "combined"


class ScanResultItem(BaseModel):
    crop_index: int
    candidates: list[CardOutLite]
    query_used: str
    match_source: str  # "ocr" | "image" | "both" | "none"
    partial: bool = False
    partial_reason: str | None = None  # "image_failed" | "ocr_failed" — both = "image_failed,ocr_failed"


class _ImageSearchCache(BaseModel):
    """Cached image-search payload — preserves the sim score so it doesn't have to be regex'd back out of query_used."""
    candidates: list[CardOutLite]
    best_sim: float
    query_used: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _hamming(a: str | None, b: str | None) -> int:
    if not a or not b:
        return 999
    try:
        return imagehash.hex_to_hash(a) - imagehash.hex_to_hash(b)
    except Exception:
        logger.warning("phash hamming failed for a=%s b=%s", a, b, exc_info=True)
        return 999


def _normalize_number(n: str) -> str:
    return re.sub(r"^0+", "", n) or "0"


def _rrf_merge(
    image_candidates: list[CardOutLite],
    ocr_candidates: list[CardOutLite],
    ocr_query: str,
    image_sim: float,
    scan_mode: str,
) -> tuple[list[CardOutLite], str]:
    use_image = scan_mode in ("image", "combined")
    if scan_mode == "combined":
        has_good_ocr = bool(ocr_candidates)
        use_image = not has_good_ocr or image_sim >= _IMAGE_MIN_SIM_WITH_OCR

    score_map: dict[int, tuple[float, CardOutLite]] = {}

    def add(candidates: list[CardOutLite], weight: float) -> None:
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
    cache_seed: str,
    language: str = "en",
) -> tuple[list[CardOutLite], float, str]:
    """pgvector nearest-neighbor search + phash re-ranking. Returns (candidates, best_sim, query_used).

    `cache_seed` is the deterministic identifier used to key the Redis cache entry —
    decoupled from the image bytes so callers can pass a PIL Image down the embedding
    path and avoid the JPEG encode→decode round-trip on the hot path.
    """
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
        .where(Card.embedding.isnot(None), Card.language == language)
        .order_by(distance_col)
        .limit(5)
    )
    async with AsyncSessionLocal() as db:
        # Raise IVFFlat probes from default 1 → 10 for better recall on
        # cluster-boundary cards. Cost: +5–10ms per query; benefit: meaningfully
        # higher chance the true match is in the candidate set.
        await db.execute(text("SET LOCAL ivfflat.probes = 10"))
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
    if best_sim >= _SIM_FLOOR:
        candidates = [CardOutLite.model_validate(row) for _, _, _, row in scored[:5]]
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

    # Cache key includes language so EN and JP scans on the same image return separate results.
    cache_item = _ImageSearchCache(candidates=candidates, best_sim=best_sim, query_used=query_used)
    key = f"{cache_seed}:{language}"
    await search_cache.set("embedding", key, ttl=_IMAGE_CACHE_TTL, value=cache_item.model_dump(mode="json"))
    return candidates, best_sim, query_used


async def _image_search_one(
    idx: int,
    image: "Image.Image | None",
    cache_seed: str | None,
    language: str = "en",
) -> tuple[list[CardOutLite], float, str]:
    """Per-crop image search. Caches by cache_seed + language."""
    if image is None or cache_seed is None:
        return [], 0.0, "image:no_match"

    key = f"{cache_seed}:{language}"
    cached = await search_cache.get("embedding", key)
    if cached is not None:
        if "best_sim" in cached:
            item = _ImageSearchCache(**cached)
            return item.candidates, item.best_sim, item.query_used
        m = re.search(r"image:([\d.]+)", cached.get("query_used", ""))
        return (
            [CardOutLite(**c) for c in cached.get("candidates", [])],
            float(m.group(1)) if m else 0.0,
            cached.get("query_used", "image:no_match"),
        )

    # Run embedding + phash off the event loop in parallel.
    embedding, query_phash = await asyncio.gather(
        asyncio.to_thread(lambda: embed_batch([image])[0]),
        asyncio.to_thread(compute_phash, image),
    )
    candidates, best_sim, query_used = await _vector_search(embedding, query_phash, cache_seed, language)

    # If JP image search is below confident threshold, also try EN — mirrors the OCR
    # JP→EN fallback and recovers EN cards that triggered kana language detection on mobile
    # (e.g. water-type symbol misread as 2 kana, flipping cropLang to 'ja').
    if language == "ja" and best_sim < _SIM_THRESHOLD:
        en_candidates, en_sim, en_query = await _vector_search(embedding, query_phash, cache_seed, "en")
        if en_sim > best_sim:
            logger.info("Image search: JP sim=%.3f < threshold, EN sim=%.3f — using EN result", best_sim, en_sim)
            return en_candidates, en_sim, en_query

    return candidates, best_sim, query_used


async def _ocr_search_one(
    hint: OcrHint,
) -> tuple[list[CardOutLite], str]:
    """Search by OCR text. Opens its own DB session so callers can run concurrently."""
    if not hint.raw_text or not hint.raw_text.strip():
        return [], ""
    game = hint.game if hint.game in VALID_GAMES else "pokemon"
    language = hint.language if hint.language in VALID_LANGUAGES else "en"
    try:
        async with AsyncSessionLocal() as db:
            cards, query_used = await _matcher.search_cards(
                ocr_text=hint.raw_text,
                game=game,
                language=language,
                db=db,
            )
            # If JP search found nothing, retry as EN — handles EN cards whose flavor
            # text was misread as kana by TextRecognitionScript.JAPANESE on the mobile,
            # flipping cropLang to 'ja' despite being an English card.
            if not cards and language == "ja":
                cards, query_used = await _matcher.search_cards(
                    ocr_text=hint.raw_text,
                    game=game,
                    language="en",
                    db=db,
                )
        return [CardOutLite.model_validate(c) for c in cards], query_used
    except Exception:
        logger.exception("OCR search failed for text: %s", (hint.raw_text or "")[:60])
        return [], ""


def _build_result(
    idx: int,
    scan_mode: str,
    image: tuple[list[CardOutLite], float, str],
    ocr: tuple[list[CardOutLite], str],
    image_failed: bool = False,
    ocr_failed: bool = False,
) -> ScanResultItem:
    image_candidates, image_sim, image_query = image
    ocr_candidates, ocr_query = ocr

    reasons: list[str] = []
    if image_failed and scan_mode in ("image", "combined"):
        reasons.append("image_failed")
    if ocr_failed and scan_mode in ("ocr", "combined"):
        reasons.append("ocr_failed")
    partial = bool(reasons)
    partial_reason = ",".join(reasons) if reasons else None

    if scan_mode == "ocr":
        return ScanResultItem(
            crop_index=idx,
            candidates=ocr_candidates,
            query_used=ocr_query or "unknown",
            match_source="ocr" if ocr_candidates else "none",
            partial=partial,
            partial_reason=partial_reason,
        )
    if scan_mode == "image":
        return ScanResultItem(
            crop_index=idx,
            candidates=image_candidates,
            query_used=image_query,
            match_source="image" if image_sim >= _SIM_THRESHOLD else ("image:low" if image_candidates else "none"),
            partial=partial,
            partial_reason=partial_reason,
        )
    merged, source = _rrf_merge(image_candidates, ocr_candidates, ocr_query, image_sim, scan_mode)
    return ScanResultItem(
        crop_index=idx,
        candidates=merged,
        query_used=ocr_query if ocr_candidates else image_query,
        match_source=source,
        partial=partial,
        partial_reason=partial_reason,
    )


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------

@router.post("")
async def scan(req: ScanRequest):
    """
    Combined card identification endpoint. Streams NDJSON results — one JSON object
    per crop as soon as that crop's image+OCR searches both complete.

    Per crop, image search and OCR search run concurrently; results are yielded in
    completion order (not crop order) so fast cards appear in the UI without
    waiting for slow ones.
    """
    # Decide input mode: server-side crop (image+boxes) takes priority when present.
    # `imgs` is now list[PIL.Image] — passed straight through to the embedder so we
    # avoid the JPEG re-encode → JPEG re-decode round-trip that was happening before.
    # `cache_seeds` is a parallel list of deterministic cache key strings.
    imgs: list["Image.Image | None"] = []
    cache_seeds: list[str | None] = []
    if req.image and req.boxes:
        boxes = req.boxes[:20]
        try:
            full_bytes = base64.b64decode(req.image)
            # Hash the full image once; per-box cache seed = full_sha + box coords.
            # Stable: same input image + same box → same cache hit.
            full_sha = hashlib.sha256(full_bytes).hexdigest()
            full_img = Image.open(io.BytesIO(full_bytes))
            full_img.load()
            if full_img.mode != "RGB":
                full_img = full_img.convert("RGB")
            W, H = full_img.size
            for b in boxes:
                try:
                    left = max(0, min(W, int(b.left)))
                    top = max(0, min(H, int(b.top)))
                    right = max(0, min(W, int(b.left + b.width)))
                    bottom = max(0, min(H, int(b.top + b.height)))
                    if right <= left or bottom <= top:
                        imgs.append(None)
                        cache_seeds.append(None)
                        continue
                    # PIL.crop creates a lightweight view — no pixel copy until needed.
                    imgs.append(full_img.crop((left, top, right, bottom)))
                    cache_seeds.append(f"{full_sha}:{left},{top},{right},{bottom}")
                except Exception:
                    logger.warning("server-side crop failed", exc_info=True)
                    imgs.append(None)
                    cache_seeds.append(None)
        except Exception:
            logger.exception("failed to decode full image for server-side crop")
            imgs = [None] * len(boxes)
            cache_seeds = [None] * len(boxes)
        num_items = len(boxes)
    else:
        crops = (req.crops or [])[:20]
        for b64 in crops:
            try:
                raw = base64.b64decode(b64)
                img = Image.open(io.BytesIO(raw))
                img.load()
                if img.mode != "RGB":
                    img = img.convert("RGB")
                imgs.append(img)
                cache_seeds.append(hashlib.sha256(raw).hexdigest())
            except Exception:
                imgs.append(None)
                cache_seeds.append(None)
        num_items = len(crops)

    hints = list(req.ocr_hints[:20])
    while len(hints) < num_items:
        hints.append(OcrHint())

    do_image = req.scan_mode in ("image", "combined")
    do_ocr = req.scan_mode in ("ocr", "combined")

    async def _empty_image(_i: int) -> tuple[list[CardOutLite], float, str]:
        return [], 0.0, "image:no_match"

    async def _empty_ocr(_h: OcrHint) -> tuple[list[CardOutLite], str]:
        return [], ""

    async def per_crop(i: int) -> ScanResultItem:
        lang = hints[i].language if hints[i].language in VALID_LANGUAGES else "en"
        image_task = _image_search_one(i, imgs[i], cache_seeds[i], lang) if do_image else _empty_image(i)
        ocr_task = _ocr_search_one(hints[i]) if do_ocr else _empty_ocr(hints[i])
        # return_exceptions=True so a failure in one branch doesn't zero out the
        # other — surface degraded mode via partial flag instead.
        image_res, ocr_res = await asyncio.gather(image_task, ocr_task, return_exceptions=True)
        image_failed = isinstance(image_res, BaseException)
        ocr_failed = isinstance(ocr_res, BaseException)
        if image_failed:
            logger.exception("Image search failed for crop %d", i, exc_info=image_res)
            image_res = ([], 0.0, "image:no_match")
        if ocr_failed:
            logger.exception("OCR search failed for crop %d", i, exc_info=ocr_res)
            ocr_res = ([], "")
        return _build_result(
            i, req.scan_mode, image_res, ocr_res,
            image_failed=image_failed, ocr_failed=ocr_failed,
        )

    async def generate():
        # Kick off all crops in parallel; yield each result as it completes.
        tasks = [asyncio.create_task(per_crop(i)) for i in range(num_items)]
        try:
            for coro in asyncio.as_completed(tasks):
                result = await coro
                yield result.model_dump_json() + "\n"
        finally:
            # If the client disconnected, cancel remaining tasks to stop wasted work.
            for t in tasks:
                if not t.done():
                    t.cancel()

    return StreamingResponse(generate(), media_type="application/x-ndjson")
