#!/usr/bin/env python3
"""
Parity harness — Phase 0 gate for on-device CLIP migration.

Compares embeddings from the original fine-tuned PyTorch model against a
candidate converted/quantized model (ONNX Runtime, TFLite, or CoreML) over
a sample of real card images pulled from the database.

Pass/fail criteria:
  - Mean cosine drift  < 0.02
  - Top-1 NN agreement >= 99%
  - P99 cosine drift   < 0.05

If the candidate fails, on-device CLIP is not viable at that quantization
level — try float16 TFLite instead of int8 before investing in mobile work.

Usage:
    # Test against a reference ONNX export (no quantization)
    python scripts/parity_harness.py --candidate clip_visual.onnx --format onnx

    # Test against a quantized int8 TFLite model
    python scripts/parity_harness.py --candidate clip_visual_int8.tflite --format tflite

    # Test against a CoreML model
    python scripts/parity_harness.py --candidate clip_visual.mlpackage --format coreml

    # Sample size (default 500, more is slower but more reliable)
    python scripts/parity_harness.py --candidate clip_visual.onnx --format onnx --samples 1000

    # Export reference embeddings only (no candidate — useful for first run)
    python scripts/parity_harness.py --export-reference ref_embeddings.npz
"""

import argparse
import asyncio
import io
import logging
import sys
from pathlib import Path

import asyncpg
import numpy as np
import os

for _candidate_path in [Path(__file__).parent.parent / "backend", Path("/app")]:
    if (_candidate_path / "app").is_dir():
        sys.path.insert(0, str(_candidate_path))
        break

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

PASS_MEAN_DRIFT   = 0.02
PASS_P99_DRIFT    = 0.05
PASS_NN_AGREEMENT = 0.99


# ---------------------------------------------------------------------------
# Reference embeddings (PyTorch fine-tuned model via card_embedder.py)
# ---------------------------------------------------------------------------

def embed_reference(image_bytes_list: list[bytes]) -> np.ndarray:
    """Embed using the existing server-side pipeline (card_embedder.py).

    This is the ground truth — the pipeline that generated the shipped index.
    Must match _crop_art + _preprocess + encode_image + L2-normalize exactly.
    """
    import importlib.util
    # Load card_embedder directly — avoids app/services/__init__.py which
    # pulls in the full FastAPI/Redis/Pydantic stack (not needed here).
    for base in [Path(__file__).parent.parent / "backend", Path("/app")]:
        candidate = base / "app" / "services" / "card_embedder.py"
        if candidate.exists():
            spec = importlib.util.spec_from_file_location("card_embedder", candidate)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            break
    else:
        raise ImportError("card_embedder.py not found")
    vecs = mod.embed_batch(image_bytes_list)
    return np.stack(vecs)  # (N, 512) float32


# ---------------------------------------------------------------------------
# Candidate model runners
# ---------------------------------------------------------------------------

def _crop_art_pil(img_bytes: bytes):
    """Replicate card_embedder._crop_art exactly — same fractions, same method."""
    from PIL import Image
    img = Image.open(io.BytesIO(img_bytes)).convert("RGB")
    w, h = img.size
    return img.crop((int(w * 0.04), int(h * 0.12), int(w * 0.96), int(h * 0.52)))


def _clip_preprocess_numpy(crop_pil) -> np.ndarray:
    """Replicate open_clip ViT-B/32 preprocessing as numpy for candidate runners.

    Steps (must match open_clip's transform exactly):
      1. Resize shorter side to 224 (bicubic), preserving aspect ratio
      2. Center-crop to 224×224
      3. Normalize: mean=[0.48145466, 0.4578275, 0.40821073]
                    std= [0.26862954, 0.26130258, 0.27577711]
    Output: float32 NCHW (1, 3, 224, 224)
    """
    from PIL import Image
    w, h = crop_pil.size
    scale = 224 / min(w, h)
    new_w, new_h = max(224, round(w * scale)), max(224, round(h * scale))
    img = crop_pil.resize((new_w, new_h), Image.BICUBIC)
    # Center crop to 224×224
    left = (new_w - 224) // 2
    top  = (new_h - 224) // 2
    img = img.crop((left, top, left + 224, top + 224))
    arr = np.array(img, dtype=np.float32) / 255.0  # HWC [0,1]
    mean = np.array([0.48145466, 0.4578275, 0.40821073], dtype=np.float32)
    std  = np.array([0.26862954, 0.26130258, 0.27577711], dtype=np.float32)
    arr = (arr - mean) / std
    return arr.transpose(2, 0, 1)[np.newaxis]  # NCHW


