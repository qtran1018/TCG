#!/usr/bin/env python3
"""
Build card embeddings: fetch all Pokemon cards from pokemontcg.io, match to
local Kaggle images (fast), fall back to URL download when not found locally.

Usage:
    python scripts/build_embeddings.py \
        --dataset "Pokemon TCG" \
        --db-url postgresql://tcg:tcgpass@localhost:5432/tcgdb

The script:
  1. Fetches all EN Pokemon cards from pokemontcg.io API (~60 requests)
  2. Upserts any missing cards into the DB
  3. For each card: uses local Kaggle image first, downloads image_url if not found
  4. Embeds all images with EfficientNet-B0 in batches
  5. Fits PCA(256) on the full embedding matrix, saves to backend/models/pca.pkl
  6. Stores 256-dim embeddings in the cards table
  7. Creates an IVFFlat index on the embedding column

Re-running is safe: already-embedded cards are skipped unless --force is passed.
"""

import argparse
import asyncio
import io
import logging
import os
import pickle
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

from app.services.card_embedder import embed_raw  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

PTCG_API = "https://api.pokemontcg.io/v2/cards"
PAGE_SIZE = 250
BATCH_SIZE = 32
PCA_DIMS = 256
SUPPORTED_EXTS = {".jpg", ".jpeg", ".png"}

# Resolve the backend root whether running locally (./backend) or inside Docker (/app)
_BACKEND_ROOT = Path("/app") if Path("/app/app").is_dir() else Path(__file__).parent.parent / "backend"
PCA_PATH = _BACKEND_ROOT / "models" / "pca.pkl"


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
    """Locate a card image in the Kaggle dataset by set name slug + card number."""
    folder = dataset_path / slugify(set_name)
    if not folder.is_dir():
        return None
    return _match_card_file(folder, card_number)


def _match_card_file(folder: Path, card_number: str) -> Path | None:
    # Normalize target: strip leading alpha prefix (TG01→1, SWSH001→1), strip leading zeros
    digits = re.sub(r"^[A-Za-z]+", "", card_number)
    target = (digits.lstrip("0") or "0")

    # Two-pass: prefer 3-digit tokens (zero-padded modern format) over shorter ones.
    # This avoids matching set-code digits like the "5" in "sv3-5_en_005_std.jpg".
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
# Image fetch (local file or URL download)
# ---------------------------------------------------------------------------

async def get_image_bytes(
    card: dict,
    dataset_path: Path | None,
    session,
) -> bytes | None:
    set_name = card.get("set", {}).get("name", "")
    card_number = card.get("number", "")

    if dataset_path:
        local = find_local_image(dataset_path, set_name, card_number)
        if local:
            return local.read_bytes()

    # Fall back to downloading the small image URL
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
    """Bulk-upsert API cards into DB. Returns {external_id: db_id} map."""
    if not cards:
        return {}

    # Fetch existing external_ids in one query
    ext_ids = [c.get("id", "") for c in cards]
    existing = {
        r["external_id"]: r["id"]
        for r in await conn.fetch(
            "SELECT id, external_id FROM cards WHERE external_id = ANY($1::text[])", ext_ids
        )
    }

    to_insert = [c for c in cards if c.get("id", "") not in existing]

    # Batch insert in chunks of 500
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
# Main
# ---------------------------------------------------------------------------

