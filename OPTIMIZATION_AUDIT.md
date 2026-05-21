# Optimization Audit — TCG Card Scanner

Date: 2026-05-19
Scope: full backend (`backend/app/`) and mobile (`mobile/`) trees.

**Status legend:** ✅ = applied · ⚠️ = partially applied · ❌ = deliberately skipped (dependency change) · (no marker) = not yet addressed.

---

## Remaining Work (quick-reference)

### ⚠️ Partially Applied

_(All previously partial items now resolved — see §1.12 and §5.1 below.)_

### ❌ Deliberately Skipped (dependency changes)

| # | Item | Reason deferred | Section |
|---|------|-----------------|---------|
| 1.7 | Replace Playwright with httpx for PriceCharting | Risk of silent Cloudflare block without Playwright's realistic browser headers; needs validation before switching | §1 Performance |
| 7.1 | Playwright bundle size | Blocked on 1.7 — only worth removing once Playwright is no longer needed | §7 Dependency / Bundle |
| 7.2 | react-native-chart-kit replacement (Victory Native / Recharts) | Breaking API change; low priority while chart is functional | §7 Dependency / Bundle |
| 7.3 | Drop axios in favor of `fetch` | Minor churn for no functional gain right now | §7 Dependency / Bundle |
| Tier 4 #27 | Playwright → httpx (prioritized table) | Same as 1.7 above | Priority table |
| Tier 5 #32 | chart-kit replacement (prioritized table) | Same as 7.2 above | Priority table |

### Not Yet Addressed

| # | Item | Description | Section |
|---|------|-------------|---------|
| 2.3 | Move OpenCV detector to separate module | Left as safety-net fallback; keep isolated once YOLO is fully trusted | §2 Correctness |
| §6 stubs | `pop_higher` field on PSA scraper | Scaffold left unimplemented | §6 Unused Code |

---

Each finding lists:
- **File / location** — where to look
- **Current** — what the code does today
- **Issue** — why it's a problem
- **Recommendation** — proposed change
- **Benefit** — expected impact

---

## 1. Performance

### ✅ 1.1 First `/scan` and `/detect` calls pay cold-start latency
- **File**: `backend/app/services/card_embedder.py:18-37`, `backend/app/services/card_detector.py:26-39`
- **Current**: CLIP and YOLO are loaded lazily on the first call. CLIP is ~170MB on disk → load + move to GPU = ~2–5s. YOLO load = ~500ms.
- **Issue**: The first user of the day waits noticeably longer than subsequent users. The mobile XHR timeout is 90s — risky on a cold container.
- **Recommendation**: Preload both models in `app/main.py` `lifespan` so they're warm before the first request.
- **Benefit**: Eliminates a multi-second latency spike on the first scan; fully predictable first-call timing.

### ✅ 1.2 `/scan` does not stream per crop — all phases complete before any result is emitted
- **File**: `backend/app/api/v1/scan.py:262-320`
- **Current**: `generate()` runs phase 1+2 (all image searches) to completion, then phase 3 (all OCR searches) to completion, then loops crops and yields NDJSON.
- **Issue**: The "streaming" endpoint is not actually streaming — all results arrive back-to-back at the end. The mobile UI shows blank progress until the entire batch finishes.
- **Recommendation**: For each crop, kick off `(vector_search, ocr_search)` as a parallel task and `asyncio.as_completed()` over the pairs, yielding NDJSON the moment a crop's pair completes.
- **Benefit**: True progressive UI — fastest cards appear in 1–2s rather than waiting for the slowest. Major perceived-latency improvement.

### ✅ 1.3 Per-crop OCR in mobile pipeline runs sequentially
- **File**: `mobile/hooks/useMultiCardScan.ts:154-175`
- **Current**: `for (const { uri, … } of cropData) { … await TextRecognition.recognize(uri, script); … }` — each crop's OCR awaits before the next starts.
- **Issue**: With 5 crops at ~200–500ms each, that's 1–2.5s of strictly sequential work before the backend call even begins.
- **Recommendation**: `await Promise.all(cropData.map(async ({uri, …}) => { … }))` — gather OCR + base64 reads in parallel.
- **Benefit**: 4–10× speedup on multi-card scans (limited by phone CPU/IO).

