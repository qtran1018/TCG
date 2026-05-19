# TCG Card Scanner

A mobile app for scanning Pokémon TCG cards and retrieving live pricing data. Point your camera at one or more cards — the app identifies them using on-device OCR and a fine-tuned visual AI model, then pulls market prices, recent sales, and price trend graphs from PriceCharting.

---

## Features

- **Multi-card scanning** — capture a photo with multiple cards visible; each is detected, cropped, identified, and priced independently
- **Three recognition modes** — OCR, Image AI (CLIP embeddings), or Combined (both in parallel with Reciprocal Rank Fusion)
- **Live pricing** — ungraded and PSA-graded (7–10) prices, recent eBay/TCGPlayer sales with direct listing links, and 90-day trend graphs
- **Japanese card support** — katakana OCR with kana→English name translation; Japanese card art sourced from TCGCollector.com (27,255 cards, 1996–present)
- **PSA cert lookup** — enter a cert number to retrieve grade and match to a card
- **Batch price retrieval** — select multiple cards from scan results and fetch all prices in one tap
- **Progressive results** — cards appear on screen as each is identified rather than waiting for the full batch

---

## Tech Stack

### Mobile
| Layer | Technology |
|---|---|
| Framework | Expo / React Native (TypeScript) |
| OCR | ML Kit Text Recognition v2 (on-device, EN + JA) |
| Camera | Expo Camera |
| State | Zustand |
| Charts | react-native-chart-kit |

### Backend
| Layer | Technology |
|---|---|
| API | FastAPI (Python) |
| Database | PostgreSQL + pgvector (vector similarity search) |
| Cache | Redis (prices 24 h TTL, search 1 h TTL) |
| Card metadata | pokemontcg.io API |
| Pricing data | PriceCharting scraper (BeautifulSoup) |
| Container | Docker Compose |

### ML / AI
| Model | Role |
|---|---|
| CLIP ViT-B/32 (fine-tuned) | 512-dim visual card embeddings for image-based identification |
| YOLO11n (fine-tuned) | Card region detection — locates and crops individual cards from a photo |
| pgvector IVFFlat | Nearest-neighbor search over 20,187 card embeddings |
| pg_trgm | Fuzzy name matching for OCR misreads (e.g. "Lotacl" → Lotad) |

---

## Recognition Pipeline

```
Photo
  └── YOLO11n (backend)          detect card bounding boxes
        └── per-card crop
              ├── ML Kit OCR     extract name + card number
              └── CLIP embed     512-dim visual vector → pgvector ANN search
                    └── RRF merge (OCR weight 2×, image weight 1×)
                          └── ranked candidates → streamed to UI (NDJSON)
```

Results are streamed one card at a time via a single `POST /api/v1/scan` endpoint, so the UI populates progressively as each crop resolves.

---

## Models

### YOLO11n — Card Detection

Fine-tuned YOLO11n (nano) for single-class card region detection.

**Dataset** — 1,688 images assembled from three sources:

| Source | Images | Format |
|---|---|---|
| Own photos (Roboflow, auto-labeled) | 221 | COCO → YOLO |
| TCG Detector (Roboflow Universe, CC BY 4.0) | 576 | YOLO11 polygon |
| Aaron's Raw Photos (Roboflow Universe, CC BY 4.0) | 891 | YOLO11 OBB |
| **Total** | **1,688** | YOLO bbox, single class |

**Training** — 50 epochs, `imgsz=640`, batch 16, CPU only (AMD Ryzen 5 5600X), 3.68 hours

**Results:**

| Metric | Score |
|---|---|
| mAP50 | **0.992** |
| mAP50-95 | **0.904** |
| Precision | 0.977 |
| Recall | 0.985 |
| Inference speed | ~34 ms / image (CPU) |

Model size: 5.5 MB (`backend/models/card_detector.pt`)

---

### CLIP ViT-B/32 — Visual Card Identification

Fine-tuned the CLIP visual encoder on synthetic (photo, card art) pairs to close the domain gap between official card art and phone photos of physical cards.

