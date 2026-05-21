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

### PriceCharting JP card numbering — older vs newer sets

PriceCharting uses **two different numbering systems** for Japanese cards depending on era:

- **Older sets** (pre-EX era, roughly pre-2003): PriceCharting uses the **Pokédex number** as the card identifier, not the card's position number within the set. Example: Sabrina's Gastly is #49 in "Challenge from the Darkness" but PriceCharting lists it as `gastly-92` (Gastly's Pokédex number is 92).
- **Newer sets** (EX era onward): PriceCharting uses the **card number within the set** (matching the printed `N/total` format), which is what our current `build_game_url` function constructs.

**Impact**: For older JP sets, the `build_game_url` output will produce a wrong URL (e.g. `sabrina-s-gastly-49` instead of `gastly-92`). PriceCharting price fetches will 404 or return the wrong card for these sets. No fix has been applied — this affects a small minority of old sets and would require a lookup table or scrape-based URL discovery to resolve.

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

> ⚠️ Single-card mode is **disabled** as of v10 — the scanner button always launches multi-card mode. This flow still exists in code but has no UI entry point.

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

### Japanese card swap propagation — RESOLVED (v11, 2026-05-20)

All swap candidates now show the correct JP art because JP cards are first-class DB records (`language='ja'`). Each candidate's `card.image_url` IS the correct JP art from TCGCollector — no overlay lookup, no name matching, no EN/JP number translation needed.

