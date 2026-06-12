/**
 * Asset updater — Phase 6 of on-device CLIP migration.
 *
 * On app launch, checks the server's /assets/manifest endpoint to see if
 * updated index/cards.db/model files are available. Downloads changed files
 * to app storage so the next scan uses the latest data without an app update.
 *
 * Strategy:
 *   - Compare SHA-256 of each manifest file against locally cached version
 *   - Download only files whose hash has changed (or that don't exist locally)
 *   - Update stored hashes after successful download
 *   - Non-blocking: runs in the background, doesn't delay the first scan
 *   - On failure, silently continues with the bundled/cached assets
 *
 * After a successful update:
 *   - vectorSearch.ts will pick up new index_*.bin on next cold load
 *   - clipEmbedder.ts re-probes capability if CLIP_MODEL_VERSION bumped
 */

import { useEffect } from "react";
import * as FileSystem from "expo-file-system/legacy";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { API_BASE_URL } from "@/constants";

const MANIFEST_URL = `${API_BASE_URL}/assets/manifest`;
const ASSET_DIR = `${FileSystem.documentDirectory}tcg_assets/`;
const HASH_STORE_KEY = "tcg:assetHashes";

// Files that can be hot-updated (index + cards.db).
// The CLIP model itself (clip_visual.tflite) requires an app update to change
// because react-native-fast-tflite loads from the bundle, not documentDirectory.
const UPDATABLE_FILES = [
  "index_en.bin",
  "index_ja.bin",
  "card_ids_en.bin",
  "card_ids_ja.bin",
  "cards.db",
];

interface ManifestFile {
  sha256: string;
  size: number;
  url?: string;
}

interface Manifest {
  model_version: string;
  files: Record<string, ManifestFile>;
}

async function ensureAssetDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(ASSET_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(ASSET_DIR, { intermediates: true });
  }
}

async function getStoredHashes(): Promise<Record<string, string>> {
  try {
    const raw = await AsyncStorage.getItem(HASH_STORE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

async function storeHash(filename: string, hash: string): Promise<void> {
  const hashes = await getStoredHashes();
  hashes[filename] = hash;
  await AsyncStorage.setItem(HASH_STORE_KEY, JSON.stringify(hashes));
}

async function downloadAsset(url: string, filename: string): Promise<boolean> {
  const dest = `${ASSET_DIR}${filename}`;
  try {
    const result = await FileSystem.downloadAsync(url, dest);
    return result.status === 200;
  } catch (e) {
    console.warn(`[AssetUpdater] failed to download ${filename}:`, e);
    return false;
  }
}

async function checkAndUpdate(): Promise<void> {
  let manifest: Manifest;
  try {
    const resp = await fetch(MANIFEST_URL, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return;
    manifest = await resp.json();
  } catch {
    return; // offline or server unavailable — silently skip
  }

  await ensureAssetDir();
  const storedHashes = await getStoredHashes();

  for (const filename of UPDATABLE_FILES) {
    const entry = manifest.files[filename];
    if (!entry?.url) continue;

    const storedHash = storedHashes[filename];
    if (storedHash === entry.sha256) continue; // up to date

    console.log(`[AssetUpdater] downloading updated ${filename} (${(entry.size / 1e6).toFixed(1)} MB)`);
    const ok = await downloadAsset(entry.url, filename);
    if (ok) {
      await storeHash(filename, entry.sha256);
      console.log(`[AssetUpdater] ${filename} updated successfully`);
    }
  }
}

/**
 * Hook — run asset update check in the background on mount.
 * Use in the root layout (_layout.tsx) so it runs once at app launch.
 */
export function useAssetUpdater(): void {
  useEffect(() => {
    // Fire and forget — never block render or first scan
    checkAndUpdate().catch(() => {});
  }, []);
}

/**
 * Returns the path to a hot-updated asset file, falling back to the bundled
 * asset if no updated version exists in app storage.
 *
 * vectorSearch.ts and clipEmbedder.ts should use this to resolve asset paths
 * so they pick up updates without requiring an app release.
 */
export async function resolveAssetPath(filename: string, bundledPath: string): Promise<string> {
  const hotPath = `${ASSET_DIR}${filename}`;
  const info = await FileSystem.getInfoAsync(hotPath);
  return info.exists ? hotPath : bundledPath;
}
