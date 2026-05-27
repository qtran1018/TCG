// Set EXPO_PUBLIC_API_URL in .env.local to override (e.g. http://10.0.2.2:8000/api/v1 for Android emulator)
export const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://192.168.1.2:8000/api/v1";

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

export const LIGHT_COLORS = {
  bg: "#f2f2f7",
  surface: "#ffffff",
  border: "#d8d8e8",
  accent: "#5a52e0",
  accentDim: "#e0deff",
  text: "#0f0f14",
  textMuted: "#666677",
  success: "#2a8c56",
  warning: "#b08000",
  error: "#c04040",
  pokemon: "#c49a00",
  onepiece: "#b01015",
} as const;

export type ColorSet = typeof COLORS;
