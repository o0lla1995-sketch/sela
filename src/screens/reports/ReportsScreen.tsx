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
import {Dimensions, ScrollView, StyleSheet, Text, TouchableOpacity, View} from 'react-native';
import {useFocusEffect} from '@react-navigation/native';
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
import {Icon} from '../../components/Icon';
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
import {formatMoney, dayMonthLabel, weekdayLabel} from '../../core/format';
import type {ReportRangeKey} from '../../core/types';
import type {BarDatum} from '../../components/charts/BarChart';

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
  const toast = useToastStore(state => state.show);
  const [rangeKey, setRangeKey] = useState<ReportRangeKey>('last7');
  const [bundle, setBundle] = useState<ReportBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState<'csv' | 'xls' | null>(null);
  const [topMode, setTopMode] = useState<'revenue' | 'profit'>('revenue');
  // v26 (round-34 #6): the cash & debts sections start COLLAPSED —
  // each shows its HEADLINE number; one tap expands the details
  // («بشكل مختصر ويتوسع عند الضغط عليه لعرض التفاصيل»). The hero
  // collected-cash, the net-of-movements number and the standing
  // debt stay ALWAYS visible («يبقى التفاصيل المهمة ظاهرة»).
  const [openSections, setOpenSections] = useState<Record<string, boolean>>(
    {},
  );
  const toggleSection = useCallback((key: string) => {
    setOpenSections(prev => ({...prev, [key]: !prev[key]}));
  }, []);

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

  // v42 (الجولة 50 #3): رسم المبيعات يتبع الفترة المحددة بدقة
  //  — لا اقتطاع لآخر عشرة أعمدة بعد اليوم ولا أسماء أسابيع
  //  مكررة تُضيّع موضع اليوم:
  //  • فترة قصيرة (اليوم/أمس/٧ أيام): كل عمود يحمل تاريخه الفعلي
  //    (٩/١٠) فوق اسم يومه — العمود وموضعه لا لبس فيهما.
  //  • الشهر: أرقام أيام الشهر ١..٣١ (الفترة كلها ظاهرة).
  //  • ما تجاوز ٦٢ يوماً («الكل»): سلسلة شهرية من المستودع —
  //    أسماء الشهور الشامية والسنة تحتها، مع تخفيف التسميات
  //    عند الازدحام.
  const dailyPoints = bundle?.daily ?? [];
  const isMonthlySeries = dailyPoints.some(p => p.day.length === 7);
  const dailyData: BarDatum[] = dailyPoints.map((point, index) => {
    const value = Math.round(point.revenue * 100) / 100;
    if (isMonthlySeries) {
      const total = dailyPoints.length;
      const step = Math.max(1, Math.ceil(total / 8));
      const [year, monthNum] = point.day.split('-');
      const showLabel = index % step === 0 || index === total - 1;
      return {
        value,
        label: showLabel ? point.label : '',
        sublabel:
          showLabel && (monthNum === '01' || index === 0) ? year : '',
      };
    }
    // الشهر الحالي (أو أي سلسلة يومية مزدحمة > ١٤ يوماً): رقم
    //  اليوم فقط — أوسع تغطية بأصغر مساحة.
    if (rangeKey === 'thisMonth' || dailyPoints.length > 14) {
      return {
        value,
        label: String(Number(point.day.slice(8, 10))),
        sublabel: '',
      };
    }
    // اليوم/أمس/آخر ٧ أيام: التاريخ فوق اسم اليوم.
    return {
      value,
      label: dayMonthLabel(point.day),
      sublabel: weekdayLabel(point.day),
    };
  });

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
      {/* v26 (round-34 #6): the الخزينة + الفواتير header buttons are
          GONE — they live in the Home quick actions now (the user's
          own reorganization), so the reports header stays clean. */}
      <AppHeader
        title="التقارير"
        subtitle="المبيعات والنقد والديون"
        showBack={false}
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
              {/* v23 (round-29 #2): the period's returns — their own
                  KPI so a refund never hides inside the net numbers. */}
              <View style={styles.statsCell}>
                <StatCard
                  label="المرتجعات"
                  value={`${formatMoney(bundle.summary.returnsTotal)}${
                    bundle.summary.returnsCount > 0
                      ? ` · ${bundle.summary.returnsCount} إيصال`
                      : ''
                  }`}
                  tone={bundle.summary.returnsTotal > 0 ? 'danger' : undefined}
                  icon="undo"
                />
              </View>
              {/* v26 (round-34 #3): the period's DISCOUNTS — their own
                  KPI so «تفاصيل الخصم» is explicit in the summary
                  (returns already net every number above). */}
              <View style={styles.statsCell}>
                <StatCard
                  label="الخصومات"
                  value={formatMoney(bundle.cash?.discountTotal ?? 0)}
                  icon="tag"
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

              {/* 2-ب) Collections received in the range — v26: brief
                  headline (the total) + expandable breakdown. */}
              <CollapseSection
                title="المقبوضات المستلمة بالفترة (سداد الديون)"
                valueText={formatMoney(cash?.collections ?? 0)}
                valueColor={c.success}
                open={openSections.collections === true}
                onToggle={() => toggleSection('collections')}
                show={(cash?.collections ?? 0) > 0}>
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
                      {/* v22 (round-28 #2): money received from the
                          campaign institutions in the range — «المستلم»
                          (server truth: pending + confirmed). */}
                      {(cash?.campaignSettlementsAmount ?? 0) > 0 ? (
                        <View style={styles.rowLine}>
                          <Text style={styles.rowLabel}>
                            منها: مستلم من حملات القسائم (المؤسسات)
                          </Text>
                          <Text style={[styles.rowValue, {color: c.success}]}>
                            {formatMoney(cash?.campaignSettlementsAmount ?? 0)}
                          </Text>
                        </View>
                      ) : null}
                    </>
                  ) : null}
                </View>
              </CollapseSection>

              {/* 2-ج) Credit invoices issued in the range — v26:
                  headline (count + total) + expandable split. */}
              <CollapseSection
                title={`فواتير الدين بالفترة · ${cash?.creditSalesCount ?? 0} فاتورة`}
                valueText={formatMoney(cash?.creditSalesAmount ?? 0)}
                valueColor={c.warning}
                open={openSections.credit === true}
                onToggle={() => toggleSection('credit')}
                show={(cash?.creditSalesCount ?? 0) > 0}>
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
                  {/* v24 (round-31 #3): the coupon-born debts of the
                      period — the claims created on the institutions by
                      voucher redemptions (face value), until the
                      settlements land. Its own line, NOT a «منها» of
                      the customer-debt total above. */}
                  {(cash?.voucherCreditSalesAmount ?? 0) > 0 ? (
                    <View style={styles.rowLine}>
                      <Text style={styles.rowLabel}>
                        عبر قسائم صِلة · {cash?.voucherCreditSalesCount ?? 0}{' '}
                        عملية صرف (مستحقات على المؤسسات حتى التسوية)
                      </Text>
                      <Text style={[styles.rowValue, {color: c.info}]}>
                        {formatMoney(cash?.voucherCreditSalesAmount ?? 0)}
                      </Text>
                    </View>
                  ) : null}
                </View>
              </CollapseSection>

              {/* 2-ج-2) v20: مبيعات القسائم الشرائية بالفترة — v26:
                  collapsed headline (count + face value) with the
                  goods/settlements split inside. Shown only when there
                  is voucher activity in the range. v21: every figure
                  counts ACTIVE-IN-STORE campaigns only. */}
              <CollapseSection
                title={`القسائم الشرائية بالفترة · ${cash?.voucherSalesCount ?? 0} عملية`}
                valueText={formatMoney(cash?.voucherSalesAmount ?? 0)}
                valueColor={c.info}
                open={openSections.vouchers === true}
                onToggle={() => toggleSection('vouchers')}
                show={(cash?.voucherSalesCount ?? 0) > 0}>
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
                      مستلم تسويات الحملات بالفترة
                    </Text>
                    <Text style={styles.rowValue}>
                      {formatMoney(cash?.campaignSettlementsAmount ?? 0)}
                    </Text>
                  </View>
                  {(cash?.campaignDueMinor ?? 0) > 0 ? (
                    <View style={styles.rowLine}>
                      <Text style={styles.rowLabel}>
                        المستحق الآن من الحملات المفعّلة (دين على المؤسسات)
                      </Text>
                      <Text style={[styles.rowValue, {color: c.warning}]}>
                        {formatMoney((cash?.campaignDueMinor ?? 0) / 100)}
                      </Text>
                    </View>
                  ) : null}
                </View>
              </CollapseSection>

              {/* 2-ج-3) v25 (round-32 #3) → v26: المصروفات والمسحوبات
                  بالفترة — the headline is the section's IMPORTANT
                  number (صافي النقد بعد الحركات) and stays visible
                  always; the breakdown expands on press. */}
              <CollapseSection
                title="صافي النقد بالفترة (بعد المصروفات والمسحوبات)"
                valueText={formatMoney(cash?.netCashAfterMovements ?? 0)}
                valueColor={
                  (cash?.netCashAfterMovements ?? 0) >= 0
                    ? c.success
                    : c.danger
                }
                open={openSections.movements === true}
                onToggle={() => toggleSection('movements')}
                show={
                  (cash?.expensesCount ?? 0) > 0 ||
                  (cash?.withdrawalsCount ?? 0) > 0 ||
                  (cash?.depositsCount ?? 0) > 0
                }>
                <View style={styles.rowBox}>
                  {(cash?.expensesCount ?? 0) > 0 ? (
                    <View style={styles.rowLine}>
                      <Text style={styles.rowLabel}>
                        مصروفات · {cash?.expensesCount ?? 0} سند
                      </Text>
                      <Text style={[styles.rowValue, {color: c.danger}]}>
                        − {formatMoney(cash?.expensesAmount ?? 0)}
                      </Text>
                    </View>
                  ) : null}
                  {(cash?.withdrawalsCount ?? 0) > 0 ? (
                    <View style={styles.rowLine}>
                      <Text style={styles.rowLabel}>
                        مسحوبات رصيد · {cash?.withdrawalsCount ?? 0} سند
                      </Text>
                      <Text style={[styles.rowValue, {color: c.danger}]}>
                        − {formatMoney(cash?.withdrawalsAmount ?? 0)}
                      </Text>
                    </View>
                  ) : null}
                  {(cash?.depositsCount ?? 0) > 0 ? (
                    <View style={styles.rowLine}>
                      <Text style={styles.rowLabel}>
                        إيداعات نقدية · {cash?.depositsCount ?? 0} سند
                      </Text>
                      <Text style={[styles.rowValue, {color: c.success}]}>
                        + {formatMoney(cash?.depositsAmount ?? 0)}
                      </Text>
                    </View>
                  ) : null}
                  <View style={styles.rowLine}>
                    <Text
                      style={[
                        styles.rowLabel,
                        {fontFamily: fonts.bold, color: c.text},
                      ]}>
                      صافي النقد بالفترة (بعد المصروفات والمسحوبات)
                    </Text>
                    <Text
                      style={[
                        styles.rowValue,
                        {
                          fontFamily: fonts.bold,
                          color: (cash?.netCashAfterMovements ?? 0) >= 0
                            ? c.success
                            : c.danger,
                        },
                      ]}>
                      {formatMoney(cash?.netCashAfterMovements ?? 0)}
                      </Text>
                    </View>
                </View>
              </CollapseSection>

              {/* 2-د) The outstanding snapshot — receivables now.
                  v26 (round-34 #6): the informational «ديون تطبيق صِلة
                  للمعلومية» cell is GONE (the user's call) — its place
                  now carries the LIVE «النقد بالخزينة الآن» cell, the
                  drawer's real number from the treasury equation, so
                  the two numbers the merchant checks side by side
                  (what I'm owed / what I hold) are one glance apart. */}
              <Text style={styles.subTitle}>الدين القائم الآن</Text>
              <View style={styles.outstandingGrid}>
                <View style={styles.outstandingCell}>
                  <Text style={styles.outstandingValue}>
                    {formatMoney(
                      ((cash?.localOutstandingMinor ?? 0) +
                        (paired ? cash?.silaOutstandingMinor ?? 0 : 0) +
                        (cash?.campaignDueMinor ?? 0)) /
                        100,
                    )}
                  </Text>
                  <Text style={styles.outstandingMeta}>
                    {(cash?.campaignDueMinor ?? 0) > 0
                      ? paired
                        ? `${
                            (cash?.localDebtorsCount ?? 0) +
                            (cash?.silaDebtorsCount ?? 0)
                          } زبون + مستحقات الحملات — دفتر المتجر + صِلة + المؤسسات`
                        : `${
                            cash?.localDebtorsCount ?? 0
                          } زبون + مستحقات الحملات — دفتر المتجر + المؤسسات`
                      : paired
                      ? `${
                          (cash?.localDebtorsCount ?? 0) +
                          (cash?.silaDebtorsCount ?? 0)
                        } زبون مدين — دفتر المتجر + صِلة`
                      : `${
                          cash?.localDebtorsCount ?? 0
                        } زبون مدين — دفتر المتجر`}
                  </Text>
                </View>
                {/* v26: النقد بالخزينة الآن — the live drawer number
                    (replaced the informational sila-app-debts cell). */}
                <View style={styles.outstandingCellInfo}>
                  <Text
                    style={[
                      styles.outstandingValueInfo,
                      {color: c.success},
                    ]}>
                    {formatMoney((cash?.cashNowMinor ?? 0) / 100)}
                  </Text>
                  <Text style={styles.outstandingMeta}>
                    النقد بالخزينة الآن — بعد المصروفات والمسحوبات
                  </Text>
                </View>
              </View>

              {/* v32 (round-40 #6): تمييز هذا المتجر — عندما تجمع
                  أرصدة صِلة فواتير من متاجر التاجر الأخرى فوق دين
                  هذا المتجر، يظهر الفارق للمعلومية حتى تبقى الأرقام
                  المعتمدة أعلاه «متجرك هو فقط». */}
              {paired &&
              (cash?.silaServerPosOutstandingMinor ?? 0) -
                (cash?.silaOutstandingMinor ?? 0) >=
                100 ? (
                <Text style={styles.silaOwnNote}>
                  ديون صِلة أعلاه ({formatMoney(
                    (cash?.silaOutstandingMinor ?? 0) / 100,
                  )}) هي فواتير هذا المتجر فقط من دفاترك المحلية — أرصدة صِلة
                  الكاملة تجمع {formatMoney(
                    (cash?.silaServerPosOutstandingMinor ?? 0) / 100,
                  )} تشمل فواتير من متاجر التاجر الأخرى المرتبطة بنفس الحساب.
                </Text>
              ) : null}

              <Text style={styles.chartHint}>
                المبيعات أعلاه تشمل فواتير الدين لأنها بضاعة خرجت من مخزونك؛
                «النقد المحصّل» يطرحها ويعيد إضافة ما استلمته فعلاً من
                المقبوضات. السداد ليس إيراداً — إنه تحويل الدين إلى نقد.
              </Text>
            </Card>

            {/* ── 3) Sales performance chart ─────────────────── */}
            <Card>
              {/* v42 (الجولة 50 #3): العنوان يتبع حبيبية السلسلة —
                  يومية للفترات القصيرة وشهرية لما طال («الكل»). */}
              <SectionTitle
                title={
                  isMonthlySeries
                    ? 'أداء المبيعات الشهري'
                    : 'أداء المبيعات اليومي'
                }
                hint={
                  isMonthlySeries
                    ? 'إجمالي كل شهر بالشيكل ₪'
                    : 'القيم بالشيكل ₪ — كل عمود يحمل تاريخه'
                }
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

            {/* ── 5) Top products — v37 (الجولة 45 #3أ) ──────────
                إعادة تصميم قسم «الأكثر إيراداً وربحاً» بشكل احترافي:
                ترويسة متمركزة في منتصف الشاشة (العنوان ثم المبدّل
                تحته — إزالة المسافات الواسعة)، وكل منتج صف مضغوط:
                ميدالية مرتبة (ذهب/فضة/برونز) + الاسم والقيمة في
                سطر واحد + شريط نسبي يقيس قيمته مقابل الأعلى في
                الفترة + الربح والكمية في سطر الميتا. المحاذاة
                جدولية بأرقام ثابتة العرض. */}
            <Card>
              <View style={styles.topHead}>
                <Text style={styles.topHeadTitle}>
                  الأكثر إيراداً وربحاً
                </Text>
                <Text style={styles.topHeadSub}>
                  أفضل خمسة منتجات في الفترة — والبقية في التصدير
                </Text>
                <Segmented
                  compact
                  value={topMode}
                  onChange={setTopMode}
                  options={[
                    {value: 'revenue', label: 'إيراداً'},
                    {value: 'profit', label: 'ربحاً'},
                  ]}
                />
              </View>
              {topProducts.length === 0 ? (
                <EmptyState
                  icon="box"
                  title="لا توجد مبيعات بعد"
                  subtitle="أفضل منتجاتك ستظهر هنا بعد أول فاتورة"
                />
              ) : (
                /* v26 (round-34 #6): the TOP FIVE only — «يظهر فقط
                    أكثر خمسة فقط» — the rest live in the CSV export. */
                (() => {
                  const five = topProducts.slice(0, 5);
                  const valueOf = (p: (typeof five)[number]) =>
                    Math.max(
                      topMode === 'revenue' ? p.revenue : p.profit,
                      0,
                    );
                  const maxShown = Math.max(
                    ...five.map(valueOf),
                    0.0001,
                  );
                  return five.map((product, index) => {
                    const shown = valueOf(product);
                    const pct = Math.max(6, Math.round((shown / maxShown) * 100));
                    return (
                      <View key={product.productId} style={styles.topRow}>
                        <View
                          style={[
                            styles.topRank,
                            index === 0
                              ? styles.topRankGold
                              : index === 1
                              ? styles.topRankSilver
                              : index === 2
                              ? styles.topRankBronze
                              : null,
                          ]}>
                          <Text style={styles.topRankText}>{index + 1}</Text>
                        </View>
                        <View style={styles.topInfo}>
                          <View style={styles.topLineRow}>
                            <Text style={styles.topName} numberOfLines={1}>
                              {product.name}
                            </Text>
                            <Text style={styles.topRevenue}>
                              {formatMoney(shown)}
                            </Text>
                          </View>
                          <View style={styles.topBarTrack}>
                            <View
                              style={[
                                styles.topBarFill,
                                {width: `${pct}%`},
                                product.profit < 0 ? styles.topBarLoss : null,
                              ]}
                            />
                          </View>
                          <Text style={styles.topMeta}>
                            {product.quantity} قطعة مبيعة · ربح{' '}
                            <Text
                              style={[
                                styles.topProfit,
                                {
                                  color:
                                    product.profit >= 0
                                      ? c.success
                                      : c.danger,
                                },
                              ]}>
                              {formatMoney(product.profit)}
                            </Text>
                          </Text>
                        </View>
                      </View>
                    );
                  });
                })()
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

// ────────────────────────────────────────────────────────────────
// v26 (round-34 #6): CollapseSection — the reports card's brief
// rows. The HEADLINE (title + the section's key number + chevron)
// is ALWAYS visible; the details expand under it on press. Returns
// null entirely when `show` is false (sections with no activity in
// the period never leave an empty stub).
// ────────────────────────────────────────────────────────────────
function CollapseSection({
  title,
  valueText,
  valueColor,
  open,
  onToggle,
  show = true,
  children,
}: {
  title: string;
  valueText: string;
  valueColor?: string;
  open: boolean;
  onToggle: () => void;
  show?: boolean;
  children: React.ReactNode;
}) {
  const c = useThemeColors();
  const styles = useStyles();
  if (!show) {
    return null;
  }
  return (
    <>
      <TouchableOpacity
        style={styles.collapseHead}
        onPress={onToggle}
        activeOpacity={0.7}>
        <Icon
          name={open ? 'chevronDown' : 'chevronLeft'}
          size={13}
          color={c.textFaint}
        />
        <Text style={styles.collapseTitle} numberOfLines={1}>
          {title}
        </Text>
        <Text
          style={[
            styles.collapseValue,
            valueColor != null ? {color: valueColor} : null,
          ]}
          numberOfLines={1}>
          {valueText}
        </Text>
      </TouchableOpacity>
      {open ? <View style={styles.collapseBody}>{children}</View> : null}
    </>
  );
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
    /** v32 (round-40 #6): ملاحظة تمييز ديون المتجر عن كل المتاجر. */
    silaOwnNote: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      lineHeight: 17,
      marginTop: -spacing.xs,
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
    // ── v26 (round-34 #6): the collapsible section styles ────────
    collapseHead: {
      flexDirection: 'row-reverse',
      alignItems: 'center',
      gap: 8,
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: radius.md,
      backgroundColor: c.surfaceHi,
      paddingHorizontal: spacing.md,
      paddingVertical: 11,
      marginTop: spacing.md,
    },
    collapseTitle: {
      flex: 1,
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.small,
      textAlign: 'left',
    },
    collapseValue: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: typography.small,
      fontVariant: ['tabular-nums'],
    },
    collapseBody: {
      marginTop: 6,
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
      marginTop: spacing.xs,
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
    /** v37 (الجولة 45 #3أ): ترويسة القسم المتمركزة — العنوان
     *  والوصف والمبدّل في منتصف الشاشة (كانت الترويسة بلا محاذاة
     *  والمبدّل بزاوية). */
    topHead: {
      alignItems: 'center',
      gap: 5,
      marginBottom: spacing.sm,
    },
    topHeadTitle: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: typography.body,
      textAlign: 'center',
    },
    topHeadSub: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      textAlign: 'center',
    },
    /** v37: الصف المضغوط — فجوة أضيق (md→sm) وحشوة أقل: إزالة
     *  المسافات الواسعة التي اشتكى منها التاجر. */
    topRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingVertical: 8,
      borderBottomWidth: 1,
      borderBottomColor: c.borderSoft,
    },
    /** v37: ميداليات المرتبة — ذهب/فضة/برونز للثلاثة الأولى. */
    topRank: {
      width: 30,
      height: 30,
      borderRadius: 10,
      backgroundColor: c.accentSoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    topRankGold: {
      backgroundColor: '#F59E0B',
    },
    topRankSilver: {
      backgroundColor: '#94A3B8',
    },
    topRankBronze: {
      backgroundColor: '#B45309',
    },
    topRankText: {
      color: c.onAccent,
      fontFamily: fonts.black,
      fontSize: typography.small,
    },
    topInfo: {flex: 1},
    /** v37: سطر الاسم والقيمة — الاسم يمتد والقيمة بنهاية السطر
     *  بأرقام جدولية ثابتة العرض. */
    topLineRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    topName: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.caption,
      flex: 1,
    },
    /** v37: الشريط النسبي — يقيس قيمة المنتج مقابل الأعلى في
     *  الفترة؛ يتعبّأ من بداية السطر (يمين RTL). */
    topBarTrack: {
      height: 5,
      borderRadius: 3,
      backgroundColor: c.surfaceHi,
      marginTop: 5,
      marginBottom: 4,
      overflow: 'hidden',
    },
    topBarFill: {
      height: '100%',
      borderRadius: 3,
      backgroundColor: c.accent,
    },
    topBarLoss: {
      backgroundColor: c.danger,
    },
    topMeta: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      marginTop: 1,
    },
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
