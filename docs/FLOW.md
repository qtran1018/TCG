# Scan-to-Price Flow

End-to-end order of events from button press to price display. Paths diverge at language detection and converge at RRF merge (scan) and URL construction (price).

---

## Part 1 — Scan Phase (Mobile)

**File:** `mobile/hooks/useMultiCardScan.ts`

### Step 1 — Camera Capture
- JPEG quality 0.95, resized to 2400 px wide, `skipProcessing: true`

### Step 2 — Full-Image OCR
- ML Kit with `JAPANESE` script — one pass returns both Latin and kana characters
- Result reused for all subsequent spatial filters; no per-crop OCR calls

### Step 3 — Card Detection
```
On-device YOLO  (TFLite float16 · NNAPI on Android · CoreML on iOS)
  ├─ boxes returned ──→ use directly as crop regions
  └─ no boxes / error ──→ fallback: POST /detect → backend YOLO11n
```

### Step 4 — Per-Crop Preparation
For each bounding box:

```
┌─ Name region filter ─────────────────────────────────────────────────────────┐
│  Spatially filter full-image OCR blocks to top 18% of crop, x 5–95% width   │
│                                                                               │
│  LANGUAGE DETECTION from name region text                                    │
│  KANA_RE = /[゠-ヿぁ-ゖ]{2,}/   (2+ consecutive kana)                       │
│                                                                               │
│      kana found ──→  cropLang = "ja"                                         │
│      no kana    ──→  cropLang = "en"                                         │
└───────────────────────────────────────────────────────────────────────────────┘

┌─ Card number filter ──────────────────────────────────────────────────────────┐
│  Bottom 8% of crop                                                            │
│  Left corner x 0–35%  OR  right corner x 65–100%                             │
│  Prefers whichever corner matches \d+/\d+ pattern                            │
└───────────────────────────────────────────────────────────────────────────────┘
```

---

## Part 2 — Backend Search (POST /scan)

**Files:** `backend/app/api/v1/scan.py`, `backend/app/services/card_matcher.py`

**Payload:** full JPEG image + bounding boxes + OCR hints `[{ rawText, language, game }]` per crop

### Step 5 — Server-Side Crop
PIL crops each box from the full image (~5 ms/box). Eliminates N JPEG re-encodes on the phone.

### Step 6 — Batch CLIP Embed
All crops embedded in a single forward pass (fp16 on CUDA). Redis image-search cache checked per crop before embedding (`SHA256(crop):language` key · 1 h TTL).

### Step 7 — Per-Crop Search (all crops run in parallel via `asyncio.gather`)

```
cropLang = "en"                          cropLang = "ja"
─────────────────────────────────────    ─────────────────────────────────────
OCR SEARCH                               OCR SEARCH
  _find_pokemon_name                       _find_kana_name
    · HP line as anchor                      · kana substring match
    · non-name prefix strip                  · kana → EN via kana_to_en.json
    · _contains_pokemon_name gate
                                           _find_jp_trainer_name  (fallback)
  _find_trainer_name  (fallback)             · グッズ/サポート/スタジアム anchor
    · standalone type keyword                · 1–2 lines above → name
    · 1–2 lines above → name                 · strip full-width （） parens
    · strip parenthetical subtitles

  _search_db                               _search_db  (EN name from kana→EN)
    · name + card number, ilike            OR _search_db_ja_trainer
    · pg_trgm fuzzy fallback                 · name_ja ilike search
      (similarity > 0.35)
    · set_printed_totals.json              [no result]
      → set total boost                    └──→ retry with language = "en"
    · pokemontcg.io API                          (EN card misdetected as JP)
      (if probable_name, no DB hit)

─────────────────────────────────────    ─────────────────────────────────────
IMAGE SEARCH  (if scan mode ≠ ocr)       IMAGE SEARCH  (if scan mode ≠ ocr)
  pgvector ANN                             pgvector ANN
  · index: ivfflat_en (partial)           · index: ivfflat_ja (partial)
  · probes = 20 · LIMIT 10               · probes = 20 · LIMIT 10
  · phash Hamming ≤ 20 → strong match    · phash Hamming ≤ 20 → strong match

  Similarity thresholds:                  Similarity thresholds:
  · ≥ 0.65 → confident  (Image AI ✓)    · ≥ 0.65 → confident  (Image AI ✓)
  · 0.50–0.65 → uncertain  (Image AI ?)  · 0.50–0.65 → uncertain
  · < 0.50 → discard                     · < 0.50 → discard
                                           └──→ retry with language = "en"
                                                (requires sim_en > sim_ja + 0.05)
─────────────────────────────────────    ─────────────────────────────────────
                         │                              │
                         └──────────────┬───────────────┘
                                        ▼
                         ┌──────────────────────────────┐
                         │      RRF MERGE (combined)    │
                         │  score = weight / (rank + 60)│
                         │  OCR   weight = 2            │
                         │  Image weight = 1            │
                         │                              │
                         │  Image gate: image excluded  │
                         │  if OCR hit AND sim < 0.83   │
                         │                              │
                         │  Card # promotion:           │
                         │  OCR-matched number → front  │
                         └──────────────────────────────┘
                                        │
                              NDJSON line emitted as
                              each crop completes,
                              buffered to preserve
                              top-to-bottom order
```

