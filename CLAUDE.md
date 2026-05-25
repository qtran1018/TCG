# TCG Card Scanner

A mobile app that scans TCG (Trading Card Game) cards and fetches pricing/sales data from [PriceCharting](https://www.pricecharting.com).

For full version history and technical decisions, see [docs/ARCHITECTURE_LOG.md](docs/ARCHITECTURE_LOG.md).

---

## Open Tasks

### Priority 1 — Live Scan mode (in progress)

Screen and core hook are built (v27). Remaining blocker: card detection never fires, so bounding box overlay and auto-trigger are non-functional.

#### What's done

- `mobile/app/(tabs)/live-scan.tsx` — viewfinder, Start/Stop buttons, session list, running total, Done → batch-prices
- `mobile/hooks/useLiveScan.ts` — recursive setTimeout loop, stability tracker (800ms hold), `captureAndScan` via `api.scanStream`, background price fetch per card
- `mobile/components/Scanner/LiveBoundingBox.tsx` — animated corner-bracket overlay
- `mobile/components/Scanner/StabilityRing.tsx` — animated stability progress bar
- Tab bar updated: Multi Scan | Live Scan (Saved/History hidden but routable)

#### Remaining blocker — YOLO always returns null in loop context

`detectCardsWithYolo` throws `"Value is undefined, expected an Object"` on `model.run([input])` for both NNAPI and CPU fallback when called in a tight async loop. The same model works fine in multi scan (one-shot). Suspected JSI/GC handle invalidation unique to high-frequency calling. See v27 in Architecture Log for full details.

**Fix:** In `runOneCycle` (`mobile/hooks/useLiveScan.ts`), when `detectCardsWithYolo` returns null fall back to `api.detectCards(base64Snapshot, sw, sh)` — the existing backend `/detect` endpoint (~200–400ms, reliable). Box coordinates feed into the same stability tracker unchanged.

**Files to change:**
- `mobile/hooks/useLiveScan.ts` — `runOneCycle`: if YOLO returns null, base64-encode snapshot → `api.detectCards()` → extract primary box
- `mobile/services/api.ts` — confirm `detectCards(base64, w, h)` signature (already exists)

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

### In-Progress / Testing — Manual Card Lookup

Third tab "Search" in the tab bar (Multi Scan | Live Scan | Search). Fuzzy name search against the `cards` table using `pg_trgm similarity()`. EN/JP toggle; JP search checks both `name` (English name) and `name_ja`. Results show card thumbnail, set, number — tapping navigates to `card/[id].tsx`.

#### Files

| File | Purpose |
|---|---|
| `backend/app/api/v1/cards.py` | `GET /api/v1/cards/search?q=&language=&game=&limit=` — similarity threshold 0.1, ordered by score desc |
| `mobile/app/(tabs)/lookup.tsx` | Search screen: debounced input (400ms, min 2 chars), EN/JP toggle, results FlatList |
| `mobile/app/(tabs)/_layout.tsx` | Third visible tab `lookup` with `search-outline` icon |
| `mobile/services/api.ts` | `api.searchCards(query, language, game, limit)` |

#### Notes

- `name` column has a GIN trgm index; `name_ja` does not — JP searches are a full scan on ~27k rows (fast enough, index is a future optimization)
- Searching "pikachu" on the JP tab matches via `name`; "ピカチュウ" matches via `name_ja`

---

### In-Progress / Testing — Custom Saved Lists (Collections)

Instagram-style save flow. Tapping ★ on any card opens a bottom sheet instead of direct save/unsave. Cards always go into the default collection for their game ("Pokémon" / "One Piece") and can optionally be added to named custom lists. Cards can be in multiple lists simultaneously.

#### Files

| File | Purpose |
|---|---|
| `mobile/store/collectionsStore.ts` | Zustand store, persisted `tcg:collections`; stores `cardIds[]` per collection; `ensureDefault(game)` auto-creates the default |
| `mobile/components/UI/SaveToCollectionSheet.tsx` | Slide-up bottom sheet (Modal + Animated, same pattern as GameDrawer); default always checked+locked; checkboxes for custom lists; inline new list creation; "Remove from saved" when already saved |
| `mobile/app/card/[id].tsx` | Star tap opens sheet instead of direct toggle |
| `mobile/app/(tabs)/saved.tsx` | Trash icon now also calls `removeCardFromAll` to keep collections in sync |

#### Data model

`useSavedCardsStore` is the master list — `isSaved(id)` drives the filled/empty star. `collectionsStore` is a separate layer storing only card IDs; card data is looked up from `savedCardsStore` for display. Removing from `savedCardsStore` (trash in saved screen or "Remove from saved" in sheet) purges from all collections atomically.

#### All parts built

- `saved.tsx` → collection index (2×2 thumbnail grid per collection, long-press to delete custom)
- `mobile/app/collection/[id].tsx` → card list/grid within a collection; remove from custom list only; remove from default = full unsave with confirmation; trash icon in header for non-default collections

---

### Future — Image AI improvements

**Real photo fine-tuning** (if CLIP similarity remains unreliable after threshold tuning):

- CLIP via `open-clip-torch` is MIT licensed — safe for commercial release
- Minimum useful scale is thousands of labeled real card photos
- Fine-tune with InfoNCE contrastive loss; re-embed all cards

**Model license table:**

| Model                  | License               | App release            |
| ---------------------- | --------------------- | ---------------------- |
| CLIP (open-clip-torch) | MIT                   | Yes                    |
| DINOv2                 | CC BY-NC 4.0          | No                     |
| DINOv3                 | Custom (access-gated) | No                     |
| YOLO11n (ultralytics)  | AGPL-3.0              | Yes (with attribution) |

---

### Future — Background price refresh worker

Not worth implementing until there are concurrent users (~10–20 active). Worker runs nightly, pre-refreshes hot-set Redis keys before their 24h TTL expires. Requires a new `price_views` append-only table to track request frequency.

---

### Future — PSA graded card recognition

- Target: Japanese card shops that cover cert numbers with price stickers
- Approach: read grade from PSA label + card name → PSA population report to narrow cert candidates

---

### Future — One Piece (multi-TCG expansion)

**Recommendation: one app with game selector.** The `cards` table already has a `game` column. OCR and price UI are game-agnostic.

**Before shipping One Piece:** add `Card.game == game` to the WHERE clause in `_vector_search` in `backend/app/api/v1/scan.py` (line ~274) — one line prevents cross-game contamination in pgvector results.

**CLIP retraining:** train on combined Pokémon + One Piece pairs simultaneously to avoid catastrophic forgetting. Use `--generate-pairs` to save pairs to disk, then merge before training:

```bash
python scripts/merge_clip_pairs.py \
    training/clip_pairs/pokemon \
    training/clip_pairs/one_piece \
    training/clip_pairs/combined
# scripts/merge_clip_pairs.py does not exist yet — ~30 lines to write
```

**OCR gaps:** One Piece card types (Event, Stage, Leader, Character, Don!!) need OP-specific keyword list. Card number format `OP01-001` may need regex update in `_search_db`.

**Data sources:**
- **Prices**: PriceCharting covers One Piece — `pricecharting.com/game/one-piece-{set-slug}/{card-slug}`
- **JP cards**: TCGCollector may cover One Piece sets

---

### Dependency Upgrades (do last — after live scan and new features are stable)

Run `expo upgrade` to handle the coordinated Expo + React Native bump.

| Package | Installed | Latest | Notes |
|---|---|---|---|
| `expo` | 54.0.x | 56.0.4 | Use `expo upgrade` — do not upgrade manually |
| `expo-router` | 6.0.x | 56.2.6 | Comes with expo upgrade |
| `react-native` | 0.81.5 | 0.85.3 | Comes with expo upgrade |
| `react` | 19.1.0 | 19.2.6 | Minor |
| `react-native-vision-camera` | 4.7.3 | 5.0.10 | Locked to v4 (v5 dropped Expo config plugin); check if v5 adds it back before upgrading |
| `react-native-reanimated` | 4.1.1 | 4.3.1 | Minor |
| `react-native-gesture-handler` | 2.28.0 | 2.31.2 | Minor |
| `react-native-screens` | 4.16.0 | 4.25.2 | Minor |
| `react-native-safe-area-context` | 5.6.0 | 5.8.0 | Minor |
| `react-native-fast-tflite` | 2.0.0 | 3.0.1 | Major — check changelog, may affect on-device YOLO |
| `react-native-worklets` | 0.5.1 | 0.8.3 | Minor |
| `zustand` | 4.5.0 | 5.0.13 | Major — store API changed |
| `axios` | 1.7.0 | 1.16.1 | Minor |
| `react-native-svg` | 15.12.1 | 15.15.5 | Patch |
| `@react-native-async-storage/async-storage` | 2.2.0 | 3.1.0 | Major |
| `@react-native-ml-kit/text-recognition` | 1.0.0 | 2.0.0 | Major — likely breaking OCR API changes |
| `react-native-nitro-modules` | 0.35.6 | 0.35.7 | Patch |
| `typescript` | 5.4.0 | 6.0.3 | Major |

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

## Data Sources

- **EN card metadata & images** — pokemontcg.io API (stored in Postgres on first match); 20,237 cards across all sets
- **JP card metadata & images** — TCGCollector.com (`scripts/scrape_tcgcollector.py`); 27,255 cards scraped, stored as `language='ja'` rows; `image_url` points to TCGCollector CDN
- **Prices, sales, trend graphs** — PriceCharting scraper (`httpx`, 0.5s rate limit, cached in Redis 24h)
- **Exchange rates** — frankfurter.dev (`GET /api/v1/currency/rates`), cached 24h
- **PriceCharting URL patterns**:
  - EN: `https://www.pricecharting.com/game/{set-slug}/{card-name}-{card-number}`
  - JP: `https://www.pricecharting.com/game/japanese-{set-slug}/{card-name}-{card-number}` (newer sets use set position; pre-2003 sets use Pokédex number — see Known Limitations)

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
- Coverage: 47,442 embeddings — 20,187 EN + 27,255 JP; 50 unembeddable (McDonald's promos CDN 404)
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
- **Live Scan YOLO detection broken**: `detectCardsWithYolo` always returns null in the continuous loop context. Fix in progress (see Priority 1 in Open Tasks). Multi scan (one-shot) is unaffected.

---

## OCR Name Extraction Reference (card_matcher.py)

### How `_find_pokemon_name` works

1. Find the HP line (`HP_RE`) as an anchor — name must be at or before it
2. If HP found: search lines `0..hp_idx` (cap 6). If HP absent: search all lines
3. For each candidate line:
   - Strip inline HP value (`"Lotad HP 40"` → `"Lotad"`)
   - Strip leading non-name prefixes (`"BASIC Lotad"` → `"Lotad"`)
   - Reject: < 3 chars, > 3 words, contains digit, contains `.,!?;:()/\'`, starts lowercase, all-caps (len > 3), any word in non-name list
   - **When no HP anchor**: reject if next line matches `_ATTACK_BODY_RE`
   - **Final gate**: reject if candidate doesn't contain a known Pokémon base name (`_contains_pokemon_name`)

### Non-name prefix list (`_POKEMON_NON_NAME_RE`)

Covers: BASIC and OCR misreads (`.{0,2}asic` pattern), Stage 1/2, Mega, Weakness, Resistance, Retreat, Damage, Ability, Trainer, Item, Stadium, Supporter, Energy types, Pokémon, Nintendo, Game Freak, Creatures, Illus., No., Copyright, Overrun, Aurora, Beam, HP

Note: VMAX/VSTAR/VUNION intentionally **not** in this list — valid name suffixes. Standalone "VMAX" is rejected by the all-caps rule.

### Search strategy (`_search_db`)

1. Name + card number (preferred)
2. Number only (only when name is also present, as fallback)
3. Name only

Number-only search without a name is disabled — too many false matches across sets.

### Card format support

Base, Holo, Full Art, Alolan/Galarian/Hisuian/Paldean, EX/ex/GX/V/VMAX/VSTAR/VUNION, Tag Team (`Pikachu & Zekrom-GX`), owner-prefix (Misty's, Sabrina's)

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
- `scripts/scrape_tcgcollector.py` — scrapes TCGCollector JP card image grid; `--newest-first` for delta updates
- `scripts/fine_tune_clip.py` — CLIP fine-tuning; `--generate-pairs` for offline pair generation
- `scripts/generate_synthetic_yolo.py` — synthetic YOLO training data generation
- `scripts/merge_yolo_datasets.py` — merges multiple YOLO datasets, remaps to single class 0 `card`
