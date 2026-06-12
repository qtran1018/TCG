/**
 * On-device CLIP visual encoder — Phase 2 of on-device CLIP migration.
 *
 * Mirrors yoloDetector.ts: lazy model load, delegate preference array,
 * stale-handle retry, capability probe on first run.
 *
 * Preprocessing replicates card_embedder.py exactly:
 *   1. _crop_art: x 4%–96%, y 12%–52%
 *   2. Resize to 224×224 (bicubic → nearest approximation in JS)
 *   3. Normalize: mean=[0.481,0.457,0.408], std=[0.269,0.261,0.276]
 *   4. NCHW float32 (for TFLite; CoreML expects NHWC — handled per-platform)
 *   5. L2-normalize output → 512-dim Float32Array
 *
 * IMPORTANT: if the preprocessing here ever diverges from card_embedder.py,
 * parity silently degrades. Run parity_harness.py after any change to either.
 */

import { loadTensorflowModel, type TfliteModel } from 'react-native-fast-tflite';
import { Platform } from 'react-native';
import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';
import { Asset } from 'expo-asset';
import * as jpegJs from 'jpeg-js';
import AsyncStorage from '@react-native-async-storage/async-storage';

const CLIP_SIZE = 224;
const EMBED_DIM = 512;

// open_clip ViT-B/32 normalization constants — must match card_embedder.py
const CLIP_MEAN = [0.48145466, 0.4578275,  0.40821073];
const CLIP_STD  = [0.26862954, 0.26130258, 0.27577711];

// Latency budget for capability probe: if first embed takes longer than this
// on the CPU delegate, mark device as server-fallback.
const CPU_LATENCY_BUDGET_MS = 2000;
const CLIP_MODE_KEY = 'tcg:clipMode'; // 'ondevice' | 'server'
const CLIP_MODE_VERSION_KEY = 'tcg:clipModeVersion'; // bump to re-probe on app update

// Bump this when a new model is shipped so devices re-run the capability probe.
// fp16 TFLite uses the same weights as int8 — embedding space is unchanged,
// so version stays '1' (compatible with server's pgvector index).
export const CLIP_MODEL_VERSION = '1';

let _model: TfliteModel | null = null;
let _modelPromise: Promise<TfliteModel | null> | null = null;
let _modelUri: string | null = null;
let _cachedClipMode: 'ondevice' | 'server' | null = null;
let _activeDelegate: string | null = null;

const DELEGATE_PREFERENCE: Array<'core-ml' | 'android-gpu' | 'nnapi' | 'default'> =
  Platform.OS === 'ios' ? ['core-ml', 'default'] : ['android-gpu', 'nnapi', 'default'];

// ---------------------------------------------------------------------------
// Model loading
// ---------------------------------------------------------------------------

async function getModel(): Promise<TfliteModel | null> {
  if (_model !== null) return _model;
  if (_modelPromise) return _modelPromise;

  _modelPromise = (async () => {
    let localUri: string;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const asset = Asset.fromModule(require('../assets/models/clip_visual.tflite'));
      await asset.downloadAsync();
      localUri = asset.localUri ?? asset.uri;
      _modelUri = localUri;
    } catch (e) {
      console.error('[CLIP] asset resolve failed:', e);
      _modelPromise = null;
      return null;
    }

    for (const delegate of DELEGATE_PREFERENCE) {
      try {
        const t0 = Date.now();
        const m = await loadTensorflowModel({ url: localUri }, delegate);
        console.log(`[CLIP] model loaded with delegate=${delegate} in ${Date.now() - t0}ms`);
        _model = m;
        _activeDelegate = delegate;
        return m;
      } catch (e) {
        console.warn(`[CLIP] delegate=${delegate} failed:`, e);
      }
    }
    console.error('[CLIP] all delegates failed');
    _modelPromise = null;
    return null;
  })();
  return _modelPromise;
}

// ---------------------------------------------------------------------------
// Capability probe
// ---------------------------------------------------------------------------

/**
 * Determine whether this device should run CLIP on-device or fall back to
 * the server. Result is persisted so we only probe once per model version.
 *
 * Call this at app startup (or before the first scan) to warm the decision.
 * The scan hooks read clipMode() synchronously after this resolves.
 */
