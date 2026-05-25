import React, { useState, useMemo } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Linking, ActivityIndicator } from "react-native";
import { COLORS } from "@/constants";
import type { PriceOut, SaleRecord } from "@/services/api";
import { PriceChart } from "./PriceChart";
import { saleLinkLabel } from "@/utils/saleLink";
import { useCurrencyStore } from "@/store/currencyStore";
import { fmtPrice } from "@/utils/currency";

type SaleFilter = "raw" | "7" | "8" | "9" | "10";

const SALE_FILTERS: { key: SaleFilter; label: string }[] = [
  { key: "raw", label: "Raw" },
  { key: "7", label: "PSA 7" },
  { key: "8", label: "PSA 8" },
  { key: "9", label: "PSA 9" },
  { key: "10", label: "PSA 10" },
];

// Any grading agency keyword — used to exclude from Raw
const GRADED_RE = /\b(PSA|BGS|CGC|SGC|graded?)\b/i;

const GRADE_RE: Record<string, RegExp> = {
  "7":  /\b(PSA|BGS|CGC|SGC)[\s\-]?7\b|grade[d]?\s*7\b|\b7\.0\b/i,
  "8":  /\b(PSA|BGS|CGC|SGC)[\s\-]?8\b|grade[d]?\s*8\b|\b8\.0\b/i,
  "9":  /\b(PSA|BGS|CGC|SGC)[\s\-]?9\b|grade[d]?\s*9\b|\b9\.0\b/i,
  "10": /\b(PSA|BGS|CGC|SGC)[\s\-]?10\b|grade[d]?\s*10\b|\b10\.0\b|gem[\s\-]?mint/i,
};

// Variant keyword patterns — matched against sale titles to partition sales by variant
const POKE_BALL_RE = /pok[eé][\s\-]?ball/i;
const MASTER_BALL_RE = /master[\s\-]?ball/i;

function filterSales(sales: SaleRecord[], filter: SaleFilter, variant: string): SaleRecord[] {
  let pool = sales;

  // On the Normal page, exclude variant sales that leaked in from PriceCharting's combined listing.
  // On variant pages the sales are already scoped by PriceCharting — no keyword filtering needed.
  if (variant === "normal") {
    pool = pool.filter((s) => !POKE_BALL_RE.test(s.title) && !MASTER_BALL_RE.test(s.title));
  }

  const filtered = filter === "raw"
    ? pool.filter((s) => !GRADED_RE.test(s.title))
    : pool.filter((s) => GRADE_RE[filter].test(s.title));
  return filtered.slice(0, 10);
}

interface Props {
  price: PriceOut;
  scanType: "raw" | "psa";
  variant?: string;
}

