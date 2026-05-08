import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { COLORS } from "@/constants";
import type { PriceOut, SaleRecord } from "@/services/api";
import { PriceChart } from "./PriceChart";

interface Props {
  price: PriceOut;
  scanType: "raw" | "psa";
}

function fmt(val: number | undefined): string {
  if (val == null) return "N/A";
  return `$${val.toFixed(2)}`;
}

export function PriceDisplay({ price, scanType }: Props) {
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
      <Text style={styles.heading}>Pricing</Text>
      {rows.map((row) => (
        <View key={row.label} style={styles.row}>
          <Text style={styles.label}>{row.label}</Text>
          <Text style={[styles.value, row.highlight && styles.highlight]}>{fmt(row.value)}</Text>
        </View>
      ))}
      <Text style={styles.source}>Source: PriceCharting</Text>

      {price.recent_sales && price.recent_sales.length > 0 && (
        <View style={styles.salesSection}>
          <Text style={styles.salesHeading}>Recent Sales</Text>
          {price.recent_sales.map((sale, i) => (
            <View key={i} style={styles.saleRow}>
              <View style={styles.saleMeta}>
                <Text style={styles.saleDate}>{sale.date}</Text>
                <Text style={styles.saleTitle} numberOfLines={1}>{sale.title}</Text>
              </View>
              <Text style={styles.salePrice}>{sale.price != null ? `$${sale.price.toFixed(2)}` : "N/A"}</Text>
            </View>
          ))}
        </View>
      )}

      {scanType === "psa"
        ? <PriceChart history={price.price_history_graded ?? []} label="Graded Price Trend" />
        : <PriceChart history={price.price_history_ungraded ?? []} label="Ungraded Price Trend" />
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
  heading: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: "700",
    marginBottom: 12,
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
  salePrice: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: "600",
    flexShrink: 0,
  },
});
