import { loadTensorflowModel, type TfliteModel } from 'react-native-fast-tflite';
import { Platform } from 'react-native';
import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';
import { Asset } from 'expo-asset';
import * as jpegJs from 'jpeg-js';
import type { DetectBox } from '@/services/api';

export interface YoloDetectResult {
  boxes: DetectBox[];
  imageWidth: number;
  imageHeight: number;
}

const MODEL_SIZE = 640;
const CONF_THRESHOLD = 0.25;
const IOU_THRESHOLD = 0.45;
const MIN_AREA_FRAC = 0.01;
const ANCHORS = 8400;

let _model: TfliteModel | null = null;
let _modelPromise: Promise<TfliteModel | null> | null = null;
let _modelUri: string | null = null;

// Try delegates in preference order. On Android, NNAPI routes to whatever
// accelerator is available (Hexagon DSP / NPU / GPU) — on Snapdragon 8 Gen 1
// this means the Hexagon DSP, typically 2–4× faster than CPU for INT8 and
// comparable or faster than CPU for float16 YOLO. Falls back to CPU if NNAPI
// rejects the model (some ops may not be NNAPI-compatible).
const DELEGATE_PREFERENCE: Array<'core-ml' | 'nnapi' | 'default'> =
  Platform.OS === 'ios' ? ['core-ml', 'default'] : ['nnapi', 'default'];

async function getModel(): Promise<TfliteModel | null> {
  if (_model !== null) return _model;
  if (_modelPromise) return _modelPromise;
  _modelPromise = (async () => {
    // Pre-resolve the asset to a real local file path. In dev mode the Metro
    // URL has a malformed double-? query string the native loader can't handle;
    // downloading first gives us a clean file:// URI it can open directly.
    let localUri: string;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const asset = Asset.fromModule(require('../assets/models/card_detector.tflite'));
      await asset.downloadAsync();
      localUri = asset.localUri ?? asset.uri;
      console.log('[YOLO] loading model from:', localUri);
      _modelUri = localUri;
    } catch (e) {
      console.error('[YOLO] asset resolve failed:', e);
      _modelPromise = null;
      return null;
    }

    for (const delegate of DELEGATE_PREFERENCE) {
      try {
        const m = await loadTensorflowModel({ url: localUri }, delegate);
        console.log(`[YOLO] model loaded with delegate=${delegate}`);
        _model = m;
        return m;
      } catch (e) {
        console.warn(`[YOLO] delegate=${delegate} failed:`, e);
      }
    }
    console.error('[YOLO] all delegates failed; falling back to backend /detect');
    _modelPromise = null;
    return null;
  })();
  return _modelPromise;
}

