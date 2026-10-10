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
import {
  fonts,
  makeStyles,
  radius,
  spacing,
  typography,
  useThemeColors,
} from '../../core/theme';
import {Icon} from '../Icon';

export interface BarDatum {
  value: number;
  label: string;
  /** v42 (الجولة 50 #3): سطر فرعي اختياري تحت التسمية — تاريخ
   *  اليوم (٤/١٠) تحت اسم اليوم في رسم المبيعات، أو السنة تحت
   *  اسم الشهر في السلسلة الشهرية؛ يُرسم بحجم أصغر وأخفت. */
  sublabel?: string;
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
  color: colorProp,
  height = 170,
  width,
  formatTick,
  emptyText = 'لا توجد بيانات في هذه الفترة',
}: BarChartProps): React.JSX.Element {
  const c = useThemeColors();
  const styles = useStyles();
  const color = colorProp ?? c.accent;

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

  // v42 (الجولة 50 #3): منطقة التسميات تتوسع سطراً إضافياً عندما
  //  يحمل أي عمود تسمية فرعية (تاريخ اليوم/السنة).
  const hasSublabels = data.some(d => d.sublabel != null && d.sublabel !== '');

  // v43 (الجولة 51 #1): محور القيم إلى اليمين — التطبيق كله RTL
  //  فكان محور القيم في اليسار غريباً عن عين التاجر («عمود اتجاه
  //  القيمة في اليسار وليس اليمين»). البادينغ العريض انتقل لليمين
  //  حيث تُرسم تسميات القيم، والأعمدة وتسميات الأيام بقيت كما
  //  هي تماماً (أول عنصر عن اليمين) — لا شيء آخر تغيّر في الرسم.
  const paddingLeft = 6;
  const paddingRight = 42;
  // v42 (الجولة 50 #3): مساحة التسميات — سطر واحد أو سطران.
  const labelArea = hasSublabels ? 34 : 22;
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
                  stroke={c.borderSoft}
                  strokeWidth={i === 0 ? 1.2 : 1}
                />
                {/* v43: التسمية على يمين الرسم — تبدأ من حافة منطقة
                    المحور وتمتد يميناً (textAnchor=start) بدل
                    المرساة اليسرى القديمة. */}
                <SvgText
                  x={width - paddingRight + 6}
                  y={y + 3.5}
                  textAnchor="start"
                  fill={c.textFaint}
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
            const h = Math.max(
              raw > 0 ? 3 : 0,
              (raw / layout.ceiling) * chartH,
            );
            const x = width - paddingRight - (i + 1) * slot + (slot - barW) / 2;
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
      {/* X labels as RN Text for proper Arabic shaping.
          v42 (الجولة 50 #3): التسمية الفرعية (تاريخ اليوم/السنة)
          تحت التسمية الرئيسية — كل عمود يعلن تاريخه بنفسه فلا
          يضيع موضع اليوم كما كان بأسماء الأسابيع المكررة.
          v44 (الجولة 52 #1): إصلاح انعكاس صف التسميات — كان
          row-reverse، وفي تطبيق RTL يقلب الـ row-reverse اتجاه
          الترتيب إلى يسار→يمين بينما الأعمدة (SVG بإحداثيات مطلقة)
          ترسم أول عنصر على اليمين، فكانت كل تسمية تقع تحت عمود
          يوم/ساعة آخر غير يومها (شكوى التاجر: «الصف السفلي
          للأيام والساعات عكسي والمؤشر لا يطابق اليوم أو الساعة
          بالضبط»). الصف الآن row: في RTL يتدفق أول تسمية من اليمين
          تماماً كترتيب الأعمدة — التسمية تحت عمودها دائماً. */}
      <View
        style={{
          flexDirection: 'row',
          paddingRight: paddingRight,
          marginTop: 2,
        }}>
        {data.map((d, i) => (
          <View key={`l${i}`} style={{width: slot, alignItems: 'center'}}>
            <Text style={styles.axisLabel} numberOfLines={1}>
              {d.label}
            </Text>
            {hasSublabels ? (
              <Text style={styles.axisSubLabel} numberOfLines={1}>
                {d.sublabel ?? ''}
              </Text>
            ) : null}
          </View>
        ))}
      </View>
    </View>
  );
}

function ChartEmpty({text}: {text: string}): React.JSX.Element {
  const c = useThemeColors();
  const styles = useStyles();
  return (
    <View style={styles.empty}>
      <Icon name="chart" size={30} color={c.textFaint} />
      <Text style={styles.emptyText}>{text}</Text>
    </View>
  );
}

const useStyles = makeStyles(c =>
  StyleSheet.create({
    axisLabel: {
      color: c.textFaint,
      fontSize: typography.micro,
      fontFamily: fonts.regular,
      textAlign: 'center',
    },
    // v42 (الجولة 50 #3): السطر الفرعي — أصغر وأخفت من الرئيسي.
    axisSubLabel: {
      color: c.textFaint,
      fontSize: typography.micro - 1.5,
      fontFamily: fonts.regular,
      textAlign: 'center',
      marginTop: 1,
    },
    empty: {
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: spacing.xl,
      gap: spacing.sm,
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.md,
    },
    emptyText: {
      color: c.textDim,
      fontSize: typography.caption,
      fontFamily: fonts.regular,
    },
  }),
);
