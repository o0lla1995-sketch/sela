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
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  ActivityIndicator,
  BackHandler,
  Clipboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  useFocusEffect,
  useNavigation,
  useRoute,
} from '@react-navigation/native';
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
import {SilaRepo} from '../../services/sila/SilaRepo';
import {VouchersRepo} from '../../services/sila/VouchersRepo';
import type {VoucherRedemptionRow} from '../../core/types';
import {LocalDebtsRepo} from '../../database/repositories/LocalDebtsRepo';
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
import type {
  ReturnLineInput,
  SaleItemRecord,
  SaleRecord,
  SaleReturnRecord,
  SilaDebtRow,
} from '../../core/types';

const PAGE_SIZE = 30;

type InvoiceRow = SaleRecord & {itemsCount: number};

/** v23 (round-29 #3): the invoice KIND filter chips. */
type KindFilter = 'all' | 'cash' | 'sila' | 'local' | 'voucher' | 'returns';
const KIND_CHIPS: {key: KindFilter; label: string}[] = [
  {key: 'all', label: 'الكل'},
  {key: 'cash', label: 'نقدية'},
  {key: 'sila', label: 'دين صِلة'},
  {key: 'local', label: 'دين المتجر'},
  {key: 'voucher', label: 'قسائم'},
  {key: 'returns', label: 'مرتجعات'},
];

/** v23 (round-29 #3): quick date-range chips. */
type DateFilter = 'all' | 'today' | 'week' | 'month';
const DATE_CHIPS: {key: DateFilter; label: string}[] = [
  {key: 'all', label: 'كل الفترات'},
  {key: 'today', label: 'اليوم'},
  {key: 'week', label: 'آخر 7 أيام'},
  {key: 'month', label: 'آخر 30 يوماً'},
];

/** The inclusive lower date bound of a date filter ('' = open). */
function fromDateOf(filter: DateFilter): string {
  if (filter === 'all') {
    return '';
  }
  const days = filter === 'today' ? 0 : filter === 'week' ? 6 : 29;
  const d = new Date();
  d.setDate(d.getDate() - days);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

export function InvoicesScreen() {
  const c = useThemeColors();
  const styles = useStyles();
  const navigation = useNavigation<any>();

  const [rows, setRows] = useState<InvoiceRow[]>([]);
  const [search, setSearch] = useState('');
  // v23 (round-29 #3): 300ms debounce — the multi-dimension search
  // runs EXISTS subqueries per row; typing must stay smooth.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [dateFilter, setDateFilter] = useState<DateFilter>('all');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reachedEnd, setReachedEnd] = useState(false);
  // Tracks the current list length for paging without stale closures.
  const [loadedCount, setLoadedCount] = useState(0);
  // v11 (SILA): invoice numbers carrying a SILA debt — one query,
  // refreshed on focus so fresh debt sales badge immediately.
  const [debtRefs, setDebtRefs] = useState<Set<string>>(new Set());
  // v20: debt invoices (partly) covered by prepaid credit → «رصيد».
  const [prepaidRefs, setPrepaidRefs] = useState<Set<string>>(new Set());

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
    }, 300);
    return () => {
      clearTimeout(timer);
    };
  }, [search]);

  const load = useCallback(
    async (
      query: string,
      kind: KindFilter,
      date: DateFilter,
      replace: boolean,
      currentCount: number,
    ) => {
      if (replace) {
        setLoading(true);
      } else {
        setLoadingMore(true);
      }
      try {
        const offset = replace ? 0 : currentCount;
        const page = await SaleRepo.listPagePaged({
          limit: PAGE_SIZE,
          offset,
          search: query,
          kind,
          fromDate: fromDateOf(date),
          toDate: '',
        });
        setRows(prev => (replace ? page : [...prev, ...page]));
        setLoadedCount(replace ? page.length : currentCount + page.length);
        setReachedEnd(page.length < PAGE_SIZE);
      } catch {
        // Keep whatever is on screen — history is read-mostly.
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [],
  );

  // Latest filter state in refs so the focus callback stays
  // identity-stable (empty deps) while never going stale.
  const stateRef = useRef({debouncedSearch, kindFilter, dateFilter});
  stateRef.current = {debouncedSearch, kindFilter, dateFilter};
  const loadRef = useRef(load);
  loadRef.current = load;

  useFocusEffect(
    useCallback(() => {
      // Reload fresh whenever the screen gains focus (a new sale or
      // RETURN may have just completed) — WITH the active filters.
      const {
        debouncedSearch: q,
        kindFilter: k,
        dateFilter: d,
      } = stateRef.current;
      void loadRef.current(q, k, d, true, 0);
      // v11 (SILA): refresh the debt-invoice badge set with it.
      void SilaRepo.allDebtInvoiceRefs().then(setDebtRefs);
      // v20: the prepaid-covered set for the «رصيد» badge.
      void SilaRepo.prepaidCoveredInvoiceRefs().then(setPrepaidRefs);
    }, []),
  );

  // Reload whenever the debounced query or a filter changes.
  useEffect(() => {
    void load(debouncedSearch, kindFilter, dateFilter, true, 0);
  }, [debouncedSearch, kindFilter, dateFilter, load]);

  const onSearch = useCallback((query: string) => {
    setSearch(query);
  }, []);

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
          placeholder="ابحث برقم الفاتورة أو الزبون أو الصنف أو المبلغ…"
        />

        {/* v23 (round-29 #3): the FILTER row — kind + quick date
            ranges, horizontally scrollable, tiny rectangles. */}
        <View style={{gap: 6}}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{gap: 6, paddingVertical: 2}}>
            {KIND_CHIPS.map(chip => (
              <FilterChip
                key={chip.key}
                label={chip.label}
                active={kindFilter === chip.key}
                onPress={() => setKindFilter(chip.key)}
              />
            ))}
            <View style={styles.chipDivider} />
            {DATE_CHIPS.map(chip => (
              <FilterChip
                key={chip.key}
                label={chip.label}
                active={dateFilter === chip.key}
                onPress={() => setDateFilter(chip.key)}
              />
            ))}
          </ScrollView>
        </View>

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
                ? `لا فاتورة تطابق «${search}» — جرّب اسم الزبون أو الصنف أو رقم أقصر`
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
                void load(
                  debouncedSearch,
                  kindFilter,
                  dateFilter,
                  false,
                  loadedCount,
                );
              }
            }}>
            {rows.map(row => {
              // v23 (round-29 #2): a RETURN row — its own look, so a
              // refund can never be mistaken for a sale.
              const isReturn = row.return_kind != null;
              return (
                <TouchableOpacity
                  key={row.id}
                  style={[styles.row, isReturn ? styles.returnRow : null]}
                  activeOpacity={0.8}
                  onPress={() =>
                    navigation.navigate('InvoiceDetail', {saleId: row.id})
                  }>
                  <View
                    style={[
                      styles.rowIcon,
                      isReturn ? {backgroundColor: c.warningSoft} : null,
                    ]}>
                    <Icon
                      name={isReturn ? 'undo' : 'inbox'}
                      size={17}
                      color={isReturn ? c.warning : c.accent}
                    />
                  </View>
                  <View style={{flex: 1}}>
                    <Text style={styles.rowInvoice}>{row.invoice_number}</Text>
                    <Text style={styles.rowMeta}>
                      {formatDateTime(row.created_at)} · {row.itemsCount} صنف
                    </Text>
                  </View>
                  {/* v23 (round-29 #2): a return receipt — its badge
                      says which book it reversed. */}
                  {isReturn ? (
                    <View style={[styles.debtChip, styles.returnChip]}>
                      <Icon name="undo" size={11} color={c.warning} />
                      <Text style={[styles.debtChipText, {color: c.warning}]}>
                        مرتجع
                      </Text>
                    </View>
                  ) : row.returned_minor != null && row.returned_minor > 0 ? (
                    <View style={[styles.debtChip, styles.returnChip]}>
                      <Icon name="undo" size={11} color={c.warning} />
                      <Text style={[styles.debtChipText, {color: c.warning}]}>
                        منها مرتجع
                      </Text>
                    </View>
                  ) : null}
                  {/* v14 (round-20 #3): INV-D numbers are debt invoices
                      by construction — badge them even if the queue row
                      was somehow lost; queue membership (older INV-
                      format debts) keeps working as before. */}
                  {!isReturn &&
                  (debtRefs.has(row.invoice_number) ||
                    row.invoice_number.startsWith('INV-D-') ||
                    row.invoice_number.startsWith('INV-L-')) ? (
                    <View style={styles.debtChip}>
                      <Icon name="qrFrame" size={11} color={c.warning} />
                      <Text style={styles.debtChipText}>دين</Text>
                    </View>
                  ) : null}
                  {/* v20: INV-V numbers are VOUCHER redemptions — their
                      own chip so the type is visible at a glance (the
                      naming-by-type requirement). */}
                  {!isReturn && row.invoice_number.startsWith('INV-V-') ? (
                    <View style={[styles.debtChip, styles.voucherChip]}>
                      <Icon name="ticket" size={11} color={c.info} />
                      <Text style={[styles.debtChipText, {color: c.info}]}>
                        قسيمة
                      </Text>
                    </View>
                  ) : null}
                  {/* v20: an INV-D debt invoice the prepaid credit
                      (partly) covered — marked «رصيد» so the merchant
                      reads instantly it is not a pure debt. */}
                  {!isReturn && prepaidRefs.has(row.invoice_number) ? (
                    <View style={[styles.debtChip, styles.prepaidChip]}>
                      <Icon name="wallet" size={11} color={c.success} />
                      <Text style={[styles.debtChipText, {color: c.success}]}>
                        رصيد
                      </Text>
                    </View>
                  ) : null}
                  {!isReturn ? (
                    <Badge
                      label={row.payment_type === 'WHOLESALE' ? 'جملة' : 'مفرق'}
                      tone={
                        row.payment_type === 'WHOLESALE' ? 'info' : 'neutral'
                      }
                    />
                  ) : null}
                  <Text
                    style={[
                      styles.rowAmount,
                      isReturn ? {color: c.warning} : null,
                    ]}>
                    {formatMoney(row.total_amount)}
                  </Text>
                </TouchableOpacity>
              );
            })}
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

