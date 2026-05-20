import logging
import httpx
from dataclasses import dataclass, field
from app.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

BASE_URL = "https://api.pokemontcg.io/v2"


@dataclass
class PokemonCard:
    id: str
    name: str
    set_name: str
    set_code: str
    number: str
    rarity: str | None
    image_url: str | None
    image_url_hi: str | None
    supertype: str | None
    subtypes: list[str] = field(default_factory=list)


class PokemonTCGApiScraper:

    def __init__(self):
        headers = {"X-Api-Key": settings.pokemon_tcg_api_key} if settings.pokemon_tcg_api_key else {}
        self._client = httpx.AsyncClient(
            base_url=BASE_URL,
            headers=headers,
            timeout=httpx.Timeout(connect=10.0, read=60.0, write=10.0, pool=10.0),
        )

    async def search(self, query: str, language: str = "en", page_size: int = 10) -> list[PokemonCard]:
        q = self._build_query(query, language)
        params = {"q": q, "pageSize": page_size, "select": "id,name,set,number,rarity,images,supertype,subtypes"}
        try:
            resp = await self._client.get("/cards", params=params)
            resp.raise_for_status()
            data = resp.json().get("data", [])
            return [self._map(c) for c in data]
        except httpx.HTTPError as e:
            logger.error("Pokemon TCG API error: %s", e)
            return []

    def _build_query(self, query: str, language: str) -> str:
        # pokemontcg.io query syntax: field:value
        name_part = f'name:"{query}"'
        if language == "ja":
            # API primarily has EN cards; for JP we search by name and filter later
            return name_part
        return name_part

    async def get_all_for_seed(self, page: int = 1, page_size: int = 250) -> tuple[list[PokemonCard], bool]:
        params = {"pageSize": page_size, "page": page, "select": "id,name,set,number,rarity,images,supertype,subtypes"}
        for attempt in range(3):
            try:
                resp = await self._client.get("/cards", params=params)
                resp.raise_for_status()
                body = resp.json()
                cards = [self._map(c) for c in body.get("data", [])]
                total = body.get("totalCount", 0)
                has_more = page * page_size < total
                return cards, has_more
            except httpx.ReadTimeout:
                logger.warning("Read timeout on page %d (attempt %d/3)", page, attempt + 1)
                if attempt == 2:
                    raise
            except httpx.HTTPError as e:
                logger.error("HTTP error on page %d: %s", page, e)
                raise
        return [], False

    def _map(self, raw: dict) -> PokemonCard:
        images = raw.get("images", {})
        set_data = raw.get("set", {})
        return PokemonCard(
            id=raw["id"],
            name=raw.get("name", ""),
            set_name=set_data.get("name", ""),
            set_code=set_data.get("id", ""),
            number=raw.get("number", ""),
            rarity=raw.get("rarity"),
            image_url=images.get("small"),
            image_url_hi=images.get("large"),
            supertype=raw.get("supertype"),
            subtypes=raw.get("subtypes", []),
        )

    async def close(self):
        await self._client.aclose()
