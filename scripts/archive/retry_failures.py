#!/usr/bin/env python3
"""
Retry embedding cards that failed in the last build_embeddings.py run.

Reads embedding_failures.json, fetches each card's image_url from the DB,
downloads from CDN (bypassing the local dataset), embeds, and stores.

Usage (from inside the backend container):
    python //scripts/retry_failures.py \
        --db-url postgresql://tcg:tcgpass@postgres:5432/tcgdb
"""

import argparse
import asyncio
import json
import logging
import os
import sys
from pathlib import Path

import asyncpg

for _candidate in [Path(__file__).parent.parent / "backend", Path("/app")]:
    if (_candidate / "app").is_dir():
        sys.path.insert(0, str(_candidate))
        break

from app.services.card_embedder import embed_batch  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

_BACKEND_ROOT = Path("/app") if Path("/app/app").is_dir() else Path(__file__).parent.parent / "backend"
FAILURES_PATH = _BACKEND_ROOT / "models" / "embedding_failures.json"
BATCH_SIZE = 32


async def main(db_url: str):
    import aiohttp

    if not FAILURES_PATH.exists():
        logger.error("No failures file found at %s", FAILURES_PATH)
        return

    with open(FAILURES_PATH) as f:
        failures = json.load(f)

    # Collect all failed external_ids
    failed_ids: list[str] = []
    for section in ("no_image", "download_failed", "embed_failed"):
        for entry in failures.get(section, []):
            if "id" in entry:
                failed_ids.append(entry["id"])

    if not failed_ids:
        logger.info("No failed cards to retry.")
        return

    logger.info("Retrying %d failed cards (fetching image_urls from DB)...", len(failed_ids))

    conn = await asyncpg.connect(db_url)
    try:
        rows = await conn.fetch(
            "SELECT id, external_id, image_url FROM cards WHERE external_id = ANY($1::text[])",
            failed_ids,
        )
        if not rows:
            logger.error("None of the failed external_ids found in DB.")
            return

        logger.info("Found %d / %d cards in DB", len(rows), len(failed_ids))

        new_failures: list[dict] = []
        embedded = 0

        async with aiohttp.ClientSession() as session:
            for i in range(0, len(rows), BATCH_SIZE):
                batch_rows = rows[i : i + BATCH_SIZE]
                image_bytes_list: list[bytes | None] = []

                for row in batch_rows:
                    url = row["image_url"]
                    if not url:
                        logger.warning("No image_url in DB for %s — skipping", row["external_id"])
                        image_bytes_list.append(None)
                        continue
                    try:
                        async with session.get(url, timeout=aiohttp.ClientTimeout(total=30)) as resp:
                            if resp.status == 200:
                                image_bytes_list.append(await resp.read())
                            else:
                                logger.warning("HTTP %d for %s (%s)", resp.status, row["external_id"], url)
                                image_bytes_list.append(None)
                    except Exception as e:
                        logger.warning("Download failed for %s: %s", row["external_id"], e)
                        image_bytes_list.append(None)

                # Filter to valid downloads
                valid: list[tuple[int, str, bytes]] = [
                    (row["id"], row["external_id"], img)
                    for row, img in zip(batch_rows, image_bytes_list)
                    if img is not None
                ]

                if not valid:
                    for row, img in zip(batch_rows, image_bytes_list):
                        if img is None:
                            new_failures.append({"id": row["external_id"], "reason": "download_failed"})
                    continue

                try:
                    vecs = embed_batch([b for _, _, b in valid])
                    for (db_id, ext_id, _), vec in zip(valid, vecs):
                        await conn.execute(
                            "UPDATE cards SET embedding = $1::vector WHERE id = $2",
                            str(vec.tolist()),
                            db_id,
                        )
                        embedded += 1
                except Exception as e:
                    logger.warning("embed_batch failed: %s", e)
                    for _, ext_id, _ in valid:
                        new_failures.append({"id": ext_id, "reason": str(e)})

                for row, img in zip(batch_rows, image_bytes_list):
                    if img is None:
                        new_failures.append({"id": row["external_id"], "reason": "download_failed"})

                logger.info("  Progress: %d / %d", min(i + BATCH_SIZE, len(rows)), len(rows))

        logger.info("Embedded %d cards. %d still failed.", embedded, len(new_failures))
        if new_failures:
            logger.info("Remaining failures:")
            for f in new_failures:
                logger.info("  %s — %s", f["id"], f["reason"])

        # Rebuild index if we added embeddings
        if embedded > 0:
            count = await conn.fetchval("SELECT COUNT(*) FROM cards WHERE embedding IS NOT NULL")
            lists = min(100, max(1, int(count) // 100))
            logger.info("Rebuilding IVFFlat index (lists=%d, rows=%d)...", lists, count)
            await conn.execute("DROP INDEX IF EXISTS ix_cards_embedding_ivfflat")
            await conn.execute(
                f"""
                CREATE INDEX ix_cards_embedding_ivfflat
                ON cards USING ivfflat (embedding vector_cosine_ops)
                WITH (lists = {lists})
                """
            )
            logger.info("Index rebuilt.")

    finally:
        await conn.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--db-url",
        default=os.getenv("DATABASE_URL", "postgresql://tcg:tcgpass@postgres:5432/tcgdb"),
    )
    args = parser.parse_args()
    asyncio.run(main(args.db_url))
