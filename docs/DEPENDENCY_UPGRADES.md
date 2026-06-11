# Dependency Upgrades

Do last — after live scan and new features are stable. Run `expo upgrade` to handle the coordinated Expo + React Native bump (do not bump those manually).

Safe minor/patch upgrades performed 2026-05-26: `axios` 1.7.0 → 1.16.1, `react-native-nitro-modules` 0.35.6 → 0.35.7. `npm audit fix` also cleaned up `brace-expansion` in Expo tooling (16 → 13 moderate advisories; remaining 13 are all in Expo internals and require expo upgrade).

| Package | Installed | Latest | Status |
|---|---|---|---|
| `expo` | 54.0.x | 56.0.4 | Pending — use `expo upgrade`, not manual |
| `expo-router` | 6.0.x | 56.2.6 | Pending — comes with expo upgrade |
| `react-native` | 0.81.5 | 0.85.3 | Pending — comes with expo upgrade |
| `react` | 19.1.0 | 19.2.6 | Pending — comes with expo upgrade (Expo pins to 19.1.0) |
| `react-native-vision-camera` | 4.7.3 | 5.0.10 | **Locked to v4** — v5 dropped Expo config plugin |
| `react-native-reanimated` | 4.1.1 | 4.3.1 | **Expo-pinned** — `expo install --check` confirmed 4.1.x correct for SDK 54 |
| `react-native-gesture-handler` | 2.28.0 | 2.31.2 | **Expo-pinned** — same as above |
| `react-native-screens` | 4.16.0 | 4.25.2 | **Expo-pinned** — same as above |
| `react-native-safe-area-context` | 5.6.0 | 5.8.0 | **Expo-pinned** — same as above |
| `react-native-fast-tflite` | 2.0.0 | 3.0.1 | **Locked to v2** — v3 silently rejects onnx2tf op set, breaks on-device YOLO |
| `react-native-worklets` | 0.5.1 | 0.9.1 | **Expo-pinned** — tied to vision-camera v4 ecosystem |
| `zustand` | 4.5.0 | 5.0.13 | **Skip** — v5 store API breaking changes |
| `axios` | ~~1.7.0~~ **1.16.1** | 1.16.1 | ✅ **Upgraded** — pure JS, no native deps |
| `react-native-svg` | 15.12.1 | 15.15.5 | **Expo-pinned** — `expo install` confirmed 15.12.1 correct for SDK 54 |
| `@react-native-async-storage/async-storage` | 2.2.0 | 3.1.0 | **Skip** — major, API changes in v3 |
| `@react-native-ml-kit/text-recognition` | 1.0.0 | 2.0.0 | **Skip** — major, breaking OCR API changes |
| `react-native-nitro-modules` | ~~0.35.6~~ **0.35.7** | 0.35.7 | ✅ **Upgraded** — patch |
| `typescript` | 5.4.0 | 6.0.3 | **Skip** — major; may introduce type errors in existing code |
