# Comprehensive Codebase Audit — TCG Card Scanner

## Context

Full audit of the TCG scanner codebase (backend FastAPI + mobile React Native/Expo). Covers bugs, security, performance, perceived UX speed, and code quality. Findings are ordered by severity. Three parallel Explore agents reviewed all key files; I verified critical claims by reading source directly. Several agent-reported issues were false positives (noted below) and are excluded.

**False positives excluded:**
- PSA API key "in git" — `.env` is gitignored, not committed
- Fuzzy search full-table-scan — `base` query on line 406 of `card_matcher.py` already includes `Card.game == game, Card.language == language`
- Live scan race condition — `isScanningRef` makes the scan loop strictly sequential; no concurrent calls possible

---

## CRITICAL

### C1 — Startup failures are silently swallowed
**File:** `backend/app/main.py:20-27`

```python
await create_tables()                          # no try/except
await asyncio.gather(
    asyncio.to_thread(card_embedder.preload),  # no try/except
    asyncio.to_thread(card_detector.preload),
)
logger.info("Models preloaded; backend ready.")
```

If DB is unreachable or CLIP/YOLO model files are missing/corrupt, the exception propagates to uvicorn which **still starts the server** (FastAPI catches lifespan exceptions by default in some versions). The backend appears healthy but every `/scan` call fails. The `/health` endpoint returns `{"status": "ok"}` regardless.

**Fix:**
```python
try:
    await create_tables()
except Exception:
    logger.critical("Database init failed — aborting startup", exc_info=True)
    raise
try:
    await asyncio.gather(
        asyncio.to_thread(card_embedder.preload),
        asyncio.to_thread(card_detector.preload),
    )
except Exception:
    logger.critical("Model preload failed — aborting startup", exc_info=True)
    raise
```

Also upgrade `/health` to a real deep-health check:
```python
@app.get("/health")
async def health():
    checks = {}
    try:
        r = await get_redis(); await r.ping(); checks["redis"] = "ok"
    except Exception: checks["redis"] = "down"
    try:
        async with AsyncSessionLocal() as db: await db.execute(text("SELECT 1")); checks["db"] = "ok"
    except Exception: checks["db"] = "down"
    checks["models"] = "ok" if card_embedder._model is not None else "not_loaded"
    ok = all(v == "ok" for v in checks.values())
    return JSONResponse(checks, status_code=200 if ok else 503)
```

---

### C2 — Unbounded base64 image payloads — memory DoS
**Files:** `backend/app/schemas/card.py:116-118`, `backend/app/api/v1/scan.py` (ScanRequest)

`DetectRequest.image_base64` and `ScanRequest.image` have no `max_length`. A 100 MB base64 string would be decoded, loaded into PIL, processed by YOLO, and embedded by CLIP — all in memory.

**Fix — `backend/app/schemas/card.py`:**
```python
class DetectRequest(BaseModel):
    image_base64: str = Field(..., max_length=8_000_000)  # ~6MB decoded
    max_cards: int = Field(default=20, ge=1, le=50)
```

For `ScanRequest` in `scan.py`, add a validator:
```python
@field_validator("image")
@classmethod
def validate_image_size(cls, v):
    if v and len(v) > 8_000_000:
        raise ValueError("image too large (max 6MB)")
    return v
```

Also add a FastAPI middleware size limit in `main.py`:
```python
from starlette.middleware.base import BaseHTTPMiddleware
class MaxBodySizeMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        if request.headers.get("content-length"):
            if int(request.headers["content-length"]) > 20_000_000:
                return Response("Payload too large", status_code=413)
        return await call_next(request)
app.add_middleware(MaxBodySizeMiddleware)
```

---

### C3 — Internal exception message leaked in HTTP response
**File:** `backend/app/api/v1/detect.py:20-21`

```python
except Exception as e:
    raise HTTPException(status_code=422, detail=f"Detection failed: {e}")
```

`str(e)` on a YOLO/PIL exception can include model paths, file names, or stack context. This is information disclosure.