export async function detectCardsWithYolo(
  imageUri: string,
  origW: number,
  origH: number,
): Promise<YoloDetectResult | null> {
  console.log('[YOLO] detectCardsWithYolo called');
  try {
    const model = await getModel();
    console.log('[YOLO] model loaded:', model !== null);
    if (!model) return null;

    // Resize to MODEL_SIZE×MODEL_SIZE (stretched — both scales tracked for un-projection).
    const resized = await ImageManipulator.manipulateAsync(
      imageUri,
      [{ resize: { width: MODEL_SIZE, height: MODEL_SIZE } }],
      { compress: 0.92, format: ImageManipulator.SaveFormat.JPEG },
    );

    // base64 → Uint8Array → JPEG decode → RGBA pixels
    const b64 = await FileSystem.readAsStringAsync(resized.uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    const binaryStr = atob(b64);
    const jpegBytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      jpegBytes[i] = binaryStr.charCodeAt(i);
    }
    const { data: rgbaData } = jpegJs.decode(jpegBytes, { useTArray: true });

    // Build float32 RGB input [1, MODEL_SIZE, MODEL_SIZE, 3] normalized 0–1 (NHWC).
    const input = new Float32Array(MODEL_SIZE * MODEL_SIZE * 3);
    for (let i = 0; i < MODEL_SIZE * MODEL_SIZE; i++) {
      input[i * 3 + 0] = rgbaData[i * 4 + 0] / 255.0;
      input[i * 3 + 1] = rgbaData[i * 4 + 1] / 255.0;
      input[i * 3 + 2] = rgbaData[i * 4 + 2] / 255.0;
    }

    // v2 API: pass TypedArray[] directly (not [arrayBuffer]).
    // v3 had auto-unwrap of ArrayBuffer; v2 doesn't and throws "no ArrayBuffer attached".
    let outputs: ArrayBufferView[];
    // Track which model instance actually produced the output for correct shape detection.
    let activeModel = model;
    try {
      outputs = await model.run([input]);
    } catch (runErr) {
      // NNAPI can throw "Value is undefined, expected an Object" when the cached native
      // model handle goes stale (fast refresh, app backgrounding, GC of native side).
      // Reset cache and retry — if NNAPI is fully gone, force CPU delegate as last resort.
      console.warn('[YOLO] run failed, resetting model cache and retrying:', runErr);
      _model = null;
      _modelPromise = null;
      let fresh = await getModel();
      if (!fresh) return null;
      try {
        outputs = await fresh.run([input]);
        activeModel = fresh;
      } catch (retryErr) {
        // NNAPI fully invalidated — force CPU delegate as last resort
        console.warn('[YOLO] retry failed, forcing CPU delegate:', retryErr);
        _model = null;
        _modelPromise = null;
        if (!_modelUri) return null;
        try {
          const cpu = await loadTensorflowModel({ url: _modelUri }, 'default');
          _model = cpu;
          outputs = await cpu.run([input]);
          activeModel = cpu;
        } catch {
          return null;
        }
      }
    }
    const output = outputs[0] instanceof Float32Array ? outputs[0] : new Float32Array(outputs[0]!);

    // Ultralytics TFLite exports in either [1,5,8400] or [1,8400,5] layout.
    // Detect layout from the output tensor shape.
    const outShape = activeModel.outputs[0]?.shape ?? [];
    const transposed = outShape.length >= 3 && outShape[1] === ANCHORS; // [1,8400,5]

    // Diagnostic: log output shape and max confidence to verify layout and model output.
    let maxConf = 0;
    let maxConfIdx = 0;
    for (let j = 0; j < ANCHORS; j++) {
      const conf = transposed ? output[j * 5 + 4] : output[4 * ANCHORS + j];
      if (conf > maxConf) { maxConf = conf; maxConfIdx = j; }
    }
    console.log(`[YOLO] outShape=${JSON.stringify(outShape)} transposed=${transposed} maxConf=${maxConf.toFixed(4)} at j=${maxConfIdx} outputLen=${output.length}`);

    type Det = { x1: number; y1: number; x2: number; y2: number; conf: number };
    const detections: Det[] = [];

    for (let j = 0; j < ANCHORS; j++) {
      const conf = transposed ? output[j * 5 + 4] : output[4 * ANCHORS + j];
      if (conf < CONF_THRESHOLD) continue;
      const cx = transposed ? output[j * 5 + 0] : output[0 * ANCHORS + j];
      const cy = transposed ? output[j * 5 + 1] : output[1 * ANCHORS + j];
      const w  = transposed ? output[j * 5 + 2] : output[2 * ANCHORS + j];
      const h  = transposed ? output[j * 5 + 3] : output[3 * ANCHORS + j];
      detections.push({ x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2, conf });
    }

    // Greedy NMS
    detections.sort((a, b) => b.conf - a.conf);
    const kept: Det[] = [];
    for (const det of detections) {
      if (kept.every((k) => iou(det, k) <= IOU_THRESHOLD)) {
        kept.push(det);
      }
    }

    // Un-project (stretched 640×640 → original image coords), filter small boxes, sort.
    const scaleX = origW / MODEL_SIZE;
    const scaleY = origH / MODEL_SIZE;
    const minArea = MIN_AREA_FRAC * origW * origH;
    const rowH = Math.max(1, Math.round(origH * 0.25));

    const boxes: DetectBox[] = kept
      .map((d) => ({
        left:   Math.max(0, Math.round(d.x1 * scaleX)),
        top:    Math.max(0, Math.round(d.y1 * scaleY)),
        width:  Math.min(origW, Math.round((d.x2 - d.x1) * scaleX)),
        height: Math.min(origH, Math.round((d.y2 - d.y1) * scaleY)),
      }))
      .filter((b) => b.width * b.height >= minArea)
      .sort((a, b) => {
        const rowDiff = Math.floor(a.top / rowH) - Math.floor(b.top / rowH);
        return rowDiff !== 0 ? rowDiff : a.left - b.left;
      });

    return { boxes, imageWidth: origW, imageHeight: origH };
  } catch (e) {
    console.error('[YOLO] detectCardsWithYolo failed:', e);
    return null;
  }
}

function iou(
  a: { x1: number; y1: number; x2: number; y2: number },
  b: { x1: number; y1: number; x2: number; y2: number },
): number {
  const ix1 = Math.max(a.x1, b.x1);
  const iy1 = Math.max(a.y1, b.y1);
  const ix2 = Math.min(a.x2, b.x2);
  const iy2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
  if (inter === 0) return 0;
  const areaA = (a.x2 - a.x1) * (a.y2 - a.y1);
  const areaB = (b.x2 - b.x1) * (b.y2 - b.y1);
  return inter / (areaA + areaB - inter);
}