### ✅ 1.4 CLIP `encode_image` blocks the FastAPI event loop
- **File**: `backend/app/services/card_embedder.py:78-80`
- **Current**: `_model.encode_image(batch)` runs synchronously inside the async endpoint.
- **Issue**: While CLIP is encoding (~100–500ms on CPU, ~50ms on GPU), the event loop is blocked — no other requests progress.
- **Recommendation**: Wrap the encode step in `await asyncio.to_thread(_encode_sync, batch)` (or `loop.run_in_executor`).
- **Benefit**: Other in-flight requests (e.g. price scrapes, history list) don't stall during inference.

### ✅ 1.5 Image cache stores ranked CardOut list but key collisions cause re-rank
- **File**: `backend/app/services/card_matcher.py:215-217`
- **Current**: `search_cache` stores only `ids` of cards. On cache hit, code does `SELECT * FROM cards WHERE id IN (...)`, which returns in DB row order — **not** the `_dedupe_and_rank` order from the original write.
- **Issue**: Extra DB query and lost ranking order on every cache hit.
- **Recommendation**: Store the ordered serialized `CardOut` array directly. Skip the DB round-trip on hits.
- **Benefit**: One fewer query per cached search; preserves correct ranking; faster cache hits.

### ✅ 1.6 `compute_phash` runs sequentially per crop in `_batch_image_search`
- **File**: `backend/app/api/v1/scan.py:204-213`
- **Current**: Inside `search_one`, `compute_phash(img_bytes)` is called synchronously before pgvector search.
- **Issue**: phash for each crop runs serially in a parallel-search loop, partially defeating the gather.
- **Recommendation**: Pre-compute all phashes in parallel via `await asyncio.gather(*[asyncio.to_thread(compute_phash, b) for _, b in to_embed])` before the search gather.
- **Benefit**: Phash computation overlaps with embedding, freeing the event loop.

### ❌ 1.7 Playwright opens a fresh browser context per scrape (skipped — dependency change)
- **File**: `backend/app/scrapers/base.py:71-82`
- **Current**: Every `fetch_page` call creates a context, opens a page, waits 800–1500ms random delay, then closes the page and context.
- **Issue**: For PriceCharting pages that don't require JS-rendered content, this is ~3× slower than `httpx` and burns ~50–100MB extra RAM per concurrent fetch.
- **Recommendation**: Try `httpx.AsyncClient` with realistic headers for PriceCharting first; fall back to Playwright only on 403/Cloudflare challenge. If PriceCharting fully accepts `httpx`, drop Playwright entirely from PriceCharting path.
- **Benefit**: 1–2s faster per uncached price lookup; significant RAM reduction; smaller backend container possible (Playwright bundles are ~300MB).

### ✅ 1.8 `ScanHistory.scanned_at` is not indexed
- **File**: `backend/app/models/card.py:65`
- **Current**: `scanned_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)`
- **Issue**: `ORDER BY scanned_at DESC LIMIT 50 OFFSET N` will require a sequential scan as the table grows.
- **Recommendation**: Add `index=True` to the column (or explicit `Index("ix_scanhistory_scanned_at", ScanHistory.scanned_at.desc())`).
- **Benefit**: O(log n) history list queries instead of O(n).

### ✅ 1.9 OpenCV `detect_card_rectangles` does base64 decode in the event loop
- **File**: `backend/app/services/card_detector.py:69-76`
- **Current**: `base64.b64decode`, `np.frombuffer`, `cv2.imdecode` all run synchronously in the request handler.
- **Issue**: For a 1600px JPEG, that's 30–80ms of CPU-bound work blocking the loop.
- **Recommendation**: Wrap `_detect_yolo` and `_detect_opencv` calls in `await asyncio.to_thread(...)`.
- **Benefit**: Other requests progress during detection.

### ✅ 1.10 `detectCardRegions` runs 5 threshold passes with O(n²) clustering each
- **File**: `mobile/utils/detectCards.ts:217-240`
- **Current**: Loops 5 different thresholds, each running BFS clustering at O(n²) on the block list, picks the pass with the most card-shaped regions.
- **Issue**: Only runs when YOLO fails — it's a fallback — but when triggered it can be slow on busy images.
- **Recommendation**: Add an early-exit: once any pass produces ≥ 3 card-shaped regions, stop.
- **Benefit**: Faster fallback path (~3× best case). Low priority since YOLO usually succeeds.

