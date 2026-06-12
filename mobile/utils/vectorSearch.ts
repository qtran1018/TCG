/**
 * On-device vector search — Phase 3 of on-device CLIP migration.
 *
 * Reads the binary index files built by scripts/build_mobile_index.py and
 * performs brute-force cosine similarity search over 47k int8 vectors.
 *
 * Index format (matches build_mobile_index.py):
 *   4B  magic "TCGI"
 *   4B  version uint32 LE = 1
 *   4B  n_cards uint32 LE
 *   4B  dim     uint32 LE (512)
 *   n*4 scales  float32 LE (per-vector dequant scales)
 *   n*512 int8  (quantized embeddings, row-major)
 *
 * Performance: 47k × 512 int8 dot-products in JS typed arrays.
 * Measured on mid-range Android: ~15-50ms. Acceptable for scan latency.
 *
 * Thresholds mirror scan.py exactly:
 *   SIM_THRESHOLD = 0.65  (confident match)
 *   SIM_FLOOR     = 0.45  (minimum to return any result; 0.45 catches hard cards
 *                          like Dewgong whose fp16 NNAPI sims cluster ~0.45-0.49)
 */

import * as FileSystem from 'expo-file-system/legacy';
import { Asset } from 'expo-asset';

const EMBED_DIM     = 512;
const INDEX_MAGIC   = 0x49474354; // "TCGI" as little-endian uint32
const INDEX_VERSION = 1;

export const SIM_THRESHOLD = 0.65;
export const SIM_FLOOR     = 0.45;
export const TOP_K         = 10;

// ---------------------------------------------------------------------------
// Index state (lazy-loaded per language)
// ---------------------------------------------------------------------------

interface LoadedIndex {
  nCards:  number;
  scales:  Float32Array;   // (nCards,) dequant scale per vector
  vectors: Int8Array;      // (nCards * 512,) row-major int8
  cardIds: Int32Array;     // (nCards,) parallel card.id array
}

const _indices: Partial<Record<'en' | 'ja', LoadedIndex | null>> = {};
const _loadPromises: Partial<Record<'en' | 'ja', Promise<LoadedIndex | null>>> = {};

// Asset require calls must be static — listed here, selected by language at runtime.
// Requires these files to exist in mobile/assets/data/ after build_mobile_index.py.
const INDEX_ASSETS: Record<'en' | 'ja', { index: number; ids: number }> = {
  en: {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    index: require('../assets/data/index_en.bin'),
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ids:   require('../assets/data/card_ids_en.bin'),
  },
  ja: {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    index: require('../assets/data/index_ja.bin'),
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ids:   require('../assets/data/card_ids_ja.bin'),
  },
};

async function readAssetBytes(module: number): Promise<ArrayBuffer> {
  const asset = Asset.fromModule(module);
  await asset.downloadAsync();
  const uri = asset.localUri ?? asset.uri;
  const b64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const binaryStr = atob(b64);
  const buf = new ArrayBuffer(binaryStr.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < binaryStr.length; i++) {
    view[i] = binaryStr.charCodeAt(i);
  }
  return buf;
}

async function loadIndex(language: 'en' | 'ja'): Promise<LoadedIndex | null> {
  if (_indices[language] !== undefined) return _indices[language]!;
  if (_loadPromises[language]) return _loadPromises[language]!;

  _loadPromises[language] = (async () => {
    try {
      const [indexBuf, idsBuf] = await Promise.all([
        readAssetBytes(INDEX_ASSETS[language].index),
        readAssetBytes(INDEX_ASSETS[language].ids),
      ]);

      // Parse header
      const dv = new DataView(indexBuf);
      const magic = dv.getUint32(0, true);
      if (magic !== INDEX_MAGIC) {
        console.error(`[VectorSearch] bad magic for ${language} index: ${magic}`);
        return null;
      }
      const version = dv.getUint32(4, true);
      const nCards  = dv.getUint32(8, true);
      const dim     = dv.getUint32(12, true);

      if (version !== INDEX_VERSION || dim !== EMBED_DIM) {
        console.error(`[VectorSearch] unsupported index version=${version} dim=${dim}`);
        return null;
      }

      const HEADER_BYTES = 16;
      const scales  = new Float32Array(indexBuf, HEADER_BYTES, nCards);
      const vectors = new Int8Array(indexBuf, HEADER_BYTES + nCards * 4, nCards * dim);
      const cardIds = new Int32Array(idsBuf);

      console.log(`[VectorSearch] loaded ${language} index: ${nCards} cards`);
      const idx: LoadedIndex = { nCards, scales, vectors, cardIds };
      _indices[language] = idx;
      return idx;
    } catch (e) {
      console.error(`[VectorSearch] failed to load ${language} index:`, e);
      _indices[language] = null;
      return null;
    }
  })();
  return _loadPromises[language]!;
}