def embed_onnx(image_bytes_list: list[bytes], model_path: str) -> np.ndarray:
    import onnxruntime as ort
    sess = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
    input_name = sess.get_inputs()[0].name
    vecs = []
    for img_bytes in image_bytes_list:
        crop = _crop_art_pil(img_bytes)
        inp = _clip_preprocess_numpy(crop)
        out = sess.run(None, {input_name: inp})[0][0]  # (512,)
        out = out / (np.linalg.norm(out) + 1e-8)
        vecs.append(out.astype(np.float32))
    return np.stack(vecs)


def embed_tflite(image_bytes_list: list[bytes], model_path: str) -> np.ndarray:
    import tensorflow as tf
    interp = tf.lite.Interpreter(model_path=model_path)
    interp.allocate_tensors()
    inp_det = interp.get_input_details()[0]
    out_det = interp.get_output_details()[0]
    vecs = []
    for img_bytes in image_bytes_list:
        crop = _crop_art_pil(img_bytes)
        inp = _clip_preprocess_numpy(crop)  # NCHW float32
        # TFLite expects NHWC
        inp_nhwc = inp.transpose(0, 2, 3, 1)
        if inp_det["dtype"] == np.int8:
            scale, zero_point = inp_det["quantization"]
            inp_nhwc = (inp_nhwc / scale + zero_point).clip(-128, 127).astype(np.int8)
        interp.set_tensor(inp_det["index"], inp_nhwc)
        interp.invoke()
        out = interp.get_tensor(out_det["index"])[0]  # (512,)
        if out_det["dtype"] == np.int8:
            scale, zero_point = out_det["quantization"]
            out = (out.astype(np.float32) - zero_point) * scale
        out = out.astype(np.float32)
        out = out / (np.linalg.norm(out) + 1e-8)
        vecs.append(out)
    return np.stack(vecs)


def embed_coreml(image_bytes_list: list[bytes], model_path: str) -> np.ndarray:
    import coremltools as ct
    from PIL import Image
    model = ct.models.MLModel(model_path)
    vecs = []
    for img_bytes in image_bytes_list:
        crop = _crop_art_pil(img_bytes).resize((224, 224))
        out = model.predict({"image": crop})
        # Output name varies — grab the first float array
        vec = next(v for v in out.values() if hasattr(v, "shape"))
        vec = np.array(vec).flatten().astype(np.float32)
        vec = vec / (np.linalg.norm(vec) + 1e-8)
        vecs.append(vec)
    return np.stack(vecs)


# ---------------------------------------------------------------------------
# Image fetch from DB
# ---------------------------------------------------------------------------

async def fetch_sample_images(db_url: str, n: int, card_ids: list[int] | None = None) -> list[tuple[int, bytes]]:
    """Fetch card images from the DB for parity testing.

    If card_ids is given, fetches those specific cards (for --load-reference reuse).
    Otherwise fetches a stratified random sample: half EN, half JP.
    """
    import aiohttp
    conn = await asyncpg.connect(db_url)
    try:
        if card_ids:
            rows = await conn.fetch(
                "SELECT id, image_url FROM cards WHERE id = ANY($1) AND image_url IS NOT NULL",
                card_ids,
            )
        else:
            half = n // 2
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

    logger.info("Fetching %d card images...", len(rows))
    results: list[tuple[int, bytes]] = []
    sem = asyncio.Semaphore(16)

    async def fetch_one(session, row):
        async with sem:
            try:
                async with session.get(row["image_url"], timeout=aiohttp.ClientTimeout(total=20)) as resp:
                    if resp.status == 200:
                        return row["id"], await resp.read()
            except Exception as e:
                logger.warning("Failed to fetch card %d: %s", row["id"], e)
            return row["id"], None

    async with aiohttp.ClientSession() as session:
        tasks = [fetch_one(session, row) for row in rows]
        for coro in asyncio.as_completed(tasks):
            card_id, data = await coro
            if data:
                results.append((card_id, data))

    logger.info("Successfully fetched %d / %d images", len(results), len(rows))
    return results


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------

