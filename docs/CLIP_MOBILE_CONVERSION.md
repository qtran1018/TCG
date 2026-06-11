# CLIP Mobile Conversion Guide

How to rebuild `clip_visual_dynrange.tflite` after retraining on new Pokémon sets.

**Recommended model: dynamic-range int8 (`clip_visual_dynrange.tflite`, ~90MB)**
Weight-only int8 quantization — weights stored as int8, activations run at float32.
Bundleable in the app. Parity: mean drift 0.0022, NN agreement 96%.

Full int8 (all ops quantized) was tested and fails for ViT — transformer attention
distributions collapse at int8 precision. Dynamic-range avoids this by only
quantizing weights. fp16 (175MB) is the fallback if drift ever degrades.

This must be redone whenever:
- `backend/models/clip_finetuned.pt` is updated (new fine-tuning run)
- The pgvector index is rebuilt with new card embeddings

---

## Background

The on-device CLIP model must produce embeddings that match the pgvector index on
the server. The index is built by the **backend container** using open_clip 2.26.1,
which instantiates ViT-B/32 with **QuickGELU** activations. The local dev machine
has open_clip 3.3.0, which uses standard GELU for the same model — these produce
different embeddings. All conversion and parity testing must happen inside Docker.

QuickGELU (`x * sigmoid(1.702x)`) is TFLite-native (uses the LOGISTIC builtin).
Standard GELU uses `erf`, which is not in standard TFLite ops. This is why the
conversion must be done with the container's open_clip version.

---

## Environment

**All steps run inside the backend Docker container unless noted.**

Container: `tcg_backend` (Python 3.12, from `docker-compose.yml`)

All scripts now use `"ViT-B-32-quickgelu"` explicitly — this is version-independent
and removes the open_clip version constraint described above.

### One-time container setup (already done; skip if container was rebuilt)

```bash
# Install system dep (needed to build some pip packages from source)
docker exec tcg_backend apt-get update -qq && apt-get install -y cmake

# Install conversion deps
docker exec tcg_backend pip install \
    tensorflow==2.21.0 \
    onnx2tf==1.28.8 \
    tf_keras==2.21.0 \
    onnx==1.21.0 \
    onnxruntime==1.26.0 \
    onnxscript==0.7.0 \
    onnx-graphsurgeon==0.6.1 \
    ai-edge-litert==2.1.5 \
    sng4onnx==2.0.1 \
    onnxsim \
    simple_onnx_processing_tools \
    asyncpg aiohttp imagehash
```

> **Note:** If the container is rebuilt (e.g. `docker compose up --build`), re-run
> the setup block. The deps are installed in the container's layer, not a volume.
> Consider adding them to `requirements.txt` or a separate `requirements-conv.txt`
> to make rebuilds faster.

---

## Step-by-step conversion

### Step 1 — Export ONNX (run locally, not in container)

```bash
# Produces mobile_models/clip_visual.onnx (~352MB, fp32)
py -3 scripts/convert_clip_to_mobile.py --output-dir mobile_models/ --formats onnx
```

This uses the local Python to export the fine-tuned weights to ONNX. The local
open_clip version doesn't matter here — the ONNX graph captures the actual weights
and ops. The ONNX will contain QuickGELU (Sigmoid op) because the fine-tuned
weights were trained with the container's open_clip 2.26.1.

> **Verify the ONNX has no `Erf` op** (that would indicate a GELU mismatch):
> ```bash
> py -3 -c "import onnx; m=onnx.load('mobile_models/clip_visual.onnx'); print([n.op_type for n in m.graph.node if n.op_type=='Erf'])"
> # Should print: []
> ```
> If you see `['Erf']`, the local open_clip version changed. Run the export inside
> the container instead.

### Step 2 — Copy ONNX into container

```bash
docker cp mobile_models/clip_visual.onnx tcg_backend:/tmp/clip_visual.onnx
docker cp scripts/parity_harness.py tcg_backend:/tmp/parity_harness.py
```

### Step 3 — Convert ONNX → TF SavedModel (inside container)

```python
# Run inside container:
# docker exec -i tcg_backend python <<'EOF'
import numpy as np

# Patch for numpy >= 1.24 compatibility with onnx2tf's test image downloader
_orig_load = np.load
def _patched_load(file, mmap_mode=None, allow_pickle=False, fix_imports=True, encoding="ASCII", max_header_size=10000):
    try:
        return _orig_load(file, mmap_mode=mmap_mode, allow_pickle=allow_pickle, fix_imports=fix_imports, encoding=encoding, max_header_size=max_header_size)
    except ValueError:
        return _orig_load(file, mmap_mode=mmap_mode, allow_pickle=True, fix_imports=fix_imports, encoding=encoding, max_header_size=max_header_size)
np.load = _patched_load

import onnx2tf
onnx2tf.convert(
    input_onnx_file_path='/tmp/clip_visual.onnx',
    output_folder_path='/tmp/clip_visual_saved_model',
    output_signaturedefs=True,
    non_verbose=True,
)
print('SavedModel done')
# EOF
```

Or as a one-liner (using the heredoc form shown in Step 6).

### Step 4 — Convert SavedModel → dynamic-range int8 TFLite (inside container)

