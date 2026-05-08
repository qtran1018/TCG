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
- Best-offer price fix: scraper now reads accepted price instead of N/A for best-offer eBay sales
- Y-axis graph labels scale correctly for sub-$1 cards
- Single-card confidence gate: OCR text scored before hitting backend (card number, HP, keywords, copyright)

## Current Scan Flow (single card)
1. Camera captures photo
2. `useCardDetection` detects card bounding boxes via ML Kit Object Detection; falls back to fixed-frame crop if none found
3. Largest detected card region is cropped and OCR'd
4. OCR text scored by `cardConfidence.ts` — rejected if score < 3
5. Backend extracts hints (name, card number) and searches DB + pokemontcg.io
6. Results returned; user selects card
7. PriceCharting scraped for prices, sales, trend graph (Redis cached)

## In Progress
### Card outline detection
- Using `@react-native-ml-kit/object-detection` to find card bounding boxes dynamically
- Filters detections by TCG card aspect ratio (63:88 portrait ± tolerance)
- Falls back to fixed-frame crop if no card-shaped object detected
- Foundation for multi-card recognition

## Roadmap
### 1. Multi-card batch recognition
- Detect all card bounding boxes in one image (display case photo)
- Run OCR + confidence check on each crop sequentially
- Batch search backend; PriceCharting rate-limited via existing `check_rate_limit` (1 req/3s)
- UI to review and confirm all detected cards

### 2. Japanese card support
- Japanese OCR already supported (ML Kit Japanese script)
- Need a JP→EN name mapping layer to bridge Japanese card names to English DB entries
- Likely approach: pokemontcg.io has `name_ja` fields; map via local lookup or translation API
- Set names and card numbers can anchor the search when name translation is uncertain

### 3. PSA graded card recognition via camera
- Target: Japanese card shops that cover cert numbers with price stickers
- Approach: identify PSA slab outline + grade label from camera (grade is usually visible even when cert is hidden)
- Use visible grade + card name/image to look up likely cert and pricing
- May require PSA population report scraping to narrow candidates

## Key Files
- `mobile/hooks/useOCR.ts` — image preprocessing + OCR
- `mobile/utils/detectCards.ts` — ML Kit object detection + card region filtering
- `mobile/utils/cardConfidence.ts` — single-card confidence scoring
- `mobile/components/Scanner/ScanOverlay.tsx` — scan frame dimensions (75% W, 88/63 ratio, -40px Y offset)
- `mobile/components/Card/PriceChart.tsx` — trend graph
- `backend/app/scrapers/pricecharting.py` — PriceCharting scraper
- `backend/app/services/card_matcher.py` — search orchestration + price caching
