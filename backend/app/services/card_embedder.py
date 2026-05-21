import io
import logging
import threading
from pathlib import Path

import imagehash
import numpy as np
import torch
from PIL import Image

logger = logging.getLogger(__name__)

_model = None
_preprocess = None
_device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
# fp16 on CUDA roughly halves VRAM and gives ~1.8× faster inference on
# Ampere-class GPUs (RTX 30xx). CPU keeps fp32 — fp16 on CPU is slower.
_USE_HALF = _device.type == "cuda"
_load_lock = threading.Lock()


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


def compute_phash(image_bytes: bytes) -> str | None:
    """Perceptual hash of the art-region crop. Returns hex string or None on error."""
    try:
        img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
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


def embed_batch(images_bytes: list[bytes]) -> list[np.ndarray]:
    """Embed multiple images in one forward pass. Returns list of 512-dim float32 arrays.

    Synchronous (CPU/GPU). Callers in async contexts should wrap with asyncio.to_thread
    so the event loop isn't blocked during the forward pass.
    """
    _load_model()
    tensors = [
        _preprocess(_crop_art(Image.open(io.BytesIO(b)).convert("RGB")))
        for b in images_bytes
    ]
    batch = torch.stack(tensors).to(_device)
    if _USE_HALF:
        batch = batch.half()
    with torch.inference_mode():
        features = _model.encode_image(batch)
        features = features / features.norm(dim=-1, keepdim=True)
    # Cast back to fp32 — pgvector storage and downstream cosine math expect float32.
    return [v.float().cpu().numpy() for v in features]
