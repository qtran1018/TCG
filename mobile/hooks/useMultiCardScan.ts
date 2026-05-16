import { useState, useCallback } from "react";
import TextRecognition, { TextRecognitionScript } from "@react-native-ml-kit/text-recognition";
import * as ImageManipulator from "expo-image-manipulator";
import * as FileSystem from "expo-file-system/legacy";
import { api } from "@/services/api";
import { detectCardRegions, boxesToRegions } from "@/utils/detectCards";
import { assessCardConfidence } from "@/utils/cardConfidence";
import type { Game, Language } from "@/constants";
import type { BatchSearchItem, CardOut } from "@/services/api";
import type { CardRegion } from "@/utils/detectCards";

export type ScanMode = "ocr" | "image" | "combined";

export interface DetectedCard {
  regionIndex: number;
  ocrText: string;
  searchResult: BatchSearchItem;
  matchSource?: "ocr" | "image" | "both";
}

export interface MultiScanResult {
  cards: DetectedCard[];
  totalRegionsFound: number;
  totalConfident: number;
}

interface UseMultiCardScanReturn {
  scan: (imageUri: string, game: Game, language: Language, scanMode?: ScanMode) => Promise<MultiScanResult | null>;
  isProcessing: boolean;
  progress: string;
  error: string | null;
}

function mlKitScript(language: Language): TextRecognitionScript {
  return language === "ja" ? TextRecognitionScript.JAPANESE : TextRecognitionScript.LATIN;
}

function rrfMerge(
  imageItem: BatchSearchItem | undefined,
  ocrItem: BatchSearchItem | undefined,
): { merged: CardOut[]; matchSource: "ocr" | "image" | "both" } {
  const scoreMap = new Map<number, { score: number; card: CardOut }>();
  const addCandidates = (candidates: CardOut[]) => {
    candidates.forEach((card, rank) => {
      const delta = 1 / (rank + 60);
      const existing = scoreMap.get(card.id);
      if (existing) existing.score += delta;
      else scoreMap.set(card.id, { score: delta, card });
    });
  };
  if (imageItem?.candidates.length) addCandidates(imageItem.candidates);
  if (ocrItem?.candidates.length) addCandidates(ocrItem.candidates);

  const merged = [...scoreMap.values()].sort((a, b) => b.score - a.score).map((v) => v.card);
  const hasImage = (imageItem?.candidates.length ?? 0) > 0;
  const hasOcr = (ocrItem?.candidates.length ?? 0) > 0;
  const matchSource = hasImage && hasOcr ? "both" : hasImage ? "image" : "ocr";
  return { merged, matchSource };
}

