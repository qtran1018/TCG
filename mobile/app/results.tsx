import React, { useState } from "react";
import {
  View, Text, FlatList, StyleSheet, TouchableOpacity, Alert,
} from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { CardListItem } from "@/components/Card/CardListItem";
import { useScanStore } from "@/store/scanStore";
import { api } from "@/services/api";
import { COLORS } from "@/constants";
import type { CardOut } from "@/services/api";

export default function ResultsScreen() {
  const router = useRouter();
  const { lastSearchResult, lastOcrText, scanType, game, language, setSelectedCard } = useScanStore();
  const [selected, setSelected] = useState<CardOut | null>(null);
  const [isConfirming, setIsConfirming] = useState(false);

  const candidates = lastSearchResult?.candidates ?? [];

  const handleSelect = (card: CardOut) => {
    setSelected((prev) => (prev?.id === card.id ? null : card));
  };

  const handleConfirm = async () => {
    if (!selected) {
      Alert.alert("Select a Card", "Tap a card to select it before confirming.");
      return;
    }
    setIsConfirming(true);
    try {
      setSelectedCard(selected);
      // Save to history
      await api.saveHistory({
        card_id: selected.id,
        game,
        scan_type: scanType,
        language,
        ocr_text: lastOcrText,
        resolved_card_name: selected.name,
      });
    } catch {
      // History save failure is non-critical; proceed anyway
    }
    setIsConfirming(false);
    router.push({ pathname: "/card/[id]", params: { id: String(selected.id) } });
  };

  if (candidates.length === 0) {
    return (
      <SafeAreaView style={styles.safe} edges={["bottom"]}>
        <View style={styles.empty}>
          <Text style={styles.emptyText}>No candidates found.</Text>
          <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
            <Text style={styles.backBtnText}>← Try Again</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      <View style={styles.header}>
        <Text style={styles.subtitle}>
          {candidates.length} result{candidates.length !== 1 ? "s" : ""} · tap to select
        </Text>
        {lastSearchResult?.query_used && (
          <Text style={styles.query} numberOfLines={1}>
            "{lastSearchResult.query_used}"
          </Text>
        )}
      </View>

      <FlatList
        data={candidates}
        keyExtractor={(item) => String(item.id)}
        renderItem={({ item }) => (
          <CardListItem
            card={item}
            onPress={handleSelect}
            selected={selected?.id === item.id}
          />
        )}
        contentContainerStyle={styles.list}
        ItemSeparatorComponent={() => null}
      />

      <View style={styles.footer}>
        <TouchableOpacity
          style={[styles.confirmBtn, (!selected || isConfirming) && styles.btnDisabled]}
          onPress={handleConfirm}
          disabled={!selected || isConfirming}
          activeOpacity={0.8}
        >
          <Text style={styles.confirmBtnText}>
            {isConfirming ? "Loading..." : selected ? `View "${selected.name}"` : "Select a Card"}
          </Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },
  header: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12, gap: 4 },
  subtitle: { color: COLORS.textMuted, fontSize: 13 },
  query: { color: COLORS.accent, fontSize: 13, fontStyle: "italic" },
  list: { paddingHorizontal: 16, paddingBottom: 100 },
  footer: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    padding: 16,
    paddingBottom: 32,
    backgroundColor: COLORS.bg,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
  confirmBtn: {
    backgroundColor: COLORS.accent,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
  },
  confirmBtnText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  btnDisabled: { opacity: 0.45 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16 },
  emptyText: { color: COLORS.textMuted, fontSize: 16 },
  backBtn: { paddingHorizontal: 24, paddingVertical: 12 },
  backBtnText: { color: COLORS.accent, fontSize: 15, fontWeight: "600" },
});
