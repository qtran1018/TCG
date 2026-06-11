#!/usr/bin/env python3
"""
Convert the QuickGELU TF SavedModel to int8 TFLite using real card images
from the database as the calibration dataset.

Must run inside the backend Docker container:
    docker cp scripts/convert_clip_int8.py tcg_backend:/tmp/
    docker exec tcg_backend python /tmp/convert_clip_int8.py

Prerequisite: /tmp/clip_qgelu_saved_model must exist (produced by the
onnx2tf step in CLIP_MOBILE_CONVERSION.md). If it doesn't exist, re-run
the onnx2tf conversion first.

Output: /tmp/clip_visual_int8.tflite (~90MB)
"""

import asyncio
import io
import logging
import os

import asyncpg
import aiohttp
import numpy as np
from PIL import Image

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

DB_URL    = os.getenv("DATABASE_URL", "postgresql://tcg:tcgpass@postgres:5432/tcgdb")
N_SAMPLES = 500   # 250 EN + 250 JP
SAVED_MODEL_PATH = "/tmp/clip_qgelu_saved_model"
OUTPUT_PATH      = "/tmp/clip_visual_int8.tflite"

CLIP_MEAN = np.array([0.48145466, 0.4578275,  0.40821073], dtype=np.float32)
CLIP_STD  = np.array([0.26862954, 0.26130258, 0.27577711], dtype=np.float32)


def crop_art(img: Image.Image) -> Image.Image:
    """Card art region crop — matches card_embedder._crop_art exactly."""
    w, h = img.size
    return img.crop((int(w * 0.04), int(h * 0.12), int(w * 0.96), int(h * 0.52)))


def preprocess(img_bytes: bytes) -> np.ndarray:
    """Crop art region, resize/center-crop to 224x224, normalize. Returns NHWC float32."""
    img = Image.open(io.BytesIO(img_bytes)).convert("RGB")
    crop = crop_art(img)

    # Resize shorter side to 224, then center-crop — matches open_clip transform
    w, h = crop.size
    scale = 224 / min(w, h)
    new_w = max(224, round(w * scale))
    new_h = max(224, round(h * scale))
    crop = crop.resize((new_w, new_h), Image.BICUBIC)
    left = (new_w - 224) // 2
    top  = (new_h - 224) // 2
    crop = crop.crop((left, top, left + 224, top + 224))

    arr = np.array(crop, dtype=np.float32) / 255.0          # HWC [0,1]
    arr = (arr - CLIP_MEAN) / CLIP_STD                       # normalize
    return arr[np.newaxis]                                    # NHWC (1,224,224,3)


async def fetch_images() -> list[bytes]:
    """Fetch N_SAMPLES card images: half EN, half JP, random across all sets."""
    conn = await asyncpg.connect(DB_URL)
    try:
        half = N_SAMPLES // 2
        rows = await conn.fetch(
            """
            (SELECT id, image_url FROM cards
             WHERE image_url IS NOT NULL AND embedding IS NOT NULL AND language='en'
             ORDER BY random() LIMIT $1)
            UNION ALL
            (SELECT id, image_url FROM cards
             WHERE image_url IS NOT NULL AND embedding IS NOT NULL AND language='ja'
             ORDER BY random() LIMIT $1)
            """,
            half,
        )
    finally:
        await conn.close()

    logger.info("Downloading %d card images for calibration...", len(rows))
    results: list[bytes] = []
    sem = asyncio.Semaphore(16)

    async def fetch_one(session, row):
        async with sem:
            try:
                async with session.get(
                    row["image_url"],
                    timeout=aiohttp.ClientTimeout(total=20),
                ) as resp:
                    if resp.status == 200:
                        return await resp.read()
            except Exception as e:
                logger.warning("Failed to fetch card %d: %s", row["id"], e)
            return None

    async with aiohttp.ClientSession() as session:
        tasks = [fetch_one(session, row) for row in rows]
        for coro in asyncio.as_completed(tasks):
            data = await coro
            if data:
                results.append(data)

    logger.info("Downloaded %d / %d images", len(results), len(rows))
    return results


def convert_int8(image_bytes_list: list[bytes]) -> None:
    import tensorflow as tf

    logger.info("Preprocessing %d images for calibration...", len(image_bytes_list))
    tensors = []
    for i, img_bytes in enumerate(image_bytes_list):
        try:
            tensors.append(preprocess(img_bytes))
        except Exception as e:
            logger.warning("Skipping image %d: %s", i, e)

    logger.info("Using %d images for int8 calibration", len(tensors))

    def representative_dataset():
        for t in tensors:
            yield [t]

    converter = tf.lite.TFLiteConverter.from_saved_model(SAVED_MODEL_PATH)
    converter.optimizations = [tf.lite.Optimize.DEFAULT]
    converter.representative_dataset = representative_dataset
    converter.target_spec.supported_ops = [tf.lite.OpsSet.TFLITE_BUILTINS_INT8]
    converter.inference_input_type  = tf.int8
    converter.inference_output_type = tf.int8

    logger.info("Converting to int8 TFLite...")
    tflite_model = converter.convert()

    with open(OUTPUT_PATH, "wb") as f:
        f.write(tflite_model)

    size_mb = len(tflite_model) / 1e6
    logger.info("int8 TFLite saved: %s (%.1f MB)", OUTPUT_PATH, size_mb)


async def main():
    if not os.path.isdir(SAVED_MODEL_PATH):
        logger.error(
            "SavedModel not found at %s — run the onnx2tf step first "
            "(see docs/CLIP_MOBILE_CONVERSION.md Step 3)",
            SAVED_MODEL_PATH,
        )
        raise SystemExit(1)

    image_bytes_list = await fetch_images()
    if len(image_bytes_list) < 100:
        logger.error("Only %d images fetched — need at least 100 for calibration", len(image_bytes_list))
        raise SystemExit(1)

    convert_int8(image_bytes_list)


if __name__ == "__main__":
    asyncio.run(main())
