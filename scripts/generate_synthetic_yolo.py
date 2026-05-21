#!/usr/bin/env python3
"""
Generate synthetic YOLO training images: card images pasted onto background photos.

Each output image contains 1–20 cards placed with random position, scale, rotation,
and mild perspective warp. Bounding boxes are exact (computed from placement geometry).
Card count distribution is weighted toward the middle range (4–12 cards) to reflect
real scanning scenarios.

Usage:
    python scripts/generate_synthetic_yolo.py \
        --cards   assets/card_images/     \
        --backgrounds assets/backgrounds/ \
        --output  synthetic_yolo/         \
        --count   3000                    \
        --split   0.85

Output structure (YOLO format, ready to merge with merge_yolo_datasets.py):
    synthetic_yolo/
        images/train/*.jpg
        images/val/*.jpg
        labels/train/*.txt
        labels/val/*.txt
        data.yaml

Card images can be downloaded beforehand with --download-cards (samples N random cards
from the Postgres DB and downloads their image_url). Requires DB running locally.
"""

import argparse
import io
import logging
import math
import os
import random
import shutil
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

CARD_ASPECT = 63 / 88  # width/height — standard Pokemon card

# Card count distribution: (min, max, weight)
# Weighted toward middle range as discussed.
COUNT_BUCKETS = [
    (1,  3,  0.10),
    (4,  7,  0.35),
    (8,  12, 0.35),
    (13, 17, 0.15),
    (18, 20, 0.05),
]

# Max fraction of a card's area that can be occluded by later-placed cards.
# Cards occluded beyond this are not labeled (YOLO can't learn to detect invisible cards).
MAX_OCCLUSION = 0.55


# ---------------------------------------------------------------------------
# Card count sampling
# ---------------------------------------------------------------------------

def _sample_card_count() -> int:
    weights = [w for _, _, w in COUNT_BUCKETS]
    bucket = random.choices(COUNT_BUCKETS, weights=weights, k=1)[0]
    return random.randint(bucket[0], bucket[1])


# ---------------------------------------------------------------------------
# Augmentation helpers (reused from fine_tune_clip.py style)
# ---------------------------------------------------------------------------

def _perspective_warp(img: Image.Image, strength: float = 0.06) -> Image.Image:
    w, h = img.size
    dx, dy = int(w * strength), int(h * strength)
    src = [(0, 0), (w, 0), (w, h), (0, h)]
    dst = [
        (random.randint(0, dx),      random.randint(0, dy)),
        (w - random.randint(0, dx),  random.randint(0, dy)),
        (w - random.randint(0, dx),  h - random.randint(0, dy)),
        (random.randint(0, dx),      h - random.randint(0, dy)),
    ]
    matrix, b = [], []
    for (x, y), (X, Y) in zip(src, dst):
        matrix += [[x, y, 1, 0, 0, 0, -X*x, -X*y],
                   [0, 0, 0, x, y, 1, -Y*x, -Y*y]]
        b += [X, Y]
    coeffs, *_ = np.linalg.lstsq(np.array(matrix, dtype=np.float64),
                                  np.array(b, dtype=np.float64), rcond=None)
    return img.transform((w, h), Image.PERSPECTIVE, coeffs.tolist(), Image.BICUBIC)


def _color_jitter(img: Image.Image, behind_glass: bool = False) -> Image.Image:
    for Klass, lo, hi in [
        (ImageEnhance.Brightness, 0.55, 1.35),
        (ImageEnhance.Contrast,   0.6,  1.4),
        (ImageEnhance.Color,      0.5,  1.5),
        (ImageEnhance.Sharpness,  0.6,  1.4),
    ]:
        img = Klass(img).enhance(random.uniform(lo, hi))
    # Simulate glass tint: slight blue-green cast + reduce brightness a little
    if behind_glass and random.random() < 0.6:
        arr = np.array(img, dtype=np.float32)
        arr[:, :, 0] *= random.uniform(0.75, 0.95)   # reduce red
        arr[:, :, 1] *= random.uniform(0.88, 1.00)   # keep green
        arr[:, :, 2] *= random.uniform(0.90, 1.05)   # slight blue boost
        img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
    return img


