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
- OpenCV contour detection is inconsistent for non-trivial card arrangements (touching cards, holofoil surfaces, overlapping). Being replaced by YOLO (see In Progress).

## Completed Features (Multi-card)
- Camera mode: capture full image → OCR → detect card regions → crop each → re-OCR → confidence check → batch search backend → results UI
- `useMultiCardScan` hook orchestrates the full pipeline
- `multi-results.tsx`: shows all identified cards with image/name/set/number; query used shown per card (`🔍 Name #N`); "Swap" button to choose alternate candidates
- `POST /api/v1/search/batch` backend endpoint: accepts up to 10 queries, returns candidates per query
- `detectCardRegions` in `mobile/utils/detectCards.ts`: adaptive threshold clustering + recursive aspect-ratio splitting
- Frontend dedup: cards with the same top-candidate ID are deduplicated before showing results
- `POST /api/v1/detect` endpoint: accepts base64 image, returns bounding boxes — currently OpenCV, being replaced by YOLO
- **Recognition Mode toggle** (OCR / Image AI / Combined) — scanner screen lets user switch modes; `useMultiCardScan` accepts `scanMode: 'ocr' | 'image' | 'combined'`
- **Combined mode**: runs OCR and image matching in parallel, merges results with Reciprocal Rank Fusion (`score = 1/(rank+60)` per source), shows per-card source badge (Both ✓ / Image AI / OCR) in results UI
- **Set printed-total ranking**: `_dedupe_and_rank` in `card_matcher.py` uses `backend/app/data/set_printed_totals.json` (172 sets, fetched from pokemontcg.io `/v2/sets`) to boost cards from sets whose `printedTotal` matches the denominator read from the card (e.g. `/111` → sm4 Crimson Invasion). This disambiguates cards that share a name and number across multiple sets.

## Completed Features (Image Embedding)
Image-based card identification as an alternative to OCR text search. Inspired by SKANIT's approach.

**Current state — EfficientNet-B0 (being replaced by CLIP, see Next Steps):**
- EfficientNet-B0 (via `timm`) extracts 1280-dim visual features, PCA reduces to 256-dim
- Embeddings stored in pgvector (`cards.embedding vector(256)`)
- **Known limitation:** EfficientNet was pretrained on ImageNet for object classification, not cross-domain visual matching. Phone photos of physical cards produce similarity scores of ~0.45–0.58 against clean pokemontcg.io card art, well below the 0.70 threshold — the domain gap makes Image AI mode unreliable in practice.

**Coverage:** 20,182 of 20,237 Pokemon EN cards embedded (99.7%). DB pre-populated via pokemontcg.io API.

**Endpoint:** `POST /api/v1/match-image` — accepts `{ crops: [base64, ...] }` (up to 10), returns `BatchSearchResult`. Returns 503 if model not ready.

**Similarity threshold:** 0.70 cosine similarity — below this, no match returned for that crop.

**Mobile flow (Image AI mode):**
1. YOLO/OpenCV detection → bounding boxes (same as OCR mode)
2. Crop each region → read as base64
3. Send all crops to `/match-image` (skips re-OCR and confidence check)
4. Results deduplicated and shown in same `multi-results.tsx` UI

**Offline pipeline:** `scripts/build_embeddings.py`
- Fetches all cards from pokemontcg.io API (~82 pages)
- Matches to local Kaggle dataset by set name slug + card number extraction (handles inconsistent filename formats across sets)
- Falls back to downloading `image_url` for unmatched cards
- Fits PCA, saves to `backend/models/pca.pkl`
- Stores embeddings, creates IVFFlat index (`lists=100`)
- Writes failure report to `backend/models/embedding_failures.json`

**Re-running:** safe — skips already-embedded cards unless `--force`. Use `--force` only when refitting PCA (or switching embedding model entirely).

**Known failures from initial run:**
- `sma-SV22`: CDN download failed (promo card)
- `me2pt5-189/190/191`: truncated local files in Kaggle dataset (corrupted download)