export function PriceDisplay({ price, scanType, variant = "normal" }: Props) {
  const { currency, jpyRate, fetching, setCurrency } = useCurrencyStore();
  const [saleFilter, setSaleFilter] = useState<SaleFilter>(scanType === "psa" ? "10" : "raw");

  const filteredSales = useMemo(
    () => filterSales(price.recent_sales ?? [], saleFilter, variant),
    [price.recent_sales, saleFilter, variant],
  );

  const priceRows = [
    { label: "Market (Raw)", value: price.price_loose, highlight: scanType === "raw" },
    { label: "PSA 7",  value: price.price_graded_7,  highlight: false },
    { label: "PSA 8",  value: price.price_graded_8,  highlight: false },
    { label: "PSA 9",  value: price.price_graded_9,  highlight: false },
    { label: "PSA 10", value: price.price_graded_10, highlight: scanType === "psa" },
  ];

  return (
    <View style={styles.container}>
      {/* Heading + currency toggle */}
      <View style={styles.headingRow}>
        <Text style={styles.heading}>Pricing</Text>
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
            {fetching && currency !== "JPY" ? (
              <ActivityIndicator size={10} color={COLORS.textMuted} />
            ) : (
              <Text style={[styles.toggleText, currency === "JPY" && styles.toggleTextActive]}>JPY</Text>
            )}
          </TouchableOpacity>
        </View>
      </View>

      {/* Price rows — always show all grades */}
      {priceRows.map((row) => (
        <View key={row.label} style={styles.row}>
          <Text style={styles.label}>{row.label}</Text>
          <Text style={[styles.value, row.highlight && styles.highlight]}>
            {fmtPrice(row.value, currency, jpyRate)}
          </Text>
        </View>
      ))}
      <Text style={styles.source}>
        Source: PriceCharting · {currency === "JPY" ? `1 USD = ¥${jpyRate?.toFixed(0) ?? "…"}` : "USD"}
      </Text>

      {/* Trend chart — follows the active grade filter */}
      {saleFilter === "raw"
        ? <PriceChart history={price.price_history_ungraded ?? []} label="Raw Price Trend" currency={currency} jpyRate={jpyRate} />
        : <PriceChart history={price.price_history_graded ?? []} label="Graded Price Trend" currency={currency} jpyRate={jpyRate} />
      }

      {/* Recent sales with grade filter */}
      {price.recent_sales && price.recent_sales.length > 0 && (
        <View style={styles.salesSection}>
          <View style={styles.salesHeaderRow}>
            <Text style={styles.salesHeading}>Recent Sales</Text>
          </View>

          {/* Filter tabs */}
          <View style={styles.filterRow}>
            {SALE_FILTERS.map((f) => (
              <TouchableOpacity
                key={f.key}
                style={[styles.filterTab, saleFilter === f.key && styles.filterTabActive]}
                onPress={() => setSaleFilter(f.key)}
                activeOpacity={0.7}
              >
                <Text style={[styles.filterTabText, saleFilter === f.key && styles.filterTabTextActive]}>
                  {f.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {filteredSales.length === 0 ? (
            <Text style={styles.noSales}>No recent {saleFilter === "raw" ? "raw" : `PSA ${saleFilter}`} sales found.</Text>
          ) : (
            filteredSales.map((sale, i) => (
              <View key={i} style={styles.saleRow}>
                <View style={styles.saleMeta}>
                  <Text style={styles.saleDate}>{sale.date}</Text>
                  <Text style={styles.saleTitle} numberOfLines={1}>{sale.title}</Text>
                </View>
                <View style={styles.salePriceWrap}>
                  <Text style={styles.salePrice}>{fmtPrice(sale.price, currency, jpyRate)}</Text>
                  {sale.url && (
                    <TouchableOpacity onPress={() => Linking.openURL(sale.url!).catch(() => {})}>
                      <Text style={styles.saleLink}>{saleLinkLabel(sale.url)}</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            ))
          )}
        </View>
      )}

    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: COLORS.surface,
    borderRadius: 14,
    padding: 16,
    marginTop: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  headingRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  heading: { color: COLORS.text, fontSize: 16, fontWeight: "700" },
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
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  label: { color: COLORS.textMuted, fontSize: 14 },
  value: { color: COLORS.text, fontSize: 14, fontWeight: "600" },
  highlight: { color: COLORS.success, fontSize: 15, fontWeight: "700" },
  source: { color: COLORS.textMuted, fontSize: 11, marginTop: 8, textAlign: "right" },

  salesSection: {
    marginTop: 16,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    paddingTop: 12,
  },
  salesHeaderRow: {
    marginBottom: 10,
  },
  salesHeading: { color: COLORS.text, fontSize: 14, fontWeight: "700" },

  filterRow: {
    flexDirection: "row",
    gap: 6,
    marginBottom: 10,
    flexWrap: "wrap",
  },
  filterTab: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.bg,
  },
  filterTabActive: {
    backgroundColor: COLORS.accent,
    borderColor: COLORS.accent,
  },
  filterTabText: { color: COLORS.textMuted, fontSize: 12, fontWeight: "600" },
  filterTabTextActive: { color: "#fff" },

  noSales: {
    color: COLORS.textMuted,
    fontSize: 12,
    fontStyle: "italic",
    paddingVertical: 8,
  },

  saleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    gap: 8,
  },
  saleMeta: { flex: 1 },
  saleDate: { color: COLORS.textMuted, fontSize: 11 },
  saleTitle: { color: COLORS.text, fontSize: 12 },
  salePriceWrap: { alignItems: "flex-end", gap: 2, flexShrink: 0 },
  salePrice: { color: COLORS.text, fontSize: 13, fontWeight: "600" },
  saleLink: { color: COLORS.accent, fontSize: 11, fontWeight: "600" },
});
