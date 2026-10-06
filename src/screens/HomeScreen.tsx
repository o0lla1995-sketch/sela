/**
 * HomeScreen — لوحة المتجر (design.md §9.1, redesigned v18).
 * ─────────────────────────────────────────────────────────────────
 * v18 (round-24 #2): rebuilt around what the merchant actually asks
 * himself every morning — «ماذا بعت؟ كم ربحت؟ كم في الخزينة؟ كم
 * عليّ من دين؟» — following the global POS dashboard pattern
 * (Square / Loyverse / ShopKeep): a hero «اليوم» block (net sales,
 * profit, receipts, average ticket) then ONE «الخزينة والديون» card
 * with net figures and a short breakdown. Sila-specific numbers
 * appear ONLY while the device is actually paired (round-24 #3 —
 * stats are never held hostage to the linking); the local debt book
 * works standalone, and money صِلة collected on the store's behalf
 * (round-24 #1) is part of the treasury, not a vanishing debt.
 */
import React, {useCallback, useEffect, useState} from 'react';
import {
  Image,
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
import {
  ReportService,
  type ReportBundle,
  type TreasurySnapshot,
} from '../services/ReportService';
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
    | 'Sila'
    | 'LocalDebts';
  accent?: boolean;
}[] = [
  {key: 'sell', label: 'بيع جديد', icon: 'cart', target: 'Pos', accent: true},
  {key: 'add', label: 'إضافة منتج', icon: 'plus', target: 'ProductForm'},
  {key: 'invoices', label: 'الفواتير', icon: 'inbox', target: 'Invoices'},
  {key: 'debts', label: 'الديون', icon: 'book', target: 'LocalDebts'},
  {key: 'stocktake', label: 'الجرد', icon: 'clipboard', target: 'Stocktake'},
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

  const paired = silaPairing != null;

  const [bundle, setBundle] = useState<ReportBundle | null>(null);
  const [recentSales, setRecentSales] = useState<
    {
      id: number;
      invoice_number: string;
      total_amount: number;
      created_at: string;
    }[]
  >([]);
  // v18 (round-24 #2): ONE treasury snapshot replaces the old wall
  // of debt counters — net cash with its sources.
  const [treasury, setTreasury] = useState<TreasurySnapshot | null>(null);
  const [localBook, setLocalBook] = useState<{
    outstandingMinor: number;
    debtorsCount: number;
  } | null>(null);
  // Sila figures — meaningful only while paired.
  const [silaDebt, setSilaDebt] = useState<{
    outstandingMinor: number;
    debtorsCount: number;
    lastSyncedAt: string | null;
  } | null>(null);
  const [pendingDebts, setPendingDebts] = useState<{
    count: number;
    minor: number;
  } | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [todayBundle, latest, treasurySnapshot, localTotals] =
        await Promise.all([
          ReportService.loadBundle('today'),
          SaleRepo.listRecent(3),
          ReportService.treasurySnapshot(),
          LocalDebtsRepo.totals(),
        ]);
      setBundle(todayBundle);
      setRecentSales(latest);
      setTreasury(treasurySnapshot);
      setLocalBook({
        outstandingMinor: localTotals.outstandingMinor,
        debtorsCount: localTotals.debtorsCount,
      });
      // Sila-side figures — refreshed live, read only when paired.
      const [silaTotals, queueTotals] = await Promise.all([
        SilaRepo.customersOutstandingTotal(),
        SilaRepo.totals(),
      ]);
      setSilaDebt({
        outstandingMinor: silaTotals.posTotalMinor + queueTotals.pendingMinor,
        debtorsCount:
          silaTotals.debtorsCount + (queueTotals.pendingCount > 0 ? 1 : 0),
        lastSyncedAt: silaTotals.lastSyncedAt,
      });
      setPendingDebts({
        count: queueTotals.pendingCount,
        minor: queueTotals.pendingMinor,
      });
    } catch {
      // Dashboard is informational — previous data stays shown.
    }
  }, []);

  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', () => {
      void loadData();
      void StockAlertsService.evaluate();
      // v18: the balances refresh also runs the Sila-app collections
      // reconciliation (round-24 #1) — money the app collected on the
      // store's behalf lands in the books the moment we're online.
      void SilaSync.refreshBalances().then(() => {
        void loadData();
      });
    });
    return unsubscribe;
  }, [navigation, loadData]);

  const alerts = StockAlertsService.activeAlerts(8);

  /** One-tap manual sync straight from the pending strip. */
  const runSyncFromHome = useCallback(() => {
    void SilaSync.syncNow().then(outcome => {
      toast(
        outcome.message,
        outcome.pending + outcome.paymentsPending === 0 ? 'success' : 'info',
      );
      void loadData();
    });
  }, [toast, loadData]);

  // ── The four net numbers (round-24 #2) ──────────────────────────
  const cashTotal = treasury?.cashTotal ?? 0;
  const localOutstandingShekels = (localBook?.outstandingMinor ?? 0) / 100;
  const silaOutstandingShekels = paired
    ? (silaDebt?.outstandingMinor ?? 0) / 100
    : 0;
  const debtTotal = localOutstandingShekels + silaOutstandingShekels;
  const debtorsTotal =
    (localBook?.debtorsCount ?? 0) + (paired ? silaDebt?.debtorsCount ?? 0 : 0);
  // Treasury breakdown (all-time sources of the cash number).
  // v20: voucher goods left with no counter cash (only the extra
  // part entered) — subtract the INV-V totals, add the extras back;
  // the claim part arrives as confirmed campaign settlements.
  const salesCash =
    (treasury?.revenueAllTime ?? 0) -
    (treasury?.creditSalesAllTime ?? 0) -
    (treasury?.voucherSalesAllTime ?? 0) +
    (treasury?.voucherCounterExtraAllTime ?? 0);
  const collectionsTotal =
    (treasury?.localCollectionsAllTime ?? 0) +
    (treasury?.cashierCollectionsAllTime ?? 0) +
    (treasury?.appCollectionsAllTime ?? 0) +
    (treasury?.prepaidCoveredAllTime ?? 0) +
    (treasury?.campaignSettlementsAllTime ?? 0);
  const campaignSettlementsShekels = treasury?.campaignSettlementsAllTime ?? 0;
  const viaSilaShekels =
    (treasury?.cashierCollectionsAllTime ?? 0) +
    (treasury?.appCollectionsAllTime ?? 0) +
    (treasury?.prepaidCoveredAllTime ?? 0);
  const invoicesCount = bundle?.summary.invoicesCount ?? 0;
  const avgTicket =
    invoicesCount > 0 ? (bundle?.summary.revenue ?? 0) / invoicesCount : 0;

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

        {/* ── ملخص اليوم — the hero block (net figures first) ── */}
        <SectionTitle title="اليوم" hint="يتحدّث تلقائياً بعد كل فاتورة" />
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
              value={String(invoicesCount)}
              icon="inbox"
            />
            <StatCard
              label="متوسط الفاتورة"
              value={formatMoney(avgTicket)}
              icon="tag"
            />
          </View>
        </View>

        {/* ── الخزينة والديون — ONE clean card, never gated ──── */}
        <SectionTitle
          title="الخزينة والديون"
          hint="النقد الفعلي لديك + الديون المستحقة لك"
          action={
            /* v19 (round-25 #5): while the store is actually paired,
             * «دفتر صِلة» sits NEXT to «دفتر الديون» — one tap from
             * the dashboard to the صِلة debts/receipts center. */
            <View style={styles.ledgerLinksRow}>
              <TouchableOpacity
                onPress={() => navigation.navigate('LocalDebts' as never)}>
                <Text style={styles.seeAll}>دفتر الديون</Text>
              </TouchableOpacity>
              {paired ? (
                <>
                  <View style={styles.ledgerLinksDivider} />
                  <TouchableOpacity
                    onPress={() => navigation.navigate('Sila' as never)}>
                    <Text style={styles.seeAll}>دفتر صِلة</Text>
                  </TouchableOpacity>
                </>
              ) : null}
            </View>
          }
        />
        <Card style={styles.moneyCard}>
          <View style={styles.moneyRow}>
            <View style={styles.moneyCell}>
              <Text style={styles.moneyLabel}>النقد بالخزينة</Text>
              <Text
                style={[
                  styles.moneyValue,
                  {color: cashTotal >= 0 ? c.success : c.danger},
                ]}>
                {formatMoney(cashTotal)}
              </Text>
              <Text style={styles.moneyMeta}>مبيعات نقدية + تحصيلات ديون</Text>
            </View>
            <View style={styles.moneyDivider} />
            <View style={styles.moneyCell}>
              <Text style={styles.moneyLabel}>الدين القائم لك</Text>
              <Text
                style={[
                  styles.moneyValue,
                  {color: debtTotal > 0 ? c.danger : c.success},
                ]}>
                {formatMoney(debtTotal)}
              </Text>
              <Text style={styles.moneyMeta}>
                {debtTotal > 0
                  ? `${debtorsTotal} زبون مدين لك`
                  : 'لا ديون قائمة'}
              </Text>
            </View>
          </View>

          {/* The short breakdown — sources of the two numbers above. */}
          <View style={styles.breakdownBox}>
            <View style={styles.breakdownRow}>
              <Text style={styles.breakdownLabel}>
                مبيعات نقدية (كامل السجل)
              </Text>
              <Text style={[styles.breakdownValue, {color: c.text}]}>
                {formatMoney(salesCash)}
              </Text>
            </View>
            <View style={styles.breakdownRow}>
              <Text style={styles.breakdownLabel}>تحصيلات ديون مستلمة</Text>
              <Text style={[styles.breakdownValue, {color: c.success}]}>
                {formatMoney(collectionsTotal)}
              </Text>
            </View>
            {paired ? (
              <View style={styles.breakdownRow}>
                <Text style={styles.breakdownLabel}>
                  منها عبر تطبيق صِلة (تحصيل + رصيد مسبق)
                </Text>
                <Text style={[styles.breakdownValue, {color: c.info}]}>
                  {formatMoney(viaSilaShekels)}
                </Text>
              </View>
            ) : null}
            {/* v20: money received from the campaign institutions
                (confirmed settlements — Σ the server's snapshot). */}
            {campaignSettlementsShekels > 0 ? (
              <View style={styles.breakdownRow}>
                <Text style={styles.breakdownLabel}>
                  منها: تسويات الحملات (قسائم شرائية)
                </Text>
                <Text style={[styles.breakdownValue, {color: c.info}]}>
                  {formatMoney(campaignSettlementsShekels)}
                </Text>
              </View>
            ) : null}
            <View style={styles.breakdownDivider} />
            <View style={styles.breakdownRow}>
              <Text style={styles.breakdownLabel}>من الدين: دفتر المتجر</Text>
              <Text style={[styles.breakdownValue, {color: c.warning}]}>
                {formatMoney(localOutstandingShekels)}
              </Text>
            </View>
            {paired ? (
              <View style={styles.breakdownRow}>
                <Text style={styles.breakdownLabel}>
                  من الدين: فواتير عبر صِلة
                </Text>
                <Text style={[styles.breakdownValue, {color: c.warning}]}>
                  {formatMoney(silaOutstandingShekels)}
                </Text>
              </View>
            ) : null}
          </View>

          {paired ? (
            <>
              {(pendingDebts?.count ?? 0) > 0 || silaPending > 0 ? (
                <TouchableOpacity
                  style={styles.silaPendingRow}
                  onPress={runSyncFromHome}
                  activeOpacity={0.8}>
                  <Icon name="refresh" size={15} color={c.warning} />
                  <Text style={[styles.silaPendingText, {color: c.warning}]}>
                    {pendingDebts?.count ?? silaPending} عملية بانتظار مزامنة
                    صِلة — اضغط للمزامنة الآن
                  </Text>
                  <Icon name="chevronLeft" size={14} color={c.warning} />
                </TouchableOpacity>
              ) : null}
              {silaDebt?.lastSyncedAt != null ? (
                <Text style={styles.balancesStamp}>
                  أرصدة صِلة محدّثة · {relativeTime(silaDebt.lastSyncedAt)}
                </Text>
              ) : null}
            </>
          ) : (
            <TouchableOpacity
              style={styles.silaLinkRow}
              onPress={() => navigation.navigate('Sila' as never)}
              activeOpacity={0.8}>
              <Icon name="qrFrame" size={14} color={c.textDim} />
              <Text style={styles.silaLinkText}>
                مربوط بالتطبيق؟ اربط صِلة لمزامنة الديون والتحصيلات سحابياً
              </Text>
              <Icon name="chevronLeft" size={13} color={c.textFaint} />
            </TouchableOpacity>
          )}
        </Card>

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
    seeAll: {
      color: c.accent,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    // v19 (round-25 #5): the paired dashboard links row.
    ledgerLinksRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    ledgerLinksDivider: {
      width: 1,
      height: 12,
      backgroundColor: c.borderSoft,
    },
    statsGrid: {
      gap: spacing.md,
    },
    statsRow: {
      flexDirection: 'row',
      gap: spacing.md,
    },
    // ── v18 (round-24 #2): the الخزينة والديون card ─────────────
    moneyCard: {gap: spacing.md},
    moneyRow: {flexDirection: 'row', alignItems: 'stretch'},
    moneyCell: {flex: 1, alignItems: 'center', gap: 3},
    moneyDivider: {
      width: 1,
      backgroundColor: c.borderSoft,
      marginVertical: 2,
    },
    moneyLabel: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    moneyValue: {
      fontFamily: fonts.black,
      fontSize: typography.title + 2,
      fontVariant: ['tabular-nums'],
    },
    moneyMeta: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      textAlign: 'center',
    },
    breakdownBox: {
      backgroundColor: c.surfaceHi,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.borderSoft,
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.md,
      gap: 6,
    },
    breakdownRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    breakdownLabel: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 2,
      flex: 1,
      textAlign: 'left',
    },
    breakdownValue: {
      fontFamily: fonts.bold,
      fontSize: typography.small,
      fontVariant: ['tabular-nums'],
    },
    breakdownDivider: {
      height: 1,
      backgroundColor: c.borderSoft,
      marginVertical: 2,
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
    // v18 (round-24 #3): a SUBTLE one-line hint — never a wall that
    // pushes the merchant's own numbers away.
    silaLinkRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      justifyContent: 'center',
      paddingVertical: 6,
    },
    silaLinkText: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      flex: 0,
    },
    balancesStamp: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      textAlign: 'center',
      marginTop: -2,
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
      width: '31.6%',
      minHeight: 88,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: radius.lg,
      alignItems: 'flex-start',
      justifyContent: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
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
  }),
);
