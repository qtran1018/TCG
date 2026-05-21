import type { Currency } from "@/store/currencyStore";

export function fmtPrice(
  usd: number | null | undefined,
  currency: Currency,
  rate: number | null,
): string {
  if (usd == null) return "N/A";
  if (currency === "JPY" && rate != null) {
    return `¥${Math.round(usd * rate).toLocaleString()}`;
  }
  return `$${usd.toFixed(2)}`;
}

/** Convert a USD price point array to JPY for chart display. */
export function convertPriceHistory(
  history: { date: string; price: number }[],
  currency: Currency,
  rate: number | null,
): { date: string; price: number }[] {
  if (currency === "USD" || rate == null) return history;
  return history.map((p) => ({ date: p.date, price: Math.round(p.price * rate) }));
}

/** Y-axis label formatter for the chart, currency-aware. */
export function chartYLabel(currency: Currency, maxPrice: number): (v: string) => string {
  if (currency === "JPY") {
    return (v: string) => {
      const n = Number(v);
      return maxPrice >= 10000
        ? `¥${Math.round(n / 1000)}k`
        : `¥${Math.round(n).toLocaleString()}`;
    };
  }
  return (v: string) => {
    const n = Number(v);
    return maxPrice < 1 ? `$${n.toFixed(2)}` : maxPrice < 10 ? `$${n.toFixed(1)}` : `$${n.toFixed(0)}`;
  };
}
