import { useState, useCallback } from "react";
import TextRecognition, { TextRecognitionScript } from "@react-native-ml-kit/text-recognition";
import * as ImageManipulator from "expo-image-manipulator";
import { Dimensions } from "react-native";
import { filterBlocksToCardZone } from "@/utils/detectCards";
import type { Language } from "@/constants";

interface OCRFrame {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface OCRResult {
  text: string;
  blocks: Array<{ text: string; frame: OCRFrame }>;
  cardDetected: boolean;
}

interface UseOCRReturn {
  recognize: (imageUri: string, language: Language) => Promise<OCRResult | null>;
  isProcessing: boolean;
  error: string | null;
}

async function resizeImage(uri: string): Promise<{ uri: string; width: number; height: number }> {
  const result = await ImageManipulator.manipulateAsync(
    uri,
    [{ resize: { width: 1200 } }],
    { compress: 0.9, format: ImageManipulator.SaveFormat.JPEG },
  );
  return { uri: result.uri, width: result.width, height: result.height };
}

function mlKitScript(language: Language): TextRecognitionScript {
  if (language === "ja") return TextRecognitionScript.JAPANESE;
  return TextRecognitionScript.LATIN;
}

export function useOCR(): UseOCRReturn {
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recognize = useCallback(async (imageUri: string, language: Language): Promise<OCRResult | null> => {
    setIsProcessing(true);
    setError(null);
    try {
      const { uri, width, height } = await resizeImage(imageUri);
      const script = mlKitScript(language);
      const result = await TextRecognition.recognize(uri, script);

      const allBlocks = [...result.blocks]
        .sort((a, b) => (a.frame?.top ?? 0) - (b.frame?.top ?? 0))
        .map((b) => ({
          text: b.text,
          frame: b.frame as OCRFrame,
        }));

      const screen = Dimensions.get("window");
      const zoneBlocks = filterBlocksToCardZone(allBlocks, width, height, screen.width, screen.height);
      const text = zoneBlocks.map((b) => b.text).join("\n");
      const cardDetected = zoneBlocks.length < allBlocks.length;

      return { text, blocks: zoneBlocks, cardDetected };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "OCR failed";
      setError(msg);
      return null;
    } finally {
      setIsProcessing(false);
    }
  }, []);

  return { recognize, isProcessing, error };
}
