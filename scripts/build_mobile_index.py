#!/usr/bin/env python3
"""
Build mobile assets for on-device CLIP search — Phase 3.

Outputs (all written to --output-dir):
  index_en.bin      — int8 scalar-quantized embeddings for EN cards  (~12MB)
  index_ja.bin      — int8 scalar-quantized embeddings for JP cards  (~14MB)
  card_ids_en.bin   — parallel int32 array of card.id for EN         (~80KB)
  card_ids_ja.bin   — parallel int32 array of card.id for JP         (~110KB)
  cards.db          — SQLite: cards metadata (CardOutLite fields + phash)
  manifest.json     — version hashes for all assets (used by /assets/manifest)

Index format (per language):
  Header: 4 bytes magic "TCGI", 4 bytes n_cards, 4 bytes dim (512),
          4 bytes n_cards floats (per-vector scale), then n_cards * 512 int8 values.

IMPORTANT: This script must be re-run AFTER running convert_clip_to_mobile.py and
AFTER the parity harness passes. The index must be built with the SAME converted
model used on-device (not the original PyTorch model). Use --use-converted-model
to point at the ONNX or TFLite file used for generating reference embeddings in
the parity harness.

Usage:
    # Use existing DB embeddings (fast, but only valid if they were generated
    # by the converted model — set --use-db-embeddings only after confirming
    # parity harness passed on the converted model's output)
    python scripts/build_mobile_index.py --use-db-embeddings --output-dir mobile_assets/

    # Re-embed using ONNX model (safest — same graph as what ships on device)
    python scripts/build_mobile_index.py --use-converted-model mobile_models/clip_visual.onnx \\
        --format onnx --output-dir mobile_assets/

    # After building, validate by re-running parity harness with --load-reference
    python scripts/parity_harness.py \\
        --candidate mobile_models/clip_visual_int8.tflite --format tflite \\
        --load-reference mobile_assets/ref_embeddings.npz
"""

import argparse
import asyncio
import hashlib
import io
import json
import logging
import os
import sqlite3
import struct
import sys
from pathlib import Path

import asyncpg
import numpy as np

for _p in [Path(__file__).parent.parent / "backend", Path("/app")]:
    if (_p / "app").is_dir():
        sys.path.insert(0, str(_p))
        break

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

INDEX_MAGIC = b"TCGI"
INDEX_VERSION = 1


# ---------------------------------------------------------------------------
# INT8 scalar quantization
# ---------------------------------------------------------------------------

