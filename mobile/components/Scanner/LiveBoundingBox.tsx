import React, { useEffect, useRef } from "react";
import { Animated, StyleSheet, View } from "react-native";

export type BoxState = "detecting" | "stable" | "captured";

interface NormBox {
  x: number; // 0–1 relative to image width
  y: number; // 0–1 relative to image height
  w: number;
  h: number;
}

interface Props {
  box: NormBox | null;
  state: BoxState;
  viewWidth: number;
  viewHeight: number;
  // Ratio of image dims to view dims (for cover-mode mapping)
  imageWidth: number;
  imageHeight: number;
}

const STATE_COLOR: Record<BoxState, string> = {
  detecting: "rgba(255,255,255,0.85)",
  stable: "rgba(80,220,100,0.95)",
  captured: "rgba(100,160,255,0.95)",
};

export function LiveBoundingBox({ box, state, viewWidth, viewHeight, imageWidth, imageHeight }: Props) {
  const opacity = useRef(new Animated.Value(0)).current;
  const prevBox = useRef<NormBox | null>(null);

  useEffect(() => {
    Animated.timing(opacity, {
      toValue: box ? 1 : 0,
      duration: box ? 120 : 300,
      useNativeDriver: true,
    }).start();
    if (box) prevBox.current = box;
  }, [box, opacity]);

  const displayBox = box ?? prevBox.current;
  if (!displayBox || viewWidth === 0 || viewHeight === 0) return null;

  // Map from image pixel coords (normalized) to screen coords using cover scaling
  const scaleX = viewWidth / imageWidth;
  const scaleY = viewHeight / imageHeight;
  const scale = Math.max(scaleX, scaleY);
  const offsetX = (viewWidth - imageWidth * scale) / 2;
  const offsetY = (viewHeight - imageHeight * scale) / 2;

  const sx = displayBox.x * imageWidth * scale + offsetX;
  const sy = displayBox.y * imageHeight * scale + offsetY;
  const sw = displayBox.w * imageWidth * scale;
  const sh = displayBox.h * imageHeight * scale;

  const color = STATE_COLOR[state];
  const cornerLen = Math.min(sw, sh) * 0.22;

  return (
    <Animated.View style={[StyleSheet.absoluteFill, { opacity }]} pointerEvents="none">
      {/* Corner brackets instead of full border */}
      <View style={[styles.corner, { left: sx, top: sy, width: cornerLen, height: cornerLen, borderLeftColor: color, borderTopColor: color }]} />
      <View style={[styles.corner, { left: sx + sw - cornerLen, top: sy, width: cornerLen, height: cornerLen, borderRightColor: color, borderTopColor: color }]} />
      <View style={[styles.corner, { left: sx, top: sy + sh - cornerLen, width: cornerLen, height: cornerLen, borderLeftColor: color, borderBottomColor: color }]} />
      <View style={[styles.corner, { left: sx + sw - cornerLen, top: sy + sh - cornerLen, width: cornerLen, height: cornerLen, borderRightColor: color, borderBottomColor: color }]} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  corner: {
    position: "absolute",
    borderWidth: 3,
    borderColor: "transparent",
  },
});
