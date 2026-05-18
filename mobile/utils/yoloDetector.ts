import type { DetectBox } from "@/services/api";

export interface YoloDetectResult {
  boxes: DetectBox[];
  imageWidth: number;
  imageHeight: number;
}

// On-device YOLO is disabled until card_detector.tflite is present.
// detectCardsWithYolo returns null → caller falls back to backend /detect.
export async function detectCardsWithYolo(
  _imageUri: string,
  _origW: number,
  _origH: number,
): Promise<YoloDetectResult | null> {
  return null;
}