**Fix:**
```python
except Exception:
    logger.exception("detect_cards failed")
    raise HTTPException(status_code=500, detail="Detection failed")
```

---

## HIGH

### H1 — Redis initialized lazily with no startup health check or retry
**File:** `backend/app/services/cache.py:22-26`

Redis is created on first use. If Redis is down at startup, the first real request discovers the failure. There's no retry logic or circuit-breaker — every cache call will throw `ConnectionError` until Redis recovers, and those exceptions propagate to the endpoint handlers.

**Fix — add startup ping in `main.py` lifespan, before model load:**
```python
from app.services.cache import get_redis
try:
    r = await get_redis()
    await r.ping()
    logger.info("Redis connected")
except Exception:
    logger.warning("Redis unavailable at startup — caching disabled")
```

**Fix — make cache operations graceful in `cache.py`:**
```python
async def get(self, *key_parts: str) -> Any | None:
    try:
        r = await get_redis()
        raw = await r.get(self._key(*key_parts))
        return self._decode(raw, key_parts)
    except Exception:
        logger.warning("Cache get failed for %s", key_parts, exc_info=True)
        return None

async def set(self, *key_parts_and_value, ttl: int, value: Any) -> None:
    try:
        # existing logic
    except Exception:
        logger.warning("Cache set failed", exc_info=True)
```

This degrades gracefully (no caching) rather than crashing on Redis unavailability.

---

### H2 — Default `secret_key = "change-me"` with no validation
**File:** `backend/app/config.py:16`

If the `.env` file is missing `SECRET_KEY`, the app runs with a publicly-known key. Any HMAC-signed operation (future sessions, tokens) would be forgeable.

**Fix — add a validator in `Settings`:**
```python
from pydantic import model_validator

@model_validator(mode="after")
def validate_secret_key(self):
    if self.secret_key == "change-me":
        import warnings
        warnings.warn("SECRET_KEY is using default placeholder — set it in .env")
    if len(self.secret_key) < 16:
        raise ValueError("SECRET_KEY must be at least 16 characters")
    return self
```

---

### H3 — CORS `allow_methods=["*"], allow_headers=["*"]`
**File:** `backend/app/main.py:45-46`

Accepts all HTTP methods and headers. The app only uses GET and POST.

**Fix:**
```python
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=False,           # no auth cookies in use
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)
```

---

### H4 — DB session held open during entire streaming response
**File:** `backend/app/api/v1/cards.py:217, 264-294`

`batch_prices_stream()` receives `db: AsyncSession = Depends(get_db)`. The DB session is acquired when the endpoint starts, stays open through the `generate()` coroutine, and only released when the streaming response is complete (which includes N concurrent `get_prices()` calls that each take ~1s). For 25 cards, one streaming request holds a DB connection for 30–60 seconds.

Under moderate concurrent load, the pool (`pool_size=10, max_overflow=20`) exhausts.

**Fix — fetch all card data upfront, then close the session before streaming:**
```python
@router.post("/prices/stream")
async def batch_prices_stream(req: BatchPricesRequest, db: AsyncSession = Depends(get_db)):
    card_ids = list(dict.fromkeys(req.card_ids))[:25]
    # Fetch cards and release the DB connection BEFORE streaming
    result = await db.execute(select(Card).where(Card.id.in_(card_ids)))
    cards_by_id: dict[int, Card] = {c.id: c for c in result.scalars().all()}
    await db.close()  # release pool slot now

    # generate() no longer needs db — it only calls matcher.get_prices() which uses its own session
    async def generate():
        ...  # unchanged except no db.commit() at end
    return StreamingResponse(generate(), media_type="application/x-ndjson")
```

Also add `pool_recycle` to prevent stale connections under long-running deployments:

**`backend/app/database.py:8-14`:**
```python
engine = create_async_engine(
    settings.database_url,
    echo=settings.environment == "development",
    pool_pre_ping=True,
    pool_size=10,
    max_overflow=20,
    pool_recycle=3600,  # recycle connections after 1h
)
```

---

