// Phase 4a note: multi-scan uses the server image upload path unchanged.
// The hybrid CLIP path (on-device embed → POST 512-d vector) is wired for live
// scan only (useLiveScan.ts). Multi-scan Phase 4b: embed each crop on-device
// and call api.scanVector per crop, bypassing server-side CLIP entirely.
// Deferred because multi-scan already avoids server YOLO (sends explicit boxes),
// so the GPU-offload gain per crop is CLIP-only. Live scan benefits more.
import { useState, useCallback, useEffect, useRef } from "react";
import TextRecognition, { TextRecognitionScript } from "@react-native-ml-kit/text-recognition";
import * as ImageManipulator from "expo-image-manipulator";
import * as FileSystem from "expo-file-system/legacy";
import { api } from "@/services/api";
import { clipMode, embedCardOnDevice, CLIP_MODEL_VERSION } from "@/utils/clipEmbedder";
import { detectCardRegions, boxesToRegions } from "@/utils/detectCards";
import { detectCardsWithYolo } from "@/utils/yoloDetector";
import { assessCardConfidence } from "@/utils/cardConfidence";
import { useScanStore } from "@/store/scanStore";
import type { Game } from "@/constants";
import type { ScanOcrHint, ScanStreamResult } from "@/services/api";
import type { CardRegion } from "@/utils/detectCards";
import type { DetectedCard, ScanTiming } from "@/types/scan";

export type ScanMode = "ocr" | "image" | "combined";

const TIMING_LOG = `${FileSystem.documentDirectory}scan_timing_log.json`;

async function _appendTimingLog(timing: ScanTiming): Promise<void> {
  let entries: unknown[] = [];
  try {
    const existing = await FileSystem.readAsStringAsync(TIMING_LOG);
    entries = JSON.parse(existing);
  } catch {
    // File doesn't exist yet — start fresh
  }
  entries.push({ ...timing, ts: new Date().toISOString() });
  await FileSystem.writeAsStringAsync(TIMING_LOG, JSON.stringify(entries, null, 2));
}

// Re-export so existing imports still compile
export type { DetectedCard } from "@/types/scan";
export type { MultiScanResult } from "@/types/scan";

interface UseMultiCardScanReturn {
  scan: (imageUri: string, game: Game, scanMode?: ScanMode, enableTiming?: boolean) => Promise<boolean>;
  isProcessing: boolean;
  progress: string;
  error: string | null;
}

// Applied to the name-region sub-crop (top 18%), which contains only card name + HP —
// virtually no EN text produces 2+ consecutive kana there. {2,} catches short JP names
// like シシコ (Litleo) that OCR may return as 2 kana after a stroke misread.
const KANA_RE = /[゠-ヿぁ-ゖ]{2,}/;
function detectCropLanguage(text: string): "en" | "ja" {
  return KANA_RE.test(text) ? "ja" : "en";
}

const NUMBER_RE = /\d+\/\d+/;

// Extract card number text from bottom-8% corners of the full-image OCR blocks.
// Left corner covers most sets; right corner covers sets that print number on the right.
// Returns whichever corner contains a N/total pattern, or falls back to any content found.
function getNumberBlocksText(
  allBlocks: Array<{ text: string; frame: any }>,
  cropX: number, cropY: number, cropW: number, cropH: number,
): string {
  const numTop = cropY + cropH * 0.92;
  const numBottom = cropY + cropH;
  const leftBlocks = allBlocks.filter((b) => {
    if (!b.frame) return false;
    const cy = b.frame.top + (b.frame.height ?? 0) / 2;
    const cx = b.frame.left + (b.frame.width ?? 0) / 2;
    return cy >= numTop && cy <= numBottom && cx >= cropX && cx <= cropX + cropW * 0.35;
  });
  const rightBlocks = allBlocks.filter((b) => {
    if (!b.frame) return false;
    const cy = b.frame.top + (b.frame.height ?? 0) / 2;
    const cx = b.frame.left + (b.frame.width ?? 0) / 2;
    return cy >= numTop && cy <= numBottom && cx >= cropX + cropW * 0.65 && cx <= cropX + cropW;
  });
  const leftText = leftBlocks.map((b) => b.text).join(" ");
  const rightText = rightBlocks.map((b) => b.text).join(" ");
  if (NUMBER_RE.test(leftText)) return leftText;
  if (NUMBER_RE.test(rightText)) return rightText;
  return leftText || rightText;
}