**Approach** — contrastive fine-tuning with InfoNCE loss. Each training pair is:
- **Anchor**: official card art, art-region cropped (`y = 12%–52%`)
- **Positive**: same card, augmented to simulate a phone photo (random background texture → perspective warp → color jitter → Gaussian blur → JPEG compression → art-region crop)

5 background textures (tablecloth photos), 20,741 card images × 4 augmented pairs = **82,964 pairs per epoch**.

Only the visual encoder was fine-tuned (87.8 M params); the text encoder was frozen.

**Training config:**

| Parameter | Value |
|---|---|
| Base model | `openai/clip-vit-base-patch32` |
| Loss | InfoNCE contrastive |
| Temperature | 0.07 |
| Optimizer | AdamW, lr = 1e-5 |
| LR schedule | Cosine decay |
| Epochs | 10 |
| Hardware | NVIDIA RTX 3080 |
| Duration | ~13 hours total |

**Epoch log:**

| Epoch | Loss | LR | Duration |
|---|---|---|---|
| 1 | 0.0255 | 9.76e-06 | 78 min |
| 2 | 0.0098 | 9.05e-06 | 77 min |
| 3 | 0.0099 | 7.96e-06 | 78 min |
| 4 | 0.0095 | 6.58e-06 | 78 min |
| 5 | 0.0088 | 5.05e-06 | 76 min |
| 6 | 0.0080 | 3.52e-06 | 77 min |
| **7 ★ best** | **0.0077** | 2.14e-06 | 77 min |
| 8 | 0.0081 | 1.05e-06 | 77 min |
| 9 | 0.0083 | 3.42e-07 | 79 min |
| 10 | 0.0081 | 1.00e-07 | 82 min |

Best weights (epoch 7) saved to `backend/models/clip_finetuned.pt`. The backend loads fine-tuned weights automatically at startup if the file is present.

**Embedding coverage:** 20,187 of 20,237 English Pokémon cards embedded (99.8%). 50 cards are unembeddable due to CDN 404s (McDonald's Collection promos).

---

## Project Structure

```
TCG/
├── backend/                    FastAPI server
│   ├── app/
│   │   ├── api/v1/             Endpoints: /scan, /detect, /cards, /search
│   │   ├── services/           card_embedder, card_detector, ja_image_lookup
│   │   ├── scrapers/           pricecharting.py
│   │   └── data/               pokemon names, kana→EN mapping, set totals,
│   │                           tcgcollector_ja.json (27,255 JP cards)
│   └── models/                 card_detector.pt, clip_finetuned.pt
├── mobile/                     Expo / React Native app
│   ├── app/                    Expo Router screens
│   ├── hooks/                  useMultiCardScan, useOCR, useCardSearch
│   ├── services/api.ts         HTTP client (XHR streaming for /scan)
│   └── utils/                  detectCards, cardConfidence, yoloDetector
├── scripts/                    Offline pipelines
│   ├── build_embeddings.py     Embed all cards with CLIP → pgvector
│   ├── fine_tune_clip.py       CLIP fine-tuning script
│   ├── scrape_tcgcollector.py  JP card image scraper (Playwright)
│   ├── coco_to_yolo.py         Dataset format conversion
│   └── merge_yolo_datasets.py  Merge multi-source YOLO datasets
├── assets/backgrounds/         Background textures for CLIP augmentation
└── docker-compose.yml
```

---

## Data Sources

| Data | Source |
|---|---|
| Card metadata + EN art | pokemontcg.io API (cached in Postgres) |
| JP card art | TCGCollector.com (27,255 cards scraped with Playwright) |
| Prices + sales | PriceCharting scraper |
| Pokémon names (kana) | Bulbapedia, 1,028 entries (all gens through Gen X) |
| Set printed totals | pokemontcg.io `/v2/sets` (172 sets, used for set disambiguation) |

---

## Licenses

| Component | License |
|---|---|
| CLIP (open-clip-torch) | MIT |
| YOLO11n (ultralytics) | AGPL-3.0 |
| TCG Detector dataset | CC BY 4.0 |
| Aaron's Raw Photos dataset | CC BY 4.0 |
