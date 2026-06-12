import { useState, useRef, useCallback, useEffect } from "react";
import * as ImageManipulator from "expo-image-manipulator";
import * as FileSystem from "expo-file-system/legacy";
import { Camera } from "react-native-vision-camera";
import { api } from "@/services/api";
import type { CardOut, PriceOut, ScanOcrHint } from "@/services/api";
import type { Game, Language, ScanType } from "@/constants";
import {
  clipMode,
  embedCardOnDevice,
  warmUpClip,
  CLIP_MODEL_VERSION,
} from "@/utils/clipEmbedder";
import { vectorSearch, vectorSearchAuto } from "@/utils/vectorSearch";
import { queryCardsByIds } from "@/utils/cardsDb";
import { detectCardsWithYolo } from "@/utils/yoloDetector";

// "auto" searches both languages and picks the higher CLIP similarity (less
// reliable for identical-art EN/JA prints); en/ja hard-lock the search.
export type LiveScanLang = Language | "auto";

// Matches at or above this sim skip the 2-frame confirmation gate —
// at 0.70+ the match is confident enough that phantom risk is negligible.
const HIGH_CONF_SIM = 0.70;

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
  language: LiveScanLang;
}

// Snapshot working resolution. On-device embedding means we no longer upload the
// JPEG (only a 512-dim vector), so the old 640px upload-size cap is obsolete.
// 1280px gives CLIP a much sharper art crop — the 640px crop upscaled to CLIP's
// 224px input was soft, pushing live-scan sims down to ~0.51-0.54 (near the floor).
const SCAN_SIZE = 1280;
// Suppress duplicate adds for the same card within this window
const RESCAN_COOLDOWN_MS = 30000;

