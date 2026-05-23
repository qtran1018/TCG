from datetime import datetime
from sqlalchemy import String, Integer, Float, Text, DateTime, Index
from sqlalchemy.orm import Mapped, mapped_column
from pgvector.sqlalchemy import Vector
from app.database import Base


class Card(Base):
    __tablename__ = "cards"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    game: Mapped[str] = mapped_column(String(50), nullable=False)          # "pokemon" | "onepiece"
    language: Mapped[str] = mapped_column(String(10), nullable=False)      # "en" | "ja"
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    name_ja: Mapped[str | None] = mapped_column(String(255), nullable=True)
    set_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    set_code: Mapped[str | None] = mapped_column(String(50), nullable=True)
    card_number: Mapped[str | None] = mapped_column(String(50), nullable=True)
    set_total: Mapped[int | None] = mapped_column(Integer, nullable=True)   # JP set size; used for OCR disambiguation
    rarity: Mapped[str | None] = mapped_column(String(100), nullable=True)
    image_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    image_url_hi: Mapped[str | None] = mapped_column(Text, nullable=True)
    phash: Mapped[str | None] = mapped_column(String(64), nullable=True)  # perceptual hash hex
    pricecharting_id: Mapped[str | None] = mapped_column(String(255), nullable=True, unique=True)
    pricecharting_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    external_id: Mapped[str | None] = mapped_column(String(255), nullable=True)  # pokemontcg.io id
    embedding: Mapped[list | None] = mapped_column(Vector(512), nullable=True)  # CLIP ViT-B/32
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        Index("ix_cards_game_language", "game", "language"),
        Index("ix_cards_name_trgm", "name", postgresql_ops={"name": "gin_trgm_ops"}, postgresql_using="gin"),
    )


class ScanHistory(Base):
    __tablename__ = "scan_history"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    card_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    game: Mapped[str] = mapped_column(String(50))
    scan_type: Mapped[str] = mapped_column(String(20))    # "raw" | "psa"
    language: Mapped[str] = mapped_column(String(10))
    ocr_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    psa_cert: Mapped[str | None] = mapped_column(String(50), nullable=True)
    resolved_card_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    price_loose: Mapped[float | None] = mapped_column(Float, nullable=True)
    price_graded_10: Mapped[float | None] = mapped_column(Float, nullable=True)
    image_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    set_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    card_number: Mapped[str | None] = mapped_column(String(50), nullable=True)
    scanned_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
