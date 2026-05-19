import React, { useState, useCallback } from "react";
import {
  View, Text, FlatList, StyleSheet, TouchableOpacity,
  Image, Modal, ScrollView, ActivityIndicator,
} from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { useScanStore } from "@/store/scanStore";
import { COLORS } from "@/constants";
import type { CardOut } from "@/services/api";
import type { DetectedCard } from "@/types/scan";

const CHECKMARK = "✓";

export default function MultiResultsScreen() {
  const router = useRouter();
  const {
    multiScanResult,
    multiScanLoading,
    multiScanError,
    multiScanTotalRegions,
    language,
    setBatchPriceCards,
  } = useScanStore();

  const cards = multiScanResult?.cards ?? [];

  const [selections, setSelections] = useState<Record<number, CardOut>>({});
  const [swapTarget, setSwapTarget] = useState<DetectedCard | null>(null);
  const [checkedIndices, setCheckedIndices] = useState<Set<number>>(new Set());

  const getSelected = useCallback(
    (dc: DetectedCard): CardOut | undefined =>
      selections[dc.regionIndex] ?? dc.searchResult.candidates[0],
    [selections],
  );

  const handleViewCard = useCallback(
    (card: CardOut, dc?: DetectedCard) => {
      router.push({
        pathname: "/card/[id]",
        params: {
          id: String(card.id),
          language,
          ...(dc?.kanaName && { kana_name: dc.kanaName }),
          ...(dc?.setTotal && { set_total: String(dc.setTotal) }),
          ...(dc?.cardNumber && { card_number: dc.cardNumber }),
        },
      });
    },
    [router, language],
  );

  const handleSwapSelect = useCallback((dc: DetectedCard, card: CardOut) => {
    setSelections((prev) => ({ ...prev, [dc.regionIndex]: card }));
    setSwapTarget(null);
  }, []);

  const toggleCheck = useCallback((regionIndex: number) => {
    setCheckedIndices((prev) => {
      const next = new Set(prev);
      if (next.has(regionIndex)) next.delete(regionIndex);
      else next.add(regionIndex);
      return next;
    });
  }, []);

  const allChecked = cards.length > 0 && checkedIndices.size === cards.length;

  const toggleAll = useCallback(() => {
    setCheckedIndices((prev) =>
      prev.size === cards.length ? new Set() : new Set(cards.map((dc) => dc.regionIndex)),
    );
  }, [cards]);

  const handleGetPrices = useCallback(() => {
    const selected = cards
      .filter((dc) => checkedIndices.has(dc.regionIndex))
      .map((dc) => getSelected(dc))
      .filter((c): c is CardOut => !!c);
    if (selected.length === 0) return;
    setBatchPriceCards(selected);
    router.push({ pathname: "/batch-prices" });
  }, [cards, checkedIndices, getSelected, setBatchPriceCards, router]);

  const handleOpenSwap = useCallback((dc: DetectedCard) => setSwapTarget(dc), []);

  // Loading state — navigated here before scan completed, no cards yet
  if (multiScanLoading && cards.length === 0) {
    return (
      <SafeAreaView style={styles.safe} edges={["bottom"]}>
        <View style={styles.header}>
          <Text style={styles.title}>Multi-Scan Results</Text>
          <Text style={styles.subtitle}>Scanning cards...</Text>
        </View>
        <View style={styles.loadingCenter}>
          <ActivityIndicator size="large" color={COLORS.accent} />
          <Text style={styles.loadingCenterText}>Identifying cards...</Text>
        </View>
      </SafeAreaView>
    );
  }

  // Error state — scan finished with no results
  if (!multiScanLoading && multiScanError && cards.length === 0) {
    return (
      <SafeAreaView style={styles.safe} edges={["bottom"]}>
        <View style={styles.empty}>
          <Text style={styles.emptyText}>{multiScanError}</Text>
          <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
            <Text style={styles.backBtnText}>← Try Again</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // Empty state — scan finished with no identifiable cards
  if (!multiScanLoading && cards.length === 0) {
    return (
      <SafeAreaView style={styles.safe} edges={["bottom"]}>
        <View style={styles.empty}>
          <Text style={styles.emptyText}>No cards found.</Text>
          <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
            <Text style={styles.backBtnText}>← Try Again</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const totalRegions = multiScanResult?.totalRegionsFound ?? multiScanTotalRegions;
  const skipped = totalRegions > cards.length ? totalRegions - cards.length : 0;

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      <View style={styles.header}>
        <Text style={styles.title}>Multi-Scan Results</Text>
        <Text style={styles.subtitle}>
          {cards.length} card{cards.length !== 1 ? "s" : ""} identified
          {skipped > 0 ? ` · ${skipped} region${skipped !== 1 ? "s" : ""} skipped` : ""}
        </Text>
        {cards.length > 0 && !multiScanLoading && (
          <View style={styles.batchRow}>
            <TouchableOpacity style={styles.selectAllBtn} onPress={toggleAll}>
              <Text style={styles.selectAllText}>
                {allChecked ? "Deselect All" : "Select All"}
              </Text>
            </TouchableOpacity>
            {checkedIndices.size > 0 && (
              <TouchableOpacity style={styles.getPricesBtn} onPress={handleGetPrices}>
                <Text style={styles.getPricesBtnText}>
                  Get Prices ({checkedIndices.size})
                </Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </View>

      <FlatList
        data={cards}
        keyExtractor={(item) => String(item.regionIndex)}
        contentContainerStyle={styles.list}
        renderItem={({ item: dc, index }) => (
          <ResultRow
            dc={dc}
            index={index}
            isChecked={checkedIndices.has(dc.regionIndex)}
            selected={getSelected(dc)}
            onToggle={toggleCheck}
            onView={handleViewCard}
            onSwap={handleOpenSwap}
          />
        )}
        ListFooterComponent={
          multiScanLoading ? (
            <View style={styles.loadingFooter}>
              <ActivityIndicator size="small" color={COLORS.accent} />
              <Text style={styles.loadingFooterText}>Finding more cards...</Text>
            </View>
          ) : null
        }
      />

      {/* Swap modal */}
      <Modal
        visible={!!swapTarget}
        transparent
        animationType="slide"
        onRequestClose={() => setSwapTarget(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>Select correct card</Text>
            <ScrollView style={styles.modalList}>
              {swapTarget?.searchResult.candidates.map((c) => (
                <TouchableOpacity
                  key={c.id}
                  style={[
                    styles.modalItem,
                    getSelected(swapTarget)?.id === c.id && styles.modalItemSelected,
                  ]}
                  onPress={() => handleSwapSelect(swapTarget, c)}
                >
                  {c.image_url ? (
                    <Image source={{ uri: c.image_url }} style={styles.modalImage} resizeMode="contain" />
                  ) : (
                    <View style={[styles.modalImage, styles.imagePlaceholder]}>
                      <Text style={styles.placeholderText}>?</Text>
                    </View>
                  )}
                  <View style={styles.modalInfo}>
                    <Text style={styles.modalName} numberOfLines={2}>{c.name}</Text>
                    <Text style={styles.modalSet} numberOfLines={1}>{c.set_name}</Text>
                    {c.card_number && <Text style={styles.badge}>#{c.card_number}</Text>}
                  </View>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <TouchableOpacity style={styles.modalClose} onPress={() => setSwapTarget(null)}>
              <Text style={styles.modalCloseText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

interface ResultRowProps {
  dc: DetectedCard;
  index: number;
  isChecked: boolean;
  selected: CardOut | undefined;
  onToggle: (regionIndex: number) => void;
  onView: (card: CardOut, dc: DetectedCard) => void;
  onSwap: (dc: DetectedCard) => void;
}

const ResultRow = React.memo(function ResultRow({
  dc, index, isChecked, selected, onToggle, onView, onSwap,
}: ResultRowProps) {
  const hasAlternates = dc.searchResult.candidates.length > 1;
  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={() => onToggle(dc.regionIndex)}
      style={[styles.card, isChecked && styles.cardChecked]}
    >
      <View style={styles.cardHeader}>
        <View style={[styles.checkbox, isChecked && styles.checkboxChecked]}>
          {isChecked && <Text style={styles.checkboxMark}>{CHECKMARK}</Text>}
        </View>
        <Text style={styles.cardIndex}>Card {index + 1}</Text>
        {dc.matchSource && (
          <Text style={[
            styles.sourceBadge,
            dc.matchSource === "both" ? styles.sourceBoth
            : dc.matchSource === "image" ? styles.sourceImage
            : dc.matchSource === "image:low" ? styles.sourceImageLow
            : styles.sourceOcr,
          ]}>
            {dc.matchSource === "both" ? "Both ✓"
              : dc.matchSource === "image" ? "Image AI"
              : dc.matchSource === "image:low" ? "Image ?"
              : "OCR"}
          </Text>
        )}
        <Text style={styles.queryUsed} numberOfLines={1}>🔍 {dc.searchResult.query_used}</Text>
      </View>
      <View style={styles.cardRow}>
        {selected?.image_url ? (
          <Image source={{ uri: selected.image_url }} style={styles.image} resizeMode="contain" />
        ) : (
          <View style={styles.imagePlaceholder}>
            <Text style={styles.placeholderText}>?</Text>
          </View>
        )}
        <View style={styles.info}>
          <Text style={styles.name} numberOfLines={2}>{selected?.name ?? "Unknown"}</Text>
          {selected?.set_name && (
            <Text style={styles.setName} numberOfLines={1}>{selected.set_name}</Text>
          )}
          <View style={styles.badges}>
            {selected?.card_number && (
              <Text style={styles.badge}>#{selected.card_number}</Text>
            )}
            {selected?.rarity && (
              <Text style={styles.badge}>{selected.rarity}</Text>
            )}
          </View>
          <View style={styles.actions}>
            <TouchableOpacity
              style={styles.viewBtn}
              onPress={(e) => { e.stopPropagation?.(); selected && onView(selected, dc); }}
            >
              <Text style={styles.viewBtnText}>View Price</Text>
            </TouchableOpacity>
            {hasAlternates && (
              <TouchableOpacity
                style={styles.swapBtn}
                onPress={(e) => { e.stopPropagation?.(); onSwap(dc); }}
              >
                <Text style={styles.swapBtnText}>
                  Swap ({dc.searchResult.candidates.length})
                </Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </View>
    </TouchableOpacity>
  );
});

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },
  header: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, gap: 4 },
  title: { color: COLORS.text, fontSize: 20, fontWeight: "800" },
  subtitle: { color: COLORS.textMuted, fontSize: 13 },
  batchRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 6 },
  selectAllBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: COLORS.border },
  selectAllText: { color: COLORS.textMuted, fontSize: 12, fontWeight: "600" },
  getPricesBtn: { backgroundColor: COLORS.accent, paddingHorizontal: 14, paddingVertical: 6, borderRadius: 8 },
  getPricesBtnText: { color: "#fff", fontSize: 12, fontWeight: "700" },
  list: { padding: 16, gap: 12, paddingBottom: 40 },

  // Loading states
  loadingCenter: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16 },
  loadingCenterText: { color: COLORS.textMuted, fontSize: 15 },
  loadingFooter: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: 10, paddingVertical: 20,
  },
  loadingFooterText: { color: COLORS.textMuted, fontSize: 13 },

  card: {
    backgroundColor: COLORS.surface,
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    gap: 8,
  },
  cardChecked: { borderColor: COLORS.accent, backgroundColor: COLORS.accentDim },
  checkbox: {
    width: 20, height: 20, borderRadius: 5,
    borderWidth: 1.5, borderColor: COLORS.border,
    alignItems: "center", justifyContent: "center",
    marginRight: 2,
  },
  checkboxChecked: { backgroundColor: COLORS.accent, borderColor: COLORS.accent },
  checkboxMark: { color: "#fff", fontSize: 11, fontWeight: "800" },
  cardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  cardIndex: { color: COLORS.textMuted, fontSize: 11, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.8 },
  sourceBadge: { fontSize: 10, fontWeight: "700", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, marginLeft: 8 },
  sourceBoth: { color: "#22c55e", backgroundColor: "rgba(34,197,94,0.15)" },
  sourceImage: { color: COLORS.accent, backgroundColor: "rgba(108,99,255,0.15)" },
  sourceImageLow: { color: "#94a3b8", backgroundColor: "rgba(148,163,184,0.15)" },
  sourceOcr: { color: "#f59e0b", backgroundColor: "rgba(245,158,11,0.15)" },
  queryUsed: { color: COLORS.textMuted, fontSize: 11, flex: 1, textAlign: "right", marginLeft: 8 },
  cardRow: { flexDirection: "row", gap: 12 },
  image: { width: 72, height: 100, borderRadius: 6 },
  imagePlaceholder: {
    width: 72, height: 100, borderRadius: 6,
    backgroundColor: COLORS.border,
    alignItems: "center", justifyContent: "center",
  },
  placeholderText: { color: COLORS.textMuted, fontSize: 24 },
  info: { flex: 1, gap: 4, justifyContent: "center" },
  name: { color: COLORS.text, fontSize: 15, fontWeight: "600" },
  setName: { color: COLORS.textMuted, fontSize: 12 },
  badges: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  badge: {
    color: COLORS.accent, fontSize: 11,
    backgroundColor: "rgba(108,99,255,0.15)",
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4,
  },
  actions: { flexDirection: "row", gap: 8, marginTop: 4 },
  viewBtn: {
    backgroundColor: COLORS.accent,
    borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6,
  },
  viewBtnText: { color: "#fff", fontSize: 12, fontWeight: "700" },
  swapBtn: {
    borderWidth: 1, borderColor: COLORS.border,
    borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6,
  },
  swapBtnText: { color: COLORS.textMuted, fontSize: 12 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16 },
  emptyText: { color: COLORS.textMuted, fontSize: 16, textAlign: "center", paddingHorizontal: 32 },
  backBtn: { paddingHorizontal: 24, paddingVertical: 12 },
  backBtnText: { color: COLORS.accent, fontSize: 15, fontWeight: "600" },
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.7)", justifyContent: "flex-end" },
  modalSheet: {
    backgroundColor: COLORS.surface,
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: 16, maxHeight: "75%",
  },
  modalTitle: { color: COLORS.text, fontSize: 16, fontWeight: "700", marginBottom: 12 },
  modalList: { flexGrow: 1, flexShrink: 1 },
  modalItem: {
    flexDirection: "row", gap: 12, padding: 10,
    borderRadius: 10, marginBottom: 8,
    backgroundColor: COLORS.bg, borderWidth: 1.5, borderColor: COLORS.border,
  },
  modalItemSelected: { borderColor: COLORS.accent, backgroundColor: COLORS.accentDim },
  modalImage: { width: 52, height: 72, borderRadius: 4 },
  modalInfo: { flex: 1, gap: 4, justifyContent: "center" },
  modalName: { color: COLORS.text, fontSize: 14, fontWeight: "600" },
  modalSet: { color: COLORS.textMuted, fontSize: 12 },
  modalClose: {
    marginTop: 12, padding: 14, borderRadius: 12,
    backgroundColor: COLORS.border, alignItems: "center",
  },
  modalCloseText: { color: COLORS.text, fontWeight: "600" },
});