function augmentWithNumberRegion(
  cropText: string,
  allBlocks: Array<{ text: string; frame: any }>,
  cropX: number, cropY: number, cropW: number, cropH: number,
): string {
  const numberText = getNumberBlocksText(allBlocks, cropX, cropY, cropW, cropH);
  return numberText && /\d/.test(numberText) ? `${cropText}\n${numberText}` : cropText;
}

// Spatial filter for the name region (top 18% of crop, 5–95% width). Reads from the
// already-computed full-image OCR blocks instead of running a fresh ML Kit pass on the
// sub-crop. Saves one ML Kit call per crop — at 12 cards this is ~3s on a Samsung S22+.
// Same pixel density as the previous sub-crop approach (full image is 2400px PNG;
// crops are sliced from that image at full resolution).
function getNameRegionText(
  allBlocks: Array<{ text: string; frame: any }>,
  cropX: number, cropY: number, cropW: number, cropH: number,
): string {
  const nameTop = cropY;
  const nameBottom = cropY + cropH * 0.18;
  const nameLeft = cropX + cropW * 0.05;
  const nameRight = cropX + cropW * 0.95;
  const blocks = allBlocks.filter((b) => {
    if (!b.frame) return false;
    const cy = b.frame.top + (b.frame.height ?? 0) / 2;
    const cx = b.frame.left + (b.frame.width ?? 0) / 2;
    return cy >= nameTop && cy <= nameBottom && cx >= nameLeft && cx <= nameRight;
  });
  return blocks
    .sort((a, b) => (a.frame?.top ?? 0) - (b.frame?.top ?? 0))
    .map((b) => b.text)
    .join("\n");
}

// Spatial filter for the entire crop region. Returns text + block count so the
// confidence check (which uses block count for the OCR-clustering fallback path)
// still works without re-OCRing the crop.
function getCropRegionTextAndCount(
  allBlocks: Array<{ text: string; frame: any }>,
  cropX: number, cropY: number, cropW: number, cropH: number,
): { text: string; blockCount: number } {
  const blocks = allBlocks.filter((b) => {
    if (!b.frame) return false;
    const cy = b.frame.top + (b.frame.height ?? 0) / 2;
    const cx = b.frame.left + (b.frame.width ?? 0) / 2;
    return cy >= cropY && cy <= cropY + cropH && cx >= cropX && cx <= cropX + cropW;
  });
  const text = blocks
    .sort((a, b) => (a.frame?.top ?? 0) - (b.frame?.top ?? 0))
    .map((b) => b.text)
    .join("\n");
  return { text, blockCount: blocks.length };
}

// Dedicated bottom-strip OCR for card number extraction. The full-image OCR pass
// (allBlocks) does not reliably detect the small N/NNN text at the bottom of cards —
// at 2400px scale those blocks are ~20px tall, below ML Kit's detection threshold.
// This runs a focused crop (bottom 18%, full width) per card through ML Kit LATIN,
// which is faster and more accurate for digit recognition than JAPANESE mode.
// All crops run in Promise.all — typical total: ~100–150ms for 12 cards.
// Returns undefined per card when the number can't be read (distant/blurry card).
async function extractCardNumbers(
  cropData: Array<{ cropX: number; cropY: number; cropW: number; cropH: number }>,
  imageUri: string,
): Promise<(string | undefined)[]> {
  return Promise.all(
    cropData.map(async ({ cropX, cropY, cropW, cropH }) => {
      // Bottom 18% — generous enough for distant cards and YOLO box imprecision,
      // tight enough to avoid HP/damage numbers in the card body.
      const stripTop = Math.round(cropY + cropH * 0.82);
      const stripH = Math.max(1, Math.round(cropH * 0.18));
      // Minimum dimensions for meaningful OCR — skip if card is too small in frame.
      if (stripH < 10 || cropW < 20) return undefined;
      try {
        const strip = await ImageManipulator.manipulateAsync(
          imageUri,
          [{ crop: { originX: Math.round(cropX), originY: stripTop, width: Math.round(cropW), height: stripH } }],
          { format: ImageManipulator.SaveFormat.JPEG, compress: 0.9 },
        );
        const result = await TextRecognition.recognize(strip.uri, TextRecognitionScript.LATIN);
        const text = result.blocks.map((b) => b.text).join(" ");
        const match = text.match(/\d+\/\d+/);
        return match ? match[0] : undefined;
      } catch {
        return undefined;
      }
    }),
  );
}

