import asyncio
import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from starlette.middleware.base import BaseHTTPMiddleware
from sqlalchemy import text
from app.config import get_settings
from app.database import create_tables, AsyncSessionLocal
from app.api.v1 import router as v1_router
from app.scrapers.base import close_client
from app.services import card_detector, card_embedder, matcher, model_versions
from app.services.cache import get_redis

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)
settings = get_settings()


class MaxBodySizeMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        if request.headers.get("content-length"):
            if int(request.headers["content-length"]) > 20_000_000:
                return Response("Payload too large", status_code=413)
        return await call_next(request)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting TCG backend...")
    try:
        await create_tables()
    except Exception:
        logger.critical("Database init failed — aborting startup", exc_info=True)
        raise
    try:
        r = await get_redis()
        await r.ping()
        logger.info("Redis connected")
    except Exception:
        logger.warning("Redis unavailable at startup — caching disabled")
    logger.info("Preloading ML models (CLIP + YOLO)...")
    try:
        await asyncio.gather(
            asyncio.to_thread(card_embedder.preload),
            asyncio.to_thread(card_detector.preload),
        )
    except Exception:
        logger.critical("Model preload failed — aborting startup", exc_info=True)
        raise
    logger.info("Models preloaded; backend ready.")
    yield
    logger.info("Shutting down TCG backend...")
    await matcher.close()
    await close_client()


app = FastAPI(
    title="TCG Card Scanner API",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(MaxBodySizeMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

app.include_router(v1_router, prefix="/api")


@app.get("/health")
async def health():
    checks = {}
    try:
        r = await get_redis()
        await r.ping()
        checks["redis"] = "ok"
    except Exception:
        checks["redis"] = "down"
    try:
        async with AsyncSessionLocal() as db:
            await db.execute(text("SELECT 1"))
        checks["db"] = "ok"
    except Exception:
        checks["db"] = "down"
    checks["clip_loaded"] = "ok" if card_embedder._model is not None else "not_loaded"
    checks["model_versions"] = model_versions.summary()
    ok = checks["redis"] == "ok" and checks["db"] == "ok"
    return JSONResponse(checks, status_code=200 if ok else 503)
