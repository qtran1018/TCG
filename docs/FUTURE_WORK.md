# Future Work — Backlog

Detailed specs for planned-but-not-started features, moved out of `CLAUDE.md` to keep always-on context lean. Active/near-term priorities (on-device CLIP, demand-weighted price worker) live in `CLAUDE.md` under Open Tasks.

---

## Collection UX improvements

Several quality-of-life features for the saved cards / collections flow, all building on the existing `useSavedCardsStore` + `useCollectionsStore` Zustand layer.

### Batch save from multi-scan results

Currently multi-scan results (`multi-results.tsx`) only allow saving one card at a time via the bookmark icon, which opens `SaveToCollectionSheet`. Desired: a **"Save Selected"** action that batch-saves all checked cards in one tap, mirroring the existing "Get Prices" batch flow.

**Implementation sketch:**
- Add a "Save Selected" button to the `batchRow` header alongside "Get Prices", enabled when `checkedIndices.size > 0`
- On tap: open a variant of `SaveToCollectionSheet` that accepts `cards: CardOut[]` instead of a single `cardId`; or iterate and call `saveCard` + `addCard` directly for each selected card, then show a confirmation toast
- The sheet's `useEffect` (which calls `ensureDefault(game)`) only needs to fire once per game, not once per card — batch the default-collection-creation step
- Edge case: mixed EN/JP or mixed game cards in the same selection → iterate per card, `ensureDefault` is idempotent

### List reordering

Allow users to drag-and-drop to reorder their saved lists on `saved.tsx` (the collection index screen).

**Implementation sketch:**
- Add `reorderCollections(newOrder: string[])` action to `collectionsStore` — replace the `collections` array with the reordered version (default list always stays first)
- Use `react-native-gesture-handler`'s `LongPressGestureHandler` + `react-native-reanimated` `useAnimatedScrollHandler` for drag-to-reorder, or swap to `react-native-draggable-flatlist` (a thin wrapper around those two, already compatible with Expo SDK 54 + RN 0.81)
- Active drag: lift the row (scale up, drop shadow), animate others out of the way
- Drop: commit via `reorderCollections` call

### Card sorting within a list

On the collection detail screen (`collection/[id].tsx`), add a sort control to the header for sorting cards within the current list.

**Sort options to support:**
- Date saved (newest first — current default, no sort needed)
- Name A→Z
- Set name A→Z
- Card number (numeric sort on the `card_number` string)

**Implementation sketch:**
- Add a sort dropdown/picker to `headerRight` in `collection/[id].tsx`
- Sort is local UI state (not persisted) — `useMemo` derives the sorted card list from the sort key + `cards` array
- Card number sort: strip non-digit prefix (`"047/165"` → `47`), sort numerically; fall back to string sort for non-standard formats

### List total value (per-list and overall)

Show a total estimated value for each saved list and an overall total across all default lists — similar to the running total shown in live scan.

**Implementation sketch:**
- `GET /api/v1/cards/prices/stream` already supports batch pricing; reuse the `api.streamPrices` call with all card IDs in the list
- Add a "Get Value" button to the collection detail header that triggers a streaming price fetch for all cards in that list
- Display a running total as prices arrive (same pattern as `batch-prices.tsx`), then show a final total in the header
- For the default list (`isDefault: true`), the `saved.tsx` index screen could show a cached total with a staleness indicator (price cache is 24h TTL on the backend; the total is only as fresh as the last price fetch)
- Overall total: sum of the two default lists (Pokémon + One Piece) — shown as a dashboard value on `saved.tsx`
- Per-list totals are not persisted — re-fetched on demand to avoid stale prices

### Per-game separation of history and lists

Currently history (`/history` route) and default saved lists mix all games. With One Piece expansion, separate per-game views are needed.

**Implementation sketch:**
- History: `GET /api/v1/history?game=pokemon` — the `game` filter is already accepted by the backend; add a game toggle pill to the history screen (same EN/JP pill pattern used in lookup and live scan)
- Saved lists: `saved.tsx` already creates per-game default collections (`ensureDefault(game)` in `collectionsStore`); add a game tab or segmented control at the top of `saved.tsx` to filter which game's collections are shown
- `collectionsStore.collections` already has `game` on each collection; filter by `game === activeGame` in the `saved.tsx` render — no store changes needed
- Custom lists (non-default) could be game-tagged at creation time, or left game-agnostic (user's choice — they can put any card in any list)

---

## Image AI improvements

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

## PSA graded card recognition

- Target: Japanese card shops that cover cert numbers with price stickers
- Approach: read grade from PSA label + card name → PSA population report to narrow cert candidates

---

## One Piece (multi-TCG expansion)

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

## Portfolio / Free Deployment (CPU-only mode)

For demo/portfolio purposes, CLIP and YOLO inference can run on CPU — no GPU required. Latency increases from ~3s to ~5–8s, acceptable for low traffic.

**Code change required (`backend/app/services/card_embedder.py`):**
- Set `device = "cpu"` instead of auto-detecting CUDA
- Remove `fp16` cast — fine-tuned weights load fine on CPU

**Free stack:**

| Component | Host | Notes |
|---|---|---|
| FastAPI backend (CPU CLIP + YOLO) | Railway or Render free tier | ~512MB RAM limit; watch model load size |
| PostgreSQL + pgvector | Neon (serverless Postgres) | Free tier: 0.5GB storage |
| Redis (price cache) | Upstash (serverless Redis) | Free tier: 10k commands/day |
| Mobile app | Expo Go / TestFlight | No change needed |

**Caveats:**
- Render free tier spins down after 15min inactivity — first request cold-starts (~30s)
- Railway free tier has a monthly usage cap (~$5 credit/month)
- Neon free tier may need pgvector extension enabled manually
- CLIP model (`clip_finetuned.pt`) + YOLO (`card_detector.pt`) must be bundled or fetched at startup; check RAM limits
