export function saleLinkLabel(url: string): string {
  if (url.includes("tcgplayer")) return "TCGPlayer →";
  if (url.includes("ebay")) return "eBay →";
  return "View →";
}
