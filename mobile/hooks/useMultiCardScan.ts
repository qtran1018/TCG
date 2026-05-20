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
import type { DetectedCard } from "@/types/scan";

export type ScanMode = "ocr" | "image" | "combined";

// Re-export so existing imports still compile
export type { DetectedCard } from "@/types/scan";
export type { MultiScanResult } from "@/types/scan";

interface UseMultiCardScanReturn {
  scan: (imageUri: string, game: Game, scanMode?: ScanMode) => Promise<boolean>;
  isProcessing: boolean;
  progress: string;
  error: string | null;
}

// Katakana U+30A0–U+30FF and hiragana U+3041–U+3096 are exclusive to Japanese.
// EN cards never contain kana — a single match is sufficient to identify the crop as JP.
const KANA_RE = /[゠-ヿぁ-ゖ]/;
function detectCropLanguage(text: string): "en" | "ja" {
  return KANA_RE.test(text) ? "ja" : "en";
}

function augmentWithNumberRegion(
  cropText: string,
  allBlocks: Array<{ text: string; frame: any }>,
  cropX: number, cropY: number, cropW: number, cropH: number,
): string {
  const numTop = cropY + cropH * 0.78;
  const numBottom = cropY + cropH;
  const numberBlocks = allBlocks.filter((b) => {
    if (!b.frame) return false;
    const cy = b.frame.top + (b.frame.height ?? 0) / 2;
    const cx = b.frame.left + (b.frame.width ?? 0) / 2;
    return cy >= numTop && cy <= numBottom && cx >= cropX && cx <= cropX + cropW;
  });
  const numberText = numberBlocks.map((b) => b.text).join(" ");
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
  } = useScanStore();

  // Abort any in-flight scan stream when the hook unmounts (e.g. user navigates away).
  useEffect(() => () => abortRef.current?.abort(), []);

  const scan = useCallback(
    async (imageUri: string, game: Game, scanMode: ScanMode = "ocr"): Promise<boolean> => {
      setIsProcessing(true);
      setError(null);

      try {
        // 1. Resize image to 1600px wide (for OCR quality and backend CLIP)
        setProgress("Processing image...");
        const resized = await ImageManipulator.manipulateAsync(
          imageUri,
          [{ resize: { width: 1600 } }],
          { compress: 0.9, format: ImageManipulator.SaveFormat.JPEG },
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
        const yoloResult = await detectCardsWithYolo(resized.uri, resized.width, resized.height);

        if (yoloResult && yoloResult.boxes.length > 0) {
          regions = boxesToRegions(yoloResult.boxes);
          setProgress(`Found ${regions.length} card${regions.length !== 1 ? "s" : ""}...`);
        } else if (!yoloResult) {
          // YOLO model absent — fall back to backend /detect
          try {
            const base64 = await FileSystem.readAsStringAsync(resized.uri, {
              encoding: FileSystem.EncodingType.Base64,
            });
            const detected = await api.detectCards(base64, 10);
            if (detected.boxes.length > 0) {
              regions = boxesToRegions(detected.boxes);
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

        if (regions.length === 0) {
          const msg = "No cards detected. Try better lighting or move closer.";
          setMultiScanError(msg);
          setError(msg);
          return false;
        }

        // 4. Crop each detected region
        setProgress(`Found ${regions.length} region${regions.length !== 1 ? "s" : ""}, reading each...`);
        const regionCount = Math.min(regions.length, 10);
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
            { compress: 0.9, format: ImageManipulator.SaveFormat.JPEG },
          );
          cropData.push({ regionIndex: i, uri: cropped.uri, cropX, cropY, cropW, cropH });
        }

        // 5. Build crop base64 list + OCR hints for the combined /scan endpoint
        setProgress(`Identifying ${cropData.length} card${cropData.length !== 1 ? "s" : ""}...`);

        // Read base64 + OCR each crop IN PARALLEL — was sequential before.
        const cropResults = await Promise.all(
          cropData.map(async ({ uri, cropX, cropY, cropW, cropH }) => {
            // Always read crop as base64 (needed for image modes)
            const cropB64 = await FileSystem.readAsStringAsync(uri, {
              encoding: FileSystem.EncodingType.Base64,
            });

            // Build OCR hint for this crop (used in ocr + combined modes).
            // JAPANESE script returns both Latin and kana — one pass handles EN and JP.
            let rawText: string | undefined;
            let cropLang: "en" | "ja" = "en";
            try {
              const cropResult = await TextRecognition.recognize(uri, TextRecognitionScript.JAPANESE);
              let cropText = cropResult.blocks
                .sort((a, b) => (a.frame?.top ?? 0) - (b.frame?.top ?? 0))
                .map((b) => b.text)
                .join("\n");
              cropText = augmentWithNumberRegion(cropText, allBlocks, cropX, cropY, cropW, cropH);
              cropLang = detectCropLanguage(cropText);
              if (scanMode !== "image") {
                const confidence = assessCardConfidence(cropText, cropResult.blocks.length, game, cropLang);
                rawText = confidence.isCard ? cropText : undefined;
              }
            } catch (e) {
              // One bad crop must not abort the entire scan — fall back to image-only signal.
              console.warn("[MultiScan] crop OCR failed:", e);
            }

            return { cropB64, rawText, cropLang };
          }),
        );

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
    [appendMultiScanCard, clearMultiScan, setMultiScanLoading, setMultiScanError],
  );

  return { scan, isProcessing, progress, error };
}