/** v23 (round-29 #3): the tiny filter chip (same look as the
 *  inventory's category chips). */
function FilterChip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  const c = useThemeColors();
  return (
    <TouchableOpacity
      style={[
        chipStyles(c).chip,
        active ? {backgroundColor: c.accent, borderColor: c.accent} : null,
      ]}
      onPress={onPress}
      activeOpacity={0.7}
      hitSlop={{top: 4, bottom: 4, left: 2, right: 2}}>
      <Text
        style={{
          color: active ? c.onAccent : c.textDim,
          fontFamily: fonts.bold,
          fontSize: 11.5,
        }}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function chipStyles(c: ReturnType<typeof useThemeColors>) {
  return StyleSheet.create({
    chip: {
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: 6,
      paddingHorizontal: 10,
      paddingVertical: 5,
      minHeight: 26,
      justifyContent: 'center',
      backgroundColor: c.surface,
    },
  });
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
  // v23 (round-29 #2): when THIS row is itself a return receipt
  //  (RET-…), its lines render from sale_return_items (positive
  //  quantities + product names) instead of the negative sale_items
  //  mirror, plus the original-invoice card.
  const [retContext, setRetContext] = useState<{
    ret: SaleReturnRecord;
    lines: {
      product_name: string;
      quantity: number;
      unit_name: string | null;
      unit_price: number;
      line_total: number;
    }[];
  } | null>(null);
  // v23 (round-29 #2): the RETURNS flow — the sheet + this
  //  invoice's return receipts (updated after every successful
  //  return so the section reflects reality without a remount).
  const [returnOpen, setReturnOpen] = useState(false);
  const [returns, setReturns] = useState<SaleReturnRecord[]>([]);
  // v12 (round-18 #3): the SILA debt row behind this invoice — the
  // creditor's identity + the debt operation number, shown and
  // copyable right in the invoice details.
  const [debt, setDebt] = useState<SilaDebtRow | null>(null);
  // v17 (round-23 #1): the LOCAL-book creditor behind an INV-L
  // invoice — same identity card, different book (the local ledger
  // has no صِلة queue row, so without this the debt invoice showed
  // NO customer at all).
  const [localCreditor, setLocalCreditor] = useState<{
    name: string;
    phone: string | null;
  } | null>(null);
  // v20: the voucher redemption behind an INV-V invoice — campaign,
  // face value, official POS-VR reference + the golden «not a debt
  // on the customer» line.
  const [voucher, setVoucher] = useState<VoucherRedemptionRow | null>(null);

  const copyText = useCallback(
    (label: string, value: string) => {
      if (value.length === 0) {
        return;
      }
      Clipboard.setString(value);
      toast(`نُسخ ${label}: ${value}`, 'success');
    },
    [toast],
  );

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      if (saleId == null) {
        return;
      }
      try {
        const record = await SaleRepo.getById(saleId);
        const lines = await SaleRepo.getItemsForSale(saleId);
        const debtRow = record
          ? await SilaRepo.byInvoiceRef(record.invoice_number)
          : null;
        // v17 (round-23 #1): local-book debts (INV-L) carry their
        // creditor in the store's own ledger.
        const localRow =
          record != null && record.invoice_number.startsWith('INV-L-')
            ? await LocalDebtsRepo.creditorByInvoiceRef(record.invoice_number)
            : null;
        // v20: voucher redemptions (INV-V) carry the campaign + the
        // official reference in their own ledger.
        const voucherRow =
          record != null && record.invoice_number.startsWith('INV-V-')
            ? await VouchersRepo.byReceiptRef(record.invoice_number)
            : null;
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
          setDebt(debtRow);
          setLocalCreditor(localRow);
          setVoucher(voucherRow);
          // v23 (round-29 #2): a RET row loads its OWN return lines
          //  (positive, named) instead of the negative mirror.
          if (record != null && record.return_kind != null) {
            const ret = await SaleRepo.returnByNumber(record.invoice_number);
            if (ret != null) {
              const retLines = await SaleRepo.returnItems(ret.id);
              if (mounted) {
                setRetContext({
                  ret,
                  lines: retLines.map(line => ({
                    product_name: line.product_name,
                    quantity: line.quantity,
                    unit_name: line.unit_name,
                    unit_price: line.unit_price,
                    line_total: line.line_total,
                  })),
                });
              }
            }
          }
          // v23 (round-29 #2): this invoice's return receipts.
          if (record != null) {
            const returnsForInvoice = await SaleRepo.returnsForSale(record.id);
            if (mounted) {
              setReturns(returnsForInvoice);
            }
          }
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

  // v23 (round-29 #2): can this invoice still take a return? Real
  //  invoices only (never a RET itself, never INV-V) and only while
  //  something of its value remains un-returned.
  const totalMinor = Math.round(sale.total_amount * 100);
  const returnedSoFar =
    returns.reduce((sum, r) => sum + r.refund_minor, 0) ?? 0;
  const canReturn =
    sale.return_kind == null &&
    !sale.invoice_number.startsWith('INV-V-') &&
    !sale.invoice_number.startsWith('RET-') &&
    returnedSoFar < totalMinor;

  return (
    <View style={styles.screen}>
      <AppHeader
        title={sale.invoice_number}
        subtitle={formatDateTime(sale.created_at)}
        showBack
        right={
          <View style={{flexDirection: 'row', gap: spacing.sm}}>
            {/* v23 (round-29 #2): إرجاع أصناف — available on every
                real invoice (cash / دين صلة / دين المتجر) until
                everything is returned. Voucher invoices (INV-V) and
                return receipts (RET-) never show it. */}
            {canReturn ? (
              <AppButton
                small
                title="إرجاع أصناف"
                icon="undo"
                onPress={() => setReturnOpen(true)}
              />
            ) : null}
            <AppButton
              small
              title="إعادة الطباعة"
              icon="printer"
              onPress={() => void reprint()}
              loading={reprinting}
            />
          </View>
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

        {/* ── v20: the VOUCHER redemption card — campaign + face value +
            the official POS-VR reference + the golden «not a debt»
            line (SILA_POS_VOUCHERS_API §2 rule 1/5). ── */}
        {voucher != null ? (
          <Card style={styles.creditorCard}>
            <View style={styles.creditorHeadRow}>
              <View style={styles.creditorIcon}>
                <Icon name="ticket" size={20} color={c.info} />
              </View>
              <View style={{flex: 1}}>
                <Text style={styles.creditorTitle}>
                  صرف قسيمة صِلة — حملة «{voucher.campaign_name ?? '—'}»
                </Text>
                <Text style={styles.creditorSub}>
                  قسيمة شرائية مؤمَّنة من المؤسسة — ليست ديناً على الزبون
                </Text>
              </View>
              <Badge
                label={
                  voucher.state === 'ok'
                    ? 'مصروفة'
                    : voucher.state === 'pending'
                    ? 'معلّقة'
                    : 'فاشلة'
                }
                tone={
                  voucher.state === 'ok'
                    ? 'success'
                    : voucher.state === 'pending'
                    ? 'warning'
                    : 'danger'
                }
              />
            </View>
            <View style={styles.creditorRows}>
              <View style={styles.creditorRow}>
                <Text style={styles.creditorLabel}>قيمة القسيمة</Text>
                <Text style={[styles.creditorValue, {color: c.info}]}>
                  {(voucher.value_minor / 100).toFixed(2)} ₪
                </Text>
              </View>
              {voucher.counter_extra_minor > 0 ? (
                <View style={styles.creditorRow}>
                  <Text style={styles.creditorLabel}>
                    الفرق النقدي بالكاشير
                  </Text>
                  <Text style={styles.creditorValue}>
                    {(voucher.counter_extra_minor / 100).toFixed(2)} ₪
                  </Text>
                </View>
              ) : null}
              {voucher.beneficiary_last4 ? (
                <View style={styles.creditorRow}>
                  <Text style={styles.creditorLabel}>هوية المستحق</Text>
                  <Text style={styles.creditorValue}>
                    ****{voucher.beneficiary_last4}
                  </Text>
                </View>
              ) : null}
              {voucher.reference_code ? (
                <View style={styles.creditorRow}>
                  <Text style={styles.creditorLabel}>
                    رقم عملية الصرف في صِلة
                  </Text>
                  <TouchableOpacity
                    style={styles.copyRow}
                    onPress={() =>
                      copyText('رقم عملية الصرف', voucher.reference_code ?? '')
                    }
                    activeOpacity={0.7}>
                    <Text
                      style={[styles.creditorMono, {color: c.success}]}
                      numberOfLines={1}>
                      {voucher.reference_code}
                    </Text>
                    <Icon name="clipboard" size={15} color={c.success} />
                  </TouchableOpacity>
                </View>
              ) : null}
              <View style={styles.creditorRow}>
                <Text style={styles.creditorLabel}>طريقة السداد</Text>
                <Text style={styles.creditorValue}>
                  تُسوّى قيمتها مع المؤسسة ضمن الحملة
                </Text>
              </View>
            </View>
          </Card>
        ) : null}

        {/* ── v12 (round-18 #3): SILA creditor card — the debt holder's
          identity + the debt operation number, copyable for support
          and reconciliation. ── */}
        {debt != null ? (
          <Card style={styles.creditorCard}>
            <View style={styles.creditorHeadRow}>
              <View style={styles.creditorIcon}>
                <Icon name="qrFrame" size={20} color={c.accent} />
              </View>
              <View style={{flex: 1}}>
                <Text style={styles.creditorTitle}>
                  بيانات الدائن — دين صِلة
                </Text>
                <Text style={styles.creditorSub}>
                  سُجّلت هذه الفاتورة ديناً عبر منظومة صِلة
                </Text>
              </View>
              <Badge
                label={
                  debt.state === 'synced'
                    ? 'مسجّل في صِلة'
                    : debt.state === 'failed'
                    ? 'فاشل'
                    : debt.state === 'syncing'
                    ? 'قيد المزامنة'
                    : 'بانتظار المزامنة'
                }
                tone={
                  debt.state === 'synced'
                    ? 'success'
                    : debt.state === 'failed'
                    ? 'danger'
                    : 'warning'
                }
              />
            </View>

            <View style={styles.creditorRows}>
              <View style={styles.creditorRow}>
                <Text style={styles.creditorLabel}>اسم الدائن</Text>
                <Text style={styles.creditorValue} numberOfLines={1}>
                  {debt.customer_name ?? 'زبون صِلة'}
                </Text>
              </View>
              {debt.customer_phone_last4 ? (
                <View style={styles.creditorRow}>
                  <Text style={styles.creditorLabel}>هاتف الدائن</Text>
                  <Text style={styles.creditorValue}>
                    ****{debt.customer_phone_last4}
                  </Text>
                </View>
              ) : null}
              <View style={styles.creditorRow}>
                <Text style={styles.creditorLabel}>قيمة الدين</Text>
                <Text style={[styles.creditorValue, {color: c.accent}]}>
                  {(debt.amount_minor / 100).toFixed(2)} ₪
                </Text>
              </View>
              <View style={styles.creditorRow}>
                <Text style={styles.creditorLabel}>رقم فاتورة الدين</Text>
                <TouchableOpacity
                  style={styles.copyRow}
                  onPress={() =>
                    copyText('رقم فاتورة الدين', debt.pos_invoice_ref)
                  }
                  activeOpacity={0.7}>
                  <Text style={styles.creditorMono} numberOfLines={1}>
                    {debt.pos_invoice_ref}
                  </Text>
                  <Icon name="clipboard" size={15} color={c.accent} />
                </TouchableOpacity>
              </View>
              {debt.state === 'synced' && debt.reference_code ? (
                <View style={styles.creditorRow}>
                  <Text style={styles.creditorLabel}>رقم عملية الدين</Text>
                  <TouchableOpacity
                    style={styles.copyRow}
                    onPress={() =>
                      copyText('رقم عملية الدين', debt.reference_code ?? '')
                    }
                    activeOpacity={0.7}>
                    <Text
                      style={[styles.creditorMono, {color: c.success}]}
                      numberOfLines={1}>
                      {debt.reference_code}
                    </Text>
                    <Icon name="clipboard" size={15} color={c.success} />
                  </TouchableOpacity>
                </View>
              ) : null}
              {debt.state === 'synced' && debt.transaction_id ? (
                <View style={styles.creditorRow}>
                  <Text style={styles.creditorLabel}>
                    معرّف العملية في صِلة
                  </Text>
                  <TouchableOpacity
                    style={styles.copyRow}
                    onPress={() =>
                      copyText('معرّف العملية', debt.transaction_id ?? '')
                    }
                    activeOpacity={0.7}>
                    <Text style={styles.creditorMonoDim} numberOfLines={1}>
                      {debt.transaction_id}
                    </Text>
                    <Icon name="clipboard" size={15} color={c.textDim} />
                  </TouchableOpacity>
                </View>
              ) : null}
            </View>

            {debt.state !== 'synced' ? (
              <View style={styles.creditorNoteBox}>
                <Icon
                  name={debt.state === 'failed' ? 'alert' : 'clock'}
                  size={14}
                  color={debt.state === 'failed' ? c.danger : c.warning}
                />
                <Text
                  style={[
                    styles.creditorNoteText,
                    {color: debt.state === 'failed' ? c.danger : c.warning},
                  ]}>
                  {debt.state === 'failed'
                    ? debt.error_message ??
                      'فشل تسجيل الدين في صِلة — أعد المحاولة من سجل الديون'
                    : 'سيُسجّل الدين في منظومة صِلة تلقائياً عند توفر الإنترنت'}
                </Text>
              </View>
            ) : null}
          </Card>
        ) : null}

        {/* ── v17 (round-23 #1): the LOCAL-book creditor card — INV-L
          debt invoices finally show WHO owes them (the customer name
          the merchant asked for on the receipt and in the details). ── */}
        {localCreditor != null ? (
          <Card style={styles.creditorCard}>
            <View style={styles.creditorHeadRow}>
              <View style={styles.creditorIcon}>
                <Icon name="book" size={20} color={c.accent} />
              </View>
              <View style={{flex: 1}}>
                <Text style={styles.creditorTitle}>
                  بيانات الدائن — دفتر المتجر
                </Text>
                <Text style={styles.creditorSub}>
                  دين مسجّل محلياً في دفتر متجرك (لا يُرفع إلى صِلة)
                </Text>
              </View>
              <Badge label="دين محلي" tone="warning" />
            </View>
            <View style={styles.creditorRows}>
              <View style={styles.creditorRow}>
                <Text style={styles.creditorLabel}>اسم الدائن</Text>
                <Text style={styles.creditorValue} numberOfLines={1}>
                  {localCreditor.name}
                </Text>
              </View>
              {localCreditor.phone ? (
                <View style={styles.creditorRow}>
                  <Text style={styles.creditorLabel}>هاتف الدائن</Text>
                  <Text style={styles.creditorValue}>
                    {localCreditor.phone}
                  </Text>
                </View>
              ) : null}
              <View style={styles.creditorRow}>
                <Text style={styles.creditorLabel}>قيمة الدين</Text>
                <Text style={[styles.creditorValue, {color: c.accent}]}>
                  {sale != null ? sale.total_amount.toFixed(2) : '—'} ₪
                </Text>
              </View>
              <View style={styles.creditorRow}>
                <Text style={styles.creditorLabel}>رقم فاتورة الدين</Text>
                <TouchableOpacity
                  style={styles.copyRow}
                  onPress={() =>
                    sale != null
                      ? copyText('رقم فاتورة الدين', sale.invoice_number)
                      : undefined
                  }
                  activeOpacity={0.7}>
                  <Text style={styles.creditorMono} numberOfLines={1}>
                    {sale?.invoice_number ?? ''}
                  </Text>
                  <Icon name="clipboard" size={15} color={c.accent} />
                </TouchableOpacity>
              </View>
            </View>
          </Card>
        ) : null}

        {/* ── Items ── */}
        {retContext != null ? (
          <>
            {/* v23 (round-29 #2): a RET receipt's own view — the
                original invoice card + POSITIVE return lines. */}
            <Text style={styles.sectionLabel}>
              أصناف مرتجعة عن فاتورة {retContext.ret.invoice_ref} (
              {retContext.lines.length})
            </Text>
            <Card style={{padding: 0, overflow: 'hidden'}}>
              {retContext.lines.map((line, index) => (
                <View
                  key={`${retContext.ret.id}-${index}`}
                  style={[
                    styles.itemRow,
                    index < retContext.lines.length - 1
                      ? styles.itemRowBorder
                      : null,
                  ]}>
                  <View style={{flex: 1}}>
                    <Text style={styles.itemName} numberOfLines={2}>
                      {line.product_name}
                      {line.unit_name && line.unit_name !== 'قطعة'
                        ? ` (${line.unit_name})`
                        : ''}
                    </Text>
                    <Text style={styles.itemMeta}>
                      {formatQty(line.quantity)} ×{' '}
                      {formatMoney(line.unit_price)} ={' '}
                      <Text style={styles.itemTotalText}>
                        {formatMoney(line.line_total)}
                      </Text>
                    </Text>
                  </View>
                </View>
              ))}
            </Card>
            {retContext.ret.debt_adjusted_minor > 0 ? (
              <View style={styles.retDebtNote}>
                <Icon name="info" size={15} color={c.warning} />
                <Text style={styles.retDebtNoteText}>
                  خُصم {formatMoney(retContext.ret.debt_adjusted_minor / 100)}{' '}
                  من{' '}
                  {retContext.ret.book === 'sila'
                    ? 'دين الزبون في تطبيق صِلة'
                    : 'دين الزبون في دفتر المتجر'}{' '}
                  نتيجة هذا المرتجع
                </Text>
              </View>
            ) : null}
          </>
        ) : (
          <>
            <Text style={styles.sectionLabel}>
              أصناف الفاتورة ({items.length})
            </Text>
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
                      {formatQty(item.quantity)} ×{' '}
                      {formatMoney(item.unit_price)} ={' '}
                      <Text style={styles.itemTotalText}>
                        {formatMoney(item.total_line_price)}
                      </Text>
                    </Text>
                  </View>
                </View>
              ))}
            </Card>
          </>
        )}

        {/* ── v23 (round-29 #2): المرتجعات — every RET receipt
            issued against THIS invoice, with what it did to the
            debt books. The invoice itself stays intact and proudly
            marked. ── */}
        {returns.length > 0 ? (
          <>
            <Text style={styles.sectionLabel}>
              مرتجعات هذه الفاتورة ({returns.length})
            </Text>
            <Card style={{padding: 0, overflow: 'hidden'}}>
              {returns.map((ret, index) => (
                <View
                  key={ret.id}
                  style={[
                    styles.itemRow,
                    index < returns.length - 1 ? styles.itemRowBorder : null,
                  ]}>
                  <View style={styles.returnRowIcon}>
                    <Icon name="undo" size={16} color={c.warning} />
                  </View>
                  <View style={{flex: 1}}>
                    <Text style={styles.itemName}>{ret.return_number}</Text>
                    <Text style={styles.itemMeta}>
                      {formatDateTime(ret.created_at)} · قيمة مرتجعة{' '}
                      {formatMoney(ret.refund_minor / 100)}
                      {ret.debt_adjusted_minor > 0
                        ? ` · خُصم من الدين ${formatMoney(
                            ret.debt_adjusted_minor / 100,
                          )}`
                        : ''}
                    </Text>
                  </View>
                  <Badge
                    label={
                      ret.book === 'sila'
                        ? 'دين صِلة'
                        : ret.book === 'local'
                        ? 'دين المتجر'
                        : 'نقدي'
                    }
                    tone="warning"
                  />
                </View>
              ))}
            </Card>
          </>
        ) : null}

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
          {/* v23 (round-29 #2): the returned part — spelled out so
              the net the customer actually owes/paid is obvious. */}
          {returnedSoFar > 0 ? (
            <View style={styles.totalRow}>
              <Text style={[styles.totalLabel, {color: c.warning}]}>
                مرتجعات منها
              </Text>
              <Text style={[styles.totalValue, {color: c.warning}]}>
                − {formatMoney(returnedSoFar / 100)}
              </Text>
            </View>
          ) : null}
          <View style={[styles.totalRow, styles.totalRowFinal]}>
            <Text style={styles.totalFinalLabel}>
              {returnedSoFar > 0 ? 'الصافي بعد المرتجعات' : 'الإجمالي المدفوع'}
            </Text>
            <MoneyText value={sale.total_amount - returnedSoFar / 100} big />
          </View>
        </Card>
      </ScrollView>

      {/* v23 (round-29 #2): the RETURN sheet — quantity pickers per
          line, live refund total, and the exact debt action spelled
          out before confirming. */}
      <ReturnSheet
        visible={returnOpen}
        saleId={sale.id}
        printerConnected={printerStatus === 'connected'}
        onClose={() => setReturnOpen(false)}
        onDone={() => {
          setReturnOpen(false);
          // Refresh EVERYTHING the screen shows — the sale row
          // (returned_minor), the returns list, the debt cards.
          const reload = async () => {
            try {
              const record = await SaleRepo.getById(sale.id);
              const returnsList = await SaleRepo.returnsForSale(sale.id);
              setSale(record);
              setReturns(returnsList);
            } catch {
              // The focus effect covers it anyway.
            }
          };
          void reload();
        }}
      />
    </View>
  );
}