### H5 — Debug `console.log` on every streaming chunk in production
**File:** `mobile/services/api.ts` — `streamPrices()` and `scanStream()`

Lines like `console.log("[streamPrices] flush lines=${lines.length} text=${text.length}b")` and `console.log("[streamPrices] onprogress chunk=${chunk.length}b ...")` fire on EVERY chunk of EVERY scan. On a 12-card scan that streams 12 results, this is ~60 console.log calls per scan. On Android, `console.log` is synchronous bridge traffic that adds measurable latency (~2-5ms each).

**Fix:** Remove or gate behind a debug flag:
```typescript
const DEBUG_STREAM = false;
// replace console.log calls with: if (DEBUG_STREAM) console.log(...)
```

---

## MEDIUM

### M1 — `datetime.utcnow()` deprecated in Python 3.12+
**File:** `backend/app/api/v1/cards.py:203, 253`; also `backend/app/models/card.py` (Column defaults)

```python
PriceOut(**price_dict, fetched_at=datetime.utcnow())
```

`datetime.utcnow()` is deprecated and returns a naive datetime. In Python 3.12 it raises a `DeprecationWarning`; future versions may remove it.

**Fix:**
```python
from datetime import datetime, timezone
fetched_at=datetime.now(timezone.utc)
```
For SQLAlchemy column defaults: `server_default=func.now()` or `default=lambda: datetime.now(timezone.utc)`.

---

### M2 — Silent search failure in lookup screen
**File:** `mobile/app/(tabs)/lookup.tsx:39-48`

```typescript
catch {
  setResults([]);
  setSearched(true);
}
```

Network errors, timeouts, and 500s all show the same "No cards found" state. User cannot distinguish a failed search from a legitimately empty result.

**Fix — add an error state:**
```typescript
const [searchError, setSearchError] = useState<string | null>(null);
// in catch:
catch (e) {
  console.warn("[lookup] search failed:", e);
  setSearchError("Search failed — check your connection");
  setResults([]);
  setSearched(true);
}
// in render: show searchError in a visible error banner if set
```

---

### M3 — State update after unmount in batch-prices
**File:** `mobile/app/batch-prices.tsx` — `useEffect` streaming block

If the user navigates away mid-stream, the `AbortController` fires `xhr.abort()` which resolves the promise, but any in-flight `setEntries` calls in the `onResult` callback may still execute after the component unmounts. React 18 suppressed the warning but stale updates still waste cycles.

**Fix — add mounted ref:**
```typescript
const mountedRef = useRef(true);
useEffect(() => () => { mountedRef.current = false; }, []);
// In the onResult callback:
if (mountedRef.current) setEntries((prev) => ...);
```

---

### M4 — FlatList callbacks not memoized in multi-results
**File:** `mobile/app/multi-results.tsx`

`renderItem`, `handleViewCard`, `handleOpenSwap`, `handleToggleSelect` are inline arrow functions or `useCallback` with unstable deps. Every checkbox toggle or swap triggers re-render of all visible card rows.

**Fix — wrap all card-row interaction callbacks in `useCallback` with stable deps, and ensure `renderItem` itself is wrapped:**
```typescript
const renderItem = useCallback(({ item }: { item: ScanResultCard }) => (
  <ResultCard
    card={item}
    onView={handleViewCard}
    onSwap={handleOpenSwap}
    onToggle={handleToggleSelect}
    isSelected={selectedIds.has(item.regionIndex)}
  />
), [handleViewCard, handleOpenSwap, handleToggleSelect, selectedIds]);
```
Move `selectedIds` to a `Set` stored in a ref or use `useCallback` with `selectedIds` properly stabilized.

---

### M5 — Missing `getItemLayout` on grid FlatList in collection detail
**File:** `mobile/app/collection/[id].tsx`

The `numColumns={2}` grid FlatList has no `getItemLayout`. For collections with 50+ cards, fast-scrolling causes layout calculation stalls.

