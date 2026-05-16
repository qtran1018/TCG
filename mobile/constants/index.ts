// Replace with your machine's local IP when testing on a physical device
// For Android emulator use: http://10.0.2.2:8000
// For physical device use: http://<your-local-ip>:8000
export const API_BASE_URL = "http://192.168.1.2:8000/api/v1";

export const GAMES = [
  { key: "pokemon", label: "Pokémon" },
  { key: "onepiece", label: "One Piece" },
] as const;

export type Game = (typeof GAMES)[number]["key"];

export const LANGUAGES = [
  { key: "en", label: "English", flag: "🇺🇸" },
  { key: "ja", label: "日本語", flag: "🇯🇵" },
] as const;

export type Language = (typeof LANGUAGES)[number]["key"];

export const SCAN_TYPES = [
  { key: "raw", label: "Raw" },
  { key: "psa", label: "PSA Slab" },
] as const;

export type ScanType = (typeof SCAN_TYPES)[number]["key"];

export const COLORS = {
  bg: "#0f0f14",
  surface: "#1a1a24",
  border: "#2a2a38",
  accent: "#6c63ff",
  accentDim: "#3d3880",
  text: "#f0f0f5",
  textMuted: "#888899",
  success: "#4caf7d",
  warning: "#f0b429",
  error: "#e05050",
  pokemon: "#ffcb05",
  onepiece: "#d4151a",
} as const;
