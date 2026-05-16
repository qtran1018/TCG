import io
import logging
import pickle
from pathlib import Path

import numpy as np

logger = logging.getLogger(__name__)

_PCA_PATH = Path(__file__).parent.parent.parent / "models" / "pca.pkl"

_model = None
_transform = None
_pca = None


def _load_model():
    global _model, _transform
    if _model is not None:
        return
    import timm
    import torch
    from torchvision import transforms

    logger.info("Loading EfficientNet-B0 embedding model...")
    _model = timm.create_model("efficientnet_b0", pretrained=True, num_classes=0)
    _model.eval()
    _transform = transforms.Compose([
        transforms.Resize((224, 224)),
        transforms.ToTensor(),
        transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
    ])
    logger.info("EfficientNet-B0 ready (1280-dim features)")


def _load_pca() -> bool:
    global _pca
    if _pca is not None:
        return True
    if not _PCA_PATH.exists():
        return False
    with open(_PCA_PATH, "rb") as f:
        _pca = pickle.load(f)
    logger.info("PCA model loaded from %s", _PCA_PATH)
    return True


def embed_raw(image_bytes: bytes) -> np.ndarray:
    """1280-dim raw EfficientNet-B0 features. Used by build_embeddings.py to fit PCA."""
    import torch
    from PIL import Image

    _load_model()
    img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    tensor = _transform(img).unsqueeze(0)
    with torch.no_grad():
        features = _model(tensor)
    return features.squeeze().numpy()


def embed_image(image_bytes: bytes) -> np.ndarray | None:
    """256-dim PCA-reduced embedding for nearest-neighbor search.

    Returns None if PCA hasn't been built yet (run scripts/build_embeddings.py first).
    """
    raw = embed_raw(image_bytes)
    if not _load_pca():
        logger.warning("PCA not found at %s — run scripts/build_embeddings.py first", _PCA_PATH)
        return None
    return _pca.transform(raw.reshape(1, -1))[0].astype(np.float32)


def is_ready() -> bool:
    """True when PCA model exists and image matching can be used."""
    return _PCA_PATH.exists()