### ✅ 1.11 `PriceChart` recomputes max/min on every render
- **File**: `mobile/components/Card/PriceChart.tsx:19-28`
- **Current**: `Math.max(...prices)`, `labels`, `decimalPlaces` recomputed every render.
- **Issue**: Negligible at 24 points but happens on every parent state change.
- **Recommendation**: Wrap in `useMemo([history])`.
- **Benefit**: Minor — pure cleanup.

### ✅ 1.12 `FlatList` items not memoized
- **File**: `mobile/components/Card/CardListItem.tsx`, `mobile/app/multi-results.tsx:160-234`, `mobile/app/batch-prices.tsx:83`
- **Current**: List item components are plain function components.
- **Issue**: `FlatList` re-renders every visible item on any parent state change (e.g. checkbox toggle in `multi-results.tsx` triggers all rows to re-render).
- **Recommendation**: Wrap with `React.memo` and ensure `keyExtractor` + stable prop refs. For functions passed in, use `useCallback`.
- **Benefit**: Smoother selection/scroll on lists with 5–10 cards.

### ✅ 1.13 `batch-prices.tsx` triggers N independent `setState` calls
- **File**: `mobile/app/batch-prices.tsx:29-46`
- **Current**: Each `getCard` resolves and calls `setEntries((prev) => …)` — N completions = N re-renders of the entire FlatList.
- **Issue**: For 10 cards, 10 full list re-renders.
- **Recommendation**: Use `Promise.allSettled` and call `setEntries` once with all results; or batch updates via `useReducer`.
- **Benefit**: Fewer renders, smoother UI when prices arrive in quick succession.

### ✅ 1.14 `_search_db` performs multiple ILIKE queries in sequence
- **File**: `backend/app/services/card_matcher.py:289-322`
- **Current**: Up to 4 sequential queries (name+number → number only → name only → fuzzy fallback).
- **Issue**: Most queries return on the first match, but on misses each adds 5–20ms.
- **Recommendation**: Combine into a single query with prioritized `CASE WHEN … THEN 0 … END` ordering, or rely on the GIN trigram index for `name ILIKE '%…%'` (already created — verify EXPLAIN actually uses it).
- **Benefit**: Faster DB search on OCR misreads; one query instead of up to four.

---

## 2. Architecture and structure

### ✅ 2.1 `CardMatcherService` is instantiated 4 times across endpoints
- **File**: `backend/app/api/v1/cards.py:15`, `scan.py:22`, `psa.py:18`, `search.py:15`
- **Current**: Each module creates its own `CardMatcherService()`, each holding its own `PricechartingScraper`, `PokemonTCGApiScraper` (which opens an `httpx.AsyncClient`), and `OnePieceScraper`.
- **Issue**: Four HTTP clients on startup, four sets of session state. No shared connection pooling between endpoints; awkward shutdown.
- **Recommendation**: Create one `services/__init__.py` module-level singleton (e.g. `matcher = CardMatcherService()`) and import it everywhere. Add `await matcher.close()` to FastAPI `lifespan` shutdown.
- **Benefit**: Cleaner shutdown, reduced memory, shared HTTP connection pooling, simpler test setup.

### ✅ 2.2 Two `compute_phash` implementations with different semantics (image_hasher deleted with Celery; only card_embedder remains)
- **File**: `backend/app/services/image_hasher.py:13`, `backend/app/services/card_embedder.py:45`
- **Current**: `image_hasher.compute_phash` hashes the full image; `card_embedder.compute_phash` hashes only the art-region crop.
- **Issue**: Same function name, different behavior — confusing. `_hamming` in `scan.py:59` also does its own `import imagehash` per call.
- **Recommendation**: Rename to `compute_full_phash` and `compute_art_phash` in one shared module; hoist all `imagehash` imports to module scope.
- **Benefit**: No more ambiguity; faster cold call (no per-call import).

### 2.3 OpenCV detector ~150 lines of dead-on-arrival fallback code
- **File**: `backend/app/services/card_detector.py:100-242`
- **Current**: When `card_detector.pt` is absent, falls back to OpenCV contour + NMS + recursive splitting.
- **Issue**: YOLO is deployed and the `.pt` is checked in — OpenCV branch is unreachable in normal use. The file is 243 lines, ~60% of it for the dead branch.
- **Recommendation**: Move `_detect_opencv`, `_try_split_box`, `_nms`, `_iou`, `_containment`, and OpenCV-specific constants to `card_detector_opencv.py`. Or delete it entirely — the dataset is robust enough that YOLO failure means "no cards present" and falling back to the broken OpenCV approach won't help.
- **Benefit**: Smaller, focused module; less surface area for bugs.

