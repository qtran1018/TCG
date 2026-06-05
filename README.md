# TCG Card Scanner

A mobile app that identifies Pokémon (and One Piece) trading cards by pointing your camera at them, then fetches live market prices and sales data from PriceCharting.com.

Two scanning modes: **Multi Scan** — photograph a spread of cards at once and get all results in a single pass; **Live Scan** — continuous real-time scanning that adds cards to a running session list as you flip through them.

---

## Stack

| Layer | Technology |
|---|---|
| Mobile | Expo (React Native), TypeScript |
| Backend | FastAPI (Python 3.12) |
| Database | PostgreSQL + pgvector |
| Cache | Redis |
| Image AI | CLIP ViT-B/32 (fine-tuned) |
| Card detection | YOLO11n — backend PyTorch + on-device TFLite |
| OCR | ML Kit (on-device, Google) |
| Prices | PriceCharting.com (live scrape, httpx) |
| State management | Zustand |
| Navigation | Expo Router |

---

## How Card Recognition Works

The app uses two independent signals to identify a card, then combines them.

### Signal 1 — Image AI (CLIP)

CLIP (Contrastive Language-Image Pretraining, OpenAI) encodes images into 512-dimensional vectors. Cards with similar art produce vectors close together in that space.

The backend runs a **fine-tuned** CLIP ViT-B/32 trained on (official card art crop, augmented simulated photo) pairs — closing the domain gap between clean digital art and real photos of physical cards taken under varying lighting and angles.

**Flow:**
1. The card art region is isolated (top 12–52% of card height — skips name text and stats)
2. CLIP encodes it to a 512-dim L2-normalized vector
3. pgvector runs an **IVFFlat approximate nearest-neighbor search** (`probes=20, LIMIT 10`) across ~47k stored embeddings
4. A **perceptual hash (phash)** re-ranks candidates using Hamming distance — catches holofoil and lighting variation that confuse CLIP
5. Scores below 0.50 discarded; above 0.65 is a confident match

On GPU, model and input are cast to fp16 (~1.8× faster, ~half VRAM on Ampere); output cast back to float32 for pgvector.

### Signal 2 — OCR

ML Kit reads text off the card on-device. The backend parses the raw text to extract a name and card number.

**Pokémon name extraction:**
1. Find the HP line (`"HP 120"`) as a spatial anchor — name is always above it
2. Scan candidate lines; reject all-caps, digit-containing, punctuation, known non-name prefixes (BASIC, Stage 1, Weakness, etc.)
3. Final gate: candidate must match a known Pokémon name from an internal dictionary

**Trainer/Supporter/Item/Stadium:** find the type keyword line, take the name 1–2 lines above.

**Japanese cards:** kana detected with a regex; a 1,028-entry kana→English dictionary translates names for the DB search. JP trainer cards search `name_ja` directly.

**Card number:** extracted by spatially filtering OCR blocks from the bottom 8% of the card image — left corner first (most sets), right corner fallback.

### Combining Both — Reciprocal Rank Fusion

In Combined mode, both signals produce ranked candidate lists. **RRF** merges them: `score = 1 / (rank + 60)`, summed across signals. Cards ranked highly by both float to the top. Card number matches receive a bonus weight on top.

---

## Scan Endpoint — `POST /api/v1/scan`

The central endpoint returns results as **NDJSON** (newline-delimited JSON) — each line is a complete JSON object for one card, streamed as it completes. The mobile app displays the first result while the backend is still processing remaining cards.

**Input:** full image (base64) + bounding box coordinates for multi-scan; or just the image for live scan (backend auto-detects via YOLO).

**Inside:** image search and OCR search run concurrently per crop with `asyncio.gather`; results yielded in completion order via `asyncio.as_completed`.

---

## Multi-Card Scan Pipeline

