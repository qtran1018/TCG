"""One-off migration: replace the merged IVFFlat index with per-language partial indices.

Runtime CLIP search always filters by `Card.language`. With a single merged
index Postgres probes a cluster and then post-filters language, throwing away
~half of the candidates. Per-language partial indices let each query scan only
matching-language clusters, ~30–40% faster.

Safe to run repeatedly — drops + recreates the partial indices.

Usage:
    docker exec tcg_backend python /scripts/migrate_partial_ivfflat.py
"""

import asyncio
import logging
import os

import asyncpg

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")
logger = logging.getLogger(__name__)


async def main():
    db_url = os.environ["DATABASE_URL"].replace("+asyncpg", "")
    conn = await asyncpg.connect(db_url)
    try:
        await conn.execute("DROP INDEX IF EXISTS ix_cards_embedding_ivfflat")
        for lang in ("en", "ja"):
            count = await conn.fetchval(
                "SELECT COUNT(*) FROM cards WHERE embedding IS NOT NULL AND language = $1",
                lang,
            )
            if not count:
                logger.info("No %s embeddings — skipping", lang)
                continue
            lists = min(100, max(1, int(count) // 100))
            idx_name = f"ix_cards_embedding_ivfflat_{lang}"
            logger.info("Building %s (lists=%d, rows=%d)...", idx_name, lists, count)
            await conn.execute(f"DROP INDEX IF EXISTS {idx_name}")
            await conn.execute(
                f"CREATE INDEX {idx_name} "
                f"ON cards USING ivfflat (embedding vector_cosine_ops) "
                f"WITH (lists = {lists}) "
                f"WHERE language = '{lang}'"
            )
        logger.info("Done.")
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
