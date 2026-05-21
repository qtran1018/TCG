import React, { useMemo } from "react";
import { View, Text, StyleSheet, Dimensions } from "react-native";
import { LineChart } from "react-native-chart-kit";
import { COLORS } from "@/constants";
import type { PricePoint } from "@/services/api";
import type { Currency } from "@/store/currencyStore";
import { convertPriceHistory, chartYLabel } from "@/utils/currency";

interface Props {
  history: PricePoint[];
  label: string;
  currency?: Currency;
  jpyRate?: number | null;
}

const CHART_WIDTH = Dimensions.get("window").width - 48;

export function PriceChart({ history, label, currency = "USD", jpyRate = null }: Props) {
  const chart = useMemo(() => {
    if (!history || history.length < 2) return null;
    const points = convertPriceHistory(history.slice(-24), currency, jpyRate);
    const labelStep = Math.ceil(points.length / 6);
    const labels = points.map((p, i) => (i % labelStep === 0 ? p.date.slice(0, 7) : ""));
    const prices = points.map((p) => p.price);
    const maxPrice = Math.max(...prices);
    const decimalPlaces = currency === "JPY" ? 0 : maxPrice < 1 ? 2 : maxPrice < 10 ? 1 : 0;
    const formatYLabel = chartYLabel(currency, maxPrice);
    return { labels, prices, decimalPlaces, formatYLabel };
  }, [history, currency, jpyRate]);

  if (!chart) return null;
  const { labels, prices, decimalPlaces, formatYLabel } = chart;

  return (
    <View style={styles.container}>
      <Text style={styles.heading}>{label}</Text>
      <LineChart
        data={{ labels, datasets: [{ data: prices }] }}
        width={CHART_WIDTH}
        height={180}
        withDots={false}
        withInnerLines={false}
        withOuterLines={false}
        withShadow={false}
        formatYLabel={formatYLabel}
        chartConfig={{
          backgroundGradientFrom: COLORS.surface,
          backgroundGradientTo: COLORS.surface,
          color: () => COLORS.success,
          labelColor: () => COLORS.textMuted,
          propsForLabels: { fontSize: 9 },
          decimalPlaces,
        }}
        bezier
        style={styles.chart}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: 16,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    paddingTop: 12,
  },
  heading: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: "700",
    marginBottom: 8,
  },
  chart: {
    borderRadius: 8,
    marginLeft: -16,
  },
});
