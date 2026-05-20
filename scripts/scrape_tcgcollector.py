"""
Scrape Japanese card data from TCGCollector.com (image grid view) using Playwright.

Outputs: backend/app/data/tcgcollector_ja.json
Format: list of {name_en, set_name, card_number, card_number_raw, image_url, card_id}

- Uses headed Chromium to avoid Cloudflare bot detection
- Randomized delays (3–6s) between pages
- Saves checkpoint every 5 pages
- Resumable: use --start-page to continue from a given page

Usage:
    py -3 scripts/scrape_tcgcollector.py [--output-dir backend/app/data] [--start-page N]
"""

import asyncio
import json
import re
import random
import argparse
import logging
from pathlib import Path

from playwright.async_api import async_playwright, Page, TimeoutError as PlaywrightTimeout

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[logging.StreamHandler()],
)
log = logging.getLogger(__name__)

BASE_URL_OLD_TO_NEW = (
    "https://www.tcgcollector.com/cards/jp"
    "?releaseDateOrder=oldToNew&displayAs=image&sortBy=pokedexNumber"
)
BASE_URL_NEW_TO_OLD = (
    "https://www.tcgcollector.com/cards/jp"
    "?releaseDateOrder=newToOld&displayAs=image&sortBy=releaseDate"
)
# Set-specific URL template — replace {set_id} with the TCGCollector set ID
BASE_URL_SET = (
    "https://www.tcgcollector.com/cards/jp"
    "?displayAs=image&sortBy=cardNumber&sets[]={set_id}"
)

LOAD_TIMEOUT = 45_000  # ms to wait for page content
MIN_DELAY = 3.0        # seconds between pages
MAX_DELAY = 6.0        # seconds between pages (random jitter)
CHECKPOINT_EVERY = 5   # pages between saves


async def human_pause(min_s: float = MIN_DELAY, max_s: float = MAX_DELAY):
    """Wait a random amount of time to look like a human."""
    delay = random.uniform(min_s, max_s)
    await asyncio.sleep(delay)


async def wait_for_cards(page: Page) -> bool:
    try:
        await page.wait_for_selector(".card-image-grid-item", timeout=LOAD_TIMEOUT)
        return True
    except PlaywrightTimeout:
        return False


async def detect_cloudflare(page: Page) -> bool:
    title = (await page.title()).lower()
    return "just a moment" in title or ("cloudflare" in title and "tcg" not in title)


async def scroll_full_page(page: Page):
    """Scroll through the entire page to trigger lazy-loaded images."""
    for pct in [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]:
        await page.evaluate(f"window.scrollTo(0, document.body.scrollHeight * {pct})")
        await asyncio.sleep(0.35)
    # Scroll back to top and wait for final settle
    await page.evaluate("window.scrollTo(0, 0)")
    await asyncio.sleep(1.0)


def parse_card_alt(alt: str) -> tuple[str, str, str, int | None] | None:
    """
    Parse TCGCollector alt text into (name, set_name, card_number, set_total).

    Handles all known formats:
      "Bulbasaur (Expansion Pack No. 001)"          → num=1,  total=None
      "Bulbasaur (Pokémon-e Starter Deck 001/029)"  → num=1,  total=29
      "Bulbasaur (Intro Pack (Bulbasaur) 1)"         → num=1,  total=None
      "Bulbasaur (ADV Promos 051/ADV-P)"             → num=51, total=None  (promo)
      "Suicune (Start Deck 100 172/198)"             → num=172, total=198
    """
    alt = alt.strip()
    if not alt.endswith(")"):
        return None

    # Strip final ")" to get inner content
    inner = alt[:-1]

    # Identify the card reference at the tail of inner.
    # Try patterns in priority order: "No. NNN[/suffix]", "NNN/suffix", bare "NNN"
    card_ref_re = [
        r"\s+No\.\s+([A-Za-z0-9]+(?:/[A-Za-z0-9\-]+)?)\s*$",   # No. 001 | No. 001/ADV-P
        r"\s+([0-9]+/[A-Za-z0-9\-]+)\s*$",                       # 001/029 | 051/ADV-P
        r"\s+([0-9]+)\s*$",                                        # bare number
    ]

    card_number_raw: str | None = None
    remainder = inner
    for pattern in card_ref_re:
        m = re.search(pattern, inner)
        if m:
            card_number_raw = m.group(1)
            remainder = inner[: m.start()]
            break

    if not card_number_raw:
        return None

    # remainder is now "Name (Set name" — split on first "("
    first_paren = remainder.find("(")
    if first_paren < 0:
        return None

    name = remainder[:first_paren].strip()
    set_name = remainder[first_paren + 1 :].strip()

    if not name:
        return None

    # Decode card number and set total from card_number_raw
    if "/" in card_number_raw:
        num_part, den_part = card_number_raw.split("/", 1)
        card_number = str(int(num_part)) if num_part.isdigit() else num_part
        set_total = int(den_part) if den_part.isdigit() else None
    else:
        card_number = str(int(card_number_raw)) if card_number_raw.isdigit() else card_number_raw
        set_total = None

    return name, set_name, card_number, set_total


