#!/usr/bin/env python3
"""
Build card embeddings: fetch all Pokemon cards from pokemontcg.io, match to
local Kaggle images (fast), fall back to URL download when not found locally.

Usage:
    python scripts/build_embeddings.py \
        --dataset "Pokemon TCG" \
        --db-url postgresql://tcg:tcgpass@localhost:5432/tcgdb

The script:
  1. Migrates the embedding column to vector(512) if it is still vector(256)
  2. Fetches all EN Pokemon cards from pokemontcg.io API (~82 pages)
  3. Upserts any missing cards into the DB
  4. For each card: uses local Kaggle image first, downloads image_url if not found
  5. Embeds all images with CLIP ViT-B/32 in batches (one forward pass per batch)
  6. Stores 512-dim embeddings in the cards table
  7. Creates an IVFFlat index on the embedding column

Re-running is safe: already-embedded cards are skipped unless --force is passed.
"""

import argparse
import asyncio
import io
import json
import logging
import os
import re
import sys
from pathlib import Path

import asyncpg
import numpy as np

# Support both local (./backend) and Docker (/app) layouts
for _candidate in [Path(__file__).parent.parent / "backend", Path("/app")]:
    if (_candidate / "app").is_dir():
        sys.path.insert(0, str(_candidate))
        break

from app.services.card_embedder import embed_batch  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

PTCG_API = "https://api.pokemontcg.io/v2/cards"
PAGE_SIZE = 250
BATCH_SIZE = 64
SUPPORTED_EXTS = {".jpg", ".jpeg", ".png"}

_BACKEND_ROOT = Path("/app") if Path("/app/app").is_dir() else Path(__file__).parent.parent / "backend"


# ---------------------------------------------------------------------------
# pokemontcg.io API fetch
# ---------------------------------------------------------------------------

async def fetch_all_ptcg_cards(api_key: str | None) -> list[dict]:
    import aiohttp
    headers = {"X-Api-Key": api_key} if api_key else {}
    all_cards: list[dict] = []
    page = 1
    timeout = aiohttp.ClientTimeout(total=90)
    async with aiohttp.ClientSession(headers=headers, timeout=timeout) as session:
        while True:
            params = {"pageSize": PAGE_SIZE, "page": page}
            data = None
            for attempt in range(3):
                try:
                    async with session.get(PTCG_API, params=params) as resp:
                        if resp.status != 200:
                            logger.error("API error %d on page %d", resp.status, page)
                            break
                        data = await resp.json()
                    break
                except Exception as e:
                    logger.warning("Page %d attempt %d failed: %s", page, attempt + 1, e)
                    if attempt < 2:
                        await asyncio.sleep(5 * (attempt + 1))
            if data is None:
                logger.error("Failed to fetch page %d after 3 attempts — stopping", page)
                break
            cards = data.get("data", [])
            if not cards:
                break
            all_cards.extend(cards)
            total = data.get("totalCount", 0)
            logger.info("Fetched page %d — %d / %d cards", page, len(all_cards), total)
            if len(all_cards) >= total:
                break
            page += 1
    return all_cards


# ---------------------------------------------------------------------------
# Local Kaggle image lookup
# ---------------------------------------------------------------------------

def slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def find_local_image(dataset_path: Path, set_name: str, card_number: str) -> Path | None:
    folder = dataset_path / slugify(set_name)
    if not folder.is_dir():
        return None
    return _match_card_file(folder, card_number)


def _match_card_file(folder: Path, card_number: str) -> Path | None:
    digits = re.sub(r"^[A-Za-z]+", "", card_number)
    target = (digits.lstrip("0") or "0")

    for min_len in (3, 1):
        for f in sorted(folder.iterdir()):
            if f.suffix.lower() not in SUPPORTED_EXTS:
                continue
            tokens = re.split(r"[-_]", f.stem)
            numeric = [t for t in tokens if re.fullmatch(r"\d+", t) and len(t) >= min_len]
            for tok in numeric:
                if (tok.lstrip("0") or "0") == target:
                    return f
    return None


# ---------------------------------------------------------------------------
# Image fetch
# ---------------------------------------------------------------------------

async def get_image_bytes(card: dict, dataset_path: Path | None, session) -> bytes | None:
    set_name = card.get("set", {}).get("name", "")
    card_number = card.get("number", "")

    if dataset_path:
        local = find_local_image(dataset_path, set_name, card_number)
        if local:
            return local.read_bytes()

    url = card.get("images", {}).get("small")
    if not url:
        return None
    try:
        async with session.get(url, timeout=20) as resp:
            if resp.status == 200:
                return await resp.read()
    except Exception as e:
        logger.warning("Download failed for %s: %s", card.get("id"), e)
    return None


