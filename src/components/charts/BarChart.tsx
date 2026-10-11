/**
 * Custom SVG charts — سيلا design system §8.10.
 * ─────────────────────────────────────────────────────────────────
 * Hand-rolled with react-native-svg to replace gifted-charts (which
 * hard-crashed on empty data in v1 → black screen). Every chart is
 * NaN-proof: empty data renders an empty state, all-zero data uses a
 * safe axis ceiling, and every division is guarded.
 *
 * v47 (الجولة 55 #3) — الاتجاه النهائي بقرار التاجر بعد ثلاث شكاوى:
 * محور الزمن يسار→يمين (الأقدم في أقصى اليسار والأحدث في أقصى
 * اليمين) ككل لوحات نقاط البيع العالمية (Loyverse/Square/Google
 * Analytics حتى بواجهاتها العربية) — وعين التاجر العربية تبدأ من
 * اليمين فتلتقي أحدث عمود أولاً تماماً كقوائم السجل (الأحدث فوق).
 * التسميات تحت أعمدتها بحكم البناء: الصف row-reverse في RTL يتدفق
 * من اليسار مثل الأعمدة نفسها.
 *
 * v47 مؤشر احترافي: highlightIndex يضيء عمود الذروة بلون مميز
 * ويعرض قيمته فوقه، وavgLine يرسم خط المتوسط المتقطع — «مؤشر صحيح»
 * يقرأه التاجر بنظرة.
 */
import React, {useMemo} from 'react';
import {I18nManager, StyleSheet, Text, View} from 'react-native';
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
  /** v47: لون عمود الذروة المضاء (highlightIndex). */
  highlightColor?: string;
  /** v47: فهرس عمود الذروة — يُضاء بلون مميز وتُكتب قيمته فوقه. */
  highlightIndex?: number | null;
  /** v47: قيمة المتوسط — خط متقطع عبر الرسم (null = بلا خط). */
  avgLine?: number | null;
  /** v47: تنسيق قيمة الذروة المكتوبة فوق العمود. */
  formatValue?: (value: number) => string;
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

/** v47: فهرس أكبر قيمة (أول عمود ذروة) — null عند لا بيانات. */
export function peakIndex(values: number[]): number | null {
  let best = -1;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isFinite(v) && (best < 0 || v > values[best])) {
      best = i;
    }
  }
  return best >= 0 && values[best] > 0 ? best : null;
}

export function BarChart({
  data,
  color: colorProp,
  highlightColor,
  highlightIndex,
  avgLine,
  formatValue,
  height = 170,
  width,
  formatTick,
  emptyText = 'لا توجد بيانات في هذه الفترة',
}: BarChartProps): React.JSX.Element {
  const c = useThemeColors();
  const styles = useStyles();
  const color = colorProp ?? c.accent;
  const hot = highlightColor ?? c.success;

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

  // v43 (الجولة 51 #1): محور القيم إلى اليمين (بادينغ عريض يميناً
  //  حيث تُرسم تسميات القيم) — طلب التاجر وبقي كما هو.
  const paddingLeft = 6;
  const paddingRight = 42;
  // v42: مساحة التسميات — سطر واحد أو سطران.
  const labelArea = hasSublabels ? 34 : 22;
  const chartW = Math.max(40, width - paddingLeft - paddingRight);
  const chartH = height;
  const n = data.length;
  const slot = chartW / n;
  const barW = Math.max(4, Math.min(26, slot * 0.55));
  // v47: مساحة صغيرة أعلى الرسم لقيمة الذروة المكتوبة فوق عمودها.
  const headroom = 13;
  const barBase = chartH - headroom;
  // v47: خط المتوسط — يُرسم داخل منطقة الأعمدة فقط.
  const avgY =
    avgLine != null && Number.isFinite(avgLine) && avgLine > 0
      ? barBase - Math.min((avgLine / layout.ceiling) * barBase, barBase - 2)
      : null;

  return (
    <View>
      <Svg width={width} height={chartH + labelArea}>
        <G>
          {layout.gridLines.map((line, i) => {
            const y = barBase - (i / 4) * barBase;
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
                    المحور وتمتد يميناً (textAnchor=start). */}
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
          {/* v47: خط المتوسط المتقطع — «مؤشر» مستوى الساعة/اليوم
              المعتاد مقابل عمود الذروة المضاء. */}
          {avgY != null ? (
            <Line
              x1={paddingLeft}
              y1={avgY}
              x2={width - paddingRight}
              y2={avgY}
              stroke={c.textFaint}
              strokeWidth={1}
              strokeDasharray="5 4"
            />
          ) : null}
          {/* Bars — v47 (الجولة 55 #3): محور الزمن يسار→يمين — أول
              عنصر (الأقدم) في أقصى اليسار والأحدث في أقصى اليمين
              كلوحات POS العالمية؛ وعين التاجر RTL تبدأ من اليمين
              فتقرأ الأحدث أولاً كقوائم السجل تماماً. */}
          {data.map((d, i) => {
            const raw = layout.values[i];
            const isPeak = highlightIndex != null && i === highlightIndex;
            const h = Math.max(
              raw > 0 ? 3 : 0,
              (raw / layout.ceiling) * barBase,
            );
            const x = paddingLeft + i * slot + (slot - barW) / 2;
            const y = barBase - h;
            return (
              <G key={`b${i}`}>
                <Rect
                  x={x}
                  y={y}
                  width={barW}
                  height={h}
                  rx={Math.min(4, barW / 2)}
                  fill={isPeak ? hot : color}
                  opacity={isPeak ? 1 : 0.92}
                />
                {/* v47: قيمة الذروة فوق عمودها — المؤشر الصحيح الذي
                    يقرأه التاجر بنظرة واحدة بلا تخمين. */}
                {isPeak && raw > 0 && formatValue ? (
                  <SvgText
                    x={x + barW / 2}
                    y={y - 3}
                    textAnchor="middle"
                    fill={hot}
                    fontSize={typography.micro}
                    fontFamily={fonts.bold}>
                    {formatValue(raw)}
                  </SvgText>
                ) : null}
              </G>
            );
          })}
        </G>
      </Svg>
      {/* X labels as RN Text for proper Arabic shaping.
          v47 (الجولة 55 #3): الصف row-reverse في RTL — يتدفق أول
          تسمية من اليسار مثل الأعمدة نفسها (الأقدم يساراً) فتبقى كل
          تسمية تحت عمودها بالضبط، مع paddingLeft مطابق لبداية
          منطقة الأعمدة فلا انزياح بكسل.
          v48 (الجولة 56 #2): كل خانة flex:1 بدل width:slot — عرض
          slot الكسري كان يتراكم مع تقريب بكسلات يوغا فتجاوز آخر
          خانة حدّ الرسم يميناً بقليل (خارج الإطار)؛ التقسيم المرن
          يوزع المساحة بالضبط فلا يمكن أن يتجاوز الصف حدود الرسم
          مهما كثرت الأعمدة. */}
      <View
        style={{
          flexDirection: I18nManager.isRTL ? 'row-reverse' : 'row',
          paddingLeft: paddingLeft,
          paddingRight: paddingRight,
          marginTop: 2,
        }}>
        {data.map((d, i) => (
          <View key={`l${i}`} style={{flex: 1, alignItems: 'center'}}>
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