def quantize_int8(embeddings: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Per-vector int8 scalar quantization.

    Each row is independently scaled so the full [-1, 1] range (L2-normalized
    CLIP embeddings live in this range) maps to [-127, 127]. Quantization error
    is ~0.8% per component; empirically < 0.01 cosine drift on CLIP embeddings.

    Returns:
        quantized: (N, 512) int8
        scales:    (N,) float32 — multiply int8 * scale to dequantize
    """
    # For L2-normalized vectors max abs value <= 1.0 by definition,
    # but take per-row max to use the full int8 range
    abs_max = np.abs(embeddings).max(axis=1, keepdims=True).clip(min=1e-8)
    scales = (abs_max / 127.0).astype(np.float32).squeeze(1)
    quantized = np.round(embeddings / abs_max * 127).clip(-127, 127).astype(np.int8)
    return quantized, scales


# ---------------------------------------------------------------------------
# Index file format
# ---------------------------------------------------------------------------

def write_index(path: Path, card_ids: np.ndarray, embeddings: np.ndarray) -> None:
    """Write binary index file.

    Format:
      4B  magic "TCGI"
      4B  version (uint32 LE) = 1
      4B  n_cards (uint32 LE)
      4B  dim     (uint32 LE) = 512
      4*n scales  (float32 LE, per-vector dequantization scales)
      n*512 int8  (quantized embeddings, row-major)
    """
    assert embeddings.dtype == np.float32
    assert card_ids.dtype == np.int32
    n, dim = embeddings.shape

    quantized, scales = quantize_int8(embeddings)

    with open(path, "wb") as f:
        f.write(INDEX_MAGIC)
        f.write(struct.pack("<II", INDEX_VERSION, n))
        f.write(struct.pack("<I", dim))
        f.write(scales.tobytes())
        f.write(quantized.tobytes())

    size_mb = path.stat().st_size / 1e6
    logger.info("Wrote %s: n=%d dim=%d size=%.1f MB", path.name, n, dim, size_mb)


def write_card_ids(path: Path, card_ids: np.ndarray) -> None:
    with open(path, "wb") as f:
        f.write(card_ids.astype(np.int32).tobytes())
    logger.info("Wrote %s: %d ids", path.name, len(card_ids))


# ---------------------------------------------------------------------------
# SQLite cards.db
# ---------------------------------------------------------------------------

def build_cards_db(path: Path, rows: list[dict]) -> None:
    """Build a read-only SQLite database with card metadata.

    Schema mirrors CardOutLite + phash — exactly what the on-device search
    returns after finding a card_id match.
    """
    conn = sqlite3.connect(str(path))
    c = conn.cursor()
    c.execute("DROP TABLE IF EXISTS cards")
    c.execute("""
        CREATE TABLE cards (
            id              INTEGER PRIMARY KEY,
            game            TEXT NOT NULL,
            language        TEXT NOT NULL,
            name            TEXT NOT NULL,
            name_ja         TEXT,
            set_name        TEXT,
            set_code        TEXT,
            card_number     TEXT,
            rarity          TEXT,
            image_url       TEXT,
            image_url_hi    TEXT,
            pricecharting_url TEXT,
            phash           TEXT
        )
    """)
    c.execute("CREATE INDEX idx_cards_id ON cards(id)")
    c.execute("CREATE INDEX idx_cards_language ON cards(language)")

    # FTS5 for on-device fuzzy name search (replaces pg_trgm for the local path)
    c.execute("DROP TABLE IF EXISTS cards_fts")
    c.execute("""
        CREATE VIRTUAL TABLE cards_fts USING fts5(
            id UNINDEXED,
            name,
            name_ja,
            set_name,
            card_number UNINDEXED,
            content='cards',
            content_rowid='id'
        )
    """)

    batch = [
        (
            r["id"], r["game"], r["language"], r["name"], r.get("name_ja"),
            r.get("set_name"), r.get("set_code"), r.get("card_number"),
            r.get("rarity"), r.get("image_url"), r.get("image_url_hi"),
            r.get("pricecharting_url"), r.get("phash"),
        )
        for r in rows
    ]
    c.executemany(
        "INSERT OR REPLACE INTO cards VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        batch,
    )
    # Populate FTS index
    c.execute("""
        INSERT INTO cards_fts(id, name, name_ja, set_name, card_number)
        SELECT id, name, name_ja, set_name, card_number FROM cards
    """)
    conn.commit()
    conn.close()

    size_mb = path.stat().st_size / 1e6
    logger.info("Wrote %s: %d cards, %.1f MB", path.name, len(rows), size_mb)


# ---------------------------------------------------------------------------
# Embedding fetch strategies
# ---------------------------------------------------------------------------

async def fetch_embeddings_from_db(db_url: str, language: str) -> tuple[np.ndarray, np.ndarray, list[dict]]:
    """Fetch stored embeddings from Postgres. Fast but only valid if those
    embeddings were generated by the same model version as on-device."""
    conn = await asyncpg.connect(db_url)
    try:
        rows = await conn.fetch(
            """
            SELECT id, game, language, name, name_ja, set_name, set_code,
                   card_number, rarity, image_url, image_url_hi,
                   pricecharting_url, phash, embedding
            FROM cards
            WHERE language = $1 AND embedding IS NOT NULL
            ORDER BY id
            """,
            language,
        )
    finally:
        await conn.close()

    if not rows:
        return np.zeros((0, 512), np.float32), np.zeros(0, np.int32), []

    card_ids = np.array([r["id"] for r in rows], dtype=np.int32)
    embeddings = np.array([
        list(map(float, str(r["embedding"]).strip("[]").split(",")))
        for r in rows
    ], dtype=np.float32)
    meta = [dict(r) for r in rows]
    logger.info("Fetched %d %s embeddings from DB", len(rows), language)
    return embeddings, card_ids, meta


async def fetch_embeddings_from_converted_model(
    db_url: str, language: str, model_path: str, fmt: str
) -> tuple[np.ndarray, np.ndarray, list[dict]]:
    """Re-embed cards using the converted model (ONNX/TFLite). This is the
    correct path when building a fresh index for a new model version — ensures
    the index and on-device query share the same embedding space."""
    import aiohttp

    conn = await asyncpg.connect(db_url)
    try:
        rows = await conn.fetch(
            """
            SELECT id, game, language, name, name_ja, set_name, set_code,
                   card_number, rarity, image_url, image_url_hi,
                   pricecharting_url, phash, image_url as img
            FROM cards
            WHERE language = $1 AND image_url IS NOT NULL
            ORDER BY id
            """,
            language,
        )
    finally:
        await conn.close()

    # Import candidate embed function
    if fmt == "onnx":
        from parity_harness import embed_onnx as embed_fn
        def embed(imgs): return embed_onnx(imgs, model_path)
    elif fmt == "tflite":
        from parity_harness import embed_tflite as embed_fn
        def embed(imgs): return embed_tflite(imgs, model_path)
    else:
        raise ValueError(f"Unsupported format: {fmt}")

    # Fetch images
    sem = asyncio.Semaphore(16)
    image_bytes: dict[int, bytes] = {}

    async def fetch_one(session, row):
        async with sem:
            try:
                async with session.get(row["img"], timeout=aiohttp.ClientTimeout(total=20)) as r:
                    if r.status == 200:
                        return row["id"], await r.read()
            except Exception as e:
                logger.warning("Image fetch failed for card %d: %s", row["id"], e)
        return row["id"], None

    async with aiohttp.ClientSession() as session:
        tasks = [fetch_one(session, r) for r in rows]
        for coro in asyncio.as_completed(tasks):
            cid, data = await coro
            if data:
                image_bytes[cid] = data

    # Embed in batches
    BATCH = 64
    valid_rows = [r for r in rows if r["id"] in image_bytes]
    all_ids, all_vecs = [], []

    for i in range(0, len(valid_rows), BATCH):
        batch = valid_rows[i:i+BATCH]
        imgs = [image_bytes[r["id"]] for r in batch]
        vecs = embed(imgs)
        all_ids.extend([r["id"] for r in batch])
        all_vecs.append(vecs)
        if (i // BATCH + 1) % 10 == 0:
            logger.info("  Embedded %d / %d %s cards", min(i+BATCH, len(valid_rows)), len(valid_rows), language)

    card_ids = np.array(all_ids, dtype=np.int32)
    embeddings = np.vstack(all_vecs).astype(np.float32)
    meta = [dict(r) for r in valid_rows if r["id"] in set(all_ids)]
    logger.info("Re-embedded %d %s cards with converted model", len(all_ids), language)
    return embeddings, card_ids, meta


# ---------------------------------------------------------------------------
# Manifest
# ---------------------------------------------------------------------------

def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


def write_manifest(output_dir: Path, model_version: str) -> Path:
    files = [
        "index_en.bin", "index_ja.bin",
        "card_ids_en.bin", "card_ids_ja.bin",
        "cards.db",
    ]
    manifest = {
        "model_version": model_version,
        "files": {},
    }
    for fname in files:
        p = output_dir / fname
        if p.exists():
            manifest["files"][fname] = {
                "sha256": sha256_file(p),
                "size": p.stat().st_size,
            }
    manifest_path = output_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2))
    logger.info("Manifest written to %s", manifest_path)
    return manifest_path


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def main(args):
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    all_meta: list[dict] = []
    ref_vecs_for_export: dict[str, np.ndarray] = {}

    for lang in ("en", "ja"):
        logger.info("--- Processing language=%s ---", lang)

        if args.use_converted_model:
            embeddings, card_ids, meta = await fetch_embeddings_from_converted_model(
                args.db_url, lang, args.use_converted_model, args.format
            )
        else:
            embeddings, card_ids, meta = await fetch_embeddings_from_db(args.db_url, lang)

        if len(embeddings) == 0:
            logger.warning("No %s embeddings found — skipping", lang)
            continue

        write_index(output_dir / f"index_{lang}.bin", card_ids, embeddings)
        write_card_ids(output_dir / f"card_ids_{lang}.bin", card_ids)
        all_meta.extend(meta)
        ref_vecs_for_export[lang] = embeddings

    # Build unified SQLite cards.db
    logger.info("Building cards.db (%d total cards)...", len(all_meta))
    build_cards_db(output_dir / "cards.db", all_meta)

    # Optionally export reference embeddings for parity harness reuse
    if args.export_reference:
        combined_ids  = np.concatenate([
            np.array([r["id"] for r in all_meta if r["language"] == "en"], dtype=np.int32),
            np.array([r["id"] for r in all_meta if r["language"] == "ja"], dtype=np.int32),
        ])
        combined_vecs = np.vstack([
            v for v in ref_vecs_for_export.values()
        ])
        np.savez_compressed(args.export_reference, card_ids=combined_ids, embeddings=combined_vecs)
        logger.info("Saved reference embeddings to %s (for parity harness)", args.export_reference)

    manifest = write_manifest(output_dir, args.model_version)

    print("\n" + "=" * 60)
    print("MOBILE INDEX BUILD COMPLETE")
    print("=" * 60)
    for f in sorted(output_dir.glob("*")):
        print(f"  {f.name:<35} {f.stat().st_size / 1e6:6.1f} MB")
    print()
    print("Copy to mobile/assets/data/ and rebuild the app bundle.")
    print("Update CLIP_MODEL_VERSION in mobile/utils/clipEmbedder.ts to force re-probe.")
    print("=" * 60)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Build mobile CLIP index and cards.db")
    parser.add_argument("--output-dir", default="mobile_assets", help="Output directory")
    parser.add_argument("--db-url", default=os.getenv("DATABASE_URL", "postgresql://tcg:tcgpass@localhost:5432/tcgdb"))
    parser.add_argument("--use-db-embeddings", action="store_true",
                        help="Use embeddings already stored in Postgres (fast, only if parity-validated)")
    parser.add_argument("--use-converted-model", default=None, metavar="MODEL_PATH",
                        help="Path to converted model (ONNX/TFLite) — re-embeds all cards with this model")
    parser.add_argument("--format", choices=["onnx", "tflite"], default="onnx",
                        help="Format of --use-converted-model")
    parser.add_argument("--model-version", default="1",
                        help="Model version string (baked into manifest.json)")
    parser.add_argument("--export-reference", default=None, metavar="PATH",
                        help="Save reference embeddings as .npz (for parity harness reuse)")
    args = parser.parse_args()

    if not args.use_db_embeddings and not args.use_converted_model:
        parser.error("Specify either --use-db-embeddings or --use-converted-model MODEL_PATH")

    asyncio.run(main(args))
