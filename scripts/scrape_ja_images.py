"""
Scrape pokemon-card.com for Japanese card images.

Builds two lookup files in backend/app/data/:
  ja_sets.json   — {pg_value: {name_ja, total}}
  ja_images.json — {kana_name: [{pg, image_url, card_order}]}

Usage (run inside the backend container or with its venv):
  python scripts/scrape_ja_images.py
  python scripts/scrape_ja_images.py --output-dir backend/app/data
"""
import argparse
import asyncio
import json
import logging
import re
import time
from pathlib import Path

import httpx

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

SEARCH_PAGE = "https://www.pokemon-card.com/card-search/"
API_URL     = "https://www.pokemon-card.com/card-search/resultAPI.php"
IMG_BASE    = "https://www.pokemon-card.com"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; TCGScanner-research/1.0)",
    "Referer":    "https://www.pokemon-card.com/card-search/",
}
DELAY = 0.8   # seconds between requests — be polite


def fetch_pg_list(html: str) -> list[tuple[str, str]]:
    """Extract [(pg_value, label_ja)] from the uiData block on the search page."""
    idx = html.find("uiData")
    if idx < 0:
        return []
    block = html[idx:idx + 200_000]
    entries = re.findall(
        r'name:\s*["\']pg["\'],\s*value:\s*["\']([^"\']+)["\'],.*?label:\s*["\']([^"\']+)["\']',
        block,
        re.DOTALL,
    )
    return entries


async def fetch_set_cards(
    client: httpx.AsyncClient,
    pg: str,
    name_ja: str,
) -> tuple[int, list[dict]]:
    """
    Fetch all cards for a single set (pg value).
    Returns (total_cards, [{card_id, kana_name, image_url, card_order}]).
    """
    cards: list[dict] = []
    page = 1
    total = None

    while True:
        params = {"pg": pg, "rp": 100, "page": page}
        for attempt in range(3):
            try:
                r = await client.get(API_URL, params=params, timeout=20)
                r.raise_for_status()
                data = r.json()
                break
            except Exception as exc:
                if attempt == 2:
                    log.warning("pg=%s page=%d failed: %s", pg, page, exc)
                    return total or 0, cards
                await asyncio.sleep(2)

        if data.get("result") != 1:
            break

        if total is None:
            total = data.get("hitCnt", 0)
            log.info("  pg=%-8s %-40s  total=%d", pg, name_ja[:40], total)

        card_list = data.get("cardList", [])
        if not card_list:
            break

        for i, c in enumerate(card_list):
            image_path = c.get("cardThumbFile", "")
            if not image_path:
                continue
            cards.append({
                "card_id":    c.get("cardID", ""),
                "kana_name":  c.get("cardNameAltText", ""),
                "image_url":  IMG_BASE + image_path,
                "card_order": len(cards) + i + 1,
            })

        max_page = data.get("maxPage", 1)
        if page >= max_page:
            break
        page += 1
        await asyncio.sleep(DELAY)

    return total or 0, cards


async def main(output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    sets_out  = output_dir / "ja_sets.json"
    cards_out = output_dir / "ja_images.json"

    # ------------------------------------------------------------------
    # 1. Fetch the set list
    # ------------------------------------------------------------------
    log.info("Fetching set list from pokemon-card.com...")
    async with httpx.AsyncClient(headers=HEADERS, follow_redirects=True) as client:
        r = await client.get(SEARCH_PAGE, timeout=20)
        pg_list = fetch_pg_list(r.text)

    log.info("Found %d sets", len(pg_list))

    # ------------------------------------------------------------------
    # 2. Fetch cards for every set
    # ------------------------------------------------------------------
    sets_data: dict[str, dict] = {}    # pg → {name_ja, total}
    # kana_name → list of {pg, image_url, card_order}
    by_name: dict[str, list[dict]] = {}

    async with httpx.AsyncClient(headers=HEADERS, follow_redirects=True) as client:
        for pg_val, name_ja in pg_list:
            await asyncio.sleep(DELAY)
            total, cards = await fetch_set_cards(client, pg_val, name_ja)
            sets_data[pg_val] = {"name_ja": name_ja, "total": total}

            for c in cards:
                kana = c["kana_name"]
                if not kana:
                    continue
                entry = {
                    "pg":         pg_val,
                    "image_url":  c["image_url"],
                    "card_order": c["card_order"],
                }
                by_name.setdefault(kana, []).append(entry)

    # ------------------------------------------------------------------
    # 3. Write output
    # ------------------------------------------------------------------
    sets_out.write_text(json.dumps(sets_data, ensure_ascii=False, indent=2), encoding="utf-8")
    log.info("Wrote %s (%d sets)", sets_out, len(sets_data))

    cards_out.write_text(json.dumps(by_name, ensure_ascii=False, indent=2), encoding="utf-8")
    total_entries = sum(len(v) for v in by_name.values())
    log.info("Wrote %s (%d unique names, %d total entries)", cards_out, len(by_name), total_entries)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output-dir",
        default="backend/app/data",
        help="Directory to write ja_sets.json and ja_images.json",
    )
    args = parser.parse_args()
    asyncio.run(main(Path(args.output_dir)))