def _maybe_blur(img: Image.Image) -> Image.Image:
    if random.random() < 0.25:
        r = random.uniform(0.4, 1.2)
        img = img.filter(ImageFilter.GaussianBlur(radius=r))
    return img


def _load_backgrounds(bg_dir: Path) -> list[Image.Image]:
    exts = {".jpg", ".jpeg", ".png", ".webp"}
    paths = [p for p in bg_dir.iterdir() if p.suffix.lower() in exts]
    if not paths:
        raise ValueError(f"No background images found in {bg_dir}")
    bgs = []
    for p in paths:
        try:
            bgs.append(Image.open(p).convert("RGB"))
        except Exception as e:
            logger.warning("Could not load background %s: %s", p, e)
    logger.info("Loaded %d background images from %s", len(bgs), bg_dir)
    return bgs


def _load_cards(card_dir: Path) -> list[Image.Image]:
    exts = {".jpg", ".jpeg", ".png"}
    paths = [p for p in card_dir.rglob("*") if p.suffix.lower() in exts]
    if not paths:
        raise ValueError(f"No card images found in {card_dir}")
    cards = []
    for p in paths:
        try:
            img = Image.open(p).convert("RGBA")
            # Ensure standard card aspect ratio — crop to center if needed
            w, h = img.size
            if abs(w / h - CARD_ASPECT) > 0.08:
                target_h = int(w / CARD_ASPECT)
                if target_h > h:
                    target_h = h
                    w = int(h * CARD_ASPECT)
                cy = (img.height - target_h) // 2
                cx = (img.width - w) // 2
                img = img.crop((cx, cy, cx + w, cy + target_h))
            cards.append(img)
        except Exception as e:
            logger.warning("Could not load card %s: %s", p, e)
    logger.info("Loaded %d card images from %s", len(cards), card_dir)
    return cards


# ---------------------------------------------------------------------------
# Rotated-rectangle helpers
# ---------------------------------------------------------------------------

def _rotate_points(pts: list[tuple], cx: float, cy: float, angle_deg: float):
    rad = math.radians(angle_deg)
    cos, sin = math.cos(rad), math.sin(rad)
    out = []
    for x, y in pts:
        dx, dy = x - cx, y - cy
        out.append((cx + dx * cos - dy * sin, cy + dx * sin + dy * cos))
    return out


def _axis_aligned_bbox(pts: list[tuple]) -> tuple[float, float, float, float]:
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


def _rect_intersection_area(a: tuple, b: tuple) -> float:
    """Intersection area of two axis-aligned rects (x1,y1,x2,y2)."""
    ix1 = max(a[0], b[0])
    iy1 = max(a[1], b[1])
    ix2 = min(a[2], b[2])
    iy2 = min(a[3], b[3])
    if ix2 <= ix1 or iy2 <= iy1:
        return 0.0
    return (ix2 - ix1) * (iy2 - iy1)


# ---------------------------------------------------------------------------
# Scene compositor
# ---------------------------------------------------------------------------

