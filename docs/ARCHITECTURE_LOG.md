# Architecture Decision Log

A chronological record of major technical decisions, for portfolio and reference purposes.

---

### v1 — Single-card OCR scanner

- Camera captures photo → ML Kit OCR on full image → text filtered to card zone overlay → backend extracts name + card number → pokemontcg.io search → price display
- Limitation: background text (keyboards, shelf labels) bled into OCR zone; coordinate mapping across devices was fragile

### v2 — Multi-card pipeline with OCR clustering

- Switched from single-card overlay to full-image multi-card detection
- `detectCardRegions` clusters OCR text blocks by spatial proximity and aspect ratio to infer card boundaries
- Each detected region cropped, re-OCR'd, confidence-gated, then batch-searched
- Limitation: OCR clustering fails when cards are far apart, have minimal text visible, or are holofoil (no text contrast)

### v3 — OpenCV contour detection for card regions

- Added `POST /api/v1/detect` endpoint: sends full image to backend, returns bounding boxes
- Backend uses adaptive threshold + contour detection to find card-shaped rectangles
- Mobile falls back to OCR clustering if backend detect fails or returns no boxes
- Limitation: OpenCV fails on holofoil surfaces, colorful desk mats, touching/overlapping cards

### v4 — Image embedding search (EfficientNet-B0 + PCA)

- Added visual card identification as alternative to OCR
- EfficientNet-B0 (via `timm`) extracts 1280-dim features, PCA reduces to 256-dim
- Embeddings stored in pgvector, nearest-neighbor search via IVFFlat index
- Added `POST /api/v1/match-image` endpoint and Image AI scan mode in mobile
- Limitation: EfficientNet not trained on card images — similarity scores 0.45–0.58, practically unusable

### v5 — CLIP ViT-B/32 replaces EfficientNet

- Migrated image embedder from EfficientNet-B0 + PCA (256-dim) to CLIP ViT-B/32 (512-dim)
- Added art-region crop (`y=10%–56%`) to focus embeddings on Pokémon illustration, not card border/text
- Scores improved to 0.78–0.86 for visually distinctive Pokémon
- Removed PCA entirely — CLIP embeddings are already compact and L2-normalized
- Limitation: domain gap between phone photos of physical cards and clean digital art; CLIP matches visual category (small round green creature) not specific card identity — confuses similar-looking Pokémon (Lotad vs Seedot)

### v6 — Combined mode with Reciprocal Rank Fusion

- Added `combined` scan mode: OCR and image search run in parallel, results merged with RRF
- RRF weights: OCR=2, image=1 (`score = weight / (rank + 60)`)
- Image gate: image results excluded when OCR found a result and image similarity < 0.83 (weak image signal is worse than no image signal when OCR already answered)
- Card number promotion: after RRF merge, candidates matching OCR-extracted number moved to front
- Card number region augmentation: full-image OCR blocks spatially filtered to bottom 22% of each crop and appended to crop OCR — zero extra OCR calls, improves number extraction
- Fuzzy name fallback: `pg_trgm similarity() > 0.35` when exact ilike returns nothing (handles OCR misreads like "Lotacl" → Lotad)

### v7 — YOLO11n card detection (fine-tuned)

- Fine-tuned YOLO11n on 1,688-image dataset assembled from 3 sources: own photos (221), TCG Detector Roboflow dataset (576), Aaron's Raw Photos Roboflow dataset (891)
- Built data pipeline scripts to convert COCO format and merge datasets with mixed label formats (bbox, OBB, polygon) into single-class YOLO format
- Training: 50 epochs, CPU only (AMD Ryzen 5 5600X), 3.68 hours
- Result: mAP50=0.992, mAP50-95=0.904, Precision=0.977, Recall=0.985
- Replaces OpenCV contour detection; OpenCV remains as fallback if model file absent
- Deployed to `backend/models/card_detector.pt` (5.5MB)

### v8 — Unified /scan endpoint + progressive streaming

- Merged three separate API calls (`/detect` → `/search/batch` + `/match-image`) into a single `POST /api/v1/scan` endpoint
- Backend batches all CLIP embeddings in one forward pass, then runs all pgvector and OCR searches in parallel (`asyncio.gather`), eliminating sequential wait time
- Results streamed as NDJSON: mobile receives and renders each card as it completes rather than waiting for all crops
- Mobile uses XHR `onprogress` to parse partial NDJSON; `appendMultiScanCard` updates the store card-by-card
- Attempted TFLite export of YOLO11n for on-device detection — model export not completed; `detectCardsWithYolo()` stub in place for future integration when `card_detector.tflite` is available

### v9 — CLIP ViT-B/32 synthetic augmentation fine-tuning ✅

- Fine-tuning CLIP visual encoder on (clean official art crop, augmented simulated phone photo) pairs to close the domain gap between training data and real phone photos of physical cards
- Augmentation pipeline: paste card onto random background texture → perspective warp → color jitter → gaussian blur → JPEG compression → art-region crop (`y=12%–52%`)
- 5 background textures: black cloth, black gray, gray white, gray, white linen (tablecloth photos in `assets/backgrounds/`)
- 20,741 card images × 4 augmented pairs = 82,964 pairs per epoch; 10 epochs planned
- Only visual encoder fine-tuned (87.8M params); text encoder frozen
- InfoNCE contrastive loss, temperature=0.07, AdamW lr=1e-5, cosine LR schedule
- Script: `scripts/fine_tune_clip.py`; output: `backend/models/clip_finetuned.pt`
- `card_embedder.py` auto-loads fine-tuned weights at startup if `backend/models/clip_finetuned.pt` exists
- `docker-compose.yml`: added `shm_size: 2gb` for backend container (required for PyTorch DataLoader workers), added `./assets/backgrounds:/backgrounds:ro` volume mount
- Training on RTX 3080 (GPU); ~6-9s/batch with 4 DataLoader workers, ~1.5hr/epoch, ~15hr total
- **Monitor training:** `docker exec -it tcg_backend tail -f /tmp/finetune.log`
- **After training:** run `python scripts/build_embeddings.py --dataset /en_cards --force` to re-embed all 20k cards with fine-tuned weights
- **Offline pair generation** (recommended for reproducibility and multi-game support):
  ```bash
  # 1. Generate pairs once per game (CPU, no GPU needed, saves to disk)
  python scripts/fine_tune_clip.py \
      --generate-pairs training/clip_pairs/pokemon \
      --dataset "/en_cards" --backgrounds "/backgrounds" --pairs-per-card 4
  # Saves: training/clip_pairs/pokemon/anchors/{i:06d}.jpg + positives/ + manifest.json

  # 2. Train from saved pairs (deterministic, reproducible)
  python scripts/fine_tune_clip.py \
      --pairs-dir training/clip_pairs/pokemon \
      --output backend/models/clip_finetuned.pt \
      --resume backend/models/clip_finetuned.pt \
      --epochs 10
  ```

  For a second game (e.g. One Piece): generate pairs to `training/clip_pairs/one_piece/`, then train resuming from the existing checkpoint so the model doesn't forget Pokémon.
