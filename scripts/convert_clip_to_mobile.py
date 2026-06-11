#!/usr/bin/env python3
"""
Convert the fine-tuned CLIP visual encoder to mobile formats.

Outputs:
  - clip_visual.onnx              (FP32 reference — for parity harness baseline)
  - clip_visual_fp16.onnx         (FP16 — smaller, good precision)
  - clip_visual_int8.tflite       (INT8 quantized via onnx2tf — for Android)
  - clip_visual_fp16.tflite       (FP16 — for Android fallback / wider op support)
  - clip_visual.mlpackage         (CoreML — for iOS, via coremltools)

After conversion, ALWAYS run the parity harness against each artifact before
shipping:
    python scripts/parity_harness.py --candidate clip_visual_int8.tflite --format tflite
    python scripts/parity_harness.py --candidate clip_visual.mlpackage --format coreml

If int8 fails parity, use fp16 TFLite. Never ship a model that fails the harness.

Usage:
    python scripts/convert_clip_to_mobile.py --output-dir mobile_models/
    python scripts/convert_clip_to_mobile.py --output-dir mobile_models/ --formats onnx tflite
    python scripts/convert_clip_to_mobile.py --output-dir mobile_models/ --formats coreml

Requirements (install separately — not in main requirements.txt):
    pip install onnx onnxruntime onnxsim
    pip install onnx2tf tensorflow  # for TFLite
    pip install coremltools          # for CoreML (macOS only)
"""

import argparse
import logging
import sys
from pathlib import Path

import torch
import numpy as np

for _p in [Path(__file__).parent.parent / "backend", Path("/app")]:
    if (_p / "app").is_dir():
        sys.path.insert(0, str(_p))
        break

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

_FINETUNED_WEIGHTS = Path(__file__).parent.parent / "backend" / "models" / "clip_finetuned.pt"
_INPUT_SIZE = 224


def load_visual_encoder():
    """Load only the fine-tuned visual encoder tower from clip_finetuned.pt."""
    import open_clip
    model, _, _ = open_clip.create_model_and_transforms("ViT-B-32", pretrained="openai")

    if _FINETUNED_WEIGHTS.exists():
        logger.info("Loading fine-tuned weights from %s", _FINETUNED_WEIGHTS)
        state = torch.load(_FINETUNED_WEIGHTS, map_location="cpu")
        model.visual.load_state_dict(state)
    else:
        logger.warning("Fine-tuned weights not found — using stock OpenAI CLIP (parity will be lower)")

    model.eval()
    return model.visual  # return only the visual tower


class ClipVisualWrapper(torch.nn.Module):
    """Wrap visual encoder to output L2-normalized 512-d embedding.

    Replicates card_embedder.embed_batch post-processing so the exported model
    includes the L2-norm step — the on-device caller gets a ready-to-use vector.
    """
    def __init__(self, visual):
        super().__init__()
        self.visual = visual

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        features = self.visual(x)
        return features / features.norm(dim=-1, keepdim=True)


def make_dummy_input():
    return torch.zeros(1, 3, _INPUT_SIZE, _INPUT_SIZE)


# ---------------------------------------------------------------------------
# ONNX export
# ---------------------------------------------------------------------------

def export_onnx(visual, output_path: Path, fp16: bool = False) -> Path:
    logger.info("Exporting ONNX (%s)...", "fp16" if fp16 else "fp32")
    model = ClipVisualWrapper(visual)
    if fp16:
        model = model.half()

    dummy = make_dummy_input()
    if fp16:
        dummy = dummy.half()

    torch.onnx.export(
        model,
        dummy,
        str(output_path),
        input_names=["image"],
        output_names=["embedding"],
        dynamic_axes={"image": {0: "batch"}, "embedding": {0: "batch"}},
        opset_version=14,
        do_constant_folding=True,
    )
    logger.info("ONNX saved to %s", output_path)

    # Simplify with onnxsim for cleaner graph (fewer ops for onnx2tf)
    try:
        import onnxsim
        import onnx
        model_onnx = onnx.load(str(output_path))
        model_sim, ok = onnxsim.simplify(model_onnx)
        if ok:
            onnx.save(model_sim, str(output_path))
            logger.info("ONNX simplified with onnxsim")
        else:
            logger.warning("onnxsim simplification did not converge — using unsimplified")
    except ImportError:
        logger.warning("onnxsim not installed — skipping simplification (install with: pip install onnxsim)")

    return output_path