def _generate_scene(
    bg: Image.Image,
    cards: list[Image.Image],
    n_cards: int,
    behind_glass: bool = False,
) -> tuple[Image.Image, list[tuple[float, float, float, float]]]:
    """
    Composite n_cards cards onto bg. Returns (image, list_of_yolo_bboxes).
    Each bbox is (cx, cy, w, h) normalised to [0,1]. Cards occluded beyond
    MAX_OCCLUSION are omitted from the label list.
    """
    # Pick a random 1600×1200 crop of the background
    bw, bh = bg.size
    out_w, out_h = 1600, 1200
    if bw < out_w or bh < out_h:
        bg = bg.resize((max(bw, out_w), max(bh, out_h)), Image.LANCZOS)
        bw, bh = bg.size
    cx0 = random.randint(0, bw - out_w)
    cy0 = random.randint(0, bh - out_h)
    scene = bg.crop((cx0, cy0, cx0 + out_w, cy0 + out_h)).convert("RGB")

    placed: list[tuple] = []  # (bbox_aabb, card_area)

    for _ in range(n_cards):
        card = random.choice(cards).copy()

        # Scale: card short-side = 8–22% of scene short-side
        short = min(out_w, out_h)
        scale = random.uniform(0.08, 0.22)
        card_w = int(short * scale / CARD_ASPECT)
        card_h = int(card_w / CARD_ASPECT)
        card = card.resize((card_w, card_h), Image.LANCZOS)

        # Rotation ±12°
        angle = random.uniform(-12, 12)
        card_rot = card.rotate(angle, expand=True, resample=Image.BICUBIC)
        rw, rh = card_rot.size

        # Position — allow cards to hang slightly off edges (up to 15%)
        px = random.randint(-int(rw * 0.15), out_w - int(rw * 0.85))
        py = random.randint(-int(rh * 0.15), out_h - int(rh * 0.85))

        # Compute the axis-aligned bbox of this card in scene coordinates
        corners = _rotate_points(
            [(0, 0), (card_w, 0), (card_w, card_h), (0, card_h)],
            card_w / 2, card_h / 2, angle,
        )
        # Shift by rotated image offset then by paste position
        rot_ox = (rw - card_w) / 2
        rot_oy = (rh - card_h) / 2
        corners_scene = [(x + rot_ox + px, y + rot_oy + py) for x, y in corners]
        x1, y1, x2, y2 = _axis_aligned_bbox(corners_scene)
        # Clip to scene
        x1c, y1c = max(0, x1), max(0, y1)
        x2c, y2c = min(out_w, x2), min(out_h, y2)
        card_area = (x2 - x1) * (y2 - y1)
        if card_area <= 0:
            continue

        # Per-card augmentation
        card_rgb = card_rot.convert("RGB")
        card_rgb = _perspective_warp(card_rgb, strength=random.uniform(0.02, 0.07))
        card_rgb = _color_jitter(card_rgb, behind_glass=behind_glass)
        card_rgb = _maybe_blur(card_rgb)

        # Paste using alpha from rotated RGBA (if available)
        if card_rot.mode == "RGBA":
            mask = card_rot.split()[3]
        else:
            mask = None

        paste_x = max(0, px)
        paste_y = max(0, py)
        # Crop the rotated card to fit within scene
        crop_left  = max(0, -px)
        crop_top   = max(0, -py)
        crop_right = rw - max(0, px + rw - out_w)
        crop_bot   = rh - max(0, py + rh - out_h)
        card_crop = card_rgb.crop((crop_left, crop_top, crop_right, crop_bot))
        if mask:
            mask_crop = mask.crop((crop_left, crop_top, crop_right, crop_bot))
            scene.paste(card_crop, (paste_x, paste_y), mask_crop)
        else:
            scene.paste(card_crop, (paste_x, paste_y))

        placed.append(((x1c, y1c, x2c, y2c), card_area))

    # Build YOLO labels — skip cards occluded more than MAX_OCCLUSION
    # (approximate: check overlap with all later-placed cards)
    labels = []
    for i, ((x1, y1, x2, y2), card_area) in enumerate(placed):
        occluded = 0.0
        for j, ((ox1, oy1, ox2, oy2), _) in enumerate(placed):
            if j <= i:
                continue  # only cards placed ON TOP occlude this one
            inter = _rect_intersection_area((x1, y1, x2, y2), (ox1, oy1, ox2, oy2))
            occluded += inter
        visible_frac = 1.0 - (occluded / max(card_area, 1))
        if visible_frac < (1 - MAX_OCCLUSION):
            continue  # too occluded to label reliably
        # Clip bbox to scene bounds
        x1c, y1c = max(0.0, x1), max(0.0, y1)
        x2c, y2c = min(float(out_w), x2), min(float(out_h), y2)
        if x2c <= x1c or y2c <= y1c:
            continue
        # YOLO normalised cx, cy, w, h
        labels.append((
            (x1c + x2c) / 2 / out_w,
            (y1c + y2c) / 2 / out_h,
            (x2c - x1c) / out_w,
            (y2c - y1c) / out_h,
        ))

    return scene, labels


