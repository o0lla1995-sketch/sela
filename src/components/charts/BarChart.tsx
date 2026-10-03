/**
 * Custom SVG charts — سيلا design system §8.10.
 * ─────────────────────────────────────────────────────────────────
 * Hand-rolled with react-native-svg to replace gifted-charts (which
 * hard-crashed on empty data in v1 → black screen). Every chart is
 * NaN-proof: empty data renders an empty state, all-zero data uses a
 * safe axis ceiling, and every division is guarded.
 *
 * RTL: series flow right→left (oldest on the right) matching Arabic
 * reading order (design.md §11).
 */
import React, {useMemo} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import Svg, {G, Line, Rect, Text as SvgText} from 'react-native-svg';
import {colors, fonts, radius, spacing, typography} from '../../core/theme';
import {Icon} from '../Icon';

export interface BarDatum {
  value: number;
  label: string;
}

interface BarChartProps {
  data: BarDatum[];
  /** Bar fill color. */
  color?: string;
  /** Chart height excluding axis labels. */
  height?: number;
  /** Chart width; caller passes screen-derived width. */
  width: number;
  /** Format for the y-axis tick labels. */
  formatTick?: (value: number) => string;
  emptyText?: string;
}

function safeMax(values: number[]): number {
  let max = 0;
  for (const v of values) {
    if (Number.isFinite(v) && v > max) {
      max = v;
    }
  }
  // All-zero (or empty) data still needs a non-zero axis ceiling.
  return max > 0 ? max : 1;
}

function niceCeiling(max: number): number {
  if (max <= 0) {
    return 1;
  }
  const magnitude = Math.pow(10, Math.floor(Math.log10(max)));
  const scaled = max / magnitude;
  let nice: number;
  if (scaled <= 1) {
    nice = 1;
  } else if (scaled <= 2) {
    nice = 2;
  } else if (scaled <= 2.5) {
    nice = 2.5;
  } else if (scaled <= 5) {
    nice = 5;
  } else {
    nice = 10;
  }
  return nice * magnitude;
}

export function BarChart({
  data,
  color = colors.accent,
  height = 170,
  width,
  formatTick,
  emptyText = 'لا توجد بيانات في هذه الفترة',
}: BarChartProps): React.JSX.Element {
  const layout = useMemo(() => {
    const values = data.map(d => (Number.isFinite(d.value) ? d.value : 0));
    const ceiling = niceCeiling(safeMax(values));
    const sections = 4;
    const gridLines = Array.from(
      {length: sections + 1},
      (_, i) => ceiling * (i / sections),
    );
    return {values, ceiling, gridLines};
  }, [data]);

  if (data.length === 0) {
    return <ChartEmpty text={emptyText} />;
  }

  const paddingLeft = 42;
  const paddingRight = 6;
  const labelArea = 22;
  const chartW = Math.max(40, width - paddingLeft - paddingRight);
  const chartH = height;
  const n = data.length;
  const slot = chartW / n;
  const barW = Math.max(4, Math.min(26, slot * 0.55));

  return (
    <View>
      <Svg width={width} height={chartH + labelArea}>
        <G>
          {layout.gridLines.map((line, i) => {
            const y = chartH - (i / 4) * chartH;
            return (
              <G key={`g${i}`}>
                <Line
                  x1={paddingLeft}
                  y1={y}
                  x2={width - paddingRight}
                  y2={y}
                  stroke={colors.borderSoft}
                  strokeWidth={i === 0 ? 1.2 : 1}
                />
                <SvgText
                  x={paddingLeft - 6}
                  y={y + 3.5}
                  textAnchor="end"
                  fill={colors.textFaint}
                  fontSize={typography.micro}
                  fontFamily={fonts.regular}>
                  {formatTick ? formatTick(line) : String(Math.round(line))}
                </SvgText>
              </G>
            );
          })}
          {/* Bars — RTL: first datum on the RIGHT */}
          {data.map((d, i) => {
            const raw = layout.values[i];
            const h = Math.max(raw > 0 ? 3 : 0, (raw / layout.ceiling) * chartH);
            const x =
              width - paddingRight - (i + 1) * slot + (slot - barW) / 2;
            const y = chartH - h;
            return (
              <Rect
                key={`b${i}`}
                x={x}
                y={y}
                width={barW}
                height={h}
                rx={Math.min(4, barW / 2)}
                fill={color}
              />
            );
          })}
        </G>
      </Svg>
      {/* X labels as RN Text for proper Arabic shaping */}
      <View
        style={{
          flexDirection: 'row-reverse',
          paddingRight: paddingRight,
          marginTop: 2,
        }}>
        {data.map((d, i) => (
          <View key={`l${i}`} style={{width: slot, alignItems: 'center'}}>
            <Text style={styles.axisLabel} numberOfLines={1}>
              {d.label}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function ChartEmpty({text}: {text: string}): React.JSX.Element {
  return (
    <View style={styles.empty}>
      <Icon name="chart" size={30} color={colors.textFaint} />
      <Text style={styles.emptyText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  axisLabel: {
    color: colors.textFaint,
    fontSize: typography.micro,
    fontFamily: fonts.regular,
    textAlign: 'center',
  },
  empty: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xl,
    gap: spacing.sm,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
  },
  emptyText: {
    color: colors.textDim,
    fontSize: typography.caption,
    fontFamily: fonts.regular,
  },
});