1. **Resize** — photo resized to 2400px wide, JPEG 0.95 (~500ms, visually lossless)
2. **Full-image OCR** — ML Kit runs a **single** Japanese-language pass on the entire image, producing text blocks with coordinates. One pass for all cards — not one per crop. Saves ~6s on 12 cards.
3. **On-device YOLO** — TFLite model detects bounding boxes (~150ms via Snapdragon NNAPI). Falls back to backend `/detect`, then to OCR clustering.
4. **Spatial OCR filter** — for each YOLO crop, the full-image OCR blocks are filtered by coordinates. Zero additional ML Kit calls.
5. **Card number extraction** — second OCR pass (Latin, bottom 8% of each card) runs in parallel to capture numbers like `047/165`
6. **Send to backend** — full JPEG + bounding boxes; backend crops with PIL (~5ms/crop, faster than JS re-encoding)
7. **Stream results** — NDJSON arrives per card in completion order

**Benchmark:** first card result in **3.12s** on Samsung S22+ (Snapdragon 8 Gen 1), 12 cards.

> `Promise.all([ML Kit OCR, NNAPI YOLO])` causes a native bridge resource conflict on Android — must run sequentially.

---

## Live Scan Pipeline

A continuous loop for single-card identification:

1. `takeSnapshot({ quality: 80 })` — reads from camera preview stream (no shutter, no delay)
2. Resize to 640px, encode to base64
3. `POST /api/v1/scan` — backend YOLO auto-detects the card, crops it, runs CLIP in one pass
4. **Consecutive-frame confirmation gate** — top match must be the same card on two consecutive scans before it's added. Filters phantom matches during physical card transitions.
5. **Cooldown dedup** — same card ID suppressed for 30 seconds
6. Background price fetch — doesn't block the scan loop
7. Loop repeats immediately (~700–900ms cycle)

---

## Card Detection — YOLO

### On-device (TFLite, mobile)

`mobile/assets/models/card_detector.tflite` — 5.1MB, float16

- Fine-tuned YOLO11n on 2,823 images (real + synthetic)
- Input: 640×640 RGB float32 → confidence filter (0.25) → greedy NMS → boxes
- Delegates: **NNAPI** on Android (Hexagon DSP on Snapdragon = 2–4×), **Core ML** on iOS, CPU fallback
- Export chain: PyTorch → ONNX → TF SavedModel (`onnx2tf`) → float16 TFLite
- Library: `react-native-fast-tflite` **v2.0.0** — v3 silently rejects the onnx2tf op set

### Backend (PyTorch, server)

`backend/models/card_detector.pt` — full PyTorch model. Primary detector in live scan; fallback for multi-scan if on-device fails. fp16 on CUDA (~1.5× faster).

---

## CLIP Fine-Tuning

**Training setup:**
- Base: CLIP ViT-B/32, OpenAI pretrained weights
- Only the visual encoder fine-tuned (87.8M params); text encoder frozen
- Pairs: official art crop (anchor) + augmented simulated photo (positive)
- Augmentation: paste card on background texture → perspective warp → color jitter → Gaussian blur → JPEG compression → art-region crop
- 20,741 EN cards × 4 augmented pairs = **82,964 pairs/epoch**
- Loss: InfoNCE contrastive, temperature=0.07; AdamW lr=1e-5, cosine LR schedule
- Hardware: RTX 3080, ~77 min/epoch, ~13 hours total

**Epoch log:**

| Epoch | Loss | LR | Duration |
|---|---|---|---|
| 1 | 0.0255 | 9.76e-06 | 78 min |
| 2 | 0.0098 | 9.05e-06 | 77 min |
| 3 | 0.0099 | 7.96e-06 | 78 min |
| 4 | 0.0095 | 6.58e-06 | 78 min |
| 5 | 0.0088 | 5.05e-06 | 76 min |
| 6 | 0.0080 | 3.52e-06 | 77 min |
| **7 ★ best** | **0.0077** | 2.14e-06 | 77 min |
| 8 | 0.0081 | 1.05e-06 | 77 min |
| 9 | 0.0083 | 3.42e-07 | 79 min |
| 10 | 0.0081 | 1.00e-07 | 82 min |

