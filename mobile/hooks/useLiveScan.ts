import { useState, useRef, useCallback, useEffect } from "react";
import * as ImageManipulator from "expo-image-manipulator";
import * as FileSystem from "expo-file-system/legacy";
import { Camera } from "react-native-vision-camera";
import { api } from "@/services/api";
import { detectCardsWithYolo } from "@/utils/yoloDetector";
import type { CardOut, PriceOut } from "@/services/api";
import type { Game, ScanType } from "@/constants";

export interface LiveSessionCard {
  tempId: string;
  card: CardOut | null;
  price: PriceOut | null;
  priceLoading: boolean;
  scanning: boolean;
  error: boolean;
}

export interface NormBox {
  x: number; y: number; w: number; h: number;
}

export type BoxState = "detecting" | "stable" | "captured";

interface UseLiveScanOptions {
  game: Game;
  scanType: ScanType;
}

const STABLE_MS = 800;
const STABLE_THRESHOLD = 0.035;
const CAPTURE_COOLDOWN_MS = 2500;
// Pause between detection cycles (added AFTER each cycle completes)
const CYCLE_PAUSE_MS = 150;

export function useLiveScan({ game, scanType }: UseLiveScanOptions) {
  const cameraRef = useRef<Camera>(null);

  const [sessionCards, setSessionCards] = useState<LiveSessionCard[]>([]);
  const [box, setBox] = useState<NormBox | null>(null);
  const [boxState, setBoxState] = useState<BoxState>("detecting");
  const [stabilityProgress, setStabilityProgress] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [snapDims, setSnapDims] = useState({ width: 1, height: 1 });

  // Refs — mutated without triggering re-renders
  const isRunningRef = useRef(false);
  const isCapturingRef = useRef(false);
  const cooldownUntilRef = useRef(0);
  const stableStartRef = useRef<number | null>(null);
  const lastBoxCenterRef = useRef<{ cx: number; cy: number } | null>(null);
  const nextCycleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const totalValue = sessionCards.reduce((sum, sc) => {
    if (!sc.price) return sum;
    const v = scanType === "psa" ? (sc.price.price_graded_10 ?? null) : (sc.price.price_loose ?? null);
    return v != null ? sum + v : sum;
  }, 0);

  const resetStability = useCallback(() => {
    stableStartRef.current = null;
    lastBoxCenterRef.current = null;
    setStabilityProgress(0);
    setBoxState("detecting");
  }, []);

  const checkStability = useCallback((cx: number, cy: number): { triggered: boolean; progress: number } => {
    const now = Date.now();
    const last = lastBoxCenterRef.current;

    if (last && (Math.abs(cx - last.cx) > STABLE_THRESHOLD || Math.abs(cy - last.cy) > STABLE_THRESHOLD)) {
      stableStartRef.current = now;
    } else if (!stableStartRef.current) {
      stableStartRef.current = now;
    }
    lastBoxCenterRef.current = { cx, cy };

    const elapsed = now - stableStartRef.current!;
    const progress = Math.min(1, elapsed / STABLE_MS);
    return { triggered: progress >= 1, progress };
  }, []);

  const captureAndScan = useCallback(async (snapshotBox: NormBox, snapshotW: number, snapshotH: number) => {
    if (!cameraRef.current || isCapturingRef.current) return;
    isCapturingRef.current = true;
    setIsCapturing(true);
    setBoxState("captured");

    const tempId = `live-${Date.now()}`;
    setSessionCards((prev) => [{
      tempId, card: null, price: null, priceLoading: false, scanning: true, error: false,
    }, ...prev]);

    try {
      const photo = await cameraRef.current.takePhoto({ qualityPrioritization: "quality" });
      const photoUri = "file://" + photo.path;

      const resized = await ImageManipulator.manipulateAsync(
        photoUri,
        [{ resize: { width: 1600 } }],
        { compress: 0.92, format: ImageManipulator.SaveFormat.JPEG },
      );

      const imageBase64 = await FileSystem.readAsStringAsync(resized.uri, {
        encoding: FileSystem.EncodingType.Base64,
      });

      // Scale box from snapshot pixel space to resized photo space
      const scaleX = resized.width / snapshotW;
      const scaleY = resized.height / snapshotH;
      const scaledBox = {
        left: Math.round(snapshotBox.x * snapshotW * scaleX),
        top: Math.round(snapshotBox.y * snapshotH * scaleY),
        width: Math.round(snapshotBox.w * snapshotW * scaleX),
        height: Math.round(snapshotBox.h * snapshotH * scaleY),
      };

      let foundCard: CardOut | null = null;
      await api.scanStream(
        { image: imageBase64, boxes: [scaledBox] },
        [{ raw_text: "", language: "en", game }],
        "image",
        (result) => {
          if (result.candidates?.length > 0 && !foundCard) {
            foundCard = result.candidates[0];
          }
        },
      );

      if (!foundCard) {
        setSessionCards((prev) =>
          prev.map((sc) => sc.tempId === tempId ? { ...sc, scanning: false, error: true } : sc),
        );
        return;
      }

      const card = foundCard as CardOut;
      setSessionCards((prev) =>
        prev.map((sc) =>
          sc.tempId === tempId ? { ...sc, card, scanning: false, priceLoading: true } : sc,
        ),
      );

      api.getCard(card.id, scanType, card.language).then((result) => {
        setSessionCards((prev) =>
          prev.map((sc) =>
            sc.tempId === tempId ? { ...sc, price: result.price ?? null, priceLoading: false } : sc,
          ),
        );
      }).catch(() => {
        setSessionCards((prev) =>
          prev.map((sc) => sc.tempId === tempId ? { ...sc, priceLoading: false } : sc),
        );
      });

    } catch {
      setSessionCards((prev) =>
        prev.map((sc) => sc.tempId === tempId ? { ...sc, scanning: false, error: true } : sc),
      );
    } finally {
      cooldownUntilRef.current = Date.now() + CAPTURE_COOLDOWN_MS;
      isCapturingRef.current = false;
      setIsCapturing(false);
      resetStability();
      setBox(null);
    }
  }, [game, scanType, resetStability]);

  // One detection pass — called sequentially by the loop
  const runOneCycle = useCallback(async () => {
    if (!isRunningRef.current || isCapturingRef.current) return;

    if (Date.now() < cooldownUntilRef.current) {
      setBox(null);
      resetStability();
      return;
    }

    if (!cameraRef.current) return;

    try {
      const snapshot = await cameraRef.current.takeSnapshot({ quality: 40 });
      const snapshotUri = "file://" + snapshot.path;
      const sw = snapshot.width;
      const sh = snapshot.height;
      setSnapDims({ width: sw, height: sh });

      const result = await detectCardsWithYolo(snapshotUri, sw, sh);
      FileSystem.deleteAsync(snapshotUri, { idempotent: true }).catch(() => {});

      if (!isRunningRef.current || isCapturingRef.current) return;

      if (!result || result.boxes.length === 0) {
        setBox(null);
        resetStability();
        return;
      }

      const primary = result.boxes.reduce((best, b) =>
        b.width * b.height > best.width * best.height ? b : best,
      );
      const normBox: NormBox = {
        x: primary.left / sw,
        y: primary.top / sh,
        w: primary.width / sw,
        h: primary.height / sh,
      };
      setBox(normBox);

      const cx = normBox.x + normBox.w / 2;
      const cy = normBox.y + normBox.h / 2;
      const { triggered, progress } = checkStability(cx, cy);
      setStabilityProgress(progress);
      setBoxState(progress > 0 ? "stable" : "detecting");

      if (triggered) {
        await captureAndScan(normBox, sw, sh);
      }
    } catch {
      // snapshot or YOLO error — skip cycle silently
    }
  }, [checkStability, captureAndScan, resetStability]);

  // Keep a fresh ref so the recursive loop never closes over a stale callback
  const runOneCycleRef = useRef(runOneCycle);
  useEffect(() => { runOneCycleRef.current = runOneCycle; }, [runOneCycle]);

  // Recursive loop: each cycle schedules the next only after it completes.
  // This prevents cycles from stacking up if YOLO takes longer than the interval.
  const scheduleNextCycle = useCallback(() => {
    if (!isRunningRef.current) return;
    nextCycleTimerRef.current = setTimeout(async () => {
      await runOneCycleRef.current();
      scheduleNextCycle();
    }, CYCLE_PAUSE_MS);
  }, []);

  const startDetection = useCallback(() => {
    if (isRunningRef.current) return;
    isRunningRef.current = true;
    setIsRunning(true);
    cooldownUntilRef.current = 0;
    resetStability();
    scheduleNextCycle();
  }, [scheduleNextCycle, resetStability]);

  const stopDetection = useCallback(() => {
    isRunningRef.current = false;
    setIsRunning(false);
    if (nextCycleTimerRef.current) {
      clearTimeout(nextCycleTimerRef.current);
      nextCycleTimerRef.current = null;
    }
    setBox(null);
    resetStability();
  }, [resetStability]);

  const clearSession = useCallback(() => setSessionCards([]), []);

  useEffect(() => {
    return () => {
      isRunningRef.current = false;
      if (nextCycleTimerRef.current) clearTimeout(nextCycleTimerRef.current);
    };
  }, []);

  return {
    cameraRef,
    sessionCards,
    box,
    boxState,
    stabilityProgress,
    snapDims,
    isRunning,
    isCapturing,
    totalValue,
    startDetection,
    stopDetection,
    clearSession,
  };
}
