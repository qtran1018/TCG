import { useState, useCallback } from "react";
import TextRecognition, { TextRecognitionScript } from "@react-native-ml-kit/text-recognition";
import * as ImageManipulator from "expo-image-manipulator";
import * as FileSystem from "expo-file-system/legacy";
import { api } from "@/services/api";
import { detectCardRegions, boxesToRegions } from "@/utils/detectCards";
import { assessCardConfidence } from "@/utils/cardConfidence";
import type { Game, Language } from "@/constants";
import type { BatchSearchItem } from "@/services/api";
import type { CardRegion } from "@/utils/detectCards";

export interface DetectedCard {
  regionIndex: number;
  ocrText: string;
  searchResult: BatchSearchItem;
}

export interface MultiScanResult {
  cards: DetectedCard[];
  totalRegionsFound: number;
  totalConfident: number;
}

interface UseMultiCardScanReturn {
  scan: (imageUri: string, game: Game, language: Language) => Promise<MultiScanResult | null>;
  isProcessing: boolean;
  progress: string;
  error: string | null;
}

function mlKitScript(language: Language): TextRecognitionScript {
  return language === "ja" ? TextRecognitionScript.JAPANESE : TextRecognitionScript.LATIN;
}

export function useMultiCardScan(): UseMultiCardScanReturn {
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);

  const scan = useCallback(
    async (imageUri: string, game: Game, language: Language): Promise<MultiScanResult | null> => {
      setIsProcessing(true);
      setError(null);
      try {
        // 1. Resize image
        setProgress("Processing image...");
        const resized = await ImageManipulator.manipulateAsync(
          imageUri,
          [{ resize: { width: 1600 } }], // wider for display cases
          { compress: 0.9, format: ImageManipulator.SaveFormat.JPEG },
        );

        // 2. OCR full image + read base64 in parallel (both read from the same resized URI)
        setProgress("Scanning for cards...");
        const script = mlKitScript(language);
        const [fullResult, base64] = await Promise.all([
          TextRecognition.recognize(resized.uri, script),
          FileSystem.readAsStringAsync(resized.uri, { encoding: FileSystem.EncodingType.Base64 }),
        ]);
        const allBlocks = fullResult.blocks
          .sort((a, b) => (a.frame?.top ?? 0) - (b.frame?.top ?? 0))
          .map((b) => ({ text: b.text, frame: b.frame as any }));

        // 3. Detect card outlines via backend OpenCV; fall back to OCR clustering if unavailable.
        let regions: CardRegion[];
        try {
          const detected = await api.detectCards(base64, 10);
          if (detected.boxes.length > 0) {
            regions = boxesToRegions(detected.boxes);
            setProgress(`Found ${regions.length} card outline${regions.length !== 1 ? "s" : ""}...`);
          } else {
            regions = detectCardRegions(allBlocks, resized.width, resized.height);
          }
        } catch (detectErr) {
          console.warn("[MultiScan] OpenCV detect failed, falling back to OCR clustering:", detectErr);
          regions = detectCardRegions(allBlocks, resized.width, resized.height);
        }

        if (regions.length === 0) {
          setError("No cards detected. Try better lighting or move closer.");
          return null;
        }

        // 4. Crop each region, re-OCR, confidence check
        setProgress(`Found ${regions.length} region${regions.length !== 1 ? "s" : ""}, reading each...`);
        const confidentQueries: Array<{ regionIndex: number; ocr_text: string }> = [];

        for (let i = 0; i < Math.min(regions.length, 10); i++) {
          const { boundingBox: bb } = regions[i];
          // Add a small margin around the detected region
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

          const cropResult = await TextRecognition.recognize(cropped.uri, script);
          const cropText = cropResult.blocks
            .sort((a, b) => (a.frame?.top ?? 0) - (b.frame?.top ?? 0))
            .map((b) => b.text)
            .join("\n");

          const confidence = assessCardConfidence(cropText, cropResult.blocks.length, game);
          if (confidence.isCard) {
            confidentQueries.push({ regionIndex: i, ocr_text: cropText });
          }
        }

        if (confidentQueries.length === 0) {
          setError("Regions found but none look like cards. Try better lighting or angle.");
          return null;
        }

        // 5. Batch search all confident cards
        setProgress(`Searching ${confidentQueries.length} card${confidentQueries.length !== 1 ? "s" : ""}...`);
        const batchResult = await api.batchSearch(
          confidentQueries.map((q) => ({ ocr_text: q.ocr_text, game, language })),
          "raw",
        );

        const seenCardIds = new Set<number>();
        const cards: DetectedCard[] = batchResult.results
          .map((result, i) => ({
            regionIndex: confidentQueries[i].regionIndex,
            ocrText: confidentQueries[i].ocr_text,
            searchResult: result,
          }))
          .filter((c) => {
            if (c.searchResult.candidates.length === 0) return false;
            const topId = c.searchResult.candidates[0].id;
            if (seenCardIds.has(topId)) return false;
            seenCardIds.add(topId);
            return true;
          });

        return {
          cards,
          totalRegionsFound: regions.length,
          totalConfident: confidentQueries.length,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Multi-scan failed";
        console.error("[MultiScan] Pipeline error:", err);
        setError(msg);
        return null;
      } finally {
        setIsProcessing(false);
        setProgress("");
      }
    },
    [],
  );

  return { scan, isProcessing, progress, error };
}