async def main(dataset_path: Path | None, db_url: str, api_key: str | None, force: bool):
    import aiohttp

    # 1. Fetch all cards from pokemontcg.io
    logger.info("Fetching all Pokemon cards from pokemontcg.io...")
    all_cards = await fetch_all_ptcg_cards(api_key)
    logger.info("Total cards fetched: %d", len(all_cards))

    # 2. Upsert into DB
    logger.info("Upserting cards into DB...")
    conn = await asyncpg.connect(db_url)
    try:
        await conn.execute("CREATE EXTENSION IF NOT EXISTS vector")
        ext_to_db_id = await upsert_cards(conn, all_cards)
        logger.info("DB now has entries for %d cards", len(ext_to_db_id))

        # Determine which cards still need embeddings
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
            # 3. Fetch images and embed
            logger.info("Fetching images and embedding (batch_size=%d)...", BATCH_SIZE)
            raw_vecs: list[np.ndarray] = []
            db_ids: list[int] = []

            async with aiohttp.ClientSession() as session:
                for i in range(0, len(to_embed), BATCH_SIZE):
                    batch = to_embed[i : i + BATCH_SIZE]
                    image_bytes_list = await asyncio.gather(
                        *[get_image_bytes(c, dataset_path, session) for c in batch]
                    )
                    for card, img_bytes in zip(batch, image_bytes_list):
                        ext_id = card.get("id", "")
                        card_info = {
                            "id": ext_id,
                            "name": card.get("name", ""),
                            "set": card.get("set", {}).get("name", ""),
                            "number": card.get("number", ""),
                            "image_url": card.get("images", {}).get("small", ""),
                        }
                        if not img_bytes:
                            local = find_local_image(dataset_path, card.get("set", {}).get("name", ""), card.get("number", "")) if dataset_path else None
                            key = "no_image" if local is None else "download_failed"
                            failures[key].append(card_info)
                            logger.debug("No image for %s, skipping", ext_id)
                            continue
                        try:
                            vec = embed_raw(img_bytes)
                            raw_vecs.append(vec)
                            db_ids.append(ext_to_db_id[card["id"]])
                        except Exception as e:
                            logger.warning("Embed failed for %s: %s", ext_id, e)
                            failures["embed_failed"].append({**card_info, "reason": str(e)})

                    if (i // BATCH_SIZE + 1) % 20 == 0 or i + BATCH_SIZE >= len(to_embed):
                        logger.info("  Embedded %d / %d", min(i + BATCH_SIZE, len(to_embed)), len(to_embed))

            logger.info("Successfully embedded %d images", len(raw_vecs))

            if len(raw_vecs) < PCA_DIMS:
                logger.error(
                    "Need at least %d embeddings to fit PCA — only got %d. "
                    "Scan more cards first or check the dataset path.",
                    PCA_DIMS, len(raw_vecs),
                )
                return

            # 4. Fit or update PCA
            from sklearn.decomposition import PCA

            # If PCA already exists, combine old fitted data with new vecs for refitting
            raw_matrix = np.array(raw_vecs, dtype=np.float32)

            if PCA_PATH.exists() and not force:
                logger.info("PCA already exists — loading and transforming new vecs only")
                with open(PCA_PATH, "rb") as f:
                    pca = pickle.load(f)
                reduced = pca.transform(raw_matrix).astype(np.float32)
            else:
                logger.info("Fitting PCA(%d) on %d vectors...", PCA_DIMS, len(raw_vecs))
                pca = PCA(n_components=PCA_DIMS, random_state=42)
                reduced = pca.fit_transform(raw_matrix).astype(np.float32)
                explained = pca.explained_variance_ratio_.sum()
                logger.info("PCA explains %.1f%% of variance", explained * 100)
                PCA_PATH.parent.mkdir(parents=True, exist_ok=True)
                with open(PCA_PATH, "wb") as f:
                    pickle.dump(pca, f)
                logger.info("Saved PCA to %s", PCA_PATH)

            # 5. Store embeddings in DB
            logger.info("Storing %d embeddings in DB...", len(db_ids))
            for db_id, vec in zip(db_ids, reduced):
                await conn.execute(
                    "UPDATE cards SET embedding = $1::vector WHERE id = $2",
                    str(vec.tolist()),
                    db_id,
                )
            logger.info("Stored %d embeddings", len(db_ids))

        # 6. Create IVFFlat index
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

        # 7. Write failure report
        import json
        total_failed = sum(len(v) for v in failures.values())
        report_path = _BACKEND_ROOT / "models" / "embedding_failures.json"
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

    logger.info("Done. Restart the backend container to load the new PCA model.")


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
        default=os.getenv("DATABASE_URL", "postgresql://tcg:tcgpass@localhost:5432/tcgdb"),
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
        help="Re-embed cards that already have embeddings and refit PCA",
    )
    args = parser.parse_args()

    if args.dataset and not args.dataset.exists():
        logger.error("Dataset path not found: %s", args.dataset)
        sys.exit(1)

    asyncio.run(main(args.dataset, args.db_url, args.api_key, args.force))
