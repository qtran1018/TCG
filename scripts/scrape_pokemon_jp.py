#!/usr/bin/env python3
"""
Scrape pokemon-card.com for Japanese card metadata (no image downloads).

Builds a lookup table keyed by (card_number, set_total) so that at scan time,
when OCR reads "039/047" from a physical Japanese card, we can instantly resolve
the Japanese image URL and kana name.

Output files (in backend/app/data/):
  pokemon_jp_cards.json        — all card records
  pokemon_jp_scrape_resume.json — last processed ID, used for resumption

Usage:
  python scripts/scrape_pokemon_jp.py            # run or resume from last saved ID
  python scripts/scrape_pokemon_jp.py 30000      # force-restart from a specific ID

Runtime estimate:
  ~50,000 IDs at 1 req/sec with gap-skipping = 12–15 hours total.
  Fully resumable — safe to interrupt and re-run at any time.

Dependencies (host machine, not Docker):
  pip install httpx beautifulsoup4 lxml
"""

import asyncio
import json
import logging
import re
import sys
from pathlib import Path

import httpx
from bs4 import BeautifulSoup

# ── Output ───────────────────────────────────────────────────────────────────
DATA_DIR = Path(__file__).parent.parent / "backend" / "app" / "data"
OUTPUT   = DATA_DIR / "pokemon_jp_cards.json"
RESUME   = DATA_DIR / "pokemon_jp_scrape_resume.json"

# ── Tuning ───────────────────────────────────────────────────────────────────
MAX_ID           = 52_000   # highest card ID to attempt
DELAY            = 1.1      # seconds between requests (be respectful)
SAVE_INTERVAL    = 250      # persist to disk every N IDs
MAX_CONSEC_EMPTY = 150      # consecutive empty/404 IDs before declaring a gap
SKIP_AHEAD       = 1_500    # IDs to jump over when a gap is detected

# ── Regex ────────────────────────────────────────────────────────────────────
# Image on pokemon-card.com CDN
LOCAL_IMG = re.compile(
    r'/assets/images/card_images/large/([^/"\']+)/(\d{6}_[^/"\']+\.(jpg|gif|png))',
    re.I,
)
# Image on GitHub CDN (used for some newer sets)
GITHUB_IMG = re.compile(
    r'(https://raw\.githubusercontent\.com/PokemonTCG/pokemon-tcg-images/master/cards/([^/"\']+)/\d{6}_[^/"\']+\.(jpg|gif|png))',
    re.I,
)
# Printed card number: "039/047" or "39/47"
CARD_NUM = re.compile(r'\b(\d{1,3})\s*/\s*(\d{2,4})\b')

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger(__name__)


# ── Parser ───────────────────────────────────────────────────────────────────

def parse_page(html: str, card_id: int) -> dict | None:
    """
    Extract card metadata from a card detail page.
    Returns None if the page has no card data (empty / gap ID).
    """
    # Image URL is the primary signal that this is a real card page.
    img_url = set_code = None

    m = LOCAL_IMG.search(html)
    if m:
        set_code = m.group(1)
        img_url  = "https://www.pokemon-card.com/assets/images/card_images/large/" + m.group(1) + "/" + m.group(2)

    if not img_url:
        m = GITHUB_IMG.search(html)
        if m:
            img_url  = m.group(1)
            set_code = m.group(2)

    if not img_url:
        return None  # no image → not a valid card page

    # Printed card number ("039/047")
    card_number = set_total = None
    m = CARD_NUM.search(html)
    if m:
        card_number = str(int(m.group(1)))   # strip leading zeros: "039" → "39"
        set_total   = str(int(m.group(2)))   # "047" → "47"

    # Japanese card name
    kana_name = _extract_kana_name(html)

    return {
        "id":          card_id,
        "kana_name":   kana_name,
        "card_number": card_number,
        "set_total":   set_total,
        "set_code_ja": set_code,
        "image_url":   img_url,
    }


