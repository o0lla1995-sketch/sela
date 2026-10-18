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
  const {width: winW} = useWindowDimensions();
  const chartWidth = Math.max(220, winW - spacing.lg * 4 - 2);

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
            {/* المؤشرات */}
            <View style={styles.grid}>
              <StatCard
                label="فواتير البيع"
                value={String(report.salesCount)}
                tone="accent"
                icon="receipt"
              />
              <StatCard
                label="مبيعات نقدي"
                value={formatMoney(report.cashTotal)}
                tone="success"
                icon="wallet"
              />
              <StatCard
                label="بيع بالدين"
                value={formatMoney(report.debtTotal)}
                tone="info"
                icon="tag"
              />
              <StatCard
                label="مرتجعات"
                value={formatMoney(Math.abs(report.returnsTotal))}
                tone="danger"
                icon="refresh"
              />
              <StatCard
                label="الصافي"
                value={formatMoney(report.netTotal)}
                tone="accent"
                icon="chart"
              />
              <StatCard
                label="خصومات"
                value={formatMoney(report.discountTotal)}
                icon="percent"
              />
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

            {/* سجل الفواتير */}
            <SectionTitle
              title="سجل الفواتير"
              hint={`${report.invoices.length} عملية في الفترة`}
            />
            {report.invoices.length === 0 ? (
              <EmptyState icon="receipt" title="لا فواتير في الفترة" />
            ) : (
              <Card style={styles.card}>
                {report.invoices.map(invoice => (
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