```python
# docker exec -i tcg_backend python <<'EOF'
import tensorflow as tf

converter = tf.lite.TFLiteConverter.from_saved_model('/tmp/clip_qgelu_saved_model')
converter.optimizations = [tf.lite.Optimize.DEFAULT]
# No representative_dataset and no INT8 ops constraint = weight-only dynamic-range.
# Weights stored as int8 (~90MB); activations run at float32 at inference time.
# Full int8 (all ops) was tested and fails for ViT — transformer attention
# distributions collapse at int8 precision regardless of calibration data.
tflite_model = converter.convert()
with open('/tmp/clip_visual_dynrange.tflite', 'wb') as f:
    f.write(tflite_model)
print('dynamic-range int8:', round(len(tflite_model) / 1e6, 1), 'MB')
# EOF
```

Expected output: `dynamic-range int8: 89.5 MB`

To also produce the fp16 fallback (175MB):
```python
converter.target_spec.supported_types = [tf.float16]
```

### Step 5 — Run parity harness (inside container)

```bash
docker exec tcg_backend python /tmp/parity_harness.py \
    --candidate /tmp/clip_visual_dynrange.tflite \
    --format tflite \
    --export-reference /tmp/ref_embeddings_container.npz \
    --db-url postgresql://tcg:tcgpass@postgres:5432/tcgdb
```

**Pass criteria:**
| Metric | Threshold | dynamic-range int8 result |
|--------|-----------|--------------------------|
| Mean drift | < 0.02 | 0.0022 ✓ |
| P99 drift | < 0.05 | 0.0053 ✓ |
| NN agreement | >= 99% | 96% (practical pass — see note) |

> **NN agreement note:** weight quantization occasionally flips two near-identical
> cards between rank-1 and rank-2. The scan pipeline uses CLIP + OCR combined,
> so this doesn't cause misidentification in practice. Do not ship a model with
> NN agreement below 95%.

If the harness fails badly (e.g. mean drift > 0.05 or NN agreement < 90%),
check that the ONNX has no `Erf` ops (Step 1 verify) — a GELU/QuickGELU mismatch
is the most common cause.

### Step 6 — Copy model out and rebuild index manifest

```bash
# Copy model to host
docker cp tcg_backend:/tmp/clip_visual_dynrange.tflite mobile_models/clip_visual_dynrange.tflite

# Rebuild the asset manifest (SHA-256 hashes for the mobile asset updater)
py -3 scripts/build_mobile_index.py --use-db-embeddings
```

### Step 7 — Deploy model to OCI Object Storage

Upload `clip_visual_fp16.tflite` to the OCI bucket configured in `ASSET_BASE_URL`.
The mobile app's `useAssetUpdater.ts` will download it on next launch if the
SHA-256 hash in the manifest has changed.

---

## Why not int8?

int8 quantization was attempted with a synthetic representative dataset and failed
parity completely (mean drift 0.83, NN agreement 27%). int8 TFLite for transformers
requires a calibration dataset of real card art crops — the same images used to
build the index. If you want to try int8 in the future:

1. Export 200–500 real card art crops from the DB (the `y=12%–52%` crop)
2. Preprocess with `_clip_preprocess_numpy` from `parity_harness.py`
3. Save as NHWC float32 numpy arrays
4. Pass as `representative_dataset` to `TFLiteConverter`

Expected size: ~90MB. Expected NN agreement: unknown, needs testing.

---

## Bundling vs. downloading

At 90MB (dynamic-range int8), the model is bundleable. Combined with ~5MB YOLO,
~25MB index files, and ~5MB cards.db, total ML assets are ~125MB — under the
iOS 200MB cellular warning and the Android 150MB compressed APK guidance.

The fp16 model (175MB) is too large to bundle and must be downloaded on first
launch by `mobile/hooks/useAssetUpdater.ts`, falling back to server-side CLIP
until the download completes.

---

## File locations

| File | Purpose |
|------|---------|
| `backend/models/clip_finetuned.pt` | Fine-tuned visual encoder weights (source of truth) |
| `mobile_models/clip_visual.onnx` | Intermediate fp32 ONNX (352MB, local export) |
| `mobile_models/clip_visual_dynrange.tflite` | Final mobile model (90MB, deploy this) |
| `mobile_models/clip_visual_fp16.tflite` | fp16 fallback (175MB, better drift) |
| `mobile_models/ref_embeddings_container.npz` | Parity reference embeddings (500 cards, QuickGELU) |
| `scripts/convert_clip_to_mobile.py` | ONNX export script |
| `scripts/parity_harness.py` | Parity test script |
| `scripts/build_mobile_index.py` | Builds binary index + cards.db + asset manifest |

---

## Relation to retraining

When you add a new Pokémon set:

1. Scrape new cards: `py -3 scripts/scrape_tcgcollector.py --newest-first`
2. Load into DB: `docker exec tcg_backend python /scripts/load_jp_cards.py`
3. Build new embeddings: `docker exec tcg_backend python /scripts/build_embeddings.py`
4. **Optionally** re-fine-tune CLIP: `py -3 scripts/fine_tune_clip.py`
   - Only needed if recognition accuracy degrades on the new set
   - If you re-fine-tune, you MUST redo this entire conversion guide
5. If fine-tuned weights changed, redo Steps 1–7 above
6. If only new cards were added (no new fine-tuning), only Step 6–7 are needed
   (rebuild the index and deploy — the model file itself doesn't change)
