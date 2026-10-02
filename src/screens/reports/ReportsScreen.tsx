/**
 * ReportsScreen — النظام المحاسبي والتقارير.
 * KPIs + daily sales bar chart + peak hours chart + top products +
 * CSV / XLS local export.
 */
import React, {useCallback, useEffect, useState} from 'react';
import {View, Text, StyleSheet, ScrollView, Dimensions} from 'react-native';
import {BarChart} from 'react-native-gifted-charts';
import {
  AppButton,
  Card,
  EmptyState,
  Screen,
  ScreenHeader,
  Segmented,
  StatCard,
} from '../../components/ui';
import {ReportService, type ReportBundle} from '../../services/ReportService';
import {ExportService} from '../../services/ExportService';
import {useToastStore} from '../../stores/toastStore';
import {colors, radius, spacing, typography} from '../../core/theme';
import {formatMoney} from '../../core/format';
import type {ReportRangeKey} from '../../core/types';

const CHART_WIDTH = Dimensions.get('window').width - spacing.lg * 2 - spacing.lg * 2;

const RANGE_OPTIONS: {value: ReportRangeKey; label: string}[] = [
  {value: 'today', label: 'اليوم'},
  {value: 'yesterday', label: 'أمس'},
  {value: 'last7', label: 'آخر 7 أيام'},
  {value: 'thisMonth', label: 'هذا الشهر'},
];

