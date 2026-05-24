import React, { useCallback, useEffect, useRef } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  Image, ActivityIndicator, LayoutChangeEvent,
} from "react-native";
import { useRouter, useFocusEffect } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Camera, useCameraDevice, useCameraPermission } from "react-native-vision-camera";
import { Ionicons } from "@expo/vector-icons";
import { LiveBoundingBox } from "@/components/Scanner/LiveBoundingBox";
import { StabilityRing } from "@/components/Scanner/StabilityRing";
import { useLiveScan } from "@/hooks/useLiveScan";
import type { LiveSessionCard } from "@/hooks/useLiveScan";
import { useScanStore } from "@/store/scanStore";
import { useCurrencyStore } from "@/store/currencyStore";
import { fmtPrice } from "@/utils/currency";
import { useColors } from "@/hooks/useColors";
import { COLORS } from "@/constants";

const VIEWFINDER_RATIO = 0.58; // fraction of screen height for the camera

export default function LiveScanScreen() {
  const router = useRouter();
  const { game, scanType } = useScanStore();
  const { currency, jpyRate } = useCurrencyStore();
  const C = useColors();
  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice("back");

  const {
    cameraRef, sessionCards, box, boxState, stabilityProgress, snapDims,
    isRunning, isCapturing, totalValue, startDetection, stopDetection, clearSession,
  } = useLiveScan({ game, scanType });

  const viewfinderDims = useRef({ width: 1, height: 1 });

  const onViewfinderLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    viewfinderDims.current = { width, height };
  }, []);

  // Stop detection when leaving the screen (never auto-start)
  useFocusEffect(
    useCallback(() => {
      return () => stopDetection();
    }, [stopDetection]),
  );

  const handleEndSession = useCallback(() => {
    stopDetection();
    const cards = sessionCards.filter((sc) => sc.card !== null);
    if (cards.length === 0) return;

    // Navigate to batch-prices with session cards
    const { setBatchPriceCards } = useScanStore.getState();
    setBatchPriceCards(
      cards.map((sc) => ({ card: sc.card!, jaCardNumber: undefined })),
    );
    router.push("/batch-prices");
  }, [sessionCards, stopDetection, router]);

  if (!hasPermission) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: C.bg }]}>
        <View style={styles.centered}>
          <Text style={[styles.permText, { color: C.textMuted }]}>
            Camera permission is required for Live Scan.
          </Text>
          <TouchableOpacity style={[styles.permBtn, { backgroundColor: C.accent }]} onPress={requestPermission}>
            <Text style={styles.permBtnText}>Grant Permission</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (!device) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: C.bg }]}>
        <View style={styles.centered}>
          <Text style={[styles.permText, { color: C.textMuted }]}>No camera available.</Text>
        </View>
      </SafeAreaView>
    );
  }

  const readyCount = sessionCards.filter((sc) => sc.card !== null).length;
  const loadingCount = sessionCards.filter((sc) => sc.scanning).length;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: C.bg }]} edges={["bottom"]}>
      {/* Camera viewfinder */}
      <View style={styles.viewfinder} onLayout={onViewfinderLayout}>
        <Camera
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          device={device}
          isActive={true}
          photo={true}
        />

        <LiveBoundingBox
          box={box}
          state={boxState}
          viewWidth={viewfinderDims.current.width}
          viewHeight={viewfinderDims.current.height}
          imageWidth={snapDims.width}
          imageHeight={snapDims.height}
        />

        <StabilityRing progress={stabilityProgress} visible={box !== null && !isCapturing} />

        {/* Start / Stop overlay */}
        {!isRunning ? (
          <TouchableOpacity style={styles.startBtn} onPress={startDetection} activeOpacity={0.85}>
            <Ionicons name="radio-outline" size={28} color="#fff" />
            <Text style={styles.startBtnText}>Start Scanning</Text>
          </TouchableOpacity>
        ) : (
          <>
            {/* Status badge */}
            <View style={styles.statusBadge}>
              {isCapturing ? (
                <>
                  <ActivityIndicator size="small" color="#fff" />
                  <Text style={styles.statusText}>Scanning...</Text>
                </>
              ) : box ? (
                <>
                  <View style={styles.statusDot} />
                  <Text style={styles.statusText}>Hold still...</Text>
                </>
              ) : (
                <Text style={styles.statusText}>Point at a card</Text>
              )}
            </View>
            {/* Stop button */}
            <TouchableOpacity style={styles.stopBtn} onPress={stopDetection} activeOpacity={0.8}>
              <Ionicons name="stop-circle-outline" size={20} color="#fff" />
              <Text style={styles.stopBtnText}>Stop</Text>
            </TouchableOpacity>
          </>
        )}
      </View>

      {/* Session footer */}
      <View style={[styles.sessionBar, { backgroundColor: C.surface, borderTopColor: C.border }]}>
        <View style={styles.sessionBarLeft}>
          <Text style={[styles.sessionCount, { color: C.text }]}>
            {readyCount} card{readyCount !== 1 ? "s" : ""}
            {loadingCount > 0 ? ` · ${loadingCount} scanning` : ""}
          </Text>
          {readyCount > 0 && (
            <Text style={[styles.sessionTotal, { color: C.accent }]}>
              {fmtPrice(totalValue, currency, jpyRate)}
            </Text>
          )}
        </View>
        <View style={styles.sessionBarRight}>
          {readyCount > 0 && (
            <TouchableOpacity
              style={[styles.clearBtn, { borderColor: C.border }]}
              onPress={clearSession}
            >
              <Ionicons name="trash-outline" size={16} color={C.textMuted} />
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[
              styles.endBtn,
              { backgroundColor: readyCount > 0 ? C.accent : C.border },
            ]}
            onPress={handleEndSession}
            disabled={readyCount === 0}
          >
            <Text style={[styles.endBtnText, readyCount === 0 && { color: C.textMuted }]}>
              Done ({readyCount})
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Session card list */}
      <FlatList
        data={sessionCards}
        keyExtractor={(item) => item.tempId}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        renderItem={({ item }) => (
          <SessionCardRow item={item} scanType={scanType} currency={currency} jpyRate={jpyRate} C={C} />
        )}
        ListEmptyComponent={
          <View style={styles.emptyList}>
            <Text style={[styles.emptyText, { color: C.textMuted }]}>
              Point the camera at cards to begin scanning
            </Text>
          </View>
        }
      />
    </SafeAreaView>
  );
}