// ────────────────────────────────────────────────────────────────
// v23 (round-29 #2): ReturnSheet — نافذة إرجاع الأصناف من فاتورة.
// Per-line quantity steppers (0..remaining), a live refund total
// (pro-rated for the invoice's discount), the debt action spelled
// out BEFORE confirming (خصم من دين صِلة / دين المتجر / استرداد
// نقدي), and a printed RET slip after the fact.
// ────────────────────────────────────────────────────────────────

function ReturnSheet({
  visible,
  saleId,
  printerConnected,
  onClose,
  onDone,
}: {
  visible: boolean;
  saleId: number;
  printerConnected: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const c = useThemeColors();
  const toast = useToastStore(state => state.show);
  const settings = useSettingsStore(state => state.settings);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The prepared context (InvoiceService.prepareReturn).
  const [lines, setLines] = useState<
    {item: SaleItemRecord; productName: string; remaining: number}[]
  >([]);
  const [book, setBook] = useState<'cash' | 'sila' | 'local'>('cash');
  const [ratio, setRatio] = useState(1);
  const [debtLabel, setDebtLabel] = useState<string | null>(null);
  const [debtState, setDebtState] = useState<{
    kind: string;
    amountMinor?: number;
    reason?: string;
  }>({kind: 'none'});
  // Quantities being picked, keyed by the ORIGINAL sale_item id.
  const [quantities, setQuantities] = useState<Record<number, number>>({});
  // Cash invoices choose how to refund; debt invoices always
  // reduce the debt (the goods come back, the customer owes less).
  const [refundMethod, setRefundMethod] = useState<'cash' | 'none'>('cash');

  // Load the context every time the sheet opens.
  useEffect(() => {
    if (!visible) {
      return;
    }
    setLoading(true);
    setError(null);
    setQuantities({});
    setRefundMethod('cash');
    InvoiceService.prepareReturn(saleId)
      .then(prep => {
        setLines(prep.lines);
        setBook(prep.book);
        setRatio(prep.discountRatio);
        setDebtLabel(prep.debtLabel);
        setDebtState(prep.debtState as {kind: string});
      })
      .catch(err => {
        setError(err instanceof Error ? err.message : 'تعذر تحضير الإرجاع');
      })
      .finally(() => {
        setLoading(false);
      });
  }, [visible, saleId]);

  const stepFor = (remaining: number) =>
    Number.isInteger(remaining) ? 1 : 0.5;

  const setQty = useCallback(
    (saleItemId: number, qty: number, remaining: number) => {
      setQuantities(prev => ({
        ...prev,
        [saleItemId]: Math.min(Math.max(qty, 0), remaining),
      }));
    },
    [],
  );

  // The live refund total (pro-rated for the invoice discount).
  const refundTotal = lines.reduce((sum, line) => {
    const qty = quantities[line.item.id] ?? 0;
    return sum + line.item.unit_price * qty * ratio;
  }, 0);
  const pickedCount = lines.filter(
    line => (quantities[line.item.id] ?? 0) > 0,
  ).length;

  // The debt action label — the merchant confirms the EXACT effect.
  const debtAction: string = (() => {
    if (book === 'sila') {
      if (debtState.kind === 'sila-synced') {
        return `يُخصم ${formatMoney(refundTotal)} من دين ${
          debtLabel ?? 'الزبون'
        } في تطبيق صِلة (عملية عكسية تُرفع للخادم)`;
      }
      if (debtState.kind === 'sila-pending') {
        return `يُخصم ${formatMoney(refundTotal)} من دين ${
          debtLabel ?? 'الزبون'
        } قبل رفعه لصِلة (لم يصل للخادم بعد)`;
      }
      if (debtState.kind === 'missing') {
        return 'تنبيه: سجل الدين غير موجود محلياً — لن يُخصم شيء تلقائياً من صِلة، راجع دفتر صِلة يدوياً';
      }
      return '';
    }
    if (book === 'local') {
      if (debtState.kind === 'local') {
        return `يُخصم ${formatMoney(refundTotal)} من دين ${
          debtLabel ?? 'الزبون'
        } في دفتر المتجر`;
      }
      if (debtState.kind === 'migrated') {
        return 'تنبيه: هذا الدين رُحّل إلى صِلة — خصم المرتجع يحتاج معالجة يدوية في دفتر صِلة';
      }
      if (debtState.kind === 'missing') {
        return 'تنبيه: سجل الدين غير موجود في دفتر المتجر — لن يُخصم شيء تلقائياً';
      }
    }
    return '';
  })();

  const confirm = useCallback(async () => {
    if (busy || refundTotal <= 0) {
      return;
    }
    setBusy(true);
    try {
      const payload: ReturnLineInput[] = lines
        .filter(line => (quantities[line.item.id] ?? 0) > 0)
        .map(line => ({
          saleItemId: line.item.id,
          productId: line.item.product_id,
          productName: line.productName,
          quantity: quantities[line.item.id] ?? 0,
          unitName: line.item.unit_name,
          basePerUnit:
            line.item.quantity > 0
              ? (line.item.base_quantity ?? line.item.quantity) /
                line.item.quantity
              : 1,
          unitPrice: line.item.unit_price,
          costPrice: line.item.cost_price,
        }));
      await InvoiceService.createReturn({
        saleId,
        lines: payload,
        refundMethod: book === 'cash' ? refundMethod : 'none',
        note: null,
        print: printerConnected,
        receiptSettings: {
          storeName: settings.storeName,
          storePhone: settings.storePhone,
          footerMessage: settings.footerMessage,
          storeLogoPath: settings.storeLogoPath,
          paperWidth: settings.paperWidth,
          codepage: settings.codepage,
          showProfit: settings.showProfitOnReceipt,
        },
        onPrintError: message => {
          toast(`سُجّل المرتجع لكن الطباعة فشلت: ${message}`, 'error');
        },
      });
      toast('سُجّل المرتجع وأُعيدت الكميات للمخزون', 'success');
      onDone();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'فشل تسجيل المرتجع', 'error');
    } finally {
      setBusy(false);
    }
  }, [
    busy,
    refundTotal,
    lines,
    quantities,
    book,
    refundMethod,
    saleId,
    printerConnected,
    settings,
    toast,
    onDone,
  ]);

  // v24 (round-31 #1): hardware back closes the sheet — the
  // replacement for the Modal's onRequestClose (an INLINE overlay
  // has none).
  useEffect(() => {
    if (!visible) {
      return;
    }
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!busy) {
        onClose();
      }
      return true;
    });
    return () => sub.remove();
  }, [visible, busy, onClose]);

  // v24 (round-31 #1): INLINE absolute overlay — NEVER a RN Modal
  // (a Modal rendered EMPTY/BLACK on this ROM right after the native
  // scanner closes — the exact «النافذة فارغة لا تحتوي على أصناف»
  // complaint, the same lesson as the POS debt sheet, the Sila pay
  // sheet and the voucher sheet). Mounted only while open.
  if (!visible) {
    return null;
  }

  return (
    <View style={retStyles(c).backdrop}>
      <Pressable
        style={{flex: 1}}
        onPress={() => {
          if (!busy) {
            onClose();
          }
        }}
      />
      <Pressable
        style={retStyles(c).sheet}
        onPress={() => undefined}
        disabled={busy}>
        {/* ── Sheet header ── */}
        <View style={retStyles(c).head}>
          <View style={retStyles(c).headIcon}>
            <Icon name="undo" size={20} color={c.warning} />
          </View>
          <View style={{flex: 1}}>
            <Text style={retStyles(c).headTitle}>إرجاع أصناف للفاتورة</Text>
            <Text style={retStyles(c).headSub}>
              اختر الكميات المُرجعة — تُستعاد للمخزون فوراً
            </Text>
          </View>
          <TouchableOpacity
            onPress={onClose}
            style={retStyles(c).closeBtn}
            disabled={busy}>
            <Icon name="x" size={16} color={c.textDim} />
          </TouchableOpacity>
        </View>

        {loading ? (
          <View style={retStyles(c).centerBox}>
            <ActivityIndicator size="large" color={c.accent} />
          </View>
        ) : error != null ? (
          <View style={retStyles(c).centerBox}>
            <Icon name="alert" size={30} color={c.warning} />
            <Text style={retStyles(c).errorText}>{error}</Text>
            <AppButton small title="إغلاق" onPress={onClose} />
          </View>
        ) : (
          <>
            <ScrollView
              style={{flex: 1}}
              contentContainerStyle={retStyles(c).linesList}
              showsVerticalScrollIndicator={false}>
              {lines.map(line => {
                const qty = quantities[line.item.id] ?? 0;
                const step = stepFor(line.remaining);
                const lineValue = line.item.unit_price * qty * ratio;
                return (
                  <View key={line.item.id} style={retStyles(c).lineCard}>
                    <View style={{flex: 1}}>
                      <Text style={retStyles(c).lineName} numberOfLines={2}>
                        {line.productName}
                        {line.item.unit_name && line.item.unit_name !== 'قطعة'
                          ? ` (${line.item.unit_name})`
                          : ''}
                      </Text>
                      <Text style={retStyles(c).lineMeta}>
                        المتبقي قابل للإرجاع: {formatQty(line.remaining)} ·{' '}
                        {formatMoney(line.item.unit_price)} للوحدة
                      </Text>
                      {qty > 0 ? (
                        <Text
                          style={[retStyles(c).lineMeta, {color: c.warning}]}>
                          قيمة الإرجاع: {formatMoney(lineValue)}
                        </Text>
                      ) : null}
                    </View>
                    <View style={retStyles(c).stepper}>
                      <TouchableOpacity
                        style={retStyles(c).stepBtn}
                        onPress={() =>
                          setQty(line.item.id, qty - step, line.remaining)
                        }
                        disabled={busy || qty <= 0}>
                        <Icon name="minus" size={14} color={c.text} />
                      </TouchableOpacity>
                      <Text style={retStyles(c).stepValue}>
                        {formatQty(qty)}
                      </Text>
                      <TouchableOpacity
                        style={retStyles(c).stepBtn}
                        onPress={() =>
                          setQty(line.item.id, qty + step, line.remaining)
                        }
                        disabled={busy || qty >= line.remaining}>
                        <Icon name="plus" size={14} color={c.text} />
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={retStyles(c).allBtn}
                        onPress={() =>
                          setQty(line.item.id, line.remaining, line.remaining)
                        }
                        disabled={busy || qty >= line.remaining}>
                        <Text style={retStyles(c).allBtnText}>الكل</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                );
              })}
            </ScrollView>

            {/* ── The live summary + the debt action ── */}
            <View style={retStyles(c).summaryBox}>
              {book === 'cash' ? (
                <View style={retStyles(c).methodRow}>
                  <TouchableOpacity
                    style={[
                      retStyles(c).methodChip,
                      refundMethod === 'cash'
                        ? {backgroundColor: c.accent, borderColor: c.accent}
                        : null,
                    ]}
                    onPress={() => setRefundMethod('cash')}
                    disabled={busy}>
                    <Text
                      style={[
                        retStyles(c).methodText,
                        refundMethod === 'cash' ? {color: c.onAccent} : null,
                      ]}>
                      استرداد نقدي للزبون
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      retStyles(c).methodChip,
                      refundMethod === 'none'
                        ? {backgroundColor: c.accent, borderColor: c.accent}
                        : null,
                    ]}
                    onPress={() => setRefundMethod('none')}
                    disabled={busy}>
                    <Text
                      style={[
                        retStyles(c).methodText,
                        refundMethod === 'none' ? {color: c.onAccent} : null,
                      ]}>
                      استبدال بضاعة (بلا استرداد)
                    </Text>
                  </TouchableOpacity>
                </View>
              ) : null}
              {debtAction.length > 0 ? (
                <View style={retStyles(c).debtActionBox}>
                  <Icon
                    name={debtAction.startsWith('تنبيه') ? 'alert' : 'info'}
                    size={15}
                    color={c.warning}
                  />
                  <Text style={retStyles(c).debtActionText}>{debtAction}</Text>
                </View>
              ) : null}
              <View style={retStyles(c).totalRow}>
                <Text style={retStyles(c).totalLabel}>
                  إجمالي قيمة المرتجع ({pickedCount} صنف)
                </Text>
                <Text style={retStyles(c).totalValue}>
                  {formatMoney(refundTotal)}
                </Text>
              </View>
              <AppButton
                title="تأكيد الإرجاع"
                icon="undo"
                onPress={() => void confirm()}
                loading={busy}
                disabled={refundTotal <= 0 || pickedCount === 0}
              />
              {printerConnected ? null : (
                <Text style={retStyles(c).printHint}>
                  لا طابعة متصلة — سيُسجّل المرتجع دون طباعة إشعار
                </Text>
              )}
            </View>
          </>
        )}
      </Pressable>
    </View>
  );
}