**Root cause (historical)**: EN and JP card numbers are completely different numbering systems. EN sets combine and reorder multiple JP sets alphabetically (EN "BREAKthrough" Doduo #115 ≠ JP "Collection Y" Doduo #46). The old overlay approach tried to map EN card numbers to JP TCGCollector entries and fell back to the first-by-name JP entry when unmatched — always returning "Shiny Doduo" (the newest JP Doduo in scrape order) for all Doduo variants. Fixed by loading JP cards as independent DB records.

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
- **Auto per-crop language detection**: OCR always runs with `TextRecognitionScript.JAPANESE` (returns both Latin and kana in one pass). Kana presence (2+ consecutive chars `/[゠-ヿぁ-ゖ]{2,}/`) determines language per crop — no user toggle needed. A single scan correctly identifies mixed EN+JP cards from the same photo. `LanguageToggle` UI component removed; `language` state removed from `scanStore`. `batch_prices` endpoint uses `card.language` per record so mixed EN+JP batches price correctly.
- **Owner-prefix Pokémon cards**: `_find_pokemon_name` strips possessive `'s` into a `clean_for_punct` variable before the punctuation gate, so "Misty's Staryu" and "Sabrina's Gastly" are accepted. JP owner-prefix cards (e.g. `R団のミュウツー`, `ロケット団のミュウツー`) are handled by `_find_kana_name` substring matching — the kana Pokémon name is found as a substring of the full `の`-format line regardless of the owner prefix.
- **Trainer / Supporter / Item / Tool card support**: `_find_trainer_name(lines)` in `card_matcher.py` locates the standalone type keyword (e.g. "Supporter"), looks 1–2 lines above for the card name, strips parenthetical subtitles ("Professor's Research (Professor Magnolia)" → "Professor's Research"), and applies the same apostrophe-tolerant punctuation check. `extract_card_hints` falls back to it when `_find_pokemon_name` returns None — no `_contains_pokemon_name` gate. Mobile `cardConfidence.ts` fast-passes any crop with a standalone EN type keyword (score=10, `isCard=true`) before HP/keyword scoring. JP trainer cards pass via `JA_KEYWORD_RE` scoring (グッズ, サポート, スタジアム). JP trainer name extraction not yet implemented.
- **Name region sub-crop OCR** (`useMultiCardScan.ts`): after confidence passes, sub-crops the top 18% (5–95% width) of each card crop and runs a second OCR pass. `rawText` sent to backend = name-region text + card number from bottom corners. Eliminates attack text and flavor text from name extraction input. Also fixes EN-card-as-JP misdetection: `cropLang` is re-detected from the name region (which has no flavor text kana misreads), so EN cards with kana-like flavor text OCR misreads are correctly classified as EN.
- **Card number spatial filter tightened**: `augmentWithNumberRegion` now checks bottom 8% (was 22%) of the card, split into left-corner (x 0–35%) and right-corner (x 65–100%) separately. Prefers whichever corner matches `\d+/\d+`. Eliminates flavor text hits.
- **Camera capture quality**: `quality: 1` (was 0.92), `skipProcessing: true` (was false). Resize target raised to 2400px wide (was 1600px). Intermediate card crops and name sub-crops saved as PNG (lossless) for OCR; only the base64 payload to the backend is re-encoded as JPEG 0.92 to keep network size manageable.
- **Kana false-positive fix**: `KANA_RE` changed from single-char match to `{2,}` consecutive kana required to classify a crop as JP. Prevents a single stray kana character (OCR misread from adjacent JP card bleed or decorative symbol) from misfiring language detection on EN cards.
- **Backend JP→EN OCR fallback** (`scan.py`): if `language='ja'` OCR search returns no candidates, automatically retries with `language='en'`. Handles EN cards whose flavor text is misread as kana by `TextRecognitionScript.JAPANESE`, causing `cropLang` to flip to `'ja'` on the mobile before Priority 2 (name region) corrects it.

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

| Source                                 | Images          | Format         | Notes                                                   |
| -------------------------------------- | --------------- | -------------- | ------------------------------------------------------- |
| Own photos (Roboflow, auto-labeled)    | 221             | COCO → YOLO   | Cards on desk, various angles, holo/non-holo            |
| TCG Detector (Roboflow universe)       | 576             | YOLO11 polygon | Single class `trading-card`, CC BY 4.0                |
| Aaron's Raw Photos (Roboflow universe) | 891             | YOLO11 OBB     | Multi-class per set → collapsed to `card`, CC BY 4.0 |
| **Total merged**                 | **1,688** | YOLO bbox      | 80/20 train/val split, all classes → class 0 `card`  |

Training config:

- Base model: `yolo11n.pt` (pretrained on COCO, 80 classes)
- Epochs: 50, imgsz: 640, batch: 16, optimizer: auto
- Hardware: AMD Ryzen 5 5600X (CPU only)
- Duration: **3.68 hours**

Training results (loss progression):

| Epoch                | Box loss        | Cls loss        | DFL loss        | mAP50           | mAP50-95        |
| -------------------- | --------------- | --------------- | --------------- | --------------- | --------------- |
| 12                   | 0.519           | 0.454           | 0.962           | —              | —              |
| 18                   | 0.458           | 0.387           | 0.933           | 0.985           | 0.849           |
| 31                   | 0.356           | 0.284           | 0.897           | —              | —              |
| 42                   | 0.333           | 0.244           | 0.863           | —              | —              |
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

### YOLO11n synthetic augmentation retraining (v2 — complete ✅, 2026-05-20)

**Goal:** Improve detection for display cases (glass background) and large card spreads (8–20 cards). Current model is strong on desk scans (mAP50=0.992) but training data had no display case photos or groups larger than ~8 cards.

**Approach:** Synthetic compositing — paste card images onto background photos with known bounding boxes. No manual labeling needed. Fine-tune from `card_detector.pt` (not base `yolo11n.pt`) to preserve real-photo learning and avoid catastrophic forgetting.

**Script:** `scripts/generate_synthetic_yolo.py`

**Card count distribution** (weighted toward middle range):
- 1–3 cards: 10% of images
- 4–7 cards: 35% of images
- 8–12 cards: 35% of images
- 13–17 cards: 15% of images
- 18–20 cards: 5% of images

**Card image sampling** (stratified from Postgres DB, `ORDER BY RANDOM()`):
- 45% EN Pokémon (`language='en'`, name excludes Supporter/Item/Trainer/Tool keywords)
- 40% JP (`language='ja'`)
- 15% EN Trainer/Item (`language='en'`, name contains type keywords or rarity=uncommon)
- Only cards with `image_url IS NOT NULL` and `embedding IS NOT NULL` are eligible
- 800 cards downloaded to `assets/card_images/` (cached — reused on subsequent runs)
- Rate-limited: 0.15s delay per request to avoid CDN bans (pokemontcg.io + TCGCollector)

**Glass display case simulation:** per-card blue-green tint + brightness reduction (simulates glass color cast, applied to 13% of scenes matching the 2/15 natural ratio of glass backgrounds). Real reflections not synthesized.

**Backgrounds:** 15 images in `assets/backgrounds/` — 2 glass display case photos, 13 other textures (wood, cloth, marble, shelf). `wood shelf with vase.jpg` excluded from glass-fraction selection.

**Dataset cleaning (applied to yolo_merged before v2 training):**
- Removed 27 set-symbol images (40×40px PNGs labeled as cards — from 3rd party Roboflow export)
- Removed 103 orphaned label files (corner crops, PSA slab photos deleted manually)
- Removed all PSA graded card slab images (different visual class; would require separate `slab` label)
- Final cleaned real dataset: 1,225 train + 304 val images
- German/multilingual cards kept — YOLO learns card shape, not card text
- Official clean card art (rotated synthetic) kept — teaches card shape at all orientations

**Merged dataset (yolo_v2_merged):**
- Real (cleaned yolo_merged): 1,225 train + 304 val
- Synthetic (synthetic_v1): 1,700 train + 300 val, avg 6.5 cards/scene
- **Total: 2,823 train (13,798 annotations) + 706 val (3,375 annotations)**
- Stored at: `C:\Users\Quang\Desktop\TCG Training Data\yolo_v2_merged\`

**Synthetic dataset stored at:** `C:\Users\Quang\Desktop\TCG Training Data\synthetic_v1\`
Keep permanently — merge with future real data on next retraining to avoid catastrophic forgetting.

**Training results (v2 — completed 2026-05-20, RTX 3080, ~1.5hr):**

| Epoch | Box loss | Cls loss | DFL loss |
|-------|----------|----------|----------|
| 1     | 0.5281   | 0.4664   | 0.9653   |
| 5     | 0.4380   | 0.3693   | 0.9008   |
| 10    | 0.3893   | 0.3348   | 0.8852   |
| 15    | 0.3495   | 0.2998   | 0.8702   |
| 20    | 0.3233   | 0.2776   | 0.8618   |
| 25    | 0.2598   | 0.2139   | 0.8147   |
| **30 (final)** | **0.2316** | **0.1915** | **0.8067** |

Final validation (all 30 epochs, loss still declining — no plateau):
- **mAP50: 0.993** (v1: 0.992)
- **mAP50-95: 0.964** (v1: 0.904 — +6.6%)
- **Precision: 0.977** (v1: 0.977)
- **Recall: 0.980** (v1: 0.985)
- GPU memory: 2.8G, batch=16, imgsz=640

**Deployed to `backend/models/card_detector.pt`** (v1 backup at `card_detector_v1_backup.pt`).

**To retrain next time:**
```
# 1. Generate new synthetic batch
py -3 scripts/generate_synthetic_yolo.py --cards assets/card_images/ --backgrounds assets/backgrounds/ --output "C:/Users/Quang/Desktop/TCG Training Data/synthetic_v2" --count 2000 --glass-fraction 0.13

# 2. Merge all datasets
py -3 scripts/merge_yolo_datasets.py --src "C:/TCG Training Data/yolo_merged" "C:/TCG Training Data/synthetic_v1" "C:/TCG Training Data/synthetic_v2" --dst "C:/TCG Training Data/yolo_v3_merged"

# 3. Copy into container, fix data.yaml path, train
```

**Future retraining:** merge `yolo_merged` + `synthetic_v1` + any new `synthetic_v2` → train from updated `card_detector.pt`. Never train on synthetic alone — always include real photos.

## OCR Name Extraction (card_matcher.py)

### How `_find_pokemon_name` works

1. Find the HP line (`HP_RE`) as an anchor — name must be at or before it
2. If HP found: search lines `0..hp_idx` (cap 6). If HP absent: search all lines
3. For each candidate line:
   - Strip inline HP value (`"Lotad HP 40"` → `"Lotad"`)
   - Strip leading non-name prefixes (`"BASIC Lotad"` → `"Lotad"`)
   - Reject: < 3 chars, > 3 words, contains digit, contains `.,!?;:()/\'`, starts lowercase, all-caps (len > 3), any word in non-name list
   - **When no HP anchor**: reject if next line matches `_ATTACK_BODY_RE` (starts with "put", "this attack", "flip", etc.) — prevents attack names from adjacent card crops being accepted
   - **Final gate**: reject if candidate doesn't contain a known Pokémon base name (`_contains_pokemon_name`) — cross-references `_EN_POKEMON_NAMES_NORM` built from `KANA_TO_EN.values()`; tokenizes on whitespace and checks unigrams + bigrams so "Charizard VMAX" passes on "charizard", "Tapu Koko V" passes on bigram "tapu koko"; Trainer/Supporter/Item cards return no name — see §6 in Next Steps for the planned fix

### Non-name prefix list (`_POKEMON_NON_NAME_RE`)

Covers: BASIC and OCR misreads (`BASIG`, `BASIQ`, `GASIC`, `GASIS`, `[gb]asi[cgsq]`), Stage 1/2, Mega, Weakness, Resistance, Retreat, Damage, Ability, Trainer, Item, Stadium, Supporter, Energy types, Pokémon, Nintendo, Game Freak, Creatures, Illus., No., Copyright, Overrun, Aurora, Beam, HP

Note: VMAX/VSTAR/VUNION intentionally **not** in this list — they are valid name suffixes (e.g. "Charizard VMAX"). Standalone "VMAX" is rejected by the all-caps rule instead.

### Search strategy (`_search_db`)

1. Name + card number (preferred)
2. Number only (only when name is also present, as fallback)
3. Name only

- Number-only search without a name is disabled — too many false matches across sets
- External API (pokemontcg.io) only called when `probable_name` exists

### Ranking within search results

Results are ranked by a priority column before the `LIMIT 10` cut:

- **Exact name match** (`Card.name.ilike(name)`) → priority 0; partial match (`ilike('%name%')`) → priority 1. Prevents "Sabrina's Gastly" ranking above "Gastly" when searching for "Gastly".
- **Card number match** → priority 0 when number matches, else 1
- **Set total match** (`Card.set_total == set_total`) → priority 0 when the OCR-read denominator matches the DB set total; boosts the correct set when multiple sets share a name+number
- **Tie-break**: `Card.id DESC` — newer catalog entries rank first within the same priority tier
- For `language='ja'` cards: `set_total` comes from the DB column directly; for EN cards it falls back to `set_printed_totals.json`

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
- phash logs show `hamming=N` per candidate — tune `_PHASH_STRONG` in `scan.py` if needed

**Step 2 (if still unreliable): DINOv2 / DINOv3 (research evaluation only)**

- Both use dense patch-level matching better suited to card identity than CLIP's global embedding
- **DINOv2** — GitHub: `https://github.com/facebookresearch/dinov2` | License: CC BY-NC 4.0 — non-commercial only, cannot be used in a released app
- **DINOv3** — GitHub: `https://github.com/facebookresearch/dinov3` | License: Custom Meta access-gated license — non-commercial only, requires access request for weights; fine-tuning is unproven (model is very new)
- Both can be evaluated locally for research/personal benchmarking against CLIP — do not ship either in a public release
- Fine-tuning approach (if attempted): same contrastive method as CLIP fine-tuning below

**Step 3a: Synthetic augmentation fine-tuning ✅ COMPLETE — see v9 in Architecture Decision Log**

- Training completed 2026-05-18 (~13 hours, 10 epochs, RTX 3080). Best checkpoint at epoch 7 (loss 0.0077).
- All 20,187 EN cards re-embedded with fine-tuned weights; IVFFlat index rebuilt.
- Weights at `backend/models/clip_finetuned.pt`; loaded automatically by `card_embedder.py` at startup.

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

| Model                  | License               | App release            |
| ---------------------- | --------------------- | ---------------------- |
| CLIP (open-clip-torch) | MIT                   | Yes                    |
| DINOv2                 | CC BY-NC 4.0          | No                     |
| DINOv3                 | Custom (access-gated) | No                     |
| YOLO11n (ultralytics)  | AGPL-3.0              | Yes (with attribution) |

### 2. Multi-card batch recognition ✅ COMPLETE

- YOLO11n detects card bounding boxes; each crop is OCR'd, confidence-gated, and searched via the unified `/scan` streaming endpoint
- Results displayed in `multi-results.tsx` with swap, select, and batch-price flows
- See Completed Features (Multi-card) and Completed Features (Unified Scan Endpoint + Streaming) for full detail

### 6. Trainer / Supporter / Item / Tool / Technical Machine card support ✅ COMPLETE (EN only)

EN Trainer/Supporter/Item/Tool cards are now identified. JP trainer name extraction not yet implemented (JP trainer cards pass confidence via `JA_KEYWORD_RE` but return 0 candidates from the backend).

**Known remaining edge cases:**
- Items with digits in the name (e.g. "Pokégear 3.0") — digit gate in `_find_trainer_name` rejects them
- JP trainer cards — `_find_kana_name` finds no kana Pokémon name on trainer cards; no `_find_jp_trainer_name` exists yet

### 7. Fixed proportional card region crops for OCR ✅ COMPLETE (2026-05-20)

Name region sub-crop (top 18%, 5–95% width) and tightened card number corners (bottom 8%, left/right separately) are both implemented in `useMultiCardScan.ts`. See Completed Features for detail.

### 4. Japanese card support — first-class JP records ✅ COMPLETE (2026-05-20)

JP and EN cards are fully independent entities. No overlay lookups, no shared card IDs.

#### What works now

- ✅ JP OCR: ML Kit Japanese script, kana→EN translation, searches `language='ja'` DB records directly
- ✅ JP image AI: pgvector searches `language='ja'` embeddings — 27,255 JP cards embedded
- ✅ Correct JP art for all candidates including swaps — `card.image_url` IS the JP art from TCGCollector
- ✅ JP-exclusive cards identifiable (promos, JP-only sets all in DB)
- ✅ JP card numbers are correct (from TCGCollector, not derived from EN numbering)
- ✅ PriceCharting URL uses JP set_name slug from the card's own DB record

#### TCGCollector data

- **27,255 JP cards** across 426 sets, all eras 1996–present
- Stored in `backend/app/data/tcgcollector_ja.json` and loaded into `cards` table as `language='ja'`
- Each card: `name_en`, `set_name`, `card_number`, `card_number_raw`, `set_total`, `image_url`, `external_id=tcgcollector-{card_id}`
- Data verified complete: no genuine gaps found after investigating TCGCollector's 27,300 count (45-card delta was false positives — word-order set name variant + one bad `set_total` field, both fixed)

#### Adding new sets (e.g. after a new JP release)

**Step 1 — Pull new cards from TCGCollector** (scrapes newest first, stops when hitting already-known cards):

```
py -3 scripts/scrape_tcgcollector.py --newest-first
```

Typical run: 1–3 pages scraped, stops automatically. Updates `backend/app/data/tcgcollector_ja.json` in-place.

**Step 2 — Load new cards into DB** (upsert — existing cards untouched):

```
docker exec tcg_backend bash -c "cd /app && python /scripts/load_jp_cards.py"
```

**Step 3 — Embed new cards** (skips already-embedded cards):

```
docker exec tcg_backend bash -c "cd /app && python /scripts/build_embeddings.py --language ja"
```

Rebuilds IVFFlat index automatically after embedding. Monitor: `docker exec tcg_backend tail -f /tmp/embed_ja.log`

**Step 4 — Restart backend:**

```
docker restart tcg_backend
```

**Finding a specific set's TCGCollector set ID** (needed if scraping a single set to fill gaps):
Run `py -3 scripts/_find_set_id.py` (create ad-hoc) using Playwright to browse `https://www.tcgcollector.com/sets/jp?releaseDateOrder=oldToNew`. Set URLs follow `/sets/{id}/set-slug`. Then scrape that set:

```
py -3 scripts/scrape_tcgcollector.py --base-url "https://www.tcgcollector.com/cards/jp?sets[]={id}&displayAs=image&sortBy=cardNumber"
```

#### OCR infrastructure (unchanged)

- kana→EN translation (`kana_to_english()`) still used to search `name_en` on JP records
- `_find_kana_name` in `card_matcher.py` extracts kana name from OCR text
- `_search_db` filters `Card.language == language` — EN and JP searches fully independent
- `_dedupe_and_rank` uses `c.set_total` directly for JP cards (DB field) instead of `set_printed_totals.json`

### 5. PSA graded card recognition via camera

- Target: Japanese card shops that cover cert numbers with price stickers
- Visible information: card name/art, PSA grade label (usually not stickered)
- Approach: read grade from label + card name → look up PSA population report to narrow cert candidates
- May require PSA pop report scraping

## Key Files

- `mobile/hooks/useOCR.ts` — image preprocessing, OCR, zone block filtering (single-card)
- `mobile/hooks/useMultiCardScan.ts` — multi-card pipeline: detect → crop → re-OCR or image match → results; accepts `scanMode: 'ocr' | 'image' | 'combined'`; RRF merge in combined mode; auto per-crop language detection via kana regex (no language toggle)
- `mobile/utils/detectCards.ts` — `filterBlocksToCardZone` (single), `detectCardRegions` (fallback), `boxesToRegions` (converts backend boxes)
- `mobile/utils/cardConfidence.ts` — single-card confidence scoring
- `mobile/services/api.ts` — `api.detectCards()`, `api.batchSearch()`, `api.scanStream()` (streaming unified scan), all API calls
- `mobile/utils/yoloDetector.ts` — `detectCardsWithYolo()` stub; returns null until `card_detector.tflite` is present
- `mobile/components/Scanner/ScanOverlay.tsx` — scan frame dimensions (75% W, 88/63 ratio, -40px Y)
- `mobile/components/UI/ScanModeToggle.tsx` — OCR / Image AI / Combined toggle component
- `mobile/components/Card/PriceChart.tsx` — trend graph
- `backend/app/services/card_detector.py` — OpenCV card outline detection (`detect_card_rectangles`)
- `backend/app/services/card_embedder.py` — CLIP ViT-B/32 embedding (fine-tuned weights loaded from `backend/models/clip_finetuned.pt` if present)
- `backend/app/api/v1/scan.py` — `POST /api/v1/scan` unified endpoint: batch CLIP embed + parallel pgvector + parallel OCR + NDJSON stream; vector search filters by language
- `backend/app/api/v1/detect.py` — `POST /api/v1/detect` endpoint
- `backend/app/data/tcgcollector_ja.json` — 27,255 JP card entries scraped from TCGCollector.com (all eras 1996–present); source of truth for JP card data
- `backend/app/scrapers/pricecharting.py` — PriceCharting scraper
- `backend/app/services/card_matcher.py` — search orchestration, ranking, price caching
- `backend/app/data/pokemon_kana_to_en.json` — kana→English name dict (1028 entries)
- `backend/app/data/pokemon_names_ja.json` — full list with ndex + english + kana
- `backend/app/data/pokemon_names.py` — `kana_to_english()` loader
- `backend/app/data/set_printed_totals.json` — 172 sets mapped to `printedTotal` (fetched from pokemontcg.io `/v2/sets`); used by `_dedupe_and_rank` to disambiguate cards sharing a name/number across sets
- `backend/models/embedding_failures.json` — EN embedding state: 20,187 embedded, 50 unembeddable (McDonald's promos CDN 404), 0 failures
- `scripts/build_embeddings.py` — embedding pipeline: EN mode fetches from pokemontcg.io/local dataset; JP mode (`--language ja`) downloads from TCGCollector CDN with rate limiting (concurrency=8); rebuilds IVFFlat index after completion
- `scripts/load_jp_cards.py` — upserts TCGCollector JP cards into `cards` table as `language='ja'` rows; safe to re-run (upsert by `external_id`)
- `scripts/scrape_tcgcollector.py` — scrapes TCGCollector JP card image grid; supports `--newest-first` for delta updates (stops when hitting known cards), `--base-url` for set-specific scraping
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

### v9 — CLIP ViT-B/32 synthetic augmentation fine-tuning ✅

- Fine-tuning CLIP visual encoder on (clean official art crop, augmented simulated photo) pairs to close the domain gap between training data and real phone photos of physical cards
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
- **After training:** run `python scripts/build_embeddings.py --dataset /pokemon-tcg --force` to re-embed all 20k cards with fine-tuned weights
- ✅ **Training complete** — 2026-05-18, ~13 hours total
- ✅ **Re-embedding complete** — 20,187 cards re-embedded with fine-tuned weights, IVFFlat index rebuilt, backend restarted and serving fine-tuned embeddings
- 50 unembeddable (McDonald's promos CDN 404), 63 embed_failed (same as before), 1 download_failed — no new failures

#### Epoch training log

| Epoch          | Loss             | LR       | Duration | Completed                                                          |
| -------------- | ---------------- | -------- | -------- | ------------------------------------------------------------------ |
| 1              | 0.0255           | 9.76e-06 | 78 min   | 2026-05-18 06:32 UTC                                               |
| 2              | 0.0098           | 9.05e-06 | 77 min   | 2026-05-18 07:49 UTC                                               |
| 3              | 0.0099           | 7.96e-06 | 78 min   | 2026-05-18 09:08 UTC                                               |
| 4              | 0.0095           | 6.58e-06 | 78 min   | 2026-05-18 10:26 UTC                                               |
| 5              | 0.0088           | 5.05e-06 | 76 min   | 2026-05-18 11:42 UTC                                               |
| 6              | 0.0080           | 3.52e-06 | 77 min   | 2026-05-18 12:59 UTC                                               |
| **7 ★** | **0.0077** | 2.14e-06 | 77 min   | 2026-05-18 14:16 UTC                                               |
| 8              | 0.0081           | 1.05e-06 | 77 min   | 2026-05-18 15:33 UTC                                               |
| 9              | 0.0083           | 3.42e-07 | 79 min   | 2026-05-18 16:52 UTC                                               |
| 10             | 0.0081           | 1.00e-07 | 82 min   | 2026-05-18 18:14 UTC                                               |
| **Best** | **0.0077** | —       | —       | **Epoch 7 — saved to `backend/models/clip_finetuned.pt`** |

### v10 — Project reorganization and dead code removal (2026-05-18)

- Moved `background-textures/` → `assets/backgrounds/`; updated `docker-compose.yml` volume mount accordingly
- Moved scraper logs to `logs/` (gitignored)
- Deleted dead files: `runs/`, `yolo11n.pt` (base model, training artifact), `pca.pkl`, `card_detector.onnx`, calibration `.npy` files, `TCGScanner.html`
- Removed `backend/app/api/v1/match_image.py` (`POST /api/v1/match-image` endpoint) — fully superseded by `/scan`
- Removed `batchMatchByImage()` from `mobile/services/api.ts` — was never called after v8
- Moved one-off scripts to `scripts/archive/`
- Expanded `.gitignore`: `assets/backgrounds/`, `logs/`, `*.npy`, `*.onnx`, `*.pkl`, `runs/`
- **Single-card scan mode disabled**: the "Scan Cards" button in `index.tsx` now always launches multi-card mode (`handleMultiCapture`). The single-card `handleCapture` path (overlay zone filtering, `useOCR` confidence gate) still exists in the file but has no UI entry point — multi-card supersedes it for all use cases

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
- **Synthetic dataset** (`synthetic_v1`): 2,000 images generated via `scripts/generate_synthetic_yolo.py` — 800 card images downloaded from DB (45% EN Pokémon, 40% JP, 15% EN Trainer/Item, 0.15s/request rate limit), pasted onto 15 backgrounds at avg 6.5 cards/scene. Glass fraction 13% matching 2/15 natural background ratio. Stored at `C:\Users\Quang\Desktop\TCG Training Data\synthetic_v1\`.
- **Merged dataset** (`yolo_v2_merged`): 2,823 train (13,798 annotations) + 706 val (3,375 annotations). Stored at `C:\Users\Quang\Desktop\TCG Training Data\yolo_v2_merged\`.
- **Training**: fine-tuned from `card_detector.pt` (not base `yolo11n.pt`) on RTX 3080, 30 epochs, batch=16, imgsz=640. ~1.5hr total.
- **Convergence confirmed**: resumed training with `patience=15` early stopping — halted after 16 additional epochs with no mAP improvement, confirming epoch 30 was the converged optimum.

| Epoch | Box loss | Cls loss | DFL loss |
|-------|----------|----------|----------|
| 1     | 0.5281   | 0.4664   | 0.9653   |
| 10    | 0.3893   | 0.3348   | 0.8852   |
| 20    | 0.3233   | 0.2776   | 0.8618   |
| **30 (final)** | **0.2316** | **0.1915** | **0.8067** |

| Metric | v1 (CPU, 50 epochs) | v2 (GPU, 30 epochs) |
|--------|---------------------|---------------------|
| mAP50 | 0.992 | **0.993** |
| mAP50-95 | 0.904 | **0.964** (+6.6%) |
| Precision | 0.977 | 0.977 |
| Recall | 0.985 | 0.980 |

- Deployed to `backend/models/card_detector.pt`; v1 backup at `card_detector_v1_backup.pt`.