# ---------------------------------------------------------------------------
# Dataset writer
# ---------------------------------------------------------------------------

def _write_dataset(
    out_dir: Path,
    backgrounds: list[Image.Image],
    cards: list[Image.Image],
    n_images: int,
    train_split: float,
    behind_glass_fraction: float,
) -> None:
    for split in ("train", "val"):
        (out_dir / "images" / split).mkdir(parents=True, exist_ok=True)
        (out_dir / "labels" / split).mkdir(parents=True, exist_ok=True)

    n_train = int(n_images * train_split)
    stats = {"total": 0, "empty": 0, "cards": 0}

    for i in range(n_images):
        split = "train" if i < n_train else "val"
        bg = random.choice(backgrounds)
        n_cards = _sample_card_count()
        behind_glass = random.random() < behind_glass_fraction

        try:
            scene, labels = _generate_scene(bg, cards, n_cards, behind_glass)
        except Exception as e:
            logger.warning("Scene generation failed (i=%d): %s", i, e)
            continue

        stem = f"syn_{i:05d}"
        img_path = out_dir / "images" / split / f"{stem}.jpg"
        lbl_path = out_dir / "labels" / split / f"{stem}.txt"

        scene.save(str(img_path), "JPEG", quality=90)

        with open(lbl_path, "w") as f:
            for cx, cy, w, h in labels:
                f.write(f"0 {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}\n")

        stats["total"] += 1
        stats["cards"] += len(labels)
        if not labels:
            stats["empty"] += 1

        if (i + 1) % 100 == 0:
            logger.info(
                "Generated %d/%d images | avg %.1f cards/image | %d empty",
                i + 1, n_images,
                stats["cards"] / max(stats["total"], 1),
                stats["empty"],
            )

    # Write data.yaml
    yaml_path = out_dir / "data.yaml"
    yaml_path.write_text(
        f"path: {out_dir.resolve()}\n"
        f"train: images/train\n"
        f"val: images/val\n"
        f"nc: 1\n"
        f"names: ['card']\n"
    )
    logger.info(
        "Done. %d images written (%d train / %d val) | %.1f avg cards/image | %d empty scenes | data.yaml: %s",
        stats["total"],
        n_train,
        stats["total"] - n_train,
        stats["cards"] / max(stats["total"], 1),
        stats["empty"],
        yaml_path,
    )


# ---------------------------------------------------------------------------
# Optional: download card images from DB
# ---------------------------------------------------------------------------

