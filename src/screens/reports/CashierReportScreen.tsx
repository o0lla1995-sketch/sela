/**
 * CashierReportScreen — v59 (الجولة 63): التقرير التفصيلي للكاشير.
 * ─────────────────────────────────────────────────────────────────
 * شاشة المدير لتقارير كل كاشير على حدة (طلب التاجر حرفياً):
 *  ① فلترة زمنية — اليوم / 7 أيام / 30 يوماً / كل الفترات.
 *  ② بطاقات المؤشرات: الفواتير، النقدي، الدين، المرتجعات، الصافي.
 *  ③ رسم بياني يومي (مبيعات مقابل مرتجعات).
 *  ④ أهم المنتجات + سجل الفواتير الكامل.
 *  ⑤ طباعة حرارية للتقرير كاملاً من طابعة الإيصالات.
 */
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import {useRoute, type RouteProp} from '@react-navigation/native';
import type {RootStackParamList} from '../../navigation/RootNavigator';
import {
  AppButton,
  AppHeader,
  Badge,
  Card,
  EmptyState,
  Screen,
  SectionTitle,
  Segmented,
  StatCard,
} from '../../components/ui';
import {BarChart} from '../../components/charts/BarChart';
import {
  CashiersRepo,
  type CashierDetailedReport,
  type CashierRecord,
} from '../../database/repositories/CashiersRepo';
import {ThermalPrinterService} from '../../services/printer/ThermalPrinterService';
import {buildCashierReportJob} from '../../services/printer/cashierReportReceipt';
import {useSettingsStore} from '../../stores/settingsStore';
import {useToastStore} from '../../stores/toastStore';
import {formatMoney} from '../../core/format';
import {
  fonts,
  makeStyles,
  spacing,
  typography,
  useThemeColors,
} from '../../core/theme';

type Period = 'today' | 'week' | 'month' | 'all';
/** v62 (الجولة 66 #3): فلتر نوع العملية في سجل الفواتير. */
type InvoiceKind = 'all' | 'cash' | 'debt' | 'return';
/** v62: كم فاتورة تُعرض قبل زر «عرض المزيد» — السجل الكامل قد يكون
 *  بمئات الفواتير فيصبح التمرير لا نهائياً. */
const INVOICE_PAGE_SIZE = 20;