export function ReportsScreen() {
  const toast = useToastStore(state => state.show);
  const [rangeKey, setRangeKey] = useState<ReportRangeKey>('last7');
  const [bundle, setBundle] = useState<ReportBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState<'csv' | 'xls' | null>(null);
  const [topMode, setTopMode] = useState<'revenue' | 'profit'>('revenue');

  const load = useCallback(
    async (key: ReportRangeKey) => {
      setLoading(true);
      try {
        const next = await ReportService.loadBundle(key);
        setBundle(next);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        toast(message, 'error');
      } finally {
        setLoading(false);
      }
    },
    [toast],
  );

  useEffect(() => {
    void load(rangeKey);
  }, [rangeKey, load]);

  const exportReport = useCallback(
    async (format: 'csv' | 'xls') => {
      setExporting(format);
      try {
        const path = await ExportService.exportSalesReport(rangeKey, undefined, format);
        toast(`تم حفظ التقرير: ${path}`, 'success', 4000);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        toast(message, 'error');
      } finally {
        setExporting(null);
      }
    },
    [rangeKey, toast],
  );

  const dailyData = (bundle?.daily ?? [])
    .slice(-10)
    .map(point => ({
      value: Math.round(point.revenue * 100) / 100,
      label: point.label,
    }));

  const hourlyData = (bundle?.hourly ?? []).map(point => ({
    value: Math.round(point.revenue * 100) / 100,
    label: point.hour % 4 === 0 ? String(point.hour) : '',
  }));

  const topProducts =
    topMode === 'revenue'
      ? bundle?.topByRevenue ?? []
      : bundle?.topByProfit ?? [];

  return (
    <Screen>
      <ScreenHeader title="التقارير والمحاسبة" subtitle="المبيعات والتكاليف والأرباح" showBack />
      <ScrollView contentContainerStyle={styles.content}>
        <Segmented value={rangeKey} onChange={setRangeKey} options={RANGE_OPTIONS} />

        {loading && !bundle ? (
          <EmptyState title="جارٍ تحميل التقارير…" emoji="📊" />
        ) : bundle ? (
          <>
            {/* ── KPIs ─────────────────────────────────────────── */}
            <View style={styles.statsRow}>
              <StatCard label="إجمالي المبيعات" value={formatMoney(bundle.summary.revenue)} tone="accent" />
              <StatCard label="صافي الربح" value={formatMoney(bundle.summary.netProfit)} tone={bundle.summary.netProfit >= 0 ? 'success' : 'danger'} />
            </View>
            <View style={styles.statsRow}>
              <StatCard label="التكلفة (COGS)" value={formatMoney(bundle.summary.cogs)} />
              <StatCard label="عدد الفواتير" value={String(bundle.summary.invoicesCount)} />
            </View>
            <View style={styles.statsRow}>
              <StatCard label="متوسط الفاتورة" value={formatMoney(bundle.summary.avgInvoice)} />
              <StatCard label="إجمالي الخصومات" value={formatMoney(bundle.summary.discountTotal)} />
              <StatCard label="القطع المبيعة" value={String(bundle.summary.itemsCount)} />
            </View>

            {/* ── Daily sales chart ────────────────────────────── */}
            <Card>
              <Text style={styles.chartTitle}>أداء المبيعات اليومي (₪)</Text>
              {dailyData.length > 0 ? (
                <BarChart
                  data={dailyData}
                  barWidth={Math.max(8, Math.floor(CHART_WIDTH / dailyData.length) - 8)}
                  spacing={Math.max(4, Math.floor(24 / Math.max(dailyData.length, 1)))}
                  frontColor={colors.accent}
                  roundedTop
                  initialSpacing={8}
                  endSpacing={8}
                  noOfSections={4}
                  yAxisThickness={1}
                  xAxisThickness={1}
                  yAxisColor={colors.textFaint}
                  xAxisColor={colors.textFaint}
                  yAxisTextStyle={{color: colors.textDim, fontSize: 10}}
                  xAxisLabelTextStyle={{color: colors.textDim, fontSize: 9, textAlign: 'center'}}
                  isAnimated
                  hideRules
                />
              ) : (
                <Text style={styles.chartEmpty}>لا توجد مبيعات في هذه الفترة</Text>
              )}
            </Card>

            {/* ── Peak hours chart ─────────────────────────────── */}
            <Card>
              <Text style={styles.chartTitle}>ساعات الذروة (₪ حسب الساعة)</Text>
              <BarChart
                data={hourlyData}
                barWidth={7}
                spacing={4}
                frontColor={colors.info}
                initialSpacing={4}
                endSpacing={4}
                noOfSections={4}
                yAxisThickness={1}
                xAxisThickness={1}
                yAxisColor={colors.textFaint}
                xAxisColor={colors.textFaint}
                yAxisTextStyle={{color: colors.textDim, fontSize: 10}}
                xAxisLabelTextStyle={{color: colors.textDim, fontSize: 9}}
                isAnimated
                hideRules
              />
              <Text style={styles.chartHint}>
                الأعمدة تمثل الإيرادات في كل ساعة (0–23) — استخدمها لتحديد أوقات
                تواجد الزبائن
              </Text>
            </Card>

            {/* ── Top products ─────────────────────────────────── */}
            <Card>
              <View style={styles.topHeaderRow}>
                <Text style={styles.chartTitle}>المنتجات الأفضل</Text>
                <Segmented
                  value={topMode}
                  onChange={setTopMode}
                  options={[
                    {value: 'revenue', label: 'إيراداً'},
                    {value: 'profit', label: 'ربحاً'},
                  ]}
                />
              </View>
              {topProducts.length === 0 ? (
                <Text style={styles.chartEmpty}>لا توجد مبيعات بعد</Text>
              ) : (
                topProducts.slice(0, 8).map((product, index) => (
                  <View key={product.productId} style={styles.topRow}>
                    <Text style={styles.topRank}>{index + 1}</Text>
                    <View style={styles.topInfo}>
                      <Text style={styles.topName} numberOfLines={1}>
                        {product.name}
                      </Text>
                      <Text style={styles.topMeta}>
                        {product.quantity} قطعة
                      </Text>
                    </View>
                    <View style={styles.topEnd}>
                      <Text style={styles.topRevenue}>
                        {formatMoney(
                          topMode === 'revenue' ? product.revenue : product.profit,
                        )}
                      </Text>
                      <Text
                        style={[
                          styles.topProfit,
                          {color: product.profit >= 0 ? colors.success : colors.danger},
                        ]}>
                        ربح: {formatMoney(product.profit)}
                      </Text>
                    </View>
                  </View>
                ))
              )}
            </Card>

            {/* ── Export ───────────────────────────────────────── */}
            <Card>
              <Text style={styles.chartTitle}>تصدير التقارير (محلياً)</Text>
              <Text style={styles.chartHint}>
                تُحفظ الملفات في مجلد التنزيلات Downloads/SmartVisionPOS وتفتح
                مباشرة في Excel
              </Text>
              <View style={styles.exportRow}>
                <AppButton
                  title="تقرير المبيعات CSV"
                  variant="ghost"
                  small
                  loading={exporting === 'csv'}
                  onPress={() => exportReport('csv')}
                  style={{flex: 1}}
                />
                <AppButton
                  title="تقرير المبيعات Excel"
                  variant="ghost"
                  small
                  loading={exporting === 'xls'}
                  onPress={() => exportReport('xls')}
                  style={{flex: 1}}
                />
              </View>
              <View style={styles.exportRow}>
                <AppButton
                  title="الأفضل مبيعاً CSV"
                  variant="ghost"
                  small
                  onPress={async () => {
                    try {
                      const path = await ExportService.exportTopProducts(rangeKey, undefined, 'csv');
                      toast(`تم الحفظ: ${path}`, 'success', 4000);
                    } catch (error) {
                      toast(error instanceof Error ? error.message : String(error), 'error');
                    }
                  }}
                  style={{flex: 1}}
                />
              </View>
            </Card>
          </>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {padding: spacing.md, gap: spacing.md, paddingBottom: spacing.xxl},
  statsRow: {flexDirection: 'row', marginHorizontal: -4},
  chartTitle: {
    color: colors.text,
    fontWeight: '900',
    fontSize: typography.body,
    marginBottom: spacing.md,
  },
  chartEmpty: {
    color: colors.textDim,
    textAlign: 'center',
    paddingVertical: spacing.lg,
    fontSize: typography.caption,
  },
  chartHint: {
    color: colors.textFaint,
    fontSize: typography.small,
    lineHeight: 17,
    marginTop: spacing.sm,
  },
  topHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  topRank: {
    color: colors.accent,
    fontWeight: '900',
    fontSize: typography.body,
    width: 24,
  },
  topInfo: {flex: 1},
  topName: {color: colors.text, fontWeight: '700', fontSize: typography.caption},
  topMeta: {color: colors.textDim, fontSize: typography.small, marginTop: 2},
  topEnd: {alignItems: 'flex-end'},
  topRevenue: {color: colors.text, fontWeight: '800', fontSize: typography.caption},
  topProfit: {fontSize: typography.small, fontWeight: '700', marginTop: 2},
  exportRow: {flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.sm},
});
