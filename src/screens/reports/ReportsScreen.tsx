/**
 * ReportsScreen — النظام المحاسبي (design.md §9.5).
 * KPI grid + custom SVG daily/peak-hour charts + top products +
 * local CSV/XLS export. Every chart sits in an ErrorBoundary.
 */
import React, {useCallback, useEffect, useState} from 'react';
import {Dimensions, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useFocusEffect} from '@react-navigation/native';
import {AppButton, AppHeader, Card, EmptyState, SectionTitle, Segmented, StatCard} from '../../components/ui';
import {Icon} from '../../components/Icon';
import {ErrorBoundary} from '../../components/ErrorBoundary';
import {BarChart} from '../../components/charts/BarChart';
import {ReportService, type ReportBundle} from '../../services/ReportService';
import {ExportService} from '../../services/ExportService';
import {useToastStore} from '../../stores/toastStore';
import {colors, fonts, radius, spacing, typography} from '../../core/theme';
import {formatMoney} from '../../core/format';
import type {ReportRangeKey} from '../../core/types';

const CHART_WIDTH = Dimensions.get('window').width - spacing.lg * 2 - spacing.lg * 2;

const RANGE_OPTIONS: {value: ReportRangeKey; label: string}[] = [
  {value: 'today', label: 'اليوم'},
  {value: 'yesterday', label: 'أمس'},
  {value: 'last7', label: '7 أيام'},
  {value: 'thisMonth', label: 'الشهر'},
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

  useFocusEffect(
    useCallback(() => {
      void load(rangeKey);
    }, [rangeKey, load]),
  );

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
    label: point.hour % 6 === 0 ? String(point.hour) : '',
  }));

  const topProducts =
    topMode === 'revenue'
      ? bundle?.topByRevenue ?? []
      : bundle?.topByProfit ?? [];

  const hasSales = (bundle?.summary.invoicesCount ?? 0) > 0;

  return (
    <View style={styles.screen}>
      <AppHeader title="التقارير والمحاسبة" subtitle="المبيعات والتكاليف والأرباح" showBack={false} />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Segmented value={rangeKey} onChange={setRangeKey} options={RANGE_OPTIONS} />

        {loading && !bundle ? (
          <EmptyState icon="chart" title="جارٍ تحميل التقارير…" />
        ) : bundle ? (
          <>
            {/* ── KPIs ─────────────────────────────────────────── */}
            <View style={styles.statsGrid}>
              <StatCard label="إجمالي المبيعات" value={formatMoney(bundle.summary.revenue)} tone="accent" icon="wallet" />
              <StatCard
                label="صافي الربح"
                value={formatMoney(bundle.summary.netProfit)}
                tone={bundle.summary.netProfit >= 0 ? 'success' : 'danger'}
                icon="chart"
              />
              <StatCard label="التكلفة (COGS)" value={formatMoney(bundle.summary.cogs)} icon="calculator" />
              <StatCard label="عدد الفواتير" value={String(bundle.summary.invoicesCount)} icon="inbox" />
              <StatCard label="متوسط الفاتورة" value={formatMoney(bundle.summary.avgInvoice)} icon="tag" />
              <StatCard label="القطع المبيعة" value={String(bundle.summary.itemsCount)} icon="box" />
            </View>

            {/* ── Daily sales chart ────────────────────────────── */}
            <Card>
              <SectionTitle title="أداء المبيعات اليومي" hint="القيم بالشيكل ₪" />
              <ErrorBoundary inline label="رسم المبيعات">
                <BarChart
                  data={dailyData}
                  width={CHART_WIDTH}
                  color={colors.accent}
                  formatTick={(value: number) => compactNumber(value)}
                  emptyText="لا توجد مبيعات في هذه الفترة"
                />
              </ErrorBoundary>
            </Card>

            {/* ── Peak hours chart ─────────────────────────────── */}
            <Card>
              <SectionTitle title="ساعات الذروة" hint="الإيراد لكل ساعة خلال الفترة (0–24)" />
              <ErrorBoundary inline label="رسم الذروة">
                <BarChart
                  data={hourlyData}
                  width={CHART_WIDTH}
                  height={120}
                  color={colors.info}
                  formatTick={(value: number) => compactNumber(value)}
                  emptyText="لا توجد مبيعات في هذه الفترة"
                />
              </ErrorBoundary>
              <Text style={styles.chartHint}>
                استخدم الرسم لتحديد أكثر ساعات تواجد الزبائن وجهّز المخزون والطاقم
                لها
              </Text>
            </Card>

            {/* ── Top products ─────────────────────────────────── */}
            <Card>
              <SectionTitle
                title="الأفضل مبيعاً"
                action={
                  <Segmented
                    compact
                    value={topMode}
                    onChange={setTopMode}
                    options={[
                      {value: 'revenue', label: 'إيراداً'},
                      {value: 'profit', label: 'ربحاً'},
                    ]}
                  />
                }
              />
              {topProducts.length === 0 ? (
                <EmptyState icon="box" title="لا توجد مبيعات بعد" subtitle="أفضل منتجاتك ستظهر هنا بعد أول فاتورة" />
              ) : (
                topProducts.slice(0, 8).map((product, index) => (
                  <View key={product.productId} style={styles.topRow}>
                    <View style={styles.topRank}>
                      <Text style={styles.topRankText}>{index + 1}</Text>
                    </View>
                    <View style={styles.topInfo}>
                      <Text style={styles.topName} numberOfLines={1}>
                        {product.name}
                      </Text>
                      <Text style={styles.topMeta}>{product.quantity} قطعة مبيعة</Text>
                    </View>
                    <View style={styles.topEnd}>
                      <Text style={styles.topRevenue}>
                        {formatMoney(topMode === 'revenue' ? product.revenue : product.profit)}
                      </Text>
                      <Text
                        style={[
                          styles.topProfit,
                          {color: product.profit >= 0 ? colors.success : colors.danger},
                        ]}>
                        ربح {formatMoney(product.profit)}
                      </Text>
                    </View>
                  </View>
                ))
              )}
            </Card>

            {/* ── Export ───────────────────────────────────────── */}
            <Card>
              <SectionTitle title="تصدير التقارير" hint="تُحفظ في مجلد التنزيلات وتفتح في Excel" />
              <View style={styles.exportRow}>
                <AppButton
                  title="المبيعات CSV"
                  variant="secondary"
                  icon="download"
                  small
                  loading={exporting === 'csv'}
                  onPress={() => exportReport('csv')}
                  style={{flex: 1}}
                />
                <AppButton
                  title="المبيعات Excel"
                  variant="secondary"
                  icon="download"
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
                  icon="list"
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
    </View>
  );
}

function compactNumber(value: number): string {
  const rounded = Math.round(value);
  if (rounded >= 1000) {
    return `${(rounded / 1000).toFixed(rounded >= 10000 ? 0 : 1)}k`;
  }
  return String(rounded);
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: colors.bg},
  content: {
    padding: spacing.lg,
    gap: spacing.md,
    paddingBottom: spacing.xxl,
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  chartHint: {
    color: colors.textFaint,
    fontFamily: fonts.regular,
    fontSize: typography.small,
    lineHeight: 17,
    marginTop: spacing.md,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSoft,
  },
  topRank: {
    width: 28,
    height: 28,
    borderRadius: 9,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  topRankText: {
    color: colors.accent,
    fontFamily: fonts.black,
    fontSize: typography.small,
  },
  topInfo: {flex: 1},
  topName: {
    color: colors.text,
    fontFamily: fonts.bold,
    fontSize: typography.caption,
  },
  topMeta: {
    color: colors.textDim,
    fontFamily: fonts.regular,
    fontSize: typography.micro + 1,
    marginTop: 1,
  },
  topEnd: {alignItems: 'flex-end'},
  topRevenue: {
    color: colors.text,
    fontFamily: fonts.black,
    fontSize: typography.caption,
    fontVariant: ['tabular-nums'],
  },
  topProfit: {
    fontFamily: fonts.bold,
    fontSize: typography.micro + 1,
    marginTop: 2,
    fontVariant: ['tabular-nums'],
  },
  exportRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
});
