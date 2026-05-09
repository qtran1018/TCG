from datetime import datetime
from pydantic import BaseModel, HttpUrl


class CardBase(BaseModel):
    game: str
    language: str
    name: str
    name_ja: str | None = None
    set_name: str | None = None
    set_code: str | None = None
    card_number: str | None = None
    rarity: str | None = None
    image_url: str | None = None
    image_url_hi: str | None = None
    pricecharting_url: str | None = None


class CardOut(CardBase):
    id: int
    phash: str | None = None
    pricecharting_id: str | None = None
    external_id: str | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


class SaleRecord(BaseModel):
    date: str
    title: str
    price: float | None = None


class PricePoint(BaseModel):
    date: str
    price: float


class PriceOut(BaseModel):
    pricecharting_id: str
    pricecharting_url: str | None = None
    scan_type: str
    price_loose: float | None = None
    price_cib: float | None = None
    price_graded_7: float | None = None
    price_graded_8: float | None = None
    price_graded_9: float | None = None
    price_graded_10: float | None = None
    currency: str = "USD"
    fetched_at: datetime
    recent_sales: list[SaleRecord] = []
    price_history_ungraded: list[PricePoint] = []
    price_history_graded: list[PricePoint] = []

    model_config = {"from_attributes": True}


class CardWithPrice(BaseModel):
    card: CardOut
    price: PriceOut | None = None


class SearchRequest(BaseModel):
    ocr_text: str
    game: str          # "pokemon" | "onepiece"
    scan_type: str     # "raw" | "psa"
    language: str      # "en" | "ja"


class SearchResult(BaseModel):
    candidates: list[CardOut]
    query_used: str


class PSACertRequest(BaseModel):
    cert_number: str
    game: str


class PSACertResult(BaseModel):
    cert_number: str
    grade: str | None = None
    card_name: str | None = None
    set_name: str | None = None
    year: str | None = None
    population: int | None = None
    card: CardOut | None = None
    price: PriceOut | None = None


class BatchQueryItem(BaseModel):
    ocr_text: str
    game: str = "pokemon"
    language: str = "en"


class BatchSearchRequest(BaseModel):
    queries: list[BatchQueryItem]
    scan_type: str = "raw"


class BatchSearchItem(BaseModel):
    candidates: list[CardOut]
    query_used: str


class BatchSearchResult(BaseModel):
    results: list[BatchSearchItem]


class DetectRequest(BaseModel):
    image_base64: str
    max_cards: int = 10


class BoundingBox(BaseModel):
    left: int
    top: int
    width: int
    height: int


class DetectResult(BaseModel):
    boxes: list[BoundingBox]
    image_width: int
    image_height: int


class HistoryEntry(BaseModel):
    id: int
    game: str
    scan_type: str
    language: str
    resolved_card_name: str | None = None
    price_loose: float | None = None
    price_graded_10: float | None = None
    scanned_at: datetime

    model_config = {"from_attributes": True}