/** The ReturnSheet's own styles (kept separate from the screen's). */
function retStyles(c: ReturnType<typeof useThemeColors>) {
  return StyleSheet.create({
    backdrop: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      justifyContent: 'flex-end',
      zIndex: 70,
      elevation: 70,
    },
    sheet: {
      maxHeight: '86%',
      backgroundColor: c.bg,
      borderTopLeftRadius: 22,
      borderTopRightRadius: 22,
      paddingTop: spacing.lg,
      paddingBottom: spacing.xl,
      paddingHorizontal: spacing.lg,
      borderWidth: 1,
      borderColor: c.borderSoft,
    },
    head: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingBottom: spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: c.borderSoft,
    },
    headIcon: {
      width: 42,
      height: 42,
      borderRadius: 13,
      backgroundColor: c.warningSoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    headTitle: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.heading,
    },
    headSub: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      marginTop: 2,
    },
    closeBtn: {
      width: 34,
      height: 34,
      borderRadius: 10,
      backgroundColor: c.surfaceHi,
      alignItems: 'center',
      justifyContent: 'center',
    },
    centerBox: {
      paddingVertical: spacing.xxl,
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
    },
    errorText: {
      color: c.text,
      fontFamily: fonts.regular,
      fontSize: typography.caption,
      textAlign: 'center',
      lineHeight: 20,
    },
    linesList: {
      gap: spacing.sm,
      paddingVertical: spacing.md,
    },
    lineCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: radius.md,
      padding: spacing.md,
    },
    lineName: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.caption,
    },
    lineMeta: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      marginTop: 2,
    },
    stepper: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    stepBtn: {
      width: 32,
      height: 32,
      borderRadius: 10,
      backgroundColor: c.surfaceHi,
      borderWidth: 1,
      borderColor: c.borderSoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    stepValue: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.caption,
      minWidth: 40,
      textAlign: 'center',
      fontVariant: ['tabular-nums'],
    },
    allBtn: {
      paddingHorizontal: 8,
      paddingVertical: 6,
      borderRadius: 8,
      backgroundColor: c.accentSofter,
    },
    allBtnText: {
      color: c.accent,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    summaryBox: {
      borderTopWidth: 1,
      borderTopColor: c.borderSoft,
      paddingTop: spacing.md,
      gap: spacing.md,
    },
    methodRow: {
      flexDirection: 'row',
      gap: spacing.sm,
    },
    methodChip: {
      flex: 1,
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: radius.md,
      paddingVertical: spacing.sm,
      alignItems: 'center',
      backgroundColor: c.surface,
    },
    methodText: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.small,
      textAlign: 'center',
    },
    debtActionBox: {
      flexDirection: 'row',
      gap: spacing.sm,
      alignItems: 'flex-start',
      backgroundColor: c.warningSoft,
      borderRadius: radius.md,
      padding: spacing.md,
    },
    debtActionText: {
      flex: 1,
      color: c.text,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      lineHeight: 18,
    },
    totalRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    totalLabel: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.caption,
    },
    totalValue: {
      color: c.warning,
      fontFamily: fonts.black,
      fontSize: typography.title,
      fontVariant: ['tabular-nums'],
    },
    printHint: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      textAlign: 'center',
    },
  });
}

