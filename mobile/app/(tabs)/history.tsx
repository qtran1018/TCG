import React, { useEffect, useState, useCallback } from "react";
import {
  View, Text, FlatList, StyleSheet, TouchableOpacity, RefreshControl,
  ActivityIndicator,
} from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { api, HistoryEntry } from "@/services/api";
import { COLORS } from "@/constants";

function fmt(val?: number): string {
  if (val == null) return "—";
  return `$${val.toFixed(2)}`;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const PAGE_SIZE = 50;

export default function HistoryScreen() {
  const router = useRouter();
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await api.getHistory(PAGE_SIZE);
      setEntries(data);
      setHasMore(data.length === PAGE_SIZE);
    } catch (e) {
      console.warn("[history] load failed:", e);
    } finally {
      setIsLoading(false);
      setRefreshing(false);
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || entries.length === 0) return;
    setLoadingMore(true);
    try {
      const last = entries[entries.length - 1];
      const data = await api.getHistory(PAGE_SIZE, 0, last.id);
      setEntries((prev) => [...prev, ...data]);
      setHasMore(data.length === PAGE_SIZE);
    } catch (e) {
      console.warn("[history] loadMore failed:", e);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, hasMore, entries]);

  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load();
  }, [load]);

  if (!isLoading && entries.length === 0) {
    return (
      <SafeAreaView style={styles.safe} edges={["bottom"]}>
        <View style={styles.empty}>
          <Text style={styles.emptyText}>No scans yet.</Text>
          <Text style={styles.emptyHint}>Scan a card to see it here.</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      <FlatList
        data={entries}
        keyExtractor={(item) => String(item.id)}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.accent} />}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <View style={styles.rowLeft}>
              <Text style={styles.cardName} numberOfLines={1}>
                {item.resolved_card_name ?? "Unknown Card"}
              </Text>
              <Text style={styles.meta}>
                {item.game === "pokemon" ? "Pokémon" : "One Piece"} ·{" "}
                {item.scan_type === "psa" ? "PSA" : "Raw"} ·{" "}
                {item.language.toUpperCase()} · {timeAgo(item.scanned_at)}
              </Text>
            </View>
            <View style={styles.rowRight}>
              {item.scan_type === "psa" ? (
                <Text style={styles.price}>{fmt(item.price_graded_10)}</Text>
              ) : (
                <Text style={styles.price}>{fmt(item.price_loose)}</Text>
              )}
              <Text style={styles.priceLabel}>{item.scan_type === "psa" ? "PSA 10" : "Market"}</Text>
            </View>
          </View>
        )}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        onEndReached={loadMore}
        onEndReachedThreshold={0.4}
        ListFooterComponent={
          loadingMore ? (
            <ActivityIndicator size="small" color={COLORS.accent} style={styles.footer} />
          ) : null
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },
  list: { padding: 16, paddingBottom: 32 },
  row: {
    flexDirection: "row",
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    padding: 14,
    justifyContent: "space-between",
    alignItems: "center",
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  rowLeft: { flex: 1, gap: 4, paddingRight: 12 },
  cardName: { color: COLORS.text, fontSize: 15, fontWeight: "600" },
  meta: { color: COLORS.textMuted, fontSize: 11 },
  rowRight: { alignItems: "flex-end", gap: 2 },
  price: { color: COLORS.success, fontSize: 16, fontWeight: "700" },
  priceLabel: { color: COLORS.textMuted, fontSize: 10 },
  separator: { height: 8 },
  footer: { paddingVertical: 16 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8 },
  emptyText: { color: COLORS.text, fontSize: 18, fontWeight: "700" },
  emptyHint: { color: COLORS.textMuted, fontSize: 14 },
});
