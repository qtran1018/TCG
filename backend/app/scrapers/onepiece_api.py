import logging
import httpx
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

# Community One Piece TCG API
OP_BASE_URL = "https://apitcg.com/api/one-piece/cards"


@dataclass
class OnePieceCard:
    id: str
    name: str
    name_ja: str | None
    set_name: str
    set_code: str
    card_number: str
    rarity: str | None
    image_url: str | None
    card_type: str | None
    colors: list[str] = field(default_factory=list)


class OnePieceScraper:

    def __init__(self):
        self._client = httpx.AsyncClient(timeout=15.0)

    async def search(self, query: str, language: str = "en") -> list[OnePieceCard]:
        try:
            resp = await self._client.get(OP_BASE_URL, params={"name": query, "limit": 20})
            resp.raise_for_status()
            data = resp.json()
            cards = data if isinstance(data, list) else data.get("data", data.get("results", []))
            return [self._map(c, language) for c in cards]
        except httpx.HTTPError as e:
            logger.error("One Piece API error: %s", e)
            return []

    async def search_by_number(self, card_number: str) -> OnePieceCard | None:
        try:
            resp = await self._client.get(OP_BASE_URL, params={"cardId": card_number, "limit": 1})
            resp.raise_for_status()
            data = resp.json()
            cards = data if isinstance(data, list) else data.get("data", [])
            return self._map(cards[0]) if cards else None
        except httpx.HTTPError as e:
            logger.error("One Piece API error: %s", e)
            return None

    def _map(self, raw: dict, language: str = "en") -> OnePieceCard:
        card_id = raw.get("id", raw.get("cardId", ""))
        set_code = raw.get("setId", raw.get("set", ""))
        return OnePieceCard(
            id=str(card_id),
            name=raw.get("name", raw.get("nameEn", "")),
            name_ja=raw.get("nameJp", raw.get("nameJa")),
            set_name=raw.get("setName", set_code),
            set_code=set_code,
            card_number=raw.get("cardId", raw.get("number", str(card_id))),
            rarity=raw.get("rarity"),
            image_url=raw.get("images", {}).get("small") if isinstance(raw.get("images"), dict) else raw.get("imageUrl"),
            card_type=raw.get("type", raw.get("cardType")),
            colors=raw.get("colors", [raw.get("color")] if raw.get("color") else []),
        )

    async def close(self):
        await self._client.aclose()
