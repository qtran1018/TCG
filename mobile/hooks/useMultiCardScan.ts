import { useState, useCallback, useEffect, useRef } from "react";
import TextRecognition, { TextRecognitionScript } from "@react-native-ml-kit/text-recognition";
import * as ImageManipulator from "expo-image-manipulator";
import * as FileSystem from "expo-file-system/legacy";
import { api } from "@/services/api";
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

// Require 3+ consecutive kana. Applied to the name-region sub-crop (top 18%) which is
// clean enough that false positives are rare. The {3,} minimum also guards against
// single stray kana. All real JP Pokémon names are ≥3 kana (shortest: アブラ = Abra = 3).
const KANA_RE = /[゠-ヿぁ-ゖ]{3,}/;
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

      try {
        // 1. Resize image to 2400px wide (higher than 1600 for better card number / small text fidelity).
        //    PNG avoids JPEG compression loss on this master image used for OCR and cropping.
        setProgress("Processing image...");
        const resized = await ImageManipulator.manipulateAsync(
          imageUri,
          [{ resize: { width: 2400 } }],
          { compress: 1, format: ImageManipulator.SaveFormat.PNG },
        );

        // 2. OCR full image with JAPANESE script — it returns both Latin and kana,
        //    so one pass covers EN and JP cards.
        setProgress("Scanning for cards...");
        const fullResult = await TextRecognition.recognize(resized.uri, TextRecognitionScript.JAPANESE);
        const allBlocks = fullResult.blocks
          .sort((a, b) => (a.frame?.top ?? 0) - (b.frame?.top ?? 0))
          .map((b) => ({ text: b.text, frame: b.frame as any }));

        // 3. Detect card regions — on-device YOLO first, then fallbacks
        let regions: CardRegion[];
        let regionsFromYolo = false;
        const yoloResult = await detectCardsWithYolo(resized.uri, resized.width, resized.height);

        if (yoloResult && yoloResult.boxes.length > 0) {
          regions = boxesToRegions(yoloResult.boxes);
          regionsFromYolo = true;
          setProgress(`Found ${regions.length} card${regions.length !== 1 ? "s" : ""}...`);
        } else if (!yoloResult) {
          // YOLO model absent — fall back to backend /detect
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
          // YOLO found nothing — fall back to OCR clustering
          regions = detectCardRegions(allBlocks, resized.width, resized.height);
        }

        if (enableTiming) t1 = Date.now();
        console.log(`[MultiScan] detection: fromYolo=${regionsFromYolo} regions=${regions.length}`);

        if (regions.length === 0) {
          const msg = "No cards detected. Try better lighting or move closer.";
          setMultiScanError(msg);
          setError(msg);
          return false;
        }

        // 4. Crop each detected region
        setProgress(`Found ${regions.length} region${regions.length !== 1 ? "s" : ""}, reading each...`);
        const regionCount = Math.min(regions.length, 20);
        const cropData: Array<{
          regionIndex: number;
          uri: string;
          cropX: number; cropY: number; cropW: number; cropH: number;
        }> = [];

        for (let i = 0; i < regionCount; i++) {
          const { boundingBox: bb } = regions[i];
          const margin = Math.round(Math.min(bb.width, bb.height) * 0.10);
          const cropX = Math.max(0, bb.left - margin);
          const cropY = Math.max(0, bb.top - margin);
          const cropW = Math.min(resized.width - cropX, bb.width + margin * 2);
          const cropH = Math.min(resized.height - cropY, bb.height + margin * 2);

          const cropped = await ImageManipulator.manipulateAsync(
            resized.uri,
            [{ crop: { originX: cropX, originY: cropY, width: cropW, height: cropH } }],
            { compress: 1, format: ImageManipulator.SaveFormat.PNG },
          );
          cropData.push({ regionIndex: i, uri: cropped.uri, cropX, cropY, cropW, cropH });
        }

        // 5. Build crop base64 list + OCR hints for the combined /scan endpoint
        setProgress(`Identifying ${cropData.length} card${cropData.length !== 1 ? "s" : ""}...`);

        // Read base64 + OCR each crop IN PARALLEL — was sequential before.
        const cropResults = await Promise.all(
          cropData.map(async ({ uri, cropX, cropY, cropW, cropH }) => {
            // Kick off the JPEG re-encode + base64 read for the backend payload
            // concurrently with the OCR chain — they only depend on `uri`, not
            // on OCR results. Saves ~200–400ms per crop on real phones.
            const backendPayloadPromise: Promise<string> = (async () => {
              const jpegForBackend = await ImageManipulator.manipulateAsync(
                uri, [], { compress: 0.92, format: ImageManipulator.SaveFormat.JPEG },
              );
              return FileSystem.readAsStringAsync(jpegForBackend.uri, {
                encoding: FileSystem.EncodingType.Base64,
              });
            })();

            // Build OCR hint for this crop (used in ocr + combined modes).
            // JAPANESE script returns both Latin and kana — one pass handles EN and JP.
            let rawText: string | undefined;
            let cropLang: "en" | "ja" = "en";
            try {
              let nameText = "";

              if (regionsFromYolo) {
                // YOLO already confirmed this is a card — skip full-crop OCR and confidence
                // check entirely. Only run the name-region sub-crop OCR (top 18%), which is
                // all the backend actually needs. Card number still comes from allBlocks
                // (full-image OCR, already computed once above).
                try {
                  const nameH = Math.max(1, Math.round(cropH * 0.18));
                  const nameW = Math.max(1, Math.round(cropW * 0.90));
                  const nameOriginX = Math.round(cropW * 0.05);
                  const nameCropImg = await ImageManipulator.manipulateAsync(
                    uri,
                    [{ crop: { originX: nameOriginX, originY: 0, width: nameW, height: nameH } }],
                    { compress: 1, format: ImageManipulator.SaveFormat.PNG },
                  );
                  const nameResult = await TextRecognition.recognize(nameCropImg.uri, TextRecognitionScript.JAPANESE);
                  nameText = nameResult.blocks
                    .sort((a, b) => (a.frame?.top ?? 0) - (b.frame?.top ?? 0))
                    .map((b) => b.text)
                    .join("\n");
                } catch (e) {
                  console.warn("[MultiScan] name region OCR failed:", e);
                }
                cropLang = detectCropLanguage(nameText);
                if (scanMode !== "image") {
                  const numberText = getNumberBlocksText(allBlocks, cropX, cropY, cropW, cropH);
                  rawText = numberText && /\d/.test(numberText)
                    ? `${nameText}\n${numberText}`
                    : nameText || undefined;
                }
              } else {
                // OCR clustering fallback — full-crop OCR still needed for confidence check
                // since the fallback detector is noisy and may produce non-card regions.
                const cropResult = await TextRecognition.recognize(uri, TextRecognitionScript.JAPANESE);
                const fullCropText = cropResult.blocks
                  .sort((a, b) => (a.frame?.top ?? 0) - (b.frame?.top ?? 0))
                  .map((b) => b.text)
                  .join("\n");

                // Language detection: ALWAYS use the name-region sub-crop (top 18%, 5–95% width).
                // Full crop text is too noisy — type symbols, energy icons, flavor text, and
                // attack text produce kana misreads on EN cards even at the {3,} threshold.
                try {
                  const nameH = Math.max(1, Math.round(cropH * 0.18));
                  const nameW = Math.max(1, Math.round(cropW * 0.90));
                  const nameOriginX = Math.round(cropW * 0.05);
                  const nameCropImg = await ImageManipulator.manipulateAsync(
                    uri,
                    [{ crop: { originX: nameOriginX, originY: 0, width: nameW, height: nameH } }],
                    { compress: 1, format: ImageManipulator.SaveFormat.PNG },
                  );
                  const nameResult = await TextRecognition.recognize(nameCropImg.uri, TextRecognitionScript.JAPANESE);
                  nameText = nameResult.blocks
                    .sort((a, b) => (a.frame?.top ?? 0) - (b.frame?.top ?? 0))
                    .map((b) => b.text)
                    .join("\n");
                } catch (e) {
                  console.warn("[MultiScan] name region OCR failed, falling back to full crop for language detection:", e);
                }
                cropLang = nameText ? detectCropLanguage(nameText) : detectCropLanguage(fullCropText);

                if (scanMode !== "image") {
                  const confidence = assessCardConfidence(fullCropText, cropResult.blocks.length, game, cropLang);
                  if (confidence.isCard) {
                    const numberText = getNumberBlocksText(allBlocks, cropX, cropY, cropW, cropH);
                    rawText = numberText && /\d/.test(numberText)
                      ? `${nameText}\n${numberText}`
                      : nameText || augmentWithNumberRegion(fullCropText, allBlocks, cropX, cropY, cropW, cropH);
                  }
                }
              }
            } catch (e) {
              // One bad crop must not abort the entire scan — fall back to image-only signal.
              console.warn("[MultiScan] crop OCR failed:", e);
            }

            const cropB64 = await backendPayloadPromise;
            return { cropB64, rawText, cropLang };
          }),
        );

        if (enableTiming) t2 = Date.now();

        const crops: string[] = cropResults.map((r) => r.cropB64);
        const ocrHints: ScanOcrHint[] = cropResults.map((r) => ({
          raw_text: r.rawText,
          language: r.cropLang,
          game,
        }));

        // 6. Signal the store that streaming is starting
        setMultiScanLoading(true, regions.length);

        // 7. Stream results from the combined /scan endpoint
        const seenIds = new Set<number>();
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;

        const streamOutcome = await api.scanStream(crops, ocrHints, scanMode, (item: ScanStreamResult) => {
          if (item.candidates.length === 0) return;

          // Deduplicate by top candidate ID
          const topId = item.candidates[0].id;
          if (seenIds.has(topId)) return;
          seenIds.add(topId);

          if (enableTiming && t3 === 0) t3 = Date.now();

          const hint = ocrHints[item.crop_index];
          const rawText = hint?.raw_text ?? "";

          // Extract kana name, card number, and set total for Japanese image lookup
          let kanaName: string | undefined;
          let setTotal: number | undefined;
          let cardNumber: string | undefined;
          const cropLang = ocrHints[item.crop_index]?.language ?? "en";
          if (cropLang === "ja" && rawText) {
            const kanaMatch = rawText.match(/[゠-ヿー]+/g);
            if (kanaMatch) kanaName = kanaMatch.reduce((a, b) => (a.length >= b.length ? a : b), "");
            const numMatch = rawText.match(/(\d+)\/(\d+)/);
            if (numMatch) {
              cardNumber = numMatch[1];
              setTotal = parseInt(numMatch[2], 10);
            }
          }

          const card: DetectedCard = {
            regionIndex: cropData[item.crop_index]?.regionIndex ?? item.crop_index,
            ocrText: rawText,
            searchResult: {
              candidates: item.candidates,
              query_used: item.query_used,
            },
            matchSource: (item.match_source === "none" || !item.match_source) ? undefined : item.match_source,
            kanaName,
            setTotal,
            cardNumber,
          };

          appendMultiScanCard(card);
        }, controller.signal);

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