# ---------------------------------------------------------------------------
# DB upsert
# ---------------------------------------------------------------------------

async def upsert_cards(conn, cards: list[dict]) -> dict[str, int]:
    if not cards:
        return {}

    ext_ids = [c.get("id", "") for c in cards]
    existing = {
        r["external_id"]: r["id"]
        for r in await conn.fetch(
            "SELECT id, external_id FROM cards WHERE external_id = ANY($1::text[])", ext_ids
        )
    }

    to_insert = [c for c in cards if c.get("id", "") not in existing]

    CHUNK = 500
    new_ids: dict[str, int] = {}
    for i in range(0, len(to_insert), CHUNK):
        chunk = to_insert[i : i + CHUNK]
        rows = await conn.fetch(
            """
            INSERT INTO cards
                (game, language, name, set_name, set_code, card_number,
                 rarity, image_url, image_url_hi, external_id)
            SELECT * FROM unnest(
                $1::text[], $2::text[], $3::text[], $4::text[], $5::text[],
                $6::text[], $7::text[], $8::text[], $9::text[], $10::text[]
            ) AS t(game,language,name,set_name,set_code,card_number,rarity,image_url,image_url_hi,external_id)
            ON CONFLICT DO NOTHING
            RETURNING id, external_id
            """,
            ["pokemon"] * len(chunk),
            ["en"] * len(chunk),
            [c.get("name", "") for c in chunk],
            [c.get("set", {}).get("name") for c in chunk],
            [c.get("set", {}).get("id") for c in chunk],
            [c.get("number") for c in chunk],
            [c.get("rarity") for c in chunk],
            [c.get("images", {}).get("small") for c in chunk],
            [c.get("images", {}).get("large") for c in chunk],
            [c.get("id", "") for c in chunk],
        )
        for r in rows:
            new_ids[r["external_id"]] = r["id"]

    return {**existing, **new_ids}


# ---------------------------------------------------------------------------
# DB migration
# ---------------------------------------------------------------------------

