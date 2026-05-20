import asyncio
import logging
import random
from typing import Any
from playwright.async_api import async_playwright, Browser, BrowserContext, Page
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

_lock = asyncio.Lock()
_last_request_time: dict[str, float] = {}


async def rate_limit(domain: str, seconds: float):
    async with _lock:
        last = _last_request_time.get(domain, 0.0)
        now = asyncio.get_event_loop().time()
        wait = seconds - (now - last)
        if wait > 0:
            await asyncio.sleep(wait + random.uniform(0.5, 1.5))
        _last_request_time[domain] = asyncio.get_event_loop().time()


class BaseScraper:
    _browser: Browser | None = None
    _playwright = None

    @classmethod
    async def get_browser(cls) -> Browser:
        if cls._browser is None or not cls._browser.is_connected():
            cls._playwright = await async_playwright().start()
            cls._browser = await cls._playwright.chromium.launch(
                headless=True,
                args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
            )
        return cls._browser

    @classmethod
    async def close(cls):
        if cls._browser:
            await cls._browser.close()
            cls._browser = None
        if cls._playwright:
            await cls._playwright.stop()
            cls._playwright = None

    async def new_context(self) -> BrowserContext:
        browser = await self.get_browser()
        return await browser.new_context(
            user_agent=random.choice(USER_AGENTS),
            viewport={"width": 1280, "height": 800},
            locale="en-US",
            extra_http_headers={"Accept-Language": "en-US,en;q=0.9"},
        )

    # Total scrape budget per call. Mobile-facing endpoints use axios with a
    # 30s default timeout — letting the backend exceed that leaves the client
    # to time out while we keep grinding on a request whose result has nowhere
    # to go. Cap below the client deadline to leave room for response framing.
    FETCH_TOTAL_TIMEOUT = 28.0

    @retry(
        # 2 attempts (not 3) with capped backoff. Combined with the wait_for
        # below the absolute worst case stays under FETCH_TOTAL_TIMEOUT.
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
        ctx = await self.new_context()
        try:
            page: Page = await ctx.new_page()
            # Playwright goto timeout reduced from 30s — anything slower would
            # blow the per-attempt budget anyway.
            await page.goto(url, wait_until="domcontentloaded", timeout=15000)
            await page.wait_for_timeout(random.randint(800, 1500))
            content = await page.content()
            await page.close()
            return content
        finally:
            await ctx.close()