// ---------------------------------------------------------------------------
// Brute-force search
// ---------------------------------------------------------------------------

export interface VectorSearchResult {
  cardId: number;
  sim: number;
}

/**
 * Search the on-device index for the top-K nearest neighbors.
 *
 * @param queryVec   512-dim L2-normalized Float32Array from clipEmbedder.ts
 * @param language   Which language index to search ('en' | 'ja')
 * @returns top-K results above SIM_FLOOR, sorted by descending similarity.
 *          Empty array if no results pass the floor threshold.
 */
export async function vectorSearch(
  queryVec: Float32Array,
  language: 'en' | 'ja',
): Promise<VectorSearchResult[]> {
  const idx = await loadIndex(language);
  if (!idx) {
    console.error('[VectorSearch] index not loaded');
    return [];
  }

  const { nCards, scales, vectors, cardIds } = idx;
  const scores = new Float32Array(nCards);

  // Brute-force dot product: query (float32) · dequantized int8 row
  // For each card i: sim ≈ dot(query, scale_i * int8_row_i)
  // Rewrite as: scale_i * dot(query, int8_row_i)
  // This avoids full dequantization — compute raw int8 dot, then multiply scale once.
  for (let i = 0; i < nCards; i++) {
    const base = i * EMBED_DIM;
    let dot = 0;
    for (let d = 0; d < EMBED_DIM; d++) {
      dot += queryVec[d] * vectors[base + d];
    }
    // Dequantize: scale_i * dot  (equivalent to dot(query, scale_i * int8_row))
    // Query is already L2-normalized; int8 row dequantizes to approximately L2-normalized.
    // Result is cosine similarity (both sides normalized).
    scores[i] = dot * scales[i];
  }

  // Partial sort: find top-K indices above SIM_FLOOR without full sort
  const candidates: VectorSearchResult[] = [];
  for (let i = 0; i < nCards; i++) {
    if (scores[i] >= SIM_FLOOR) {
      candidates.push({ cardId: cardIds[i], sim: scores[i] });
    }
  }

  if (candidates.length === 0) return [];

  // Sort descending and return top K
  candidates.sort((a, b) => b.sim - a.sim);
  return candidates.slice(0, TOP_K);
}

/**
 * Search both languages and return whichever has the higher top-1 similarity,
 * subject to the cross-language fallback margin used in scan.py (0.05 gap).
 * Used when language='auto'.
 */
export async function vectorSearchAuto(
  queryVec: Float32Array,
): Promise<{ results: VectorSearchResult[]; language: 'en' | 'ja' }> {
  const FALLBACK_MARGIN = 0.05; // mirrors scan.py _FALLBACK_MARGIN

  const [enResults, jaResults] = await Promise.all([
    vectorSearch(queryVec, 'en'),
    vectorSearch(queryVec, 'ja'),
  ]);

  const enTop = enResults[0]?.sim ?? 0;
  const jaTop = jaResults[0]?.sim ?? 0;

  if (jaTop > enTop + FALLBACK_MARGIN) {
    return { results: jaResults, language: 'ja' };
  }
  return { results: enResults, language: 'en' };
}

/**
 * Preload both language indices. Call at app startup so the first scan is instant.
 */
export async function preloadIndices(): Promise<void> {
  await Promise.all([loadIndex('en'), loadIndex('ja')]);
}
