"""
Update image_url for McDonald's EN cards using TCGCollector-scraped images.

Usage:
    # 1. Scrape TCGCollector EN McDonald's expansions first:
    py -3 scripts/scrape_tcgcollector.py \
        --base-url "https://www.tcgcollector.com/cards/intl?releaseDateOrder=newToOld&displayAs=images&expansions=93,642,582,488,409,148,139,121,122,94,92,91,90" \
        --output-file backend/app/data/tcgcollector_mcd_en.json

    # 2. Run this script to update the DB:
    docker exec tcg_backend python /scripts/update_mcd_images.py

Matching logic:
  - Extract 4-digit year from TCGCollector set_name (e.g. "McDonald's 2017 Collection" → 2017)
  - Match DB row WHERE game='pokemon' AND language='en'
      AND set_name = "McDonald's Collection {year}"
      AND card_number = scraped card_number
  - Update image_url
"""

import asyncio
import json
import logging
import re
import sys
from pathlib import Path

# Allow running inside the Docker container where /app is the working dir
sys.path.insert(0, "/app")

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker

from app.config import get_settings
from app.models.card import Card

settings = get_settings()

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

DATA_FILE = Path("/app/app/data/tcgcollector_mcd_en.json")
# Fallback path when running outside Docker
if not DATA_FILE.exists():
    DATA_FILE = Path(__file__).parent.parent / "backend/app/data/tcgcollector_mcd_en.json"


def extract_year(set_name: str) -> str | None:
    m = re.search(r"\b(20\d{2})\b", set_name)
    return m.group(1) if m else None


async def main():
    if not DATA_FILE.exists():
        log.error("Data file not found: %s", DATA_FILE)
        log.error("Run scrape_tcgcollector.py with --output-file first.")
        sys.exit(1)

    with open(DATA_FILE, encoding="utf-8") as f:
        scraped: list[dict] = json.load(f)

    log.info("Loaded %d scraped entries from %s", len(scraped), DATA_FILE)

    engine = create_async_engine(settings.database_url, echo=False)
    async_session = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    updated = 0
    skipped_no_year = 0
    skipped_no_match = 0
    skipped_no_image = 0

    async with async_session() as db:
        for entry in scraped:
            image_url = entry.get("image_url")
            if not image_url:
                skipped_no_image += 1
                continue

            set_name_scraped = entry.get("set_name", "")
            card_number = entry.get("card_number", "").strip()

            year = extract_year(set_name_scraped)
            if not year:
                log.debug("No year found in set_name %r — skipping", set_name_scraped)
                skipped_no_year += 1
                continue

            db_set_name = f"McDonald's Collection {year}"

            result = await db.execute(
                select(Card).where(
                    Card.game == "pokemon",
                    Card.language == "en",
                    Card.set_name == db_set_name,
                    Card.card_number == card_number,
                )
            )
            card = result.scalar_one_or_none()

            if not card:
                log.debug("No DB match for %s #%s", db_set_name, card_number)
                skipped_no_match += 1
                continue

            if card.image_url == image_url:
                continue  # already up to date

            log.info(
                "Updating %s #%s (%s): %s → %s",
                db_set_name, card_number, card.name,
                (card.image_url or "")[:60], image_url[:60],
            )
            card.image_url = image_url
            updated += 1

        await db.commit()

    log.info(
        "Done. updated=%d  skipped_no_match=%d  skipped_no_year=%d  skipped_no_image=%d",
        updated, skipped_no_match, skipped_no_year, skipped_no_image,
    )


if __name__ == "__main__":
    asyncio.run(main())