async def parse_image_page(page: Page) -> list[dict]:
    """Extract card entries from the current image grid page."""
    # Trigger lazy-loaded images by scrolling through the full page
    await scroll_full_page(page)

    cards = []
    items = await page.query_selector_all(".card-image-grid-item")

    for item in items:
        try:
            card_id_str = await item.get_attribute("data-card-id") or ""
            card_id = int(card_id_str) if card_id_str.isdigit() else None

            # Card art image
            img_el = await item.query_selector(".card-image-grid-item-image")
            image_url: str | None = None
            alt_text: str = ""
            if img_el:
                # Prefer the higher-res srcset entry
                srcset = await img_el.get_attribute("srcset") or ""
                src = await img_el.get_attribute("src") or ""
                alt_text = (await img_el.get_attribute("alt") or "").strip()

                if srcset:
                    parts = [p.strip().split() for p in srcset.split(",")]
                    best_src, best_w = src, 0
                    for p in parts:
                        if len(p) == 2:
                            w_str = p[1].rstrip("w")
                            if w_str.isdigit() and int(w_str) > best_w:
                                best_w = int(w_str)
                                best_src = p[0]
                    image_url = best_src
                elif src and not src.startswith("data:"):
                    image_url = src

            if not alt_text or not image_url:
                continue

            parsed = parse_card_alt(alt_text)
            if not parsed:
                log.debug("Unmatched alt: %r", alt_text)
                continue

            name_en, set_name, card_number, set_total = parsed
            card_number_raw = card_number_raw = re.search(r"[0-9]+", alt_text)
            # Re-extract raw number for record-keeping
            raw_m = re.search(r"(\d+)(?:/[A-Za-z0-9\-]+)?\s*\)\s*$", alt_text)
            card_number_raw_str = raw_m.group(1) if raw_m else card_number

            cards.append({
                "name_en": name_en,
                "set_name": set_name,
                "card_number": card_number,
                "card_number_raw": card_number_raw_str,
                "set_total": set_total,
                "image_url": image_url,
                "card_id": card_id,
            })

        except Exception as e:
            log.debug("Item parse error: %s", e)
            continue

    return cards