const useStyles = makeStyles(c =>
  StyleSheet.create({
    screen: {flex: 1, backgroundColor: c.bg},
    content: {flex: 1, padding: spacing.lg, gap: spacing.md},
    list: {gap: spacing.sm, paddingBottom: spacing.xl},
    // v23 (round-29): the kind/date filter row + return rows.
    chipDivider: {
      width: 1,
      alignSelf: 'stretch',
      backgroundColor: c.borderSoft,
      marginHorizontal: 2,
    },
    returnRow: {
      borderColor: c.warning,
      backgroundColor: c.warningSoft,
    },
    returnChip: {backgroundColor: c.warningSoft},
    retDebtNote: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.sm,
      backgroundColor: c.warningSoft,
      borderRadius: radius.md,
      padding: spacing.md,
    },
    retDebtNoteText: {
      flex: 1,
      color: c.text,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      lineHeight: 18,
    },
    returnRowIcon: {
      width: 34,
      height: 34,
      borderRadius: 10,
      backgroundColor: c.warningSoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
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
    // v11 (SILA): the small debt marker on SILA-deferred invoices.
    debtChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 3,
      backgroundColor: c.warningSoft,
      borderRadius: 6,
      paddingHorizontal: 6,
      paddingVertical: 3,
    },
    /** v20: the قسيمة chip (info tint) + the رصيد chip (success tint). */
    voucherChip: {
      backgroundColor: c.infoSoft,
    },
    prepaidChip: {
      backgroundColor: c.successSoft,
    },
    debtChipText: {
      color: c.warning,
      fontFamily: fonts.bold,
      fontSize: typography.micro,
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
    // v12 (round-18 #3): SILA creditor card.
    creditorCard: {
      padding: spacing.md,
      borderWidth: 1,
      borderColor: c.accentSoft,
    },
    creditorHeadRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
    },
    creditorIcon: {
      width: 44,
      height: 44,
      borderRadius: 13,
      backgroundColor: c.accentSoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    creditorTitle: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.caption,
    },
    creditorSub: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      marginTop: 1,
    },
    creditorRows: {
      marginTop: spacing.sm,
      gap: 7,
    },
    creditorRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
      minHeight: 34,
    },
    creditorLabel: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.small,
      flexShrink: 0,
    },
    creditorValue: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.small,
      textAlign: 'left',
      flex: 1,
    },
    creditorMono: {
      color: c.accent,
      fontFamily: fonts.bold,
      fontSize: typography.small,
      fontVariant: ['tabular-nums'],
      flex: 1,
      textAlign: 'left',
    },
    creditorMonoDim: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      fontVariant: ['tabular-nums'],
      flex: 1,
      textAlign: 'left',
    },
    copyRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.sm,
      paddingHorizontal: spacing.sm,
      paddingVertical: 6,
      flex: 1,
    },
    creditorNoteBox: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
      marginTop: spacing.sm + 2,
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.sm,
      paddingHorizontal: spacing.sm,
      paddingVertical: 8,
    },
    creditorNoteText: {
      flex: 1,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      textAlign: 'left',
    },
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
