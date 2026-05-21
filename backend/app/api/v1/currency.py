import logging
import httpx
from fastapi import APIRouter, HTTPException
from app.services.cache import get_redis

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/currency", tags=["currency"])

_FRANKFURTER_URL = "https://api.frankfurter.dev/v2/rates?quotes=JPY&base=USD"
_CACHE_KEY = "tcg:currency:usd_jpy"
_CACHE_TTL = 86400  # 24 hours


@router.get("/rates")
async def get_rates():
    """Return USD→JPY exchange rate. Cached in Redis for 24h; fetched lazily on miss."""
    r = await get_redis()
    cached = await r.hgetall(_CACHE_KEY)
    if cached:
        return {"base": "USD", "quote": "JPY", "rate": float(cached["rate"]), "date": cached["date"]}

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(_FRANKFURTER_URL)
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        logger.error("Failed to fetch exchange rate from frankfurter.dev: %s", e)
        raise HTTPException(status_code=503, detail="Exchange rate service unavailable")

    # API returns a list with one entry
    entry = data[0] if isinstance(data, list) else data
    rate = float(entry["rate"])
    date = entry["date"]

    await r.hset(_CACHE_KEY, mapping={"rate": str(rate), "date": date})
    await r.expire(_CACHE_KEY, _CACHE_TTL)

    return {"base": "USD", "quote": "JPY", "rate": rate, "date": date}
