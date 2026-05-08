import logging
import re
from sqlalchemy import select, or_, func
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.card import Card
from app.scrapers.pricecharting import PricechartingScraper
from app.scrapers.pokemon_tcg_api import PokemonTCGApiScraper
from app.scrapers.onepiece_api import OnePieceScraper
from app.services.cache import search_cache, price_cache
from app.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

POKEMON_SET_NUM_RE = re.compile(r"(\d{1,3})\s*/\s*(\d{1,3})")
ONEPIECE_CARD_NUM_RE = re.compile(r"(OP\d{2}-\d{3}|ST\d{2}-\d{3}|P-\d{3})", re.I)
HP_RE = re.compile(r"\bHP\s*(\d+)\b", re.I)
# Terms that are never the card name
_POKEMON_NON_NAME_RE = re.compile(
    r"^(basi\w*|basic|stage\s*[12]|mega|vmax|vstar|vunion|"
    r"weakness|resistance|retreat|damage|ability|trainer|item|"
    r"stadium|supporter|energy|water|fire|grass|lightning|psychic|"
    r"fighting|darkness|metal|fairy|colorless|dragon|"
    r"pok[eé]mon|nintendo|game\s*freak|creatures|illus\.?|no\.|"
    r"copyright|overrun|aurora|beam|hp)$",
    re.I,
)


def _find_pokemon_name(lines: list[str]) -> str | None:
    """Return the first line that looks like a Pokémon name."""
    for line in lines:
        words = line.split()
        # Name is 1–3 words
        if not 1 <= len(words) <= 3:
            continue
        # No digits
        if any(c.isdigit() for c in line):
            continue
        # No punctuation except hyphens (Tapu-Koko, Mr. Mime needs a dot though)
        if re.search(r"[,!?;:()/\\]", line):
            continue
        # Must start with an uppercase letter
        if not line[0].isupper():
            continue
        # Reject all-caps short tokens (OCR stage labels like BASIG, PRE)
        if line.replace(" ", "").isupper() and len(line) > 3:
            continue
        # Reject known non-name terms
        if any(_POKEMON_NON_NAME_RE.match(w) for w in words):
            continue
        return line
    return None


def extract_card_hints(ocr_text: str, game: str, language: str) -> dict:
    hints: dict = {"raw_text": ocr_text}
    lines = [l.strip() for l in ocr_text.split("\n") if l.strip()]

    if game == "pokemon":
        m = POKEMON_SET_NUM_RE.search(ocr_text)
        if m:
            hints["card_number"] = m.group(1).lstrip("0") or "0"
            hints["set_total"] = m.group(2).lstrip("0") or "0"
        hp = HP_RE.search(ocr_text)
        if hp:
            hints["hp"] = hp.group(1)
        name = _find_pokemon_name(lines)
        if name:
            hints["probable_name"] = name

    elif game == "onepiece":
        m = ONEPIECE_CARD_NUM_RE.search(ocr_text)
        if m:
            hints["card_number"] = m.group(1).upper()
        if lines:
            hints["probable_name"] = lines[0]

    return hints


def build_search_query(hints: dict, game: str, language: str) -> str:
    """Returns a human-readable label for the query (used in API response only)."""
    if "probable_name" in hints:
        name = hints["probable_name"]
        if game == "pokemon" and "card_number" in hints and "set_total" in hints:
            return f"{name} {hints['card_number']}/{hints['set_total']}"
        if game == "onepiece" and "card_number" in hints:
            return f"{name} {hints['card_number']}"
        return name
    return hints.get("raw_text", "")[:60]