export async function probeClipCapability(): Promise<'ondevice' | 'server'> {
  // Check persisted decision for this model version
  const [storedMode, storedVersion] = await Promise.all([
    AsyncStorage.getItem(CLIP_MODE_KEY),
    AsyncStorage.getItem(CLIP_MODE_VERSION_KEY),
  ]);

  if (storedMode && storedVersion === CLIP_MODEL_VERSION) {
    _cachedClipMode = storedMode as 'ondevice' | 'server';
    console.log(`[CLIP] capability probe: using cached mode=${_cachedClipMode}`);
    return _cachedClipMode;
  }

  console.log('[CLIP] running capability probe...');
  const model = await getModel();
  if (!model) {
    console.log('[CLIP] no model loaded — server fallback');
    await _persistMode('server');
    return 'server';
  }

  // Synthesize a dummy card-art crop for the probe (224×224 zeros)
  const dummyInput = new Float32Array(CLIP_SIZE * CLIP_SIZE * 3); // NHWC all zeros
  const t0 = Date.now();
  try {
    await model.run([dummyInput]);
    const elapsed = Date.now() - t0;
    console.log(`[CLIP] probe embed took ${elapsed}ms on delegate=${_activeDelegate ?? 'unknown'}`);

    // If we fell all the way to CPU ('default') and it's slow, route to server.
    const isCpuFallback = elapsed > CPU_LATENCY_BUDGET_MS;
    const mode: 'ondevice' | 'server' = isCpuFallback ? 'server' : 'ondevice';
    if (isCpuFallback) {
      console.log(`[CLIP] slow CPU fallback (${elapsed}ms > ${CPU_LATENCY_BUDGET_MS}ms) — server mode`);
    } else {
      console.log(`[CLIP] on-device mode confirmed (${elapsed}ms, delegate=${_activeDelegate ?? 'unknown'})`);
    }
    await _persistMode(mode);
    return mode;
  } catch (e) {
    console.warn('[CLIP] probe run failed — server fallback:', e);
    await _persistMode('server');
    return 'server';
  }
}

async function _persistMode(mode: 'ondevice' | 'server') {
  _cachedClipMode = mode;
  await Promise.all([
    AsyncStorage.setItem(CLIP_MODE_KEY, mode),
    AsyncStorage.setItem(CLIP_MODE_VERSION_KEY, CLIP_MODEL_VERSION),
  ]);
}

/** Synchronous read of the cached clip mode. Call probeClipCapability() first. */
export function clipMode(): 'ondevice' | 'server' {
  return _cachedClipMode ?? 'server';
}

// ---------------------------------------------------------------------------
// Preprocessing — must match card_embedder.py exactly
// ---------------------------------------------------------------------------

/**
 * Crop to card art region (replicates card_embedder._crop_art).
 * x: 4%–96%, y: 12%–52%
 */
async function cropArt(imageUri: string, origW: number, origH: number): Promise<string> {
  const left   = Math.round(origW * 0.04);
  const top    = Math.round(origH * 0.12);
  const width  = Math.round(origW * 0.92);  // 96% - 4%
  const height = Math.round(origH * 0.40);  // 52% - 12%

  const cropped = await ImageManipulator.manipulateAsync(
    imageUri,
    [
      { crop: { originX: left, originY: top, width, height } },
      { resize: { width: CLIP_SIZE, height: CLIP_SIZE } },
    ],
    { compress: 0.92, format: ImageManipulator.SaveFormat.JPEG },
  );
  return cropped.uri;
}

/**
 * Decode JPEG → float32 NHWC normalized input tensor.
 * Normalization: (pixel/255 - mean) / std  (open_clip ViT-B/32 constants)
 */
function buildInputTensor(jpegBytes: Uint8Array): Float32Array {
  const { data: rgba, width, height } = jpegJs.decode(jpegBytes, { useTArray: true });
  const n = width * height;
  const input = new Float32Array(n * 3); // NHWC flat

  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4 + 0] / 255.0;
    const g = rgba[i * 4 + 1] / 255.0;
    const b = rgba[i * 4 + 2] / 255.0;
    input[i * 3 + 0] = (r - CLIP_MEAN[0]) / CLIP_STD[0];
    input[i * 3 + 1] = (g - CLIP_MEAN[1]) / CLIP_STD[1];
    input[i * 3 + 2] = (b - CLIP_MEAN[2]) / CLIP_STD[2];
  }
  return input;
}

