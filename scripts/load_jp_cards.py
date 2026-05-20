"""
Load Japanese card records from tcgcollector_ja.json into the cards table.

Each TCGCollector entry becomes a language='ja' row. The image_url IS the JP art —
no overlay lookup needed once these records exist. The name field stores the English
translation (name_en) so OCR search (kana→EN) and PriceCharting queries work.

Upserts on external_id = "tcgcollector-{card_id}" so re-running after a fresh
scrape updates existing records rather than duplicating them.

Usage (from repo root, inside the backend container or with its venv):
    docker exec tcg_backend python scripts/load_jp_cards.py
    docker exec tcg_backend python scripts/load_jp_cards.py --dry-run
"""

import argparse
import asyncio
import json
import logging
import sys
from pathlib import Path

# Allow running from repo root or scripts/
sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

from sqlalchemy import select, text
from app.database import AsyncSessionLocal, engine
from app.models.card import Card

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

_REPO_ROOT = Path(__file__).parent.parent
# Resolve data path: works both from repo root (local) and inside Docker (/app = backend/)
DATA_PATH = next(
    p for p in [
        _REPO_ROOT / "backend" / "app" / "data" / "tcgcollector_ja.json",  # local
        Path("/app/app/data/tcgcollector_ja.json"),                          # Docker
    ]
    if p.exists()
)
BATCH_SIZE = 500


def _external_id(card_id: int) -> str:
    return f"tcgcollector-{card_id}"


async def load(dry_run: bool = False) -> None:
    log.info("Loading TCGCollector JP data from %s", DATA_PATH)
    entries: list[dict] = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    log.info("%d entries in source file", len(entries))

    # Deduplicate by card_id — scraper can produce duplicate card_ids on overlap pages
    seen: set[int] = set()
    unique: list[dict] = []
    for e in entries:
        cid = e.get("card_id")
        if cid and cid not in seen:
            seen.add(cid)
            unique.append(e)
    log.info("%d unique card_ids", len(unique))

    # Skip entries without a usable English name (can't search / price without it)
    valid = [e for e in unique if e.get("name_en", "").strip()]
    log.info("%d entries with name_en (skipping %d)", len(valid), len(unique) - len(valid))

    if dry_run:
        log.info("DRY RUN — no DB writes. Sample entry: %s", valid[0] if valid else "n/a")
        return

    inserted = updated = skipped = 0

    async with AsyncSessionLocal() as db:
        # Build a lookup of existing external_ids so we can decide insert vs update
        existing_rows = (await db.execute(
            select(Card.id, Card.external_id).where(Card.language == "ja")
        )).all()
        existing: dict[str, int] = {row.external_id: row.id for row in existing_rows if row.external_id}
        log.info("%d existing JP records in DB", len(existing))

        batch: list[dict] = []

        async def flush(batch: list[dict]) -> tuple[int, int]:
            ins = upd = 0
            for entry in batch:
                ext_id = _external_id(entry["card_id"])
                name = (entry.get("name_en") or "").strip()
                set_name = (entry.get("set_name") or "").strip() or None
                card_number = (entry.get("card_number") or "").strip() or None
                set_total = entry.get("set_total")  # int or None
                image_url = (entry.get("image_url") or "").strip() or None

                if ext_id in existing:
                    # Update existing record
                    card = await db.get(Card, existing[ext_id])
                    if card:
                        card.name = name
                        card.set_name = set_name
                        card.card_number = card_number
                        card.set_total = set_total
                        card.image_url = image_url
                        upd += 1
                else:
                    card = Card(
                        game="pokemon",
                        language="ja",
                        name=name,
                        set_name=set_name,
                        card_number=card_number,
                        set_total=set_total,
                        image_url=image_url,
                        external_id=ext_id,
                    )
                    db.add(card)
                    ins += 1

            await db.flush()
            return ins, upd

        for i, entry in enumerate(valid):
            batch.append(entry)
            if len(batch) >= BATCH_SIZE:
                i_count, u_count = await flush(batch)
                inserted += i_count
                updated += u_count
                batch = []
                log.info("Progress: %d / %d  (inserted=%d updated=%d)",
                         i + 1, len(valid), inserted, updated)

        if batch:
            i_count, u_count = await flush(batch)
            inserted += i_count
            updated += u_count

        await db.commit()

    log.info("Done. inserted=%d  updated=%d  skipped=%d", inserted, updated, skipped)
    log.info("Total JP records now: %d", inserted + updated + len(existing))


def main() -> None:
    parser = argparse.ArgumentParser(description="Load JP cards from TCGCollector JSON into DB")
    parser.add_argument("--dry-run", action="store_true", help="Parse and report without writing")
    args = parser.parse_args()
    asyncio.run(load(dry_run=args.dry_run))


if __name__ == "__main__":
    main()
