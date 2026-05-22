"""
Post-training INT8 quantization for card_detector TFLite model.

Reads the existing TF SavedModel (produced by onnx2tf during v18 export),
runs calibration images through it to determine per-layer activation ranges,
and writes a fully quantized INT8 TFLite model.

Internal weights and activations run in INT8; I/O stays float32 so
yoloDetector.ts needs no changes.

Usage (inside Docker):
    python /scripts/quantize_int8.py --calib-dir /calib_images --output /app/models/card_detector_int8.tflite

Then copy to mobile:
    docker cp tcg_backend:/app/models/card_detector_int8.tflite mobile/assets/models/card_detector.tflite
"""

import argparse
import os
import sys

import numpy as np
from PIL import Image

MODEL_SIZE = 640
SUPPORTED_EXTS = {".jpg", ".jpeg", ".png", ".webp"}


def iter_images(root: str):
    for dirpath, _, filenames in os.walk(root):
        for fname in sorted(filenames):
            if os.path.splitext(fname)[1].lower() in SUPPORTED_EXTS:
                yield os.path.join(dirpath, fname)


def build_representative_dataset(calib_dir: str, max_images: int = 300):
    paths = list(iter_images(calib_dir))[:max_images]
    if not paths:
        sys.exit(f"No images found under {calib_dir}")
    print(f"Calibrating on {len(paths)} images from {calib_dir}")

    def generator():
        for i, path in enumerate(paths):
            try:
                img = Image.open(path).convert("RGB").resize(
                    (MODEL_SIZE, MODEL_SIZE), Image.BILINEAR
                )
                arr = np.array(img, dtype=np.float32) / 255.0
                yield [arr[np.newaxis]]  # [1, 640, 640, 3]
            except Exception as e:
                print(f"  Skipping {path}: {e}")
            if (i + 1) % 50 == 0:
                print(f"  Calibrated {i + 1}/{len(paths)} images...")

    return generator


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--calib-dir",
        required=True,
        help="Directory of calibration images (searched recursively)",
    )
    parser.add_argument(
        "--saved-model",
        default="/app/models/card_detector_saved_model",
        help="Path to TF SavedModel directory (output of onnx2tf)",
    )
    parser.add_argument(
        "--output",
        default="/app/models/card_detector_int8.tflite",
        help="Output path for the INT8 TFLite model",
    )
    args = parser.parse_args()

    if not os.path.isdir(args.saved_model):
        sys.exit(
            f"SavedModel not found at {args.saved_model}. "
            "Run onnx2tf first to generate it."
        )

    import tensorflow as tf

    print(f"TensorFlow {tf.__version__}")
    print(f"Loading SavedModel from {args.saved_model} ...")

    converter = tf.lite.TFLiteConverter.from_saved_model(args.saved_model)
    converter.optimizations = [tf.lite.Optimize.DEFAULT]
    converter.representative_dataset = build_representative_dataset(args.calib_dir)
    converter.target_spec.supported_ops = [tf.lite.OpsSet.TFLITE_BUILTINS_INT8]
    # Keep float32 I/O — mobile preprocessing code unchanged
    converter.inference_input_type = tf.float32
    converter.inference_output_type = tf.float32

    print("Converting (this runs all calibration images — takes 1–3 minutes) ...")
    tflite_model = converter.convert()

    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    with open(args.output, "wb") as f:
        f.write(tflite_model)

    size_kb = len(tflite_model) / 1024
    print(f"Done. Written to {args.output} ({size_kb:.0f} KB)")
    print()
    print("Next steps:")
    print(f"  docker cp tcg_backend:{args.output} mobile/assets/models/card_detector.tflite")
    print("  Then rebuild: expo run:android")


if __name__ == "__main__":
    main()
