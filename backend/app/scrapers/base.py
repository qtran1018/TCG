import asyncio
import logging
import random
import httpx
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type
from app.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
]

_BROWSER_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "DNT": "1",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Cache-Control": "max-age=0",
    "Connection": "keep-alive",
}

_lock = asyncio.Lock()
_last_request_time: dict[str, float] = {}

# Shared persistent client — reuses TCP/TLS connections across all scrape calls.
_client: httpx.AsyncClient | None = None
_client_lock = asyncio.Lock()


async def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        async with _client_lock:
            if _client is None or _client.is_closed:
                _client = httpx.AsyncClient(follow_redirects=True)
    return _client


async def close_client():
    global _client
    if _client and not _client.is_closed:
        await _client.aclose()
        _client = None


async def rate_limit(domain: str, seconds: float):
    async with _lock:
        last = _last_request_time.get(domain, 0.0)
        now = asyncio.get_event_loop().time()
        wait = seconds - (now - last)
        if wait > 0:
            await asyncio.sleep(wait + random.uniform(0.1, 0.4))
        _last_request_time[domain] = asyncio.get_event_loop().time()


class BaseScraper:
    # Total scrape budget per call. Mobile-facing endpoints use axios with a
    # 30s default timeout — cap below the client deadline to leave room for
    # response framing.
    FETCH_TOTAL_TIMEOUT = 28.0

    @retry(
        stop=stop_after_attempt(2),
        wait=wait_exponential(multiplier=2, min=2, max=6),
        retry=retry_if_exception_type(Exception),
        reraise=True,
    )
    async def fetch_page(self, url: str, domain: str, rate_seconds: float | None = None) -> str:
        return await asyncio.wait_for(
            self._fetch_page_inner(url, domain, rate_seconds),
            timeout=self.FETCH_TOTAL_TIMEOUT,
        )

    async def _fetch_page_inner(self, url: str, domain: str, rate_seconds: float | None) -> str:
        await rate_limit(domain, rate_seconds or settings.pricecharting_rate_limit_seconds)
        headers = {**_BROWSER_HEADERS, "User-Agent": random.choice(USER_AGENTS)}
        client = await _get_client()
        resp = await client.get(url, headers=headers, timeout=20.0)
        resp.raise_for_status()
        return resp.text
