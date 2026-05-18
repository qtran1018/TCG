#!/usr/bin/env python3
"""
Convert a Roboflow COCO export to YOLO format for yolo11n training.

Usage:
    python scripts/coco_to_yolo.py \
        --src "C:\\Users\\Quang\\Desktop\\train" \
        --dst "C:\\Users\\Quang\\Desktop\\yolo_dataset"
"""

import argparse
import json
import random
import shutil
from pathlib import Path


def main(src: Path, dst: Path, val_frac: float = 0.20, seed: int = 42):
    coco_path = src / "_annotations.coco.json"
    if not coco_path.exists():
        raise FileNotFoundError(f"No _annotations.coco.json found in {src}")

    with open(coco_path) as f:
        coco = json.load(f)

    # Find the target class — use "rectangle card" if present, else first class
    categories = {c["id"]: c["name"] for c in coco["categories"]}
    target_ids = {cid for cid, name in categories.items() if "card" in name.lower()}
    if not target_ids:
        target_ids = set(categories.keys())
    print(f"Using categories: {[categories[i] for i in sorted(target_ids)]} -> YOLO class 0")

    # Build image map
    images = {img["id"]: img for img in coco["images"]}

    # Group annotations by image id, filtering to target class only
    ann_by_image: dict[int, list] = {img_id: [] for img_id in images}
    skipped_class = 0
    for ann in coco["annotations"]:
        if ann["category_id"] not in target_ids:
            skipped_class += 1
            continue
        ann_by_image[ann["image_id"]].append(ann)

    # Split images into train/val
    all_ids = list(images.keys())
    random.seed(seed)
    random.shuffle(all_ids)
    split = int(len(all_ids) * (1 - val_frac))
    train_ids = set(all_ids[:split])
    val_ids = set(all_ids[split:])

    # Create output directories
    for split_name in ("train", "valid"):
        (dst / split_name / "images").mkdir(parents=True, exist_ok=True)
        (dst / split_name / "labels").mkdir(parents=True, exist_ok=True)

    total_anns = 0
    no_ann_images = 0

    for img_id, img_info in images.items():
        split_name = "train" if img_id in train_ids else "valid"
        src_img = src / img_info["file_name"]
        if not src_img.exists():
            print(f"  WARNING: image not found: {src_img.name}")
            continue

        anns = ann_by_image.get(img_id, [])
        if not anns:
            no_ann_images += 1

        # Copy image
        shutil.copy2(src_img, dst / split_name / "images" / src_img.name)

        # Write label file (empty if no annotations)
        label_path = dst / split_name / "labels" / (src_img.stem + ".txt")
        iw, ih = img_info["width"], img_info["height"]
        lines = []
        for ann in anns:
            x, y, w, h = [float(v) for v in ann["bbox"]]
            cx = (x + w / 2) / iw
            cy = (y + h / 2) / ih
            wn = w / iw
            hn = h / ih
            # Clamp to [0, 1]
            cx = max(0.0, min(1.0, cx))
            cy = max(0.0, min(1.0, cy))
            wn = max(0.0, min(1.0, wn))
            hn = max(0.0, min(1.0, hn))
            lines.append(f"0 {cx:.6f} {cy:.6f} {wn:.6f} {hn:.6f}")
        label_path.write_text("\n".join(lines))
        total_anns += len(anns)

    # Write data.yaml
    yaml_path = dst / "data.yaml"
    yaml_path.write_text(
        f"path: {dst.as_posix()}\n"
        f"train: train/images\n"
        f"val: valid/images\n"
        f"nc: 1\n"
        f"names: ['card']\n"
    )

    print(f"\nDone.")
    print(f"  Train images : {len(train_ids)}")
    print(f"  Val images   : {len(val_ids)}")
    print(f"  Annotations  : {total_anns}")
    print(f"  No-ann images: {no_ann_images} (label files written as empty)")
    if skipped_class:
        print(f"  Skipped anns (wrong class): {skipped_class}")
    print(f"\nDataset written to: {dst}")
    print(f"data.yaml: {yaml_path}")
    print(f"\nTrain with:")
    print(f'  yolo train model=yolo11n.pt data="{yaml_path}" epochs=50 imgsz=640')


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--src", required=True, type=Path, help="Folder containing images + _annotations.coco.json")
    parser.add_argument("--dst", required=True, type=Path, help="Output folder for YOLO dataset")
    parser.add_argument("--val-frac", type=float, default=0.20, help="Fraction of images for validation (default 0.20)")
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()
    main(args.src, args.dst, args.val_frac, args.seed)