export function useMultiCardScan(): UseMultiCardScanReturn {
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);

  const scan = useCallback(
    async (imageUri: string, game: Game, language: Language, scanMode: ScanMode = "ocr"): Promise<MultiScanResult | null> => {
      setIsProcessing(true);
      setError(null);
      try {
        // 1. Resize image
        setProgress("Processing image...");
        const resized = await ImageManipulator.manipulateAsync(
          imageUri,
          [{ resize: { width: 1600 } }],
          { compress: 0.9, format: ImageManipulator.SaveFormat.JPEG },
        );

        // 2. OCR full image + read base64 in parallel
        setProgress("Scanning for cards...");
        const script = mlKitScript(language);
        const [fullResult, base64] = await Promise.all([
          TextRecognition.recognize(resized.uri, script),
          FileSystem.readAsStringAsync(resized.uri, { encoding: FileSystem.EncodingType.Base64 }),
        ]);
        const allBlocks = fullResult.blocks
          .sort((a, b) => (a.frame?.top ?? 0) - (b.frame?.top ?? 0))
          .map((b) => ({ text: b.text, frame: b.frame as any }));

        // 3. Detect card outlines via backend; fall back to OCR clustering
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

        // 4. Crop each detected region
        setProgress(`Found ${regions.length} region${regions.length !== 1 ? "s" : ""}, reading each...`);
        const regionCount = Math.min(regions.length, 10);
        const cropData: Array<{ regionIndex: number; uri: string }> = [];

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
          cropData.push({ regionIndex: i, uri: cropped.uri });
        }

        // 5. Identify cards — branch by scan mode
        let cards: DetectedCard[] = [];
        let totalConfident = 0;

        if (scanMode === "image") {
          setProgress(`Matching ${cropData.length} card${cropData.length !== 1 ? "s" : ""} by image...`);
          const crops = await Promise.all(
            cropData.map((c) => FileSystem.readAsStringAsync(c.uri, { encoding: FileSystem.EncodingType.Base64 })),
          );
          const result = await api.batchMatchByImage(crops);

          const seenIds = new Set<number>();
          cards = result.results
            .map((r, i) => ({
              regionIndex: cropData[i].regionIndex,
              ocrText: "",
              searchResult: r,
            }))
            .filter((c) => {
              if (c.searchResult.candidates.length === 0) return false;
              const topId = c.searchResult.candidates[0].id;
              if (seenIds.has(topId)) return false;
              seenIds.add(topId);
              return true;
            });
          totalConfident = cards.length;

        } else if (scanMode === "combined") {
          // OCR each crop, then run both searches in parallel and merge with RRF
          setProgress("Reading cards...");
          const ocrTexts: (string | null)[] = [];
          for (const { uri } of cropData) {
            const cropResult = await TextRecognition.recognize(uri, script);
            const cropText = cropResult.blocks
              .sort((a, b) => (a.frame?.top ?? 0) - (b.frame?.top ?? 0))
              .map((b) => b.text)
              .join("\n");
            const confidence = assessCardConfidence(cropText, cropResult.blocks.length, game);
            ocrTexts.push(confidence.isCard ? cropText : null);
          }

          const allCropBase64 = await Promise.all(
            cropData.map((c) => FileSystem.readAsStringAsync(c.uri, { encoding: FileSystem.EncodingType.Base64 })),
          );

          const confidentIndices: number[] = [];
          const ocrQueryList: { ocr_text: string; game: Game; language: Language }[] = [];
          ocrTexts.forEach((text, i) => {
            if (text !== null) {
              confidentIndices.push(i);
              ocrQueryList.push({ ocr_text: text, game, language });
            }
          });

          setProgress(`Running combined scan on ${cropData.length} card${cropData.length !== 1 ? "s" : ""}...`);
          const [imageResult, ocrBatch] = await Promise.all([
            api.batchMatchByImage(allCropBase64),
            ocrQueryList.length > 0
              ? api.batchSearch(ocrQueryList, "raw")
              : Promise.resolve({ results: [] as BatchSearchItem[] }),
          ]);

          // Map OCR results back to crop indices
          const ocrByIndex: Record<number, BatchSearchItem> = {};
          confidentIndices.forEach((cropIdx, resultIdx) => {
            if (ocrBatch.results[resultIdx]) {
              ocrByIndex[cropIdx] = ocrBatch.results[resultIdx];
            }
          });

          // RRF merge per crop
          const seenIds = new Set<number>();
          for (let i = 0; i < cropData.length; i++) {
            const imageItem = imageResult.results[i];
            const ocrItem = ocrByIndex[i];
            const { merged, matchSource } = rrfMerge(imageItem, ocrItem);

            if (merged.length === 0) continue;
            const topId = merged[0].id;
            if (seenIds.has(topId)) continue;
            seenIds.add(topId);

            // Prefer OCR query string (human-readable); fall back to image query
            const queryUsed = ocrItem?.query_used ?? imageItem?.query_used ?? "";

            cards.push({
              regionIndex: cropData[i].regionIndex,
              ocrText: ocrTexts[i] ?? "",
              searchResult: { candidates: merged, query_used: queryUsed },
              matchSource,
            });
          }
          totalConfident = cards.length;

        } else {
          // OCR mode
          const confidentQueries: Array<{ regionIndex: number; ocr_text: string }> = [];
          for (const { regionIndex, uri } of cropData) {
            const cropResult = await TextRecognition.recognize(uri, script);
            const cropText = cropResult.blocks
              .sort((a, b) => (a.frame?.top ?? 0) - (b.frame?.top ?? 0))
              .map((b) => b.text)
              .join("\n");
            const confidence = assessCardConfidence(cropText, cropResult.blocks.length, game);
            if (confidence.isCard) {
              confidentQueries.push({ regionIndex, ocr_text: cropText });
            }
          }

          if (confidentQueries.length === 0) {
            setError("Regions found but none look like cards. Try better lighting or angle.");
            return null;
          }

          totalConfident = confidentQueries.length;
          setProgress(`Searching ${confidentQueries.length} card${confidentQueries.length !== 1 ? "s" : ""}...`);
          const result = await api.batchSearch(
            confidentQueries.map((q) => ({ ocr_text: q.ocr_text, game, language })),
            "raw",
          );

          const regionIndices = confidentQueries.map((q) => q.regionIndex);
          const seenIds = new Set<number>();
          cards = result.results
            .map((r, i) => ({
              regionIndex: regionIndices[i],
              ocrText: "",
              searchResult: r,
            }))
            .filter((c) => {
              if (c.searchResult.candidates.length === 0) return false;
              const topId = c.searchResult.candidates[0].id;
              if (seenIds.has(topId)) return false;
              seenIds.add(topId);
              return true;
            });
        }

        return {
          cards,
          totalRegionsFound: regions.length,
          totalConfident,
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