---

## Part 3 — Results Display (Mobile)

**File:** `mobile/app/multi-results.tsx`

Card rows populate progressively as NDJSON lines arrive (XHR `onprogress`):

| Field | Source |
|---|---|
| Card image | `card.image_url` from DB |
| Name / Set / Number | DB card record |
| Language flag 🇺🇸 / 🇯🇵 | `card.language` |
| Source badge | OCR / Image AI / Both ✓ |
| Swap button | alternate RRF candidates |

---

## Part 4 — Price Phase (GET /cards/{id})

**Files:** `backend/app/api/v1/cards.py`, `backend/app/services/card_matcher.py`, `backend/app/scrapers/pricecharting.py`

### Step 9 — Build PriceCharting URL

```
card.language = "en"                     card.language = "ja"
─────────────────────────────────────    ─────────────────────────────────────
language_override = "en"                 language_override = "ja"
                                         Always rebuild as JP URL.
Use stored pricecharting_url             Number source depends on how the card
or build:                                was matched:
  pokemon-{set-slug}/{name-slug}-{num}
                                         ┌─ Matched as JP (card.language = "ja")
                                         │  → number = card.card_number  (DB)
Exception: JP scan hit an EN card        │    DB is authoritative (v11)
via cross-language fallback              │    OCR misreads ignored
  → number = OCR ja_card_number          │
    (EN DB number is wrong               └─ EN card via cross-lang fallback
     for a JP PriceCharting URL)            (card.language = "en")
                                            → number = OCR ja_card_number
                                              EN DB number is wrong for JP URL
─────────────────────────────────────    ─────────────────────────────────────
                         │                              │
                         └──────────────┬───────────────┘
                                        ▼
                         pokemon-{set-slug}/{name-slug}[-variant]-{num}

                         Variant suffix examples:
                           1st Edition  →  charizard-1st-edition-4
                           Shadowless   →  charizard-shadowless-4
                           Poké Ball    →  umbreon-poke-ball-59
                           Master Ball  →  gengar-master-ball-94
```

### Step 10 — Redis Cache Check
- Key: `set_slug + card_slug + variant`
- **HIT** (24 h TTL) → return immediately, skip scrape
- **MISS** → proceed to scrape

### Step 11 — PriceCharting Scrape
`httpx.AsyncClient` · persistent TCP/TLS · brotli decompression · 0.5 s rate limit

```
GET pricecharting_url
  ├─ 302 redirect → no listing (set slug mismatch or card not on PC)
  └─ 200 → parse page
       ├─ #full-prices table
       │    → loose (ungraded) · graded 7 / 8 / 9 / PSA 10
       ├─ VGPC.chart_data embedded JS
       │    → price history series (ungraded + graded, [[timestamp_ms, cents], ...])
       └─ hoverable-rows sortable tables (all tables, eBay + TCGPlayer)
            → recent sales: date · title · price · sale URL
            prefer: ebay. / tcgplayer. / mercari. / yahoo. links
            discard: /console/ links (disambiguation pages, not individual sales)
            guard: if loose = null AND no sale URLs → clear sales (bogus page)
```

### Step 12 — Cache Result
- Price data found → Redis **24 h** TTL
- No data / 302 → Redis **1 h** negative TTL (avoids hammering PC on every tap)

### Step 13 — Display
**File:** `mobile/app/card/[id].tsx`

| UI Element | Detail |
|---|---|
| Card image | `image_url_hi` preferred, `image_url` fallback |
| Variant picker | EN: Normal / 1st Edition / Shadowless / Poké Ball<br>JP: Normal / Poké Ball / Master Ball |
| PriceDisplay | Loose · Graded 7–10 · currency toggle USD / JPY |
| PriceChart | Trend graph · y-axis scales for sub-$1 cards |
| Recent sales | Date · title · price · eBay → / TCGPlayer → links |
| Refresh button | `force_refresh=true` bypasses Redis cache, re-scrapes |
| No-price (variant) | "Variant not found" + Search on PriceCharting → link |

---

## Cross-Language Fallback Summary

| Scan lang | DB card lang | OCR fallback | Image fallback | Number used for PC URL |
|---|---|---|---|---|
| en | en | — | — | `card.card_number` |
| ja | ja | — | EN retry if sim < threshold + 0.05 | `card.card_number` (DB authoritative) |
| ja | en | EN retry if no JP results | EN retry if sim < threshold + 0.05 | OCR `ja_card_number` |
