/**
 * InvoicesScreen — الفواتير (v9.1, round-14 #5).
 * ─────────────────────────────────────────────────────────────────
 * The missing sales-history center, exactly like the professional
 * POS apps (Loyverse Sales history / Square Transactions):
 *
 *   • a paged, newest-first list of every invoice — number, time,
 *     payment type badge, line count and total,
 *   • search by invoice number (INV-20251004-0001 …),
 *   • tap any invoice → the full detail view: header info, every
 *     line (name × qty × unit price = total), subtotal, discount,
 *     grand total — and إعادة الطباعة reprint on the thermal
 *     printer with the store's receipt settings.
 */
import React, {useCallback, useEffect, useState} from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {useFocusEffect, useNavigation, useRoute} from '@react-navigation/native';
import {
  AppButton,
  AppHeader,
  Badge,
  Card,
  EmptyState,
  MoneyText,
  SearchBar,
} from '../../components/ui';
import {Icon} from '../../components/Icon';
import {SaleRepo} from '../../database/repositories/SaleRepo';
import {ProductRepo} from '../../database/repositories/ProductRepo';
import {InvoiceService} from '../../services/InvoiceService';
import {useSettingsStore} from '../../stores/settingsStore';
import {usePrinterStore} from '../../stores/printerStore';
import {useToastStore} from '../../stores/toastStore';
import {
  fonts,
  makeStyles,
  radius,
  spacing,
  typography,
  useThemeColors,
} from '../../core/theme';
import {formatDateTime, formatMoney, formatQty} from '../../core/format';
import type {SaleItemRecord, SaleRecord} from '../../core/types';

const PAGE_SIZE = 30;

type InvoiceRow = SaleRecord & {itemsCount: number};

