from app.services.cache import CacheService, price_cache, card_cache, search_cache
from app.services.card_matcher import CardMatcherService

# Module-level singleton shared across all endpoints — one set of HTTP clients,
# one Playwright browser, one connection pool. Closed in app lifespan.
matcher = CardMatcherService()

__all__ = [
    "CacheService", "price_cache", "card_cache", "search_cache",
    "CardMatcherService", "matcher",
]