### ✅ 2.4 Single-card scan path is fully dead but still wired
- **Files**: `mobile/hooks/useOCR.ts`, `mobile/hooks/useCardSearch.ts:searchByOCR`, `mobile/app/results.tsx`, `mobile/components/Scanner/ScanOverlay.tsx`, `mobile/utils/detectCards.ts:filterBlocksToCardZone`, `mobile/app/(tabs)/index.tsx:handleCapture`
- **Current**: CLAUDE.md v10 notes single-card mode is disabled; the "Scan Cards" button only calls `handleMultiCapture`. But the entire single-card code path still exists.
- **Issue**: Maintenance burden, confusing reads, dead routes (`/results` is registered in `_layout.tsx` but unreachable).
- **Recommendation**: Delete `useOCR.ts`, `useCardSearch.searchByOCR`, `app/results.tsx`, `filterBlocksToCardZone`, `handleCapture` in `index.tsx`, the `results` Stack.Screen registration in `_layout.tsx`. Keep `ScanOverlay` only if you want to display a frame guide in multi mode (it's currently passed `showOverlay={false}` so it never renders).
- **Benefit**: ~400 fewer lines of mobile code; clearer mental model.

### ✅ 2.5 `POST /search` and `POST /search/batch` are unused
- **File**: `backend/app/api/v1/search.py`
- **Current**: Both endpoints exist and are mounted in `__init__.py`. `api.ts:searchCards` and `api.ts:batchSearch` are still exported.
- **Issue**: Per CLAUDE.md, `/scan` superseded both. `api.batchSearch` was noted as removed but it's still in api.ts. `searchCards` is only called from the dead `handleCapture` path.
- **Recommendation**: Delete both backend endpoints and their mobile wrappers.
- **Benefit**: Smaller API surface; clearer architecture.

### ✅ 2.6 `PriceCache` ORM model is never used
- **File**: `backend/app/models/card.py:36-50`
- **Current**: Table is created by `Base.metadata.create_all`. Defined columns mirror Redis-cached fields.
- **Issue**: Redis is the actual cache. The table exists but nothing reads or writes to it.
- **Recommendation**: Delete the model. Add a Alembic migration to drop the table if anything is already created in real environments.
- **Benefit**: Removes confusion about where prices are cached.

### ✅ 2.7 `POST /cards/history` uses query parameters instead of a request body
- **File**: `backend/app/api/v1/cards.py:53-79`, `mobile/services/api.ts:170-185`
- **Current**: Every field is a FastAPI query parameter; mobile sends `null` body with all fields as URL params.
- **Issue**: URL can hit length limits with long `ocr_text` / `resolved_card_name`. Unusual for POST. Hard to extend.
- **Recommendation**: Define a `ScanHistoryCreate` pydantic model; mobile sends JSON body.
- **Benefit**: Cleaner API; no URL length risk; auto-validation.

### ✅ 2.8 `_VALID_GAMES` and `_VALID_LANGUAGES` duplicated
- **File**: `backend/app/api/v1/scan.py:23-24`, `backend/app/api/v1/search.py:17-18`
- **Current**: Both modules define the same sets.
- **Recommendation**: Move to `app/constants.py` (new file) or `app/schemas/card.py` as `VALID_GAMES`, `VALID_LANGUAGES`.
- **Benefit**: Single source of truth.

### ✅ 2.9 `get_prices` mixes URL building, caching, scraping, and dict transformation
- **File**: `backend/app/services/card_matcher.py:390-449`
- **Current**: 60-line method does URL construction, two caching strategies, scrape call, and response shaping.
- **Recommendation**: Split into `_build_pc_url(card, lang) → str`, `_cache_key(card, scan_type, lang) → str`, `_serialize_prices(prices) → dict`. Main method becomes ~15 lines of orchestration.
- **Benefit**: Testable; easier to add new price providers; clearer responsibilities.

### ✅ 2.10 `saleLinkLabel` duplicated across two files
- **File**: `mobile/components/Card/PriceDisplay.tsx:7-11`, `mobile/app/batch-prices.tsx:93-97`
- **Recommendation**: Move to `mobile/utils/saleLink.ts`.
- **Benefit**: One place to add new marketplaces (Cardmarket, etc.) in the future.

### ✅ 2.11 Unused styles in `index.tsx`
- **File**: `mobile/app/(tabs)/index.tsx:246-255`
- **Current**: `multiScanBtn` and `multiScanBtnText` style definitions exist but no JSX references them.
- **Recommendation**: Delete.

### ✅ 2.12 Routes registered for unused screens
- **File**: `mobile/app/_layout.tsx:23` — registers `name="results"` Stack.Screen
- **Recommendation**: Delete after removing `results.tsx`.

---

## 3. Async and concurrency

### ✅ 3.1 `/scan` phases serialize instead of overlapping
- See **1.2** — phase 1+2 (all image) then phase 3 (all OCR) then yield, instead of per-crop parallel kick-off + yield as completed.

### ✅ 3.2 Per-crop mobile OCR sequential
- See **1.3** — fix with `Promise.all`.

### ✅ 3.3 Mobile `scanStream` cannot be aborted by callers
- **File**: `mobile/services/api.ts:220-275`, `mobile/hooks/useMultiCardScan.ts:183`
- **Current**: `scanStream(crops, hints, mode, onResult, signal?)` accepts an `AbortSignal` but `useMultiCardScan` never passes one.
- **Issue**: If user navigates away mid-scan, the network request continues consuming backend resources. Worse if user starts another scan immediately.
- **Recommendation**: Create an `AbortController` in `useMultiCardScan`, expose `cancel()`, and pass `controller.signal` to `scanStream`. Abort on unmount.
- **Benefit**: No wasted backend CPU; cleaner state when user backs out.

### ✅ 3.4 Error swallowing in `getHistory`
- **File**: `mobile/app/(tabs)/history.tsx:35-37`
- **Current**: `catch { /* non-critical */ }`
- **Issue**: Network or backend errors silently disappear. Hard to diagnose.
- **Recommendation**: `catch (e) { console.warn("[history] load failed", e); }` and surface a small banner.
- **Benefit**: Diagnosability without breaking the UI.

### ✅ 3.5 Per-crop OCR errors crash the whole scan
- **File**: `mobile/hooks/useMultiCardScan.ts:163-172`
- **Current**: A single crop's `TextRecognition.recognize` throwing will bubble out of the `for` loop and abort the whole pipeline.
- **Recommendation**: Wrap each crop in `try/catch`; on failure set `rawText = undefined` so backend still gets image-only signal.
- **Benefit**: Multi-card scan survives a bad crop.

### ✅ 3.6 `_batch_image_search` exception swallows and silently zeros image results
- **File**: `backend/app/api/v1/scan.py:273-277`
- **Current**: `try: image_results = await _batch_image_search(imgs); except Exception: logger.exception(...)` — proceeds with empty `image_results`.
- **Issue**: User sees "OCR only" results without knowing CLIP failed; no error metric.
- **Recommendation**: Add a header or response field like `partial: true, reason: "image_failed"` for telemetry, while still returning OCR-only results.
- **Benefit**: Visibility into degraded mode.

### ✅ 3.7 Save history failure swallowed in `results.tsx`
- **File**: `mobile/app/results.tsx:42-44`
- **Current**: `catch {}` with no logging.
- **Note**: This whole file is dead per 2.4 anyway. Just delete it. (Deleted.)

---

## 4. Data handling

### ✅ 4.1 Search cache loses ranking order on hit
- See **1.5** — store the ordered serialized list, not just `ids`.

### ✅ 4.2 Image search cache stores `query_used` as a regex-parsed string
- **File**: `backend/app/api/v1/scan.py:194-195`
- **Current**: `BatchSearchItem` only has `candidates` and `query_used`; sim score is parsed back out of `query_used` with regex like `image:0.85`.
- **Issue**: Fragile; if `query_used` format changes, sim parsing breaks silently.
- **Recommendation**: Cache a richer structure `{candidates, best_sim, query_used}` directly.
- **Benefit**: Robust to format changes; no regex.

### ✅ 4.3 `getCard` called N times in batch-prices.tsx
- **File**: `mobile/app/batch-prices.tsx:29-46`
- **Current**: 10 selected cards → 10 parallel HTTP requests, each one scraping PriceCharting (or hitting Redis).
- **Issue**: Even when all cached, N round-trips. When uncached, N scrapes throttled by `pricecharting_rate_limit_seconds = 3` — that's potentially 30s for 10 cards.
- **Recommendation**: Add `POST /cards/prices` that accepts `{card_ids: [], language, scan_type}` and returns all prices in one response, with internal parallelism on cache hits + queued/serialized scrapes.
- **Benefit**: Faster batch loads; clear backend control over scrape concurrency.

### ✅ 4.4 `CardOut` includes fields the mobile UI never reads
- **File**: `backend/app/schemas/card.py:19-26`, `mobile/services/api.ts:11-27`
- **Current**: `phash`, `external_id`, `pricecharting_id`, `created_at` always shipped to the client.
- **Issue**: Wasted bandwidth on every search result and every streamed scan card.
- **Recommendation**: Add a `CardOutLite` schema for list views (no phash, no external_id, no created_at) and use it for `/scan` results and search candidates.
- **Benefit**: Smaller payloads; faster mobile parse on large batches.

### ✅ 4.5 History endpoint not paginated on mobile
- **File**: `mobile/app/(tabs)/history.tsx:33`
- **Current**: Hard-coded `getHistory(50, 0)`.
- **Issue**: Once a user has 200+ scans, older ones become inaccessible. No infinite scroll.
- **Recommendation**: Add `onEndReached` with cursor-based pagination.
- **Benefit**: Scales to large history.

### ✅ 4.6 No compression on Redis JSON values
- **File**: `backend/app/services/cache.py:38-41`
- **Current**: `json.dumps(value)` stored as-is.
- **Issue**: Price entries with 10 sales + 24+24 history points serialize to several KB. Times 20k cards = potentially hundreds of MB of Redis.
- **Recommendation**: Optional gzip wrap for values over a threshold, or msgpack. Low priority while volume is small.

---

## 5. Error handling and resilience

### ✅ 5.1 Silent error swallowing
- **Files**: multiple — `pricecharting.py:213` (`except (json.JSONDecodeError, Exception)` — redundant `Exception` catch), `card_embedder.py:53` (`compute_phash` returns None silently), `scan.py:65` (`_hamming` returns 999 on import error), `history.tsx:35`.
- **Recommendation**: Log every swallow at WARNING level minimum. Distinguish "expected miss" (no chart data) from "unexpected failure" (import error → real bug).
- **Benefit**: Operational visibility.

### ✅ 5.2 Missing 404 differentiation in PriceCharting scrape
- **File**: `backend/app/scrapers/pricecharting.py:171-175`
- **Current**: If PriceCharting returns a 404 page (card not catalogued), `_parse_prices` returns an empty `PCPrices`. Indistinguishable from a partial parse failure.
- **Recommendation**: Inspect response status / detect "not found" content; raise `CardNotFoundError`. Cache the negative result with a shorter TTL (1h) so we don't re-scrape repeatedly.
- **Benefit**: Less wasted scraping; clearer error states.

### ✅ 5.3 `scanStream` `onabort` resolves as if completed
- **File**: `mobile/services/api.ts:267`
- **Current**: `xhr.onabort = () => resolve();`
- **Issue**: Caller can't distinguish completed from aborted.
- **Recommendation**: Either reject with `AbortError` or set a flag in the resolve value.

### ✅ 5.4 `imagehash` and `PIL` imports inside per-call functions
- **File**: `backend/app/services/card_embedder.py:48-50`, `scan.py:63`
- **Current**: `import imagehash; from PIL import Image` inside `compute_phash` body.
- **Issue**: First-call slowness; obscures dependency requirements at startup.
- **Recommendation**: Move to module-level imports.

### ✅ 5.5 Backend has no global request timeout on scrape paths
- **Current**: `pricecharting.fetch_page` waits up to 30s for Playwright + tenacity does 3 retries with exp backoff up to 30s → worst case ~150s per scrape.
- **Issue**: Mobile XHR times out at 90s. User sees a timeout for what's actually still working server-side.
- **Recommendation**: Match server-side total budget to mobile timeout (e.g. cap retries to 2, max wait 30s total).

---

## 6. Dead or redundant code

(Many already listed in §2. Consolidated list.)

| Status | Item | File | Recommendation |
|---|---|---|---|
| ✅ | `useOCR.ts` hook | `mobile/hooks/useOCR.ts` | Delete |
| ✅ | `handleCapture` in `index.tsx` | `mobile/app/(tabs)/index.tsx:38-67` | Delete |
| ✅ | `results.tsx` route | `mobile/app/results.tsx` + Stack.Screen reg | Delete |
| ✅ | `useCardSearch.searchByOCR` | `mobile/hooks/useCardSearch.ts:21-42` | Delete (keep `searchByCert`) |
| ✅ | `filterBlocksToCardZone` | `mobile/utils/detectCards.ts:26-54` | Delete |
| ✅ | `ScanOverlay` | `mobile/components/Scanner/ScanOverlay.tsx` | Delete or stop importing |
| ✅ | `api.searchCards`, `api.batchSearch` | `mobile/services/api.ts:127, 187` | Delete |
| ✅ | `POST /search` endpoint | `backend/app/api/v1/search.py:21` | Delete |
| ✅ | `POST /search/batch` endpoint | `backend/app/api/v1/search.py:43` | Delete |
| ✅ | `PriceCache` ORM model | `backend/app/models/card.py:36-50` | Delete + drop table migration |
| ✅ | `_scan_counter` infinite counter | `backend/app/api/v1/detect.py:11` | Replace with `request_id` from FastAPI or remove |
| ✅ | Unused mobile styles `multiScanBtn*` | `mobile/app/(tabs)/index.tsx:246-255` | Delete |
| ✅ | `get_by_number`, `search_by_number` | `backend/app/scrapers/pokemon_tcg_api.py:56, 69` | Deleted — no callers in repo |
|  | `pop_higher` field set but unused | `backend/app/scrapers/psa.py:21` | Remove or expose in `PSACertResult` |
| ✅ | Unused `scanType` import | `mobile/app/multi-results.tsx:25` (`scanType` destructured, never read) | Remove |

### ✅ 6.x Celery worker may be unused
- **File**: `backend/app/tasks/scrape_tasks.py`
- **Current**: `fetch_card_prices_task` and `seed_pokemon_cards_task` defined.
- **Issue**: Search the codebase — neither is `.delay()`-called from active flows. `seed_pokemon_cards_task` only chains itself. Likely a relic from earlier seed scripts (`scripts/build_embeddings.py` replaced it).
- **Recommendation**: Confirm via `git grep .delay\(` — if no callers, remove the Celery worker entirely (frees `docker-compose.yml` worker container and reduces dependency on `celery` package).

---

## 7. Dependency and bundle hygiene

### ❌ 7.1 Playwright is heavy and may be unnecessary for PriceCharting (skipped — see Playwright assessment in commit notes)
- **Issue**: ~300MB browser bundle + ~50–100MB RAM per concurrent fetch.
- **Recommendation**: Test if `httpx` with a realistic User-Agent can fetch PriceCharting pages successfully. If yes, remove Playwright from PriceCharting path. Keep it only for TCGCollector scraping (offline build step, not request path).
- **Benefit**: Smaller backend image; faster cold starts; lower per-request memory.

### ❌ 7.2 `react-native-chart-kit` ships ~30KB+ with SVG runtime (skipped — dependency change)
- **Issue**: One chart in the app. Could use bare `react-native-svg` and draw a simple polyline.
- **Recommendation**: Defer unless app size matters. Low priority.

### ❌ 7.3 `axios` + native XHR both shipped (skipped — dependency change)
- **Current**: Most endpoints use axios; `scanStream` uses raw XHR.
- **Issue**: ~14KB extra for axios when `fetch` could handle everything (RN fetch supports streaming via ReactNativeBlobUtil or with explicit handling).
- **Recommendation**: Low priority — axios is small and the codebase is consistent with it.

### ✅ 7.4 Celery + redis-py both pulled for an unused worker
- See 6.x. If `tasks/scrape_tasks.py` is removed, `celery` can drop from `requirements.txt`. (Done — `celery` dropped, `redis` retained since cache uses it.)

---

## Prioritized Action List (impact vs effort)

### Tier 1 — High impact, low effort (do first)
| Status | # | Item | Section |
|---|---|---|---|
| ✅ | 1 | Preload CLIP + YOLO at startup | 1.1 |
| ✅ | 2 | Parallelize per-crop mobile OCR with `Promise.all` | 1.3 |
| ✅ | 3 | Add `index=True` on `ScanHistory.scanned_at` | 1.8 |
| ✅ | 4 | Cache full ordered `CardOut` list in `search_cache` (not just IDs) | 1.5 |
| ✅ | 5 | Hoist `imagehash`, `PIL` imports to module scope | 5.4 |
| ✅ | 6 | Delete dead single-card mode files (see table in §6) | 2.4 |
| ✅ | 7 | Delete unused `/search` + `/search/batch` endpoints & mobile wrappers | 2.5 |
| ✅ | 8 | Delete `PriceCache` model | 2.6 |
| ✅ | 9 | Memoize `FlatList` items in `multi-results.tsx`, `batch-prices.tsx` | 1.12 |
| ✅ | 10 | Wrap per-crop OCR in try/catch | 3.5 |
| ✅ | 11 | Add `AbortController` to mobile scan stream | 3.3 |

### Tier 2 — High impact, medium effort
| Status | # | Item | Section |
|---|---|---|---|
| ✅ | 12 | Make `/scan` truly streaming (per-crop parallel + as_completed) | 1.2 |
| ✅ | 13 | Move CLIP encode and OpenCV decode to `asyncio.to_thread` | 1.4, 1.9 |
| ✅ | 14 | Consolidate `CardMatcherService` into singleton with shared httpx clients | 2.1 |
| ✅ | 15 | Cache image search with richer structure (sim score, query_used as fields) | 4.2 |
| ✅ | 16 | Convert `POST /cards/history` to JSON body schema | 2.7 |
| ✅ | 17 | Parallelize phash computation with embedding | 1.6 |

### Tier 3 — Medium impact, low/medium effort
| Status | # | Item | Section |
|---|---|---|---|
| ✅ | 18 | Extract `saleLinkLabel` to shared util | 2.10 |
|   | 19 | Move OpenCV detector to a separate module or delete it | 2.3 |
| ✅ | 20 | Combine `_VALID_GAMES`/`_VALID_LANGUAGES` into shared module | 2.8 |
| ✅ | 21 | Refactor `get_prices` into helper methods | 2.9 |
| ⚠️ | 22 | Add proper error logging in place of silent `except` | 5.1 |
| ✅ | 23 | Detect PriceCharting 404 and cache negative results | 5.2 |
| ✅ | 24 | Reduce `CardOut` payload via `CardOutLite` schema | 4.4 |
| ✅ | 25 | Memoize `PriceChart` computations with `useMemo` | 1.11 |
| ✅ | 26 | Single setState in `batch-prices.tsx` via `Promise.allSettled` | 1.13 |

### Tier 4 — High impact, high effort (evaluate, don't commit yet)
| Status | # | Item | Section |
|---|---|---|---|
| ❌ | 27 | Replace Playwright with `httpx` for PriceCharting (test first) | 1.7, 7.1 |
| ✅ | 28 | Add `POST /cards/prices` batch price endpoint | 4.3 |
| ✅ | 29 | Cap total backend scrape time to match mobile XHR timeout | 5.5 |

### Tier 5 — Low priority / cosmetic
| Status | # | Item | Section |
|---|---|---|---|
| ✅ | 30 | Confirm Celery is unused and remove worker | 6.x |
| ✅ | 31 | Add cursor pagination to history list | 4.5 |
| ❌ | 32 | Replace `react-native-chart-kit` with custom SVG (only if app size matters) | 7.2 |
| ✅ | 33 | Optional gzip/msgpack for Redis values | 4.6 |
| ✅ | 34 | Remove unused mobile styles, unused imports, `_scan_counter` | 6 (table) |

---

## Notes

- Original audit was read-only. Findings cite line numbers based on the audit-time `HEAD` (commit `bc1f387`) — line numbers may have shifted in subsequent commits.
- Implementation applied across commits `1a00032` → `1f4786d` plus follow-up commits addressing the remaining "Not Yet Addressed" items (1.10, 1.14, 3.6, 4.3, 4.5, 4.6, 5.2, 5.3, 5.5, 23, 28, 29, 31, 33, plus `get_by_number`/`search_by_number` removal).
- Skipped intentionally (dependency considerations): 1.7, 7.1 (Playwright), 7.2 (chart-kit), 7.3 (axios), 27 (Playwright replacement), 32 (chart-kit replacement).
- Still deferred by design: 2.3 (OpenCV module split — left as safety net behind YOLO) and 19 (same), plus `pop_higher` (PSA scaffolding).