- ✅ **Training complete** — 2026-05-18, ~13 hours total
- ✅ **Re-embedding complete** — 20,187 cards re-embedded with fine-tuned weights, IVFFlat index rebuilt, backend restarted and serving fine-tuned embeddings
- 50 unembeddable (McDonald's promos CDN 404), 63 embed_failed (same as before), 1 download_failed — no new failures

#### Epoch training log

| Epoch     | Loss       | LR       | Duration | Completed                                           |
| --------- | ---------- | -------- | -------- | --------------------------------------------------- |
| 1         | 0.0255     | 9.76e-06 | 78 min   | 2026-05-18 06:32 UTC                                |
| 2         | 0.0098     | 9.05e-06 | 77 min   | 2026-05-18 07:49 UTC                                |
| 3         | 0.0099     | 7.96e-06 | 78 min   | 2026-05-18 09:08 UTC                                |
| 4         | 0.0095     | 6.58e-06 | 78 min   | 2026-05-18 10:26 UTC                                |
| 5         | 0.0088     | 5.05e-06 | 76 min   | 2026-05-18 11:42 UTC                                |
| 6         | 0.0080     | 3.52e-06 | 77 min   | 2026-05-18 12:59 UTC                                |
| **7 ★**   | **0.0077** | 2.14e-06 | 77 min   | 2026-05-18 14:16 UTC                                |
| 8         | 0.0081     | 1.05e-06 | 77 min   | 2026-05-18 15:33 UTC                                |
| 9         | 0.0083     | 3.42e-07 | 79 min   | 2026-05-18 16:52 UTC                                |
| 10        | 0.0081     | 1.00e-07 | 82 min   | 2026-05-18 18:14 UTC                                |
| **Best**  | **0.0077** | —        | —        | **Epoch 7 — saved to `backend/models/clip_finetuned.pt`** |

### v10 — Project reorganization and dead code removal (2026-05-18)

- Moved `background-textures/` → `assets/backgrounds/`; updated `docker-compose.yml` volume mount accordingly
- Moved scraper logs to `logs/` (gitignored)
- Deleted dead files: `runs/`, `yolo11n.pt` (base model, training artifact), `pca.pkl`, `card_detector.onnx`, calibration `.npy` files, `TCGScanner.html`
- Removed `backend/app/api/v1/match_image.py` (`POST /api/v1/match-image` endpoint) — fully superseded by `/scan`
- Removed `batchMatchByImage()` from `mobile/services/api.ts` — was never called after v8
- Moved one-off scripts to `scripts/archive/`
- Expanded `.gitignore`: `assets/backgrounds/`, `logs/`, `*.npy`, `*.onnx`, `*.pkl`, `runs/`
- **Single-card scan mode disabled**: the "Scan Cards" button in `index.tsx` now always launches multi-card mode (`handleMultiCapture`). The single-card `handleCapture` path (overlay zone filtering, `useOCR` confidence gate) still exists in the file but has no UI entry point — multi-card supersedes it for all use cases

#### Single-card scan flow (historical reference — no UI entry point)

1. Camera captures photo
2. Image resized to 1200px wide; OCR run on full image
3. `filterBlocksToCardZone` maps scan overlay geometry through camera cover-scale transform to image coordinates, keeps only blocks within the card zone
4. OCR text scored by `cardConfidence.ts` — rejected if score < 3
5. Backend extracts hints (name, card number) and searches DB + pokemontcg.io
6. Results returned sorted by card number match; user selects card
7. PriceCharting scraped for prices, sales, trend graph (Redis cached)

### v11 — JP cards as first-class DB records ✅ (2026-05-20)

- Root-caused swap image bug: all swap candidates showing the same JP art (Shiny Doduo). EN and JP card numbers are completely different numbering systems — EN sets combine and reorder multiple JP sets alphabetically. No shared key exists between pokemontcg.io EN records and TCGCollector JP records.
- Rearchitected JP support: 27,255 TCGCollector JP cards loaded as `language='ja'` rows in the `cards` table via `scripts/load_jp_cards.py`. `image_url` IS the JP art — no overlay needed.
- Embedded all 27,255 JP cards with fine-tuned CLIP (inference only, not retraining). IVFFlat index rebuilt covering 47,442 total embeddings (20,187 EN + 27,255 JP). Zero failures.
- OCR search and pgvector search both filter by `Card.language == language` — EN and JP searches are fully independent.
- Removed all JP image overlay code: `ja_image_lookup.py` (now unused), `ja_image_urls`/`jaImageUrl` fields removed from `scan.py`, `cards.py`, `schemas/card.py`, `mobile/services/api.ts`, `mobile/types/scan.ts`, `batch-prices.tsx`, `card/[id].tsx`, `multi-results.tsx`.
- `kana_name`, `set_total` route params removed from card detail navigation — JP card's own `card.card_number` and `card.image_url` are now authoritative.
- `set_total` column added to `cards` table for JP OCR disambiguation; `_dedupe_and_rank` uses it directly for `language='ja'` cards instead of the EN `set_printed_totals.json` lookup.
- Vector search cache key includes language: `f"{sha256(img_bytes)}:{language}"` to keep EN/JP caches separate.

### v12 — Auto language detection, encoding fixes, search ranking (2026-05-20)

- **Auto per-crop language detection**: removed user-facing language toggle entirely. `TextRecognitionScript.JAPANESE` now used for all OCR (returns both Latin and kana). Kana regex `/[゠-ヿぁ-ゖ]/` determines language per crop — single scan correctly handles mixed EN+JP photos. `language` state removed from `scanStore`; `LanguageToggle.tsx` deleted. `BatchPricesRequest.language` field removed; `batch_prices` endpoint uses `card.language` per record.
- **JP set name mojibake fix**: 1,094 rows in DB and `tcgcollector_ja.json` had double-encoded UTF-8 set names (`PokÃ©mon` → `Pokémon`, `Ã—` → `×`, etc.). Root cause: HTML decoded as Latin-1 instead of UTF-8 during scraping. Fixed via SQL `REPLACE` in a single transaction; JSON source also corrected.
- **PriceCharting `_slugify` accented character fix**: `_slugify` was stripping `é` entirely (producing `pokmon-card-151`). Fixed with `unicodedata.normalize("NFKD")` to decompose accents before stripping combining marks — `Pokémon Card 151` now correctly slugifies to `pokemon-card-151`.
- **Search ranking improvements in `_search_db`**: added exact-match priority column so `"Gastly"` ranks above `"Sabrina's Gastly"` when searching for `"Gastly"`. Added set_total boosting column. Changed tie-break from `id ASC` to `id DESC` so newer catalog entries surface first within the same priority tier.

### v13 — OCR accuracy, trainer support, language detection hardening (2026-05-20)

- **Owner-prefix EN cards**: `_find_pokemon_name` strips possessive `'s` into `clean_for_punct` before the punctuation gate — "Misty's Staryu", "Sabrina's Gastly" now accepted. JP owner-prefix (`R団のミュウツー`, `ロケット団のミュウツー`) already worked via `_find_kana_name` substring matching.
- **Trainer/Supporter/Item/Tool EN support**: new `_find_trainer_name(lines)` in `card_matcher.py` — finds standalone type keyword, takes name 1–2 lines above, strips parenthetical subtitles, allows possessive apostrophe. `extract_card_hints` falls back to it after `_find_pokemon_name`. Mobile `cardConfidence.ts` fast-passes any standalone EN type keyword (`score=10, isCard=true`) before HP/keyword scoring.
- **Name region sub-crop OCR**: per-crop pipeline now runs a second OCR pass on the top 18% (5–95% width) of each card crop. `rawText` sent to backend = name-region text + card number from bottom corners. Removes attack text and flavor text from name extraction. Also fixes false EN→JP language misdetection: `cropLang` re-detected from name region (no flavor text kana misreads for EN cards).
- **Card number spatial filter tightened**: bottom 8% (was 22%), split into left-corner (x 0–35%) and right-corner (x 65–100%). Prefers corner with `\d+/\d+` pattern.
- **Camera / image quality**: `quality: 1`, `skipProcessing: true` at capture. Resize to 2400px PNG (was 1600px JPEG). Intermediate crops lossless PNG; backend payload re-encoded JPEG 0.92.
- **Kana false-positive fix**: `KANA_RE` requires 2+ consecutive kana chars (was single char) to classify crop as JP — prevents stray kana from adjacent card bleed misfiring on EN cards.
- **Backend JP→EN OCR fallback**: `_ocr_search_one` retries with `language='en'` if JP search returns no candidates — recovers EN cards whose flavor text was misread as kana before the name region crop fix takes effect.

### v14 — YOLO11n synthetic augmentation retraining ✅ (2026-05-20)

- **Dataset cleaning**: removed 27 set-symbol images (40×40px PNGs mislabeled as cards from 3rd party Roboflow export), 103 orphaned label files, all PSA slab images. Final cleaned real dataset: 1,225 train + 304 val.
- **Synthetic dataset** (`synthetic/v1`): 2,000 images generated via `scripts/generate_synthetic_yolo.py` — 800 card images downloaded from DB (45% EN Pokémon, 40% JP, 15% EN Trainer/Item, 0.15s/request rate limit), pasted onto 15 backgrounds at avg 6.5 cards/scene. Glass fraction 13% matching 2/15 natural background ratio. Stored at `training/datasets/pokemon/synthetic/v1/`.
- **Merged dataset** (`merged/v2`): 2,823 train (13,798 annotations) + 706 val (3,375 annotations). Stored at `training/datasets/pokemon/merged/v2/`.
- **Training**: fine-tuned from `card_detector.pt` (not base `yolo11n.pt`) on RTX 3080, 30 epochs, batch=16, imgsz=640. ~1.5hr total.
- **Convergence confirmed**: resumed training with `patience=15` early stopping — halted after 16 additional epochs with no mAP improvement, confirming epoch 30 was the converged optimum.

| Epoch          | Box loss   | Cls loss   | DFL loss   |
| -------------- | ---------- | ---------- | ---------- |
| 1              | 0.5281     | 0.4664     | 0.9653     |
| 10             | 0.3893     | 0.3348     | 0.8852     |
| 20             | 0.3233     | 0.2776     | 0.8618     |
| **30 (final)** | **0.2316** | **0.1915** | **0.8067** |

| Metric    | v1 (CPU, 50 epochs) | v2 (GPU, 30 epochs)     |
| --------- | ------------------- | ----------------------- |
| mAP50     | 0.992               | **0.993**               |
| mAP50-95  | 0.904               | **0.964** (+6.6%)       |
| Precision | 0.977               | 0.977                   |
| Recall    | 0.985               | 0.980                   |

- Deployed to `backend/models/card_detector.pt`; v1 backup at `card_detector_v1_backup.pt`.

### v15 — USD/JPY currency toggle (2026-05-21)

- **Use case**: scanning cards at Japanese card shops — user can instantly compare a card's USD market price converted to JPY against the shop sticker price.
- **Backend**: `GET /api/v1/currency/rates` endpoint (`backend/app/api/v1/currency.py`) fetches USD→JPY rate from frankfurter.dev and caches it in Redis under key `tcg:currency:usd_jpy` with a 24h TTL. Lazy-loaded on first request; no cron job needed — a missed cache hit costs ~150ms which is acceptable for a daily rate. The lazy approach is equivalent to a pre-warming cron at this scale and simpler to operate.
- **Mobile state**: `mobile/store/currencyStore.ts` (Zustand) holds `currency: "USD"|"JPY"`, `jpyRate`, and `fetchRate()`. Rate is fetched lazily on first JPY switch; store is global so currency preference is shared across all price screens within a session.
- **Formatting**: `mobile/utils/currency.ts` provides `fmtPrice()` (USD → `$X.XX`, JPY → `¥X` whole number with locale commas), `convertPriceHistory()` (multiplies chart data points), and `chartYLabel()` (JPY-aware y-axis: `¥X` or `¥Xk` for large amounts).
- **UI**: `[USD][JPY]` pill toggle in `PriceDisplay.tsx` heading row and `batch-prices.tsx` header. All price values, recent sales, last sold, and trend chart update immediately on toggle. Source line shows `1 USD = ¥X` when JPY is active.
- **Chart**: `PriceChart.tsx` accepts `currency`/`jpyRate` props; history points are converted before rendering; y-axis labels use the currency-aware formatter.

### v16 — Round 2 performance optimizations (2026-05-21)

Codebase pass that landed nine additional perf/correctness improvements after the original `OPTIMIZATION_AUDIT.md` round and the YOLO v2 retrain. OpenCV detection removed entirely.

- **OpenCV detector removed**: YOLO v2 (mAP50-95 0.964) is reliable enough that the OpenCV fallback is dead-on-arrival. `_detect_opencv`, `_try_split_box`, `_nms`, `_iou`, `_containment` and aspect/area thresholds deleted from `backend/app/services/card_detector.py` — file shrank from 249 → 87 lines. If the YOLO `.pt` is ever missing the endpoint returns zero boxes and mobile falls back to OCR clustering.
- **pgvector IVFFlat probes raised to 10** (`scan.py:_vector_search`): `SET LOCAL ivfflat.probes = 10` before the nearest-neighbor query — default of 1 only scans ~470 vectors across 100 lists, missing cluster-boundary matches. +5–10ms latency, materially higher recall.
- **Per-language partial IVFFlat indices**: replaced the merged `ix_cards_embedding_ivfflat` with `ix_cards_embedding_ivfflat_en` and `ix_cards_embedding_ivfflat_ja` (`WHERE language = 'en'|'ja'`). Each query now only scans matching-language clusters. New helper `rebuild_ivfflat_indices(conn)` in `scripts/build_embeddings.py`; one-off migration at `scripts/migrate_partial_ivfflat.py` for the existing DB.
- **CLIP fp16 on CUDA** (`card_embedder.py`): `_model.half()` after `.to(_device)` when CUDA available; input batch cast to `.half()`; output cast back to `.float()` for pgvector compatibility. ~1.8× encode throughput on RTX 3080, ~half VRAM. CPU keeps fp32 (fp16 on CPU is slower).
- **`torch.inference_mode()`** replaces `torch.no_grad()` in `embed_batch` — slightly faster, no autograd state.
- **Vector search LIMIT 5** (was 10): `_vector_search` only returns the top 5 anyway; phash re-ranking promotes existing rows, doesn't pull new ones in.
- **`threading.Lock` around `_load_model`** in `card_embedder.py`: prevents two `asyncio.to_thread` workers from racing the first-call load and double-allocating ~170MB of weights.
- **YOLO `half=True` on CUDA** (`card_detector.py`): ~1.5× faster YOLO inference on GPU.
- **Redis `mget` pipelining** (`cache.py`): new `CacheService.mget(key_parts_list)` batches N gets into one Redis round-trip. `_batch_image_search` in `scan.py` uses it for the per-crop cache check — N RTTs → 1.
- **Mobile: overlap JPEG re-encode with OCR** (`useMultiCardScan.ts`): inside the per-crop `Promise.all`, the JPEG re-encode + base64 read now kicks off concurrently with the full-crop OCR + name-region OCR chain. Saves 200–400ms per crop on real phones.

**Re-running the partial index migration on the existing DB:**

```bash
docker exec tcg_backend python /scripts/migrate_partial_ivfflat.py
```

Subsequent `scripts/build_embeddings.py` runs (with or without `--force`) automatically use `rebuild_ivfflat_indices()` to maintain both partial indices.

### v17 — Language detection hardening + UX fixes (2026-05-21)

- **Name-region sub-crop as primary language source**: `useMultiCardScan.ts` now always runs the name-region OCR (top 18%, 5–95% width) for language detection, regardless of scan mode or confidence result. Previously, the name-region override only ran in combined/OCR mode when `confidence.isCard` was true — meaning image-only mode and low-confidence crops always used the noisy full-crop text. Type symbols, energy icons, and flavor text on EN cards produced 2–3 consecutive kana misreads that flipped `cropLang` to `'ja'`, sending the wrong language to the backend. `KANA_RE` raised to `{3,}` as a secondary defense.
- **Backend JP→EN image search fallback**: `_image_search_one` in `scan.py` now retries with `language='en'` when `language='ja'` search returns `best_sim < _SIM_THRESHOLD`. Reuses the already-computed embedding (one extra pgvector query, ~5ms). Mirrors the existing OCR JP→EN fallback.
- **Region cap raised to 20**: crop loop in `useMultiCardScan.ts`, backend `/detect` call, `scan.py` crop slice, `card_detector.py` default, and `DetectRequest.max_cards` schema all raised from 10 → 20. Matches the YOLO v2 training range (up to 20 cards/scene).
- **JP PriceCharting URL fix**: `_JP_PC_SET_SLUG` dict maps TCGCollector set names that `_slugify` would mangle to pre-slugified PriceCharting slugs (e.g. "Pokémon Card 151" → `scarlet-&-violet-151`). `/console/` link filter added to `_parse_prices` — prevents set-listing disambiguation page links from being stored as sale URLs. Guard: if `price_loose is None` and all sale URLs are None, clears `recent_sales` to avoid bogus rows.
- **"Complete" row removed** from `PriceDisplay.tsx`: `price_cib` is PriceCharting's "Complete In Box" game tier — never populated for trading cards.
- **Reload button on card details page**: `loadCard(refresh?)` extracted from `useEffect`. Error state → accent "Retry" button. No-price state → "Retry" inside the box. Price loaded → "↻ Refresh price" link below `PriceDisplay` with spinner. Re-fetch hits backend which checks Redis cache (24h price TTL, 1h negative TTL).

### v19 — Reload cache bypass + TFLite on-device YOLO (2026-05-21)

- **Reload cache bypass**: `GET /api/v1/cards/{id}` now accepts `?force_refresh=true` (FastAPI `Query` param). Passes through to `get_prices(..., force_refresh=True)` which skips the Redis `get()` call entirely when set — bypasses both the positive 24h cache and the 1h negative (not-found) cache. Backend still writes back after scraping. Mobile `api.getCard()` has new `forceRefresh?: boolean` param; the reload button in `card/[id].tsx` passes `refresh=true` so `loadCard(true)` → `forceRefresh=true`.
- **TFLite on-device YOLO**: Export chain: `YOLO.export(format='onnx')` + `onnx2tf` (direct, not via ultralytics — ultralytics TFLite export segfaults in this container). Output: `card_detector_float16.tflite` (5.1MB, float32 I/O, output `[1, 5, 8400]`). `metro.config.js` created with `tflite` in `assetExts`. `mobile/utils/yoloDetector.ts` implemented: jpeg-js JPEG decode → float32 NHWC input → TFLite inference → greedy NMS → stretched (not letterboxed) 640×640 un-projection → box sort matching backend. Output layout auto-detected from `model.outputs[0].shape`. Try-catch returns `null` (falls back to backend `/detect`). Model loaded lazily, cached module-level.

### v20 — httpx scraper, speed benchmark mode, OCR optimization (2026-05-22)

#### Playwright → httpx scraper switch

Removed 300MB headless Chromium dependency entirely. PriceCharting now fetched with `httpx.AsyncClient` — persistent TCP/TLS connections, brotli decompression via `brotlicffi`, rate limit dropped from 3.0s → 0.5s. Per-card fetch improved from ~5–7s to ~1s.

- `backend/app/scrapers/base.py` — full rewrite: `_get_client()` returns a shared `httpx.AsyncClient`; `close_client()` called on shutdown; `BaseScraper.fetch_page()` interface preserved so `pricecharting.py` and `psa.py` needed no changes
- `backend/requirements.txt` — removed `playwright==1.47.0`, `opencv-python-headless==4.10.0.84`; added `brotlicffi==1.1.0.0`
- `backend/app/config.py` — `pricecharting_rate_limit_seconds: 3.0 → 0.5`
- `backend/Dockerfile` — switched from Playwright image to `python:3.12-slim`; kept `libgl1 libglib2.0-0` apt packages (still needed by ultralytics transitive `opencv-python` dep)
- `backend/app/services/card_detector.py` — removed direct `cv2` usage; switched `cv2.imdecode` → `PIL.Image.open(io.BytesIO()).convert("RGB")`; YOLO accepts PIL images natively

#### Speed benchmark mode (dev feature)

Times the scan pipeline (button press → first card result from backend) independently of the PriceCharting scrape. Real functionality preserved.

- **Backend**: `GET /api/v1/cards/{id}` accepts `?skip_price=true` — returns `price: null` immediately, no scrape
- **`mobile/types/scan.ts`**: `ScanTiming` interface (`yoloMs`, `cropPrepMs`, `firstResultMs`, `totalStreamMs`)
- **`mobile/store/scanStore.ts`**: `scanTiming: ScanTiming | null` field + `setScanTiming` action; cleared on `clearMultiScan`/`reset`
- **`mobile/services/api.ts`**: `skipPrice?: boolean` on `getCard()` → appends `skip_price: true`
- **`mobile/hooks/useMultiCardScan.ts`**: `enableTiming` 4th param; timestamps at YOLO complete (t1), crop prep complete (t2), first streamed result (t3), stream done (t4)
- **`mobile/app/(tabs)/index.tsx`**: "⚡ Speed Test" toggle button; passes `speedTestMode` to `multiScan()`
- **`mobile/app/multi-results.tsx`**: gold timing banner (first card / all cards / YOLO / OCR prep ms); passes `speedTest=1` to card detail nav
- **`mobile/app/card/[id].tsx`**: reads `speedTest` param, skips price fetch, times card-detail round-trip, shows gold banner

#### Speed test results — Samsung S22+ (Snapdragon 8 Gen 1), 12 cards

| Run          | Delegate / Model                        | First card      | All cards | YOLO   | OCR prep | Notes                                 |
| ------------ | --------------------------------------- | --------------- | --------- | ------ | -------- | ------------------------------------- |
| 1 (baseline) | CPU float16                             | 12.10s          | 12.52s    | 4969ms | 5695ms   | First clean CPU baseline              |
| 2            | GPU delegate                            | 16.99s          | 17.43s    | 9832ms | 6558ms   | First run, init overhead              |
| 3            | GPU delegate                            | 14.04s          | 14.39s    | 7121ms | 6275ms   | Second run, still slower than CPU     |
| 4            | CPU float16 (reverted)                  | 13.97s          | 14.36s    | 6806ms | 6406ms   | Normal CPU variance, phone at 51°C    |
| 5            | CPU float16                             | 13.88s          | 14.22s    | 7160ms | 6065ms   | After OCR opt + INT8 attempt          |
| 6            | CPU float16 (TFLiteConverter regen)     | 13.39s          | 13.79s    | 6726ms | 6060ms   | regionsFromYolo=false — model broken  |
| 7            | CPU float16 (onnx2tf original restored) | pending rebuild | —         | —      | —        | Restoring to verify OCR opt           |

**GPU delegate verdict**: slower than CPU on S22+ (Snapdragon 8 Gen 1) due to YOLO op compatibility — some ops fall back to CPU with quantize/dequantize overhead. Reverted. Phone temps 51°C are below throttle threshold (~80°C); variance (~30%) is normal Android scheduler noise.

**Key finding**: backend is fast (~1.4s to first card result). Bottleneck is entirely on-device: YOLO (~5–7s CPU) + OCR prep (~5.7s for N crops × 2 ML Kit passes).

#### INT8 quantization attempt — failed (2026-05-22)

Attempted to produce an INT8 TFLite model for faster ARM CPU inference.

- Calibration: 225 real card photos from `training/datasets/pokemon/source/my_photos/` (23 batch folders of 10), copied into container at `/calib_images`
- Script: `scripts/quantize_int8.py` — reads existing `card_detector_saved_model`, runs TFLiteConverter with `Optimize.DEFAULT` + `TFLITE_BUILTINS_INT8` + float32 I/O
- Output: `card_detector_int8.tflite` (2853KB, down from 5.1MB float16) — written to `backend/models/`
- **Result: slower than float16** — converter output `fully_quantize: 0` (incomplete quantization). YOLO has ops that don't map to INT8 in TFLite, so quantize/dequantize nodes were inserted at every float/INT8 boundary, adding overhead exceeding the INT8 speedup. YOLO went from ~5s → ~7–9s.
- **Root cause of 0 boxes**: TFLiteConverter regenerated float16 model also failed (`fromYolo=false`) — TFLiteConverter does not preserve the onnx2tf output tensor layout (`[1, 5, 8400]`). The mobile post-processing expects this specific layout and got something different, producing no detections.
- **Fix**: restored original onnx2tf-generated `card_detector_float16.tflite` from `card_detector_saved_model/card_detector_float16.tflite` — this file survived in the saved model directory untouched.

**For future INT8 attempts**: use onnx2tf's own quantization pipeline (`--quant_type int8 --calib_data_dir`), not TFLiteConverter. onnx2tf handles the YOLO-specific op layout and tensor naming correctly; TFLiteConverter does not. onnx2tf is not currently in `requirements.txt` — install separately when needed.

#### OCR optimization — skip full-crop OCR for YOLO-detected regions

When YOLO detected the card regions, the per-crop full-image OCR pass + `assessCardConfidence` check are redundant — YOLO (mAP50 0.993) already confirmed the regions are cards. Only the name-region sub-crop OCR (top 18%) is needed for the backend hint.

- `mobile/hooks/useMultiCardScan.ts`: `regionsFromYolo` flag set when YOLO returned boxes; per-crop pipeline branches on this flag — YOLO path runs 1 ML Kit call per crop (name region only); fallback path runs 2 calls per crop (full crop + name region) with confidence gate unchanged
- Card number extraction unchanged — still reads from `allBlocks` (full-image OCR computed once at start)
- Expected saving: N crops × 2 ML Kit calls → N crops × 1 ML Kit call (~2–3s on 12 cards)
- **Superseded by v21 spatial-filter OCR** — eliminated per-crop ML Kit calls entirely (zero ML Kit per crop), saving ~6s on 12 cards. The `regionsFromYolo` branch is subsumed by the spatial-filter approach.

#### Language flag emoji on scan results (2026-05-22)

Added 🇺🇸/🇯🇵 flag in the badges row of each card result in `multi-results.tsx`. Reads `card.language` — `'ja'` shows 🇯🇵, anything else shows 🇺🇸. Appears left of card number and rarity badges.

#### Speed test logging (2026-05-22)

- `useMultiCardScan.ts`: `_appendTimingLog()` appends each speed test result to `scan_timing_log.json` in the app's document directory
- `multi-results.tsx`: "Copy log" button in timing banner opens native share sheet with full JSON log content
- Each entry: `{ yoloMs, cropPrepMs, firstResultMs, totalStreamMs, ts }`

### v21 — Server-side cropping + spatial-filter OCR + NNAPI delegate (2026-05-22)

Three independent optimizations landed together. All preserved in v22.

- **Spatial-filter OCR** (`mobile/hooks/useMultiCardScan.ts`): eliminated all per-crop ML Kit OCR calls. New helpers `getNameRegionText()` and `getCropRegionTextAndCount()` spatially filter the already-computed full-image OCR blocks for each crop's name region (top 18%, 5–95% width) and full-crop region. Same pixel density as the previous per-crop sub-crop pass. Saves ~6s on 12 cards.
- **Server-side cropping** (`backend/app/api/v1/scan.py`, `mobile/services/api.ts`): `/scan` now accepts `{image, boxes}` instead of N pre-cropped base64 JPEGs. Mobile sends one full image + box coords; backend slices with `PIL.Image.crop` (~5ms/box). Eliminates N `ImageManipulator.manipulateAsync` + N JPEG re-encodes + N base64 reads on the phone (~500ms–1s saved on 12 cards). Legacy `crops: list[str]` path preserved for backwards compat.
- **NNAPI delegate preference** (`mobile/utils/yoloDetector.ts`): replaced hard-coded delegate with `['nnapi', 'default']` on Android, `['core-ml', 'default']` on iOS, with transparent fallback if the first delegate rejects the model. NNAPI routes to Snapdragon Hexagon DSP when available.

### v22 — On-device YOLO unblocked + JPEG resize + PIL-direct embedder (2026-05-22)

**Headline:** Samsung S22+, 12 cards: 13.97s → **3.12s first card (4.5× faster)**. On par with SKANIT/DeckTradr territory.

#### On-device YOLO now working

`react-native-fast-tflite` v3.0.1 was rejecting onnx2tf's op set with an empty native error. Downgraded to **v2.0.0** (single API-compatible v2 release on npm). Model loads first try with NNAPI delegate.

Two post-load fixes for v2 API differences:

1. **Input format**: v3 accepted `ArrayBuffer[]`; v2 wants `TypedArray[]`. Symptom: `"Exception in HostFunction: no ArrayBuffer attached"`. Fix: `model.run([input])` not `model.run([input.buffer])`.
2. **Output unwrap conditional**: v2 may return `Float32Array` directly. Fix: `outputs[0] instanceof Float32Array ? outputs[0] : new Float32Array(outputs[0]!)`.

#### Stale NNAPI handle recovery

Module-level `_model` cache goes stale after fast refresh / app backgrounding / native-side GC. Symptom on second-session scan: `"Value is undefined, expected an Object"` from `runModel`. Fix: try/catch around `model.run()`; on failure, nuke `_model` + `_modelPromise`, call `getModel()` for a fresh load, retry inference once.

#### Failed approach: `Promise.all([OCR, YOLO])`

Attempted to overlap ML Kit OCR and NNAPI YOLO. Both completed individually but the YOLO call crashed inside `runModel` with `"Value is undefined, expected an Object"` whenever paired with concurrent ML Kit. Suspected native-bridge resource conflict between the two systems. **Do not retry.** YOLO is only ~100–200ms post-warmup; sequential is stable and the parallelism win is small.

#### Resize: PNG (lossless) → JPEG 0.95

Discovered `resize=3001ms` was the new dominant cost — PNG encode of a multi-megapixel raw camera image. Switched to JPEG 0.95: ~500ms encode, visually lossless, no measurable OCR accuracy impact. Side effect: `resized.uri` is already JPEG, so the backend payload promise skips its redundant JPEG re-encode and base64s the file directly.

#### Embedder: accept PIL Image directly (eliminate double JPEG)

Image-AI path was doing two JPEG round-trips: mobile encoded full image as JPEG 0.95, backend cropped with PIL then re-encoded each crop as JPEG 0.92, `embed_batch` decoded that back to PIL inside CLIP preprocessing. Each compression pass shaves ~2–5% off CLIP similarity scores, pushing borderline cards below `_IMAGE_MIN_SIM_WITH_OCR = 0.83` in Combined mode (visible as "more OCR-only badges, no Both ✓ badges").

Refactor:

- **`backend/app/services/card_embedder.py`**: `embed_batch` and `compute_phash` now accept `PIL.Image | bytes`. New `_to_pil(src)` helper: PIL passes through, bytes decoded once. Other callers (`build_embeddings.py`, `retry_failures.py`) unaffected — still pass bytes.
- **`backend/app/api/v1/scan.py`**: `imgs` is now `list[PIL.Image | None]`; new parallel `cache_seeds: list[str | None]`. `_vector_search` and `_image_search_one` take `cache_seed: str` instead of `img_bytes`. Cache strategy:
  - Server-crop path: `f"{sha256(full_image_bytes)}:{left},{top},{right},{bottom}"`
  - Legacy crops path: `sha256(crop_bytes)` (unchanged)
- **Dead code removed**: `_batch_image_search` was unreferenced. Deleted.

Cache seed change invalidates pre-existing Redis entries on deploy; 1h TTL means self-healing within an hour.

Note: in dim lighting CLIP scores typically sit at 0.55–0.75 regardless of image quality, so the 0.83 gate still filters most image hits out of Combined mode. Better lighting recovers "Both ✓" badges.

#### BASIC OCR strip regex expanded

`_POKEMON_NON_NAME_RE` in `card_matcher.py` previously only matched `BASIC` variants with the leading B intact. New pattern `[b38g]?as[in][cgsq]\w*` handles dropped-B misreads (`ASIC`, `ASIG`, `ASIQ`), digit-confusion misreads (`3ASIC`, `8ASIC`), G-confusion (`GASIC`, `GASIG`), and I→N stroke confusion (`ASNG`, `ASNC`). Discovered when user reported search queries like `"ASIG Suicune"` and `"ASNG Gastly"` displayed on results screen.

#### Speed test results — Samsung S22+, 12 cards (post-v22)

| Run                          | First card      | All cards       | YOLO bucket      | OCR prep       | Notes                                    |
| ---------------------------- | --------------- | --------------- | ---------------- | -------------- | ---------------------------------------- |
| Pre-v21 baseline             | 13.97s          | 14.36s          | 6806ms           | 6406ms         | v20 reference                            |
| v21 (parallel attempt)       | 8.15s           | 8.59s           | 7105ms           | 365ms          | NNAPI crashed, fell back to backend      |
| v21 (sequential, PNG resize) | 5.91s           | 6.28s           | 4683ms           | 333ms          | On-device YOLO working but resize=3000ms |
| **v22 run 1**                | **2.97s**       | **3.39s**       | **2047ms**       | **46ms**       | JPEG resize + on-device YOLO             |
| **v22 run 2**                | **3.14s**       | **3.56s**       | **2096ms**       | **56ms**       | Stable repeat                            |
| **v22 post-PIL**             | **3.12s**       | **3.51s**       | **2156ms**       | **37ms**       | After PIL-direct embedder change         |

`yolo bucket` breakdown (post-v22): resize ~580ms + on-device YOLO ~1050ms (incl. JS preprocessing) + full-image OCR ~600ms.

#### Remaining latency targets (Round 4 candidates)

1. **`yoloDetector.ts` JS preprocessing** (~850ms of the 1050ms YOLO bucket): file read → atob → JPEG decode (jpeg-js) → Float32 array build, all in single-threaded JS. Replace `jpeg-js` with a native decoder or a worklet.
2. **Full-image OCR** (~600ms): try `LATIN` script as fast path with `JAPANESE` fallback only when no Latin hits found (current pass is always JAPANESE which is slower).
3. **Camera capture quality**: `quality: 1, skipProcessing: true` produces multi-megapixel raw — lowering to 0.85 could cut ~200ms off resize with no OCR impact.
4. **NNAPI warmup**: first inference takes ~1000ms due to native compilation; preload at app startup so first user scan is fast.

### v22.1 — Accuracy fixes: cross-language fallback margin + candidate pool widening + batch timeout (2026-05-22)

- **Cross-language fallback margin**: JP→EN and EN→JP image fallback now requires `other_sim > best_sim + 0.05` before switching — prevents marginal differences (e.g. JP sim=0.477, EN sim=0.489) from causing wrong-language results.
- **Candidate pool widening**: vector search `LIMIT 5 → 10`; IVFFlat `probes 10 → 20` — more candidates survive to RRF merge, better recall at ~5ms extra latency.
- **Batch prices axios timeout**: `30s → 90s` — 20 cards × ~3s per uncached card = 60s worst case; default timeout produced spurious network errors while backend successfully completed.

### v23 — OCR accuracy fixes: BASIC misreads, McDonald's ranking, JP short-name detection (2026-05-22)

- **BASIC OCR misread prefix**: `_POKEMON_NON_NAME_RE` pattern expanded from `[b38g]?as[in][cgsq]\w*` to `.{0,2}as[in][cgsq]\w*` — catches OASIC, DASIC, and any 0–2-char OCR prefix confusion (B misread as O, D, 日, etc.) before the ASIC/ASIG/ASNG stem.
- **McDonald's promo ranking**: `mcd_penalty` added as tertiary sort key in `_dedupe_and_rank` — `set_code.startswith("mcd")` → penalty 1; McDonald's variants only surface when set_total and card number both fail to differentiate.
- **KANA_RE stabilized at `{2,}`**: lowered from `{3,}` to catch short JP names like シシコ (Litleo) that OCR misreads as 2 kana. Detection runs on name-region sub-crop (top 18%) — no EN text generates 2+ consecutive kana there. Unified EN+JP scan flow preserved.

### v24 — JP trainer name extraction + card variant pricing (2026-05-22)

#### JP trainer card name extraction

- `_find_jp_trainer_name(lines)` in `card_matcher.py`: locates standalone JP type keyword (グッズ/サポート/スタジアム/ポケモンのどうぐ), takes name 1–2 lines above, strips parenthetical subtitles (full-width `（）` and half-width `()` parens).
- `_search_db_ja_trainer()`: searches `Card.name_ja` directly for JP trainer names that have no kana→EN translation in the Pokémon dictionary.
- Falls through from `_find_kana_name` in `extract_card_hints` — no change to Pokémon card path.
- `build_search_query` updated to show JP trainer name in query label.

#### Card variant pricing

Variant picker on card detail screen — horizontal pills that re-fetch prices for a different PriceCharting listing of the same card.

**URL pattern** (verified against real PriceCharting pages): variant suffix inserts between name slug and card number in the card slug; game slug unchanged.

| Variant     | Card slug example          |
| ----------- | -------------------------- |
| 1st Edition | `charizard-1st-edition-4`  |
| Shadowless  | `charizard-shadowless-4`   |
| Poké Ball   | `umbreon-poke-ball-59`     |
| Master Ball | `gengar-master-ball-94`    |

**EN variants**: Normal / 1st Edition / Shadowless / Poké Ball
**JP variants**: Normal / Poké Ball / Master Ball

**When variant has no price data**: shows "Variant not found on PriceCharting" with a "Search on PriceCharting →" link (opens browser to pre-populated search). URL construction is heuristic — PriceCharting may use different slugs for some cards; the search link lets the user verify manually.

**Files**: `backend/app/scrapers/pricecharting.py` (`build_game_url` variant param), `backend/app/services/card_matcher.py` (`_build_pc_url`, `get_prices`), `backend/app/api/v1/cards.py` (`variant` query param), `mobile/services/api.ts`, `mobile/app/card/[id].tsx`.

### v25 — Streaming batch prices (2026-05-22)

Replaced the wait-for-all batch prices request with an NDJSON stream — prices appear card-by-card as they resolve rather than all at once.

**Backend**: `POST /api/v1/cards/prices/stream` in `cards.py`. Uses `asyncio.ensure_future` + `asyncio.as_completed` — all price fetches run concurrently and results are yielded the moment each completes. Cache hits (Redis) emit immediately; scrape misses follow as the rate limiter allows. Same `BatchPricesItem` shape per line. `POST /api/v1/cards/prices` unchanged (backwards compatible).

**Mobile `api.ts`**: `api.streamPrices()` — XHR `onprogress` NDJSON parser (same pattern as `scanStream`). Accepts `onResult(item: BatchPricesItem)` callback and `AbortSignal` for cleanup.

**Mobile `batch-prices.tsx`**: replaced `api.batchPrices()` + bulk `setEntries` with `api.streamPrices()` + per-result `setEntries`. Each card row's spinner resolves independently as its price arrives. `AbortController` cancels the stream on unmount.

### v26 — Batch prices fixes + price UI improvements + save button (2026-05-24)

#### Batch prices payload fix

All cards beyond the first were failing to populate in the stream. Root cause: the full `PriceOut` payload per card (~14–18KB) included 60 recent sales + full chart history, causing Android XHR to drop or stall the NDJSON stream. Fixed by introducing `PriceOutSlim` / `BatchPricesItemSlim` schemas used exclusively by the stream endpoint — strips `price_history_ungraded`, `price_history_graded`, and caps `recent_sales` at 3. Payload dropped from ~69KB → ~8KB for 5 cards. Full data (100 sales cap, full chart history) is preserved in Redis and served to individual card pages unaffected.

- `backend/app/schemas/card.py`: `PriceOutSlim` (no chart history, recent_sales capped at 3), `BatchPricesItemSlim`
- `backend/app/api/v1/cards.py`: stream `generate()` converts to slim schema before serializing
- Note on 100-sale limit: intentional — prevents raw sales from crowding out PSA entries on popular cards (e.g. Charizard). Applies to Redis cache / individual card pages. Stream trims to 3 at serialization only.

#### Batch prices → card detail navigation

Tapping a card row in batch-prices now navigates to `card/[id].tsx`. Back button returns to batch-prices. Header title fixed from "batch-prices" to "Batch Prices".

- `mobile/app/_layout.tsx`: added explicit `Stack.Screen name="batch-prices"` with `title: "Batch Prices"`
- `mobile/app/batch-prices.tsx`: `CardPriceRow` accepts `onPress` prop; outer `View` changed to `TouchableOpacity`; `renderItem` builds nav params from resolved card (uses `item.data?.card ?? item.card` so navigation uses the enriched card from the price response)

#### Price trend chart follows grade filter

The trend chart in `PriceDisplay.tsx` switches series based on the active sale filter tab: Raw tab → `price_history_ungraded`; any PSA grade tab → `price_history_graded`.

**Note on per-grade chart data**: `VGPC.chart_data` embedded in PriceCharting pages only contains `used` (ungraded) and `graded` (one combined series covering all grades). There are no per-grade series (grade-7, grade-8, etc.) in the embedded JS — PriceCharting loads those via AJAX on grade toggle. Per-grade trend charts are not achievable from a single page scrape.

- `mobile/components/Card/PriceDisplay.tsx`: `saleFilter` state defaults to `"10"` when `scanType === "psa"`, else `"raw"`; chart renders `price_history_ungraded` when `saleFilter === "raw"`, otherwise `price_history_graded`

#### PSA grade filter labels

Sale filter tabs updated from "G7"/"G8"/"G9" to "PSA 7"/"PSA 8"/"PSA 9" for clarity.

#### Save button on card detail page

Star icon (☆/★) added to header right of `card/[id].tsx` alongside the refresh button. Taps toggle saved state via `useSavedCardsStore`. Star is gold (`COLORS.warning`) when saved, muted when not.

- `mobile/app/card/[id].tsx`: imports `useSavedCardsStore`; `toggleSave` callback; `headerButtons` row wraps save + refresh; `cardSaved` derived from `isSaved(data.card.id)`

### v27 — Live Scan mode (2026-05-24)

#### What was implemented

Fully new screen and hook for continuous card-by-card scanning without a capture button.

- **`mobile/app/(tabs)/live-scan.tsx`**: VisionCamera viewfinder (aspectRatio 3:4), Start/Stop buttons, session list (FlatList), running total footer, Done button → `batch-prices`
- **`mobile/hooks/useLiveScan.ts`**: recursive `setTimeout` detection loop (`CYCLE_PAUSE_MS = 150ms`), stability tracker (800ms hold window, `STABLE_THRESHOLD = 0.035`), `captureAndScan` using `takePhoto` + `api.scanStream` + background price fetch, cooldown between captures (`CAPTURE_COOLDOWN_MS = 2500ms`)
- **`mobile/components/Scanner/LiveBoundingBox.tsx`**: animated corner-bracket overlay; cover-scale mapping from snapshot coords to viewfinder coords; state colors: detecting=white, stable=green, captured=blue
- **`mobile/components/Scanner/StabilityRing.tsx`**: animated horizontal progress bar; white → green at 100%; fades in/out via opacity animation
- **`mobile/app/(tabs)/_layout.tsx`**: tab bar changed from 3 visible tabs (Scan/Saved/History) to 2 visible tabs (Multi Scan / Live Scan); Saved and History kept as `href: null` hidden routes
- `useFocusEffect` stops detection on screen blur (no auto-start); Start button is explicit
- End Session collects resolved cards → `setBatchPriceCards` → `/batch-prices`

#### Known issue — on-device YOLO always fails in live scan context

**Symptom**: `detectCardsWithYolo` returns `null` on every cycle. Logs show:
```
[YOLO] run failed, resetting model cache and retrying: Value is undefined, expected an Object
[YOLO] model loaded with delegate=nnapi
[YOLO] retry failed, forcing CPU delegate: Value is undefined, expected an Object
[YOLO] model loaded: true
[YOLO] run failed, resetting model cache and retrying (repeats)
```

**Root cause**: `model.run([input])` throws even after the CPU fallback sets `_model = cpu`. The CPU handle also goes stale immediately — every call resets and retries. Multi scan (one-shot `detectCardsWithYolo` per photo tap) works fine with the same model; the live scan loop (continuous 150ms cycles) triggers a pattern where all three tries fail: NNAPI run, NNAPI retry, CPU run. Suspected: `react-native-fast-tflite` v2 native model handles are invalidated when `model.run` is called with a fresh `Float32Array` in a tight async loop on Android (possibly GC pressure or JSI bridging issue unique to high-frequency calling patterns).

**Impact**: no bounding box overlay is shown; `detectCardsWithYolo` returns null every cycle so `runOneCycle` returns early with no box set, meaning no stability trigger and no capture.

**Fix needed**: in `runOneCycle`, when `detectCardsWithYolo` returns null fall back to `api.detectCards(snapshotBase64)` (the existing backend `/detect` endpoint). This gives boxes for the overlay via the backend instead of on-device. Slower (~200–400ms vs ~100ms) but reliable. Backend detect is already fast (httpx, no Playwright). The fallback is already wired in multi scan — same pattern applies here.

**Files to change**:
- `mobile/hooks/useLiveScan.ts`: `runOneCycle` — read snapshot → call `detectCardsWithYolo(snapshotUri, sw, sh)`; if null, base64-encode snapshot → call `api.detectCards(base64, sw, sh)` → use returned boxes; rest of stability logic unchanged
- `mobile/services/api.ts`: `api.detectCards` already exists and accepts base64 + dimensions

### v28 — Search improvements, JP name population, dynamic save lists (2026-05-25)

#### Search ranking overhaul

Multi-signal scoring in `GET /api/v1/cards/search`:

- **First-word penalty**: `name_score = sim_name × similarity(first_query_token, first_word_of_card_name)`. Prevents "mew vstar" from ranking Mewtwo VSTAR (high full-name sim) above Mew V — Mewtwo's first word fails the first-token match hard.
- **Set hint bonus**: for multi-token queries, `word_similarity(non-first-tokens, set_name) × 0.5` added additively to name score. "suicune prism" now boosts Prismatic Evolutions cards even when multiple Suicune cards have identical name similarity.
- **Card number extraction**: last all-digit token stripped from query and applied as a hard `card_number` filter instead of diluting the similarity score.
- **Exclusion terms**: tokens starting with `-` (e.g. `-detective`) removed before scoring and applied as `NOT ILIKE '%term%'` on both `name` and `set_name`. Multiple exclusions stack. Query of only exclusion terms returns empty. Primary use case: `pikachu -detective` to exclude the Detective Pikachu set.

#### JP name population — Pass 6 (trainer cards)

`scripts/populate_name_ja.py` Pass 6 added: ~80-entry `TRAINER_NAMES` dict mapping EN trainer names to katakana (e.g. `"Brock"` → `"タケシ"`, `"Professor Oak"` → `"オーキド博士"`). Applied as exact-match UPDATE on `name_ja IS NULL` rows. Updated 1,137 trainer rows; total JP name coverage reached 35,252 / 47,492.

#### Encoding fixes

- `scripts/scrape_tcgcollector.py`: added `fix_encoding(s)` helper (`s.encode('latin-1').decode('utf-8')`) applied to all scraped name and set_name fields — prevents future mojibake from HTML decoded as Latin-1.
- `backend/app/data/tcgcollector_ja.json`: 387 double-encoded fields fixed in-place (`PokÃ©` → `Poké`).

#### Dynamic save lists (SaveToCollectionSheet rewrite)

- **No Done button**: tapping ★ saves to the default collection immediately; sheet opens for optional list assignment. Closing the sheet does not revert the save.
- **Dynamic checkbox toggle**: each non-default list row immediately `addCard` / `removeFromCollection` on tap — no buffered state, no confirm step.
- **Inline list rename**: pencil icon per non-default row → `renamingId` state swaps the row to a TextInput + Save/cancel.
- **Keyboard avoidance (Android)**: `kbHeight` plain `useState(0)` + static `marginBottom: kbHeight`. Fabric renderer rejects `Animated.Value` on `marginBottom` — cannot use `useNativeDriver: false` for margin. `Keyboard.addListener` events update the state.
- **`collectionsStore.rename`**: new action added; guards `!c.isDefault` to prevent renaming the default collection.

#### Saved Lists screen

- Long-press-to-delete removed from `saved.tsx`.
- Pencil icon and inline rename row removed from `saved.tsx` (moved to collection detail).
- `saved.tsx` now: tap only to navigate, `Stack.Screen title="Saved Lists"`, clean list with chevron.
- GameDrawer nav link updated to "Saved Lists" (proper case).

#### Collection detail screen — rename + delete in header

- `collection/[id].tsx` header right now includes: list/grid toggle, pencil icon (non-default), trash icon (non-default).
- Pencil tap: `isRenaming` state set; `headerTitle` swaps to a custom component rendering a `TextInput` + checkmark + X. Title row cleared; `headerRight` icons hidden during rename. Submit via checkmark or return key calls `rename(id, text)`.

### v29 — McDonald's image and pricing fixes (2026-05-25)

#### PriceCharting URL fix for McDonald's sets

pokemontcg.io names these sets `"McDonald's Collection 2017"` but PriceCharting uses `mcdonalds-2017` (no "Collection"). The generic `_slugify` produced `mcdonalds-collection-2017` → 404 on every McDonald's price fetch.

Fix: `_EN_PC_SET_SLUG` dict in `backend/app/scrapers/pricecharting.py` — dict comprehension covering all 10 EN sets (2011–2022), maps DB set name → pre-slugified PriceCharting game slug. Checked before `_slugify` in `build_game_url`, same pattern as existing `_JP_PC_SET_SLUG`.

#### TCGCollector images for McDonald's EN cards

pokemontcg.io images for McDonald's sets were low-quality or missing. TCGCollector has high-quality scans for all Collection sets (2011–2022).

- **Scraper**: `scripts/scrape_tcgcollector.py` extended with `--output-file` param (previously always wrote to `tcgcollector_ja.json`). Run with `--base-url` pointing to the TCGCollector multi-expansion URL for 13 EN McDonald's expansions.
- **Scraped**: 178 cards across 13 sets (includes 2013, Dragon Discovery 2024, Match Battle 2022/2023 which aren't in our DB — 42 skipped). 136 matched and updated.
- **Update script**: `scripts/update_mcd_images.py` — reads `tcgcollector_mcd_en.json`, extracts year from TCGCollector set name via `\b(20\d\d)\b` regex, matches to `"McDonald's Collection {year}"` + card_number in DB, updates `image_url`. Idempotent (skips already-matching URLs).
- **Result**: 136 McDonald's EN cards (2011–2022 Collection sets) now serve TCGCollector CDN images.
