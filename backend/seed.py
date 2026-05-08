"""
Run once after docker-compose up to seed the Pokemon card database.
Usage: docker exec tcg_backend python seed.py
"""
import asyncio
import logging
import sys
import os

# Allow running from the backend/ directory directly (outside Docker)
sys.path.insert(0, os.path.dirname(__file__))

from app.database import create_tables, AsyncSessionLocal
from app.scrapers.pokemon_tcg_api import PokemonTCGApiScraper
from app.models.card import Card
from sqlalchemy import select

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

PAGE_SIZE = 100   # smaller pages = lower timeout risk per request
DELAY_BETWEEN_PAGES = 1.0  # seconds, keep API polite


async def seed_pokemon(max_pages: int = 999):
    api = PokemonTCGApiScraper()
    await create_tables()
    total_added = 0

    for page in range(1, max_pages + 1):
        logger.info("Fetching page %d (up to %d cards)...", page, PAGE_SIZE)
        try:
            cards, has_more = await api.get_all_for_seed(page=page, page_size=PAGE_SIZE)
        except Exception as e:
            logger.error("Failed to fetch page %d: %s — stopping.", page, e)
            break

        if not cards:
            logger.info("No cards returned on page %d, done.", page)
            break

        added = 0
        async with AsyncSessionLocal() as db:
            for api_card in cards:
                stmt = select(Card).where(Card.external_id == api_card.id)
                existing = (await db.execute(stmt)).scalar_one_or_none()
                if existing:
                    continue

                db.add(Card(
                    game="pokemon",
                    language="en",
                    name=api_card.name,
                    set_name=api_card.set_name,
                    set_code=api_card.set_code,
                    card_number=api_card.number,
                    rarity=api_card.rarity,
                    image_url=api_card.image_url,
                    image_url_hi=api_card.image_url_hi,
                    phash=None,
                    external_id=api_card.id,
                ))
                added += 1

            await db.commit()

        total_added += added
        logger.info("Page %d done: %d new cards (total added: %d). More pages: %s",
                    page, added, total_added, has_more)

        if not has_more:
            break

        await asyncio.sleep(DELAY_BETWEEN_PAGES)

    await api.close()
    logger.info("Seed complete. Total cards added: %d", total_added)


if __name__ == "__main__":
    asyncio.run(seed_pokemon())
