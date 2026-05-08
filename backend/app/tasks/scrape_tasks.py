import asyncio
import logging
from celery import Celery
from app.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

celery_app = Celery(
    "tcg_worker",
    broker=settings.redis_url,
    backend=settings.redis_url,
)

celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="UTC",
    enable_utc=True,
    task_acks_late=True,
    worker_prefetch_multiplier=1,
)


def run_async(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


@celery_app.task(bind=True, max_retries=3, default_retry_delay=60)
def fetch_card_prices_task(self, card_id: int, scan_type: str = "raw"):
    from app.database import AsyncSessionLocal
    from app.models.card import Card
    from sqlalchemy import select
    from app.services.card_matcher import CardMatcherService

    async def _run():
        async with AsyncSessionLocal() as db:
            result = await db.execute(select(Card).where(Card.id == card_id))
            card = result.scalar_one_or_none()
            if not card:
                logger.warning("Card %d not found for price fetch", card_id)
                return
            matcher = CardMatcherService()
            await matcher.get_prices(card, scan_type)
            await db.commit()
            logger.info("Prices fetched for card %d (%s)", card_id, scan_type)

    try:
        run_async(_run())
    except Exception as exc:
        logger.error("Price fetch failed for card %d: %s", card_id, exc)
        raise self.retry(exc=exc)


@celery_app.task
def seed_pokemon_cards_task(page: int = 1):
    from app.database import AsyncSessionLocal
    from app.scrapers.pokemon_tcg_api import PokemonTCGApiScraper
    from app.services.image_hasher import compute_phash_from_url
    from app.models.card import Card
    from sqlalchemy import select

    async def _run():
        api = PokemonTCGApiScraper()
        async with AsyncSessionLocal() as db:
            cards, has_more = await api.get_all_for_seed(page=page, page_size=250)
            for api_card in cards:
                stmt = select(Card).where(Card.external_id == api_card.id)
                existing = (await db.execute(stmt)).scalar_one_or_none()
                if existing:
                    continue
                phash = await compute_phash_from_url(api_card.image_url) if api_card.image_url else None
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
                    phash=phash,
                    external_id=api_card.id,
                ))
            await db.commit()
            logger.info("Seeded page %d (%d cards)", page, len(cards))
            if has_more:
                seed_pokemon_cards_task.delay(page + 1)
        await api.close()

    run_async(_run())
