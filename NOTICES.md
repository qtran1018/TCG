# Third-Party Notices

This project incorporates work from third-party datasets, models, and data
sources. Each is used under its own license; this file lists the attributions
required by those licenses.

---

## Training Datasets

The YOLO11n card-detection model (`backend/models/card_detector.pt`) was
fine-tuned on a combined dataset of own photos plus the following community
contributions:

### TCG Detector

- **Source**: Roboflow Universe
- **License**: Creative Commons Attribution 4.0 International (CC BY 4.0)
- **License text**: https://creativecommons.org/licenses/by/4.0/
- **URL**: https://universe.roboflow.com/tcg-detector/pokemon-card-detection-7aaz7-mxbhx

### Aaron's Raw Photos

- **Source**: Roboflow Universe
- **License**: Creative Commons Attribution 4.0 International (CC BY 4.0)
- **License text**: https://creativecommons.org/licenses/by/4.0/
- **URL**: https://universe.roboflow.com/aaron-qwuzu/pokemon-cards-63wlp/dataset/5

Both datasets were converted from their original formats (COCO / YOLO polygon /
YOLO OBB) to single-class YOLO bounding-box format, then merged with own photos.
No modifications were made to the underlying image content.

---

## Models

### YOLO11n (Ultralytics)

- **Source**: https://github.com/ultralytics/ultralytics
- **License**: GNU Affero General Public License v3.0 (AGPL-3.0)
- **License text**: https://www.gnu.org/licenses/agpl-3.0.html
- **Notes**: Used via the `ultralytics` Python package (v8.4.51). The
  fine-tuned weights distributed with this project (`card_detector.pt`)
  are derivative of YOLO11n and therefore subject to AGPL-3.0.

### CLIP ViT-B/32 (OpenAI, via open-clip-torch)

- **Source**: https://github.com/mlfoundations/open_clip
- **License**: MIT
- **License text**: https://github.com/mlfoundations/open_clip/blob/main/LICENSE
- **Notes**: The visual encoder was fine-tuned on a synthetic
  (clean-art, simulated-photo) pair dataset; fine-tuned weights
  (`clip_finetuned.pt`) remain under MIT.

---

## Data Sources

### pokemontcg.io

- Card metadata and official artwork for English cards are retrieved via the
  pokemontcg.io API and cached locally.
- Used under the pokemontcg.io Terms of Service.
- API documentation: https://pokemontcg.io/

### PriceCharting.com

- Trading-card prices, sales history, and trend graphs are scraped from
  PriceCharting product pages on demand and cached for 24 hours.
- Used for personal/research purposes. All price data remains property of
  PriceCharting.

### TCGCollector.com

- Japanese card metadata, set lists, card numbers, and artwork are scraped
  from TCGCollector and stored as `language='ja'` rows.
- Used for personal/research purposes. All card metadata remains property of
  TCGCollector and the original card publishers.

---

## Open-Source Dependencies

The backend (`backend/requirements.txt`) and mobile app (`mobile/package.json`)
depend on a large number of open-source packages, each retaining its own
license. Notable dependencies and their licenses:

| Package                               | License      |
| ------------------------------------- | ------------ |
| FastAPI                               | MIT          |
| SQLAlchemy                            | MIT          |
| asyncpg                               | Apache-2.0   |
| pgvector                              | PostgreSQL   |
| Pydantic                              | MIT          |
| Playwright                            | Apache-2.0   |
| BeautifulSoup                         | MIT          |
| open-clip-torch                       | MIT          |
| PyTorch                               | BSD-3-Clause |
| Pillow                                | MIT-CMU      |
| imagehash                             | BSD-2-Clause |
| OpenCV (cv2)                          | Apache-2.0   |
| ultralytics                           | AGPL-3.0     |
| React Native                          | MIT          |
| Expo                                  | MIT          |
| Zustand                               | MIT          |
| axios                                 | MIT          |
| react-native-chart-kit                | MIT          |
| @react-native-ml-kit/text-recognition | MIT          |
| react-native-fast-tflite              | MIT          |

Full dependency trees are available via:

- Backend: `pip list` (inside the `tcg_backend` container)
- Mobile: `npm ls --all` (inside `mobile/`)

---

## Trademarks

Pokémon, Pokémon character names, and all related properties are trademarks of
Nintendo, Game Freak, and Creatures Inc. One Piece and related properties are
trademarks of Shueisha and Bandai. This project is an independent personal
project and is not affiliated with, endorsed by, or sponsored by any of the
above rights holders.
