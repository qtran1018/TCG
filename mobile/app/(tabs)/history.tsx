import React, { useEffect, useState, useCallback } from "react";
import {
  View, Text, FlatList, StyleSheet, TouchableOpacity, RefreshControl,
  ActivityIndicator, Image,
} from "react-native";
import { Stack, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { api, HistoryEntry } from "@/services/api";
import { useColors } from "@/hooks/useColors";

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

// Deduplicate by card_id, keeping only the most recent entry per card.
// Entries without a card_id are kept as-is (unresolved scans).
function dedupe(entries: HistoryEntry[]): HistoryEntry[] {
  const seen = new Set<number>();
  const result: HistoryEntry[] = [];
  for (const e of entries) {
    if (e.card_id == null) {
      result.push(e);
    } else if (!seen.has(e.card_id)) {
      seen.add(e.card_id);
      result.push(e);
    }
  }
  return result;
}

const PAGE_SIZE = 50;

export default function HistoryScreen() {
  const router = useRouter();
  const C = useColors();
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  // Track all seen card_ids across pages so loadMore can skip already-shown cards
  const [seenIds, setSeenIds] = useState<Set<number>>(new Set());

  const load = useCallback(async () => {
    try {
      const data = await api.getHistory(PAGE_SIZE);
      const deduped = dedupe(data);
      const ids = new Set(deduped.map((e) => e.card_id).filter((id): id is number => id != null));
      setEntries(deduped);
      setSeenIds(ids);
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
      const rawEntries = entries.concat(); // preserve for cursor
      const last = rawEntries[rawEntries.length - 1];
      const data = await api.getHistory(PAGE_SIZE, 0, last.id);
      setEntries((prev) => {
        const newEntries = data.filter(
          (e) => e.card_id == null || !seenIds.has(e.card_id),
        );
        const merged = [...prev, ...newEntries];
        return merged;
      });
      setSeenIds((prev) => {
        const next = new Set(prev);
        data.forEach((e) => { if (e.card_id != null) next.add(e.card_id); });
        return next;
      });
      setHasMore(data.length === PAGE_SIZE);
    } catch (e) {
      console.warn("[history] loadMore failed:", e);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, hasMore, entries, seenIds]);

  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load();
  }, [load]);

  const handlePress = (item: HistoryEntry) => {
    if (!item.card_id) return;
    router.push({
      pathname: "/card/[id]",
      params: { id: String(item.card_id), language: item.language },
    });
  };

  if (!isLoading && entries.length === 0) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: C.bg }]} edges={["bottom"]}>
        <Stack.Screen options={{ title: "Scan History" }} />
        <View style={styles.empty}>
          <Text style={[styles.emptyText, { color: C.text }]}>No scans yet.</Text>
          <Text style={[styles.emptyHint, { color: C.textMuted }]}>Scan a card to see it here.</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: C.bg }]} edges={["bottom"]}>
      <Stack.Screen options={{ title: "Scan History" }} />
      <FlatList
        data={entries}
        keyExtractor={(item) => String(item.id)}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.accent} />
        }
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={[styles.row, { backgroundColor: C.surface, borderColor: C.border }]}
            onPress={() => handlePress(item)}
            activeOpacity={item.card_id ? 0.7 : 1}
          >
            {item.image_url ? (
              <Image source={{ uri: item.image_url }} style={styles.thumb} resizeMode="contain" />
            ) : (
              <View style={[styles.thumb, styles.thumbPlaceholder, { backgroundColor: C.border }]} />
            )}
            <View style={styles.rowLeft}>
              <Text style={[styles.cardName, { color: C.text }]} numberOfLines={1}>
                {item.resolved_card_name ?? "Unknown Card"}
              </Text>
              <Text style={[styles.meta, { color: C.textMuted }]} numberOfLines={1}>
                {item.set_name ?? (item.game === "pokemon" ? "Pokémon" : "One Piece")}
                {item.card_number ? ` · ${item.card_number}` : ""}
              </Text>
              <Text style={[styles.metaMuted, { color: C.textMuted }]}>{timeAgo(item.scanned_at)}</Text>
            </View>
            <View style={styles.rowRight}>
              {item.scan_type === "psa" ? (
                <Text style={[styles.price, { color: C.success }]}>{fmt(item.price_graded_10)}</Text>
              ) : (
                <Text style={[styles.price, { color: C.success }]}>{fmt(item.price_loose)}</Text>
              )}
              <Text style={[styles.priceLabel, { color: C.textMuted }]}>
                {item.scan_type === "psa" ? "PSA 10" : "Market"}
              </Text>
            </View>
          </TouchableOpacity>
        )}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        onEndReached={loadMore}
        onEndReachedThreshold={0.4}
        ListFooterComponent={
          loadingMore ? (
            <ActivityIndicator size="small" color={C.accent} style={styles.footer} />
          ) : null
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  list: { padding: 16, paddingBottom: 32 },
  row: {
    flexDirection: "row",
    borderRadius: 12,
    padding: 10,
    alignItems: "center",
    borderWidth: 1,
    gap: 10,
  },
  thumb: { width: 44, height: 62, borderRadius: 4 },
  thumbPlaceholder: {},
  rowLeft: { flex: 1, gap: 3 },
  cardName: { fontSize: 14, fontWeight: "600" },
  meta: { fontSize: 11 },
  metaMuted: { fontSize: 11, opacity: 0.7 },
  rowRight: { alignItems: "flex-end", gap: 2 },
  price: { fontSize: 16, fontWeight: "700" },
  priceLabel: { fontSize: 10 },
  separator: { height: 8 },
  footer: { paddingVertical: 16 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8 },
  emptyText: { fontSize: 18, fontWeight: "700" },
  emptyHint: { fontSize: 14 },
});