class CardMatcherService:

    def __init__(self):
        self.pc_scraper = PricechartingScraper()
        self.pokemon_api = PokemonTCGApiScraper()
        self.op_scraper = OnePieceScraper()

    async def search_cards(
        self,
        ocr_text: str,
        game: str,
        language: str,
        db: AsyncSession,
        image_phash: str | None = None,  # reserved for future re-enable
    ) -> tuple[list[Card], str]:
        hints = extract_card_hints(ocr_text, game, language)
        query = build_search_query(hints, game, language)
        name_for_api = hints.get("probable_name") or query
        logger.info("OCR hints: %s | query: %s", hints, query)

        cache_key = f"{game}:{language}:{query}"
        cached = await search_cache.get(cache_key)
        if cached:
            logger.info("Cache hit for search: %s", cache_key)
            card_ids = cached.get("ids", [])
            if card_ids:
                result = await db.execute(select(Card).where(Card.id.in_(card_ids)))
                return list(result.scalars().all()), query

        db_cards = await self._search_db(hints, game, language, db)

        if len(db_cards) < 3:
            api_cards = await self._search_external(name_for_api, game, language, db, hints)
            existing_ids = {c.id for c in db_cards}
            for ac in api_cards:
                if ac.id not in existing_ids:
                    db_cards.append(ac)
                    existing_ids.add(ac.id)

        db_cards = self._dedupe_and_rank(db_cards, hints)
        await search_cache.set(cache_key, ttl=3600, value={"ids": [c.id for c in db_cards[:20]]})
        return db_cards[:10], query

    def _dedupe_and_rank(self, cards: list[Card], hints: dict) -> list[Card]:
        seen: set[str] = set()
        unique: list[Card] = []
        for c in cards:
            key = f"{c.name}|{c.set_code or ''}|{c.card_number or ''}"
            if key not in seen:
                seen.add(key)
                unique.append(c)
        # Rank: exact card number match first, then prefix match, then rest
        card_num = hints.get("card_number", "")
        if card_num:
            def rank(c: Card) -> int:
                num = (c.card_number or "").lstrip("0").split("/")[0]
                hint = card_num.lstrip("0")
                if num == hint:
                    return 0
                if num.startswith(hint):
                    return 1
                return 2
            unique.sort(key=rank)
        return unique

    async def _search_db(self, hints: dict, game: str, language: str, db: AsyncSession) -> list[Card]:
        name = hints.get("probable_name", "")
        card_number = hints.get("card_number", "")
        set_total = hints.get("set_total", "")

        stmt = select(Card).where(Card.game == game, Card.language == language)

        if name and card_number:
            # Prefer name + card number match first
            exact = await db.execute(
                stmt.where(
                    Card.name.ilike(f"%{name}%"),
                    Card.card_number.ilike(f"%{card_number}%"),
                ).limit(10)
            )
            results = list(exact.scalars().all())
            if results:
                return results

        if name:
            result = await db.execute(
                stmt.where(Card.name.ilike(f"%{name}%")).limit(10)
            )
            return list(result.scalars().all())

        if card_number:
            result = await db.execute(
                stmt.where(Card.card_number.ilike(f"%{card_number}%")).limit(10)
            )
            return list(result.scalars().all())

        return []

    async def _search_external(self, query: str, game: str, language: str, db: AsyncSession, hints: dict | None = None) -> list[Card]:
        cards: list[Card] = []
        if game == "pokemon":
            api_results = await self.pokemon_api.search(query, language)
            for r in api_results[:10]:
                card = await self._upsert_pokemon_card(r, language, db)
                if card:
                    cards.append(card)
        elif game == "onepiece":
            api_results = await self.op_scraper.search(query, language)
            for r in api_results[:10]:
                card = await self._upsert_op_card(r, language, db)
                if card:
                    cards.append(card)
        return cards

    async def _upsert_pokemon_card(self, api_card, language: str, db: AsyncSession) -> Card | None:
        stmt = select(Card).where(Card.external_id == api_card.id)
        result = await db.execute(stmt)
        existing = result.scalars().first()
        if existing:
            return existing

        card = Card(
            game="pokemon",
            language=language,
            name=api_card.name,
            set_name=api_card.set_name,
            set_code=api_card.set_code,
            card_number=api_card.number,
            rarity=api_card.rarity,
            image_url=api_card.image_url,
            image_url_hi=api_card.image_url_hi,
            phash=None,
            external_id=api_card.id,
        )
        db.add(card)
        await db.flush()
        return card

    async def _upsert_op_card(self, api_card, language: str, db: AsyncSession) -> Card | None:
        stmt = select(Card).where(Card.external_id == api_card.id, Card.game == "onepiece")
        result = await db.execute(stmt)
        existing = result.scalars().first()
        if existing:
            return existing

        card = Card(
            game="onepiece",
            language=language,
            name=api_card.name,
            name_ja=api_card.name_ja,
            set_name=api_card.set_name,
            set_code=api_card.set_code,
            card_number=api_card.card_number,
            rarity=api_card.rarity,
            image_url=api_card.image_url,
            phash=None,
            external_id=api_card.id,
        )
        db.add(card)
        await db.flush()
        return card

    async def get_prices(self, card: Card, scan_type: str) -> dict | None:
        if not card.name:
            return None

        # Build URL locally — never modify the card object to avoid unique constraint
        # violations when duplicate rows exist in the DB.
        pc_url = card.pricecharting_url
        if pc_url is None and card.set_name and card.card_number:
            pc_url = self.pc_scraper.build_game_url(
                card.name, card.set_name, card.card_number, card.game
            )

        if not pc_url:
            return None

        pc_id = pc_url.rstrip("/").split("/")[-1]
        cache_key = f"{pc_id}:{scan_type}"
        cached = await price_cache.get(cache_key)
        if cached:
            return cached

        prices = await self.pc_scraper.get_prices(pc_url)
        price_dict = {
            "pricecharting_id": pc_id,
            "pricecharting_url": pc_url,
            "scan_type": scan_type,
            "price_loose": prices.loose,
            "price_cib": prices.cib,
            "price_graded_7": prices.graded_7,
            "price_graded_8": prices.graded_8,
            "price_graded_9": prices.graded_9,
            "price_graded_10": prices.graded_10,
            "currency": "USD",
            "recent_sales": [
                {"date": s.date, "title": s.title, "price": s.price}
                for s in prices.recent_sales
            ],
            "price_history_ungraded": [
                {"date": p.date, "price": p.price}
                for p in prices.price_history_ungraded
            ],
            "price_history_graded": [
                {"date": p.date, "price": p.price}
                for p in prices.price_history_graded
            ],
        }

        await price_cache.set(cache_key, ttl=settings.scrape_cache_ttl_prices, value=price_dict)
        return price_dict
