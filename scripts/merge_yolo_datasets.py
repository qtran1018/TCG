#!/usr/bin/env python3
"""
Merge multiple YOLO-format datasets into one combined train/valid split.

Handles three label formats and normalizes all to standard YOLO bbox:
  - Standard bbox:    class cx cy w h
  - OBB (4 points):  class x1 y1 x2 y2 x3 y3 x4 y4
  - Polygon mask:     class x1 y1 x2 y2 ... xN yN  (N > 4 points)

All classes are collapsed to class 0 "card".

Usage:
    python scripts/merge_yolo_datasets.py \
        --src "C:\\path\\to\\dataset1" \
                "C:\\path\\to\\dataset2" \
                "C:\\path\\to\\dataset3" \
        --dst "C:\\Users\\Quang\\Desktop\\yolo_merged"
"""

import argparse
import random
import re
import shutil
from pathlib import Path


def poly_to_bbox(coords: list[float]) -> tuple[float, float, float, float]:
    """Convert any polygon (OBB or segmentation) to axis-aligned cx,cy,w,h."""
    xs = coords[0::2]
    ys = coords[1::2]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    cx = (min_x + max_x) / 2
    cy = (min_y + max_y) / 2
    w = max_x - min_x
    h = max_y - min_y
    return cx, cy, w, h


def convert_label_file(src_txt: Path) -> list[str]:
    """Read a label file and return standard YOLO bbox lines (class 0)."""
    lines_out = []
    for raw in src_txt.read_text().splitlines():
        raw = raw.strip()
        if not raw:
            continue
        parts = raw.split()
        if len(parts) < 5:
            continue
        nums = [float(p) for p in parts[1:]]  # drop class id — remap to 0
        if len(nums) == 4:
            # Already standard bbox: cx cy w h
            cx, cy, w, h = nums
        else:
            # OBB (8 values) or polygon (>8 values)
            cx, cy, w, h = poly_to_bbox(nums)

        # Clamp
        cx = max(0.0, min(1.0, cx))
        cy = max(0.0, min(1.0, cy))
        w = max(0.0, min(1.0, w))
        h = max(0.0, min(1.0, h))

        if w > 0 and h > 0:
            lines_out.append(f"0 {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}")
    return lines_out


def collect_pairs(src: Path) -> list[tuple[Path, Path | None]]:
    """Return (image_path, label_path_or_None) pairs from a dataset folder."""
    pairs = []
    for split in ("train", "valid", "test"):
        img_dir = src / split / "images"
        lbl_dir = src / split / "labels"
        if not img_dir.exists():
            continue
        for img in sorted(img_dir.iterdir()):
            if img.suffix.lower() not in (".jpg", ".jpeg", ".png"):
                continue
            lbl = lbl_dir / (img.stem + ".txt")
            pairs.append((img, lbl if lbl.exists() else None))
    return pairs


def main(sources: list[Path], dst: Path, val_frac: float = 0.20, seed: int = 42):
    all_pairs: list[tuple[Path, Path | None]] = []
    for src in sources:
        found = collect_pairs(src)
        print(f"  {src.name}: {len(found)} images")
        all_pairs.extend(found)

    print(f"\nTotal images: {len(all_pairs)}")

    # Shuffle and split
    random.seed(seed)
    random.shuffle(all_pairs)
    split_idx = int(len(all_pairs) * (1 - val_frac))
    train_pairs = all_pairs[:split_idx]
    val_pairs = all_pairs[split_idx:]

    # Create output directories
    for split_name in ("train", "valid"):
        (dst / split_name / "images").mkdir(parents=True, exist_ok=True)
        (dst / split_name / "labels").mkdir(parents=True, exist_ok=True)

    def write_split(pairs, split_name):
        ann_count = 0
        name_count: dict[str, int] = {}
        for img_path, lbl_path in pairs:
            # Deduplicate filenames across sources
            stem = img_path.stem
            name_count[stem] = name_count.get(stem, 0) + 1
            suffix = f"_{name_count[stem]}" if name_count[stem] > 1 else ""
            out_img = dst / split_name / "images" / (stem + suffix + img_path.suffix)
            out_lbl = dst / split_name / "labels" / (stem + suffix + ".txt")

            shutil.copy2(img_path, out_img)

            if lbl_path:
                lines = convert_label_file(lbl_path)
                out_lbl.write_text("\n".join(lines))
                ann_count += len(lines)
            else:
                out_lbl.write_text("")
        return ann_count

    train_anns = write_split(train_pairs, "train")
    val_anns = write_split(val_pairs, "valid")

    # Write data.yaml
    yaml_path = dst / "data.yaml"
    yaml_path.write_text(
        f"path: {dst.as_posix()}\n"
        f"train: train/images\n"
        f"val: valid/images\n"
        f"nc: 1\n"
        f"names: ['card']\n"
    )

    print(f"\nMerge complete.")
    print(f"  Train: {len(train_pairs)} images, {train_anns} annotations")
    print(f"  Valid: {len(val_pairs)} images, {val_anns} annotations")
    print(f"  Output: {dst}")
    print(f"\nTrain with:")
    print(f'  yolo train model=yolo11n.pt data="{yaml_path}" epochs=50 imgsz=640')


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--src", nargs="+", required=True, type=Path,
                        help="One or more dataset folders (each with train/valid/test subfolders)")
    parser.add_argument("--dst", required=True, type=Path,
                        help="Output folder for merged YOLO dataset")
    parser.add_argument("--val-frac", type=float, default=0.20)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()
    main(args.src, args.dst, args.val_frac, args.seed)
