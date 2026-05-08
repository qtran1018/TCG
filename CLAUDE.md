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

## Completed Features (Multi-card)
- Camera mode: capture full image → OCR → detect card regions → crop each → re-OCR → confidence check → batch search backend → results UI
- `useMultiCardScan` hook orchestrates the full pipeline
- `multi-results.tsx`: shows all identified cards with image/name/set/number; "Swap" button to choose alternate candidates
- `POST /api/v1/search/batch` backend endpoint: accepts up to 10 queries, returns candidates per query
- `detectCardRegions` in `mobile/utils/detectCards.ts`: adaptive threshold clustering + recursive aspect-ratio splitting

## In Progress
### Multi-card region detection reliability (`mobile/utils/detectCards.ts`)

**What works:** Scanning 2 cards placed directly side-by-side (touching or near-touching) detects both consistently.

**Current issue:** Detection breaks down when:
- Cards have a visible gap between them (background OCR blocks fill the gap, breaking axis-gap detection)
- Cards are arranged non-linearly (triangle, one above another, etc.)

**Current approach (as of last session):**
`detectCardRegions` runs single-linkage BFS clustering at 5 progressive thresholds (8%–60% of min image dimension). For each resulting cluster, `recursiveSplitCluster` recursively splits at the bounding box midpoint (horizontal if too wide, vertical if too tall) until each piece has a card-shaped aspect ratio (0.40–1.10 W/H). The threshold pass yielding the most card-shaped regions wins. Falls back to the largest cluster if nothing passes.

**Why it's still inconsistent:**
- At the threshold needed to connect all blocks within a single card (~0.25–0.40 × minDim = 300–480px), blocks from adjacent cards also fall within range and merge via single-linkage chaining.
- Recursive splitting at bounding box midpoints works when cards are cleanly left/right or top/bottom, but diagonal or triangular arrangements produce clusters that don't split cleanly along either axis.
- OCR block count per card varies (sparse cards like Basic Energy have fewer blocks), making some cards invisible to the confidence filter.

**Next debugging steps if detection remains unreliable:**
- Log how many regions `detectCardRegions` returns and what their aspect ratios are, to diagnose whether the issue is clustering, splitting, or confidence filtering
- Consider density-based splitting: find the lowest-density column/row in the cluster's projection profile as the split point, rather than always splitting at the geometric midpoint
- Consider DBSCAN-style minimum density threshold to discard background noise blocks before clustering

## Roadmap
### 1. Multi-card batch recognition (in progress — detection reliability)
- Scan a display case with many cards visible
- Detect individual card bounding boxes, crop, OCR, price each one
- UI to review all detected cards at once

### 2. Japanese card support
- Japanese OCR already works (ML Kit Japanese script)
- Need JP→EN name mapping to bridge Japanese card names to the English pokemontcg.io DB
- Approach: use `name_ja` field already stored on Card model; match via local lookup or translation API
- Set names and card numbers can anchor the search when name translation is uncertain

### 3. PSA graded card recognition via camera
- Target: Japanese card shops that cover cert numbers with price stickers
- Visible information: card name/art, PSA grade label (usually not stickered)
- Approach: read grade from label + card name → look up PSA population report to narrow cert candidates
- May require PSA pop report scraping

## Key Files
- `mobile/hooks/useOCR.ts` — image preprocessing, OCR, zone block filtering
- `mobile/utils/detectCards.ts` — `filterBlocksToCardZone` (single) + `detectCardRegions` (multi)
- `mobile/utils/cardConfidence.ts` — single-card confidence scoring
- `mobile/components/Scanner/ScanOverlay.tsx` — scan frame dimensions (75% W, 88/63 ratio, -40px Y)
- `mobile/components/Card/PriceChart.tsx` — trend graph
- `backend/app/scrapers/pricecharting.py` — PriceCharting scraper
- `backend/app/services/card_matcher.py` — search orchestration, ranking, price caching
