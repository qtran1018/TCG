import React, { useState } from "react";
import { TouchableOpacity, View } from "react-native";
import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { GameDrawer } from "@/components/UI/GameDrawer";
import { useScanStore } from "@/store/scanStore";
import { useColors } from "@/hooks/useColors";

function GameDot() {
  const game = useScanStore((s) => s.game);
  const C = useColors();
  const color = game === "pokemon" ? C.pokemon : C.onepiece;
  return (
    <View
      style={{
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: color,
        position: "absolute",
        bottom: -1,
        right: -1,
      }}
    />
  );
}

export default function TabLayout() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const C = useColors();

  const hamburger = () => (
    <TouchableOpacity
      onPress={() => setDrawerOpen(true)}
      style={{ marginRight: 16, position: "relative" }}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
    >
      <Ionicons name="menu-outline" size={24} color={C.text} />
      <GameDot />
    </TouchableOpacity>
  );

  return (
    <>
      <Tabs
        screenOptions={{
          headerStyle: { backgroundColor: C.bg },
          headerTintColor: C.text,
          headerShadowVisible: false,
          headerRight: hamburger,
          tabBarStyle: {
            backgroundColor: C.surface,
            borderTopColor: C.border,
          },
          tabBarActiveTintColor: C.accent,
          tabBarInactiveTintColor: C.textMuted,
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: "Multi Scan",
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="scan-outline" size={size} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="live-scan"
          options={{
            title: "Live Scan",
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="radio-outline" size={size} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="lookup"
          options={{
            title: "Search",
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="search-outline" size={size} color={color} />
            ),
          }}
        />
        {/* Hidden tabs — still routable but not shown in tab bar */}
        <Tabs.Screen name="saved" options={{ href: null }} />
        <Tabs.Screen name="history" options={{ href: null }} />
      </Tabs>

      <GameDrawer isOpen={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </>
  );
}