export function useMultiCardScan(): UseMultiCardScanReturn {
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const {
    clearMultiScan,
    setMultiScanLoading,
    setMultiScanError,
    appendMultiScanCard,
    setScanTiming,
  } = useScanStore();

  // Abort any in-flight scan stream when the hook unmounts (e.g. user navigates away).
  useEffect(() => () => abortRef.current?.abort(), []);

  const scan = useCallback(
    async (imageUri: string, game: Game, scanMode: ScanMode = "ocr", enableTiming = false): Promise<boolean> => {
      setIsProcessing(true);
      setError(null);

      const t0 = enableTiming ? Date.now() : 0;
      let t1 = 0, t2 = 0, t3 = 0;
      let tResize = 0, tOcr = 0, tYolo = 0;

      try {
        // 1. Resize image to 2400px wide. JPEG quality 0.95 instead of lossless PNG —
        //    PNG encode of a multi-megapixel image takes ~3000ms on a phone; JPEG ~500ms.
        //    Quality 0.95 is visually lossless and OCR accuracy is unchanged in testing.
        setProgress("Processing image...");
        const resizeStart = Date.now();
        const resized = await ImageManipulator.manipulateAsync(
          imageUri,
          [{ resize: { width: 2400 } }],
          { compress: 0.95, format: ImageManipulator.SaveFormat.JPEG },
        );
        if (enableTiming) tResize = Date.now() - resizeStart;

        // 2. Run YOLO first (fast: ~100–200ms on NNAPI/Hexagon after warmup),
        //    then OCR. Earlier attempt to parallelize via Promise.all caused NNAPI
        //    inference to fail with "Value is undefined, expected an Object" — likely
        //    a resource conflict between ML Kit and NNAPI native bindings. Sequential
        //    is stable. The YOLO time is small enough that parallelizing doesn't help much.
        const yoloStart = Date.now();
        const yoloResult = await detectCardsWithYolo(resized.uri, resized.width, resized.height);
        if (enableTiming) tYolo = Date.now() - yoloStart;

        setProgress("Scanning for cards...");
        const ocrStart = Date.now();
        const fullResult = await TextRecognition.recognize(resized.uri, TextRecognitionScript.JAPANESE);
        if (enableTiming) tOcr = Date.now() - ocrStart;

        const allBlocks = fullResult.blocks
          .sort((a, b) => (a.frame?.top ?? 0) - (b.frame?.top ?? 0))
          .map((b) => ({ text: b.text, frame: b.frame as any }));

        // 3. Pick detection result — on-device YOLO first, then backend /detect, then OCR clustering
        let regions: CardRegion[];
        let regionsFromYolo = false;

        if (yoloResult && yoloResult.boxes.length > 0) {
          regions = boxesToRegions(yoloResult.boxes);
          regionsFromYolo = true;
          setProgress(`Found ${regions.length} card${regions.length !== 1 ? "s" : ""}...`);
        } else if (!yoloResult) {
          // YOLO model absent or failed — fall back to backend /detect
          try {
            const base64 = await FileSystem.readAsStringAsync(resized.uri, {
              encoding: FileSystem.EncodingType.Base64,
            });
            const detected = await api.detectCards(base64, 20);
            if (detected.boxes.length > 0) {
              regions = boxesToRegions(detected.boxes);
              regionsFromYolo = true;  // backend /detect also runs YOLO — same trust level as on-device
              setProgress(`Found ${regions.length} card outline${regions.length !== 1 ? "s" : ""}...`);
            } else {
              regions = detectCardRegions(allBlocks, resized.width, resized.height);
            }
          } catch {
            regions = detectCardRegions(allBlocks, resized.width, resized.height);
          }
        } else {
          // YOLO loaded but returned 0 boxes — fall back to OCR clustering
          regions = detectCardRegions(allBlocks, resized.width, resized.height);
        }

        if (enableTiming) t1 = Date.now();
        console.log(`[MultiScan] detection: fromYolo=${regionsFromYolo} regions=${regions.length} | resize=${tResize}ms ocr=${tOcr}ms yolo=${tYolo}ms`);

        if (regions.length === 0) {
          const msg = "No cards detected. Try better lighting or move closer.";
          setMultiScanError(msg);
          setError(msg);
          return false;
        }

        // 4. Compute crop box coordinates (server crops on-demand — no per-crop
        //    ImageManipulator.manipulateAsync, no per-crop JPEG re-encode, no per-crop
        //    base64 read). The full image is re-encoded as JPEG once and sent with the
        //    boxes; backend slices with PIL (~5ms/crop). Saves ~500ms–1s on 12 cards.
        setProgress(`Found ${regions.length} region${regions.length !== 1 ? "s" : ""}, reading each...`);
        const regionCount = Math.min(regions.length, 20);
        const cropData: Array<{
          regionIndex: number;
          cropX: number; cropY: number; cropW: number; cropH: number;
        }> = [];

        for (let i = 0; i < regionCount; i++) {
          const { boundingBox: bb } = regions[i];
          const margin = Math.round(Math.min(bb.width, bb.height) * 0.10);
          const cropX = Math.max(0, bb.left - margin);
          const cropY = Math.max(0, bb.top - margin);
          const cropW = Math.min(resized.width - cropX, bb.width + margin * 2);
          const cropH = Math.min(resized.height - cropY, bb.height + margin * 2);
          cropData.push({ regionIndex: i, cropX, cropY, cropW, cropH });
        }

        // 5. Build OCR hints + box coords for the combined /scan endpoint.
        //    All OCR comes from spatial filtering of allBlocks — zero per-crop ML Kit calls.
        setProgress(`Identifying ${cropData.length} card${cropData.length !== 1 ? "s" : ""}...`);

        // `resized.uri` is already JPEG 0.95 from step 1 — skip the re-encode entirely
        // and base64 it directly. Both promises kick off concurrently with the
        // synchronous cropResults assembly below.
        const fullImagePromise: Promise<string> = FileSystem.readAsStringAsync(resized.uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        // Dedicated bottom-strip OCR for each card. Full-image allBlocks doesn't
        // reliably pick up the small N/NNN text — this targets just the bottom 18%
        // with ML Kit LATIN for better digit recall. Runs in parallel so it adds
        // ~100–150ms total rather than blocking the stream start.
        const numberStripPromise = extractCardNumbers(cropData, resized.uri);

        const cropResults = cropData.map(({ cropX, cropY, cropW, cropH }) => {
          let rawText: string | undefined;
          let cropLang: "en" | "ja" = "en";
          try {
            const nameText = getNameRegionText(allBlocks, cropX, cropY, cropW, cropH);
            cropLang = detectCropLanguage(nameText);

            if (regionsFromYolo) {
              if (scanMode !== "image") {
                const numberText = getNumberBlocksText(allBlocks, cropX, cropY, cropW, cropH);
                rawText = numberText && /\d/.test(numberText)
                  ? `${nameText}\n${numberText}`
                  : nameText || undefined;
              }
            } else {
              const { text: fullCropText, blockCount } = getCropRegionTextAndCount(
                allBlocks, cropX, cropY, cropW, cropH,
              );
              if (scanMode !== "image") {
                const confidence = assessCardConfidence(fullCropText, blockCount, game, cropLang);
                if (confidence.isCard) {
                  const numberText = getNumberBlocksText(allBlocks, cropX, cropY, cropW, cropH);
                  rawText = numberText && /\d/.test(numberText)
                    ? `${nameText}\n${numberText}`
                    : nameText || augmentWithNumberRegion(fullCropText, allBlocks, cropX, cropY, cropW, cropH);
                }
              }
            }
          } catch (e) {
            console.warn("[MultiScan] crop OCR failed:", e);
          }
          return { rawText, cropLang };
        });

        const [fullImageB64, cardNumbers] = await Promise.all([fullImagePromise, numberStripPromise]);

        if (enableTiming) t2 = Date.now();

        const boxes = cropData.map(({ cropX, cropY, cropW, cropH }) => ({
          left: cropX, top: cropY, width: cropW, height: cropH,
        }));
        const ocrHints: ScanOcrHint[] = cropResults.map((r, i) => {
          const extracted = cardNumbers[i]; // "84/165" or undefined
          let rawText = r.rawText;
          if (extracted) {
            if (rawText && !NUMBER_RE.test(rawText)) {
              // Append number — name region text rarely includes it (small bottom text).
              rawText = `${rawText}\n${extracted}`;
            } else if (!rawText) {
              // Image mode or unidentified crop: send just the number so the backend
              // can still re-rank image AI candidates by set.
              rawText = extracted;
            }
            // If rawText already contains N/NNN (rare allBlocks hit), keep as-is.
          }
          return { raw_text: rawText, language: r.cropLang, game };
        });

        // 6. Signal the store that streaming is starting
        setMultiScanLoading(true, regions.length);

        // 7. Stream results — hybrid on-device CLIP path first, server fallback
        const seenIds = new Set<number>();
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;

        // Shared result handler used by both on-device and server paths.
        const handleResult = (item: ScanStreamResult, cropIndex: number) => {
          if (item.candidates.length === 0) return;
          const topId = item.candidates[0].id;
          if (seenIds.has(topId)) return;
          seenIds.add(topId);
          if (enableTiming && t3 === 0) t3 = Date.now();

          const hint = ocrHints[cropIndex];
          const rawText = hint?.raw_text ?? "";
          let kanaName: string | undefined;
          let setTotal: number | undefined;
          let cardNumber: string | undefined;
          const cropLang = hint?.language ?? "en";
          if (cropLang === "ja" && rawText) {
            const kanaMatch = rawText.match(/[゠-ヿー]+/g);
            if (kanaMatch) kanaName = kanaMatch.reduce((a, b) => (a.length >= b.length ? a : b), "");
            const numMatch = rawText.match(/(\d+)\/(\d+)/);
            if (numMatch) { cardNumber = numMatch[1]; setTotal = parseInt(numMatch[2], 10); }
          }
          appendMultiScanCard({
            regionIndex: cropData[cropIndex]?.regionIndex ?? cropIndex,
            ocrText: rawText,
            searchResult: { candidates: item.candidates, query_used: item.query_used },
            matchSource: (item.match_source === "none" || !item.match_source) ? undefined : item.match_source,
            kanaName, setTotal, cardNumber,
          });
        };

        let hybridSucceeded = false;
        if (clipMode() === 'ondevice') {
          try {
            // Embed each crop on-device sequentially (TFLite can't run concurrent inferences).
            // Fire scanVector calls in parallel as embeddings complete.
            const vectorTasks: Promise<void>[] = [];
            for (let i = 0; i < cropData.length; i++) {
              const { cropX, cropY, cropW, cropH } = cropData[i];
              const cropManip = await ImageManipulator.manipulateAsync(
                resized.uri,
                [{ crop: { originX: cropX, originY: cropY, width: cropW, height: cropH } }],
                { format: ImageManipulator.SaveFormat.JPEG, compress: 0.9 },
              );
              const embedResult = await embedCardOnDevice(cropManip.uri, cropW, cropH);
              if (!embedResult) continue;
              const hint = ocrHints[i];
              const capturedI = i;
              vectorTasks.push(
                api.scanVector(
                  Array.from(embedResult.embedding),
                  hint?.language ?? 'en',
                  scanMode,
                  hint ?? { raw_text: undefined, language: 'en', game },
                  CLIP_MODEL_VERSION,
                  null,
                  (item) => handleResult(item, capturedI),
                ).catch((e: unknown) => {
                  const err = e as Error & { code?: string };
                  if (err?.code !== 'MODEL_VERSION_MISMATCH') {
                    console.warn('[MultiScan] vector scan failed for crop', capturedI, e);
                  }
                }),
              );
            }
            await Promise.all(vectorTasks);
            hybridSucceeded = true;
            console.log('[MultiScan] hybrid on-device path completed');
          } catch (e) {
            console.warn('[MultiScan] hybrid path failed — falling back to server:', e);
          }
        }

        // Server fallback: used when not on-device capable, or hybrid failed.
        const streamOutcome = hybridSucceeded ? null : await api.scanStream(
          { image: fullImageB64, boxes },
          ocrHints,
          scanMode,
          (item: ScanStreamResult) => handleResult(item, item.crop_index),
          controller.signal,
        );

        setMultiScanLoading(false);

        if (enableTiming) {
          const t4 = Date.now();
          const timing: ScanTiming = {
            yoloMs: t1 - t0,
            cropPrepMs: t2 - t1,
            firstResultMs: t3 > 0 ? t3 - t0 : t4 - t0,
            totalStreamMs: t4 - t0,
          };
          setScanTiming(timing);
          _appendTimingLog(timing).catch(() => {});
        }

        // Aborted (user backed out or new scan started) — don't surface an
        // error and don't claim success; the caller is responsible for new state.
        if (streamOutcome?.aborted) {
          console.log("[MultiScan] Stream aborted by caller");
          return false;
        }

        // Check if anything was found
        const store = useScanStore.getState();
        if (!store.multiScanResult || store.multiScanResult.cards.length === 0) {
          setMultiScanError("No cards could be identified. Try better lighting or angle.");
          return false;
        }

        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Multi-scan failed";
        console.error("[MultiScan] Pipeline error:", err);
        setError(msg);
        setMultiScanError(msg);
        return false;
      } finally {
        setIsProcessing(false);
        setProgress("");
      }
    },
    [appendMultiScanCard, clearMultiScan, setMultiScanLoading, setMultiScanError, setScanTiming],
  );

  return { scan, isProcessing, progress, error };
}