# ---------------------------------------------------------------------------
# TFLite export (via onnx2tf)
# ---------------------------------------------------------------------------

def export_tflite(onnx_path: Path, output_dir: Path, quantize_int8: bool = True) -> list[Path]:
    """Convert ONNX → TF SavedModel → TFLite via onnx2tf.

    Mirrors the exact chain used for card_detector.tflite (CLAUDE.md export chain).
    Do NOT use ultralytics direct export — use onnx2tf manually.

    Returns list of produced TFLite paths.
    """
    import subprocess

    saved_model_dir = output_dir / "clip_visual_saved_model"
    logger.info("Running onnx2tf: %s -> %s", onnx_path, saved_model_dir)

    cmd = [
        sys.executable, "-m", "onnx2tf",
        "-i", str(onnx_path),
        "-o", str(saved_model_dir),
        "-osd",  # output as SavedModel (needed for TFLite conversion step)
        "--non_verbose",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        logger.error("onnx2tf failed:\n%s", result.stderr)
        raise RuntimeError("onnx2tf conversion failed")
    logger.info("onnx2tf succeeded")

    import tensorflow as tf

    outputs = []

    # FP16 TFLite
    fp16_path = output_dir / "clip_visual_fp16.tflite"
    logger.info("Converting to fp16 TFLite...")
    converter = tf.lite.TFLiteConverter.from_saved_model(str(saved_model_dir))
    converter.optimizations = [tf.lite.Optimize.DEFAULT]
    converter.target_spec.supported_types = [tf.float16]
    tflite_model = converter.convert()
    fp16_path.write_bytes(tflite_model)
    logger.info("fp16 TFLite saved: %s (%.1f MB)", fp16_path, len(tflite_model) / 1e6)
    outputs.append(fp16_path)

    # INT8 TFLite (requires representative dataset for full integer quantization)
    if quantize_int8:
        int8_path = output_dir / "clip_visual_int8.tflite"
        logger.info("Converting to int8 TFLite (representative dataset)...")

        def representative_dataset():
            """Feed synthetic CLIP-normalized inputs for int8 calibration.

            For best accuracy, replace with real card art crops. The mean/std
            values match open_clip ViT-B/32 normalization used in card_embedder.py.
            """
            rng = np.random.default_rng(42)
            mean = np.array([0.48145466, 0.4578275, 0.40821073], dtype=np.float32)
            std  = np.array([0.26862954, 0.26130258, 0.27577711], dtype=np.float32)
            for _ in range(200):
                # Simulate normalized card art pixels: uniform [0,1] → normalize
                img = rng.random((1, _INPUT_SIZE, _INPUT_SIZE, 3), dtype=np.float32)
                img = (img - mean) / std
                yield [img]

        converter_i8 = tf.lite.TFLiteConverter.from_saved_model(str(saved_model_dir))
        converter_i8.optimizations = [tf.lite.Optimize.DEFAULT]
        converter_i8.representative_dataset = representative_dataset
        converter_i8.target_spec.supported_ops = [tf.lite.OpsSet.TFLITE_BUILTINS_INT8]
        converter_i8.inference_input_type  = tf.int8
        converter_i8.inference_output_type = tf.int8
        try:
            tflite_int8 = converter_i8.convert()
            int8_path.write_bytes(tflite_int8)
            logger.info("int8 TFLite saved: %s (%.1f MB)", int8_path, len(tflite_int8) / 1e6)
            outputs.append(int8_path)
        except Exception as e:
            logger.warning("int8 conversion failed (ops not fully int8-able): %s", e)
            logger.warning("This is common for ViT attention ops on some TF versions — use fp16 instead")

    return outputs


# ---------------------------------------------------------------------------
# CoreML export
# ---------------------------------------------------------------------------

def export_coreml(onnx_path: Path, output_dir: Path) -> Path:
    """Convert ONNX → CoreML via coremltools.

    CoreML is the preferred path for iOS — Neural Engine support is more
    consistent than Android NNAPI for transformer architectures.
    """
    import coremltools as ct

    output_path = output_dir / "clip_visual.mlpackage"
    logger.info("Converting to CoreML...")

    model = ct.convert(
        str(onnx_path),
        inputs=[ct.TensorType(name="image", shape=(1, 3, _INPUT_SIZE, _INPUT_SIZE))],
        outputs=[ct.TensorType(name="embedding")],
        minimum_deployment_target=ct.target.iOS16,
        compute_precision=ct.precision.FLOAT16,
    )
    model.save(str(output_path))
    logger.info("CoreML saved: %s", output_path)
    return output_path


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Convert fine-tuned CLIP visual encoder to mobile formats")
    parser.add_argument("--output-dir", type=Path, default=Path("mobile_models"),
                        help="Directory to write converted model files")
    parser.add_argument("--formats", nargs="+",
                        choices=["onnx", "tflite", "coreml"],
                        default=["onnx", "tflite"],
                        help="Which formats to produce (default: onnx tflite)")
    parser.add_argument("--skip-int8", action="store_true",
                        help="Skip INT8 TFLite (produce fp16 only) — faster, avoids calibration issues")
    parser.add_argument("--weights", type=Path, default=_FINETUNED_WEIGHTS,
                        help="Path to fine-tuned weights (default: backend/models/clip_finetuned.pt)")
    args = parser.parse_args()

    global _FINETUNED_WEIGHTS
    _FINETUNED_WEIGHTS = args.weights

    args.output_dir.mkdir(parents=True, exist_ok=True)
    logger.info("Output directory: %s", args.output_dir.resolve())

    logger.info("Loading visual encoder...")
    visual = load_visual_encoder()

    produced = []

    if "onnx" in args.formats or "tflite" in args.formats or "coreml" in args.formats:
        onnx_fp32 = args.output_dir / "clip_visual.onnx"
        export_onnx(visual, onnx_fp32, fp16=False)
        produced.append(onnx_fp32)

    if "tflite" in args.formats:
        try:
            tflite_files = export_tflite(onnx_fp32, args.output_dir, quantize_int8=not args.skip_int8)
            produced.extend(tflite_files)
        except Exception as e:
            logger.error("TFLite export failed: %s", e)
            logger.error("Install: pip install onnx2tf tensorflow")

    if "coreml" in args.formats:
        try:
            ml_path = export_coreml(onnx_fp32, args.output_dir)
            produced.append(ml_path)
        except Exception as e:
            logger.error("CoreML export failed: %s", e)
            logger.error("Install: pip install coremltools (macOS only)")

    print("\n" + "=" * 60)
    print("CONVERSION COMPLETE")
    print("=" * 60)
    for p in produced:
        size_mb = p.stat().st_size / 1e6 if p.exists() else 0
        print(f"  {p.name:<40} {size_mb:6.1f} MB")
    print()
    print("NEXT STEP — run parity harness against each artifact:")
    for p in produced:
        if p.suffix in (".tflite",):
            print(f"  python scripts/parity_harness.py --candidate {p} --format tflite")
        elif p.suffix in (".mlpackage", ".mlmodel"):
            print(f"  python scripts/parity_harness.py --candidate {p} --format coreml")
        elif p.suffix == ".onnx":
            print(f"  python scripts/parity_harness.py --candidate {p} --format onnx")
    print()
    print("Ship only models that PASS the harness (mean drift < 0.02, NN agreement >= 99%).")
    print("=" * 60)


if __name__ == "__main__":
    main()
