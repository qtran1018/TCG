import React from "react";
import { View, Text, StyleSheet, TouchableOpacity, Linking, ActivityIndicator } from "react-native";
import { COLORS } from "@/constants";
import type { PriceOut } from "@/services/api";
import { PriceChart } from "./PriceChart";
import { saleLinkLabel } from "@/utils/saleLink";
import { useCurrencyStore } from "@/store/currencyStore";
import { fmtPrice } from "@/utils/currency";

interface Props {
  price: PriceOut;
  scanType: "raw" | "psa";
}

export function PriceDisplay({ price, scanType }: Props) {
  const { currency, jpyRate, fetching, setCurrency } = useCurrencyStore();

  const rows =
    scanType === "psa"
      ? [
          { label: "PSA 7", value: price.price_graded_7 },
          { label: "PSA 8", value: price.price_graded_8 },
          { label: "PSA 9", value: price.price_graded_9 },
          { label: "PSA 10", value: price.price_graded_10, highlight: true },
        ]
      : [
          { label: "Market (Raw)", value: price.price_loose, highlight: true },
          { label: "Complete", value: price.price_cib },
        ];

  return (
    <View style={styles.container}>
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

      {rows.map((row) => (
        <View key={row.label} style={styles.row}>
          <Text style={styles.label}>{row.label}</Text>
          <Text style={[styles.value, row.highlight && styles.highlight]}>
            {fmtPrice(row.value, currency, jpyRate)}
          </Text>
        </View>
      ))}
      <Text style={styles.source}>Source: PriceCharting · {currency === "JPY" ? `1 USD = ¥${jpyRate?.toFixed(0) ?? "…"}` : "USD"}</Text>

      {price.recent_sales && price.recent_sales.length > 0 && (
        <View style={styles.salesSection}>
          <Text style={styles.salesHeading}>Recent Sales</Text>
          {price.recent_sales.map((sale, i) => (
            <View key={i} style={styles.saleRow}>
              <View style={styles.saleMeta}>
                <Text style={styles.saleDate}>{sale.date}</Text>
                <Text style={styles.saleTitle} numberOfLines={1}>{sale.title}</Text>
              </View>
              <View style={styles.salePriceWrap}>
                <Text style={styles.salePrice}>{fmtPrice(sale.price, currency, jpyRate)}</Text>
                {sale.url && (
                  <TouchableOpacity onPress={() => Linking.openURL(sale.url!).catch((e) => console.warn("[price-display] openURL failed:", sale.url, e))}>
                    <Text style={styles.saleLink}>{saleLinkLabel(sale.url)}</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
          ))}
        </View>
      )}

      {scanType === "psa"
        ? <PriceChart history={price.price_history_graded ?? []} label="Graded Price Trend" currency={currency} jpyRate={jpyRate} />
        : <PriceChart history={price.price_history_ungraded ?? []} label="Ungraded Price Trend" currency={currency} jpyRate={jpyRate} />
      }
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
  heading: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: "700",
  },
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
  toggleBtnActive: {
    backgroundColor: COLORS.accent,
  },
  toggleText: {
    color: COLORS.textMuted,
    fontSize: 12,
    fontWeight: "600",
  },
  toggleTextActive: {
    color: "#fff",
  },
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
  source: {
    color: COLORS.textMuted,
    fontSize: 11,
    marginTop: 8,
    textAlign: "right",
  },
  salesSection: {
    marginTop: 16,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    paddingTop: 12,
  },
  salesHeading: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: "700",
    marginBottom: 8,
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
  saleMeta: {
    flex: 1,
  },
  saleDate: {
    color: COLORS.textMuted,
    fontSize: 11,
  },
  saleTitle: {
    color: COLORS.text,
    fontSize: 12,
  },
  salePriceWrap: {
    alignItems: "flex-end",
    gap: 2,
    flexShrink: 0,
  },
  salePrice: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: "600",
  },
  saleLink: {
    color: COLORS.accent,
    fontSize: 11,
    fontWeight: "600",
  },
});
