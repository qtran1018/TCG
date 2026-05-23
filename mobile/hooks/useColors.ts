import { COLORS, LIGHT_COLORS } from "@/constants";
import { useThemeStore } from "@/store/themeStore";

export function useColors() {
  const theme = useThemeStore((s) => s.theme);
  return theme === "dark" ? COLORS : LIGHT_COLORS;
}
