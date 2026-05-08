import io
import logging
import httpx
import imagehash
from PIL import Image
from typing import Optional

logger = logging.getLogger(__name__)

MAX_HAMMING_DISTANCE = 12  # cards within this distance are considered matches


def compute_phash(image_bytes: bytes) -> str:
    img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    return str(imagehash.phash(img))


def phash_distance(hash1: str, hash2: str) -> int:
    return imagehash.hex_to_hash(hash1) - imagehash.hex_to_hash(hash2)


def is_similar(hash1: str, hash2: str, threshold: int = MAX_HAMMING_DISTANCE) -> bool:
    try:
        return phash_distance(hash1, hash2) <= threshold
    except Exception:
        return False


_shared_client: httpx.AsyncClient | None = None


def _get_shared_client() -> httpx.AsyncClient:
    global _shared_client
    if _shared_client is None or _shared_client.is_closed:
        _shared_client = httpx.AsyncClient(
            timeout=httpx.Timeout(connect=10.0, read=30.0, write=10.0, pool=10.0),
            follow_redirects=True,
        )
    return _shared_client


async def compute_phash_from_url(url: str) -> str | None:
    try:
        client = _get_shared_client()
        resp = await client.get(url)
        resp.raise_for_status()
        return compute_phash(resp.content)
    except Exception as e:
        logger.warning("Failed to compute phash from URL %s: %s", url, e)
        return None


def rank_by_similarity(query_phash: str, candidates: list[dict]) -> list[dict]:
    """
    candidates: list of dicts with at least {"phash": str, ...}
    Returns sorted by ascending hamming distance (most similar first).
    """
    scored = []
    for c in candidates:
        phash = c.get("phash")
        if phash:
            try:
                dist = phash_distance(query_phash, phash)
                scored.append((dist, c))
            except Exception:
                scored.append((999, c))
        else:
            scored.append((999, c))

    scored.sort(key=lambda x: x[0])
    return [c for _, c in scored]
