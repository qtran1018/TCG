# TCG Card Scanner

A mobile app that scans TCG (Trading Card Game) cards and fetches pricing/sales data from [PriceCharting](https://www.pricecharting.com).

## Project Structure
- `backend/` — FastAPI server (Python), scrapes PriceCharting and proxies pokemontcg.io
- `mobile/` — Expo/React Native app (card scanning UI)
- `docker-compose.yml` — Local dev environment (backend + postgres + redis + worker)

## Data Sources
- **Card metadata & images** — pokemontcg.io API (stored in Postgres on first match)
- **Prices, sales, trend graphs** — PriceCharting scraper (cached in Redis, 24h TTL)
- **PriceCharting URL pattern**: `https://www.pricecharting.com/game/{set-slug}/{card-slug}`

## Completed Features
- Camera scan → ML Kit OCR → card search (pokemontcg.io + local DB)
- Price display: ungraded, graded (PSA 7–10), recent sales table
- Price trend graph (`VGPC.chart_data` embedded JS, rendered via react-native-chart-kit)
- PSA cert lookup flow
- Search result caching (Redis): prices 24h, search 1h
- Best-offer price fix: scraper reads accepted price instead of N/A for best-offer eBay sales
- Y-axis graph labels scale correctly for sub-$1 cards
- Single-card confidence gate: OCR text scored before hitting backend (card number, HP, keywords, copyright)
- Backend card number ranking: exact match ranks first (handles zero-padded numbers like "024")
- Query display format: `Name #N` (e.g. `Suicune #24`) — denominator dropped, `#` prefix added
- **Batch price retrieval**: multi-results screen lets you select cards (tap to check, Select All), then "Get Prices (N)" navigates to `batch-prices.tsx` showing each card's market price + last sold entry
- **Sale listing links**: recent sales rows on both individual price page and batch-prices page show "eBay →" or "TCGPlayer →" links; tapping opens in app/browser via `Linking.openURL`
- **All-source sales scraping**: PriceCharting scraper collects from all `hoverable-rows sortable` tables on the page (eBay + TCGPlayer), not just the first one
- **Price cache key fix**: cache key uses `{set-slug}_{card-slug}` instead of just `{card-slug}`, preventing same-number cards from different sets (e.g. Gastly #36 in Fossil vs Base Set 2) from colliding in Redis

## Current Scan Flow (single card)
1. Camera captures photo
2. Image resized to 1200px wide; OCR run on full image
3. `filterBlocksToCardZone` maps scan overlay geometry through camera cover-scale transform to image coordinates, keeps only blocks within the card zone
4. OCR text scored by `cardConfidence.ts` — rejected if score < 3
5. Backend extracts hints (name, card number) and searches DB + pokemontcg.io
6. Results returned sorted by card number match; user selects card
7. PriceCharting scraped for prices, sales, trend graph (Redis cached)

## Known Issues
- Background text isolation (keyboard keys, shelf labels) is unreliable in single-card mode. The overlay-zone block filter approach has coordinate mapping complexity across devices. Deferred — the multi-card approach will supersede it.
- On-device YOLO detection (`mobile/utils/yoloDetector.ts`) is scaffolded but disabled — `detectCardsWithYolo` always returns null until `card_detector.tflite` is present. TFLite model export was attempted but not completed; falls back to backend `/detect`.
- Image AI mode similarity scores for some cards (e.g. Lotad) are around 0.43 — below the `_SIM_FLOOR = 0.50` cutoff, so they return no image candidates. Combined/OCR mode reliably identifies these cards. Image AI works best for visually distinctive cards.

## Completed Features (Multi-card)
- Camera mode: capture full image → OCR → detect card regions → crop each → re-OCR → confidence check → batch search backend → results UI
- `useMultiCardScan` hook orchestrates the full pipeline
- `multi-results.tsx`: shows all identified cards with image/name/set/number; query used shown per card (`🔍 Name #N`); "Swap" button to choose alternate candidates
- `POST /api/v1/search/batch` backend endpoint: accepts up to 10 queries, returns candidates per query (legacy; superseded by `/scan`)
- `detectCardRegions` in `mobile/utils/detectCards.ts`: adaptive threshold clustering + recursive aspect-ratio splitting
- Frontend dedup: cards with the same top-candidate ID are deduplicated before showing results
- `POST /api/v1/detect` endpoint: accepts base64 image, returns bounding boxes — YOLO11n (OpenCV fallback if model absent)
- **Recognition Mode toggle** (OCR / Image AI / Combined) — scanner screen lets user switch modes; `useMultiCardScan` accepts `scanMode: 'ocr' | 'image' | 'combined'`
- **Combined mode**: runs OCR and image matching in parallel, merges results with Reciprocal Rank Fusion. OCR gets 2× weight. Image results are gated out when OCR found a confident result and image similarity < 0.83 — weak image signal is worse than no image signal when OCR already has an answer. Shows per-card source badge (Both ✓ / Image AI / OCR) in results UI.
- **Combined mode RRF detail**: `score = weight/(rank+60)` — OCR weight=2, image weight=1. After merge, candidates matching the OCR card number are promoted to front. Image gate: skipped if OCR found a name and `image_sim < 0.83`.
- **Card number region augmentation**: full-image OCR blocks (already computed) are spatially filtered to the bottom 22% of each detected card crop and appended to the crop's OCR text before backend search — zero extra OCR calls, improves card number extraction when the crop-level OCR misses it.
- **Set printed-total ranking**: `_dedupe_and_rank` in `card_matcher.py` uses `backend/app/data/set_printed_totals.json` (172 sets, fetched from pokemontcg.io `/v2/sets`) to boost cards from sets whose `printedTotal` matches the denominator read from the card (e.g. `/111` → sm4 Crimson Invasion). This disambiguates cards that share a name and number across multiple sets.
- **Fuzzy name matching**: `_search_db` falls back to `pg_trgm` `similarity() > 0.35` when exact `ilike` returns nothing — handles OCR misreads like "Lotacl" → Lotad, "Sulcune" → Suicune.
- **Unified `/scan` endpoint with streaming** — see below.

## Completed Features (Unified Scan Endpoint + Streaming)
Replaces the previous 3-call pipeline (`/detect` → `/search/batch` + `/match-image`) with a single streaming endpoint.

**`POST /api/v1/scan`** — `backend/app/api/v1/scan.py`
- Accepts: `{ crops: [base64, ...], ocr_hints: [{raw_text, language, game}, ...], scan_mode: "ocr"|"image"|"combined" }`
- Returns: NDJSON stream — one JSON object per crop emitted as it completes
- Flow:
  1. Batch CLIP embed all crops in a **single forward pass** (`embed_batch`)
  2. Parallel pgvector nearest-neighbor searches for all crops (`asyncio.gather`)
  3. Parallel OCR searches for all crops (`asyncio.gather`)
  4. Per-crop RRF merge → streamed as NDJSON (`application/x-ndjson`)
- Image search results cached by SHA-256 of crop bytes (1h TTL) — cache checked before embedding

**Mobile streaming client** — `api.scanStream()` in `mobile/services/api.ts`
- Uses XHR `onprogress` to parse NDJSON incrementally as bytes arrive
- Calls `onResult(item)` for each complete line — UI updates card-by-card without waiting for all crops
- `useMultiCardScan` calls `appendMultiScanCard` per streamed result → `multi-results.tsx` populates progressively

**On-device YOLO detection stub** — `mobile/utils/yoloDetector.ts`
- `detectCardsWithYolo()` is called first in the pipeline before falling back to backend `/detect`
- Currently returns `null` (disabled) — TFLite model export was attempted but `card_detector.tflite` was not produced
- When a `.tflite` model is present, this function would run inference on-device and skip the `/detect` network call entirely

## Completed Features (Image Embedding)
Image-based card identification as an alternative to OCR text search. Inspired by SKANIT's approach.

**What an embedding is:** CLIP looks at a card image and outputs 512 numbers representing its visual appearance. Cards that look similar produce similar vectors. At scan time, a phone photo crop is converted to its own vector and pgvector finds the closest stored card — that's the match. No text needed, purely visual.

**Current state — CLIP ViT-B/32:**
- CLIP converts each card image to a 512-dim L2-normalized vector
- Art-region crop applied before embedding (`y=12%–52%`) to focus on Pokémon illustration, not border/text
- Embeddings stored in pgvector (`cards.embedding vector(512)`), IVFFlat index (`lists=100`)
- CLIP runs on GPU (RTX 3080) when available — `card_embedder.py` detects CUDA automatically
- **Known limitation (domain gap):** CLIP was trained on general internet images, not (phone photo, card art) pairs. It understands visual categories ("small round green creature") not specific card identity — confuses visually similar Pokémon (Lotad vs Seedot). Works best as a supplementary signal in Combined mode when OCR also fires.

**Coverage:** 20,187 of 20,237 Pokemon EN cards embedded (99.8%).
- 50 unembeddable: McDonald's Collection promos (mcd14/15/17/18), `hsp-HGSS18`, `svp-102` — pokemontcg.io CDN returns 404 for these
- DB previously had duplicate rows (catalog inserted twice) — deduplicated 2026-05-18; `embedding_failures.json` reflects current clean state

**Similarity thresholds** (in `backend/app/api/v1/scan.py`):
- `_SIM_THRESHOLD = 0.65` — confident match; shows "Image AI" badge
- `_SIM_FLOOR = 0.50` — minimum to show any candidates; 0.50–0.65 shows "Image ?" badge with swap available
- Below `_SIM_FLOOR`: no image candidates returned (too unreliable)
- `_PHASH_STRONG = 20` Hamming distance — phash match promotes result regardless of CLIP score
- `_IMAGE_MIN_SIM_WITH_OCR = 0.83` — in combined mode, image results excluded when OCR found a result and image sim < 0.83

**Offline pipeline:** `scripts/build_embeddings.py`
- Fetches all cards from pokemontcg.io API (~82 pages)
- Matches to local Kaggle dataset by set name slug + card number extraction (handles inconsistent filename formats across sets)
- Falls back to downloading `image_url` for unmatched cards
- Stores embeddings, creates IVFFlat index (`lists=100`)
- Safe to re-run — skips already-embedded cards unless `--force`
- Writes failure report to `backend/models/embedding_failures.json`

**Re-running:** safe — skips already-embedded cards unless `--force`.

## Completed Features (YOLO Card Detection)
### Multi-card region detection — fine-tuned YOLO11n

**Decision:** Replaced OpenCV contour detection with a fine-tuned YOLO11n model. OpenCV struggles with holofoil surfaces, touching/overlapping cards, and cards on busy backgrounds. YOLO learns the physical card appearance and is robust to these cases.

**Architecture:**
- Model: YOLO11n (nano) — 5.5MB, runs on CPU in 30–50ms, no GPU needed
- Library: `ultralytics==8.4.51` (v8.3+ includes YOLO11)
- Single class: `card`
- Inference runs inside the existing FastAPI container — no new infrastructure
- `/api/v1/detect` endpoint response format unchanged; only `card_detector.py` internals change
- Deployed to `backend/models/card_detector.pt`; loaded lazily on first detect call

**Detection flow:**
1. Resize image to 1600px wide
2. OCR full image + read base64 **in parallel**
3. `POST /api/v1/detect` → YOLO inference → returns bounding boxes in image-pixel coordinates
4. If boxes returned: use them directly as crop regions (`boxesToRegions`)
5. If none returned or network fails: fall back to `detectCardRegions` (OCR clustering)
6. Crop each region (5% margin) → re-OCR → confidence check → batch search

**Training — completed 2026-05-17:**

Dataset assembled from 3 sources, converted and merged via `scripts/coco_to_yolo.py` + `scripts/merge_yolo_datasets.py`:
| Source | Images | Format | Notes |
|---|---|---|---|
| Own photos (Roboflow, auto-labeled) | 221 | COCO → YOLO | Cards on desk, various angles, holo/non-holo |
| TCG Detector (Roboflow universe) | 576 | YOLO11 polygon | Single class `trading-card`, CC BY 4.0 |
| Aaron's Raw Photos (Roboflow universe) | 891 | YOLO11 OBB | Multi-class per set → collapsed to `card`, CC BY 4.0 |
| **Total merged** | **1,688** | YOLO bbox | 80/20 train/val split, all classes → class 0 `card` |

Training config:
- Base model: `yolo11n.pt` (pretrained on COCO, 80 classes)
- Epochs: 50, imgsz: 640, batch: 16, optimizer: auto
- Hardware: AMD Ryzen 5 5600X (CPU only)
- Duration: **3.68 hours**

Training results (loss progression):
| Epoch | Box loss | Cls loss | DFL loss | mAP50 | mAP50-95 |
|---|---|---|---|---|---|
| 12 | 0.519 | 0.454 | 0.962 | — | — |
| 18 | 0.458 | 0.387 | 0.933 | 0.985 | 0.849 |
| 31 | 0.356 | 0.284 | 0.897 | — | — |
| 42 | 0.333 | 0.244 | 0.863 | — | — |
| **50 (final)** | **0.293** | **0.203** | **0.840** | **0.992** | **0.904** |

Final validation on `best.pt`:
- **mAP50: 0.992** (target: >0.85)
- **mAP50-95: 0.904** (target: >0.70)
- **Precision: 0.977**
- **Recall: 0.985**
- Inference speed: 33.9ms per image on CPU

Scripts:
- `scripts/coco_to_yolo.py` — converts Roboflow COCO export to YOLO bbox format
- `scripts/merge_yolo_datasets.py` — merges multiple YOLO datasets (handles standard bbox, OBB, and polygon formats), remaps all classes to single class 0 `card`

## In Progress
### On-device YOLO detection (TFLite)
- `mobile/utils/yoloDetector.ts` stub is in place; `detectCardsWithYolo()` is called first in the pipeline
- Blocked on exporting `card_detector.pt` → `card_detector.tflite` (YOLO11n TFLite export was attempted but not completed)
- When `.tflite` is available: drop it in `mobile/assets/` (or bundle path), update `yoloDetector.ts` to run inference with `react-native-fast-tflite` or similar, eliminates the `/detect` network round-trip entirely
- Export command: `from ultralytics import YOLO; YOLO('backend/models/card_detector.pt').export(format='tflite', imgsz=640)`

### YOLO11n second fine-tuning round (optional)
**Current state:** YOLO11n deployed and active. First training run achieved mAP50=0.992 on combined dataset. May benefit from additional real-world photos (display cases, varied lighting).

**If retraining:**
- Add display case photos and varied lighting to address any gaps
- Label in Roboflow (one class: `card`), export YOLOv11 format
- Run `scripts/merge_yolo_datasets.py` to combine with existing dataset
- Train: `python -c "from ultralytics import YOLO; YOLO('yolo11n.pt').train(data='data.yaml', epochs=50, imgsz=640)"`
- Deploy: copy `runs/detect/train/weights/best.pt` → `backend/models/card_detector.pt`, restart container

## OCR Name Extraction (card_matcher.py)

### How `_find_pokemon_name` works
1. Find the HP line (`HP_RE`) as an anchor — name must be at or before it
2. If HP found: search lines `0..hp_idx` (cap 6). If HP absent: search all lines
3. For each candidate line:
   - Strip inline HP value (`"Lotad HP 40"` → `"Lotad"`)
   - Strip leading non-name prefixes (`"BASIC Lotad"` → `"Lotad"`)
   - Reject: < 3 chars, > 3 words, contains digit, contains `.,!?;:()/\'`, starts lowercase, all-caps (len > 3), any word in non-name list
   - **When no HP anchor**: reject if next line matches `_ATTACK_BODY_RE` (starts with "put", "this attack", "flip", etc.) — prevents attack names from adjacent card crops being accepted
   - **Final gate**: reject if candidate doesn't contain a known Pokémon base name (`_contains_pokemon_name`) — cross-references `_EN_POKEMON_NAMES_NORM` built from `KANA_TO_EN.values()`; tokenizes on whitespace and checks unigrams + bigrams so "Charizard VMAX" passes on "charizard", "Tapu Koko V" passes on bigram "tapu koko"; Trainer/Supporter/Item cards return no name (deferred)

### Non-name prefix list (`_POKEMON_NON_NAME_RE`)
Covers: BASIC and OCR misreads (`BASIG`, `BASIQ`, `GASIC`, `GASIS`, `[gb]asi[cgsq]`), Stage 1/2, Mega, Weakness, Resistance, Retreat, Damage, Ability, Trainer, Item, Stadium, Supporter, Energy types, Pokémon, Nintendo, Game Freak, Creatures, Illus., No., Copyright, Overrun, Aurora, Beam, HP

Note: VMAX/VSTAR/VUNION intentionally **not** in this list — they are valid name suffixes (e.g. "Charizard VMAX"). Standalone "VMAX" is rejected by the all-caps rule instead.

### Search strategy (`_search_db`)
1. Name + card number (preferred)
2. Number only (only when name is also present, as fallback)
3. Name only
- Number-only search without a name is disabled — too many false matches across sets
- External API (pokemontcg.io) only called when `probable_name` exists

### Card format support
All of the following are correctly extracted and searched:
- Base, Holo, Full Art (same name, no format difference)
- Alolan / Galarian / Hisuian / Paldean forms (2-word names)
- EX / ex, GX (`Charizard-GX`), V, VMAX, VSTAR, VUNION
- Tag Team (`Pikachu & Zekrom-GX`)

## Next Steps

### 1. Image matching improvement roadmap

**Current state:** CLIP ViT-B/32, 512-dim, art-region crop (y=12%–52%), similarity threshold 0.75, phash re-ranking. Works for visually distinctive cards; unreliable for similar-looking Pokémon.

**Step 1 (now): Assess phash + crop changes**
- Test real scans with tighter crop (`y=12%–52%`), threshold 0.75, and phash Hamming re-ranking
- Watch for: fewer wrong-card results, any correct cards being missed (threshold too aggressive)
- phash logs show `hamming=N` per candidate — tune `_PHASH_STRONG` in `match_image.py` if needed

**Step 2 (if still unreliable): DINOv2 / DINOv3 (research evaluation only)**
- Both use dense patch-level matching better suited to card identity than CLIP's global embedding
- **DINOv2** — GitHub: `https://github.com/facebookresearch/dinov2` | License: CC BY-NC 4.0 — non-commercial only, cannot be used in a released app
- **DINOv3** — GitHub: `https://github.com/facebookresearch/dinov3` | License: Custom Meta access-gated license — non-commercial only, requires access request for weights; fine-tuning is unproven (model is very new)
- Both can be evaluated locally for research/personal benchmarking against CLIP — do not ship either in a public release
- Fine-tuning approach (if attempted): same contrastive method as CLIP fine-tuning below

**Step 3a: Synthetic augmentation fine-tuning ✦ IN PROGRESS — see v9 in Architecture Decision Log**
- Script running: `scripts/fine_tune_clip.py`, output to `backend/models/clip_finetuned.pt`
- 82,964 pairs/epoch (20,741 cards × 4 augmentations), 10 epochs, RTX 3080, ~15hr total
- After completion: run `build_embeddings.py --force` to re-embed all 20k cards
- **File size / performance**: no change — fine-tuning doesn't alter architecture. Same ~170MB fp16 weights, identical inference speed
- **Expected improvement**: meaningful gains for matte cards (common/uncommon). Holofoil/rainbow cards will still struggle — reflective surfaces produce visual appearances essentially impossible to synthesize convincingly
- **Realistic outcome**: probably closes the gap for non-holo cards (possibly 0.90+), leaves holo/full-art accuracy similar to today. Non-holo cards are well-covered by OCR anyway, so image AI fills the gap where OCR fails

**Step 3b (if 3a is insufficient): Fine-tune CLIP ViT-B/32 with real photos ✦ Safe for release**
- CLIP via `open-clip-torch` is MIT licensed — fully permissive for commercial release
- Collect real labeled photos of physical cards (single card per photo, labeled with card ID)
- SKANIT context: dev said ~50,000 images and 6 months — that's real data at scale across thousands of distinct cards. 300 real photos covering ~200–300 cards would overfit to those cards and generalize poorly to the other 19,700+
- Realistic minimum for general robustness: thousands of photos spanning hundreds of sets, including holo/special cards
- Pair each photo with the card's official art from `image_url`; fine-tune with InfoNCE contrastive loss
- Can combine with synthetic augmentation (3a) — real photos anchor to actual appearance, synthetic provides broad coverage
- Re-embed all 20k cards after fine-tuning

**On-device inference (SKANIT-style, no backend)**
- CLIP ViT-B/32 at ~170MB fp16 is too large to bundle in a mobile app
- Would require distilling the fine-tuned CLIP into a compact model: MobileClip or SigLIP-Small (~20–50MB)
- Distillation adds significant additional work after fine-tuning and requires further accuracy trade-off evaluation
- Not worth pursuing until fine-tuned CLIP accuracy is validated on the backend first

**License summary for image models:**
| Model | License | App release |
|---|---|---|
| CLIP (open-clip-torch) | MIT | Yes |
| DINOv2 | CC BY-NC 4.0 | No |
| DINOv3 | Custom (access-gated) | No |
| YOLO11n (ultralytics) | AGPL-3.0 | Yes (with attribution) |

### 2. Multi-card batch recognition (in progress — testing OpenCV detection)
- Scan a display case with many cards visible
- Detect individual card bounding boxes, crop, OCR, price each one
- UI to review all detected cards at once

### 4. Japanese card support
- Japanese OCR already works (ML Kit Japanese script)
- Kana→English name mapping built and stored in `backend/app/data/pokemon_kana_to_en.json` (1028 entries, all gens including Gen X: Browt #1026, Pombon #1027, Gecqua #1028)
- Loader: `backend/app/data/pokemon_names.py` — `kana_to_english(kana: str) -> str | None`, loaded once at import
- Source: Bulbapedia List of Japanese Pokémon names, Kana column mapped to English; all names are katakana
- Full list with ndex also at `backend/app/data/pokemon_names_ja.json`
- ✅ Wired: `card_matcher.py` branches on `language == "ja"` — `_find_kana_name` scans OCR lines against `KANA_TO_EN` (exact then substring), translates to English, stores as `probable_name` for DB/API search
- Stage label filter: `_JA_NON_NAME = {"たね", "1進化", "2進化", "ステージ1", "ステージ2"}` — skipped before lookup
- Card number and set total extraction is language-agnostic (digits/slash format is the same on Japanese cards)
- ✅ `_search_db` uses `language="en"` for Japanese Pokemon scans (all cards stored as EN; kana→EN translation gives English name to search)
- ✅ `_search_external` skipped for Japanese scans (pokemontcg.io has no Japanese card data)
- ✅ PriceCharting URL uses `pokemon-japanese-{set_slug}` prefix for Japanese scans via `language_override` passed through `GET /cards/{id}?language=ja`
- ✅ Price cache key includes language to avoid EN/JA collision (`{pc_id}:{scan_type}:{language}`)
- ✅ `price.pricecharting_url` used for "View on PriceCharting" link (was `card.pricecharting_url` which is null for API-upserted cards)
- **Known limitation**: PriceCharting Japanese set slug is derived from the English set name (e.g., "Scarlet & Violet" → `pokemon-japanese-scarlet-violet`). PriceCharting may use a different slug for some Japanese sets — these will return no pricing data
- Special cases (Tag Team, regional forms in Japanese) deferred

#### Japanese card images ✅
Japanese scans show the Japanese card art instead of the English art. Lookup is display-only — identification still uses OCR (kana→EN) + English DB records.

**Data source: TCGCollector.com**
- 27,255 Japanese cards, all eras from 1996 → present (Base Set through current SV sets)
- Scraped with Playwright (headed Chromium to bypass Cloudflare) — `scripts/scrape_tcgcollector.py`
- Output: `backend/app/data/tcgcollector_ja.json` — list of `{name_en, set_name, card_number, set_total, image_url, card_id}`
- `set_total` is extracted from fraction-format card numbers (e.g. `001/029` → set_total=29); used for disambiguation
- pokemon-card.com data (`ja_images.json`, SV era only, 6,851 entries) retained as fallback

**Lookup service: `backend/app/services/ja_image_lookup.py`**
- Primary: TCGCollector index keyed by English name (lowercased)
- Inputs: `kana_name` (OCR) → translated to English via `kana_to_english()`, plus optional `set_total` and `card_number`
- Match priority: (name + set_total + card_number) → (name + set_total) → (name + card_number) → first by name
- Fallback: pokemon-card.com data (kana_name + set_total match)
- `card_number` (numerator from OCR, e.g. "172" from "172/742") is now extracted in `useMultiCardScan` and threaded through route params → `api.getCard()` → backend

**PriceCharting Japanese URL**: `build_game_url` uses `pokemon-japanese-{set_slug}` prefix when `language="ja"`. `card_matcher.py` forces this path whenever `language_override="ja"` regardless of the stored card URL.

**Known limitation**: Japanese-exclusive cards (promos, sets with no English release) have no English DB entry, so identification fails for those. Image AI for Japanese-exclusive cards is deferred — low priority for US use cases.

**Re-scraping**: `py -3 scripts/scrape_tcgcollector.py --output-dir backend/app/data` (resumable with `--start-page N`). Stops automatically when page returns 0 cards or >50% duplicate card IDs (loop detection). After re-scraping, restart backend to reload data.

### 5. PSA graded card recognition via camera
- Target: Japanese card shops that cover cert numbers with price stickers
- Visible information: card name/art, PSA grade label (usually not stickered)
- Approach: read grade from label + card name → look up PSA population report to narrow cert candidates
- May require PSA pop report scraping

## Key Files
- `mobile/hooks/useOCR.ts` — image preprocessing, OCR, zone block filtering (single-card)
- `mobile/hooks/useMultiCardScan.ts` — multi-card pipeline: detect → crop → re-OCR or image match → results; accepts `scanMode: 'ocr' | 'image' | 'combined'`; RRF merge in combined mode
- `mobile/utils/detectCards.ts` — `filterBlocksToCardZone` (single), `detectCardRegions` (fallback), `boxesToRegions` (converts backend boxes)
- `mobile/utils/cardConfidence.ts` — single-card confidence scoring
- `mobile/services/api.ts` — `api.detectCards()`, `api.batchSearch()`, `api.batchMatchByImage()`, `api.scanStream()` (streaming unified scan), all API calls
- `mobile/utils/yoloDetector.ts` — `detectCardsWithYolo()` stub; returns null until `card_detector.tflite` is present
- `mobile/components/Scanner/ScanOverlay.tsx` — scan frame dimensions (75% W, 88/63 ratio, -40px Y)
- `mobile/components/UI/ScanModeToggle.tsx` — OCR / Image AI / Combined toggle component
- `mobile/components/Card/PriceChart.tsx` — trend graph
- `backend/app/services/card_detector.py` — OpenCV card outline detection (`detect_card_rectangles`)
- `backend/app/services/card_embedder.py` — CLIP ViT-B/32 embedding (fine-tuned weights loaded from `backend/models/clip_finetuned.pt` if present)
- `backend/app/services/ja_image_lookup.py` — Japanese card image lookup: TCGCollector primary (27,255 cards), pokemon-card.com fallback (SV era); keyed by English name + set_total + card_number
- `backend/app/api/v1/scan.py` — `POST /api/v1/scan` unified endpoint: batch CLIP embed + parallel pgvector + parallel OCR + NDJSON stream
- `backend/app/api/v1/detect.py` — `POST /api/v1/detect` endpoint
- `backend/app/data/tcgcollector_ja.json` — 27,255 JP card entries scraped from TCGCollector.com (all eras 1996–present)
- `backend/app/scrapers/pricecharting.py` — PriceCharting scraper
- `backend/app/services/card_matcher.py` — search orchestration, ranking, price caching
- `backend/app/data/pokemon_kana_to_en.json` — kana→English name dict (1028 entries)
- `backend/app/data/pokemon_names_ja.json` — full list with ndex + english + kana
- `backend/app/data/pokemon_names.py` — `kana_to_english()` loader
- `backend/app/data/set_printed_totals.json` — 172 sets mapped to `printedTotal` (fetched from pokemontcg.io `/v2/sets`); used by `_dedupe_and_rank` to disambiguate cards sharing a name/number across sets
- `backend/models/embedding_failures.json` — current embedding state: 20,187 embedded, 50 unembeddable (McDonald's promos), 0 failures
- `scripts/build_embeddings.py` — offline pipeline: pokemontcg.io fetch → local image match → CLIP embed → pgvector store
- `scripts/coco_to_yolo.py` — converts Roboflow COCO export to YOLO bbox format with train/val split
- `scripts/merge_yolo_datasets.py` — merges multiple YOLO datasets (handles standard bbox, OBB, polygon), remaps all classes to single class 0 `card`
- `scripts/retry_failures.py` — retries failed card embeddings by downloading from CDN directly

## Architecture Decision Log

A chronological record of major technical decisions, for portfolio and reference purposes.

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

### v9 — CLIP ViT-B/32 synthetic augmentation fine-tuning (in progress)
- Fine-tuning CLIP visual encoder on (clean official art crop, augmented simulated photo) pairs to close the domain gap between training data and real phone photos of physical cards
- Augmentation pipeline: paste card onto random background texture → perspective warp → color jitter → gaussian blur → JPEG compression → art-region crop (`y=12%–52%`)
- 5 background textures: black cloth, black gray, gray white, gray, white linen (tablecloth photos in `background-textures/`)
- 20,741 card images × 4 augmented pairs = 82,964 pairs per epoch; 10 epochs planned
- Only visual encoder fine-tuned (87.8M params); text encoder frozen
- InfoNCE contrastive loss, temperature=0.07, AdamW lr=1e-5, cosine LR schedule
- Script: `scripts/fine_tune_clip.py`; output: `backend/models/clip_finetuned.pt`
- `card_embedder.py` auto-loads fine-tuned weights at startup if `backend/models/clip_finetuned.pt` exists
- `docker-compose.yml`: added `shm_size: 2gb` for backend container (required for PyTorch DataLoader workers), added `./background-textures:/backgrounds:ro` volume mount
- Training on RTX 3080 (GPU); ~6-9s/batch with 4 DataLoader workers, ~1.5hr/epoch, ~15hr total
- **Monitor training:** `docker exec -it tcg_backend tail -f /tmp/finetune.log`
- **After training:** run `python scripts/build_embeddings.py --dataset /pokemon-tcg --force` to re-embed all 20k cards with fine-tuned weights
- ✅ **Training complete** — 2026-05-18, ~13 hours total
- ✅ **Re-embedding complete** — 20,187 cards re-embedded with fine-tuned weights, IVFFlat index rebuilt, backend restarted and serving fine-tuned embeddings
- 50 unembeddable (McDonald's promos CDN 404), 63 embed_failed (same as before), 1 download_failed — no new failures

#### Epoch training log
| Epoch | Loss | LR | Duration | Completed |
|-------|------|----|----------|-----------|
| 1 | 0.0255 | 9.76e-06 | 78 min | 2026-05-18 06:32 UTC |
| 2 | 0.0098 | 9.05e-06 | 77 min | 2026-05-18 07:49 UTC |
| 3 | 0.0099 | 7.96e-06 | 78 min | 2026-05-18 09:08 UTC |
| 4 | 0.0095 | 6.58e-06 | 78 min | 2026-05-18 10:26 UTC |
| 5 | 0.0088 | 5.05e-06 | 76 min | 2026-05-18 11:42 UTC |
| 6 | 0.0080 | 3.52e-06 | 77 min | 2026-05-18 12:59 UTC |
| **7 ★** | **0.0077** | 2.14e-06 | 77 min | 2026-05-18 14:16 UTC |
| 8 | 0.0081 | 1.05e-06 | 77 min | 2026-05-18 15:33 UTC |
| 9 | 0.0083 | 3.42e-07 | 79 min | 2026-05-18 16:52 UTC |
| 10 | 0.0081 | 1.00e-07 | 82 min | 2026-05-18 18:14 UTC |
| **Best** | **0.0077** | — | — | **Epoch 7 — saved to `backend/models/clip_finetuned.pt`** |
