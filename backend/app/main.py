import asyncio
import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.config import get_settings
from app.database import create_tables
from app.api.v1 import router as v1_router
from app.scrapers.base import close_client
from app.services import card_detector, card_embedder, matcher

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)
settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting TCG backend...")
    await create_tables()
    # Preload heavy models so the first request doesn't pay cold-start cost.
    # Run off the event loop since model load is CPU-bound and uses torch's blocking IO.
    logger.info("Preloading ML models (CLIP + YOLO)...")
    await asyncio.gather(
        asyncio.to_thread(card_embedder.preload),
        asyncio.to_thread(card_detector.preload),
    )
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

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(v1_router, prefix="/api")


@app.get("/health")
async def health():
    return {"status": "ok"}