async def run(output_dir: str, start_page: int, newest_first: bool = False, base_url: str | None = None):
    output_path = Path(output_dir) / "tcgcollector_ja.json"

    if base_url:
        mode_label = "custom URL: " + base_url
    elif newest_first:
        base_url = BASE_URL_NEW_TO_OLD
        mode_label = "delta (newest-first)"
    else:
        base_url = BASE_URL_OLD_TO_NEW
        mode_label = "full (oldest-first)"
    log.info("Scrape mode: %s", mode_label)

    # Load existing data for resume / delta
    all_cards: list[dict] = []
    if output_path.exists():
        try:
            with open(output_path, encoding="utf-8") as f:
                all_cards = json.load(f)
            if newest_first:
                log.info("Delta mode: loaded %d existing entries — will stop when hitting known cards.", len(all_cards))
            elif start_page > 1:
                log.info("Resuming: loaded %d existing entries from %s", len(all_cards), output_path)
            else:
                log.info("Found existing file with %d entries — will append. Use --start-page to resume.", len(all_cards))
        except Exception:
            pass

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=False,
            slow_mo=50,  # Slightly slow actions to appear human
            args=["--disable-blink-features=AutomationControlled"],
        )
        context = await browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
            viewport={"width": 1280, "height": 900},
            locale="en-US",
            timezone_id="America/Chicago",
            # Realistic browser headers
            extra_http_headers={
                "Accept-Language": "en-US,en;q=0.9",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            },
        )

        # Remove automation indicator
        await context.add_init_script("""
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        """)

        page = await context.new_page()

        # Navigate to starting page
        url = base_url if start_page == 1 else base_url + f"&page={start_page}"
        log.info("Navigating to page %d: %s", start_page, url)
        await page.goto(url, wait_until="domcontentloaded", timeout=60_000)

        # Initial wait — longer to let CF resolve and page JS hydrate
        log.info("Initial wait (12s) for page to stabilize...")
        await asyncio.sleep(12)

        title = await page.title()
        log.info("Page title: %s", title)

        if await detect_cloudflare(page):
            log.warning("Cloudflare challenge detected. Waiting 30s for manual resolution...")
            log.warning("Complete the challenge in the browser window if prompted.")
            await asyncio.sleep(30)
            if await detect_cloudflare(page):
                log.error("Still blocked by Cloudflare. Exiting.")
                await browser.close()
                return

        # Estimate total pages from result count text if present (for logging only)
        # Do NOT rely on this to stop — pagination widget shows only a few links at a time.
        total_pages_est = 0
        try:
            body_text = await page.inner_text("body")
            m = re.search(r"(\d[\d,]+)\s+results?", body_text, re.IGNORECASE)
            if m:
                n = int(m.group(1).replace(",", ""))
                total_pages_est = (n + 119) // 120  # 120 per page
        except Exception:
            pass
        log.info("Estimated total pages: %s", total_pages_est or "unknown")

        current_page = start_page
        consecutive_failures = 0

        while True:
            loaded = await wait_for_cards(page)
            if not loaded:
                if await detect_cloudflare(page):
                    log.warning("Page %d: Cloudflare challenge. Waiting 30s...", current_page)
                    await asyncio.sleep(30)
                    loaded = await wait_for_cards(page)
                if not loaded:
                    log.warning("Page %d: No cards loaded after wait", current_page)
                    consecutive_failures += 1
                    if consecutive_failures >= 3:
                        log.error("3 consecutive failures — stopping")
                        break
                    await human_pause(5, 10)
                    # Try reloading
                    await page.reload(wait_until="domcontentloaded")
                    await asyncio.sleep(8)
                    loaded = await wait_for_cards(page)
                    if not loaded:
                        break

            if loaded:
                consecutive_failures = 0
                cards = await parse_image_page(page)
                all_cards.extend(cards)
                log.info(
                    "Page %d/~%s: %d cards parsed (total: %d)",
                    current_page,
                    total_pages_est or "?",
                    len(cards),
                    len(all_cards),
                )

                # Stop if this page had 0 cards — we've gone past the last page
                if len(cards) == 0:
                    log.info("Page %d returned 0 cards — reached end.", current_page)
                    break

                # Stop if >50% of this page's card_ids are already in our set.
                # In delta mode (newest-first) this means we've caught up to previously
                # scraped content. In full mode this means TCGCollector has looped.
                known_ids = {c["card_id"] for c in all_cards[:-len(cards)] if c.get("card_id")}
                new_ids = [c["card_id"] for c in cards if c.get("card_id")]
                if new_ids and sum(1 for cid in new_ids if cid in known_ids) / len(new_ids) > 0.5:
                    if newest_first:
                        log.info("Page %d: >50%% already known — caught up to existing data. Stopping.", current_page)
                    else:
                        log.info("Page %d: >50%% duplicate card IDs — TCGCollector looped. Stopping.", current_page)
                    # Remove the duplicates we just appended
                    new_only = [c for c in cards if c.get("card_id") not in known_ids]
                    del all_cards[-len(cards):]
                    all_cards.extend(new_only)
                    log.info("Kept %d new cards from that page.", len(new_only))
                    break
            else:
                log.error("Giving up on page %d", current_page)
                break

            # Checkpoint save
            if current_page % CHECKPOINT_EVERY == 0:
                with open(output_path, "w", encoding="utf-8") as f:
                    json.dump(all_cards, f, ensure_ascii=False, indent=2)
                log.info("Checkpoint saved: %d entries → %s", len(all_cards), output_path)

            # Navigate to next page — always by URL (pagination widget shows too few links)
            next_page_num = current_page + 1
            next_url = base_url + f"&page={next_page_num}"
            await human_pause()
            await page.goto(next_url, wait_until="domcontentloaded", timeout=60_000)
            current_page = next_page_num
            await asyncio.sleep(3)

        await browser.close()

    # Final save
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(all_cards, f, ensure_ascii=False, indent=2)
    log.info("DONE. %d total entries → %s", len(all_cards), output_path)

    # Summary
    names = {c["name_en"] for c in all_cards if c.get("name_en")}
    sets = {c["set_name"] for c in all_cards if c.get("set_name")}
    log.info("Unique Pokémon names: %d | Unique sets: %d", len(names), len(sets))


def main():
    parser = argparse.ArgumentParser(description="Scrape TCGCollector.com JP cards (image view)")
    parser.add_argument("--output-dir", default="backend/app/data")
    parser.add_argument(
        "--start-page", type=int, default=1,
        help="Page number to start from (use to resume interrupted scrape)"
    )
    parser.add_argument(
        "--newest-first", action="store_true",
        help="Delta mode: scrape newest cards first, stop when hitting already-known cards. "
             "Use this for incremental updates after new sets are released."
    )
    parser.add_argument(
        "--base-url",
        help="Custom TCGCollector base URL (without &page=N). Use to scrape a specific set. "
             "Example: pass a set-filtered URL from TCGCollector to scrape only that set."
    )
    args = parser.parse_args()
    asyncio.run(run(args.output_dir, args.start_page, newest_first=args.newest_first, base_url=args.base_url))


if __name__ == "__main__":
    main()