**Fix:**
```typescript
const ITEM_HEIGHT = 180; // measure actual card cell height
const ITEM_GAP = 8;
getItemLayout={(_, index) => ({
  length: ITEM_HEIGHT + ITEM_GAP,
  offset: (ITEM_HEIGHT + ITEM_GAP) * Math.floor(index / 2),
  index,
})}
```

---

### M6 — `Linking.openURL()` without URL scheme validation
**File:** `mobile/components/Card/PriceDisplay.tsx` (sale URL handler), `mobile/app/card/[id].tsx`

Sale URLs are scraped from PriceCharting HTML and stored in Redis/DB. If the scraper ever produces a `javascript:` or `data:` URL (malformed HTML edge case), it would be opened directly.

**Fix — validate before opening:**
```typescript
const openUrl = (url: string) => {
  if (!url.startsWith("https://") && !url.startsWith("http://")) return;
  Linking.openURL(url).catch(() => {});
};
```

---

### M7 — Hardcoded local IP in `constants/index.ts`
**File:** `mobile/constants/index.ts:4`

```typescript
export const API_BASE_URL = "http://192.168.1.2:8000/api/v1";
```

Breaks for any device not on the `192.168.1.x` subnet. Anyone cloning the repo needs to change this manually.

**Fix — use Expo's `EXPO_PUBLIC_` env vars:**
```typescript
// constants/index.ts
export const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://192.168.1.2:8000/api/v1";
```
Then set `EXPO_PUBLIC_API_URL=http://10.0.2.2:8000/api/v1` in `.env.local` for emulator, etc. Create `.env.example` documenting this.

---

### M8 — Redis cache key uses raw query string
**File:** `backend/app/services/card_matcher.py` — `search_cards()` cache key

```python
cache_key = f"{game}:{language}:{query}"
```

If `query` contains `:` characters (e.g., `"V-MAX:"` from OCR misread), the key structure becomes ambiguous. With the current `CacheService._key()` joining on `:`, the path ends up as `tcg:search:game:language:V-MAX:` which will look up incorrectly.

**Fix:**
```python
import hashlib
query_hash = hashlib.md5(query.encode()).hexdigest()
cache_key = f"{game}:{language}:{query_hash}"
```

---

### M9 — Silent exception catch in live scan hot path
**File:** `mobile/hooks/useLiveScan.ts:133`

```typescript
} catch {
  // skip silently
}
```

Any exception thrown by the scan loop (network error, JSON parse failure, image resize crash) is completely suppressed. Debugging scan failures requires adding console.log manually.

**Fix:**
```typescript
} catch (e) {
  console.warn("[useLiveScan] scan cycle error:", e);
}
```

---

## LOW

### L1 — `/health` endpoint returns static `ok`
**File:** `backend/app/main.py:52-54`

Already covered in C1 fix above. Current endpoint doesn't check DB, Redis, or model state.

---

### L2 — Dead code: `reason` field computed but never returned
**File:** `mobile/utils/cardConfidence.ts:70-76`

The `reason` string is built (e.g., `"low_confidence"`) but the return type is `{ score, isCard }` — `reason` is never included. Remove the computation or add it to the return type for future use.

---

### L3 — DB pool size not configurable from env
**File:** `backend/app/database.py:12-13`

`pool_size=10, max_overflow=20` is hard-coded. Add to `Settings`:
```python
db_pool_size: int = 10
db_max_overflow: int = 20
```
Then `engine = create_async_engine(..., pool_size=settings.db_pool_size, max_overflow=settings.db_max_overflow)`.

---

### L4 — `SET LOCAL ivfflat.probes = 20` on every vector search
**File:** `backend/app/api/v1/scan.py:174`

This is a session-local setting that costs ~1ms per query. Since each AsyncSession is a short-lived checkout from the pool, the setting doesn't persist between requests — it needs to be set each time. The current behavior is correct but could be moved to a session init event to avoid explicit code in `_vector_search`. Low-impact change.

---

### L5 — `allow_credentials=True` with no auth in use
**File:** `backend/app/main.py:44`

`allow_credentials=True` allows cookies/auth headers cross-origin. The app has no authentication; this flag is unnecessary and slightly broadens the CSRF surface.

