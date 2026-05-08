import React from "react";
import { View, StyleSheet, Dimensions } from "react-native";
import Svg, { Rect, Defs, Mask, Path } from "react-native-svg";
import { COLORS } from "@/constants";

const { width: W, height: H } = Dimensions.get("window");
const FRAME_W = W * 0.75;
const FRAME_H = FRAME_W * (88 / 63); // standard TCG card portrait ratio
const FRAME_X = (W - FRAME_W) / 2;
const FRAME_Y = (H - FRAME_H) / 2 - 40;
const CORNER = 18;

interface Props {
  label?: string;
}

export function ScanOverlay({ label }: Props) {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <Svg width={W} height={H}>
        <Defs>
          <Mask id="frame-mask">
            <Rect width={W} height={H} fill="white" />
            <Rect
              x={FRAME_X}
              y={FRAME_Y}
              width={FRAME_W}
              height={FRAME_H}
              rx={CORNER}
              ry={CORNER}
              fill="black"
            />
          </Mask>
        </Defs>
        {/* Dark overlay outside frame */}
        <Rect width={W} height={H} fill="rgba(0,0,0,0.55)" mask="url(#frame-mask)" />
        {/* Corner brackets */}
        {[
          [FRAME_X, FRAME_Y, 1, 1],
          [FRAME_X + FRAME_W, FRAME_Y, -1, 1],
          [FRAME_X, FRAME_Y + FRAME_H, 1, -1],
          [FRAME_X + FRAME_W, FRAME_Y + FRAME_H, -1, -1],
        ].map(([x, y, sx, sy], i) => (
          <Path
            key={i}
            d={`M ${x + sx * CORNER} ${y} L ${x + sx * 4} ${y} Q ${x} ${y} ${x} ${y + sy * 4} L ${x} ${y + sy * CORNER}`}
            stroke={COLORS.accent}
            strokeWidth={3}
            fill="none"
          />
        ))}
      </Svg>
    </View>
  );
}