export function InvoicesScreen() {
  const c = useThemeColors();
  const styles = useStyles();
  const navigation = useNavigation<any>();

  const [rows, setRows] = useState<InvoiceRow[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reachedEnd, setReachedEnd] = useState(false);
  // Tracks the current list length for paging without stale closures.
  const [loadedCount, setLoadedCount] = useState(0);

  const load = useCallback(
    async (query: string, replace: boolean) => {
      if (replace) {
        setLoading(true);
      } else {
        setLoadingMore(true);
      }
      try {
        const offset = replace ? 0 : loadedCount;
        const page = await SaleRepo.listPagePaged({
          limit: PAGE_SIZE,
          offset,
          search: query,
        });
        setRows(prev => (replace ? page : [...prev, ...page]));
        setLoadedCount(replace ? page.length : loadedCount + page.length);
        setReachedEnd(page.length < PAGE_SIZE);
      } catch {
        // Keep whatever is on screen — history is read-mostly.
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [loadedCount],
  );

  useFocusEffect(
    useCallback(() => {
      void load('', true);
      // Reload fresh whenever the screen gains focus (a new sale may
      // have just completed).
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  const onSearch = useCallback(
    (query: string) => {
      setSearch(query);
      void load(query, true);
    },
    [load],
  );

  return (
    <View style={styles.screen}>
      <AppHeader
        title="الفواتير"
        subtitle={`${rows.length} فاتورة معروضة`}
        showBack
      />
      <View style={styles.content}>
        <SearchBar
          value={search}
          onChangeText={onSearch}
          placeholder="ابحث برقم الفاتورة (INV-…)"
        />
        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={c.accent} />
          </View>
        ) : rows.length === 0 ? (
          <EmptyState
            icon="inbox"
            title={search ? 'لا نتائج' : 'لا فواتير بعد'}
            subtitle={
              search
                ? `لا فاتورة تطابق «${search}»`
                : 'أول بيع من نقطة البيع سيظهر هنا فوراً'
            }
          />
        ) : (
          <ScrollView
            style={{flex: 1}}
            contentContainerStyle={styles.list}
            showsVerticalScrollIndicator={false}
            scrollEventThrottle={120}
            onScroll={({nativeEvent}) => {
              const {layoutMeasurement, contentOffset, contentSize} =
                nativeEvent;
              const nearEnd =
                layoutMeasurement.height + contentOffset.y >=
                contentSize.height - 260;
              if (nearEnd && !loadingMore && !reachedEnd && !loading) {
                void load(search, false);
              }
            }}>
            {rows.map(row => (
              <TouchableOpacity
                key={row.id}
                style={styles.row}
                activeOpacity={0.8}
                onPress={() =>
                  navigation.navigate('InvoiceDetail', {saleId: row.id})
                }>
                <View style={styles.rowIcon}>
                  <Icon name="inbox" size={17} color={c.accent} />
                </View>
                <View style={{flex: 1}}>
                  <Text style={styles.rowInvoice}>{row.invoice_number}</Text>
                  <Text style={styles.rowMeta}>
                    {formatDateTime(row.created_at)} · {row.itemsCount} صنف
                  </Text>
                </View>
                <Badge
                  label={row.payment_type === 'WHOLESALE' ? 'جملة' : 'مفرق'}
                  tone={row.payment_type === 'WHOLESALE' ? 'info' : 'neutral'}
                />
                <Text style={styles.rowAmount}>
                  {formatMoney(row.total_amount)}
                </Text>
              </TouchableOpacity>
            ))}
            {loadingMore ? (
              <ActivityIndicator
                size="small"
                color={c.accent}
                style={{marginVertical: spacing.md}}
              />
            ) : reachedEnd && rows.length > PAGE_SIZE ? (
              <Text style={styles.endHint}>لا مزيد من الفواتير</Text>
            ) : null}
          </ScrollView>
        )}
      </View>
    </View>
  );
}

// ────────────────────────────────────────────────────────────────
// Invoice detail — مراجعة الفاتورة بالتفصيل + إعادة الطباعة
// ────────────────────────────────────────────────────────────────

export function InvoiceDetailScreen() {
  const c = useThemeColors();
  const styles = useStyles();
  const route = useRoute<any>();
  const saleId: number | undefined = route.params?.saleId;
  const toast = useToastStore(state => state.show);
  const settings = useSettingsStore(state => state.settings);
  const printerStatus = usePrinterStore(state => state.status);

  const [sale, setSale] = useState<SaleRecord | null>(null);
  const [items, setItems] = useState<SaleItemRecord[]>([]);
  const [names, setNames] = useState<Map<number, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [reprinting, setReprinting] = useState(false);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      if (saleId == null) {
        return;
      }
      try {
        const record = await SaleRepo.getById(saleId);
        const lines = await SaleRepo.getItemsForSale(saleId);
        const nameMap = new Map<number, string>();
        for (const item of lines) {
          if (!nameMap.has(item.product_id)) {
            const product = await ProductRepo.getById(item.product_id);
            nameMap.set(
              item.product_id,
              product?.name ?? `#${item.product_id}`,
            );
          }
        }
        if (mounted) {
          setSale(record);
          setItems(lines);
          setNames(nameMap);
        }
      } catch (error) {
        toast(
          error instanceof Error ? error.message : 'فشل تحميل الفاتورة',
          'error',
        );
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    };
    void load();
    return () => {
      mounted = false;
    };
  }, [saleId, toast]);

  const reprint = useCallback(async () => {
    if (sale == null || saleId == null) {
      return;
    }
    if (printerStatus !== 'connected') {
      toast('لا توجد طابعة متصلة — أوصل الطابعة أولاً', 'error');
      return;
    }
    setReprinting(true);
    try {
      await InvoiceService.reprintInvoice(saleId, {
        storeName: settings.storeName,
        storePhone: settings.storePhone,
        footerMessage: settings.footerMessage,
        storeLogoPath: settings.storeLogoPath,
        paperWidth: settings.paperWidth,
        codepage: settings.codepage,
        showProfit: settings.showProfitOnReceipt,
      });
      toast('أُعيدت طباعة الفاتورة', 'success');
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'فشلت إعادة الطباعة',
        'error',
      );
    } finally {
      setReprinting(false);
    }
  }, [sale, saleId, printerStatus, settings, toast]);

  if (loading) {
    return (
      <View style={styles.screen}>
        <AppHeader title="تفاصيل الفاتورة" showBack />
        <View style={styles.center}>
          <ActivityIndicator size="large" color={c.accent} />
        </View>
      </View>
    );
  }

  if (sale == null) {
    return (
      <View style={styles.screen}>
        <AppHeader title="تفاصيل الفاتورة" showBack />
        <EmptyState
          icon="inbox"
          title="الفاتورة غير موجودة"
          subtitle="ربما حُذفت من قاعدة البيانات"
        />
      </View>
    );
  }

  const subtotal = sale.total_amount + sale.discount;

  return (
    <View style={styles.screen}>
      <AppHeader
        title={sale.invoice_number}
        subtitle={formatDateTime(sale.created_at)}
        showBack
        right={
          <AppButton
            small
            title="إعادة الطباعة"
            icon="printer"
            onPress={() => void reprint()}
            loading={reprinting}
          />
        }
      />
      <ScrollView
        style={{flex: 1}}
        contentContainerStyle={styles.detailContent}
        showsVerticalScrollIndicator={false}>
        {/* ── Header card ── */}
        <Card style={styles.detailHeadCard}>
          <View style={styles.detailHeadRow}>
            <View style={styles.detailHeadIcon}>
              <Icon name="inbox" size={22} color={c.accent} />
            </View>
            <View style={{flex: 1}}>
              <Text style={styles.detailInvoice}>{sale.invoice_number}</Text>
              <Text style={styles.detailMeta}>
                {formatDateTime(sale.created_at)}
              </Text>
            </View>
            <Badge
              label={sale.payment_type === 'WHOLESALE' ? 'جملة' : 'مفرق'}
              tone={sale.payment_type === 'WHOLESALE' ? 'info' : 'neutral'}
            />
          </View>
        </Card>

        {/* ── Items ── */}
        <Text style={styles.sectionLabel}>أصناف الفاتورة ({items.length})</Text>
        <Card style={{padding: 0, overflow: 'hidden'}}>
          {items.map((item, index) => (
            <View
              key={item.id}
              style={[
                styles.itemRow,
                index < items.length - 1 ? styles.itemRowBorder : null,
              ]}>
              <View style={{flex: 1}}>
                <Text style={styles.itemName} numberOfLines={2}>
                  {names.get(item.product_id) ?? `#${item.product_id}`}
                  {item.unit_name && item.unit_name !== 'قطعة'
                    ? ` (${item.unit_name})`
                    : ''}
                </Text>
                <Text style={styles.itemMeta}>
                  {formatQty(item.quantity)} × {formatMoney(item.unit_price)}{' '}
                  ={' '}
                  <Text style={styles.itemTotalText}>
                    {formatMoney(item.total_line_price)}
                  </Text>
                </Text>
              </View>
            </View>
          ))}
        </Card>

        {/* ── Totals ── */}
        <Card style={styles.totalsCard}>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>المجموع قبل الخصم</Text>
            <Text style={styles.totalValue}>{formatMoney(subtotal)}</Text>
          </View>
          {sale.discount > 0 ? (
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>الخصم</Text>
              <Text style={[styles.totalValue, {color: c.danger}]}>
                − {formatMoney(sale.discount)}
              </Text>
            </View>
          ) : null}
          <View style={[styles.totalRow, styles.totalRowFinal]}>
            <Text style={styles.totalFinalLabel}>الإجمالي المدفوع</Text>
            <MoneyText value={sale.total_amount} big />
          </View>
        </Card>
      </ScrollView>
    </View>
  );
}

