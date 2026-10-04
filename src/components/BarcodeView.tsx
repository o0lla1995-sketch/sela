/**
 * BarcodeView — v9.1 (round-14 #6) in-app barcode preview.
 * ─────────────────────────────────────────────────────────────────
 * Renders a barcode's exact module pattern as crisp SVG bars:
 *   • valid 13-digit codes  → true EAN-13 layout (guards + digits)
 *   • anything else         → CODE128-B (what the label printer
 *                             actually prints for free-form codes)
 * Non-renderable values (empty, non-ASCII…) render nothing.
 */
import React from 'react';
import Svg, {Rect} from 'react-native-svg';
import {StyleSheet, Text, View} from 'react-native';
import {encodeBarcodeBars} from '../services/BarcodeService';
import {fonts, makeStyles, useThemeColors} from '../core/theme';

interface BarcodeViewProps {
  value: string;
  /** Bar height in px. */
  height?: number;
  /** Module (narrowest bar) width in px. */
  moduleWidth?: number;
  /** Show the human-readable digits under the bars. */
  showText?: boolean;
}

export function BarcodeView({
  value,
  height = 64,
  moduleWidth = 2,
  showText = true,
}: BarcodeViewProps) {
  const c = useThemeColors();
  const styles = useStyles();
  const trimmed = value.trim();
  const pattern = encodeBarcodeBars(trimmed);

  if (pattern == null) {
    return null;
  }

  // Group consecutive '1' runs into bar rects.
  const bars: {x: number; w: number}[] = [];
  let run = 0;
  for (let i = 0; i <= pattern.bits.length; i++) {
    if (pattern.bits[i] === '1') {
      run++;
    } else if (run > 0) {
      bars.push({x: (i - run) * moduleWidth, w: run * moduleWidth});
      run = 0;
    }
  }
  const width = pattern.bits.length * moduleWidth;
  const isEan = pattern.standard;

  return (
    <View style={styles.wrap}>
      <Svg width={width} height={height}>
        {bars.map((bar, index) => (
          <Rect
            key={index}
            x={bar.x}
            y={0}
            width={bar.w}
            height={height}
            fill={c.text}
          />
        ))}
      </Svg>
      {showText ? (
        <Text
          style={[styles.code, isEan ? styles.codeEan : null]}
          numberOfLines={1}
          adjustsFontSizeToFit>
          {trimmed}
        </Text>
      ) : null}
    </View>
  );
}

const useStyles = makeStyles(c =>
  StyleSheet.create({
    wrap: {
      alignItems: 'center',
      backgroundColor: c.surfaceAlt,
      borderRadius: 10,
      paddingVertical: 10,
      paddingHorizontal: 12,
      gap: 6,
      borderWidth: 1,
      borderColor: c.borderSoft,
    },
    code: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: 13,
      fontVariant: ['tabular-nums'],
      letterSpacing: 1.5,
    },
    /** EAN-13: spaced groups 1-6-6 like real packaging. */
    codeEan: {
      letterSpacing: 3,
    },
  }),
);
