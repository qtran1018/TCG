import { useEffect } from "react";
import { Stack } from "expo-router";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { StatusBar } from "expo-status-bar";
import { StyleSheet } from "react-native";
import { COLORS } from "@/constants";
import { probeClipCapability } from "@/utils/clipEmbedder";
import { useAssetUpdater } from "@/hooks/useAssetUpdater";

export default function RootLayout() {
  useAssetUpdater();

  useEffect(() => {
    // Warm the capability probe so clipMode() is ready before the first scan.
    // Runs once per install / per model version bump — result persisted in AsyncStorage.
    probeClipCapability().catch(() => {});
  }, []);

  return (
    <GestureHandlerRootView style={styles.root}>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: COLORS.bg },
          headerTintColor: COLORS.text,
          headerShadowVisible: false,
          contentStyle: { backgroundColor: COLORS.bg },
          animation: "slide_from_right",
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen
          name="multi-results"
          options={{ title: "Scan Results", headerBackTitle: "Back" }}
        />
        <Stack.Screen
          name="batch-prices"
          options={{ title: "Batch Prices", headerBackTitle: "Back" }}
        />
        <Stack.Screen
          name="card/[id]"
          options={{ title: "Card Detail", headerBackTitle: "Back" }}
        />
      </Stack>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({ root: { flex: 1 } });