def cosine_sim(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Row-wise cosine similarity between two (N, 512) arrays."""
    return np.einsum("ij,ij->i", a, b)  # both are already L2-normalized


def top1_agreement(ref: np.ndarray, cand: np.ndarray, k: int = 100) -> float:
    """For a random subset of query vectors, check if top-1 NN in cand matches top-1 NN in ref.

    Uses the full ref matrix as the index — so the query set and index set overlap,
    but we exclude self-matches (distance to self = 0) by zeroing the diagonal.
    """
    n = ref.shape[0]
    subset = min(k, n)
    idx = np.random.choice(n, subset, replace=False)

    # For each query in subset, find NN in the full matrix (excluding self)
    sim_ref  = ref[idx] @ ref.T   # (subset, n)
    sim_cand = cand[idx] @ cand.T

    # Mask self-matches
    for qi, ri in enumerate(idx):
        sim_ref[qi, ri]  = -1.0
        sim_cand[qi, ri] = -1.0

    nn_ref  = np.argmax(sim_ref, axis=1)
    nn_cand = np.argmax(sim_cand, axis=1)
    return float(np.mean(nn_ref == nn_cand))


def report(ref_vecs: np.ndarray, cand_vecs: np.ndarray) -> dict:
    sims = cosine_sim(ref_vecs, cand_vecs)
    drifts = 1.0 - sims  # cosine drift (0 = identical)
    nn_agree = top1_agreement(ref_vecs, cand_vecs)

    result = {
        "n": len(ref_vecs),
        "mean_sim":    float(np.mean(sims)),
        "min_sim":     float(np.min(sims)),
        "p1_sim":      float(np.percentile(sims, 1)),
        "mean_drift":  float(np.mean(drifts)),
        "p99_drift":   float(np.percentile(drifts, 99)),
        "max_drift":   float(np.max(drifts)),
        "nn_agreement": nn_agree,
        "pass_mean":   float(np.mean(drifts)) < PASS_MEAN_DRIFT,
        "pass_p99":    float(np.percentile(drifts, 99)) < PASS_P99_DRIFT,
        "pass_nn":     nn_agree >= PASS_NN_AGREEMENT,
    }
    result["overall_pass"] = result["pass_mean"] and result["pass_p99"] and result["pass_nn"]
    return result


def print_report(r: dict):
    print("\n" + "=" * 60)
    print("PARITY HARNESS RESULTS")
    print("=" * 60)
    print(f"  Samples:         {r['n']}")
    print(f"  Mean cosine sim: {r['mean_sim']:.4f}  (1.0 = identical)")
    print(f"  P1 cosine sim:   {r['p1_sim']:.4f}")
    print(f"  Min cosine sim:  {r['min_sim']:.4f}")
    print(f"  Mean drift:      {r['mean_drift']:.4f}  threshold < {PASS_MEAN_DRIFT}  {'✓ PASS' if r['pass_mean'] else '✗ FAIL'}")
    print(f"  P99 drift:       {r['p99_drift']:.4f}  threshold < {PASS_P99_DRIFT}   {'✓ PASS' if r['pass_p99'] else '✗ FAIL'}")
    print(f"  NN agreement:    {r['nn_agreement']:.4f}  threshold >= {PASS_NN_AGREEMENT} {'✓ PASS' if r['pass_nn'] else '✗ FAIL'}")
    print("-" * 60)
    verdict = "✓ PASS — safe to proceed with mobile conversion" if r["overall_pass"] else "✗ FAIL — embedding drift too high; try float16 instead of int8"
    print(f"  Overall:         {verdict}")
    print("=" * 60 + "\n")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def main(args):
    db_url = args.db_url

    # Load reference embeddings
    if args.load_reference:
        logger.info("Loading reference embeddings from %s", args.load_reference)
        data = np.load(args.load_reference)
        card_ids = data["card_ids"].tolist()
        ref_vecs = data["embeddings"]
        image_bytes_map: dict[int, bytes] = {}

        if args.candidate is None:
            logger.info("No candidate specified — reference loaded. Use --candidate to compare.")
            print(f"\nLoaded {len(ref_vecs)} reference embeddings from {args.load_reference}")
            return

        # Re-fetch the same card IDs for candidate embedding
        logger.info("Re-fetching %d specific card images for candidate embedding...", len(card_ids))
        pairs = await fetch_sample_images(db_url, len(card_ids), card_ids=card_ids)
        image_bytes_map = {cid: img for cid, img in pairs}
        # Keep only cards whose images we successfully downloaded
        keep_mask = np.array([cid in image_bytes_map for cid in card_ids])
        card_ids = [cid for cid, keep in zip(card_ids, keep_mask) if keep]
        ref_vecs = ref_vecs[keep_mask]
        image_bytes_list = [image_bytes_map[cid] for cid in card_ids]
    else:
        # Fresh fetch
        pairs = await fetch_sample_images(db_url, args.samples)
        if not pairs:
            logger.error("No images fetched — check DB connection and image URLs")
            sys.exit(1)
        card_ids = [cid for cid, _ in pairs]
        image_bytes_list = [img for _, img in pairs]

        logger.info("Computing reference embeddings (PyTorch, %d images)...", len(image_bytes_list))
        ref_vecs = embed_reference(image_bytes_list)
        logger.info("Reference embeddings: shape=%s dtype=%s", ref_vecs.shape, ref_vecs.dtype)

    # Export reference if requested
    if args.export_reference:
        np.savez_compressed(args.export_reference, card_ids=card_ids, embeddings=ref_vecs)
        logger.info("Saved reference embeddings to %s", args.export_reference)
        if args.candidate is None:
            return

    # Embed with candidate
    if args.candidate is None:
        logger.info("No --candidate provided. Use --export-reference to save refs for later comparison.")
        return

    logger.info("Computing candidate embeddings (%s, %d images)...", args.format, len(image_bytes_list))
    if args.format == "onnx":
        cand_vecs = embed_onnx(image_bytes_list, args.candidate)
    elif args.format == "tflite":
        cand_vecs = embed_tflite(image_bytes_list, args.candidate)
    elif args.format == "coreml":
        cand_vecs = embed_coreml(image_bytes_list, args.candidate)
    else:
        logger.error("Unknown format: %s", args.format)
        sys.exit(1)

    logger.info("Candidate embeddings: shape=%s dtype=%s", cand_vecs.shape, cand_vecs.dtype)

    r = report(ref_vecs, cand_vecs)
    print_report(r)

    if args.save_report:
        import json
        with open(args.save_report, "w") as f:
            json.dump(r, f, indent=2)
        logger.info("Report saved to %s", args.save_report)

    sys.exit(0 if r["overall_pass"] else 1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Parity harness for on-device CLIP conversion")
    parser.add_argument("--candidate", default=None, help="Path to converted model to test")
    parser.add_argument("--format", choices=["onnx", "tflite", "coreml"], default="onnx",
                        help="Format of the candidate model")
    parser.add_argument("--samples", type=int, default=500,
                        help="Number of card images to sample (default 500)")
    parser.add_argument("--db-url", default=os.getenv("DATABASE_URL", "postgresql://tcg:tcgpass@localhost:5432/tcgdb"))
    parser.add_argument("--export-reference", default=None, metavar="PATH",
                        help="Save reference embeddings to .npz file (for later reuse)")
    parser.add_argument("--load-reference", default=None, metavar="PATH",
                        help="Load previously saved reference embeddings from .npz file")
    parser.add_argument("--save-report", default=None, metavar="PATH",
                        help="Save JSON report to file")
    args = parser.parse_args()
    asyncio.run(main(args))