**Fix:** Set `allow_credentials=False` (already covered in H3 fix).

---

## Summary Table

| # | Severity | File | Issue |
|---|----------|------|-------|
| C1 | Critical | `backend/main.py` | Startup failures (DB/model) not caught → server starts broken |
| C2 | Critical | `backend/schemas/card.py`, `scan.py` | No payload size limit on image fields → OOM DoS |
| C3 | Critical | `backend/api/v1/detect.py:21` | Exception message leaked in HTTP response |
| H1 | High | `backend/services/cache.py` | Redis lazily initialized, no retry/graceful degradation |
| H2 | High | `backend/config.py:16` | `secret_key="change-me"` default, no validation |
| H3 | High | `backend/main.py:45-46` | CORS `allow_methods=["*"]` too permissive |
| H4 | High | `backend/api/v1/cards.py:217` | DB session held open entire streaming duration |
| H5 | High | `mobile/services/api.ts` | Debug `console.log` on every stream chunk |
| M1 | Medium | `backend/api/v1/cards.py:203,253` | `datetime.utcnow()` deprecated in Python 3.12+ |
| M2 | Medium | `mobile/app/(tabs)/lookup.tsx` | Silent search error → indistinguishable from empty results |
| M3 | Medium | `mobile/app/batch-prices.tsx` | State update after unmount (missing mounted ref) |
| M4 | Medium | `mobile/app/multi-results.tsx` | FlatList callbacks unstable → full list re-renders |
| M5 | Medium | `mobile/app/collection/[id].tsx` | No `getItemLayout` on grid FlatList |
| M6 | Medium | `mobile/components/Card/PriceDisplay.tsx` | Unvalidated URL passed to `Linking.openURL()` |
| M7 | Medium | `mobile/constants/index.ts:4` | Hardcoded local IP — breaks for other devs/subnets |
| M8 | Medium | `backend/services/card_matcher.py` | Raw query string in Redis cache key → key ambiguity |
| M9 | Medium | `mobile/hooks/useLiveScan.ts:133` | Silent `catch {}` in scan loop |
| L1 | Low | `backend/main.py` | `/health` doesn't check DB/Redis/models |
| L2 | Low | `mobile/utils/cardConfidence.ts` | Dead `reason` field |
| L3 | Low | `backend/database.py` | Pool size hard-coded |
| L4 | Low | `backend/api/v1/scan.py:174` | `SET LOCAL ivfflat.probes` called per query |
| L5 | Low | `backend/main.py:44` | `allow_credentials=True` with no auth in use |

---

## Recommended Implementation Order

1. **C1 + C2 + C3** — startup safety + payload limits + response leak (all backend, 1-2h)
2. **H1** — Redis graceful degradation (backend, 1h)
3. **H4** — release DB session before streaming (backend, 30m)
4. **H5** — remove debug console.logs (mobile, 15m)
5. **M2 + M9** — surface errors to user instead of silencing (mobile, 30m)
6. **M4 + M5** — FlatList perf (mobile, 1h)
7. **H2 + H3** — config validation + CORS (backend, 30m)
8. **M1** — datetime deprecation (backend, 15m)
9. **M3 + M6 + M7 + M8** — remaining medium issues (1-2h)
10. **L1-L5** — low priority cleanup (1h)

---

## Verification

After implementing:
- **C1:** Stop the backend mid-startup (kill postgres container), confirm uvicorn exits non-zero and logs `CRITICAL`
- **C2:** Send a 50MB base64 string to `/api/v1/detect`; confirm 413/422 response, not 500 or hang
- **H4:** Run 3 concurrent batch-prices requests for 25 cards each; confirm no `QueuePool limit exceeded` in logs
- **H5:** Do a 12-card multi-scan; confirm no `[streamPrices]` log lines in the device console
- **M2:** Kill backend, do a lookup search; confirm error banner vs "No cards found"
- **M4:** Scan 15 cards; open multi-results; check interaction framerate with React DevTools profiler