## In Progress
### Multi-card region detection — YOLO ML object detection

**Decision:** Replace OpenCV contour detection with a fine-tuned YOLOv8n model. OpenCV struggles with holofoil surfaces, touching/overlapping cards, and cards on busy backgrounds. YOLO learns the physical card appearance and is robust to these cases.

**Architecture:**
- Model: YOLOv8n (nano) — ~6MB, runs on CPU in 50–100ms, no GPU needed
- Library: `ultralytics` added to `backend/requirements.txt`
- Single class: `card`
- Inference runs inside the existing FastAPI container — no new infrastructure
- `/api/v1/detect` endpoint response format unchanged; only `card_detector.py` internals change

**Detection flow (target):**
1. Resize image to 1600px wide
2. OCR full image + read base64 **in parallel**
3. `POST /api/v1/detect` → YOLO inference → returns bounding boxes in image-pixel coordinates
4. If boxes returned: use them directly as crop regions (`boxesToRegions`)
5. If none returned or network fails: fall back to `detectCardRegions` (OCR clustering)
6. Crop each region (5% margin) → re-OCR → confidence check → batch search

**Implementation phases:**
1. ✅ Scaffold: add `ultralytics` to requirements, lazy-load model in `card_detector.py`, fall back to OpenCV when no `.pt` file present
2. Dataset: collect ~250 practical photos, label with Roboflow (one class: `card`), export YOLO format
3. Fine-tune: run `yolo train model=yolov8n.pt data=data.yaml epochs=50 imgsz=640` locally
4. Swap: copy `best.pt` → `backend/models/card_detector.pt`, restart container — picked up automatically

**How YOLO fits into the pipeline:**
- Phone takes photo → resizes to 1600px wide
- Phone sends full image (base64) to `POST /api/v1/detect` (round trip 1)
- Backend runs YOLO → returns bounding boxes `[{left, top, width, height}]`
- Phone crops each box locally, runs ML Kit OCR on each crop (on-device)
- Phone sends OCR text to `POST /api/v1/search/batch` (round trip 2)
- Backend identifies cards → returns results to phone
- YOLO runs on backend only — no mobile dependencies; OCR runs on phone only

**Dataset guidance (for fine-tuning):**
- Practical scene photos only — cards on desk, cloth, glass display case (not isolated PNG cutouts)
- Card identity does not matter; same 10–15 cards can be used throughout
- Mix holo and non-holo cards (holo surfaces are where OpenCV fails most)
- Label with bounding boxes only in Roboflow (one class: `card`), export YOLO v8 format
- ~10–15 cards is enough variety for shooting sessions

**Photo count breakdown (~250 total, one session):**
| Card count per photo | % of dataset | ~Images |
|---|---|---|
| 1 card | 15% | ~38 |
| 2–3 cards | 40% | ~100 |
| 4–6 cards | 35% | ~88 |
| 7+ cards | 10% | ~25 |

**What to vary across your 250 photos:**
- Surfaces (most important): wood desk, dark cloth, white table, glass display case — at least 4 distinct surfaces
- Lighting (second): overhead room light, window from one side, dim room, phone flashlight; include glare on holos
- Arrangements: flat grid, fan/slight overlap, cards touching edge-to-edge, L-shape, one card diagonal
- Angle: straight top-down and ~20–30° tilt (realistic phone hold)

**Practical shoot plan:**
- 3 surfaces × ~4 arrangements × ~3 lighting conditions ≈ ~40 shots per surface → ~120 base shots
- Add ~30 display case shots if that's a target environment
- Fill remainder with varied edge cases (touching cards, holos under light)

**Pre-training datasets (optional):**
- Playing card / UNO scene datasets on Roboflow can be used for pre-training before fine-tuning on your TCG photos
- If mixing datasets, cap playing card images at 2–3× your TCG photo count to avoid bias toward white-border card features
- Sequential fine-tuning (playing cards first, then your photos) is safer than mixing
- YOLOv8n is already pre-trained on COCO (330k images) — playing card datasets add marginal value; 100+ of your own photos may be sufficient without them