def _extract_kana_name(html: str) -> str | None:
    """Pull the Japanese card name out of the page HTML."""
    soup = BeautifulSoup(html, "lxml")

    # Try semantic heading / card-name elements first
    for sel in ["h1", "h2", ".card-name", ".name", "[class*='title']", "[class*='card']"]:
        for el in soup.select(sel):
            t = el.get_text(strip=True)
            if re.search(r'[぀-ヿ一-鿿]', t) and 1 < len(t) < 40:
                return t

    # Fallback: any short Japanese string in the page
    for s in soup.find_all(string=re.compile(r'[぀-ヿ一-鿿]')):
        t = str(s).strip()
        if 1 < len(t) < 30 and '\n' not in t and '©' not in t:
            return t

    return None


# ── Main scrape loop ─────────────────────────────────────────────────────────

async def main() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    cards: list[dict] = []
    start_id = 1

    # Load existing results (safe to re-run)
    if OUTPUT.exists():
        cards = json.loads(OUTPUT.read_text(encoding="utf-8"))
        log.info("Loaded %d existing records from %s", len(cards), OUTPUT.name)

    # Resume from last saved position
    if RESUME.exists():
        r = json.loads(RESUME.read_text(encoding="utf-8"))
        start_id = r.get("next_id", 1)
        log.info("Resuming from ID %d", start_id)

    current_id   = start_id
    consec_empty = 0

    async with httpx.AsyncClient(
        timeout=httpx.Timeout(connect=10.0, read=20.0, write=10.0, pool=5.0),
        headers={"User-Agent": "Mozilla/5.0 (research/personal; contact: qtran1018@gmail.com)"},
        follow_redirects=True,
    ) as client:

        while current_id <= MAX_ID:
            url = f"https://www.pokemon-card.com/card-search/details.php/card/{current_id}/"

            try:
                resp = await client.get(url)

                if resp.status_code == 200:
                    card = parse_page(resp.text, current_id)
                    if card:
                        cards.append(card)
                        consec_empty = 0
                        log.info(
                            "ID %5d  %-22s  %3s/%-4s  [%s]",
                            current_id,
                            (card["kana_name"] or "?")[:22],
                            card["card_number"] or "?",
                            card["set_total"]   or "?",
                            card["set_code_ja"] or "?",
                        )
                    else:
                        consec_empty += 1

                elif resp.status_code == 404:
                    consec_empty += 1

                else:
                    log.warning("ID %d: HTTP %d — waiting 5s", current_id, resp.status_code)
                    await asyncio.sleep(5)
                    consec_empty += 1

            except httpx.TimeoutException:
                log.warning("ID %d: timeout — waiting 10s", current_id)
                await asyncio.sleep(10)
                consec_empty += 1

            except Exception as e:
                log.warning("ID %d: %s", current_id, e)
                consec_empty += 1

            # ── Gap detection: jump over empty ID ranges ──────────────────
            if consec_empty >= MAX_CONSEC_EMPTY:
                skip_to = current_id + SKIP_AHEAD
                log.info(
                    "Gap at ID %d (%d consecutive empty) → jumping to %d",
                    current_id, consec_empty, skip_to,
                )
                current_id   = skip_to
                consec_empty = 0
            else:
                current_id += 1

            # ── Periodic save ─────────────────────────────────────────────
            if current_id % SAVE_INTERVAL == 0:
                _save(cards, current_id)

            await asyncio.sleep(DELAY)

    _save(cards, MAX_ID + 1)
    log.info("Done — %d Japanese cards written to %s", len(cards), OUTPUT)


def _save(cards: list[dict], next_id: int) -> None:
    OUTPUT.write_text(
        json.dumps(cards, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    RESUME.write_text(
        json.dumps({"next_id": next_id, "total_so_far": len(cards)}),
        encoding="utf-8",
    )
    log.info("  → saved %d records (next_id=%d)", len(cards), next_id)


# ── Entry point ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    # Optional: pass a start ID to force-restart from that position
    if len(sys.argv) > 1:
        forced = int(sys.argv[1])
        RESUME.write_text(json.dumps({"next_id": forced}), encoding="utf-8")
        log.info("Forced start ID: %d", forced)

    asyncio.run(main())
