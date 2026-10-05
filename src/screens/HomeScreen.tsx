/**
 * HomeScreen — لوحة المتجر (design.md §9.1).
 * Today's KPIs, stock alerts strip, quick actions and the latest
 * invoices — everything a shop owner glances at between customers.
 */
import React, {useCallback, useEffect, useState} from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import {
  AppButton,
  AppHeader,
  Badge,
  Card,
  EmptyState,
  SectionTitle,
  StatCard,
} from '../components/ui';
import {Icon, IconChip, type IconName} from '../components/Icon';
import {ReportService, type ReportBundle} from '../services/ReportService';
import {StockAlertsService} from '../services/StockAlertsService';
import {useCatalogStore} from '../stores/catalogStore';
import {useSettingsStore} from '../stores/settingsStore';
import {usePrinterStore} from '../stores/printerStore';
import {useSilaStore} from '../stores/silaStore';
import {SilaRepo} from '../services/sila/SilaRepo';
import {SilaSync} from '../services/sila/SilaSync';
import {LocalDebtsRepo} from '../database/repositories/LocalDebtsRepo';
import {useToastStore} from '../stores/toastStore';
import {
  fonts,
  makeStyles,
  radius,
  spacing,
  typography,
  useThemeColors,
} from '../core/theme';
import {formatMoney, formatQty, relativeTime} from '../core/format';
import {APP_NAME, APP_VERSION_LABEL, BASE_UNIT_NAME} from '../core/config';
import {baseUnitLabelOf} from '../core/types';
import {Image} from 'react-native';
import {SaleRepo} from '../database/repositories/SaleRepo';

const QUICK_ACTIONS: {
  key: string;
  label: string;
  icon: IconName;
  target:
    | 'Pos'
    | 'ProductForm'
    | 'PrinterSettings'
    | 'Reports'
    | 'Stocktake'
    | 'Invoices'
    | 'Sila';
  accent?: boolean;
}[] = [
  {key: 'sell', label: 'بيع جديد', icon: 'cart', target: 'Pos', accent: true},
  {key: 'add', label: 'إضافة منتج', icon: 'plus', target: 'ProductForm'},
  {key: 'stocktake', label: 'الجرد', icon: 'clipboard', target: 'Stocktake'},
  {key: 'invoices', label: 'الفواتير', icon: 'inbox', target: 'Invoices'},
  // v12 (round-18 #5): direct access to the SILA debt log from the
  // dashboard — previously buried behind Settings ← صِلة.
  {key: 'sila', label: 'سجل الديون', icon: 'qrFrame', target: 'Sila'},
  {key: 'reports', label: 'التقارير', icon: 'chart', target: 'Reports'},
];

