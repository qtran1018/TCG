import base64
import gzip
import json
import logging
from typing import Any
import redis.asyncio as aioredis
from app.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

# Values larger than this are gzip-compressed before storing. Price entries
# with full sales tables + 24-month history series typically run 4–10 KB —
# compression shrinks them to ~25–35%. Below the threshold the overhead isn't
# worth it.
_COMPRESS_THRESHOLD_BYTES = 2048
_COMPRESS_PREFIX = "gz:"  # marker so reads can detect compressed payloads

_redis: aioredis.Redis | None = None


async def get_redis() -> aioredis.Redis:
    global _redis
    if _redis is None:
        _redis = aioredis.from_url(settings.redis_url, decode_responses=True)
    return _redis


class CacheService:

    def __init__(self, prefix: str = "tcg"):
        self.prefix = prefix

    def _key(self, *parts: str) -> str:
        return f"{self.prefix}:" + ":".join(parts)

    async def get(self, *key_parts: str) -> Any | None:
        r = await get_redis()
        raw = await r.get(self._key(*key_parts))
        if raw is None:
            return None
        if isinstance(raw, str) and raw.startswith(_COMPRESS_PREFIX):
            try:
                decoded = base64.b64decode(raw[len(_COMPRESS_PREFIX):])
                raw = gzip.decompress(decoded).decode("utf-8")
            except Exception:
                logger.warning("Failed to decompress cached value at %s", ":".join(key_parts), exc_info=True)
                return None
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return raw

    async def set(self, *key_parts_and_value, ttl: int, value: Any) -> None:
        r = await get_redis()
        key = self._key(*key_parts_and_value)
        payload = json.dumps(value)
        if len(payload) > _COMPRESS_THRESHOLD_BYTES:
            compressed = gzip.compress(payload.encode("utf-8"))
            payload = _COMPRESS_PREFIX + base64.b64encode(compressed).decode("ascii")
        await r.set(key, payload, ex=ttl)

    async def delete(self, *key_parts: str) -> None:
        r = await get_redis()
        await r.delete(self._key(*key_parts))

    async def check_rate_limit(self, domain: str, max_per_window: int = 1, window_seconds: int = 3) -> bool:
        """Returns True if request is allowed, False if rate limited."""
        r = await get_redis()
        key = self._key("rl", domain)
        count = await r.incr(key)
        if count == 1:
            await r.expire(key, window_seconds)
        return count <= max_per_window


price_cache = CacheService("tcg:prices")
card_cache = CacheService("tcg:cards")
search_cache = CacheService("tcg:search")
