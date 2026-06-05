# TCG Card Scanner — Full Technical Rundown

## What the App Does

You point your phone camera at one or more Pokémon (or One Piece) trading cards. The app identifies each card by name and set, then fetches real market prices from PriceCharting.com. There are two scanning modes: **Multi Scan** (photograph a spread of cards at once) and **Live Scan** (continuous real-time scanning, one card at a time).

---

## High-Level Architecture

```
┌─────────────────────────────┐       ┌─────────────────────────────────────────┐
│  Mobile App (React Native)  │       │         Backend (FastAPI, Python)        │
│                             │       │                                          │
│  Camera → On-device YOLO    │──────▶│  YOLO detection (if needed)             │
│  On-device OCR (ML Kit)     │       │  CLIP image embedding (GPU/CPU)         │
│  XHR streaming client       │◀──────│  pgvector similarity search             │
│  Zustand state stores       │       │  OCR text → DB search                   │
│  Expo Router (tabs)         │       │  PriceCharting scraper                  │
└─────────────────────────────┘       │  Redis price cache                      │
                                      │  PostgreSQL + pgvector                  │
                                      └─────────────────────────────────────────┘
```

The backend is a **FastAPI** server with a **PostgreSQL** database (using the **pgvector** extension for AI similarity search) and **Redis** for caching prices. The mobile app is built with **Expo** (React Native).

---

## The Card Database

The database has ~47,500 cards:

- **20,237 English cards** sourced from the `pokemontcg.io` API
- **27,255 Japanese cards** scraped from `TCGCollector.com`

Each card row has: name, set name, card number, image URL, language, and a game column (`pokemon` / `one_piece`).

Every card also has a **CLIP embedding** — a 512-dimensional float vector that represents what the card's art looks like. These are stored in pgvector and used for visual similarity search ("which stored card looks most like this photo?").

---

## Card Recognition — The Two Signals

The app uses two independent signals to identify a card, then combines them:

### Signal 1: Image AI (CLIP)

**CLIP** (Contrastive Language-Image Pretraining) is a neural network from OpenAI that converts images to 512-dimensional vectors. Cards with similar art produce vectors that are close together in that 512-dimensional space.

The backend runs a fine-tuned version of **CLIP ViT-B/32** (`backend/models/clip_finetuned.pt`). It was fine-tuned on real card photo pairs to improve accuracy over stock CLIP, especially for cards with similar art.

**Flow:**

1. The card art region is cropped (top 12–52% of card height — skips the name text at top and stats at bottom)
2. CLIP encodes it into a 512-dim vector, L2-normalized
3. pgvector runs an **IVFFlat approximate nearest-neighbor search** (`probes=20, LIMIT 10`) returning the 10 closest stored card embeddings
4. Scores below 0.50 are discarded (floor threshold); scores above 0.65 are considered confident

**Perceptual hash re-ranking:** After CLIP retrieves candidates, a **phash** (perceptual hash) of the art region is computed and compared with Hamming distance. This catches holofoil reflections and lighting variations that CLIP scores similarly.

### Signal 2: OCR (Text Recognition)

