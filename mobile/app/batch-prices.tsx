import React, { useEffect, useState } from "react";
import {
  View, Text, FlatList, StyleSheet, Image,
  ActivityIndicator, TouchableOpacity, Linking,
} from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { api, CardOut, CardWithPrice } from "@/services/api";
import { useScanStore } from "@/store/scanStore";
import { COLORS } from "@/constants";
import { saleLinkLabel } from "@/utils/saleLink";

interface CardPriceEntry {
  card: CardOut;
  data: CardWithPrice | null;
  loading: boolean;
  error: boolean;
}

export default function BatchPricesScreen() {
  const router = useRouter();
  const { batchPriceCards, scanType, language } = useScanStore();
  const [entries, setEntries] = useState<CardPriceEntry[]>(
    batchPriceCards.map((card) => ({ card, data: null, loading: true, error: false })),
  );

  useEffect(() => {
    if (batchPriceCards.length === 0) return;

    let cancelled = false;
    (async () => {
      const settled = await Promise.allSettled(
        batchPriceCards.map((card) => api.getCard(card.id, scanType, language)),
      );
      if (cancelled) return;
      // Single setState — replaces N independent updates that re-rendered the
      // FlatList for every individual price resolution.
      setEntries((prev) =>
        prev.map((entry, i) => {
          const res = settled[i];
          if (res.status === "fulfilled") {
            return { ...entry, data: res.value, loading: false };
          }
          return { ...entry, loading: false, error: true };
        }),
      );
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (batchPriceCards.length === 0) {
    return (
      <SafeAreaView style={styles.safe} edges={["bottom"]}>
        <View style={styles.empty}>
          <Text style={styles.emptyText}>No cards selected.</Text>
          <TouchableOpacity onPress={() => router.back()}>
            <Text style={styles.backLink}>← Go Back</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const totalLoading = entries.filter((e) => e.loading).length;

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      <View style={styles.header}>
        <Text style={styles.title}>Batch Prices</Text>
        <Text style={styles.subtitle}>
          {entries.length} card{entries.length !== 1 ? "s" : ""}
          {totalLoading > 0 ? ` · fetching ${totalLoading}...` : ""}
        </Text>
      </View>

      <FlatList
        data={entries}
        keyExtractor={(item) => String(item.card.id)}
        contentContainerStyle={styles.list}
        renderItem={({ item: entry }) => <CardPriceRow entry={entry} scanType={scanType} />}
      />
    </SafeAreaView>
  );
}

function CardPriceRow({ entry, scanType }: { entry: CardPriceEntry; scanType: string }) {
  const { card, data, loading, error } = entry;
  const price = data?.price;
  const rawPrice = scanType === "psa" ? price?.price_graded_10 : price?.price_loose;
  const lastSale = price?.recent_sales?.[0];

  const openUrl = (url: string) => {
    Linking.openURL(url).catch(() => {});
  };

  return (
    <View style={styles.row}>
      <View style={styles.cardImageWrap}>
        {card.image_url ? (
          <Image source={{ uri: card.image_url }} style={styles.cardImage} resizeMode="contain" />
        ) : (
          <View style={[styles.cardImage, styles.imagePlaceholder]}>
            <Text style={styles.placeholderText}>?</Text>
          </View>
        )}
      </View>

      <View style={styles.cardInfo}>
        <Text style={styles.cardName} numberOfLines={2}>{card.name}</Text>
        {card.set_name && <Text style={styles.cardSet} numberOfLines={1}>{card.set_name}</Text>}
        <View style={styles.badges}>
          {card.card_number && <Text style={styles.badge}>#{card.card_number}</Text>}
          {card.rarity && <Text style={styles.badge}>{card.rarity}</Text>}
        </View>

        {loading ? (
          <ActivityIndicator size="small" color={COLORS.accent} style={styles.loader} />
        ) : error ? (
          <Text style={styles.errorText}>Price unavailable</Text>
        ) : (
          <View style={styles.priceSection}>
            <View style={styles.priceRow}>
              <Text style={styles.priceLabel}>{scanType === "psa" ? "PSA 10" : "Market"}</Text>
              <Text style={styles.priceValue}>
                {rawPrice != null ? `$${rawPrice.toFixed(2)}` : "N/A"}
              </Text>
            </View>

            {lastSale && (
              <View style={styles.lastSaleRow}>
                <View style={styles.lastSaleInfo}>
                  <Text style={styles.lastSaleLabel}>Last Sold</Text>
                  <Text style={styles.lastSaleDate}>{lastSale.date}</Text>
                  <Text style={styles.lastSaleTitle} numberOfLines={1}>{lastSale.title}</Text>
                </View>
                <View style={styles.lastSaleRight}>
                  <Text style={styles.lastSalePrice}>
                    {lastSale.price != null ? `$${lastSale.price.toFixed(2)}` : "N/A"}
                  </Text>
                  {lastSale.url && (
                    <TouchableOpacity onPress={() => openUrl(lastSale.url!)}>
                      <Text style={styles.ebayLink}>{saleLinkLabel(lastSale.url)}</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            )}
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },
  header: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, gap: 4 },
  title: { color: COLORS.text, fontSize: 20, fontWeight: "800" },
  subtitle: { color: COLORS.textMuted, fontSize: 13 },
  list: { padding: 16, gap: 12, paddingBottom: 40 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16 },
  emptyText: { color: COLORS.textMuted, fontSize: 15 },
  backLink: { color: COLORS.accent, fontSize: 15, fontWeight: "600" },

  row: {
    flexDirection: "row",
    gap: 12,
    backgroundColor: COLORS.surface,
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  cardImageWrap: { alignItems: "center" },
  cardImage: { width: 72, height: 100, borderRadius: 6 },
  imagePlaceholder: {
    backgroundColor: COLORS.border,
    alignItems: "center",
    justifyContent: "center",
  },
  placeholderText: { color: COLORS.textMuted, fontSize: 24 },

  cardInfo: { flex: 1, gap: 4 },
  cardName: { color: COLORS.text, fontSize: 14, fontWeight: "700" },
  cardSet: { color: COLORS.textMuted, fontSize: 12 },
  badges: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  badge: {
    color: COLORS.accent, fontSize: 11,
    backgroundColor: "rgba(108,99,255,0.15)",
    paddingHorizontal: 5, paddingVertical: 2, borderRadius: 4,
  },
  loader: { marginTop: 8, alignSelf: "flex-start" },
  errorText: { color: COLORS.error, fontSize: 12, marginTop: 6 },

  priceSection: { marginTop: 4, gap: 6 },
  priceRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  priceLabel: { color: COLORS.textMuted, fontSize: 12 },
  priceValue: { color: COLORS.success, fontSize: 15, fontWeight: "700" },

  lastSaleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    backgroundColor: COLORS.bg,
    borderRadius: 8,
    padding: 8,
    gap: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  lastSaleInfo: { flex: 1, gap: 2 },
  lastSaleLabel: { color: COLORS.textMuted, fontSize: 10, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5 },
  lastSaleDate: { color: COLORS.textMuted, fontSize: 11 },
  lastSaleTitle: { color: COLORS.text, fontSize: 11 },
  lastSaleRight: { alignItems: "flex-end", gap: 4 },
  lastSalePrice: { color: COLORS.text, fontSize: 13, fontWeight: "700" },
  ebayLink: { color: COLORS.accent, fontSize: 11, fontWeight: "600" },
});