export function HomeScreen() {
  const c = useThemeColors();
  const styles = useStyles();
  const navigation = useNavigation<any>();
  const settings = useSettingsStore(state => state.settings);
  const printerStatus = usePrinterStore(state => state.status);
  const products = useCatalogStore(state => state.products);
  const silaPairing = useSilaStore(state => state.pairing);
  const silaPending = useSilaStore(state => state.pending);
  const toast = useToastStore(state => state.show);

  const [bundle, setBundle] = useState<ReportBundle | null>(null);
  const [recentSales, setRecentSales] = useState<
    {
      id: number;
      invoice_number: string;
      total_amount: number;
      created_at: string;
    }[]
  >([]);
  // v12 (round-18 #4): the debts & treasury report on the dashboard.
  // v13 (round-19 #1): the outstanding figure now comes from the
  // SERVER-synced صِلة customers cache (Σ outstanding_minor — shrinks
  // when customers repay through the صِلة app), plus the local rows
  // still awaiting upload so nothing is understated while offline.
  const [debtTotals, setDebtTotals] = useState<{
    allMinor: number;
    allCount: number;
    pendingMinor: number;
    pendingCount: number;
  } | null>(null);
  const [serverBalances, setServerBalances] = useState<{
    totalMinor: number;
    posTotalMinor: number;
    appTotalMinor: number;
    debtorsCount: number;
    lastSyncedAt: string | null;
  } | null>(null);
  const [treasuryRevenue, setTreasuryRevenue] = useState<number | null>(null);
  // v15 (round-21 #3): repayments actually collected at the cashier.
  const [paymentsReceived, setPaymentsReceived] = useState<{
    allMinor: number;
    todayMinor: number;
  } | null>(null);
  // v16 (round-22 #4): the STORE-LOCAL debt book totals — the main
  // «الدين الإجمالي» card merges them with the صِلة store-origin
  // part; the Sila-APP part stays informational (للمعلومية).
  const [localBook, setLocalBook] = useState<{
    outstandingMinor: number;
    debtsMinor: number;
    paymentsMinor: number;
    customersCount: number;
    debtorsCount: number;
  } | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [
        todayBundle,
        latest,
        silaTotals,
        balances,
        allRevenue,
        paymentTotals,
        localTotals,
      ] = await Promise.all([
        ReportService.loadBundle('today'),
        SaleRepo.listRecent(3),
        SilaRepo.totals(),
        SilaRepo.customersOutstandingTotal(),
        SaleRepo.allTimeRevenue(),
        SilaRepo.paymentsTotals(),
        LocalDebtsRepo.totals(),
      ]);
      setBundle(todayBundle);
      setRecentSales(latest);
      setDebtTotals(silaTotals);
      setServerBalances(balances);
      setTreasuryRevenue(allRevenue);
      setPaymentsReceived({
        allMinor: paymentTotals.allMinor,
        todayMinor: paymentTotals.todayMinor,
      });
      setLocalBook(localTotals);
    } catch {
      // Dashboard is informational — previous data stays shown.
    }
  }, []);

  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', () => {
      void loadData();
      void StockAlertsService.evaluate();
      // v13 (round-19 #1): refresh the صِلة balances the moment the
      // merchant lands on the dashboard — «الديون القائمة» و«الرصيد
      // بعد السداد» now mirror the debts screen (repayments included)
      // instead of summing local debt rows that never shrink.
      void SilaSync.refreshBalances().then(() => {
        void loadData();
      });
    });
    return unsubscribe;
  }, [navigation, loadData]);

  const alerts = StockAlertsService.activeAlerts(8);

  /** v12 (round-18 #1): one-tap manual sync straight from the
   *  dashboard's pending-debts strip — zero friction, real feedback. */
  const runSyncFromHome = useCallback(() => {
    void SilaSync.syncNow().then(outcome => {
      toast(
        outcome.message,
        outcome.pending + outcome.paymentsPending === 0 ? 'success' : 'info',
      );
      void loadData();
    });
  }, [toast, loadData]);

  // v15 (round-21 #3 — SILA_POS_DEBT_SEPARATION §3.4):
  // «الديون القائمة» = STORE-origin debts ONLY — the pos part the
  // صِلة server attributes to this store's invoices (Σ
  // pos_outstanding_minor) + this device's not-yet-uploaded debt
  // rows (store-origin by definition). App-origin debts used to be
  // mixed in — the «تداخل» that inflated the number.
  const storeOutstandingShekels =
    ((serverBalances?.posTotalMinor ?? 0) + (debtTotals?.pendingMinor ?? 0)) /
    100;
  // Informational: debts born inside the Sila app — NOT this store's
  // sales; never enters the treasury or P&L (§3.4 forbidden list).
  const appDebtsShekels = (serverBalances?.appTotalMinor ?? 0) / 100;
  // Treasury = cash sales (revenue MINUS credit invoices — goods
  // that left on credit brought no cash) PLUS repayments actually
  // collected at the cashier. A repayment is an asset swap
  // (دين → كاش), never revenue (§3.4) — the old formula (revenue −
  // outstanding) double-counted and shrank on every repayment.
  const creditSalesShekels = (debtTotals?.allMinor ?? 0) / 100;
  const collectedShekels = (paymentsReceived?.allMinor ?? 0) / 100;
  // v16 (round-22 #4): local-book figures — outstanding, collected
  // repayments, and the credit-sales total (goods that left with no
  // cash; they ARE in revenue — same asset-swap discipline §3.4).
  const localOutstandingShekels = (localBook?.outstandingMinor ?? 0) / 100;
  const localCollectedShekels = (localBook?.paymentsMinor ?? 0) / 100;
  const localDebtsShekels = (localBook?.debtsMinor ?? 0) / 100;
  const treasuryCash =
    (treasuryRevenue ?? 0) -
    creditSalesShekels -
    localDebtsShekels +
    collectedShekels +
    localCollectedShekels;
  const debtorsCount =
    (serverBalances?.debtorsCount ?? 0) +
    ((debtTotals?.pendingCount ?? 0) > 0 ? 1 : 0) +
    (localBook?.debtorsCount ?? 0);

  return (
    <View style={styles.screen}>
      <AppHeader title={APP_NAME} subtitle="لوحة المتجر" showBack={false} />

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}>
        {/* ── Store welcome card ─────────────────────────────── */}
        <Card style={styles.welcome}>
          <View style={styles.welcomeRow}>
            {settings.storeLogoPath ? (
              <Image
                source={{uri: `file://${settings.storeLogoPath}`}}
                style={styles.storeLogo}
              />
            ) : (
              <IconChip
                name="store"
                chipSize={46}
                size={22}
                bg={c.accentSoft}
                color={c.accent}
              />
            )}
            <View style={{flex: 1}}>
              <Text style={styles.storeName} numberOfLines={1}>
                {settings.storeName}
              </Text>
              <Text style={styles.storeMeta}>
                {products.length} منتج · البيع الافتراضي{' '}
                {settings.defaultPricingMode === 'WHOLESALE' ? 'جملة' : 'مفرق'}
              </Text>
              {/* v12 (round-18 #5): the version badge moved out of the
                store card — the footer at the bottom of the dashboard
                already carries the version label. */}
            </View>
            <Badge
              label={
                printerStatus === 'connected'
                  ? 'الطابعة متصلة'
                  : printerStatus === 'connecting'
                  ? 'جارٍ الاتصال'
                  : 'بدون طابعة'
              }
              tone={printerStatus === 'connected' ? 'success' : 'neutral'}
            />
          </View>
        </Card>

        {/* ── Today KPIs ─────────────────────────────────────── */}
        <SectionTitle title="ملخص اليوم" hint="يتحدّث تلقائياً بعد كل فاتورة" />
        <View style={styles.statsGrid}>
          <View style={styles.statsRow}>
            <StatCard
              label="مبيعات اليوم"
              value={formatMoney(bundle?.summary.revenue ?? 0)}
              tone="accent"
              icon="wallet"
            />
            <StatCard
              label="صافي الربح"
              value={formatMoney(bundle?.summary.netProfit ?? 0)}
              tone={
                (bundle?.summary.netProfit ?? 0) >= 0 ? 'success' : 'danger'
              }
              icon="chart"
            />
          </View>
          <View style={styles.statsRow}>
            <StatCard
              label="عدد الفواتير"
              value={String(bundle?.summary.invoicesCount ?? 0)}
              icon="inbox"
            />
            <StatCard
              label="القطع المبيعة"
              value={String(bundle?.summary.itemsCount ?? 0)}
              icon="box"
            />
          </View>
        </View>

        {/* ── v12 (round-18 #4): debts & treasury report ──── */}
        <SectionTitle
          title="الديون والخزينة"
          hint="ديون دفترك المحلي + ديون صِلة — منفصلة لا تختلط"
          action={
            <View style={{flexDirection: 'row', gap: spacing.md}}>
              <TouchableOpacity
                onPress={() => navigation.navigate('LocalDebts' as never)}>
                <Text style={styles.seeAll}>دفتر المتجر</Text>
              </TouchableOpacity>
              {silaPairing != null ? (
                <TouchableOpacity
                  onPress={() => navigation.navigate('Sila' as never)}>
                  <Text style={styles.seeAll}>سجل صِلة</Text>
                </TouchableOpacity>
              ) : undefined}
            </View>
          }
        />
        {silaPairing == null ? (
          <>
            <TouchableOpacity
              style={styles.silaCtaCard}
              onPress={() => navigation.navigate('Sila' as never)}
              activeOpacity={0.8}>
              <View style={styles.silaCtaIcon}>
                <Icon name="qrFrame" size={20} color={c.accent} />
              </View>
              <View style={{flex: 1}}>
                <Text style={styles.silaCtaTitle}>فعّل البيع بالدين — صِلة</Text>
                <Text style={styles.silaCtaText}>
                  اربط حساب التاجر لتسجيل فواتير الدين ومتابعتها هنا
                </Text>
              </View>
              <Icon name="chevronLeft" size={16} color={c.textFaint} />
            </TouchableOpacity>
            {/* v16 (round-22 #4): the LOCAL debt book works WITHOUT
                صِلة — accounts by ID number, debts & repayments in
                the store's own books. */}
            <TouchableOpacity
              style={[styles.silaCtaCard, {marginTop: spacing.md}]}
              onPress={() => navigation.navigate('LocalDebts' as never)}
              activeOpacity={0.8}>
              <View style={styles.silaCtaIcon}>
                <Icon name="book" size={20} color={c.accent} />
              </View>
              <View style={{flex: 1}}>
                <Text style={styles.silaCtaTitle}>دفتر ديون المتجر</Text>
                <Text style={styles.silaCtaText}>
                  حسابات دين محلية بالهوية والاسم والجوال — بدون تطبيق صِلة
                </Text>
              </View>
              <Icon name="chevronLeft" size={16} color={c.textFaint} />
            </TouchableOpacity>
            {localBook != null && localBook.outstandingMinor !== 0 ? (
              <View style={styles.statsRow}>
                <StatCard
                  label={`ديون الدفتر المحلي · ${localBook.debtorsCount} مدين`}
                  value={formatMoney(localBook.outstandingMinor / 100)}
                  tone="danger"
                  icon="book"
                />
                <StatCard
                  label="النقد بالخزينة"
                  value={formatMoney(treasuryCash)}
                  tone={treasuryCash >= 0 ? 'success' : 'danger'}
                  icon="wallet"
                />
              </View>
            ) : null}
          </>
        ) : (
          <>
            <View style={styles.statsRow}>
              {/* v16 (round-22 #4): the MAIN card is the TOTAL debt —
                  the local debt book + the صِلة store-origin part —
                  exactly as requested: «في الديون يظهر الدين
                  الإجمالي». */}
              <StatCard
                label={`الدين الإجمالي القائم · ${debtorsCount} مدين`}
                value={formatMoney(
                  storeOutstandingShekels + localOutstandingShekels,
                )}
                tone={storeOutstandingShekels + localOutstandingShekels > 0 ? 'danger' : 'success'}
                icon="book"
              />
              <StatCard
                label="النقد بالخزينة"
                value={formatMoney(treasuryCash)}
                tone={treasuryCash >= 0 ? 'success' : 'danger'}
                icon="wallet"
              />
            </View>
            {/* v15 (§3.3/§3.4) + v16 (round-22 #4): the split strip —
                the total splits into the local book, the صِلة
                store-origin part, and the Sila-APP part which is
                informational only and NEVER enters the treasury
                («ديون تطبيق صلة للمعلومية فقط — ديون مستخدم صلة
                المرتبطة بالمتجر»). */}
            <View style={styles.splitStrip}>
              <View style={styles.splitStripCell}>
                <Text style={styles.splitStripLabel}>منها دفتر المتجر</Text>
                <Text style={[styles.splitStripValue, {color: c.warning}]}>
                  {formatMoney(localOutstandingShekels)}
                </Text>
              </View>
              <View style={styles.splitStripDivider} />
              <View style={styles.splitStripCell}>
                <Text style={styles.splitStripLabel}>منها فواتير متجري (صِلة)</Text>
                <Text style={[styles.splitStripValue, {color: c.accent}]}>
                  {formatMoney(storeOutstandingShekels)}
                </Text>
              </View>
              <View style={styles.splitStripDivider} />
              <View style={styles.splitStripCell}>
                <Text style={styles.splitStripLabel}>
                  ديون تطبيق صِلة (للمعلومية)
                </Text>
                <Text style={[styles.splitStripValue, {color: c.info}]}>
                  {formatMoney(appDebtsShekels)}
                </Text>
              </View>
            </View>
            <View style={styles.splitStrip}>
              <View style={styles.splitStripCell}>
                <Text style={styles.splitStripLabel}>
                  سدادّات مستلمة (صِلة)
                </Text>
                <Text style={[styles.splitStripValue, {color: c.success}]}>
                  {formatMoney(collectedShekels)}
                </Text>
              </View>
              <View style={styles.splitStripDivider} />
              <View style={styles.splitStripCell}>
                <Text style={styles.splitStripLabel}>
                  سدادّات مستلمة (دفتر المتجر)
                </Text>
                <Text style={[styles.splitStripValue, {color: c.success}]}>
                  {formatMoney(localCollectedShekels)}
                </Text>
              </View>
            </View>
            {serverBalances?.lastSyncedAt != null ? (
              <Text style={styles.balancesStamp}>
                محدّث من صِلة · {relativeTime(serverBalances.lastSyncedAt)} ·
                ديون متجري منفصلة عن ديون التطبيق
              </Text>
            ) : null}
            {silaPending > 0 || (debtTotals?.pendingCount ?? 0) > 0 ? (
              <TouchableOpacity
                style={styles.silaPendingRow}
                onPress={runSyncFromHome}
                activeOpacity={0.8}>
                <Icon name="refresh" size={15} color={c.warning} />
                <Text style={[styles.silaPendingText, {color: c.warning}]}>
                  {debtTotals?.pendingCount ?? silaPending} دين بانتظار مزامنة
                  صِلة — اضغط للمزامنة الآن
                </Text>
                <Icon name="chevronLeft" size={14} color={c.warning} />
              </TouchableOpacity>
            ) : null}
          </>
        )}

        {/* ── Stock alerts ───────────────────────────────────── */}
        {alerts.length > 0 ? (
          <>
            <SectionTitle
              title="تنبيهات المخزون"
              hint={`${alerts.length} منتج يحتاج إعادة تزويد`}
              action={
                <TouchableOpacity
                  onPress={() => navigation.navigate('Notifications' as never)}>
                  <Text style={styles.seeAll}>عرض الكل</Text>
                </TouchableOpacity>
              }
            />
            <View style={styles.alertsCol}>
              {alerts.slice(0, 3).map(({product, state}) => (
                <TouchableOpacity
                  key={product.id}
                  style={[
                    styles.alertCard,
                    {
                      borderRightWidth: 4,
                      borderColor: state === 'out' ? c.danger : c.warning,
                    },
                  ]}
                  onPress={() =>
                    navigation.navigate('ProductForm', {productId: product.id})
                  }
                  activeOpacity={0.8}>
                  <View style={styles.alertIconWrap}>
                    <Icon
                      name={state === 'out' ? 'packageMinus' : 'alert'}
                      size={18}
                      color={state === 'out' ? c.danger : c.warning}
                    />
                  </View>
                  <View style={styles.alertTexts}>
                    <Text style={styles.alertName} numberOfLines={1}>
                      {product.name}
                    </Text>
                    <Text style={styles.alertQty}>
                      {state === 'out'
                        ? 'نفد المخزون'
                        : `${formatQty(
                            product.stock_quantity,
                          )} ${baseUnitLabelOf(
                            product,
                            BASE_UNIT_NAME,
                          )} متبقية`}
                    </Text>
                  </View>
                  <Icon name="chevronLeft" size={16} color={c.textFaint} />
                </TouchableOpacity>
              ))}
            </View>
          </>
        ) : null}

        {/* ── Quick actions ──────────────────────────────────── */}
        <SectionTitle title="إجراءات سريعة" />
        <View style={styles.quickGrid}>
          {QUICK_ACTIONS.map(action => (
            <TouchableOpacity
              key={action.key}
              style={[
                styles.quickCard,
                action.accent
                  ? {backgroundColor: c.accent, borderColor: c.accent}
                  : null,
              ]}
              onPress={() =>
                navigation.navigate(
                  action.target as never,
                  action.target === 'ProductForm' ? {} : undefined,
                )
              }
              activeOpacity={0.8}>
              <Icon
                name={action.icon}
                size={26}
                color={action.accent ? c.onAccent : c.accent}
              />
              <Text
                style={[
                  styles.quickLabel,
                  action.accent ? {color: c.onAccent} : null,
                ]}>
                {action.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* ── Recent invoices ────────────────────────────────── */}
        <SectionTitle
          title="آخر الفواتير"
          hint="اضغط أي فاتورة لمراجعتها بالتفصيل"
          action={
            <TouchableOpacity
              onPress={() => navigation.navigate('Invoices' as never)}>
              <Text style={styles.allInvoicesLink}>كل الفواتير</Text>
            </TouchableOpacity>
          }
        />
        {recentSales.length === 0 ? (
          <Card>
            <EmptyState
              icon="inbox"
              title="لا توجد فواتير بعد"
              subtitle="أول بيع سيظهر هنا — ابدأ من شاشة نقطة البيع"
              action={
                <AppButton
                  small
                  title="ابدأ البيع"
                  icon="cart"
                  onPress={() => navigation.navigate('Pos' as never)}
                />
              }
            />
          </Card>
        ) : (
          <Card style={{padding: 0, overflow: 'hidden'}}>
            {recentSales.map((sale, index) => (
              <TouchableOpacity
                key={sale.id}
                activeOpacity={0.8}
                onPress={() =>
                  navigation.navigate('InvoiceDetail', {saleId: sale.id})
                }
                style={[
                  styles.saleRow,
                  index < recentSales.length - 1 ? styles.saleRowBorder : null,
                ]}>
                <View style={styles.saleInvoiceIcon}>
                  <Icon name="inbox" size={16} color={c.textDim} />
                </View>
                <View style={{flex: 1}}>
                  <Text style={styles.saleInvoice}>{sale.invoice_number}</Text>
                  <Text style={styles.saleTime}>
                    {relativeTime(sale.created_at)}
                  </Text>
                </View>
                <Text style={styles.saleAmount}>
                  {formatMoney(sale.total_amount)}
                </Text>
              </TouchableOpacity>
            ))}
          </Card>
        )}

        <Text style={styles.version}>
          {APP_NAME} · الإصدار {APP_VERSION_LABEL} · يعمل دون إنترنت
        </Text>
      </ScrollView>
    </View>
  );
}

const useStyles = makeStyles(c =>
  StyleSheet.create({
    screen: {flex: 1, backgroundColor: c.bg},
    storeLogo: {
      width: 46,
      height: 46,
      borderRadius: 13,
      backgroundColor: c.surfaceAlt,
      borderWidth: 1,
      borderColor: c.border,
    },
    content: {
      padding: spacing.lg,
      gap: spacing.md,
      paddingBottom: spacing.xxl,
    },
    welcome: {paddingVertical: spacing.md},
    welcomeRow: {flexDirection: 'row', alignItems: 'center', gap: spacing.md},
    storeName: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: typography.body,
    },
    storeMeta: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      marginTop: 2,
    },
    allInvoicesLink: {
      color: c.accent,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    // v12 (round-18 #4): debts & treasury section styles.
    silaCtaCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.accentSoft,
      borderRadius: radius.lg,
      padding: spacing.md,
    },
    silaCtaIcon: {
      width: 42,
      height: 42,
      borderRadius: 12,
      backgroundColor: c.accentSoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    silaCtaTitle: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    silaCtaText: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      marginTop: 1,
    },
    silaPendingRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.warning,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      paddingVertical: 10,
    },
    silaPendingText: {
      flex: 1,
      fontFamily: fonts.bold,
      fontSize: typography.micro + 2,
      textAlign: 'left',
    },
    // v13 (round-19 #1): "when was this synced from صِلة" caption.
    balancesStamp: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      textAlign: 'center',
      marginTop: -2,
    },
    seeAll: {
      color: c.accent,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    statsGrid: {
      gap: spacing.md,
    },
    statsRow: {
      flexDirection: 'row',
      gap: spacing.md,
    },
    alertsCol: {
      gap: spacing.sm,
    },
    alertCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      paddingVertical: 11,
    },
    alertIconWrap: {
      width: 38,
      height: 38,
      borderRadius: 11,
      backgroundColor: c.surfaceAlt,
      alignItems: 'center',
      justifyContent: 'center',
    },
    alertTexts: {
      flex: 1,
      minWidth: 0,
    },
    alertName: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    alertQty: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      marginTop: 1,
    },
    quickGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.sm,
    },
    quickCard: {
      width: '48.3%',
      minHeight: 92,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: radius.lg,
      alignItems: 'flex-start',
      justifyContent: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
    },
    quickLabel: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.caption,
    },
    saleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: 12,
    },
    saleRowBorder: {borderBottomWidth: 1, borderBottomColor: c.borderSoft},
    saleInvoiceIcon: {
      width: 34,
      height: 34,
      borderRadius: 10,
      backgroundColor: c.surfaceAlt,
      alignItems: 'center',
      justifyContent: 'center',
    },
    saleInvoice: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.small,
      fontVariant: ['tabular-nums'],
    },
    saleTime: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
    },
    saleAmount: {
      color: c.accent,
      fontFamily: fonts.black,
      fontSize: typography.caption,
      fontVariant: ['tabular-nums'],
    },
    version: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      textAlign: 'center',
      marginTop: spacing.md,
    },
    // v15 (round-21 #3): store/app debt split strip on the dashboard.
    splitStrip: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: c.surface,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.borderSoft,
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.md,
      gap: spacing.sm,
    },
    splitStripCell: {
      flex: 1,
      alignItems: 'center',
      gap: 2,
    },
    splitStripDivider: {
      width: 1,
      alignSelf: 'stretch',
      backgroundColor: c.borderSoft,
    },
    splitStripLabel: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.micro,
      textAlign: 'center',
    },
    splitStripValue: {
      fontFamily: fonts.bold,
      fontSize: typography.small,
      fontVariant: ['tabular-nums'],
    },
  }),
);