def _download_cards(card_dir: Path, n_sample: int) -> None:
    """Sample n_sample random cards from Postgres and download their image_url."""
    import asyncio
    import httpx

    async def _run():
        try:
            import asyncpg
        except ImportError:
            logger.error("asyncpg not installed — run: pip install asyncpg")
            sys.exit(1)

        db_url = os.environ.get(
            "DATABASE_URL",
            "postgresql://tcg:tcgpass@localhost:5432/tcgdb",
        ).replace("postgresql+asyncpg://", "postgresql://").replace("postgresql+psycopg://", "postgresql://")

        logger.info("Connecting to DB: %s", db_url)
        conn = await asyncpg.connect(db_url)

        # Stratified sample: 45% EN Pokémon, 40% JP, 15% EN trainer/supporter/item.
        # YOLO learns card SHAPE not content, but visual diversity (text-heavy trainer
        # layouts, JP art styles) helps generalise. Trainer cards are identified by
        # names that don't contain common Pokémon name patterns — approximate via
        # checking for Supporter/Item/Tool/Trainer in the name as a rough heuristic;
        # pokemontcg.io cards with those words are almost always trainer cards.
        n_en_trainer = max(1, int(n_sample * 0.15))
        n_jp         = max(1, int(n_sample * 0.40))
        n_en_pokemon = n_sample - n_en_trainer - n_jp

        rows_en_pokemon = await conn.fetch(
            "SELECT image_url FROM cards WHERE image_url IS NOT NULL "
            "AND embedding IS NOT NULL AND language = 'en' "
            "AND name NOT ILIKE '%supporter%' AND name NOT ILIKE '%item%' "
            "AND name NOT ILIKE '%trainer%' AND name NOT ILIKE '%tool%' "
            "ORDER BY RANDOM() LIMIT $1",
            n_en_pokemon,
        )
        rows_en_trainer = await conn.fetch(
            "SELECT image_url FROM cards WHERE image_url IS NOT NULL "
            "AND embedding IS NOT NULL AND language = 'en' "
            "AND (name ILIKE '%supporter%' OR name ILIKE '%item%' "
            "     OR name ILIKE '%trainer%' OR name ILIKE '%tool%' "
            "     OR rarity ILIKE '%uncommon%') "
            "ORDER BY RANDOM() LIMIT $1",
            n_en_trainer,
        )
        rows_jp = await conn.fetch(
            "SELECT image_url FROM cards WHERE image_url IS NOT NULL "
            "AND embedding IS NOT NULL AND language = 'ja' "
            "ORDER BY RANDOM() LIMIT $1",
            n_jp,
        )
        await conn.close()

        rows = list(rows_en_pokemon) + list(rows_en_trainer) + list(rows_jp)
        random.shuffle(rows)
        logger.info(
            "Sampled %d EN Pokémon + %d EN trainer/item + %d JP = %d total card images",
            len(rows_en_pokemon), len(rows_en_trainer), len(rows_jp), len(rows),
        )

        card_dir.mkdir(parents=True, exist_ok=True)
        downloaded = 0
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            for idx, row in enumerate(rows):
                url = row["image_url"]
                dest = card_dir / f"card_{idx:05d}.jpg"
                if dest.exists():
                    downloaded += 1
                    continue
                try:
                    r = await client.get(url)
                    r.raise_for_status()
                    dest.write_bytes(r.content)
                    downloaded += 1
                    await asyncio.sleep(0.15)
                except Exception as e:
                    logger.warning("Failed %s: %s", url, e)
                if (idx + 1) % 50 == 0:
                    logger.info("Downloaded %d/%d cards", downloaded, len(rows))
        logger.info("Downloaded %d card images to %s", downloaded, card_dir)

    asyncio.run(_run())


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    p = argparse.ArgumentParser(description="Generate synthetic YOLO card detection dataset")
    p.add_argument("--cards",       required=True,  type=Path, help="Directory of card images (jpg/png)")
    p.add_argument("--backgrounds", required=True,  type=Path, help="Directory of background images")
    p.add_argument("--output",      required=True,  type=Path, help="Output dataset directory")
    p.add_argument("--count",       default=3000,   type=int,  help="Number of synthetic images to generate")
    p.add_argument("--split",       default=0.85,   type=float,help="Train/val split fraction")
    p.add_argument("--glass-fraction", default=0.25, type=float,
                   help="Fraction of images that simulate a glass display case background")
    p.add_argument("--seed",        default=42,     type=int,  help="Random seed")
    p.add_argument("--download-cards", type=int,    metavar="N",
                   help="Download N random card images from DB before generating (requires DB running)")
    args = p.parse_args()

    random.seed(args.seed)
    np.random.seed(args.seed)

    if args.download_cards:
        logger.info("Downloading %d card images from DB...", args.download_cards)
        _download_cards(args.cards, args.download_cards)

    backgrounds = _load_backgrounds(args.backgrounds)
    cards = _load_cards(args.cards)

    if len(cards) < 10:
        logger.error("Need at least 10 card images. Use --download-cards N to fetch from DB.")
        sys.exit(1)

    logger.info(
        "Generating %d synthetic images (%d cards, %d backgrounds, glass=%.0f%%)",
        args.count, len(cards), len(backgrounds), args.glass_fraction * 100,
    )
    _write_dataset(args.output, backgrounds, cards, args.count, args.split, args.glass_fraction)


if __name__ == "__main__":
    main()
