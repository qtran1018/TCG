import React, { useCallback, useEffect, useState } from "react";
import {
  View, Text, FlatList, StyleSheet, Image,
  ActivityIndicator, TouchableOpacity, Linking,
} from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { api, CardOut, CardWithPrice } from "@/services/api";
import { useScanStore } from "@/store/scanStore";
import { useCurrencyStore } from "@/store/currencyStore";
import { COLORS } from "@/constants";
import { saleLinkLabel } from "@/utils/saleLink";
import { fmtPrice } from "@/utils/currency";

interface CardPriceEntry {
  card: CardOut;
  jaCardNumber?: string;
  data: CardWithPrice | null;
  loading: boolean;
  error: boolean;
}

const keyExtractor = (item: CardPriceEntry) => String(item.card.id);


const openUrl = (url: string) => {
  Linking.openURL(url).catch((e) => console.warn("[batch-prices] openURL failed:", url, e));
};

export default function BatchPricesScreen() {
  const router = useRouter();
  const { batchPriceCards, scanType } = useScanStore();
  const { currency, jpyRate, fetching: rateFetching, setCurrency } = useCurrencyStore();
  const [entries, setEntries] = useState<CardPriceEntry[]>(
    batchPriceCards.map(({ card, jaCardNumber }) => ({
      card, jaCardNumber, data: null, loading: true, error: false,
    })),
  );

  useEffect(() => {
    if (batchPriceCards.length === 0) return;

    let cancelled = false;
    (async () => {
      // Single POST /cards/prices request replaces N independent /cards/{id}
      // calls. Backend resolves cache hits in parallel and serializes misses
      // through its own rate limiter.
      let items: Awaited<ReturnType<typeof api.batchPrices>> = [];
      try {
        const jaCardNumbers = Object.fromEntries(
          batchPriceCards
            .filter((bpc) => bpc.jaCardNumber)
            .map((bpc) => [bpc.card.id, bpc.jaCardNumber!]),
        );
        items = await api.batchPrices(
          batchPriceCards.map((bpc) => bpc.card.id),
          scanType,
          Object.keys(jaCardNumbers).length > 0 ? jaCardNumbers : undefined,
        );
      } catch (e) {
        console.warn("[batch-prices] batch fetch failed:", e);
      }
      if (cancelled) return;

      const byId = new Map(items.map((it) => [it.card_id, it]));
      setEntries((prev) =>
        prev.map((entry) => {
          const item = byId.get(entry.card.id);
          if (!item || item.error) {
            return { ...entry, loading: false, error: true };
          }
          return {
            ...entry,
            data: { card: item.card ?? entry.card, price: item.price },
            loading: false,
          };
        }),
      );
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: CardPriceEntry }) => (
      <CardPriceRow entry={item} scanType={scanType} currency={currency} jpyRate={jpyRate} />
    ),
    [scanType, currency, jpyRate],
  );

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
        <View style={styles.headerRow}>
          <Text style={styles.title}>Batch Prices</Text>
          <View style={styles.toggle}>
            <TouchableOpacity
              style={[styles.toggleBtn, currency === "USD" && styles.toggleBtnActive]}
              onPress={() => setCurrency("USD")}
            >
              <Text style={[styles.toggleText, currency === "USD" && styles.toggleTextActive]}>USD</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.toggleBtn, currency === "JPY" && styles.toggleBtnActive]}
              onPress={() => setCurrency("JPY")}
            >
              {rateFetching && currency !== "JPY" ? (
                <ActivityIndicator size={10} color={COLORS.textMuted} />
              ) : (
                <Text style={[styles.toggleText, currency === "JPY" && styles.toggleTextActive]}>JPY</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
        <Text style={styles.subtitle}>
          {entries.length} card{entries.length !== 1 ? "s" : ""}
          {totalLoading > 0 ? ` · fetching ${totalLoading}...` : ""}
          {currency === "JPY" && jpyRate != null ? ` · 1 USD = ¥${jpyRate.toFixed(0)}` : ""}
        </Text>
      </View>

      <FlatList
        data={entries}
        keyExtractor={keyExtractor}
        contentContainerStyle={styles.list}
        renderItem={renderItem}
        extraData={scanType}
      />
    </SafeAreaView>
  );
}

const CardPriceRow = React.memo(function CardPriceRow({
  entry,
  scanType,
  currency,
  jpyRate,
}: {
  entry: CardPriceEntry;
  scanType: string;
  currency: "USD" | "JPY";
  jpyRate: number | null;
}) {
  const { card, jaCardNumber, data, loading, error } = entry;
  const price = data?.price;
  const rawPrice = scanType === "psa" ? price?.price_graded_10 : price?.price_loose;
  const lastSale = price?.recent_sales?.[0];

  return (
    <View style={styles.row}>
      <View style={styles.cardImageWrap}>
        {(data?.card?.image_url ?? card.image_url) ? (
          <Image source={{ uri: data?.card?.image_url ?? card.image_url! }} style={styles.cardImage} resizeMode="contain" />
        ) : (
          <View style={[styles.cardImage, styles.imagePlaceholder]}>
            <Text style={styles.placeholderText}>?</Text>
          </View>
        )}
      </View>

      <View style={styles.cardInfo}>
        <Text style={styles.cardName} numberOfLines={2}>{data?.card?.name ?? card.name}</Text>
        {(data?.card?.set_name ?? card.set_name) && <Text style={styles.cardSet} numberOfLines={1}>{data?.card?.set_name ?? card.set_name}</Text>}
        <View style={styles.badges}>
          {(jaCardNumber ?? card.card_number) && (
            <Text style={styles.badge}>#{card.language === "ja" && jaCardNumber ? jaCardNumber : card.card_number}</Text>
          )}
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
                {fmtPrice(rawPrice, currency, jpyRate)}
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
                    {fmtPrice(lastSale.price, currency, jpyRate)}
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
});

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },
  header: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, gap: 4 },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  title: { color: COLORS.text, fontSize: 20, fontWeight: "800" },
  subtitle: { color: COLORS.textMuted, fontSize: 13 },
  toggle: {
    flexDirection: "row",
    backgroundColor: COLORS.bg,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    overflow: "hidden",
  },
  toggleBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    minWidth: 42,
    alignItems: "center",
    justifyContent: "center",
  },
  toggleBtnActive: { backgroundColor: COLORS.accent },
  toggleText: { color: COLORS.textMuted, fontSize: 12, fontWeight: "600" },
  toggleTextActive: { color: "#fff" },
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
