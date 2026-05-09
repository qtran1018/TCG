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
- Multi-card region detection is partially working but inconsistent for non-trivial card arrangements (see In Progress below).
- OpenCV midpoint splits can land on the seam between two adjacent cards, producing a crop that contains text from both. The confidence gate and attack-body-text lookahead mitigate this but don't eliminate it.

## Completed Features (Multi-card)
- Camera mode: capture full image → OCR → detect card regions → crop each → re-OCR → confidence check → batch search backend → results UI
- `useMultiCardScan` hook orchestrates the full pipeline
- `multi-results.tsx`: shows all identified cards with image/name/set/number; query used shown per card (`🔍 Name #N`); "Swap" button to choose alternate candidates
- `POST /api/v1/search/batch` backend endpoint: accepts up to 10 queries, returns candidates per query
- `detectCardRegions` in `mobile/utils/detectCards.ts`: adaptive threshold clustering + recursive aspect-ratio splitting
- Frontend dedup: cards with the same top-candidate ID are deduplicated before showing results

## In Progress
### Multi-card region detection — OpenCV outline detection (testing)

**Architecture change (completed):** Replaced OCR-block clustering as the primary region detector with a backend OpenCV contour detection pipeline. OCR clustering remains as a fallback.

**New detection flow:**
1. Resize image to 1600px wide
2. OCR full image + read base64 **in parallel**
3. `POST /api/v1/detect` → backend runs `adaptiveThreshold` → `findContours` → aspect-ratio filter (0.50–0.95 W/H) → NMS → returns bounding boxes in image-pixel coordinates
4. If boxes returned: use them directly as crop regions (`boxesToRegions`)
5. If none returned or network fails: fall back to `detectCardRegions` (OCR clustering)
6. Crop each region (5% margin) → re-OCR → confidence check → batch search

**Why OpenCV instead of OCR clustering:**
- Detects the physical card border, not where text happens to be — works for art-heavy cards (Basic Energy, etc.)
- Not affected by background text filling gaps between cards
- Works for any card arrangement (gaps, stacked, diagonal, triangle)
- No new native mobile dependencies — OpenCV runs in the existing FastAPI container

**Current step:** Testing with real cards in various arrangements:
- 2 cards side-by-side with gap ✅
- 2 cards stacked (one above another) — partial
- L-shape arrangement (e.g. 1 card top row, 2 bottom) — partial
- Triangle arrangement (3 cards) — untested
- Single card close-up ✅

**Tuning parameters (in `backend/app/services/card_detector.py`):**
- `_ASPECT_MIN / _ASPECT_MAX` (0.50–0.95): tighten if false positives appear
- `_MIN_AREA_FRAC` (0.010): raise if shelf/desk edges are detected as cards
- `_MAX_CARD_AREA_FRAC` (0.12): single card must cover ≤12% of image; larger = merged multi-card
- `blockSize=21` in `adaptiveThreshold`
- `iterations=1`, kernel `(3,3)` in morphological close — small to avoid bridging adjacent card borders
- CLAHE (`clipLimit=2.0, tileGridSize=(8,8)`) applied before thresholding — improves holo/foil card border detection

## OCR Name Extraction (card_matcher.py)

### How `_find_pokemon_name` works
1. Find the HP line (`HP_RE`) as an anchor — name must be at or before it
2. If HP found: search lines `0..hp_idx` (cap 6). If HP absent: search all lines
3. For each candidate line:
   - Strip inline HP value (`"Lotad HP 40"` → `"Lotad"`)
   - Strip leading non-name prefixes (`"BASIC Lotad"` → `"Lotad"`)
   - Reject: < 3 chars, > 3 words, contains digit, contains `.,!?;:()/\'`, starts lowercase, all-caps (len > 3), any word in non-name list
   - **When no HP anchor**: reject if next line matches `_ATTACK_BODY_RE` (starts with "put", "this attack", "flip", etc.) — prevents attack names from adjacent card crops being accepted

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

## Roadmap
### 1. Multi-card batch recognition (in progress — testing OpenCV detection)
- Scan a display case with many cards visible
- Detect individual card bounding boxes, crop, OCR, price each one
- UI to review all detected cards at once

### 2. Japanese card support
- Japanese OCR already works (ML Kit Japanese script)
- Kana→English name mapping built and stored in `backend/app/data/pokemon_kana_to_en.json` (1028 entries, all gens including Gen X: Browt #1026, Pombon #1027, Gecqua #1028)
- Loader: `backend/app/data/pokemon_names.py` — `kana_to_english(kana: str) -> str | None`, loaded once at import
- Source: Bulbapedia List of Japanese Pokémon names, Kana column mapped to English
- Full list with ndex also at `backend/app/data/pokemon_names_ja.json`
- **TODO**: Wire `kana_to_english()` into `card_matcher.py` — when `language == "ja"`, translate `probable_name` from kana to English before DB search and pokemontcg.io API call
- Set names and card numbers can anchor the search when name translation is uncertain
- Special cases (Tag Team, regional forms in Japanese) deferred

### 3. PSA graded card recognition via camera
- Target: Japanese card shops that cover cert numbers with price stickers
- Visible information: card name/art, PSA grade label (usually not stickered)
- Approach: read grade from label + card name → look up PSA population report to narrow cert candidates
- May require PSA pop report scraping

## Key Files
- `mobile/hooks/useOCR.ts` — image preprocessing, OCR, zone block filtering (single-card)
- `mobile/hooks/useMultiCardScan.ts` — multi-card pipeline: detect → crop → re-OCR → batch search
- `mobile/utils/detectCards.ts` — `filterBlocksToCardZone` (single), `detectCardRegions` (fallback), `boxesToRegions` (converts backend boxes)
- `mobile/utils/cardConfidence.ts` — single-card confidence scoring
- `mobile/services/api.ts` — `api.detectCards()`, `api.batchSearch()`, all API calls
- `mobile/components/Scanner/ScanOverlay.tsx` — scan frame dimensions (75% W, 88/63 ratio, -40px Y)
- `mobile/components/Card/PriceChart.tsx` — trend graph
- `backend/app/services/card_detector.py` — OpenCV card outline detection (`detect_card_rectangles`)
- `backend/app/api/v1/detect.py` — `POST /api/v1/detect` endpoint
- `backend/app/scrapers/pricecharting.py` — PriceCharting scraper
- `backend/app/services/card_matcher.py` — search orchestration, ranking, price caching
- `backend/app/data/pokemon_kana_to_en.json` — kana→English name dict (1028 entries)
- `backend/app/data/pokemon_names_ja.json` — full list with ndex + english + kana
- `backend/app/data/pokemon_names.py` — `kana_to_english()` loader
