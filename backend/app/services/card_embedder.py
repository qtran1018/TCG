import io
import logging
import os
import threading
from pathlib import Path

import imagehash
import numpy as np
import torch
from PIL import Image

logger = logging.getLogger(__name__)

_model = None
_preprocess = None

# OCI Ampere deployment: server no longer runs CLIP in the hot path — on-device
# CLIP handles recognition; server is fallback-only for weak/non-NPU devices.
# Force CPU mode when FORCE_CPU_EMBEDDER=1 (set in docker-compose for OCI).
# Retain CUDA auto-detect for local GPU dev so existing workflow is unchanged.
_FORCE_CPU = os.getenv("FORCE_CPU_EMBEDDER", "").strip() in ("1", "true", "yes")
_device = torch.device("cpu") if _FORCE_CPU else torch.device("cuda" if torch.cuda.is_available() else "cpu")
# fp16 on CUDA roughly halves VRAM and gives ~1.8× faster inference on
# Ampere-class GPUs (RTX 30xx). CPU keeps fp32 — fp16 on CPU is slower.
_USE_HALF = _device.type == "cuda"
_load_lock = threading.Lock()

# On OCI (CPU fallback-only), cap concurrent embeds so a burst of weak-device
# fallbacks can't saturate all cores and starve co-hosted services.
# CLIP_MAX_CONCURRENCY=0 means unlimited (default for GPU/local dev).
_MAX_CONCURRENCY = int(os.getenv("CLIP_MAX_CONCURRENCY", "0") or 0)
_concurrency_sem = threading.Semaphore(_MAX_CONCURRENCY) if _MAX_CONCURRENCY > 0 else None


_FINETUNED_WEIGHTS = Path(__file__).parent.parent.parent / "models" / "clip_finetuned.pt"


def preload() -> None:
    """Eagerly load the CLIP model at startup so the first /scan call is fast."""
    _load_model()


def _load_model():
    global _model, _preprocess
    if _model is not None:
        return
    # Lock prevents two ThreadPoolExecutor workers (from asyncio.to_thread)
    # from racing the first-call load — without it both would allocate ~170MB
    # of CLIP weights before one wins the assignment.
    with _load_lock:
        if _model is not None:
            return
        import open_clip

        logger.info("Loading CLIP ViT-B/32 on %s (half=%s)...", _device, _USE_HALF)
        model, _, preprocess = open_clip.create_model_and_transforms("ViT-B-32", pretrained="openai")

        if _FINETUNED_WEIGHTS.exists():
            logger.info("Loading fine-tuned visual encoder from %s", _FINETUNED_WEIGHTS)
            state = torch.load(_FINETUNED_WEIGHTS, map_location=_device)
            model.visual.load_state_dict(state)
            logger.info("Fine-tuned weights loaded")
        else:
            logger.info("No fine-tuned weights found — using pretrained OpenAI CLIP")

        model = model.to(_device)
        if _USE_HALF:
            model = model.half()
        model.eval()
        _preprocess = preprocess
        _model = model
        logger.info("CLIP ViT-B/32 ready (512-dim features, device=%s, half=%s)", _device, _USE_HALF)


def embed_image(image_bytes: bytes) -> np.ndarray:
    """512-dim L2-normalized CLIP embedding for nearest-neighbor search."""
    return embed_batch([image_bytes])[0]


def _to_pil(src: "Image.Image | bytes") -> "Image.Image":
    """Accept either a PIL Image (zero-copy path) or JPEG/PNG bytes (decode once)."""
    if isinstance(src, Image.Image):
        return src if src.mode == "RGB" else src.convert("RGB")
    return Image.open(io.BytesIO(src)).convert("RGB")


def compute_phash(src: "Image.Image | bytes") -> str | None:
    """Perceptual hash of the art-region crop. Returns hex string or None on error.

    Accepts a PIL Image directly to skip JPEG decode when the caller already has one.
    """
    try:
        img = _to_pil(src)
        return str(imagehash.phash(_crop_art(img)))
    except Exception:
        logger.warning("phash computation failed", exc_info=True)
        return None


def _crop_art(img):
    """Crop to the card art region (works for both standard and full-art cards).

    Standard cards: art box sits roughly at y=10%-56%, x=4%-96%.
    Full-art cards: illustration covers the whole card; this crop captures the
    upper subject area, which is where the main Pokémon/character appears.
    """
    w, h = img.size
    return img.crop((int(w * 0.04), int(h * 0.12), int(w * 0.96), int(h * 0.52)))


def embed_batch(images: "list[Image.Image | bytes]") -> list[np.ndarray]:
    """Embed multiple images in one forward pass. Returns list of 512-dim float32 arrays.

    Accepts a heterogeneous list of PIL Images and/or encoded bytes — PIL Images are
    passed straight through (no JPEG decode round-trip), bytes get decoded once.
    This matters in the /scan hot path where callers already crop with PIL and would
    otherwise have to JPEG-encode just to pass us bytes we'd immediately decode.

    Synchronous (CPU/GPU). Callers in async contexts should wrap with asyncio.to_thread
    so the event loop isn't blocked during the forward pass.
    """
    _load_model()
    if _concurrency_sem is not None:
        _concurrency_sem.acquire()
    try:
        tensors = [_preprocess(_crop_art(_to_pil(src))) for src in images]
        batch = torch.stack(tensors).to(_device)
        if _USE_HALF:
            batch = batch.half()
        with torch.inference_mode():
            features = _model.encode_image(batch)
            features = features / features.norm(dim=-1, keepdim=True)
        # Cast back to fp32 — pgvector storage and downstream cosine math expect float32.
        return [v.float().cpu().numpy() for v in features]
    finally:
        if _concurrency_sem is not None:
            _concurrency_sem.release()