function SessionCardRow({
  item, scanType, currency, jpyRate, C,
}: {
  item: LiveSessionCard;
  scanType: string;
  currency: "USD" | "JPY";
  jpyRate: number | null;
  C: ReturnType<typeof useColors>;
}) {
  if (item.scanning) {
    return (
      <View style={[styles.cardRow, { backgroundColor: C.surface, borderColor: C.border }]}>
        <View style={[styles.cardImagePlaceholder, { backgroundColor: C.border }]} />
        <View style={styles.cardInfo}>
          <ActivityIndicator size="small" color={C.accent} />
          <Text style={[styles.cardSub, { color: C.textMuted }]}>Identifying...</Text>
        </View>
      </View>
    );
  }

  if (item.error || !item.card) {
    return (
      <View style={[styles.cardRow, { backgroundColor: C.surface, borderColor: C.border }]}>
        <View style={[styles.cardImagePlaceholder, { backgroundColor: C.border }]}>
          <Text style={{ color: C.textMuted, fontSize: 18 }}>?</Text>
        </View>
        <View style={styles.cardInfo}>
          <Text style={[styles.cardName, { color: COLORS.error }]}>Could not identify</Text>
          <Text style={[styles.cardSub, { color: C.textMuted }]}>Try scanning again</Text>
        </View>
      </View>
    );
  }

  const { card, price, priceLoading } = item;
  const priceValue = scanType === "psa" ? price?.price_graded_10 : price?.price_loose;

  return (
    <View style={[styles.cardRow, { backgroundColor: C.surface, borderColor: C.border }]}>
      {card.image_url ? (
        <Image source={{ uri: card.image_url }} style={styles.cardImage} resizeMode="contain" />
      ) : (
        <View style={[styles.cardImagePlaceholder, { backgroundColor: C.border }]} />
      )}
      <View style={styles.cardInfo}>
        <Text style={[styles.cardName, { color: C.text }]} numberOfLines={1}>{card.name}</Text>
        {card.set_name && (
          <Text style={[styles.cardSub, { color: C.textMuted }]} numberOfLines={1}>{card.set_name}</Text>
        )}
        <View style={styles.cardBottom}>
          <Text style={[styles.cardNumber, { color: C.accent }]}>
            {card.language === "ja" ? "🇯🇵" : "🇺🇸"} {card.card_number ?? ""}
          </Text>
          {priceLoading ? (
            <ActivityIndicator size="small" color={C.accent} />
          ) : (
            <Text style={[styles.cardPrice, { color: COLORS.success }]}>
              {fmtPrice(priceValue, currency, jpyRate)}
            </Text>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 16 },
  permText: { textAlign: "center", fontSize: 15 },
  permBtn: { paddingHorizontal: 24, paddingVertical: 12, borderRadius: 10 },
  permBtnText: { color: "#fff", fontWeight: "600", fontSize: 14 },

  viewfinder: {
    width: "100%",
    aspectRatio: 3 / 4,
    backgroundColor: "#000",
    overflow: "hidden",
  },

  startBtn: {
    position: "absolute",
    bottom: 24,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "rgba(108,99,255,0.9)",
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: 32,
  },
  startBtnText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  stopBtn: {
    position: "absolute",
    bottom: 16,
    right: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(0,0,0,0.6)",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
  },
  stopBtnText: { color: "#fff", fontSize: 13, fontWeight: "600" },
  statusBadge: {
    position: "absolute",
    top: 12,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(0,0,0,0.55)",
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: "#50dc64",
  },
  statusText: { color: "#fff", fontSize: 13, fontWeight: "600" },

  sessionBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderTopWidth: 1,
    gap: 10,
  },
  sessionBarLeft: { flex: 1, gap: 2 },
  sessionBarRight: { flexDirection: "row", alignItems: "center", gap: 8 },
  sessionCount: { fontSize: 13, fontWeight: "600" },
  sessionTotal: { fontSize: 16, fontWeight: "800" },
  clearBtn: {
    width: 34,
    height: 34,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  endBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
  },
  endBtnText: { color: "#fff", fontWeight: "700", fontSize: 13 },

  list: { flex: 1 },
  listContent: { padding: 12, gap: 10, paddingBottom: 32 },
  emptyList: { padding: 32, alignItems: "center" },
  emptyText: { textAlign: "center", fontSize: 14, lineHeight: 22 },

  cardRow: {
    flexDirection: "row",
    gap: 12,
    borderRadius: 12,
    padding: 10,
    borderWidth: 1,
    alignItems: "center",
  },
  cardImage: { width: 52, height: 72, borderRadius: 4 },
  cardImagePlaceholder: {
    width: 52,
    height: 72,
    borderRadius: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  cardInfo: { flex: 1, gap: 3 },
  cardName: { fontSize: 13, fontWeight: "700" },
  cardSub: { fontSize: 11 },
  cardBottom: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 4 },
  cardNumber: { fontSize: 11, fontWeight: "600" },
  cardPrice: { fontSize: 14, fontWeight: "800" },
});