**Training output:**
- Trained weights saved to `runs/detect/train/weights/best.pt`
- Test before deploying: `yolo predict model=best.pt source=test_photo.jpg` — saves annotated image showing detections
- Deploy: `cp best.pt backend/models/card_detector.pt` and restart container

**Current step:** Phase 1 complete. Awaiting dataset collection and labeling for fine-tuning (phase 2).

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

### 1. Switch image embeddings from EfficientNet to CLIP ✦ Priority
**Why:** EfficientNet has a domain gap problem — it cannot bridge phone photos of physical cards to clean pokemontcg.io card art. CLIP (Contrastive Language-Image Pre-training) was trained on 400M image-text pairs specifically to match the same object across different visual contexts, making it robust to lighting, angle, and camera quality differences.

**Model:** CLIP ViT-B/32 via `open-clip-torch`
- ~350MB model weights (server-side only, zero mobile app size impact)
- 512-dim output — no PCA needed (already compact)
- ~100–150ms CPU inference per crop vs ~20ms for EfficientNet (acceptable within network round-trip budget)

**Changes required:**
1. `backend/requirements.txt` — replace `timm` with `open-clip-torch`
2. `backend/app/services/card_embedder.py` — swap EfficientNet for CLIP ViT-B/32; output 512-dim directly, remove PCA dependency
3. `backend/app/api/v1/match_image.py` — remove `is_ready()` PCA check (no PCA needed)
4. DB migration — `ALTER TABLE cards ALTER COLUMN embedding TYPE vector(512)`; drop and rebuild IVFFlat index
5. `scripts/build_embeddings.py` — remove PCA fitting; store 512-dim embeddings; update vector dimension
6. Re-run build script (~30–40 min on CPU for 20k cards)

**Threshold:** Will need tuning — start at 0.70 and adjust based on observed CLIP similarity scores.

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
- Special cases (Tag Team, regional forms in Japanese) deferred

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
- `mobile/services/api.ts` — `api.detectCards()`, `api.batchSearch()`, `api.batchMatchByImage()`, all API calls
- `mobile/components/Scanner/ScanOverlay.tsx` — scan frame dimensions (75% W, 88/63 ratio, -40px Y)
- `mobile/components/UI/ScanModeToggle.tsx` — OCR / Image AI / Combined toggle component
- `mobile/components/Card/PriceChart.tsx` — trend graph
- `backend/app/services/card_detector.py` — OpenCV card outline detection (`detect_card_rectangles`)
- `backend/app/services/card_embedder.py` — EfficientNet-B0 embedding: `embed_raw()` (1280-dim), `embed_image()` (256-dim after PCA), `is_ready()` — **to be replaced by CLIP ViT-B/32**
- `backend/app/api/v1/detect.py` — `POST /api/v1/detect` endpoint
- `backend/app/api/v1/match_image.py` — `POST /api/v1/match-image` endpoint (image embedding search)
- `backend/app/scrapers/pricecharting.py` — PriceCharting scraper
- `backend/app/services/card_matcher.py` — search orchestration, ranking, price caching
- `backend/app/data/pokemon_kana_to_en.json` — kana→English name dict (1028 entries)
- `backend/app/data/pokemon_names_ja.json` — full list with ndex + english + kana
- `backend/app/data/pokemon_names.py` — `kana_to_english()` loader
- `backend/app/data/set_printed_totals.json` — 172 sets mapped to `printedTotal` (fetched from pokemontcg.io `/v2/sets`); used by `_dedupe_and_rank` to disambiguate cards sharing a name/number across sets
- `backend/models/pca.pkl` — fitted PCA model (1280→256 dim); loaded lazily by `card_embedder.py` — **obsolete after CLIP migration**
- `backend/models/embedding_failures.json` — cards skipped/failed during last embedding run
- `scripts/build_embeddings.py` — offline pipeline: pokemontcg.io fetch → local image match → embed → PCA → pgvector store; needs update for CLIP (remove PCA, change vector dim to 512)