function periodRange(period: Period): {from: string | null; to: string | null} {
  if (period === 'all') {
    return {from: null, to: null};
  }
  const now = new Date();
  const to = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;
  if (period === 'today') {
    return {from: to, to};
  }
  const days = period === 'week' ? 6 : 29;
  const start = new Date(now.getTime() - days * 86400000);
  const from = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(
    start.getDate(),
  ).padStart(2, '0')}`;
  return {from, to};
}

export function CashierReportScreen() {
  const route = useRoute<RouteProp<RootStackParamList, 'CashierReport'>>();
  const cashierId = route.params?.cashierId ?? 0;
  const c = useThemeColors();
  const styles = useStyles();
  const toast = useToastStore(state => state.show);
  const settings = useSettingsStore(state => state.settings);

  const [period, setPeriod] = useState<Period>('today');
  const [cashier, setCashier] = useState<CashierRecord | null>(null);
  const [report, setReport] = useState<CashierDetailedReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [printing, setPrinting] = useState(false);
  // v62 (الجولة 66 #3): فلتر النوع + عدد الفواتير المعروضة.
  const [kindFilter, setKindFilter] = useState<InvoiceKind>('all');
  const [visibleCount, setVisibleCount] = useState(INVOICE_PAGE_SIZE);
  const {width: winW} = useWindowDimensions();
  const chartWidth = Math.max(220, winW - spacing.lg * 4 - 2);

  // أي تغيير للفترة يعيد التصفح من البداية.
  useEffect(() => {
    setVisibleCount(INVOICE_PAGE_SIZE);
    setKindFilter('all');
  }, [period]);

  useEffect(() => {
    void (async () => {
      try {
        setCashier(await CashiersRepo.byId(cashierId));
      } catch {
        // الحساب حُذف — تُعرض البيانات برقمه فقط.
      }
    })();
  }, [cashierId]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const {from, to} = periodRange(period);
      setReport(await CashiersRepo.detailedReport(cashierId, from, to));
    } catch {
      toast('تعذر تحميل التقرير', 'error');
    } finally {
      setLoading(false);
    }
  }, [cashierId, period, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const print = useCallback(async () => {
    if (!report || !cashier) {
      return;
    }
    setPrinting(true);
    try {
      const ops = buildCashierReportJob(report, {
        storeName: settings.storeName,
        cashierName: cashier.display_name,
        paperWidth: settings.paperWidth,
        codepage: settings.codepage,
      });
      await ThermalPrinterService.printJob(ops);
      toast('طُبع تقرير الكاشير', 'success');
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'فشلت الطباعة',
        'error',
      );
    } finally {
      setPrinting(false);
    }
  }, [cashier, report, settings, toast]);

  const chartData = useMemo(() => {
    if (!report) {
      return [];
    }
    return [...report.daily]
      .reverse()
      .slice(-14)
      .map(day => ({
        label: day.day.slice(5),
        value: day.salesTotal,
      }));
  }, [report]);

  // v62 (الجولة 66 #3): السجل المصفّى + عدادات الأنواع للفلاتر.
  const kindCounts = useMemo(() => {
    const counts = {all: 0, cash: 0, debt: 0, return: 0};
    if (report) {
      for (const invoice of report.invoices) {
        counts.all++;
        counts[invoice.kind as 'cash' | 'debt' | 'return'] =
          (counts[invoice.kind as 'cash' | 'debt' | 'return'] ?? 0) + 1;
      }
    }
    return counts;
  }, [report]);

  const filteredInvoices = useMemo(() => {
    if (!report) {
      return [];
    }
    if (kindFilter === 'all') {
      return report.invoices;
    }
    return report.invoices.filter(invoice => invoice.kind === kindFilter);
  }, [report, kindFilter]);

  return (
    <Screen>
      <AppHeader
        title={`تقرير: ${cashier?.display_name ?? 'كاشير'}`}
        subtitle="تقارير الكاشير التفصيلية القابلة للطباعة"
        showBack
      />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled">
        <Segmented<Period>
          value={period}
          onChange={setPeriod}
          options={[
            {value: 'today', label: 'اليوم'},
            {value: 'week', label: '7 أيام'},
            {value: 'month', label: '30 يوماً'},
            {value: 'all', label: 'الكل'},
          ]}
        />

        {loading ? (
          <ActivityIndicator color={c.accent} style={styles.loader} />
        ) : !report ? (
          <EmptyState
            icon="chart"
            title="لا بيانات"
            subtitle="لم تُسجَّل عمليات لهذا الكاشير في الفترة المحددة"
          />
        ) : (
          <>
            {/* المؤشرات — v62 (الجولة 66 #3): كان ستّ بطاقات flex:1
                (flexBasis صفر) تتزاحم كلها في صف واحد متلاصق؛ الآن
                شبكة حتمية بطاقتين في الصف (٣ صفوف) والأهم أولاً:
                الصافي ثم عدد الفواتير ثم التفصيل. */}
            <View style={styles.grid}>
              <View style={styles.gridCell}>
                <StatCard
                  label="الصافي"
                  value={formatMoney(report.netTotal)}
                  tone="accent"
                  icon="chart"
                />
              </View>
              <View style={styles.gridCell}>
                <StatCard
                  label="فواتير البيع"
                  value={String(report.salesCount)}
                  tone="accent"
                  icon="receipt"
                />
              </View>
              <View style={styles.gridCell}>
                <StatCard
                  label="مبيعات نقدي"
                  value={formatMoney(report.cashTotal)}
                  tone="success"
                  icon="wallet"
                />
              </View>
              <View style={styles.gridCell}>
                <StatCard
                  label="بيع بالدين"
                  value={formatMoney(report.debtTotal)}
                  tone="info"
                  icon="tag"
                />
              </View>
              <View style={styles.gridCell}>
                <StatCard
                  label="مرتجعات"
                  value={formatMoney(Math.abs(report.returnsTotal))}
                  tone="danger"
                  icon="refresh"
                />
              </View>
              <View style={styles.gridCell}>
                <StatCard
                  label="خصومات"
                  value={formatMoney(report.discountTotal)}
                  icon="percent"
                />
              </View>
            </View>

            {/* الرسم اليومي */}
            <SectionTitle title="المبيعات اليومية" hint="آخر 14 يوماً في الفترة" />
            <Card style={styles.card}>
              <BarChart data={chartData} width={chartWidth} height={170} />
            </Card>

            {/* أهم المنتجات */}
            {report.topProducts.length > 0 ? (
              <>
                <SectionTitle title="أهم المنتجات" hint="الأعلى قيمة في الفترة" />
                <Card style={styles.card}>
                  {report.topProducts.map((product, index) => (
                    <View key={product.productId} style={styles.row}>
                      <Text style={styles.rank}>{index + 1}</Text>
                      <View style={{flex: 1}}>
                        <Text style={styles.name} numberOfLines={1}>
                          {product.name}
                        </Text>
                        <Text style={styles.dim}>
                          الكمية {product.qty.toFixed(2)}
                        </Text>
                      </View>
                      <Text style={styles.value}>
                        {formatMoney(product.total)}
                      </Text>
                    </View>
                  ))}
                </Card>
              </>
            ) : null}

            {/* سجل الفواتير — v62 (الجولة 66 #3): فلتر النوع بعدادات
                + تصفح تدريجي (٢٠ كل مرة) بدلاً من قائمة لا نهائية. */}
            <SectionTitle
              title="سجل الفواتير"
              hint={`${kindCounts.all} عملية في الفترة`}
            />
            {report.invoices.length === 0 ? (
              <EmptyState icon="receipt" title="لا فواتير في الفترة" />
            ) : (
              <>
                <View style={styles.filterRow}>
                  {(
                    [
                      {value: 'all', label: `الكل ${kindCounts.all}`},
                      {value: 'cash', label: `نقدي ${kindCounts.cash}`},
                      {value: 'debt', label: `دين ${kindCounts.debt}`},
                      {value: 'return', label: `مرتجع ${kindCounts.return}`},
                    ] as {value: InvoiceKind; label: string}[]
                  ).map(chip => (
                    <Pressable
                      key={chip.value}
                      style={[
                        styles.filterChip,
                        kindFilter === chip.value ? styles.filterChipOn : null,
                      ]}
                      onPress={() => {
                        setKindFilter(chip.value);
                        setVisibleCount(INVOICE_PAGE_SIZE);
                      }}>
                      <Text
                        style={[
                          styles.filterChipText,
                          kindFilter === chip.value
                            ? {color: c.onAccent}
                            : null,
                        ]}>
                        {chip.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                <Card style={styles.card}>
                  {filteredInvoices
                    .slice(0, visibleCount)
                    .map(invoice => (
                      <View key={invoice.id} style={styles.row}>
                        <View style={{flex: 1}}>
                          <Text style={styles.name} numberOfLines={1}>
                            {invoice.number}
                          </Text>
                          <Text style={styles.dim}>
                            {invoice.createdAt.slice(0, 16)}
                          </Text>
                        </View>
                        <Badge
                          label={
                            invoice.kind === 'return'
                              ? 'مرتجع'
                              : invoice.kind === 'debt'
                              ? 'دين'
                              : 'نقدي'
                          }
                          tone={
                            invoice.kind === 'return'
                              ? 'danger'
                              : invoice.kind === 'debt'
                              ? 'info'
                              : 'success'
                          }
                        />
                        <Text
                          style={[
                            styles.value,
                            invoice.kind === 'return' ? {color: c.danger} : null,
                          ]}>
                          {formatMoney(invoice.total)}
                        </Text>
                      </View>
                    ))}
                </Card>
                {filteredInvoices.length > visibleCount ? (
                  <AppButton
                    title={`عرض المزيد (${
                      filteredInvoices.length - visibleCount
                    } متبقية)`}
                    variant="ghost"
                    small
                    onPress={() =>
                      setVisibleCount(count => count + INVOICE_PAGE_SIZE)
                    }
                  />
                ) : null}
              </>
            )}

            <AppButton
              title="طباعة التقرير"
              icon="printer"
              onPress={() => void print()}
              loading={printing}
              disabled={printing}
            />
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

const useStyles = makeStyles(c =>
  StyleSheet.create({
    scroll: {flex: 1},
    content: {
      padding: spacing.lg,
      gap: spacing.md,
      paddingBottom: spacing.xxl,
    },
    grid: {
      flexDirection: 'row-reverse',
      flexWrap: 'wrap',
      gap: spacing.sm,
    },
    /** v62 (الجولة 66 #3): خلية حتمية — بطاقتان في الصف دائماً
     *  (StatCard نفسها flex:1 / flexBasis صفر فلو تُركت حرة ازدحمت
     *  الستّ كلها في صف واحد متلاصق). */
    gridCell: {
      width: '48.5%',
    },
    /** v62: صف فلاتر نوع الفاتورة. */
    filterRow: {
      flexDirection: 'row-reverse',
      flexWrap: 'wrap',
      gap: spacing.xs + 2,
    },
    filterChip: {
      borderRadius: 999,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
      paddingHorizontal: 12,
      paddingVertical: 6,
    },
    filterChipOn: {
      backgroundColor: c.accent,
      borderColor: c.accent,
    },
    filterChipText: {
      color: c.textDim,
      fontFamily: fonts.medium,
      fontSize: typography.micro + 2,
    },
    card: {padding: spacing.md, gap: spacing.sm},
    loader: {marginTop: spacing.xl},
    row: {
      flexDirection: 'row-reverse',
      alignItems: 'center',
      gap: spacing.sm,
      paddingVertical: 6,
    },
    rank: {
      color: c.accent,
      fontFamily: fonts.black,
      fontSize: typography.body,
      minWidth: 22,
      textAlign: 'center',
    },
    name: {
      color: c.text,
      fontFamily: fonts.medium,
      fontSize: typography.small + 1,
      textAlign: 'right',
    },
    dim: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      textAlign: 'right',
    },
    value: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.small + 1,
    },
  }),
);