Best epoch (7) saved to `backend/models/clip_finetuned.pt`. Auto-loaded at startup if present.

---

## YOLO Retraining (v2)

| Metric | v1 (CPU, 50 epochs) | v2 (GPU, 30 epochs) |
|---|---|---|
| mAP50 | 0.992 | **0.993** |
| mAP50-95 | 0.904 | **0.964** (+6.6%) |
| Precision | 0.977 | 0.977 |
| Recall | 0.985 | 0.980 |

v2 trained on a merged dataset of 2,823 images (1,225 real + 2,000 synthetic). Synthetic images generated by `scripts/generate_synthetic_yolo.py` — cards pasted onto background textures at random scale/rotation with glass-effect overlay at 13% frequency. Fine-tuned from v1 checkpoint (not base YOLO weights) on RTX 3080, 30 epochs, ~1.5 hours.

---

## Card Database

~47,500 cards across two languages:

| Source | Count | Method |
|---|---|---|
| pokemontcg.io (EN) | 20,237 | API |
| TCGCollector.com (JP) | 27,255 | Scraped |

Every card has a 512-dim CLIP embedding stored in pgvector. Two partial IVFFlat indices (one per language) ensure each query only scans same-language clusters. 50 cards are unembeddable due to broken CDN image URLs (older McDonald's promos).

---

## Prices

All prices are scraped live from **PriceCharting.com** — there is no price database. The scraper (`httpx.AsyncClient`, brotli decompression, 0.5s rate limit) takes ~1s per card.

The scraper parses:
- Loose / graded price cells, handling "best offer accepted" spans
- Price history embedded as JavaScript: `VGPC.chart_data = {...}` — extracted with regex, parsed as JSON
- Recent sales from eBay, TCGPlayer, Mercari, and Yahoo Japan tables

Results cached in Redis for 24 hours. Batch pricing streams back as NDJSON — cache hits appear immediately, scrape misses trickle in as the rate limiter allows.

**Card variants:** Normal / 1st Edition / Shadowless / Poké Ball / Master Ball — each maps to a different PriceCharting URL slug.

---

## Streaming on Mobile

React Native's `fetch()` doesn't support progressive response body streaming on iOS. Both `/scan` and `/cards/prices/stream` are consumed via **manual XHR with `onprogress`** — accumulates response text, splits on newlines, fires a callback per complete JSON line as it arrives.

---

## Camera Session Management

Expo Router keeps all tab screens mounted simultaneously. Both camera screens (Multi Scan and Live Scan) were always active regardless of the focused tab — causing `session/invalid-output-configuration` errors on Android from two camera sessions competing for the same hardware.

**Fix:** each camera screen tracks tab focus with `useFocusEffect` and passes `isActive={isFocused}` to Vision Camera. Sessions are mutually exclusive. Additionally, `photo={true}` was removed from the Live Scan camera — that prop adds an `ImageCapture` output stream (needed for `takePhoto()`), but Live Scan only uses `takeSnapshot()` which reads from the preview stream. The extra output caused session configuration failures on some Android camera HALs.

---

## Known Limitations

| Issue | Notes |
|---|---|
| Older JP sets price 404 on PriceCharting | Pre-2003 JP sets use Pokédex number as card identifier, not set position. Would require a per-card lookup table to fix. |
| JP Abra and kana-heavy cards not detected | OCR confidence < 3 and image sim < 0.50 floor → 0 candidates. Fundamental OCR limitation on heavily stylized text. |
| Holofoil image AI unreliable | Reflective surfaces produce visual appearances impossible to match against clean digital art. Use OCR or Combined mode. |
| Items with digits in name (Pokégear 3.0) | Digit gate in `_find_trainer_name` rejects them. Rare edge case, low priority. |
| INT8 TFLite quantization slower than float16 | TFLiteConverter inserts quantize/dequantize boundary nodes for YOLO-specific ops, net slower. Use onnx2tf's quantization pipeline if re-attempting. |
| `Promise.all([OCR, YOLO])` crashes on Android | Native bridge resource conflict between ML Kit and TFLite. Sequential only. |
| Per-grade price trend charts unavailable | PriceCharting's embedded `VGPC.chart_data` JS only contains combined graded series — per-grade series are loaded via AJAX after page load, inaccessible from a single scrape. |

---

## Future Updates

### Self-Hosted Backend (Oracle Cloud Free Tier)

The backend is currently developed and run locally on a machine with an NVIDIA RTX 3080. The plan is to migrate it to an Oracle Cloud Always Free ARM64 instance (Ampere A1, up to 4 OCPUs / 24GB RAM) that already hosts other personal projects.

**What changes:**

The backend code already handles CPU gracefully — `card_embedder.py` auto-detects CUDA availability and falls back to fp32 CPU if no GPU is present. The main deployment changes are swapping the PyTorch pip install to the CPU-only wheel (~250MB vs ~2.5GB) and rebuilding the Docker image for `linux/arm64`.

**Performance trade-off:**

Moving CLIP and YOLO inference from an RTX 3080 to ARM64 CPU is the primary cost. The RTX 3080 runs CLIP at ~20ms per crop in fp16; Oracle Ampere A1 cores will run it at roughly 200–500ms per crop in fp32. YOLO detection similarly slows from ~10ms to ~100–300ms. End-to-end scan latency is expected to increase from ~3s to ~5–8s for a typical multi-card scan — acceptable for a portfolio demo at low traffic, but noticeably slower than the local GPU experience.

**This is a deliberate trade-off** — the Oracle free tier is permanent and costs nothing, making it suitable for portfolio hosting until a GPU-enabled cloud instance becomes worth funding.

**Potential optimization — ONNX Runtime:**

A further improvement is converting the backend models from PyTorch to ONNX and running them with ONNX Runtime instead of PyTorch. ONNX Runtime on ARM64 is particularly strong — it ships with ARM-specific execution providers (XNNPACK, Arm Compute Library) that exploit NEON SIMD instructions on Ampere cores more aggressively than PyTorch's CPU backend. On ARM64 the gap is wider than on x86, realistically **30–50% faster inference** per crop, which would bring scan latency closer to ~3–5s.

YOLO conversion is a one-liner via Ultralytics and is already part of the TFLite export chain — the ONNX file is a byproduct that could be used directly on the backend. CLIP requires a manual `torch.onnx.export()` call on the visual encoder after loading fine-tuned weights, then swapping `open-clip-torch` inference for an `onnxruntime` session. The main trade-off is operational: every CLIP retrain requires a re-export step before deploying, and stale ONNX weights fail silently. The recommendation is to do the YOLO conversion first (low effort, no maintenance cost) and evaluate CLIP conversion after measuring real CPU latency on the Oracle instance.

---

## Third-Party Attributions

| Component | License | Notes |
|---|---|---|
| CLIP (`open-clip-torch`) | MIT | Fine-tuned visual encoder; original weights from OpenAI |
| YOLO11n (`ultralytics`) | AGPL-3.0 | Fine-tuned on custom card dataset |
| `react-native-fast-tflite` | MIT | On-device TFLite inference |
| `react-native-vision-camera` | MIT | Camera preview and snapshot |
| `@react-native-ml-kit/text-recognition` | Apache 2.0 | On-device OCR |
| pgvector | MIT | Vector similarity search for PostgreSQL |
| TCG Detector dataset (Roboflow) | CC BY 4.0 | Contributed to YOLO training set |
| Aaron's Raw Photos dataset (Roboflow) | CC BY 4.0 | Contributed to YOLO training set |
| pokemontcg.io | — | EN card metadata and images (free API) |
| TCGCollector.com | — | JP card metadata and images (scraped) |
| PriceCharting.com | — | Market prices and sales history (scraped) |
| frankfurter.dev | MIT | USD/JPY exchange rates |

Card images displayed in the app are sourced from pokemontcg.io (EN) and TCGCollector.com (JP) and remain the property of their respective rights holders (The Pokémon Company, Nintendo, Game Freak).