async def migrate_embedding_column(conn):
    """Ensure the embedding column is vector(512). Drops and recreates if still vector(256)."""
    row = await conn.fetchrow(
        """
        SELECT pg_catalog.format_type(atttypid, atttypmod) AS col_type
        FROM pg_attribute
        JOIN pg_class ON pg_class.oid = pg_attribute.attrelid
        WHERE pg_class.relname = 'cards' AND pg_attribute.attname = 'embedding'
        """
    )
    if row is None:
        logger.info("embedding column not found — adding as vector(512)")
        await conn.execute("ALTER TABLE cards ADD COLUMN embedding vector(512)")
    elif row["col_type"] == "vector(256)":
        logger.info("Migrating embedding column from vector(256) to vector(512) — existing embeddings cleared")
        await conn.execute("DROP INDEX IF EXISTS ix_cards_embedding_ivfflat")
        await conn.execute("ALTER TABLE cards DROP COLUMN embedding")
        await conn.execute("ALTER TABLE cards ADD COLUMN embedding vector(512)")
    elif row["col_type"] == "vector(512)":
        logger.info("embedding column is already vector(512)")
    else:
        logger.warning("Unexpected embedding column type: %s — leaving as-is", row["col_type"])


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def main(dataset_path: Path | None, db_url: str, api_key: str | None, force: bool):
    import aiohttp

    logger.info("Fetching all Pokemon cards from pokemontcg.io...")
    all_cards = await fetch_all_ptcg_cards(api_key)
    logger.info("Total cards fetched: %d", len(all_cards))

    conn = await asyncpg.connect(db_url)
    try:
        await conn.execute("CREATE EXTENSION IF NOT EXISTS vector")

        # Ensure column is vector(512)
        await migrate_embedding_column(conn)

        logger.info("Upserting cards into DB...")
        ext_to_db_id = await upsert_cards(conn, all_cards)
        logger.info("DB now has entries for %d cards", len(ext_to_db_id))

        if force:
            to_embed = all_cards
        else:
            existing = set(
                r["external_id"]
                for r in await conn.fetch(
                    "SELECT external_id FROM cards WHERE embedding IS NOT NULL AND external_id IS NOT NULL"
                )
            )
            to_embed = [c for c in all_cards if c.get("id") not in existing]

        logger.info("%d cards need embedding (%d already done)", len(to_embed), len(all_cards) - len(to_embed))

        failures: dict[str, list[dict]] = {"no_image": [], "download_failed": [], "embed_failed": []}

        if not to_embed:
            logger.info("Nothing to embed — run with --force to re-embed all.")
        else:
            logger.info("Fetching images and embedding (batch_size=%d)...", BATCH_SIZE)

            async with aiohttp.ClientSession() as session:
                for i in range(0, len(to_embed), BATCH_SIZE):
                    batch_cards = to_embed[i : i + BATCH_SIZE]
                    image_bytes_list = await asyncio.gather(
                        *[get_image_bytes(c, dataset_path, session) for c in batch_cards]
                    )

                    # Filter out cards with no image
                    valid: list[tuple[dict, bytes]] = []
                    for card, img_bytes in zip(batch_cards, image_bytes_list):
                        ext_id = card.get("id", "")
                        card_info = {
                            "id": ext_id,
                            "name": card.get("name", ""),
                            "set": card.get("set", {}).get("name", ""),
                            "number": card.get("number", ""),
                            "image_url": card.get("images", {}).get("small", ""),
                        }
                        if not img_bytes:
                            has_local = bool(
                                dataset_path and find_local_image(
                                    dataset_path,
                                    card.get("set", {}).get("name", ""),
                                    card.get("number", ""),
                                )
                            )
                            failures["no_image" if not has_local else "download_failed"].append(card_info)
                        else:
                            valid.append((card, img_bytes))

                    if not valid:
                        continue

                    try:
                        vecs = embed_batch([b for _, b in valid])
                        for (card, _), vec in zip(valid, vecs):
                            db_id = ext_to_db_id[card["id"]]
                            await conn.execute(
                                "UPDATE cards SET embedding = $1::vector WHERE id = $2",
                                str(vec.tolist()),
                                db_id,
                            )
                    except Exception as e:
                        logger.warning("embed_batch failed for batch at i=%d: %s", i, e)
                        for card, _ in valid:
                            failures["embed_failed"].append({
                                "id": card.get("id", ""),
                                "name": card.get("name", ""),
                                "set": card.get("set", {}).get("name", ""),
                                "number": card.get("number", ""),
                                "reason": str(e),
                            })

                    if (i // BATCH_SIZE + 1) % 10 == 0 or i + BATCH_SIZE >= len(to_embed):
                        logger.info("  Embedded %d / %d", min(i + BATCH_SIZE, len(to_embed)), len(to_embed))

        # Build IVFFlat index
        count = await conn.fetchval("SELECT COUNT(*) FROM cards WHERE embedding IS NOT NULL")
        lists = min(100, max(1, int(count) // 100))
        logger.info("Creating IVFFlat index (lists=%d, rows_with_embedding=%d)...", lists, count)
        await conn.execute("DROP INDEX IF EXISTS ix_cards_embedding_ivfflat")
        await conn.execute(
            f"""
            CREATE INDEX ix_cards_embedding_ivfflat
            ON cards USING ivfflat (embedding vector_cosine_ops)
            WITH (lists = {lists})
            """
        )
        logger.info("IVFFlat index created")

        # Write failure report
        total_failed = sum(len(v) for v in failures.values())
        report_path = _BACKEND_ROOT / "models" / "embedding_failures.json"
        report_path.parent.mkdir(parents=True, exist_ok=True)
        with open(report_path, "w") as f:
            json.dump(failures, f, indent=2)
        logger.info(
            "Failure report: %d no_image, %d download_failed, %d embed_failed → %s",
            len(failures["no_image"]),
            len(failures["download_failed"]),
            len(failures["embed_failed"]),
            report_path,
        )

    finally:
        await conn.close()

    logger.info("Done. Restart the backend container to pick up the new embeddings.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Build card image embeddings")
    parser.add_argument(
        "--dataset",
        type=Path,
        default=None,
        help="Path to Kaggle image dataset folder (optional — downloads from pokemontcg.io if not provided)",
    )
    parser.add_argument(
        "--db-url",
        default=os.getenv("DATABASE_URL", "postgresql://tcg:tcgpass@postgres:5432/tcgdb"),
        help="Postgres connection URL",
    )
    parser.add_argument(
        "--api-key",
        default=os.getenv("POKEMON_TCG_API_KEY") or None,
        help="pokemontcg.io API key (optional — higher rate limit)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Re-embed cards that already have embeddings",
    )
    args = parser.parse_args()

    if args.dataset and not args.dataset.exists():
        logger.error("Dataset path not found: %s", args.dataset)
        sys.exit(1)

    asyncio.run(main(args.dataset, args.db_url, args.api_key, args.force))
