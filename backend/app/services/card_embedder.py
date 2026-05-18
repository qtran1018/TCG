import io
import logging
from pathlib import Path

import numpy as np
import torch

logger = logging.getLogger(__name__)

_model = None
_preprocess = None
_device = torch.device("cuda" if torch.cuda.is_available() else "cpu")


_FINETUNED_WEIGHTS = Path(__file__).parent.parent.parent / "models" / "clip_finetuned.pt"


def _load_model():
    global _model, _preprocess
    if _model is not None:
        return
    import open_clip

    logger.info("Loading CLIP ViT-B/32 on %s...", _device)
    _model, _, _preprocess = open_clip.create_model_and_transforms("ViT-B-32", pretrained="openai")

    if _FINETUNED_WEIGHTS.exists():
        logger.info("Loading fine-tuned visual encoder from %s", _FINETUNED_WEIGHTS)
        state = torch.load(_FINETUNED_WEIGHTS, map_location=_device)
        _model.visual.load_state_dict(state)
        logger.info("Fine-tuned weights loaded")
    else:
        logger.info("No fine-tuned weights found — using pretrained OpenAI CLIP")

    _model = _model.to(_device)
    _model.eval()
    logger.info("CLIP ViT-B/32 ready (512-dim features, device=%s)", _device)


def embed_image(image_bytes: bytes) -> np.ndarray:
    """512-dim L2-normalized CLIP embedding for nearest-neighbor search."""
    return embed_batch([image_bytes])[0]


def compute_phash(image_bytes: bytes) -> str | None:
    """Perceptual hash of the art-region crop. Returns hex string or None on error."""
    try:
        import imagehash
        from PIL import Image
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
    """Embed multiple images in one forward pass. Returns list of 512-dim float32 arrays."""
    from PIL import Image

    _load_model()
    tensors = [
        _preprocess(_crop_art(Image.open(io.BytesIO(b)).convert("RGB")))
        for b in images_bytes
    ]
    batch = torch.stack(tensors).to(_device)
    with torch.no_grad():
        features = _model.encode_image(batch)
        features = features / features.norm(dim=-1, keepdim=True)
    return [v.cpu().numpy().astype(np.float32) for v in features]
