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
  target: 'Pos' | 'ProductForm' | 'PrinterSettings' | 'Reports' | 'Stocktake';
  accent?: boolean;
}[] = [
  {key: 'sell', label: 'بيع جديد', icon: 'cart', target: 'Pos', accent: true},
  {key: 'add', label: 'إضافة منتج', icon: 'plus', target: 'ProductForm'},
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

  const [bundle, setBundle] = useState<ReportBundle | null>(null);
  const [recentSales, setRecentSales] = useState<
    {
      id: number;
      invoice_number: string;
      total_amount: number;
      created_at: string;
    }[]
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

  const alerts = StockAlertsService.activeAlerts(8);

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
              {/* Distinctive version badge — always visible on the dashboard */}
              <View style={styles.versionBadge}>
                <View style={styles.versionDot} />
                <Text style={styles.versionBadgeText}>
                  الإصدار {APP_VERSION_LABEL}
                </Text>
              </View>
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
              tone={(bundle?.summary.netProfit ?? 0) >= 0 ? 'success' : 'danger'}
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
                        : `${formatQty(product.stock_quantity)} ${baseUnitLabelOf(
                            product,
                            BASE_UNIT_NAME,
                          )} متبقية`}
                    </Text>
                  </View>
                  <Icon
                    name="chevronLeft"
                    size={16}
                    color={c.textFaint}
                  />
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
        <SectionTitle title="آخر الفواتير" />
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
              <View
                key={sale.id}
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
              </View>
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
    versionBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      alignSelf: 'flex-start',
      backgroundColor: c.accentSoft,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.sm + 2,
      paddingVertical: 2,
      marginTop: 6,
    },
    versionDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: c.accent,
    },
    versionBadgeText: {
      color: c.accent,
      fontFamily: fonts.bold,
      fontSize: typography.micro + 1,
      fontVariant: ['tabular-nums'],
    },
    statsGrid: {
      gap: spacing.md,
    },
    statsRow: {
      flexDirection: 'row',
      gap: spacing.md,
    },
    seeAll: {
      color: c.accent,
      fontFamily: fonts.bold,
      fontSize: typography.small,
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
  }),
);
