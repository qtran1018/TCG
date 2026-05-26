import { useState, useRef, useCallback, useEffect } from "react";
import * as ImageManipulator from "expo-image-manipulator";
import * as FileSystem from "expo-file-system/legacy";
import { Camera } from "react-native-vision-camera";
import { api } from "@/services/api";
import type { CardOut, PriceOut } from "@/services/api";
import type { Game, ScanType } from "@/constants";

export interface LiveSessionCard {
  tempId: string;
  card: CardOut | null;
  candidates: CardOut[];
  price: PriceOut | null;
  priceLoading: boolean;
  scanning: boolean;
}

interface UseLiveScanOptions {
  game: Game;
  scanType: ScanType;
}

// Resize snapshot before upload — 640px is plenty for CLIP (224px input) + OCR
const SCAN_SIZE = 640;
// Suppress duplicate adds for the same card within this window
const RESCAN_COOLDOWN_MS = 5000;

export function useLiveScan({ game, scanType }: UseLiveScanOptions) {
  const cameraRef = useRef<Camera>(null);

  const [sessionCards, setSessionCards] = useState<LiveSessionCard[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [isScanning, setIsScanning] = useState(false);

  const isRunningRef = useRef(false);
  const isScanningRef = useRef(false);
  const loopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // card.id → timestamp of last successful add; reset on clearSession
  const seenCardTimesRef = useRef<Map<string, number>>(new Map());

  const totalValue = sessionCards.reduce((sum, sc) => {
    if (!sc.price) return sum;
    const v = scanType === "psa" ? (sc.price.price_graded_10 ?? null) : (sc.price.price_loose ?? null);
    return v != null ? sum + v : sum;
  }, 0);

  const runOneScan = useCallback(async () => {
    if (!isRunningRef.current || isScanningRef.current) return;
    if (!cameraRef.current) return;

    isScanningRef.current = true;
    setIsScanning(true);

    let snapshotUri: string | null = null;
    let resizedUri: string | null = null;

    try {
      const snapshot = await cameraRef.current.takeSnapshot({ quality: 80 });
      snapshotUri = "file://" + snapshot.path;

      const resized = await ImageManipulator.manipulateAsync(
        snapshotUri,
        [{ resize: { width: SCAN_SIZE } }],
        { compress: 0.85, format: ImageManipulator.SaveFormat.JPEG },
      );
      resizedUri = resized.uri;

      const imageBase64 = await FileSystem.readAsStringAsync(resized.uri, {
        encoding: FileSystem.EncodingType.Base64,
      });

      if (!isRunningRef.current) return;

      const allCandidates: CardOut[] = [];
      await api.scanStream(
        { image: imageBase64 }, // no boxes — backend YOLO auto-detects the card
        [
          { raw_text: "", language: "en", game },
          { raw_text: "", language: "ja", game },
        ],
        "combined",
        (result) => {
          result.candidates?.forEach((c) => {
            if (!allCandidates.find((x) => x.id === c.id)) allCandidates.push(c);
          });
        },
      );

      if (!isRunningRef.current || allCandidates.length === 0) return;

      const card = allCandidates[0];

      // Skip if we already added this card recently
      const lastSeen = seenCardTimesRef.current.get(String(card.id));
      if (lastSeen && Date.now() - lastSeen < RESCAN_COOLDOWN_MS) return;
      seenCardTimesRef.current.set(String(card.id), Date.now());

      const tempId = `live-${Date.now()}`;
      setSessionCards((prev) => [{
        tempId, card, candidates: allCandidates, price: null, priceLoading: true, scanning: false,
      }, ...prev]);

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
      // skip silently
    } finally {
      if (snapshotUri) FileSystem.deleteAsync(snapshotUri, { idempotent: true }).catch(() => {});
      if (resizedUri) FileSystem.deleteAsync(resizedUri, { idempotent: true }).catch(() => {});
      isScanningRef.current = false;
      setIsScanning(false);
    }
  }, [game, scanType]);

  const runOneScanRef = useRef(runOneScan);
  useEffect(() => { runOneScanRef.current = runOneScan; }, [runOneScan]);

  // Sequential loop: each scan completes before the next begins.
  // Natural pacing — backend scan (~600-900ms) is the rate limiter.
  const scheduleLoop = useCallback(() => {
    if (!isRunningRef.current) return;
    loopTimerRef.current = setTimeout(async () => {
      await runOneScanRef.current();
      scheduleLoop();
    }, 0);
  }, []);

  const startDetection = useCallback(() => {
    if (isRunningRef.current) return;
    isRunningRef.current = true;
    setIsRunning(true);
    scheduleLoop();
  }, [scheduleLoop]);

  const stopDetection = useCallback(() => {
    isRunningRef.current = false;
    isScanningRef.current = false;
    setIsRunning(false);
    setIsScanning(false);
    if (loopTimerRef.current) {
      clearTimeout(loopTimerRef.current);
      loopTimerRef.current = null;
    }
  }, []);

  const clearSession = useCallback(() => {
    setSessionCards([]);
    seenCardTimesRef.current.clear();
  }, []);

  const removeCard = useCallback((tempId: string) => {
    setSessionCards((prev) => prev.filter((sc) => sc.tempId !== tempId));
  }, []);

  const swapCard = useCallback((tempId: string, card: CardOut) => {
    // Mark the new card as seen so the scan loop doesn't re-add it immediately
    seenCardTimesRef.current.set(String(card.id), Date.now());
    setSessionCards((prev) =>
      prev.map((sc) => sc.tempId === tempId ? { ...sc, card } : sc),
    );
  }, []);

  useEffect(() => {
    return () => {
      isRunningRef.current = false;
      if (loopTimerRef.current) clearTimeout(loopTimerRef.current);
    };
  }, []);

  return {
    cameraRef,
    sessionCards,
    isRunning,
    isScanning,
    totalValue,
    startDetection,
    stopDetection,
    clearSession,
    removeCard,
    swapCard,
  };
}