The app uses **ML Kit** (Google's on-device OCR) to read text off the card. The backend's `card_matcher.py` then parses that raw text.

**For Pokémon cards, the name extraction works like this:**

1. Find the HP line (e.g., "HP 120") as an anchor — the card name is always above it
2. Scan lines above the HP anchor; reject anything that's all-caps, contains digits, contains punctuation, is too short, or matches known non-name words (BASIC, Stage 1, Weakness, etc.)
3. The surviving candidate must contain a **known Pokémon name** from a hardcoded dictionary — this is the final gate that prevents garbage OCR output from matching anything

**For Trainer/Supporter/Item/Stadium cards:**
Find the keyword line ("Trainer", "Supporter", etc.) then take the name 1–2 lines above it.

**For Japanese cards:**
Kana characters (`゠-ヿ`, `ぁ-ゖ`) are detected with a regex; then a `pokemon_kana_to_en.json` dictionary (1,028 entries) translates the kana name to English for the DB search.

The card number (e.g., "047/165") is extracted separately by spatially filtering OCR blocks from the bottom 8% of the card image — left corner first (where most sets print it), right corner as fallback.

### Combining Both Signals — RRF

When both signals are available (Combined mode), the backend uses **Reciprocal Rank Fusion (RRF)**. Each signal produces a ranked list of candidates; RRF merges them using the formula `1 / (rank + 60)`, summing scores across signals. Cards ranked highly by both signals bubble to the top. Card number matches get a bonus weight on top of this.

---

## The Scan Endpoint — `POST /api/v1/scan`

This is the central API endpoint in `backend/app/api/v1/scan.py`. It returns results as **NDJSON** (newline-delimited JSON) — a streaming format where each line is a separate JSON object. This lets the mobile app display the first card result while the backend is still processing the remaining cards.

**What the endpoint receives:**

- Either `image` (base64 full image) + `boxes` (bounding box coordinates) for multi-scan
- Or just `image` with no boxes for live scan (backend auto-detects the card with YOLO)

**What happens inside:**

1. For each bounding box crop (or the auto-detected crop in live scan):
   - Image search and OCR search run **concurrently** with `asyncio.gather`
   - Results are yielded in **completion order** — whichever crop finishes first streams back first
2. The client sees progressive results rather than waiting for all cards

**Similarity thresholds:**

- `_SIM_FLOOR = 0.50` — discard anything below this, not confident enough
- `_SIM_THRESHOLD = 0.65` — above this is a confident image-only match
- `_IMAGE_MIN_SIM_WITH_OCR = 0.83` — when both signals are combined, image alone needs a high score to override OCR

---

## Card Detection — Two YOLO Models

The app detects where cards are in the image before recognizing them. There are two YOLO models:

### On-device TFLite YOLO (mobile)

`mobile/assets/models/card_detector.tflite` (5.1MB, float16) runs **on the phone** without a network call.

- Trained on YOLO11n (Ultralytics), fine-tuned on 2,823 real + synthetic card images
- Input: 640×640 JPEG → decoded to RGB float32 → fed to TFLite
- Output: `[1, 5, 8400]` detection grid → filtered by confidence (0.25) → NMS → bounding boxes
- Platform delegates: **NNAPI on Android** (routes to Hexagon DSP on Snapdragon chips = 2–4× faster), **Core ML on iOS**, CPU fallback
- Library: `react-native-fast-tflite` v2 (v3 silently rejects the onnx2tf op set — cannot upgrade)
- Export chain: PyTorch → ONNX → TensorFlow SavedModel (via `onnx2tf`) → float16 TFLite

The on-device YOLO runs sequentially with OCR — they cannot run in parallel because of a native bridge resource conflict on Android.

### Backend YOLO (server)

`backend/models/card_detector.pt` — the full PyTorch model running on the server (GPU/CPU). Used as a fallback if on-device detection fails, and as the primary detector in live scan mode (live scan sends the full image to the backend and lets it handle detection + recognition in a single roundtrip).

Backend YOLO v2 stats: mAP50=0.993, mAP50-95=0.964.

---

## Multi-Card Scan Pipeline (`useMultiCardScan.ts`)

This is the most complex part of the mobile app. When you tap the shutter in multi-scan mode:

1. **Resize** — The captured photo is resized to 2400px wide (JPEG 0.95). Full resolution takes too long to base64-encode; 2400px is the sweet spot.
2. **OCR the full image** — ML Kit runs a single Japanese-language OCR pass on the entire 2400px image. This produces a list of text blocks, each with coordinates. **This is the key optimization** — instead of running OCR on each crop individually (which would be 12+ separate ML Kit calls for 12 cards), it runs once and the backend spatially filters which blocks belong to each crop. This saves ~3 seconds on a 12-card scan.
3. **On-device YOLO** — Detects card bounding boxes. Falls back to backend `/detect` endpoint if the TFLite model fails, then falls back to OCR-based clustering if that also fails.
4. **Card number extraction** — A second OCR pass (Latin script, smaller crop of the bottom 8% of each card) runs in parallel to get card numbers like "047/165".
5. **Send to backend** — The full JPEG + all bounding boxes + OCR text per crop is sent to `POST /api/v1/scan`. The backend crops each card server-side with PIL (~5ms per crop, much faster than re-encoding in JS) and runs CLIP + DB search for each.
6. **Stream results** — Results arrive as NDJSON and display progressively in `multi-results.tsx`.

Benchmark: first card result in **3.12 seconds** on a Samsung S22+ scanning 12 cards.

---

## Live Scan Pipeline (`useLiveScan.ts`)

Live scan is a continuous loop optimized for single-card recognition:

1. `takeSnapshot({ quality: 80 })` — grabs a frame from the camera preview (not a full photo capture — no shutter lag)
2. Resize to 640px, encode to base64
3. `POST /api/v1/scan` with just the image (no boxes) — backend YOLO auto-finds the largest card, crops it, runs CLIP, returns result
4. **Consecutive-frame confirmation gate** (`pendingMatchRef`) — the top match must be the same card on **two consecutive scans** before it's added to the session. This prevents phantom matches during the physical transition of swapping one card for the next.
5. **Cooldown dedup** (`seenCardTimesRef`) — the same card ID cannot be added again within 30 seconds.
6. Background price fetch — `api.streamPrices()` fetches price without blocking the scan loop
7. Loop repeats immediately after the previous scan completes (~700–900ms cycle)

---

## Prices — PriceCharting Scraper

The app has no price database. Every price is **scraped live** from PriceCharting.com (`backend/app/scrapers/pricecharting.py`).

**URL construction:**

- EN: `https://www.pricecharting.com/game/pokemon-{set-slug}/{card-name}-{number}`
- JP: `https://www.pricecharting.com/game/japanese-{set-slug}/{card-name}-{number}`

The scraper uses `httpx` (async HTTP client) with a 0.5-second rate limit between requests. It parses:

- Loose/CIB/graded price cells (handles "best offer accepted" vs. listed price)
- Price history chart data embedded as JavaScript: `VGPC.chart_data = {...}` — extracted with regex then parsed as JSON
- Recent sales from multiple marketplace tables (eBay, TCGPlayer, Mercari, Yahoo Japan)

Results are **cached in Redis for 24 hours** to avoid re-scraping the same card repeatedly. Cache key is based on the card ID + variant.

**Streaming batch prices** (`POST /api/v1/cards/prices/stream`): when pricing a batch of cards, results stream back as they complete — cache hits appear instantly, scrape misses trickle in over several seconds. `asyncio.as_completed` is used so faster results aren't blocked by slower ones.

---

## State Management (Mobile)

The app uses **Zustand** for state management (v4 — v5 has breaking API changes, pinned).

Key stores:

- `useScanStore` — current game, scan type, multi-scan results and loading state
- `useSavedCardsStore` — saved cards, persisted to `AsyncStorage` under key `tcg:saved-cards`
- `useCollectionsStore` — named card lists (like Instagram saved collections), persisted to `AsyncStorage`
- `useCurrencyStore` — USD/JPY toggle; exchange rate from frankfurter.dev API, cached 24h

---

## Streaming on the Frontend (`mobile/services/api.ts`)

React Native's `fetch()` API doesn't support streaming on iOS. Instead, the app uses **manual XHR with `onprogress`**:

```js
xhr.onprogress = () => {
  // parse newly arrived text since last callback
  // split on newlines → yield complete JSON lines
}
```

Each complete line is parsed as JSON and passed to a callback, so the UI updates progressively as each card result arrives. An `AbortSignal` is wired through to cancel in-flight requests when the user navigates away.

---

## Tab Navigation and Camera Session Management

The app has three tabs (Multi Scan | Live Scan | Search) managed by **Expo Router** with a tab layout.

**The problem:** Expo Router keeps all tab screens mounted simultaneously (like a web SPA with hidden routes). Both camera screens were always active, even when the user was on a different tab. Two camera sessions fighting over the same physical camera hardware caused the `session/invalid-output-configuration` error.

**The fix:** Each camera screen now tracks whether its tab is focused using `useFocusEffect` from Expo Router. The `isActive` prop on the Vision Camera component is set to `isFocused` (true only when the tab is on screen). When the user switches tabs, the old camera session tears down and the new one initializes — they never overlap.

Additionally, the live scan camera had `photo={true}` set — this prop tells Vision Camera to add an `ImageCapture` output stream to the Android camera session (needed for `takePhoto()`). But live scan only uses `takeSnapshot()`, which reads from the **preview stream** and doesn't need `ImageCapture`. Having both streams added was causing the session configuration to exceed what some Android camera HALs support. Removing `photo={true}` from live scan fixed this.

---

## Key Technical Decisions and Why

| Decision                                                    | Why                                                                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| NDJSON streaming from backend                               | Progressive UI — user sees first card result in ~3s, not 15s                                          |
| Single OCR pass on full image, spatial filter per crop      | Avoids 12+ ML Kit calls; saves ~3s on a 12-card scan                                                   |
| On-device YOLO + backend YOLO fallback                      | On-device is fast (~150ms) and works offline; backend catches failures                                 |
| Consecutive-frame confirmation in live scan                 | Prevents phantom matches when physically swapping cards                                                |
| Redis price cache (24h TTL)                                 | PriceCharting rate-limits; same card scanned twice would 2× scrape time                               |
| pgvector IVFFlat (approximate) over exact search            | 47k vectors × exact cosine = slow; IVFFlat with probes=20 gives 99%+ recall at 10× speed             |
| Fine-tuned CLIP over stock CLIP                             | Stock CLIP struggles with card-specific visual similarity; fine-tuning on card pairs improves accuracy |
| `react-native-fast-tflite` v2 locked                      | v3 silently rejects the onnx2tf op set — model loads but produces garbage output                      |
| Vision Camera v4 locked                                     | v5 dropped the Expo config plugin — can't use v5 with Expo SDK                                        |
| Zustand v4 locked                                           | v5 has breaking store API changes; upgrade requires codebase-wide rewrites                             |
| XHR instead of fetch for streaming                          | iOS `fetch()` doesn't expose the response body stream progressively                                  |
| `takeSnapshot()` for live scan, `takePhoto()` for multi | Snapshot reads preview (no shutter delay, faster); photo is higher quality for batch                   |

---

## Data Flow Summary — End to End

```
User points camera at cards
        ↓
[Mobile] Camera preview frame
        ↓
On-device YOLO detects card bounding boxes (TFLite, ~150ms)
        ↓
ML Kit OCR reads full image text (single pass, ~300ms)
        ↓
POST /api/v1/scan  { full JPEG + boxes + OCR text per crop }
        ↓
[Backend] PIL crops each card from JPEG (~5ms each)
        ↓
        ├── CLIP embeds each crop → pgvector nearest-neighbor search
        └── OCR text → extract name + number → PostgreSQL ilike search
        ↓
RRF merges image + OCR rankings
        ↓
Stream results back as NDJSON (fastest crop first)
        ↓
[Mobile] XHR onprogress → parse JSON lines → update UI progressively
        ↓
User confirms cards → POST /api/v1/cards/prices/stream
        ↓
[Backend] Check Redis cache → if miss, scrape PriceCharting.com
        ↓
Stream prices back as NDJSON (cache hits first)
        ↓
[Mobile] Display prices with trend charts
```
