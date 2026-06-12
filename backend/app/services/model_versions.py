import json
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

_VERSIONS_PATH = Path(__file__).parent.parent.parent / "models" / "versions.json"
_cache: dict | None = None


def load() -> dict:
    global _cache
    if _cache is None:
        try:
            _cache = json.loads(_VERSIONS_PATH.read_text())
        except Exception as e:
            logger.warning("Could not read model versions.json: %s", e)
            _cache = {}
    return _cache


def get(key: str) -> str:
    return load().get(key, {}).get("version", "unknown")


def summary() -> dict[str, str]:
    return {k: v.get("version", "?") for k, v in load().items()}