export function useLiveScan({ game, scanType, language }: UseLiveScanOptions) {
  const cameraRef = useRef<Camera>(null);

  const [sessionCards, setSessionCards] = useState<LiveSessionCard[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [isScanning, setIsScanning] = useState(false);

  const isRunningRef = useRef(false);
  const isScanningRef = useRef(false);
  const loopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // card.id → timestamp of last successful add; reset on clearSession
  const seenCardTimesRef = useRef<Map<string, number>>(new Map());
  // Last frame's top-match card id — a card must match twice in a row before
  // it's added. Filters transient phantoms during physical card transitions.
  const pendingMatchRef = useRef<string | null>(null);

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

      // 0.92 (was 0.85): this base JPEG feeds the on-device CLIP crop and the
      // server fallback upload. Fewer artifacts here = cleaner embeddings and a
      // better fallback image, and it preserves the detail the 1280px bump adds.
      const resized = await ImageManipulator.manipulateAsync(
        snapshotUri,
        [{ resize: { width: SCAN_SIZE } }],
        { compress: 0.92, format: ImageManipulator.SaveFormat.JPEG },
      );
      resizedUri = resized.uri;

      if (!isRunningRef.current) return;

      const allCandidates: CardOut[] = [];
      const ocrHint: ScanOcrHint = { raw_text: "", language, game };
      let topSim = 0; // best sim seen this frame — used by adaptive gate

      // --- Hybrid CLIP path (Phase 4a) ---
      // If this device supports on-device CLIP, embed locally and send only the
      // 512-dim vector. Falls back to image upload on any failure.
      const useHybrid = clipMode() === 'ondevice';
      let hybridSucceeded = false;

      if (useHybrid) {
        try {
          // YOLO detect, then crop to the card bounds before embedding.
          // embedCardOnDevice applies the art crop (y=12%-52%) relative to whatever
          // image it receives — passing the full frame causes it to crop the wrong region.
          const imgW = resized.width ?? SCAN_SIZE;
          const imgH = resized.height ?? SCAN_SIZE;
          const yoloResult = await detectCardsWithYolo(resizedUri, imgW, imgH);
          let cardUri = resizedUri;
          let cardW = imgW;
          let cardH = imgH;

          if (yoloResult && yoloResult.boxes.length > 0) {
            const box = yoloResult.boxes[0]; // sorted by confidence
            // Clamp the crop to image bounds. YOLO boxes can extend past the right/
            // bottom edge (left+width > imgW), which makes ImageManipulator reject
            // with "Context.renderAsync has been rejected" — that previously bubbled
            // up and forced a full-image upload. Clamp keeps the crop on-device.
            const left = Math.max(0, Math.min(box.left, imgW - 1));
            const top = Math.max(0, Math.min(box.top, imgH - 1));
            const width = Math.max(1, Math.min(box.width, imgW - left));
            const height = Math.max(1, Math.min(box.height, imgH - top));
            try {
              const cropped = await ImageManipulator.manipulateAsync(
                resizedUri,
                [{ crop: { originX: left, originY: top, width, height } }],
                { format: ImageManipulator.SaveFormat.JPEG, compress: 0.92 },
              );
              cardUri = cropped.uri;
              cardW = width;
              cardH = height;
            } catch (cropErr) {
              // Transient crop failure — skip this frame instead of uploading the
              // full image. The continuous loop retries on the next snapshot.
              console.warn('[useLiveScan] YOLO crop failed, skipping frame:', cropErr);
              pendingMatchRef.current = null;
              return;
            }
          }

          // Embed with on-device CLIP
          const embedResult = await embedCardOnDevice(cardUri, cardW, cardH);

          if (embedResult && isRunningRef.current) {
            try {
              let searchResults;
              let detectedLang: 'en' | 'ja' = language === 'auto' ? 'en' : language as 'en' | 'ja';
              if (language === 'auto') {
                const auto = await vectorSearchAuto(embedResult.embedding);
                searchResults = auto.results;
                detectedLang = auto.language;
                topSim = auto.results[0]?.sim ?? 0;
                console.log(`[useLiveScan] ondevice auto-lang=${auto.language} top-sim=${topSim.toFixed(3)}`);
              } else {
                searchResults = await vectorSearch(embedResult.embedding, language as 'en' | 'ja');
                topSim = searchResults[0]?.sim ?? 0;
                console.log(`[useLiveScan] ondevice lang=${language} top-sim=${topSim > 0 ? topSim.toFixed(3) : 'none'}`);
              }
              const candidates = await queryCardsByIds(searchResults);
              if (candidates.length > 0) {
                candidates.forEach(c => {
                  if (!allCandidates.find(x => x.id === c.id)) allCandidates.push(c);
                });
                hybridSucceeded = true;
              } else {
                // Score below floor (quantization drift) — fall back to server vector call
                console.log('[useLiveScan] on-device miss — server fallback');
                await api.scanVector(
                  Array.from(embedResult.embedding),
                  detectedLang,
                  'combined',
                  ocrHint,
                  CLIP_MODEL_VERSION,
                  null,
                  (result) => {
                    result.candidates?.forEach(c => {
                      if (!allCandidates.find(x => x.id === c.id)) allCandidates.push(c);
                    });
                  },
                );
                hybridSucceeded = true;
              }
            } catch (e) {
              console.warn('[useLiveScan] on-device search failed — falling back:', e);
            }
          }
        } catch (e) {
          console.warn('[useLiveScan] hybrid embed path failed — falling back:', e);
        }
      }

      // --- Server image-upload fallback ---
      // Used when: on-device CLIP not available, hybrid failed, or version mismatch.
      if (!hybridSucceeded && isRunningRef.current) {
        const imageBase64 = await FileSystem.readAsStringAsync(resizedUri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        await api.scanStream(
          { image: imageBase64 }, // no boxes — backend YOLO auto-detects
          [ocrHint],
          "combined",
          (result) => {
            result.candidates?.forEach((c) => {
              if (!allCandidates.find((x) => x.id === c.id)) allCandidates.push(c);
            });
          },
        );
      }

      if (!isRunningRef.current || allCandidates.length === 0) {
        pendingMatchRef.current = null;
        return;
      }

      const card = allCandidates[0];
      const cardId = String(card.id);

      // Confirmation gate: a card must match on two consecutive frames before
      // being added, filtering transient phantoms during card transitions.
      // Exception: skip the gate for high-confidence matches (topSim >= HIGH_CONF_SIM)
      // where phantom risk is negligible — saves one full scan cycle (~600ms).
      const isHighConf = topSim >= HIGH_CONF_SIM;
      if (pendingMatchRef.current !== cardId) {
        if (isHighConf) {
          console.log(`[useLiveScan] high-conf match sim=${topSim.toFixed(3)} — skipping gate`);
          // fall through to add immediately
        } else {
          pendingMatchRef.current = cardId;
          return;
        }
      }

      // Skip if we already added this card recently
      const lastSeen = seenCardTimesRef.current.get(cardId);
      if (lastSeen && Date.now() - lastSeen < RESCAN_COOLDOWN_MS) return;
      seenCardTimesRef.current.set(cardId, Date.now());

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

    } catch (e) {
      console.warn("[useLiveScan] scan cycle error:", e);
    } finally {
      if (snapshotUri) FileSystem.deleteAsync(snapshotUri, { idempotent: true }).catch(() => {});
      if (resizedUri) FileSystem.deleteAsync(resizedUri, { idempotent: true }).catch(() => {});
      isScanningRef.current = false;
      setIsScanning(false);
    }
  }, [game, scanType, language]);

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
    // Re-warm NNAPI's DSP context before the first real scan. NNAPI releases its
    // compiled DSP cache after idle periods; without this the first embed costs
    // ~800ms instead of ~250ms. Runs concurrently — loop starts immediately.
    warmUpClip();
    scheduleLoop();
  }, [scheduleLoop]);

  const stopDetection = useCallback(() => {
    isRunningRef.current = false;
    isScanningRef.current = false;
    setIsRunning(false);
    setIsScanning(false);
    pendingMatchRef.current = null;
    if (loopTimerRef.current) {
      clearTimeout(loopTimerRef.current);
      loopTimerRef.current = null;
    }
  }, []);

  const clearSession = useCallback(() => {
    setSessionCards([]);
    seenCardTimesRef.current.clear();
    pendingMatchRef.current = null;
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
