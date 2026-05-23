# TCG Card Scanner

A mobile app that scans TCG (Trading Card Game) cards and fetches pricing/sales data from [PriceCharting](https://www.pricecharting.com).

---

## Open Tasks

### Priority 1 — Recognition improvements

#### CLIP similarity threshold tuning

`_SIM_THRESHOLD = 0.65` and `_SIM_FLOOR = 0.50` were set before the fine-tuned CLIP model. Now that the YOLO v2 model produces tighter crops (mAP50-95: 0.964 vs 0.904), real scan similarity scores may have shifted.

**File:** `backend/app/api/v1/scan.py`

- Run combined mode scans and check logged `image:X.XX` similarity scores in backend logs
- Consider raising `_SIM_FLOOR` if scores are consistently higher with tighter crops
- Consider raising `_IMAGE_MIN_SIM_WITH_OCR` if image-only false positives are observed

#### Card sleeve detection (future YOLO retraining)

Training data has no sleeved cards. Most collectors use penny sleeves or deck sleeves, which add a clear/matte border and change card edge appearance.

When retraining next:

- Add real photos of sleeved cards to `yolo_merged` (label as `card`)
- Or generate synthetic sleeved cards: add semi-transparent border overlay in `generate_synthetic_yolo.py`

---

### Priority 2 — YOLO on-device (TFLite) ✅ COMPLETED (v22, 2026-05-22)

Implemented in `mobile/utils/yoloDetector.ts`. Eliminates the `/detect` network round-trip.

| Metric                | Backend `/detect` (mobile data) | On-device TFLite                                    |
| --------------------- | --------------------------------- | --------------------------------------------------- |
| Round-trip latency    | 1000–3000ms                      | 100–200ms (post-warmup)                            |
| Works offline         | No                                | Yes (detection only — OCR/CLIP still need backend) |
| Backend load per scan | 1 detect call                     | 0                                                   |
| Data uploaded         | Full 2400px image (~500KB–2MB)   | One full image + box coords (server-side crop)     |

**How it works (v22):**

- Export chain: PyTorch → ONNX (onnxscript + onnxslim) → TF SavedModel (onnx2tf) → TFLite float16
- `ultralytics` direct TFLite export segfaulted; fixed by running onnx2tf manually
- Model: `card_detector_float16.tflite` (5.1MB, float32 I/O, `[1, 5, 8400]` output)
- Bundled at `mobile/assets/models/card_detector.tflite`; `metro.config.js` adds `tflite` to `assetExts`
- Library: `react-native-fast-tflite` **v2.0.0** (v3.0.1 rejected onnx2tf op set silently — downgrade required)
- Delegate: NNAPI on Android (routes to Hexagon DSP on Snapdragon 8 Gen 1), Core ML on iOS, CPU fallback
- Input: resize full image to 640×640 JPEG 0.95, base64 → `jpeg-js` decode → float32 RGB NHWC
- Post-processing: conf > 0.25 filter, greedy NMS (IoU 0.45), stretched un-projection, area filter
- Output layout auto-detected from `model.outputs[0].shape`: `[1,5,8400]` or `[1,8400,5]`
- Stale-handle recovery: try/catch around `model.run()`; on failure, resets `_model`/`_modelPromise` and retries once
- Graceful fallback: try-catch returns `null` → caller falls back to backend `/detect`
- **Do not use `Promise.all([ML Kit OCR, NNAPI YOLO])`** — causes native bridge resource conflict; sequential is stable

**To re-export after YOLO retraining:**

```bash
docker exec tcg_backend python -c "from ultralytics import YOLO; YOLO('/app/models/card_detector.pt').export(format='onnx', imgsz=640)"
docker exec tcg_backend onnx2tf -i /app/models/card_detector.onnx -o /app/models/card_detector_saved_model -osd
# Then copy card_detector_float16.tflite to mobile/assets/models/card_detector.tflite
```

**Validation:** Compare box count/coords between backend `/detect` and on-device for the same test photo. Drift >5px indicates preprocessing bug (normalization, NHWC order, scale factor). Backend `/detect` fallback still active if TFLite returns 0 boxes.

**Known risks:** GPU delegate needs Expo config plugin; iOS needs Core ML re-export; model updates require full app rebuild.

---

### Future — Image AI improvements

**Real photo fine-tuning** (if CLIP similarity remains unreliable after threshold tuning):

- CLIP via `open-clip-torch` is MIT licensed — safe for commercial release
- Collect thousands of real labeled card photos spanning hundreds of sets (holo/special cards included)
- Fine-tune with InfoNCE contrastive loss; re-embed all cards
- Note: 300 photos of ~200–300 cards would overfit badly — minimum useful scale is thousands of images

**DINOv2 / DINOv3 (research benchmarking only — non-commercial licenses):**

- Dense patch-level matching; better suited to card identity than CLIP's global embedding
- DINOv2: CC BY-NC 4.0; DINOv3: custom Meta access-gated — neither can be shipped in a released app
- Evaluate locally against CLIP if CLIP continues to struggle

| Model                  | License               | App release            |
| ---------------------- | --------------------- | ---------------------- |
| CLIP (open-clip-torch) | MIT                   | Yes                    |
| DINOv2                 | CC BY-NC 4.0          | No                     |
| DINOv3                 | Custom (access-gated) | No                     |
| YOLO11n (ultralytics)  | AGPL-3.0              | Yes (with attribution) |

---

### Future — Background price refresh worker

Not worth implementing until there are concurrent users — benefit is zero for single-user use. Implement when the same popular cards are being requested by multiple users within the same 24h window and cache-miss latency becomes noticeable (~10–20 active users).

**How it works with Redis:**

- Redis is unchanged — same 24h TTL keys, same cache-check logic in the price endpoint
- Worker runs nightly (~2am) inside the existing `worker` container, pre-refreshes any hot-set key with less than 2 hours of TTL remaining
- Users always hit a warm Redis key; the scrape latency (~800–2,500ms) moves from user-facing to an invisible overnight process
- Total PriceCharting request volume is unchanged — scraping shifts from random user-triggered bursts to a controlled 1 req/s overnight drip

**New table — `price_views` (append-only event log):**

```sql
CREATE TABLE price_views (
    card_id   INTEGER NOT NULL REFERENCES cards(id),
    viewed_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX ix_price_views_card_viewed ON price_views (card_id, viewed_at DESC);

-- Nightly cleanup to keep the table lean (run alongside the worker)
DELETE FROM price_views WHERE viewed_at < NOW() - INTERVAL '30 days';
```

**Log user-initiated requests only** — the worker never writes to `price_views`, so its own activity can never keep a card artificially hot:

```python
# In the prices endpoint, before the Redis check
await db.execute("INSERT INTO price_views (card_id) VALUES (:id)", {"id": card_id})
```

**Worker logic:**

```python
hot_cards = await db.fetch(
    "SELECT DISTINCT card_id FROM price_views WHERE viewed_at > NOW() - INTERVAL '30 days'"
)
for card in hot_cards:
    ttl = await redis.ttl(price_key(card))
    if ttl < 7200:  # < 2 hours remaining, or missing (-2)
        prices = await scraper.get_prices(card.pricecharting_url)
        await redis.set(price_key(card), prices.json(), ex=86400)
    await asyncio.sleep(1)  # 1 req/s — polite to PriceCharting
```

Cards nobody scans for 30 days fall out of the hot set automatically and stop being refreshed.

---

### Future — PSA graded card recognition

- Target: Japanese card shops that cover cert numbers with price stickers
- Approach: read grade from PSA label + card name → PSA population report to narrow cert candidates
- May require PSA pop report scraping

---

### Known Limitations (no fix planned)

| Issue                                     | Notes                                                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Older JP sets price 404 on PriceCharting  | Pre-2003 JP sets use Pokédex number not set position (e.g. Gastly #92 not #49). Would need a lookup table or scrape-based URL discovery.  |
| JP Abra (kana-heavy cards) not detected   | OCR confidence < 3 + image sim < 0.50 floor → 0 candidates. Fundamental limitation — scan separately with better conditions.             |
| Holofoil image AI unreliable              | Reflective surfaces produce visual appearances impossible to synthesize. CLIP fine-tuning didn't close this gap. Use OCR or Combined mode. |
| Items with digits in name (Pokégear 3.0) | Digit gate in `_find_trainer_name` rejects them. Low priority — rare edge case.                                                         |

---

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
- **Currency toggle (USD/JPY)**: `[USD][JPY]` pill toggle in the Pricing heading (individual card) and Batch Prices header; converts all prices, recent sales, and trend chart on the fly; exchange rate fetched from `GET /api/v1/currency/rates` (frankfurter.dev, cached in Redis 24h); JPY displayed as `¥X` whole numbers with locale commas; rate shown inline as `1 USD = ¥X`; state global via `currencyStore` so switching screens preserves the selection
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
- On-device YOLO detection (`mobile/utils/yoloDetector.ts`) fully implemented (v18). `card_detector_float16.tflite` (5.1MB) bundled at `mobile/assets/models/`. CPU delegate only — GPU needs Expo config plugin setup.
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
- `POST /api/v1/detect` endpoint: accepts base64 image, returns bounding boxes — YOLO11n only (OpenCV fallback removed in v16; returns empty boxes if model absent so mobile falls back to OCR clustering)
- **Recognition Mode toggle** (OCR / Image AI / Combined) — scanner screen lets user switch modes; `useMultiCardScan` accepts `scanMode: 'ocr' | 'image' | 'combined'`
- **Combined mode**: runs OCR and image matching in parallel, merges results with Reciprocal Rank Fusion. OCR gets 2× weight. Image results are gated out when OCR found a confident result and image similarity < 0.83 — weak image signal is worse than no image signal when OCR already has an answer. Shows per-card source badge (Both ✓ / Image AI / OCR) in results UI.
- **Combined mode RRF detail**: `score = weight/(rank+60)` — OCR weight=2, image weight=1. After merge, candidates matching the OCR card number are promoted to front. Image gate: skipped if OCR found a name and `image_sim < 0.83`.
- **Card number region augmentation**: full-image OCR blocks (already computed) are spatially filtered to the bottom 22% of each detected card crop and appended to the crop's OCR text before backend search — zero extra OCR calls, improves card number extraction when the crop-level OCR misses it.
- **Set printed-total ranking**: `_dedupe_and_rank` in `card_matcher.py` uses `backend/app/data/set_printed_totals.json` (172 sets, fetched from pokemontcg.io `/v2/sets`) to boost cards from sets whose `printedTotal` matches the denominator read from the card (e.g. `/111` → sm4 Crimson Invasion). This disambiguates cards that share a name and number across multiple sets.
- **Fuzzy name matching**: `_search_db` falls back to `pg_trgm` `similarity() > 0.35` when exact `ilike` returns nothing — handles OCR misreads like "Lotacl" → Lotad, "Sulcune" → Suicune.
- **Unified `/scan` endpoint with streaming** — see below.
- **Auto per-crop language detection**: OCR always runs with `TextRecognitionScript.JAPANESE` (returns both Latin and kana in one pass). Language is detected from the **name-region sub-crop** (top 18%, 5–95% width) as the primary source — full-crop text is too noisy (type symbols, energy icons, flavor text produce kana misreads on EN cards). Falls back to full-crop text only when name region is empty. `KANA_RE = /[゠-ヿぁ-ゖ]{3,}/` — requires 3+ consecutive kana (shortest JP Pokémon name アブラ = Abra = 3 kana). Name-region sub-crop now always runs regardless of scan mode (previously gated on `scanMode !== "image"` and `confidence.isCard`). A single scan correctly identifies mixed EN+JP cards from the same photo. `LanguageToggle` UI component removed; `language` state removed from `scanStore`. `batch_prices` endpoint uses `card.language` per record so mixed EN+JP batches price correctly.
- **Owner-prefix Pokémon cards**: `_find_pokemon_name` strips possessive `'s` into a `clean_for_punct` variable before the punctuation gate, so "Misty's Staryu" and "Sabrina's Gastly" are accepted. JP owner-prefix cards (e.g. `R団のミュウツー`, `ロケット団のミュウツー`) are handled by `_find_kana_name` substring matching — the kana Pokémon name is found as a substring of the full `の`-format line regardless of the owner prefix.
- **Trainer / Supporter / Item / Tool card support**: `_find_trainer_name(lines)` in `card_matcher.py` locates the standalone type keyword (e.g. "Supporter"), looks 1–2 lines above for the card name, strips parenthetical subtitles ("Professor's Research (Professor Magnolia)" → "Professor's Research"), and applies the same apostrophe-tolerant punctuation check. `extract_card_hints` falls back to it when `_find_pokemon_name` returns None — no `_contains_pokemon_name` gate. Mobile `cardConfidence.ts` fast-passes any crop with a standalone EN type keyword (score=10, `isCard=true`) before HP/keyword scoring. JP trainer cards pass via `JA_KEYWORD_RE` scoring (グッズ, サポート, スタジアム). JP trainer name extraction not yet implemented.
- **Name region sub-crop OCR** (`useMultiCardScan.ts`): after confidence passes, sub-crops the top 18% (5–95% width) of each card crop and runs a second OCR pass. `rawText` sent to backend = name-region text + card number from bottom corners. Eliminates attack text and flavor text from name extraction input. Also fixes EN-card-as-JP misdetection: `cropLang` is re-detected from the name region (which has no flavor text kana misreads), so EN cards with kana-like flavor text OCR misreads are correctly classified as EN.
- **Card number spatial filter tightened**: `augmentWithNumberRegion` now checks bottom 8% (was 22%) of the card, split into left-corner (x 0–35%) and right-corner (x 65–100%) separately. Prefers whichever corner matches `\d+/\d+`. Eliminates flavor text hits.
- **Camera capture quality**: `quality: 1` (was 0.92), `skipProcessing: true` (was false). Resize target raised to 2400px wide (was 1600px). Intermediate card crops and name sub-crops saved as PNG (lossless) for OCR; only the base64 payload to the backend is re-encoded as JPEG 0.92 to keep network size manageable.
- **Kana false-positive fix (enhanced)**: `KANA_RE` raised to `{3,}` consecutive kana (was `{2,}`, then `{1,}`). More importantly, language detection now always runs from the name-region sub-crop (top 18%) rather than full-crop text — name region contains only card name + HP, making false JP classification from EN decorative elements effectively impossible.
- **Backend JP→EN OCR fallback** (`scan.py`): if `language='ja'` OCR search returns no candidates, automatically retries with `language='en'`. Handles EN cards whose flavor text is misread as kana by `TextRecognitionScript.JAPANESE`, causing `cropLang` to flip to `'ja'` on the mobile.
- **Backend JP→EN image search fallback** (`scan.py`): if `language='ja'` vector search returns `best_sim < _SIM_THRESHOLD`, also tries `language='en'` and uses whichever has higher similarity. Recovers EN cards that slipped past the mobile language detection fix. Reuses the already-computed embedding — only one extra pgvector query (~5ms).
- **Region cap raised to 20**: `useMultiCardScan.ts` crop loop, backend `/detect` fallback call, `scan.py` crop slice, `card_detector.py` default `max_cards`, and `DetectRequest.max_cards` schema all raised from 10 → 20. Matches YOLO v2 training (up to 20 cards/scene).
- **JP PriceCharting URL fix**: `_JP_PC_SET_SLUG` dict in `pricecharting.py` maps TCGCollector set names to pre-slugified PriceCharting slugs where `_slugify` would produce wrong output (e.g. "Pokémon Card 151" → `scarlet-&-violet-151`; `_slugify` strips `&` producing wrong slug). `/console/` URL filter added to `_parse_prices` fallback link logic — prevents disambiguation page links from being recorded as real sale URLs. Guard added: if `price_loose is None` and all scraped sale URLs are None, `recent_sales` is cleared to prevent bogus rows from set-listing redirects.
- **"Complete" price row removed** from `PriceDisplay.tsx`: `price_cib` is PriceCharting's "Complete In Box" tier for video games — never populated for trading cards, always showed N/A.
- **Reload button on card details page** (`mobile/app/card/[id].tsx`): fetch logic extracted to `loadCard(refresh?)`. Error state shows accent "Retry" button. No-price state shows "Retry" inside the box. Price loaded state shows subtle "↻ Refresh price" link below `PriceDisplay` with spinner while refreshing. Re-fetch hits backend which checks Redis cache first (24h TTL for hits, 1h for negatives).

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
- `scripts/generate_synthetic_yolo.py` — generates synthetic YOLO dataset by compositing card images onto backgrounds with known bounding boxes

**To retrain next time** (v3):

```
# 1. Generate new synthetic batch
py -3 scripts/generate_synthetic_yolo.py --cards assets/card_images/ --backgrounds assets/backgrounds/ --output training/datasets/synthetic_v2 --count 2000 --glass-fraction 0.13

# 2. Merge all datasets (always include synthetic_v1 to avoid catastrophic forgetting)
py -3 scripts/merge_yolo_datasets.py --src training/datasets/yolo_merged training/datasets/synthetic_v1 training/datasets/synthetic_v2 --dst training/datasets/yolo_v3_merged

# 3. Copy into container, fix data.yaml path, fine-tune from card_detector.pt (not base yolo11n.pt)
```

Synthetic datasets stored at `C:\Users\Quang\Desktop\TCG Training Data\` — keep permanently and always include all prior synthetic batches when retraining.

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
- `backend/app/services/card_detector.py` — YOLO11n card detection (`detect_card_rectangles`); no fallback path
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
- **After training:** run `python scripts/build_embeddings.py --dataset /en_cards --force` to re-embed all 20k cards with fine-tuned weights
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

**Adding new JP sets** (e.g. after a new JP release):

```
# Step 1 — Pull new cards from TCGCollector (scrapes newest first, stops at already-known cards)
py -3 scripts/scrape_tcgcollector.py --newest-first

# Step 2 — Load new cards into DB (upsert — existing cards untouched)
docker exec tcg_backend bash -c "cd /app && python /scripts/load_jp_cards.py"

# Step 3 — Embed new cards (skips already-embedded; rebuilds IVFFlat index after)
docker exec tcg_backend bash -c "cd /app && python /scripts/build_embeddings.py --language ja"
# Monitor: docker exec tcg_backend tail -f /tmp/embed_ja.log

# Step 4 — Restart backend
docker restart tcg_backend
```

To scrape a specific set: find the TCGCollector set ID by browsing `https://www.tcgcollector.com/sets/jp?releaseDateOrder=oldToNew` (set URLs follow `/sets/{id}/set-slug`), then:

```
py -3 scripts/scrape_tcgcollector.py --base-url "https://www.tcgcollector.com/cards/jp?sets[]={id}&displayAs=image&sortBy=cardNumber"
```

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
- **Synthetic dataset** (`synthetic_v1`): 2,000 images generated via `scripts/generate_synthetic_yolo.py` — 800 card images downloaded from DB (45% EN Pokémon, 40% JP, 15% EN Trainer/Item, 0.15s/request rate limit), pasted onto 15 backgrounds at avg 6.5 cards/scene. Glass fraction 13% matching 2/15 natural background ratio. Stored at `training/datasets/synthetic_v1/`.
- **Merged dataset** (`yolo_v2_merged`): 2,823 train (13,798 annotations) + 706 val (3,375 annotations). Stored at `training/datasets/yolo_v2_merged/`.
- **Training**: fine-tuned from `card_detector.pt` (not base `yolo11n.pt`) on RTX 3080, 30 epochs, batch=16, imgsz=640. ~1.5hr total.
- **Convergence confirmed**: resumed training with `patience=15` early stopping — halted after 16 additional epochs with no mAP improvement, confirming epoch 30 was the converged optimum.

| Epoch                | Box loss         | Cls loss         | DFL loss         |
| -------------------- | ---------------- | ---------------- | ---------------- |
| 1                    | 0.5281           | 0.4664           | 0.9653           |
| 10                   | 0.3893           | 0.3348           | 0.8852           |
| 20                   | 0.3233           | 0.2776           | 0.8618           |
| **30 (final)** | **0.2316** | **0.1915** | **0.8067** |

| Metric    | v1 (CPU, 50 epochs) | v2 (GPU, 30 epochs)     |
| --------- | ------------------- | ----------------------- |
| mAP50     | 0.992               | **0.993**         |
| mAP50-95  | 0.904               | **0.964** (+6.6%) |
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
| 4            | CPU float16 (reverted)                  | 13.97s          | 14.36s    | 6806ms | 6406ms   | Normal CPU variance, phone at 51°C   |
| 5            | CPU float16                             | 13.88s          | 14.22s    | 7160ms | 6065ms   | After OCR opt + INT8 attempt          |
| 6            | CPU float16 (TFLiteConverter regen)     | 13.39s          | 13.79s    | 6726ms | 6060ms   | regionsFromYolo=false — model broken |
| 7            | CPU float16 (onnx2tf original restored) | pending rebuild | —        | —     | —       | Restoring to verify OCR opt           |

**GPU delegate verdict**: slower than CPU on S22+ (Snapdragon 8 Gen 1) due to YOLO op compatibility — some ops fall back to CPU with quantize/dequantize overhead. Reverted. Phone temps 51°C are below throttle threshold (~80°C); variance (~30%) is normal Android scheduler noise.

**Key finding**: backend is fast (~1.4s to first card result). Bottleneck is entirely on-device: YOLO (~5–7s CPU) + OCR prep (~5.7s for N crops × 2 ML Kit passes).

#### INT8 quantization attempt — failed (2026-05-22)

Attempted to produce an INT8 TFLite model for faster ARM CPU inference.

- Calibration: 225 real card photos from `training/datasets/my_photos/` (23 batch folders of 10), copied into container at `/calib_images`
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

| Run | First card | All cards | YOLO bucket | OCR prep | Notes |
|---|---|---|---|---|---|
| Pre-v21 baseline | 13.97s | 14.36s | 6806ms | 6406ms | v20 reference |
| v21 (parallel attempt) | 8.15s | 8.59s | 7105ms | 365ms | NNAPI crashed, fell back to backend |
| v21 (sequential, PNG resize) | 5.91s | 6.28s | 4683ms | 333ms | On-device YOLO working but resize=3000ms |
| **v22 run 1** | **2.97s** | **3.39s** | **2047ms** | **46ms** | JPEG resize + on-device YOLO |
| **v22 run 2** | **3.14s** | **3.56s** | **2096ms** | **56ms** | Stable repeat |
| **v22 post-PIL** | **3.12s** | **3.51s** | **2156ms** | **37ms** | After PIL-direct embedder change |

`yolo bucket` breakdown (post-v22): resize ~580ms + on-device YOLO ~1050ms (incl. JS preprocessing) + full-image OCR ~600ms.

#### Remaining latency targets (Round 4 candidates)

1. **`yoloDetector.ts` JS preprocessing** (~850ms of the 1050ms YOLO bucket): file read → atob → JPEG decode (jpeg-js) → Float32 array build, all in single-threaded JS. Replace `jpeg-js` with a native decoder or a worklet.
2. **Full-image OCR** (~600ms): try `LATIN` script as fast path with `JAPANESE` fallback only when no Latin hits found (current pass is always JAPANESE which is slower).
3. **Camera capture quality**: `quality: 1, skipProcessing: true` produces multi-megapixel raw — lowering to 0.85 could cut ~200ms off resize with no OCR impact.
4. **NNAPI warmup**: first inference takes ~1000ms due to native compilation; preload at app startup so first user scan is fast.

#### Accuracy notes (not v22 regressions, but observed during v22 testing)

- Dim lighting + desk lamp pointing up = CLIP scores below 0.83 gate → no "Both ✓" badges, mostly "OCR" badges. Working as designed.
- Holofoil cards remain unreliable for image AI (pre-existing).
- OCR misread fix above (`ASIG`, `ASNG`) is in v22.

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

| Variant | Card slug example |
|---|---|
| 1st Edition | `charizard-1st-edition-4` |
| Shadowless | `charizard-shadowless-4` |
| Poké Ball | `umbreon-poke-ball-59` |
| Master Ball | `gengar-master-ball-94` |

**EN variants**: Normal / 1st Edition / Shadowless / Poké Ball  
**JP variants**: Normal / Poké Ball / Master Ball

**When variant has no price data**: shows "Variant not found on PriceCharting" with a "Search on PriceCharting →" link (opens browser to pre-populated search). URL construction is heuristic — PriceCharting may use different slugs for some cards; the search link lets the user verify manually.

**Files**: `backend/app/scrapers/pricecharting.py` (`build_game_url` variant param), `backend/app/services/card_matcher.py` (`_build_pc_url`, `get_prices`), `backend/app/api/v1/cards.py` (`variant` query param), `mobile/services/api.ts`, `mobile/app/card/[id].tsx`.

### v25 — Streaming batch prices (2026-05-22)

Replaced the wait-for-all batch prices request with an NDJSON stream — prices appear card-by-card as they resolve rather than all at once.

**Backend**: `POST /api/v1/cards/prices/stream` in `cards.py`. Uses `asyncio.ensure_future` + `asyncio.as_completed` — all price fetches run concurrently and results are yielded the moment each completes. Cache hits (Redis) emit immediately; scrape misses follow as the rate limiter allows. Same `BatchPricesItem` shape per line. `POST /api/v1/cards/prices` unchanged (backwards compatible).

**Mobile `api.ts`**: `api.streamPrices()` — XHR `onprogress` NDJSON parser (same pattern as `scanStream`). Accepts `onResult(item: BatchPricesItem)` callback and `AbortSignal` for cleanup.

**Mobile `batch-prices.tsx`**: replaced `api.batchPrices()` + bulk `setEntries` with `api.streamPrices()` + per-result `setEntries`. Each card row's spinner resolves independently as its price arrives. `AbortController` cancels the stream on unmount.
