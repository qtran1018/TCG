import React, { useEffect, useRef, useState } from "react";
import {
  Animated, Modal, StyleSheet, Text, TouchableOpacity,
  TouchableWithoutFeedback, useWindowDimensions, View,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { GAMES, type Game } from "@/constants";
import { useScanStore } from "@/store/scanStore";
import { useThemeStore } from "@/store/themeStore";
import { useColors } from "@/hooks/useColors";

const DRAWER_WIDTH_RATIO = 0.72;

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export function GameDrawer({ isOpen, onClose }: Props) {
  const { width } = useWindowDimensions();
  const drawerWidth = width * DRAWER_WIDTH_RATIO;
  const slideAnim = useRef(new Animated.Value(drawerWidth)).current;
  const [visible, setVisible] = useState(false);
  const router = useRouter();
  const { game, setGame } = useScanStore();
  const { theme, toggle: toggleTheme } = useThemeStore();
  const C = useColors();

  useEffect(() => {
    if (isOpen) {
      setVisible(true);
      Animated.timing(slideAnim, {
        toValue: 0,
        duration: 260,
        useNativeDriver: true,
      }).start();
    } else {
      Animated.timing(slideAnim, {
        toValue: drawerWidth,
        duration: 220,
        useNativeDriver: true,
      }).start(() => setVisible(false));
    }
  }, [isOpen, drawerWidth, slideAnim]);

  const handleSelectGame = (g: Game) => {
    setGame(g);
    onClose();
  };

  const handleNavigate = (path: string) => {
    onClose();
    setTimeout(() => router.push(path as any), 50);
  };

  const isDark = theme === "dark";

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <View style={styles.root}>
        <TouchableWithoutFeedback onPress={onClose}>
          <View style={styles.backdrop} />
        </TouchableWithoutFeedback>

        <Animated.View
          style={[
            styles.panel,
            {
              width: drawerWidth,
              transform: [{ translateX: slideAnim }],
              backgroundColor: C.surface,
              borderLeftColor: C.border,
            },
          ]}
        >
          {/* Header */}
          <View style={styles.drawerHeader}>
            <Text style={[styles.drawerTitle, { color: C.text }]}>TCG Scanner</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close" size={22} color={C.textMuted} />
            </TouchableOpacity>
          </View>

          {/* Game selector */}
          <Text style={[styles.sectionLabel, { color: C.textMuted }]}>Game</Text>
          {GAMES.map((g) => {
            const isActive = game === g.key;
            const accentColor = g.key === "pokemon" ? C.pokemon : C.onepiece;
            return (
              <TouchableOpacity
                key={g.key}
                style={[
                  styles.gameRow,
                  { backgroundColor: C.bg },
                  isActive && { borderLeftColor: accentColor, borderLeftWidth: 3 },
                ]}
                onPress={() => handleSelectGame(g.key)}
                activeOpacity={0.7}
              >
                <View style={[styles.gameColorDot, { backgroundColor: accentColor }]} />
                <Text style={[styles.gameLabel, { color: C.textMuted }, isActive && { color: C.text, fontWeight: "700" }]}>
                  {g.label}
                </Text>
                {isActive && (
                  <Ionicons name="checkmark" size={16} color={accentColor} style={styles.gameCheck} />
                )}
              </TouchableOpacity>
            );
          })}

          <View style={[styles.divider, { backgroundColor: C.border }]} />

          {/* Dark/light mode toggle */}
          <TouchableOpacity
            style={styles.navRow}
            onPress={toggleTheme}
            activeOpacity={0.7}
          >
            <Ionicons
              name={isDark ? "sunny-outline" : "moon-outline"}
              size={18}
              color={C.textMuted}
            />
            <Text style={[styles.navLabel, { color: C.textMuted }]}>
              {isDark ? "Light Mode" : "Dark Mode"}
            </Text>
            <View style={[styles.themeToggleTrack, { backgroundColor: isDark ? C.border : C.accent }]}>
              <View style={[
                styles.themeToggleThumb,
                { backgroundColor: C.surface },
                !isDark && styles.themeToggleThumbOn,
              ]} />
            </View>
          </TouchableOpacity>

          <View style={[styles.divider, { backgroundColor: C.border }]} />

          {/* Navigation links */}
          <TouchableOpacity
            style={styles.navRow}
            onPress={() => handleNavigate("/(tabs)/saved")}
            activeOpacity={0.7}
          >
            <Ionicons name="bookmark-outline" size={18} color={C.textMuted} />
            <Text style={[styles.navLabel, { color: C.textMuted }]}>Saved Cards</Text>
            <Ionicons name="chevron-forward" size={14} color={C.border} style={styles.navChevron} />
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.navRow}
            onPress={() => handleNavigate("/(tabs)/history")}
            activeOpacity={0.7}
          >
            <Ionicons name="time-outline" size={18} color={C.textMuted} />
            <Text style={[styles.navLabel, { color: C.textMuted }]}>Scan History</Text>
            <Ionicons name="chevron-forward" size={14} color={C.border} style={styles.navChevron} />
          </TouchableOpacity>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: "row", justifyContent: "flex-end" },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.55)" },
  panel: {
    height: "100%",
    paddingTop: 56,
    paddingHorizontal: 20,
    paddingBottom: 40,
    borderLeftWidth: 1,
    shadowColor: "#000",
    shadowOffset: { width: -4, height: 0 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 16,
  },
  drawerHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 28,
  },
  drawerTitle: { fontSize: 17, fontWeight: "700" },
  sectionLabel: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1,
    textTransform: "uppercase",
    marginBottom: 10,
  },
  gameRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 13,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderLeftWidth: 0,
    borderLeftColor: "transparent",
    marginBottom: 4,
  },
  gameColorDot: { width: 10, height: 10, borderRadius: 5, marginRight: 12 },
  gameLabel: { flex: 1, fontSize: 15, fontWeight: "500" },
  gameCheck: { marginLeft: 4 },
  divider: { height: 1, marginVertical: 16 },
  navRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 13,
    paddingHorizontal: 4,
    gap: 12,
  },
  navLabel: { flex: 1, fontSize: 14, fontWeight: "500" },
  navChevron: { marginLeft: "auto" },
  themeToggleTrack: {
    width: 38,
    height: 22,
    borderRadius: 11,
    justifyContent: "center",
    paddingHorizontal: 3,
  },
  themeToggleThumb: {
    width: 16,
    height: 16,
    borderRadius: 8,
  },
  themeToggleThumbOn: {
    alignSelf: "flex-end",
  },
});
