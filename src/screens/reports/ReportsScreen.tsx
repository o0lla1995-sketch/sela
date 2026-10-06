/**
 * ReportsScreen — النظام المحاسبي (design.md §9.5, redesigned v18).
 * ─────────────────────────────────────────────────────────────────
 * v18 (round-24 #2/#3): the v17 debts wall («صفحة التقارير مقززة»)
 * is gone. The page now follows the global POS reports pattern
 * (Square's sales summary → cash waterfall → receivables):
 *
 *   1. ملخص المبيعات  — 6 clean KPIs (revenue, profit, COGS,
 *      invoices, average ticket, items).
 *   2. النقد والديون  — ONE card: cash collected in the period,
 *      its sources, credit invoices, and the outstanding snapshot.
 *      Sila-specific rows appear ONLY while actually paired; the
 *      local book and the store's own numbers never require linking.
 *   3. Charts + top products + export (unchanged).
 *
 * Accounting rule kept from Square's house accounts: a repayment is
 * an asset swap (debt → cash), NEVER revenue — credit invoices are
 * inside revenue, and «النقد المحصّل» adds the collections back.
 */
import React, {useCallback, useState} from 'react';
import {Dimensions, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import {
  AppButton,
  AppHeader,
  Card,
  EmptyState,
  SectionTitle,
  Segmented,
  StatCard,
} from '../../components/ui';
import {ErrorBoundary} from '../../components/ErrorBoundary';
import {BarChart} from '../../components/charts/BarChart';
import {ReportService, type ReportBundle} from '../../services/ReportService';
import {ExportService} from '../../services/ExportService';
import {useToastStore} from '../../stores/toastStore';
import {
  fonts,
  makeStyles,
  radius,
  spacing,
  typography,
  useThemeColors,
} from '../../core/theme';
import {formatMoney} from '../../core/format';
import type {ReportRangeKey} from '../../core/types';

const CHART_WIDTH =
  Dimensions.get('window').width - spacing.lg * 2 - spacing.lg * 2;

const RANGE_OPTIONS: {value: ReportRangeKey; label: string}[] = [
  {value: 'today', label: 'اليوم'},
  {value: 'yesterday', label: 'أمس'},
  {value: 'last7', label: '7 أيام'},
  {value: 'thisMonth', label: 'الشهر'},
  {value: 'all', label: 'الكل'},
];

export function ReportsScreen() {
  const c = useThemeColors();
  const styles = useStyles();
  const navigation = useNavigation<any>();
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
        const path = await ExportService.exportSalesReport(
          rangeKey,
          undefined,
          format,
        );
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

  const dailyData = (bundle?.daily ?? []).slice(-10).map(point => ({
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

  const cash = bundle?.cash;
  const paired = cash?.paired ?? false;

  return (
    <View style={styles.screen}>
      <AppHeader
        title="التقارير"
        subtitle="المبيعات والنقد والديون"
        showBack={false}
        right={
          <AppButton
            small
            title="الفواتير"
            icon="inbox"
            onPress={() => navigation.navigate('Invoices' as never)}
          />
        }
      />

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}>
        <Segmented
          value={rangeKey}
          onChange={setRangeKey}
          options={RANGE_OPTIONS}
        />

        {loading && !bundle ? (
          <EmptyState icon="chart" title="جارٍ تحميل التقارير…" />
        ) : bundle ? (
          <>
            {/* ── 1) ملخص المبيعات — clean 2×3 KPI grid ─────── */}
            <SectionTitle title="ملخص المبيعات" />
            <View style={styles.statsGrid}>
              <View style={styles.statsCell}>
                <StatCard
                  label="إجمالي المبيعات"
                  value={formatMoney(bundle.summary.revenue)}
                  tone="accent"
                  icon="wallet"
                />
              </View>
              <View style={styles.statsCell}>
                <StatCard
                  label="صافي الربح"
                  value={formatMoney(bundle.summary.netProfit)}
                  tone={bundle.summary.netProfit >= 0 ? 'success' : 'danger'}
                  icon="chart"
                />
              </View>
              <View style={styles.statsCell}>
                <StatCard
                  label="التكلفة (COGS)"
                  value={formatMoney(bundle.summary.cogs)}
                  icon="calculator"
                />
              </View>
              <View style={styles.statsCell}>
                <StatCard
                  label="عدد الفواتير"
                  value={String(bundle.summary.invoicesCount)}
                  icon="inbox"
                />
              </View>
              <View style={styles.statsCell}>
                <StatCard
                  label="متوسط الفاتورة"
                  value={formatMoney(bundle.summary.avgInvoice)}
                  icon="tag"
                />
              </View>
              <View style={styles.statsCell}>
                <StatCard
                  label="القطع المبيعة"
                  value={String(bundle.summary.itemsCount)}
                  icon="box"
                />
              </View>
            </View>

            {/* ── 2) النقد والديون — ONE clean card (v18) ────── */}
            <Card>
              <SectionTitle
                title="النقد والديون"
                hint={
                  paired
                    ? 'النقد الفعلي بالفترة + ديونك — صِلة مُفعّلة'
                    : 'النقد الفعلي بالفترة + ديونك — بدون أي ربط'
                }
              />

              {/* 2-أ) The net cash hero. */}
              <View style={styles.cashHero}>
                <Text style={styles.cashHeroLabel}>النقد المحصّل بالفترة</Text>
                <Text style={[styles.cashHeroValue, {color: c.accent}]}>
                  {formatMoney(cash?.collected ?? 0)}
                </Text>
                <Text style={styles.cashHeroMeta}>
                  مبيعات نقدية {formatMoney(cash?.salesCash ?? 0)} + مقبوضات
                  (ديون وحملات) {formatMoney(cash?.collections ?? 0)}
                </Text>
              </View>

              {/* 2-ب) Collections received in the range. */}
              <Text style={styles.subTitle}>المقبوضات المستلمة بالفترة</Text>
              <View style={styles.rowBox}>
                <View style={styles.rowLine}>
                  <Text style={styles.rowLabel}>
                    إجمالي المقبوضات (سداد ديون)
                  </Text>
                  <Text style={[styles.rowValue, {color: c.success}]}>
                    {formatMoney(cash?.collections ?? 0)}
                  </Text>
                </View>
                <View style={styles.rowLine}>
                  <Text style={styles.rowLabel}>منها: دفتر المتجر</Text>
                  <Text style={styles.rowValue}>
                    {formatMoney(cash?.localBookAmount ?? 0)}
                  </Text>
                </View>
                {paired ? (
                  <>
                    <View style={styles.rowLine}>
                      <Text style={styles.rowLabel}>
                        منها: سدادّات استلمها الكاشير (فواتير صِلة)
                      </Text>
                      <Text style={styles.rowValue}>
                        {formatMoney(cash?.cashierSilaAmount ?? 0)}
                      </Text>
                    </View>
                    <View style={styles.rowLine}>
                      <Text style={styles.rowLabel}>
                        منها: تحصيلات عبر تطبيق صِلة
                      </Text>
                      <Text style={styles.rowValue}>
                        {formatMoney(cash?.viaSilaAppAmount ?? 0)}
                      </Text>
                    </View>
                    <View style={styles.rowLine}>
                      <Text style={styles.rowLabel}>
                        منها: سدّدها رصيد مسبق للزبون
                      </Text>
                      <Text style={styles.rowValue}>
                        {formatMoney(cash?.prepaidAmount ?? 0)}
                      </Text>
                    </View>
                    {/* v20: money actually received from institutions
                        (confirmed settlements only — pending ones wait
                        for the merchant's receipt confirmation). */}
                    {(cash?.campaignSettlementsAmount ?? 0) > 0 ? (
                      <View style={styles.rowLine}>
                        <Text style={styles.rowLabel}>
                          منها: تسويات الحملات (قسائم مؤكّدة)
                        </Text>
                        <Text style={[styles.rowValue, {color: c.success}]}>
                          {formatMoney(cash?.campaignSettlementsAmount ?? 0)}
                        </Text>
                      </View>
                    ) : null}
                  </>
                ) : null}
              </View>

              {/* 2-ج) Credit invoices issued in the range. */}
              <Text style={styles.subTitle}>فواتير الدين بالفترة</Text>
              <View style={styles.rowBox}>
                <View style={styles.rowLine}>
                  <Text style={styles.rowLabel}>
                    إجمالي مبيعات الدين · {cash?.creditSalesCount ?? 0} فاتورة
                  </Text>
                  <Text style={[styles.rowValue, {color: c.warning}]}>
                    {formatMoney(cash?.creditSalesAmount ?? 0)}
                  </Text>
                </View>
                <View style={styles.rowLine}>
                  <Text style={styles.rowLabel}>منها: دفتر المتجر (INV-L)</Text>
                  <Text style={styles.rowValue}>
                    {formatMoney(cash?.localCreditSalesAmount ?? 0)}
                  </Text>
                </View>
                {paired ? (
                  <View style={styles.rowLine}>
                    <Text style={styles.rowLabel}>منها: عبر صِلة (INV-D)</Text>
                    <Text style={styles.rowValue}>
                      {formatMoney(cash?.silaCreditSalesAmount ?? 0)}
                    </Text>
                  </View>
                ) : null}
              </View>

              {/* 2-ج-2) v20: مبيعات القسائم الشرائية بالفترة — the
                  campaigns column (face value from the server + the
                  goods invoices + the counter difference). Shown when
                  there is any voucher activity in the range.
                  v21 (round-27 #1): every figure counts ACTIVE-IN-STORE
                  campaigns only (the merchant's own switch). */}
              {(cash?.voucherSalesCount ?? 0) > 0 ? (
                <>
                  <Text style={styles.subTitle}>القسائم الشرائية بالفترة</Text>
                  <View style={styles.rowBox}>
                    <View style={styles.rowLine}>
                      <Text style={styles.rowLabel}>
                        قسائم مصروفة · {cash?.voucherSalesCount ?? 0} عملية
                      </Text>
                      <Text style={[styles.rowValue, {color: c.info}]}>
                        {formatMoney(cash?.voucherSalesAmount ?? 0)}
                      </Text>
                    </View>
                    <View style={styles.rowLine}>
                      <Text style={styles.rowLabel}>
                        منها: بضاعة مسجّلة (INV-V)
                      </Text>
                      <Text style={styles.rowValue}>
                        {formatMoney(cash?.voucherGoodsAmount ?? 0)}
                      </Text>
                    </View>
                    {(cash?.voucherCounterExtraAmount ?? 0) > 0 ? (
                      <View style={styles.rowLine}>
                        <Text style={styles.rowLabel}>
                          منها: فرق نقدي استُلم فوراً بالكاشير
                        </Text>
                        <Text style={styles.rowValue}>
                          {formatMoney(cash?.voucherCounterExtraAmount ?? 0)}
                        </Text>
                      </View>
                    ) : null}
                    <View style={styles.rowLine}>
                      <Text style={styles.rowLabel}>
                        تسويات مؤكّدة وصلت بالفترة
                      </Text>
                      <Text style={styles.rowValue}>
                        {formatMoney(cash?.campaignSettlementsAmount ?? 0)}
                      </Text>
                    </View>
                    {(cash?.campaignDueMinor ?? 0) > 0 ? (
                      <View style={styles.rowLine}>
                        <Text style={styles.rowLabel}>
                          المستحق الآن من الحملات الفعّالة (دين على المؤسسات)
                        </Text>
                        <Text style={[styles.rowValue, {color: c.warning}]}>
                          {formatMoney((cash?.campaignDueMinor ?? 0) / 100)}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                </>
              ) : null}

              {/* 2-د) The outstanding snapshot — receivables now.
                  v19 (round-25 #2): the informational app-origin cell
                  appears ONLY when it actually carries debt — a
                  permanent 0.00 cell (the complaint «دائما صفر»)
                  taught the merchant nothing and looked broken. */}
              <Text style={styles.subTitle}>الدين القائم الآن</Text>
              <View style={styles.outstandingGrid}>
                <View
                  style={
                    (cash?.appOriginOutstandingMinor ?? 0) > 0
                      ? styles.outstandingCell
                      : styles.outstandingCellFull
                  }>
                  <Text style={styles.outstandingValue}>
                    {formatMoney(
                      ((cash?.localOutstandingMinor ?? 0) +
                        (paired ? cash?.silaOutstandingMinor ?? 0 : 0)) /
                        100,
                    )}
                  </Text>
                  <Text style={styles.outstandingMeta}>
                    {paired
                      ? `${
                          (cash?.localDebtorsCount ?? 0) +
                          (cash?.silaDebtorsCount ?? 0)
                        } زبون مدين — دفتر المتجر + صِلة`
                      : `${
                          cash?.localDebtorsCount ?? 0
                        } زبون مدين — دفتر المتجر`}
                  </Text>
                </View>
                {paired && (cash?.appOriginOutstandingMinor ?? 0) > 0 ? (
                  <View style={styles.outstandingCellInfo}>
                    <Text style={styles.outstandingValueInfo}>
                      {formatMoney(
                        (cash?.appOriginOutstandingMinor ?? 0) / 100,
                      )}
                    </Text>
                    <Text style={styles.outstandingMeta}>
                      ديون تطبيق صِلة — للمعلومية فقط، ليست من مبيعاتك
                    </Text>
                  </View>
                ) : null}
              </View>

              <Text style={styles.chartHint}>
                المبيعات أعلاه تشمل فواتير الدين لأنها بضاعة خرجت من مخزونك؛
                «النقد المحصّل» يطرحها ويعيد إضافة ما استلمته فعلاً من
                المقبوضات. السداد ليس إيراداً — إنه تحويل الدين إلى نقد.
              </Text>
            </Card>

            {/* ── 3) Daily sales chart ────────────────────────── */}
            <Card>
              <SectionTitle
                title="أداء المبيعات اليومي"
                hint="القيم بالشيكل ₪"
              />
              <ErrorBoundary inline label="رسم المبيعات">
                <BarChart
                  data={dailyData}
                  width={CHART_WIDTH}
                  color={c.accent}
                  formatTick={(value: number) => compactNumber(value)}
                  emptyText="لا توجد مبيعات في هذه الفترة"
                />
              </ErrorBoundary>
            </Card>

            {/* ── 4) Peak hours chart ─────────────────────────── */}
            <Card>
              <SectionTitle
                title="ساعات الذروة"
                hint="الإيراد لكل ساعة خلال الفترة (0–24)"
              />
              <ErrorBoundary inline label="رسم الذروة">
                <BarChart
                  data={hourlyData}
                  width={CHART_WIDTH}
                  height={120}
                  color={c.info}
                  formatTick={(value: number) => compactNumber(value)}
                  emptyText="لا توجد مبيعات في هذه الفترة"
                />
              </ErrorBoundary>
              <Text style={styles.chartHint}>
                استخدم الرسم لتحديد أكثر ساعات تواجد الزبائن وجهّز المخزون
                والطاقم لها
              </Text>
            </Card>

            {/* ── 5) Top products ─────────────────────────────── */}
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
                <EmptyState
                  icon="box"
                  title="لا توجد مبيعات بعد"
                  subtitle="أفضل منتجاتك ستظهر هنا بعد أول فاتورة"
                />
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
                      <Text style={styles.topMeta}>
                        {product.quantity} قطعة مبيعة
                      </Text>
                    </View>
                    <View style={styles.topEnd}>
                      <Text style={styles.topRevenue}>
                        {formatMoney(
                          topMode === 'revenue'
                            ? product.revenue
                            : product.profit,
                        )}
                      </Text>
                      <Text
                        style={[
                          styles.topProfit,
                          {color: product.profit >= 0 ? c.success : c.danger},
                        ]}>
                        ربح {formatMoney(product.profit)}
                      </Text>
                    </View>
                  </View>
                ))
              )}
            </Card>

            {/* ── 6) Export ───────────────────────────────────── */}
            <Card>
              <SectionTitle
                title="تصدير التقارير"
                hint="تُحفظ في مجلد التنزيلات وتفتح في Excel"
              />
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
                      const path = await ExportService.exportTopProducts(
                        rangeKey,
                        undefined,
                        'csv',
                      );
                      toast(`تم الحفظ: ${path}`, 'success', 4000);
                    } catch (error) {
                      toast(
                        error instanceof Error ? error.message : String(error),
                        'error',
                      );
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

const useStyles = makeStyles(c =>
  StyleSheet.create({
    screen: {flex: 1, backgroundColor: c.bg},
    content: {
      padding: spacing.lg,
      gap: spacing.lg,
      paddingBottom: spacing.xxl,
    },
    statsGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.md,
    },
    statsCell: {
      width: '47.5%',
      flexGrow: 1,
    },
    chartHint: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      lineHeight: 17,
      marginTop: spacing.md,
    },
    // ── v18 (round-24 #2): the النقد والديون card styles ────────
    subTitle: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.small,
      marginTop: spacing.md,
      marginBottom: spacing.xs,
      borderRightWidth: 3,
      borderRightColor: c.accent,
      paddingRight: spacing.sm,
    },
    cashHero: {
      backgroundColor: c.surfaceHi,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.borderSoft,
      padding: spacing.md,
      alignItems: 'center',
      gap: 3,
    },
    cashHeroLabel: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    cashHeroValue: {
      fontFamily: fonts.black,
      fontSize: typography.title + 4,
      fontVariant: ['tabular-nums'],
    },
    cashHeroMeta: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      textAlign: 'center',
    },
    rowBox: {
      backgroundColor: c.surfaceHi,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.borderSoft,
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.md,
      gap: 6,
    },
    rowLine: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    rowLabel: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 2,
      flex: 1,
      textAlign: 'left',
    },
    rowValue: {
      fontFamily: fonts.bold,
      fontSize: typography.small,
      color: c.text,
      fontVariant: ['tabular-nums'],
    },
    outstandingGrid: {
      flexDirection: 'row',
      gap: spacing.sm,
    },
    outstandingCell: {
      flex: 1,
      backgroundColor: c.surfaceHi,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.borderSoft,
      padding: spacing.sm + 2,
      gap: 2,
      alignItems: 'center',
    },
    outstandingCellFull: {
      flexGrow: 1,
      backgroundColor: c.surfaceHi,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.borderSoft,
      padding: spacing.sm + 2,
      gap: 2,
      alignItems: 'center',
    },
    outstandingCellInfo: {
      flex: 1,
      backgroundColor: c.surface,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.borderSoft,
      padding: spacing.sm + 2,
      gap: 2,
      alignItems: 'center',
    },
    outstandingValue: {
      fontFamily: fonts.black,
      fontSize: typography.body,
      color: c.danger,
      fontVariant: ['tabular-nums'],
    },
    outstandingValueInfo: {
      fontFamily: fonts.black,
      fontSize: typography.body,
      color: c.info,
      fontVariant: ['tabular-nums'],
    },
    outstandingMeta: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro,
      textAlign: 'center',
    },
    topRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: 9,
      borderBottomWidth: 1,
      borderBottomColor: c.borderSoft,
    },
    topRank: {
      width: 28,
      height: 28,
      borderRadius: 9,
      backgroundColor: c.accentSoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    topRankText: {
      color: c.accent,
      fontFamily: fonts.black,
      fontSize: typography.small,
    },
    topInfo: {flex: 1},
    topName: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.caption,
    },
    topMeta: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      marginTop: 1,
    },
    topEnd: {alignItems: 'flex-end'},
    topRevenue: {
      color: c.text,
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
  }),
);
