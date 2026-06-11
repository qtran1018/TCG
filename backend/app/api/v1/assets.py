"""
Asset manifest endpoint — Phase 6 of on-device CLIP migration.

Serves the manifest.json produced by scripts/build_mobile_index.py so the
mobile app can detect when new index/model/cards.db assets are available and
download deltas without requiring a full app store update.

The manifest lives at backend/app/data/asset_manifest.json and is re-generated
by build_mobile_index.py whenever a new set is added or a model is rebuilt.

Endpoint:
  GET /api/v1/assets/manifest
  Response: { model_version, files: { filename: { sha256, size, url } } }

The `url` field is injected at serve time using ASSET_BASE_URL from config
(e.g. an OCI Object Storage pre-auth URL or a CDN prefix). Set this in .env:
  ASSET_BASE_URL=https://objectstorage.ap-osaka-1.oraclecloud.com/n/.../b/tcg-assets/o/
"""

import json
import logging
import os
from pathlib import Path

from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/assets", tags=["assets"])
logger = logging.getLogger(__name__)

_MANIFEST_PATH = Path(__file__).parent.parent.parent / "data" / "asset_manifest.json"
_ASSET_BASE_URL = os.getenv("ASSET_BASE_URL", "").rstrip("/")


@router.get("/manifest")
async def get_asset_manifest():
    """Return the current asset manifest with download URLs.

    Mobile app polls this on launch to decide whether to download updated
    index/model/cards.db assets. SHA-256 hashes allow delta detection:
    if the hash matches the locally cached file, no download is needed.

    The response is intentionally lightweight (< 1KB) so it's always fast
    even on poor connectivity — the actual asset downloads are done lazily.
    """
    if not _MANIFEST_PATH.exists():
        raise HTTPException(
            status_code=503,
            detail="Asset manifest not yet built. Run scripts/build_mobile_index.py first.",
        )

    try:
        manifest = json.loads(_MANIFEST_PATH.read_text())
    except Exception as e:
        logger.error("Failed to read asset manifest: %s", e)
        raise HTTPException(status_code=500, detail="Failed to read asset manifest")

    # Inject download URLs — decouple the stored manifest (hashes only) from
    # the serving URL so the base URL can change without rebuilding the manifest.
    if _ASSET_BASE_URL and "files" in manifest:
        for fname, meta in manifest["files"].items():
            meta["url"] = f"{_ASSET_BASE_URL}/{fname}"

    return manifest
