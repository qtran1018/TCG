import React, { useCallback, useRef, useState } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  Image, ActivityIndicator, Dimensions,
  Modal, ScrollView, Pressable,
} from "react-native";
import { useRouter, useFocusEffect } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Camera, useCameraDevice, useCameraPermission } from "react-native-vision-camera";
import { Ionicons } from "@expo/vector-icons";
import { useLiveScan } from "@/hooks/useLiveScan";
import type { LiveSessionCard } from "@/hooks/useLiveScan";
import { useScanStore } from "@/store/scanStore";
import { useCurrencyStore } from "@/store/currencyStore";
import { fmtPrice } from "@/utils/currency";
import { useColors } from "@/hooks/useColors";
import { COLORS } from "@/constants";
import type { Language } from "@/constants";

const VIEWFINDER_H = Dimensions.get("window").height * 0.38;

export default function LiveScanScreen() {
  const router = useRouter();
  const { game, scanType } = useScanStore();
  const { currency, jpyRate } = useCurrencyStore();
  const C = useColors();
  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice("back");

  const [liveLang, setLiveLang] = useState<Language>("en");

  const {
    cameraRef, sessionCards, isRunning, isScanning, totalValue,
    startDetection, stopDetection, clearSession, removeCard, swapCard,
  } = useLiveScan({ game, scanType, language: liveLang });

  const [swapTarget, setSwapTarget] = useState<LiveSessionCard | null>(null);

  useFocusEffect(
    useCallback(() => {
      return () => stopDetection();
    }, [stopDetection]),
  );

  const handleEndSession = useCallback(() => {
    stopDetection();
    const cards = sessionCards.filter((sc) => sc.card !== null);
    if (cards.length === 0) return;

    // Dedup by card.id, keeping the first occurrence (sessionCards is newest-first,
    // so first = most recently scanned or swapped by the user).
    const seen = new Set<number>();
    const deduped = cards.filter((sc) => {
      if (seen.has(sc.card!.id)) return false;
      seen.add(sc.card!.id);
      return true;
    });
    const duplicatesRemoved = cards.length - deduped.length;

    const { setBatchPriceCards } = useScanStore.getState();
    setBatchPriceCards(
      deduped.map((sc) => ({ card: sc.card!, jaCardNumber: undefined })),
      duplicatesRemoved,
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

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: C.bg }]} edges={["bottom"]}>
      {/* Camera viewfinder */}
      <View style={styles.viewfinder}>
        <Camera
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          device={device}
          isActive={true}
          photo={true}
        />

        {/* Scanning pulse border */}
        {isRunning && isScanning && (
          <View style={[StyleSheet.absoluteFill, styles.scanningBorder]} pointerEvents="none" />
        )}

        {/* Language lock toggle */}
        <View style={styles.langToggle}>
          {(["en", "ja"] as const).map((lng) => (
            <TouchableOpacity
              key={lng}
              style={[styles.langOption, liveLang === lng && styles.langOptionActive]}
              onPress={() => setLiveLang(lng)}
              activeOpacity={0.8}
            >
              <Text style={[styles.langOptionText, liveLang === lng && styles.langOptionTextActive]}>
                {lng === "en" ? "🇺🇸 EN" : "🇯🇵 JP"}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {!isRunning ? (
          <TouchableOpacity style={styles.startBtn} onPress={startDetection} activeOpacity={0.85}>
            <Ionicons name="radio-outline" size={28} color="#fff" />
            <Text style={styles.startBtnText}>Start Scanning</Text>
          </TouchableOpacity>
        ) : (
          <>
            <View style={styles.statusBadge}>
              {isScanning ? (
                <>
                  <ActivityIndicator size="small" color="#fff" />
                  <Text style={styles.statusText}>Scanning...</Text>
                </>
              ) : (
                <>
                  <View style={styles.statusDot} />
                  <Text style={styles.statusText}>Live</Text>
                </>
              )}
            </View>
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
            style={[styles.endBtn, { backgroundColor: readyCount > 0 ? C.accent : C.border }]}
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
          <SessionCardRow
            item={item}
            scanType={scanType}
            currency={currency}
            jpyRate={jpyRate}
            C={C}
            onRemove={() => removeCard(item.tempId)}
            onSwap={() => setSwapTarget(item)}
          />
        )}
        ListEmptyComponent={
          <View style={styles.emptyList}>
            <Text style={[styles.emptyText, { color: C.textMuted }]}>
              Point the camera at cards to begin scanning
            </Text>
          </View>
        }
      />

      {/* Swap modal */}
      <Modal
        visible={swapTarget !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setSwapTarget(null)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setSwapTarget(null)}>
          <Pressable style={[styles.modalSheet, { backgroundColor: C.surface }]} onPress={() => {}}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: C.text }]}>Choose correct card</Text>
              <TouchableOpacity onPress={() => setSwapTarget(null)}>
                <Ionicons name="close" size={22} color={C.textMuted} />
              </TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={styles.modalList}>
              {swapTarget?.candidates.map((candidate) => (
                <TouchableOpacity
                  key={candidate.id}
                  style={[
                    styles.modalRow,
                    { borderColor: C.border },
                    swapTarget.card?.id === candidate.id && { borderColor: C.accent, backgroundColor: C.accent + "18" },
                  ]}
                  onPress={() => {
                    swapCard(swapTarget.tempId, candidate);
                    setSwapTarget(null);
                  }}
                >
                  {candidate.image_url ? (
                    <Image source={{ uri: candidate.image_url }} style={styles.modalCardImage} resizeMode="contain" />
                  ) : (
                    <View style={[styles.modalCardImage, { backgroundColor: C.border, borderRadius: 4 }]} />
                  )}
                  <View style={styles.modalCardInfo}>
                    <Text style={[styles.modalCardName, { color: C.text }]} numberOfLines={1}>{candidate.name}</Text>
                    {candidate.set_name && (
                      <Text style={[styles.modalCardSub, { color: C.textMuted }]} numberOfLines={1}>{candidate.set_name}</Text>
                    )}
                    <Text style={[styles.modalCardNum, { color: C.accent }]}>
                      {candidate.language === "ja" ? "🇯🇵" : "🇺🇸"} {candidate.card_number ?? ""}
                    </Text>
                  </View>
                  {swapTarget.card?.id === candidate.id && (
                    <Ionicons name="checkmark-circle" size={20} color={C.accent} />
                  )}
                </TouchableOpacity>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

function SessionCardRow({
  item, scanType, currency, jpyRate, C, onRemove, onSwap,
}: {
  item: LiveSessionCard;
  scanType: string;
  currency: "USD" | "JPY";
  jpyRate: number | null;
  C: ReturnType<typeof useColors>;
  onRemove: () => void;
  onSwap: () => void;
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

  if (!item.card) return null;

  const { card, price, priceLoading, candidates } = item;
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
      <View style={styles.cardActions}>
        {candidates.length > 1 && (
          <TouchableOpacity style={styles.cardActionBtn} onPress={onSwap}>
            <Ionicons name="swap-horizontal-outline" size={16} color={C.accent} />
          </TouchableOpacity>
        )}
        <TouchableOpacity style={styles.cardActionBtn} onPress={onRemove}>
          <Ionicons name="close" size={16} color={C.textMuted} />
        </TouchableOpacity>
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
    height: VIEWFINDER_H,
    backgroundColor: "#000",
    overflow: "hidden",
  },
  scanningBorder: {
    borderWidth: 3,
    borderColor: "rgba(108,99,255,0.7)",
  },
  langToggle: {
    position: "absolute",
    top: 12,
    left: 12,
    flexDirection: "row",
    backgroundColor: "rgba(0,0,0,0.55)",
    borderRadius: 16,
    padding: 3,
    gap: 2,
  },
  langOption: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 13,
  },
  langOptionActive: {
    backgroundColor: "rgba(108,99,255,0.9)",
  },
  langOptionText: { color: "rgba(255,255,255,0.7)", fontSize: 12, fontWeight: "600" },
  langOptionTextActive: { color: "#fff", fontWeight: "700" },

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
  cardActions: { flexDirection: "column", gap: 6, alignItems: "center" },
  cardActionBtn: { padding: 4 },

  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  modalSheet: {
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    maxHeight: "70%",
    paddingBottom: 32,
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  modalTitle: { fontSize: 16, fontWeight: "700" },
  modalList: { paddingHorizontal: 16, gap: 10, paddingBottom: 8 },
  modalRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderWidth: 1,
    borderRadius: 12,
    padding: 10,
  },
  modalCardImage: { width: 44, height: 62 },
  modalCardInfo: { flex: 1, gap: 2 },
  modalCardName: { fontSize: 13, fontWeight: "700" },
  modalCardSub: { fontSize: 11 },
  modalCardNum: { fontSize: 11, fontWeight: "600" },
});