const useStyles = makeStyles(c =>
  StyleSheet.create({
    screen: {flex: 1, backgroundColor: c.bg},
    content: {flex: 1, padding: spacing.lg, gap: spacing.md},
    list: {gap: spacing.sm, paddingBottom: spacing.xl},
    center: {flex: 1, alignItems: 'center', justifyContent: 'center'},

    // List rows
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: radius.md,
      padding: spacing.md,
    },
    rowIcon: {
      width: 40,
      height: 40,
      borderRadius: 12,
      backgroundColor: c.accentSofter,
      alignItems: 'center',
      justifyContent: 'center',
    },
    rowInvoice: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.caption,
      fontVariant: ['tabular-nums'],
    },
    rowMeta: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      marginTop: 1,
    },
    rowAmount: {
      color: c.accent,
      fontFamily: fonts.black,
      fontSize: typography.caption,
      fontVariant: ['tabular-nums'],
    },
    endHint: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      textAlign: 'center',
      paddingVertical: spacing.md,
    },

    // Detail
    detailContent: {
      padding: spacing.lg,
      gap: spacing.md,
      paddingBottom: spacing.xxl,
    },
    detailHeadCard: {padding: spacing.md},
    detailHeadRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
    },
    detailHeadIcon: {
      width: 48,
      height: 48,
      borderRadius: 14,
      backgroundColor: c.accentSofter,
      alignItems: 'center',
      justifyContent: 'center',
    },
    detailInvoice: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: typography.body,
      fontVariant: ['tabular-nums'],
    },
    detailMeta: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      marginTop: 2,
    },
    sectionLabel: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.small,
      marginTop: spacing.xs,
    },
    itemRow: {
      flexDirection: 'row',
      alignItems: 'center',
      padding: spacing.md,
    },
    itemRowBorder: {borderBottomWidth: 1, borderBottomColor: c.borderSoft},
    itemName: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.caption,
      lineHeight: 19,
    },
    itemMeta: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      marginTop: 3,
      fontVariant: ['tabular-nums'],
    },
    itemTotalText: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    totalsCard: {gap: spacing.sm, padding: spacing.md},
    totalRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    totalLabel: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    totalValue: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.caption,
      fontVariant: ['tabular-nums'],
    },
    totalRowFinal: {
      borderTopWidth: 1,
      borderTopColor: c.borderSoft,
      paddingTop: spacing.sm,
      marginTop: spacing.xs,
    },
    totalFinalLabel: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: typography.small,
    },
  }),
);