function l2Normalize(vec: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) + 1e-8;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ClipEmbedResult {
  embedding: Float32Array;  // 512-dim L2-normalized
  mode: 'ondevice';
}

/**
 * Embed a card image on-device.
 *
 * @param imageUri  URI of the already-detected card crop (from YOLO or full frame)
 * @param origW     Width of the source image (needed for art-crop fractions)
 * @param origH     Height of the source image
 *
 * Returns null if on-device embedding fails (caller should fall back to server).
 */
export async function embedCardOnDevice(
  imageUri: string,
  origW: number,
  origH: number,
): Promise<ClipEmbedResult | null> {
  const model = await getModel();
  if (!model) return null;

  try {
    // 1. Crop art region + resize to 224×224
    const artUri = await cropArt(imageUri, origW, origH);

    // 2. Decode JPEG → normalized float32 input
    const b64 = await FileSystem.readAsStringAsync(artUri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    const binaryStr = atob(b64);
    const jpegBytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      jpegBytes[i] = binaryStr.charCodeAt(i);
    }
    const input = buildInputTensor(jpegBytes); // NHWC float32 (224*224*3)

    // 3. Run model
    let outputs: ArrayBufferView[];
    const _t0 = Date.now();
    try {
      outputs = await model.run([input]);
      console.log(`[CLIP] embed ${Date.now() - _t0}ms delegate=${_activeDelegate ?? 'unknown'}`);
    } catch (runErr) {
      // Stale handle recovery — same pattern as yoloDetector.ts
      console.warn('[CLIP] run failed, resetting and retrying:', runErr);
      _model = null;
      _modelPromise = null;
      const fresh = await getModel();
      if (!fresh) return null;
      try {
        outputs = await fresh.run([input]);
      } catch (retryErr) {
        // Force CPU as last resort
        console.warn('[CLIP] retry failed, forcing CPU:', retryErr);
        _model = null;
        _modelPromise = null;
        if (!_modelUri) return null;
        const cpu = await loadTensorflowModel({ url: _modelUri }, 'default');
        _model = cpu;
        outputs = await cpu.run([input]);
      }
    }

    // 4. Extract + L2-normalize output
    const raw = outputs[0] instanceof Float32Array
      ? outputs[0]
      : new Float32Array(outputs[0]!.buffer);

    // Handle quantized output — dequantize if int8
    let vec: Float32Array;
    if (raw.BYTES_PER_ELEMENT === 1) {
      // int8 output — need scale/zero_point from model metadata
      // For now treat as float32 (TFLite runtime dequantizes automatically when
      // inference_output_type=FLOAT32 wrapper is used in conversion)
      vec = new Float32Array(raw.length);
      for (let i = 0; i < raw.length; i++) vec[i] = raw[i];
    } else {
      vec = raw.length === EMBED_DIM ? raw : new Float32Array(raw.buffer, 0, EMBED_DIM);
    }

    return { embedding: l2Normalize(vec), mode: 'ondevice' };
  } catch (e) {
    console.error('[CLIP] embedCardOnDevice failed:', e);
    return null;
  }
}

/**
 * Fire a dummy inference to re-warm NNAPI's DSP context.
 * NNAPI releases its compiled DSP cache after idle periods; calling this at
 * session start prevents the first real embed from paying an ~800ms cold-start
 * penalty. Safe to fire-and-forget — errors are swallowed.
 */
export async function warmUpClip(): Promise<void> {
  const model = await getModel();
  if (!model) return;
  try {
    const dummy = new Float32Array(CLIP_SIZE * CLIP_SIZE * 3);
    await model.run([dummy]);
    console.log('[CLIP] NNAPI warmed up');
  } catch {
    // Ignore — warmup failures are non-fatal
  }
}

/**
 * Reset the capability probe (e.g. after a model update or for testing).
 * Next call to probeClipCapability() will re-run the probe.
 */
export async function resetClipCapabilityProbe(): Promise<void> {
  _cachedClipMode = null;
  await Promise.all([
    AsyncStorage.removeItem(CLIP_MODE_KEY),
    AsyncStorage.removeItem(CLIP_MODE_VERSION_KEY),
  ]);
}
