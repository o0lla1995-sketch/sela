/**
 * HomeScreen — لوحة المتجر (design.md §9.1).
 * Today's KPIs, stock alerts strip, quick actions and the latest
 * invoices — everything a shop owner glances at between customers.
 */
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {ScrollView, StyleSheet, Text, TouchableOpacity, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import {AppButton, AppHeader, Badge, Card, EmptyState, SectionTitle, StatCard} from '../components/ui';
import {Icon, IconChip, type IconName} from '../components/Icon';
import {ReportService, type ReportBundle} from '../services/ReportService';
import {StockAlertsService} from '../services/StockAlertsService';
import {useCatalogStore} from '../stores/catalogStore';
import {useSettingsStore} from '../stores/settingsStore';
import {usePrinterStore} from '../stores/printerStore';
import {colors, fonts, radius, spacing, typography} from '../core/theme';
import {formatMoney, relativeTime} from '../core/format';
import {APP_NAME, APP_VERSION} from '../core/config';
import {SaleRepo} from '../database/repositories/SaleRepo';

const QUICK_ACTIONS: {
  key: string;
  label: string;
  icon: IconName;
  target: 'Pos' | 'ProductForm' | 'PrinterSettings' | 'Reports';
  accent?: boolean;
}[] = [
  {key: 'sell', label: 'بيع جديد', icon: 'cart', target: 'Pos', accent: true},
  {key: 'add', label: 'إضافة منتج', icon: 'plus', target: 'ProductForm'},
  {key: 'printer', label: 'الطابعة', icon: 'printer', target: 'PrinterSettings'},
  {key: 'reports', label: 'التقارير', icon: 'chart', target: 'Reports'},
];

export function HomeScreen() {
  const navigation = useNavigation<any>();
  const settings = useSettingsStore(state => state.settings);
  const printerStatus = usePrinterStore(state => state.status);
  const printerName = usePrinterStore(state => state.deviceName);
  const products = useCatalogStore(state => state.products);
  const refreshCatalog = useCatalogStore(state => state.refresh);

  const [bundle, setBundle] = useState<ReportBundle | null>(null);
  const [recentSales, setRecentSales] = useState<
    {id: number; invoice_number: string; total_amount: number; created_at: string}[]
  >([]);

  const loadData = useCallback(async () => {
    try {
      const [todayBundle, latest] = await Promise.all([
        ReportService.loadBundle('today'),
        SaleRepo.listRecent(3),
      ]);
      setBundle(todayBundle);
      setRecentSales(latest);
    } catch {
      // Dashboard is informational — previous data stays shown.
    }
  }, []);

  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', () => {
      void loadData();
      void StockAlertsService.evaluate();
    });
    return unsubscribe;
  }, [navigation, loadData]);

  const alerts = useMemo(() => StockAlertsService.activeAlerts(8), [products]);

  return (
    <View style={styles.screen}>
      <AppHeader title={APP_NAME} subtitle="لوحة المتجر" showBack={false} />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* ── Store welcome card ─────────────────────────────── */}
        <Card style={styles.welcome}>
          <View style={styles.welcomeRow}>
            <IconChip name="store" chipSize={46} size={22} bg={colors.accentSoft} color={colors.accent} />
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

        {/* ── Today KPIs ─────────────────────────────────────── */}
        <SectionTitle title="ملخص اليوم" hint="يتحدّث تلقائياً بعد كل فاتورة" />
        <View style={styles.statsGrid}>
          <StatCard
            label="مبيعات اليوم"
            value={formatMoney(bundle?.summary.revenue ?? 0)}
            tone="accent"
            icon="wallet"
          />
          <StatCard
            label="صافي الربح"
            value={formatMoney(bundle?.summary.netProfit ?? 0)}
            tone={(bundle?.summary.netProfit ?? 0) >= 0 ? 'success' : 'danger'}
            icon="chart"
          />
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

        {/* ── Stock alerts ───────────────────────────────────── */}
        {alerts.length > 0 ? (
          <>
            <SectionTitle
              title="تنبيهات المخزون"
              hint="منتجات تحتاج إعادة تزويد"
              action={
                <TouchableOpacity
                  onPress={() => navigation.navigate('Notifications' as never)}>
                  <Text style={styles.seeAll}>عرض الكل</Text>
                </TouchableOpacity>
              }
            />
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{gap: spacing.sm, paddingBottom: spacing.xs}}>
              {alerts.map(({product, state}) => (
                <TouchableOpacity
                  key={product.id}
                  style={[
                    styles.alertCard,
                    {borderColor: state === 'out' ? colors.danger : colors.warning},
                  ]}
                  onPress={() =>
                    navigation.navigate('ProductForm', {productId: product.id})
                  }>
                  <Icon
                    name={state === 'out' ? 'packageMinus' : 'alert'}
                    size={17}
                    color={state === 'out' ? colors.danger : colors.warning}
                  />
                  <View style={{flex: 1, minWidth: 120}}>
                    <Text style={styles.alertName} numberOfLines={1}>
                      {product.name}
                    </Text>
                    <Text style={styles.alertQty}>
                      {state === 'out' ? 'نفد المخزون' : `${product.stock_quantity} قطعة متبقية`}
                    </Text>
                  </View>
                </TouchableOpacity>
              ))}
            </ScrollView>
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
                action.accent ? {backgroundColor: colors.accent, borderColor: colors.accent} : null,
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
                color={action.accent ? colors.onAccent : colors.accent}
              />
              <Text
                style={[
                  styles.quickLabel,
                  action.accent ? {color: colors.onAccent} : null,
                ]}>
                {action.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* ── Recent invoices ────────────────────────────────── */}
        <SectionTitle title="آخر الفواتير" />
        {recentSales.length === 0 ? (
          <Card>
            <EmptyState
              icon="inbox"
              title="لا توجد فواتير بعد"
              subtitle="أول بيع سيظهر هنا — ابدأ من شاشة نقطة البيع"
              action={
                <AppButton small title="ابدأ البيع" icon="cart" onPress={() => navigation.navigate('Pos' as never)} />
              }
            />
          </Card>
        ) : (
          <Card style={{padding: 0, overflow: 'hidden'}}>
            {recentSales.map((sale, index) => (
              <View
                key={sale.id}
                style={[
                  styles.saleRow,
                  index < recentSales.length - 1 ? styles.saleRowBorder : null,
                ]}>
                <View style={styles.saleInvoiceIcon}>
                  <Icon name="inbox" size={16} color={colors.textDim} />
                </View>
                <View style={{flex: 1}}>
                  <Text style={styles.saleInvoice}>{sale.invoice_number}</Text>
                  <Text style={styles.saleTime}>{relativeTime(sale.created_at)}</Text>
                </View>
                <Text style={styles.saleAmount}>{formatMoney(sale.total_amount)}</Text>
              </View>
            ))}
          </Card>
        )}

        <Text style={styles.version}>سيلا الإصدار {APP_VERSION} · يعمل دون إنترنت</Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: colors.bg},
  content: {
    padding: spacing.lg,
    gap: spacing.md,
    paddingBottom: spacing.xxl,
  },
  welcome: {paddingVertical: spacing.md},
  welcomeRow: {flexDirection: 'row', alignItems: 'center', gap: spacing.md},
  storeName: {
    color: colors.text,
    fontFamily: fonts.black,
    fontSize: typography.body,
  },
  storeMeta: {
    color: colors.textDim,
    fontFamily: fonts.regular,
    fontSize: typography.small,
    marginTop: 2,
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  statCard: {minWidth: '48%'},
  seeAll: {
    color: colors.accent,
    fontFamily: fonts.bold,
    fontSize: typography.small,
  },
  alertCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    maxWidth: 250,
  },
  alertName: {
    color: colors.text,
    fontFamily: fonts.bold,
    fontSize: typography.small,
  },
  alertQty: {
    color: colors.textDim,
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
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radius.lg,
    alignItems: 'flex-start',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  quickLabel: {
    color: colors.text,
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
  saleRowBorder: {borderBottomWidth: 1, borderBottomColor: colors.borderSoft},
  saleInvoiceIcon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saleInvoice: {
    color: colors.text,
    fontFamily: fonts.bold,
    fontSize: typography.small,
    fontVariant: ['tabular-nums'],
  },
  saleTime: {
    color: colors.textFaint,
    fontFamily: fonts.regular,
    fontSize: typography.micro + 1,
  },
  saleAmount: {
    color: colors.accent,
    fontFamily: fonts.black,
    fontSize: typography.caption,
    fontVariant: ['tabular-nums'],
  },
  version: {
    color: colors.textFaint,
    fontFamily: fonts.regular,
    fontSize: typography.micro + 1,
    textAlign: 'center',
    marginTop: spacing.md,
  },
});
