# TCG Card Scanner

A mobile app that scans TCG (Trading Card Game) cards and fetches pricing/sales data from [PriceCharting](https://www.pricecharting.com).

For full version history and technical decisions, see [docs/ARCHITECTURE_LOG.md](docs/ARCHITECTURE_LOG.md).

---

## Open Tasks

### Priority 1 — Live Scan mode ✓ Done (v30–v31)

Fully functional. Decktradr-style single-roundtrip architecture: continuous `takeSnapshot` → backend auto-detects + recognizes in one `/scan` call → result appears in ~700-900ms. No stability gate. Deduplication by card ID (30s cooldown) plus consecutive-frame confirmation gate. See v30–v31 in Architecture Log for full details.

#### What's shipped

- `mobile/app/(tabs)/live-scan.tsx` — viewfinder, Start/Stop, **EN/JP language toggle** (pill, top-left of viewfinder), session list, running total, Done → batch-prices (deduped by card ID), swap modal, per-card delete
- `mobile/hooks/useLiveScan.ts` — sequential scan loop, single-roundtrip `/scan`, time-based dedup (30s), **consecutive-frame confirmation gate** (card must be top match on two consecutive scans before adding), `removeCard`/`swapCard` actions
- `backend/app/api/v1/scan.py` — `elif req.image:` auto-detect branch; `is_live_scan` mode supports manual language lock (`cross_lang=False`) and `language="auto"` dual-EN/JA parallel search
- Tab bar: Multi Scan | Live Scan | Search

---

### Priority 2 — Recognition improvements

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

### Manual Card Lookup

Third tab "Search" in the tab bar (Multi Scan | Live Scan | Search). Fuzzy name search against the `cards` table using `pg_trgm similarity()`. EN/JP toggle; JP search checks both `name` (English name) and `name_ja`. Results show card thumbnail, set, number — tapping navigates to `card/[id].tsx`.

#### Files

| File | Purpose |
|---|---|
| `backend/app/api/v1/cards.py` | `GET /api/v1/cards/search?q=&language=&game=&limit=` — multi-signal scoring, card number filter, exclusion terms |
| `mobile/app/(tabs)/lookup.tsx` | Search screen: debounced input (400ms, min 2 chars), EN/JP toggle, results FlatList |
| `mobile/app/(tabs)/_layout.tsx` | Third visible tab `lookup` with `search-outline` icon |
| `mobile/services/api.ts` | `api.searchCards(query, language, game, limit)` |

#### Search scoring

- First-word penalty: `sim_name × similarity(first_query_token, first_word_of_card_name)` — prevents "mew vstar" from surfacing Mewtwo above Mew
- Set hint bonus: `word_similarity(non-first-tokens, set_name) × 0.5` added to name score — "suicune prism" boosts Prismatic Evolutions cards
- Card number: last all-digit token extracted as hard filter on `card_number`
- Exclusion terms: tokens starting with `-` excluded via `NOT ILIKE` on both `name` and `set_name` — e.g. `pikachu -detective` drops all Detective Pikachu set results

#### Notes

- `name` column has a GIN trgm index; `name_ja` does not — JP searches are a full scan on ~27k rows (fast enough, index is a future optimization)
- Searching "pikachu" on the JP tab matches via `name`; "ピカチュウ" matches via `name_ja`

---

### Custom Saved Lists (Collections)

Instagram-style save flow. Tapping ★ on any card opens a bottom sheet instead of direct save/unsave. Cards always go into the default collection for their game ("Pokémon" / "One Piece") and can optionally be added to named custom lists. Cards can be in multiple lists simultaneously.

#### Files

| File | Purpose |
|---|---|
| `mobile/store/collectionsStore.ts` | Zustand store, persisted `tcg:collections`; stores `cardIds[]` per collection; `ensureDefault(game)` auto-creates the default |
| `mobile/components/UI/SaveToCollectionSheet.tsx` | Slide-up bottom sheet; default always checked+locked; dynamic checkbox toggle (no Done button); inline new list creation and rename; "Remove from saved" at bottom |
| `mobile/app/card/[id].tsx` | Star tap opens sheet instead of direct toggle |
| `mobile/app/(tabs)/saved.tsx` | Collection index — 2×2 thumbnail grid per list, tap to open |
| `mobile/app/collection/[id].tsx` | Card list/grid within a collection; pencil icon → inline header rename; trash icon → delete list with confirmation |

#### Data model

`useSavedCardsStore` is the master list — `isSaved(id)` drives the filled/empty star. `collectionsStore` is a separate layer storing only card IDs; card data is looked up from `savedCardsStore` for display. Removing from `savedCardsStore` ("Remove from saved" in sheet) purges from all collections atomically.

#### UX

- Tapping ★ saves to default immediately and opens the sheet for optional list assignment — no Done button required
- Custom list checkboxes toggle membership immediately
- Rename a list: from the collection detail screen, tap pencil icon in header → title swaps to a TextInput → submit with checkmark or return key
- Delete a list: trash icon in collection detail screen header (non-default only); cards remain in other lists

---

### Priority 3 — On-device CLIP recognition ✓ Done (Phase 5)

Fully shipped on `feature/ondevice-clip` branch (PR open, pending merge to master).

**What's on-device:** YOLO detection, CLIP embedding (TFLite dynamic-range int8), brute-force vector search over bundled int8 index, SQLite card lookup. Zero network calls for recognition.
**Stays server-side:** pricing (always networked), new-set ingestion / index builds.

#### Architecture

- `mobile/utils/vectorSearch.ts` — brute-force dot-product over `index_en.bin` / `index_ja.bin` (int8, ~24MB total); `SIM_FLOOR=0.50`
- `mobile/utils/cardsDb.ts` — SQLite wrapper (`expo-sqlite`) over bundled `cards.db`; FTS5 name search for OCR mode; McDonald's penalty
- `mobile/assets/data/` — `index_en.bin`, `index_ja.bin`, `card_ids_en.bin`, `card_ids_ja.bin`, `cards.db`, `manifest.json` (tracked via Git LFS)
- `mobile/assets/models/clip_visual.tflite` — CLIP ViT-B/32 dynamic-range int8 (tracked via Git LFS)
- `mobile/metro.config.js` — `assetExts` includes `'bin'` and `'db'`
- Per-crop server fallback: when on-device returns 0 results (sim < SIM_FLOOR due to int8 quantization drift), sends 512-dim vector (not image) to `/scan/vector`

#### Model versioning

- `backend/models/versions.json` — source of truth for all 4 model versions (`clip_server`, `yolo_server`, `clip_mobile`, `yolo_mobile`)
- `backend/app/services/model_versions.py` — `load()` / `get(key)` / `summary()` helpers
- Versions logged at startup and exposed via `GET /health`
- When retraining: bump version in `versions.json`; if `clip_mobile` changes also bump `CLIP_MODEL_VERSION` in `mobile/utils/clipEmbedder.ts`

#### Batch save from scan results

- `mobile/components/UI/BatchSaveSheet.tsx` — multi-card save sheet; saves all on open, toggles collection membership for all cards at once
- `mobile/app/multi-results.tsx` — "Save (N)" button in batch row for checked cards
- `mobile/app/batch-prices.tsx` — bookmark icon in header for all session cards

---

### Priority 4 — Demand-weighted background price refresh worker

Keeps prices fresh on cards users actually view while bounding scrape volume and block risk — buys runway before committing to PriceCharting's paid API. **Do after on-device CLIP.**

Do **not** sweep the whole catalog: an exhaustive 24/7 sequential walk of all 47k cards is the most bot-like pattern possible (also wastes freshness on bulk nobody views and trails 404s on older JP sets). Follow demand instead.

**Two separate TTLs (do not conflate):**
- **Membership/heat** — "should I still track this card?" Driven by organic searches/views.
- **Price-freshness** — "is the cached price stale enough to re-scrape?" Driven by the worker.

**Design:**
- On every organic search/view, bump the card's score in a Redis sorted set (`ZADD`). Simplest: score = expiry timestamp (`now + 2 weeks`), `ZREMRANGEBYSCORE` evicts expired (basic LRU watchlist). Better: score = decaying "heat" (bump on search, decays over time) so frequency + recency both count and drive refresh cadence.
- Worker loop: evict cold cards → take **top-N by score** (N = a fixed safe daily scrape budget — the hard cap that makes worst-case request volume deterministic regardless of traffic spikes) → for each, check price-freshness TTL (scaled by heat × price magnitude/volatility) → enqueue scrape at a controlled, jittered, diurnally-shaped rate.
- Cache miss on an untracked card → one on-demand scrape + `ZADD` into the set.
- Durable `price_views` append-only table (card_id, timestamp) in Postgres = system of record + analytics; Redis ZSET = live working set (rebuildable from the table).
- **Staleness indicator** in the UI ("as of 3h ago") — turns the freshness tradeoff into honest UX instead of a confident wrong number.

Net: a small working set means viewed cards refresh in hours (not the flat 24h), scrape volume drops 1–2 orders of magnitude vs a full sweep, and the footprint mirrors organic demand — less detectable and less adversarial.

---

> **Other backlog** (lower priority) lives in [docs/FUTURE_WORK.md](docs/FUTURE_WORK.md): Collection UX improvements, Image AI real-photo fine-tuning, PSA graded recognition, One Piece multi-TCG expansion, and free/CPU-only deployment. Dependency upgrade tracking is in [docs/DEPENDENCY_UPGRADES.md](docs/DEPENDENCY_UPGRADES.md).

---

### Known Limitations (no fix planned)

| Issue | Notes |
|---|---|
| Older JP sets price 404 on PriceCharting | Pre-2003 JP sets use Pokédex number not set position (e.g. Gastly #92 not #49). Would need a lookup table or scrape-based URL discovery. |
| JP Abra (kana-heavy cards) not detected | OCR confidence < 3 + image sim < 0.50 floor → 0 candidates. Fundamental limitation. |
| Holofoil image AI unreliable | Reflective surfaces produce visual appearances impossible to synthesize. Use OCR or Combined mode. |
| Items with digits in name (Pokégear 3.0) | Digit gate in `_find_trainer_name` rejects them. Low priority — rare edge case. |
| Badge boxes too tall on Android (multi-results) | Android `includeFontPadding: true` default. Workaround `includeFontPadding: false` applied but may not fully resolve on all devices. |

---

## Project Structure

- `backend/` — FastAPI server (Python), scrapes PriceCharting and proxies pokemontcg.io
- `mobile/` — Expo/React Native app (card scanning UI)
- `docker-compose.yml` — Local dev environment (backend + postgres + redis + worker)
- `docker-compose.oci.yml` — Production deployment (OCI Ampere A1, CPU-only, port 8002)
- `backend/Dockerfile.oci` — CPU-only image (ARM64-compatible torch, no CUDA wheels)

## Production Deployment (OCI)

- **Server**: `ubuntu@158.101.110.211` (OCI free tier, Ampere A1, 4 OCPU, 24GB RAM, no GPU)
- **Backend URL**: `https://tcg-api.quangntran.com` (nginx → `127.0.0.1:8002`)
- **Code**: `~/TCG/` — git clone of this repo tracking `master`
- **Models**: `~/TCG/backend/models/clip_finetuned.pt` + `card_detector.pt` (scp'd, not in git LFS pull path)
- **Database**: `tcg_postgres` container, volume `pgdata`
- **Nginx config**: `/etc/nginx/sites-available/tcg-api`
- **CLIP mode**: CPU fp32 fallback only (`FORCE_CPU_EMBEDDER=1`, `CLIP_MAX_CONCURRENCY=2`) — on-device handles the hot path

### Deploy updates
```bash
# On OCI after merging a PR:
cd ~/TCG && git pull && docker restart tcg_backend

# If requirements.txt or Dockerfile.oci changed:
cd ~/TCG && git pull && docker compose -f docker-compose.oci.yml up -d --build backend
```

### Local dev override
Create `mobile/.env.local` to point the app at your home machine instead of OCI:
```bash
EXPO_PUBLIC_API_URL=http://192.168.1.2:8000/api/v1
```

## Data Sources

- **EN card metadata & images** — pokemontcg.io API (stored in Postgres on first match); 20,237 cards across all sets
- **JP card metadata & images** — TCGCollector.com (`scripts/scrape_tcgcollector.py`); 27,255 cards scraped, stored as `language='ja'` rows; `image_url` points to TCGCollector CDN
- **Prices, sales, trend graphs** — PriceCharting scraper (`httpx`, 0.5s rate limit, cached in Redis 24h)
- **Exchange rates** — frankfurter.dev (`GET /api/v1/currency/rates`), cached 24h
- **PriceCharting URL patterns**:
  - EN: `https://www.pricecharting.com/game/{set-slug}/{card-name}-{card-number}`
  - JP: `https://www.pricecharting.com/game/japanese-{set-slug}/{card-name}-{card-number}` (newer sets use set position; pre-2003 sets use Pokédex number — see Known Limitations)
  - McDonald's EN: `_EN_PC_SET_SLUG` dict in `pricecharting.py` maps `"McDonald's Collection YYYY"` → `mcdonalds-YYYY` (pokemontcg.io includes "Collection"; PriceCharting drops it)
- **McDonald's EN card images**: 136 cards (2011–2022 Collection sets) have both `image_url` and `image_url_hi` pointing to TCGCollector CDN instead of pokemontcg.io — scraped via `scripts/scrape_tcgcollector.py --base-url ... --output-file backend/app/data/tcgcollector_mcd_en.json`, then loaded by `scripts/update_mcd_images.py`. Both fields must be updated because `card/[id].tsx` prefers `image_url_hi`; pokemontcg.io's original `_hires.png` URLs are broken for McDonald's sets.

### PriceCharting JP card numbering — older vs newer sets

- **Older sets** (pre-EX era, roughly pre-2003): PriceCharting uses the **Pokédex number** as the card identifier, not the card's set position. Example: Sabrina's Gastly is #49 in "Challenge from the Darkness" but PriceCharting lists it as `gastly-92`.
- **Newer sets** (EX era onward): PriceCharting uses the **card number within the set**, matching `N/total` printed format.

---

## Current System State

### Scan Pipeline (multi-card, current default)

Camera capture (`quality: 1, skipProcessing: true`) → JPEG resize to 2400px + full-image OCR in parallel → on-device YOLO detection (falls back to backend `/detect` then OCR clustering if null) → spatial-filter OCR per crop (zero extra ML Kit calls) → `POST /api/v1/scan` NDJSON stream → progressive results in `multi-results.tsx`

- Region cap: 20 cards
- Latency benchmark (Samsung S22+, 12 cards): **3.12s first card** (v22)
- **Do not `Promise.all([ML Kit OCR, NNAPI YOLO])`** — native bridge resource conflict; sequential only

### Scan Pipeline (live scan, single-card continuous)

`takeSnapshot({ quality: 80 })` → resize to 640px → `POST /api/v1/scan` with `{ image, no boxes }` → backend YOLO auto-detects largest card, crops it, runs CLIP in one pass → result streamed back → consecutive-frame confirmation → deduplicated by card ID (30s cooldown) → added to session list with background price fetch.

- Cycle time: ~700-900ms (natural pacing — next scan starts immediately after previous completes)
- No stability gate, no on-device YOLO, no separate detect roundtrip
- **Consecutive-frame confirmation gate** (`pendingMatchRef`): card must be the top match on two consecutive scans before being added. Filters transient phantoms during physical card transitions (dropping one card to reveal the next). Adds ~1 cycle of latency (~700-900ms) for the first card in a run.
- **Language toggle**: EN/JP pill in viewfinder top-left hard-locks the CLIP search to the chosen language (`cross_lang=False` in backend). An `"auto"` code path (searches both EN and JA in parallel, picks higher sim) is wired through the full stack but not exposed in the UI yet.
- Swap dedup: `swapCard` records the new card ID in `seenCardTimesRef` to prevent immediate re-add
- **Batch-prices dedup**: session cards deduplicated by card ID before navigating to batch-prices; duplicate count shown in a dismissible banner on the batch-prices screen
- Files: `mobile/hooks/useLiveScan.ts`, `mobile/app/(tabs)/live-scan.tsx`, `backend/app/api/v1/scan.py` (`elif req.image:` branch)

### Card Detection — YOLO

**Backend YOLO v2** (`backend/models/card_detector.pt`): mAP50=0.993, mAP50-95=0.964; 2,823 train images (real + synthetic); fine-tuned from v1 checkpoint on RTX 3080.

**To retrain (v3):**
```bash
py -3 scripts/generate_synthetic_yolo.py --cards assets/card_images/ --backgrounds assets/backgrounds/ --output training/datasets/pokemon/synthetic/v2 --count 2000 --glass-fraction 0.13
py -3 scripts/merge_yolo_datasets.py --src training/datasets/pokemon/merged/v2 training/datasets/pokemon/synthetic/v1 training/datasets/pokemon/synthetic/v2 --dst training/datasets/pokemon/merged/v3
# fine-tune from card_detector.pt (not base yolo11n.pt); always include all prior synthetic batches
```

Synthetic datasets: `C:\Users\Quang\Desktop\TCG Training Data\` — keep permanently.

**On-device TFLite** (`mobile/assets/models/card_detector.tflite`, 5.1MB, float16):
- Export chain: PyTorch → ONNX → TF SavedModel (onnx2tf) → float16 TFLite; `ultralytics` direct TFLite export segfaults — use onnx2tf manually
- Library: `react-native-fast-tflite` **v2.0.0** (v3 rejected onnx2tf op set silently — do not upgrade)
- Delegates: NNAPI on Android → Core ML on iOS → CPU fallback
- Input: 640×640 JPEG 0.95 → jpeg-js decode → float32 RGB NHWC; output auto-detected `[1,5,8400]` or `[1,8400,5]`
- Re-export after retraining: `YOLO.export(format='onnx')` + `onnx2tf -i .onnx -o _saved_model -osd` → copy `_float16.tflite` to `mobile/assets/models/card_detector.tflite`

### Image AI — CLIP

- Model: CLIP ViT-B/32, 512-dim L2-normalized; art-region crop `y=12%–52%`
- Coverage: 47,442 embeddings — 20,187 EN + 27,255 JP; ~50 unembeddable (older McDonald's promos and obscure promos with broken CDN URLs)
- Fine-tuned weights at `backend/models/clip_finetuned.pt` (auto-loaded at startup); best epoch 7, loss 0.0077
- fp16 on CUDA; partial IVFFlat indices per language (`probes=20`, `LIMIT 10`)
- Thresholds: `_SIM_THRESHOLD = 0.65` (confident); `_SIM_FLOOR = 0.50` (floor); `_IMAGE_MIN_SIM_WITH_OCR = 0.83` (combined gate)
- Cross-language fallback requires `other_sim > best_sim + 0.05` margin before switching

### Card Recognition — OCR

- **`_find_pokemon_name`**: HP line as anchor; strips inline HP, BASIC prefix and OCR misreads (`.{0,2}asic`); rejects all-caps >3, digits, punctuation, attack-body next-line; requires known Pokémon name match
- **EN Trainer/Supporter/Item/Tool**: `_find_trainer_name` finds standalone keyword, takes name 1–2 lines above
- **JP Trainer extraction**: `_find_jp_trainer_name` finds グッズ/サポート/スタジアム/ポケモンのどうぐ; `_search_db_ja_trainer` searches `Card.name_ja` directly
- **Owner-prefix cards**: `'s` stripped before punctuation gate (EN); kana name found as substring of `の`-prefix line (JP)
- **Fuzzy name fallback**: `pg_trgm similarity() > 0.35`
- **Auto language detection**: `KANA_RE = /[゠-ヿぁ-ゖ]{2,}/` on name-region sub-crop (top 18%) — no language toggle
- **Card number spatial filter**: bottom 8%, left-corner (x 0–35%) and right-corner (x 65–100%)
- **Search ranking**: exact name → priority 0; card number match → priority 0; set_total match → priority 0; tie-break `id DESC`; McDonald's promo penalty as tertiary sort

### Adding new JP sets

```bash
# 1. Scrape TCGCollector (stops at already-known cards)
py -3 scripts/scrape_tcgcollector.py --newest-first

# 2. Load into DB (upsert — safe to re-run)
docker exec tcg_backend bash -c "cd /app && python /scripts/load_jp_cards.py"

# 3. Embed new cards (skips already-embedded; rebuilds IVFFlat index)
docker exec tcg_backend bash -c "cd /app && python /scripts/build_embeddings.py --language ja"

# 4. Restart backend
docker restart tcg_backend
```

### Price & Data

- PriceCharting scraper: `httpx.AsyncClient`, brotli via `brotlicffi`, 0.5s rate limit, ~1s per card
- Streaming batch prices: `POST /api/v1/cards/prices/stream` — NDJSON, `asyncio.as_completed`, `PriceOutSlim` schema (~8KB vs ~69KB full)
- Card variants: 1st Edition / Shadowless / Poké Ball / Master Ball; suffix inserted in card slug
- Currency toggle: USD/JPY via frankfurter.dev, cached 24h in Redis
- Force-refresh: `GET /api/v1/cards/{id}?force_refresh=true` bypasses Redis cache
- Price trend chart: `VGPC.chart_data` embedded JS; `price_history_ungraded` (Raw tab) or `price_history_graded` (PSA tabs); no per-grade series available from single page scrape

---

## Known Issues

- Image AI mode similarity scores for some cards (e.g. Lotad) are around 0.43 — below `_SIM_FLOOR = 0.50`. Combined/OCR mode reliably identifies these cards.
- **Live Scan**: fully functional as of v30. On-device YOLO is unused in live scan — backend handles detect+recognize in a single roundtrip.
- **Variant sales filtering — needs review**: Normal variant excludes sales whose title matches `pok[eé][\s-]?ball` or `master[\s-]?ball`; Poké Ball / Master Ball variants show all sales unfiltered (PriceCharting already scopes them). Needs real-device testing across several cards to confirm: (1) Normal no longer shows variant sales, (2) Poké Ball / Master Ball pages show expected sales, (3) no edge-case titles are missed or over-excluded. File: `mobile/components/Card/PriceDisplay.tsx` (`filterSales`).

---

## Key Files

- `mobile/hooks/useMultiCardScan.ts` — multi-card pipeline: detect → crop → OCR/image match → results; RRF merge in combined mode; auto per-crop language detection
- `mobile/hooks/useLiveScan.ts` — live scan loop, stability tracker, captureAndScan
- `mobile/services/api.ts` — `api.detectCards()`, `api.scanStream()`, `api.streamPrices()`, all API calls
- `mobile/utils/yoloDetector.ts` — `detectCardsWithYolo()`; NNAPI/CoreML/CPU delegates; stale-handle recovery
- `mobile/utils/detectCards.ts` — `filterBlocksToCardZone`, `detectCardRegions` (fallback), `boxesToRegions`
- `mobile/utils/cardConfidence.ts` — single-card confidence scoring
- `mobile/components/Scanner/ScanOverlay.tsx` — scan frame dimensions (75% W, 88/63 ratio, -40px Y)
- `mobile/components/Scanner/LiveBoundingBox.tsx` — animated corner-bracket overlay for live scan
- `mobile/components/Scanner/StabilityRing.tsx` — stability progress bar for live scan
- `mobile/components/UI/ScanModeToggle.tsx` — OCR / Image AI / Combined toggle
- `mobile/components/Card/PriceChart.tsx` — trend graph
- `mobile/store/savedCardsStore.ts` — saved cards, persisted via AsyncStorage (`tcg:saved-cards`)
- `backend/app/services/card_detector.py` — YOLO11n card detection (`detect_card_rectangles`)
- `backend/app/services/card_embedder.py` — CLIP ViT-B/32 embedding (fine-tuned weights auto-loaded)
- `backend/app/api/v1/scan.py` — `POST /api/v1/scan` unified endpoint: batch CLIP embed + parallel pgvector + parallel OCR + NDJSON stream
- `backend/app/api/v1/detect.py` — `POST /api/v1/detect` endpoint (backend fallback for live scan)
- `backend/app/api/v1/cards.py` — price endpoints including streaming batch prices
- `backend/app/services/card_matcher.py` — search orchestration, ranking, price caching
- `backend/app/scrapers/pricecharting.py` — PriceCharting scraper (httpx)
- `backend/app/data/tcgcollector_ja.json` — 27,255 JP card entries; source of truth for JP card data
- `backend/app/data/set_printed_totals.json` — 172 EN sets mapped to `printedTotal`; used by `_dedupe_and_rank`
- `backend/app/data/pokemon_kana_to_en.json` — kana→English name dict (1028 entries)
- `backend/models/embedding_failures.json` — EN embedding state: 20,187 embedded, 50 unembeddable
- `scripts/build_embeddings.py` — embedding pipeline; rebuilds IVFFlat index after completion
- `scripts/load_jp_cards.py` — upserts TCGCollector JP cards into `cards` table; safe to re-run
- `scripts/scrape_tcgcollector.py` — scrapes TCGCollector card image grid (JP or EN via `--base-url`); `--newest-first` for delta updates; `--output-file` to write to a custom path instead of `tcgcollector_ja.json`
- `scripts/update_mcd_images.py` — reads `tcgcollector_mcd_en.json`, matches by year+card_number, updates both `image_url` and `image_url_hi` for McDonald's EN cards in DB
- `scripts/fine_tune_clip.py` — CLIP fine-tuning; `--generate-pairs` for offline pair generation
- `scripts/generate_synthetic_yolo.py` — synthetic YOLO training data generation
- `scripts/merge_yolo_datasets.py` — merges multiple YOLO datasets, remaps to single class 0 `card`
