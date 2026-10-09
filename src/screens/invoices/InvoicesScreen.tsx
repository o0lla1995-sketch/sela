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
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  Clipboard,
  Dimensions,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
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
import {formatDateTime, formatMoney, formatQty, parseNumber} from '../../core/format';
import {
  cameraPermissionMessage,
  ensureCameraPermission,
  scanBarcode,
} from '../../services/vision/scanFlow';
import type {
  ExchangeLineInput,
  Product,
  ProductUnit,
  ProductVariant,
  ReturnLineInput,
  SaleItemRecord,
  SaleRecord,
  SaleReturnRecord,
  SilaDebtRow,
} from '../../core/types';
import {VariantRepo} from '../../database/repositories/VariantRepo';
import {UnitRepo} from '../../database/repositories/UnitRepo';

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
  const toast = useToastStore(state => state.show);

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

  /** v25 (round-32 #4): scan-to-open — the receipt's CODE128
   *  barcode carries the invoice number; one native scan looks
   *  the row up EXACTLY and opens its detail screen instantly. */
  const [scanBusy, setScanBusy] = useState(false);
  const scanInvoice = useCallback(async () => {
    if (scanBusy) {
      return;
    }
    const permission = await ensureCameraPermission();
    if (permission !== 'granted') {
      Alert.alert('إذن الكاميرا مطلوب', cameraPermissionMessage(permission), [
        {text: 'إغلاق', style: 'cancel'},
        {
          text: 'فتح الإعدادات',
          onPress: () => {
            void Linking.openSettings();
          },
        },
      ]);
      return;
    }
    setScanBusy(true);
    try {
      const code = await scanBarcode();
      if (code == null) {
        return; // closed without scanning.
      }
      const sale = await SaleRepo.byInvoiceNumber(code);
      if (sale == null) {
        toast(
          `لا توجد فاتورة بهذا الباركود (${code}) — الباركود يجب أن يكون من إيصال طبعه هذا المتجر`,
          'error',
          4500,
        );
        return;
      }
      navigation.navigate('InvoiceDetail', {saleId: sale.id});
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'فشل مسح الباركود',
        'error',
      );
    } finally {
      setScanBusy(false);
    }
  }, [scanBusy, navigation, toast]);

  return (
    <View style={styles.screen}>
      {/* v28 (round-36 #3): the barcode reader left the header — it
          now sits BESIDE the search field (icon only, no text), one
          tap from the exact place merchants scan from. */}
      <AppHeader
        title="الفواتير"
        subtitle={`${rows.length} فاتورة معروضة`}
        showBack
      />
      <View style={styles.content}>
        <View style={styles.searchRow}>
          <View style={{flex: 1}}>
            <SearchBar
              value={search}
              onChangeText={onSearch}
              placeholder="ابحث برقم الفاتورة أو الزبون أو الصنف أو المبلغ…"
            />
          </View>
          <TouchableOpacity
            style={styles.scanBtn}
            onPress={() => void scanInvoice()}
            disabled={scanBusy}
            activeOpacity={0.7}
            hitSlop={{top: 6, bottom: 6, left: 6, right: 6}}>
            {scanBusy ? (
              <ActivityIndicator size="small" color={c.accent} />
            ) : (
              <Icon name="barcode" size={22} color={c.accent} />
            )}
          </TouchableOpacity>
        </View>

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
              // v26 (round-34 #1): the status badges moved OFF the
              // main row line into their own wrapped line under the
              // invoice number. With the old layout every badge was a
              // DIRECT child of the horizontal row — the moment a
              // status changed and «منها مرتجع» appeared, five chips
              // + the amount fought for one line and the card blew up
              // «كبيرة جدا ومشوهة». Now the main line NEVER changes
              // shape (icon + number + amount), and badges stack
              // neatly below, wrapping to a second line if needed.
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
                  <View style={{flex: 1, minWidth: 0}}>
                    <View style={styles.rowTitleLine}>
                      <Text
                        style={styles.rowInvoice}
                        numberOfLines={1}
                        adjustsFontSizeToFit={false}>
                        {row.invoice_number}
                      </Text>
                      <Text
                        style={[
                          styles.rowAmount,
                          isReturn ? {color: c.warning} : null,
                        ]}
                        numberOfLines={1}>
                        {formatMoney(row.total_amount)}
                      </Text>
                    </View>
                    <Text style={styles.rowMeta}>
                      {formatDateTime(row.created_at)} · {row.itemsCount} صنف
                    </Text>
                    {/* The badges line — compact chips, wrapping safely
                        without ever stretching the card. */}
                    <View style={styles.rowBadges}>
                      {/* v23 (round-29 #2): a return receipt — its badge
                          says which book it reversed. */}
                      {isReturn ? (
                        <View style={[styles.debtChip, styles.returnChip]}>
                          <Icon name="undo" size={10} color={c.warning} />
                          <Text
                            style={[styles.debtChipText, {color: c.warning}]}>
                            مرتجع
                          </Text>
                        </View>
                      ) : row.returned_minor != null &&
                        row.returned_minor > 0 ? (
                        <View style={[styles.debtChip, styles.returnChip]}>
                          <Icon name="undo" size={10} color={c.warning} />
                          <Text
                            style={[styles.debtChipText, {color: c.warning}]}>
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
                          <Icon name="qrFrame" size={10} color={c.warning} />
                          <Text style={styles.debtChipText}>دين</Text>
                        </View>
                      ) : null}
                      {/* v20: INV-V numbers are VOUCHER redemptions — their
                          own chip so the type is visible at a glance (the
                          naming-by-type requirement). */}
                      {!isReturn && row.invoice_number.startsWith('INV-V-') ? (
                        <View style={[styles.debtChip, styles.voucherChip]}>
                          <Icon name="ticket" size={10} color={c.info} />
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
                          <Icon name="wallet" size={10} color={c.success} />
                          <Text
                            style={[styles.debtChipText, {color: c.success}]}>
                            رصيد
                          </Text>
                        </View>
                      ) : null}
                      {!isReturn ? (
                        <View
                          style={[
                            styles.debtChip,
                            row.payment_type === 'WHOLESALE'
                              ? styles.wholesaleChip
                              : styles.retailChip,
                          ]}>
                          <Text
                            style={[
                              styles.debtChipText,
                              row.payment_type === 'WHOLESALE'
                                ? {color: c.info}
                                : {color: c.textDim},
                            ]}>
                            {row.payment_type === 'WHOLESALE' ? 'جملة' : 'مفرق'}
                          </Text>
                        </View>
                      ) : null}
                    </View>
                  </View>
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
  //  v26 (round-34 #2): 1-agora tolerance — the pro-rata rounding of
  //  refund_minor (Σ round(line×ratio) vs round(Σ)) can leave the
  //  accumulator ±1 agora off the invoice total; without the epsilon
  //  the button could stay on a fully-returned invoice.
  const totalMinor = Math.round(sale.total_amount * 100);
  const returnedSoFar =
    returns.reduce((sum, r) => sum + r.refund_minor, 0) ?? 0;
  const canReturn =
    sale.return_kind == null &&
    !sale.invoice_number.startsWith('INV-V-') &&
    !sale.invoice_number.startsWith('RET-') &&
    totalMinor - returnedSoFar > 1;

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
                return receipts (RET-) never show it.
                v25 (round-32 #1): shrunk to a compact icon+word
                chip — the wide AppButton squeezed the header on
                this ROM's narrow screens. */}
            {canReturn ? (
              <TouchableOpacity
                style={styles.retChip}
                onPress={() => setReturnOpen(true)}
                activeOpacity={0.7}>
                <Icon name="undo" size={14} color={c.warning} />
                <Text style={styles.retChipText}>إرجاع</Text>
              </TouchableOpacity>
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

  // v26 (round-34 #4): NO entrance animation and a 400ms close-guard.
  // The v25 fade+slide entrance still read as «فتح وأغلق بسرعة» on the
  // first press of this ROM: the sheet mounted at opacity 0 while the
  // JS thread ran the prepareReturn queries, the first native-driven
  // animation frames dropped, and any stray/bounced touch landed on
  // the just-mounted backdrop Pressable → instant close. Now the sheet
  // renders at FULL opacity in the very first frame (nothing to
  // glitch), and the backdrop ignores every press within 400ms of
  // mount — the bounced second tap of a cold digitizer can no longer
  // close the window it just opened.
  const mountedAt = useRef(0);
  if (visible && mountedAt.current === 0) {
    mountedAt.current = Date.now();
  }
  if (!visible) {
    mountedAt.current = 0;
  }
  const backdropPressGuarded = useCallback(() => {
    if (Date.now() - mountedAt.current < 400) {
      return; // the opening touch's bounce — ignore it.
    }
    onClose();
  }, [onClose]);

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
  // v36: الاستبدال بقيمة المرجع — أصناف بديلة تخرج من المخزون بدل
  // الإرجاع المالي. بلا أي أثر مالي: المرتجع يعود للمخزون والبديل
  // يخرج منه؛ لا استرداد نقدي ولا خصم دين ولا عكس رفع لصلة.
  const [exchangePicks, setExchangePicks] = useState<ExchangePick[]>([]);
  const [exchangeOpen, setExchangeOpen] = useState(false);

  // Load the context every time the sheet opens.
  useEffect(() => {
    if (!visible) {
      return;
    }
    setLoading(true);
    setError(null);
    setQuantities({});
    setRefundMethod('cash');
    setExchangePicks([]);
    setExchangeOpen(false);
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

  // v36: الاستبدال — القيمة الحية للبضاعة البديلة.
  const exchangeTotal = exchangePicks.reduce(
    (sum, pick) => sum + pick.unitPrice * pick.quantity,
    0,
  );
  const exchangeModeOn = exchangePicks.length > 0;
  // v40 (الجولة 48 #2): الفرق الحي بين قيمة المرتجع والبدائل —
  // موجب: المرتجع أغلى (يُرَد للزبون نقداً أو يُخصم من دينه)؛
  // سالب: البدائل أغلى (يدفعها الزبون نقداً أو تُضاف لدينه).
  const exchangeDiff = refundTotal - exchangeTotal;

  /* v39 (الجولة 47): ملاحظة الإرجاع (debtAction) حُذفت من نافذة
   *  التأكيد بطلب التاجر نصاً — صندوق «يُخصم من دين الزبون…» لم
   *  يعد يُعرض؛ أثر العملية في confirm/createReturn كما هو تماماً،
   *  وتحذيرا الحواف الحرجة (سجل دين مفقود/مُرحّل) انتقلا توست
   *  لحظة التأكيد داخل confirm أعلاه. */

  const confirm = useCallback(async () => {
    if (busy || refundTotal <= 0) {
      return;
    }
    // v40 (الجولة 48 #2): في وضع الاستبدال تُسوّى قيمة الفرق — لا
    //  رفض للزيادة بعد الآن (البدائل الأغلى يدفع فرقها الزبون نقداً
    //  أو يُضاف لدينه). الحارسان الوحيدان: قيمة بديلة صالحة، ودين
    //  محلي مفقود لا يمكن زيادته تلقائياً (الزيادة على دين مسدَّد
    //  محذوف تتطلب معرفة الزبون — تُرفض برسالة واضحة).
    if (exchangePicks.length > 0) {
      if (exchangeTotal <= 0) {
        toast('قيمة الاستبدال غير صالحة — راجع الأصناف البديلة', 'error');
        return;
      }
      if (
        exchangeDiff < -0.0001 &&
        book === 'local' &&
        debtState.kind === 'missing'
      ) {
        toast(
          'دين هذه الفاتورة مسدَّد ومحذوف من الدفتر — لا يمكن زيادة دين غير موجود تلقائياً؛ سجّل الفرق يدوياً من دفتر الزبائن أو أرجع مالياً وبِع البدائل',
          'error',
          7000,
        );
        return;
      }
    }
    // v39 (الجولة 47): ملاحظة الإرجاع حُذفت من النافذة — تحذيرا
    //  الحواف الحرجة فقط (سجل دين مفقود/مُرحّل لصِلة) يظهران توست
    //  لحظة التأكيد كي لا يفاجأ التاجر بدين لم يُخصم تلقائياً.
    if (
      book !== 'cash' &&
      !exchangeModeOn &&
      (debtState.kind === 'missing' || debtState.kind === 'migrated')
    ) {
      toast(
        debtState.kind === 'missing'
          ? 'تنبيه: سجل الدين غير موجود — لن يُخصم شيء تلقائياً، راجع الدفتر يدوياً'
          : 'تنبيه: هذا الدين مُرحّل إلى صِلة — عالج خصم المرتجع في دفتر صِلة يدوياً',
        'info',
        6000,
      );
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
          // v35: استرجاع مخزون المتغير تحديداً (لون × مقاس / حجم)
          //  أو كل مقاسات لون الربطة المرتجعة.
          variantId: line.item.variant_id ?? null,
          variantColor: line.item.variant_color ?? null,
          variantLabel: line.item.variant_label ?? null,
        }));
      // v36→v40 (الجولة 48 #2): أصناف الاستبدال (إن اختيرت) — تخرج
      //  من المخزون بدل الإرجاع المالي، والفرق بالسعر يُسوّى:
      //  نقدي للزبون/منه، أو خصم/زيادة دين.
      const exchangePayload: ExchangeLineInput[] | undefined =
        exchangePicks.length > 0
          ? exchangePicks.map(pick => ({
              productId: pick.productId,
              productName: pick.name,
              quantity: pick.quantity,
              unitName: pick.unitName,
              basePerUnit: pick.basePerUnit,
              unitPrice: pick.unitPrice,
              costPrice: pick.costPrice,
              variantId: pick.variantId ?? null,
              variantColor: pick.variantColor ?? null,
              variantLabel: pick.variantLabel ?? null,
            }))
          : undefined;
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
        exchange: exchangePayload,
      });
      // v40 (الجولة 48 #2): رسالة النجاح تشرح تسوية الفرق بوضوح —
      //  ماذا حدث للفرق بالضبط (نقد خارج/داخل، خصم/زيادة دين، أو
      //  استبدال متكافئ) كي يعرف الكاشير ما ينفذه فوراً.
      toast(
        exchangePayload != null
          ? exchangeDiff > 0.0001
            ? book === 'cash'
              ? `سُجّل الاستبدال — سلّم الزبون الفرق ${formatMoney(exchangeDiff)} نقداً من الخزينة`
              : `سُجّل الاستبدال — خُصم الفرق ${formatMoney(exchangeDiff)} من دين الزبون`
            : exchangeDiff < -0.0001
            ? book === 'cash'
              ? `سُجّل الاستبدال — قبض الفرق ${formatMoney(-exchangeDiff)} نقداً من الزبون إلى الخزينة`
              : `سُجّل الاستبدال — زاد دين الزبون بالفرق ${formatMoney(-exchangeDiff)}`
            : 'سُجّل الاستبدال المتكافئ — المرتجع عاد والبديل خرج ولا فرق'
          : 'سُجّل المرتجع وأُعيدت الكميات للمخزون',
        'success',
        6000,
      );
      onDone();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'فشل تسجيل المرتجع', 'error');
    } finally {
      setBusy(false);
    }
  }, [
    busy,
    refundTotal,
    exchangePicks,
    exchangeTotal,
    exchangeDiff,
    lines,
    quantities,
    book,
    refundMethod,
    saleId,
    printerConnected,
    settings,
    toast,
    onDone,
    // v39: تحذيرا الحواف (missing/migrated) يُعرضان توست لحظة
    //  التأكيد بعد حذف ملاحظة الإرجاع من النافذة.
    debtState,
    exchangeModeOn,
  ]);

  // v24 (round-31 #1): hardware back closes the sheet — the
  // replacement for the Modal's onRequestClose (an INLINE overlay
  // has none). v26: guarded like the backdrop — a spurious back
  // event right after opening can no longer kill the fresh sheet.
  useEffect(() => {
    if (!visible) {
      return;
    }
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!busy && Date.now() - mountedAt.current >= 400) {
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

  const sheetHeight = Math.round(Dimensions.get('window').height * 0.82);

  return (
    <View style={retStyles(c).backdrop}>
      <Pressable
        style={{flex: 1}}
        onPress={backdropPressGuarded}
      />
      <View style={[retStyles(c).sheet, {height: sheetHeight}]}>
        <Pressable
          style={{flex: 1}}
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
                        hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
                        onPress={() =>
                          setQty(line.item.id, qty - step, line.remaining)
                        }
                        disabled={busy || qty <= 0}>
                        <Icon name="minus" size={13} color={c.text} />
                      </TouchableOpacity>
                      <Text style={retStyles(c).stepValue}>
                        {formatQty(qty)}
                      </Text>
                      <TouchableOpacity
                        style={retStyles(c).stepBtn}
                        hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
                        onPress={() =>
                          setQty(line.item.id, qty + step, line.remaining)
                        }
                        disabled={busy || qty >= line.remaining}>
                        <Icon name="plus" size={13} color={c.text} />
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={retStyles(c).allBtn}
                        hitSlop={{top: 6, bottom: 6, left: 6, right: 6}}
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

            {/* ═══ v37 (الجولة 45 #2ج+2د): قائمة أصناف الاستبدال
                البديلة — انتقلت من التذييل إلى داخل التمرير: كانت
                تنمو بلا حد مع كل صنف مضاف فتدفع مجموع القيمة وزر
                التأكيد أسفل حدود الشاشة (شكوى التاجر نصاً:
                «مختفٍ زر التأكيد أسفل الشاشة أثناء عمليات
                الاستبدال أو الإرجاع»). الآن مهما بلغ عدد الأصناف
                والعمليات المعقدة: التمرير يمررها كافة والتذييل
                محدود الارتفاع يعرض زر التأكيد دائماً. ═══ */}
            {exchangeModeOn ? (
              <View style={retStyles(c).exchangeListScrollSection}>
                <Text style={retStyles(c).exchangeSectionTitle}>
                  أصناف الاستبدال البديلة ({exchangePicks.length}) — بقيمة{' '}
                  {formatMoney(exchangeTotal)}
                </Text>
                {exchangePicks.map(pick => (
                  <View key={pick.key} style={retStyles(c).exchangeRow}>
                    <View style={{flex: 1}}>
                      <Text style={retStyles(c).exchangeRowName} numberOfLines={1}>
                        {pick.name}
                        {pick.variantLabel ? ` (${pick.variantLabel})` : ''}
                        {pick.unitName && pick.unitName !== 'قطعة'
                          ? ` · ${pick.unitName}`
                          : ''}
                      </Text>
                      <Text style={retStyles(c).exchangeRowMeta}>
                        {formatQty(pick.quantity)} × {formatMoney(pick.unitPrice)} ={' '}
                        {formatMoney(pick.unitPrice * pick.quantity)}
                      </Text>
                    </View>
                    <TouchableOpacity
                      style={retStyles(c).exchangeRemove}
                      onPress={() =>
                        setExchangePicks(prev =>
                          prev.filter(x => x.key !== pick.key),
                        )
                      }
                      disabled={busy}>
                      <Icon name="x" size={13} color={c.danger} />
                    </TouchableOpacity>
                  </View>
                ))}
                <TouchableOpacity
                  style={retStyles(c).exchangeClear}
                  onPress={() => setExchangePicks([])}
                  disabled={busy}>
                  <Text style={retStyles(c).exchangeClearText}>
                    إلغاء الاستبدال — العودة للإرجاع المالي
                  </Text>
                </TouchableOpacity>
              </View>
            ) : null}
            </ScrollView>

            {/* ── v37: التذييل المحدود الارتفاع — كل عناصره صفوف
                مقيدة الطول (أزرار + نصوص + مجاميع)؛ قائمة الأصناف
                البديلة انتقلت للتمرير أعلاه فلا يمكن لشيء أن يدفع
                زر التأكيد خارج الشاشة. ── */}
            <View style={retStyles(c).summaryBox}>
              {/* ═══ v40 (الجولة 48 #3): تذييل مضغوط بطلب التاجر نصاً —
                  «اجعل قيمة المرجع وقيمة المستبدل في نفس الصف
                  واضغطهم جيداً حتى نقلل المساحة، وزر الاستبدال اجعل
                  له مكاناً مناسباً في الأسفل بجانب زر التأكيد».
                  البنية: (١) طريقة الاسترداد عند الحاجة، (٢) صندوق واحد
                  يجمع قيمة المرتجع وقيمة الاستبدال جنباً إلى جنب،
                  (٣) شريط الفرق الحي وتسويته، (٤) صف الأزرار: زر
                  الاستبدال المضغوط بجانب زر التأكيد المهيمن. ═══ */}
              {book === 'cash' && !exchangeModeOn ? (
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
                      {/* v38 (الجولة 46 #6): التسمية الدقيقة — هذا ليس
                          نافذة الاستبدال (في الأسفل) بل إرجاع بلا
                          استرداد نقدي. */}
                      إرجاع بلا استرداد نقدي
                    </Text>
                  </TouchableOpacity>
                </View>
              ) : null}

              {/* v40 #3: قيمتا المرتجع والاستبدال في صف واحد — نصفي
                  صندوق مضغوطين (وضع الاستبدال) أو صندوق واحد كامل
                  العرض (الإرجاع المالي)؛ نفس الارتفاع دائماً فلا
                  يقفز التذييل بين الوضعين. */}
              {exchangeModeOn ? (
                <View style={retStyles(c).valuesPairRow}>
                  <View style={retStyles(c).valueHalf}>
                    <Text style={retStyles(c).valueHalfLabel}>
                      المرتجع ({pickedCount} صنف)
                    </Text>
                    <Text style={retStyles(c).valueHalfAmount}>
                      {formatMoney(refundTotal)}
                    </Text>
                  </View>
                  <View
                    style={[
                      retStyles(c).valueHalf,
                      retStyles(c).valueHalfAccent,
                    ]}>
                    <Text
                      style={[
                        retStyles(c).valueHalfLabel,
                        {color: c.accent},
                      ]}>
                      المستبدل ({exchangePicks.length} صنف)
                    </Text>
                    <Text
                      style={[
                        retStyles(c).valueHalfAmount,
                        {color: c.accent},
                      ]}>
                      {formatMoney(exchangeTotal)}
                    </Text>
                  </View>
                </View>
              ) : (
                <View style={retStyles(c).valuesPairRow}>
                  <View style={retStyles(c).valueHalf}>
                    <Text style={retStyles(c).valueHalfLabel}>
                      إجمالي قيمة المرتجع ({pickedCount} صنف)
                    </Text>
                    <Text style={retStyles(c).valueHalfAmount}>
                      {formatMoney(refundTotal)}
                    </Text>
                  </View>
                </View>
              )}

              {/* v40 (الجولة 48 #2+#3): شريط الفرق الحي وتسويته —
                  سطر واحد مضغوط يخبر الكاشير بالضبط ماذا سيحدث
                  للفرق قبل أن يضغط التأكيد (نقد خارج/داخل أو خصم/
                  زيادة دين أو تكافؤ). */}
              {exchangeModeOn ? (
                <View
                  style={[
                    retStyles(c).diffStrip,
                    exchangeDiff > 0.0001
                      ? {borderColor: c.warning}
                      : exchangeDiff < -0.0001
                      ? {borderColor: c.success}
                      : null,
                  ]}>
                  <Text
                    style={[
                      retStyles(c).diffText,
                      exchangeDiff < -0.0001
                        ? {color: c.success}
                        : exchangeDiff > 0.0001
                        ? {color: c.warning}
                        : null,
                    ]}>
                    {Math.abs(exchangeDiff) < 0.0001
                      ? 'استبدال متكافئ — لا فرق'
                      : exchangeDiff > 0
                      ? `الفرق ${formatMoney(exchangeDiff)} — ${
                          book === 'cash'
                            ? 'سلّمه نقداً من الخزينة'
                            : debtState.kind === 'migrated'
                            ? 'دين مُرحّل لصلة — عالجه يدوياً'
                            : 'يُخصم من دين الزبون'
                        }`
                      : `الفرق ${formatMoney(-exchangeDiff)} — ${
                          book === 'cash'
                            ? 'اقبضه نقداً من الزبون'
                            : debtState.kind === 'migrated' ||
                              debtState.kind === 'missing'
                            ? 'دين غير قابل للزيادة هنا — عالجه يدوياً'
                            : 'يُضاف إلى دين الزبون'
                        }`}
                  </Text>
                </View>
              ) : null}

              {/* v40 #3: صف الأزرار — زر الاستبدال المضغوط بجانب زر
                  التأكيد (كان زراً عريضاً بعنوان وشرح يأخذ صفاً
                  كاملاً). v38: يظهر دائماً ما دامت في الفاتورة أصناف
                  قابلة للإرجاع؛ الضغط بلا كميات يرشد برسالة. */}
              <View style={retStyles(c).actionsRow}>
                {lines.length > 0 ? (
                  <TouchableOpacity
                    style={[
                      retStyles(c).exchangeCompactBtn,
                      exchangeModeOn
                        ? {borderColor: c.accent, backgroundColor: c.accentSoft}
                        : null,
                    ]}
                    onPress={() => {
                      if (pickedCount === 0) {
                        toast(
                          'اختر كميات المرتجع أولاً — الاستبدال يقابل قيمة ما تُرجعه',
                          'info',
                          5000,
                        );
                      }
                      setExchangeOpen(true);
                    }}
                    disabled={busy}
                    activeOpacity={0.75}>
                    <Icon
                      name="swap"
                      size={15}
                      color={exchangeModeOn ? c.accent : c.textDim}
                    />
                    <Text
                      style={[
                        retStyles(c).exchangeCompactText,
                        exchangeModeOn ? {color: c.accent} : null,
                      ]}
                      numberOfLines={1}>
                      {exchangeModeOn
                        ? `الاستبدال (${exchangePicks.length})`
                        : 'استبدال'}
                    </Text>
                  </TouchableOpacity>
                ) : null}
                <AppButton
                  title={exchangeModeOn ? 'تأكيد الاستبدال' : 'تأكيد الإرجاع'}
                  icon={exchangeModeOn ? 'swap' : 'undo'}
                  onPress={() => void confirm()}
                  loading={busy}
                  disabled={refundTotal <= 0 || pickedCount === 0}
                  style={{flex: 1.6}}
                />
              </View>
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
      {/* v36: نافذة الاستبدال — طبقة فوق نافذة الإرجاع (نفس درس
          الروم: بلا Modal أبداً — inline overlay). */}
      {exchangeOpen ? (
        <ExchangeSheet
          refundTotal={refundTotal}
          picks={exchangePicks}
          onAdd={pick =>
            setExchangePicks(prev => {
              const existing = prev.find(x => x.key === pick.key);
              if (existing != null) {
                return prev.map(x =>
                  x.key === pick.key ? {...x, ...pick} : x,
                );
              }
              return [...prev, pick];
            })
          }
          onRemove={key =>
            setExchangePicks(prev => prev.filter(x => x.key !== key))
          }
          onClear={() => setExchangePicks([])}
          onClose={() => setExchangeOpen(false)}
        />
      ) : null}
    </View>
  );
}

/** v36: صنف استبدال مختار في النافذة (قبل التنفيذ). */
interface ExchangePick {
  /** مفتاح فريد: منتج:وحدة:متغير. */
  key: string;
  productId: number;
  name: string;
  quantity: number;
  unitName: string | null;
  basePerUnit: number;
  unitPrice: number;
  costPrice: number;
  variantId?: number | null;
  variantColor?: string | null;
  variantLabel?: string | null;
}


/**
 * v36: ExchangeSheet — نافذة «الاستبدال بقيمة المرجع».
 * ─────────────────────────────────────────────────────────────────
 * بحث بالاسم + قارئ باركود → اختيار منتج → خياراته (الكمية،
 * الوحدة، المتغير لون×مقاس/حجم) → «أضف إلى الاستبدال» — يُوضع في
 * سلة الاستبدال بدل المنتجات المرتجعة؛ الفرق بين قيمة المرتجع
 * والبدائل يُسوّى عند التأكيد (نقد أو دين) — v40 (الجولة 48 #2).
 * فقط المخزون (المرتجع يعود عند التنفيذ والبديل يخرج).
 * Inline overlay — NEVER a RN Modal (نفس درس هذا الروم).
 *
 * v41 (الجولة 49 #3): كان تبديل الوحدات في رقائق المنتج المفتوح
 * بطيئاً بشكل ملحوظ — كل ضغطة على رقاقة وحدة تعيد رسم النافذة
 * بأكملها، وexcStyles(c) كانت تُستدعى داخل كل عنصر JSX (٤٦ موضعاً)،
 * وكل استدعاء يبني StyleSheet.create كاملة بعشرات الأنماط، فضلاً
 * عن إعادة رسم قائمة النتائج (حتى ٨٠ صفاً) بلا أي سبب. الإصلاح:
 *  1) ذاكرة أنماط على مستوى الوحدة مفتاحها لوحة الألوان المستقرة
 *     من المتجر — تُبنى الأنماط مرة واحدة لكل ثيم.
 *  2) صفوف النتائج مكوّن مذكّر (React.memo) بدالة فتح مستقرة عبر
 *     ref — فلا تُلمس القائمة إطلاقاً عند تبديل الوحدات/المتغيرات.
 */

/** v41: ذاكرة أنماط ExchangeSheet — مفتاحها كائن اللوحة المستقر
 *  من useThemeColors (zustand يعيد نفس المرجع ما لم يتغير الثيم). */
let exchangeStylesCache: {
  theme: ReturnType<typeof useThemeColors>;
  styles: ReturnType<typeof excStyles>;
} | null = null;

function exchangeStyles(c: ReturnType<typeof useThemeColors>) {
  if (exchangeStylesCache != null && exchangeStylesCache.theme === c) {
    return exchangeStylesCache.styles;
  }
  const built = excStyles(c);
  exchangeStylesCache = {theme: c, styles: built};
  return built;
}

/** v41 (الجولة 49 #3): صف منتج في نتائج بحث الاستبدال — مكوّن
 *  مذكّر: لا يُعاد رسمه عند تبديل الوحدات/المتغيرات في صندوق
 *  الخيارات، فيبقى تبديل الوحدة لحظياً حتى مع ٨٠ نتيجة معروضة. */
const ExchangeProductRow = React.memo(function ExchangeProductRow({
  product,
  onOpen,
}: {
  product: Product;
  onOpen: (productId: number) => void;
}) {
  const c = useThemeColors();
  const styles = exchangeStyles(c);
  return (
    <TouchableOpacity
      style={styles.productRow}
      onPress={() => onOpen(product.id)}
      activeOpacity={0.75}>
      <View style={{flex: 1}}>
        <Text style={styles.productName} numberOfLines={1}>
          {product.name}
        </Text>
        <Text style={styles.productMeta}>
          {formatMoney(product.retail_price)}
          {Number(product.stock_untracked) === 1
            ? ' · بلا تتبع مخزون'
            : ` · متوفر ${formatQty(product.stock_quantity)}`}
        </Text>
      </View>
      <Icon name="chevronLeft" size={16} color={c.textFaint} />
    </TouchableOpacity>
  );
});

function ExchangeSheet({
  refundTotal,
  picks,
  onAdd,
  onRemove,
  onClear,
  onClose,
}: {
  refundTotal: number;
  picks: ExchangePick[];
  onAdd: (pick: ExchangePick) => void;
  onRemove: (key: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const c = useThemeColors();
  // v41 (الجولة 49 #3): الأنماط عبر الذاكرة — تُبنى مرة واحدة لكل
  //  ثيم بدل ٤٦ استدعاء StyleSheet.create في كل إعادة رسم.
  const styles = exchangeStyles(c);
  const toast = useToastStore(state => state.show);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<Product[]>([]);
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  // الخيارات الحية للمنتج المفتوح (productId → الاختيار).
  const [openId, setOpenId] = useState<number | null>(null);
  const [openUnits, setOpenUnits] = useState<ProductUnit[]>([]);
  const [openVariants, setOpenVariants] = useState<ProductVariant[]>([]);
  const [chosenUnitId, setChosenUnitId] = useState<number | null>(null);
  const [chosenVariantId, setChosenVariantId] = useState<number | null>(null);
  const [qtyText, setQtyText] = useState('1');
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedAt = useRef(Date.now());

  const load = useCallback(async (q: string) => {
    setLoading(true);
    try {
      const rows = await ProductRepo.list({
        search: q.trim().length > 0 ? q.trim() : undefined,
        archival: 'active',
      });
      setResults(rows.slice(0, 80));
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load('');
  }, [load]);

  useEffect(() => {
    if (searchTimer.current != null) {
      clearTimeout(searchTimer.current);
    }
    searchTimer.current = setTimeout(() => void load(search), 250);
    return () => {
      if (searchTimer.current != null) {
        clearTimeout(searchTimer.current);
      }
    };
  }, [search, load]);

  const doScan = useCallback(async () => {
    if (scanning) {
      return;
    }
    setScanning(true);
    try {
      const permission = await ensureCameraPermission();
      if (permission !== 'granted') {
        toast(cameraPermissionMessage(permission), 'error');
        return;
      }
      const code = await scanBarcode();
      if (code == null) {
        return;
      }
      const hit =
        (await ProductRepo.findByBarcode(code.trim())) ?? null;
      if (hit == null) {
        // جرّب باركودات الوحدات (كرتونة/علبة…).
        const byUnit = await UnitRepo.findByBarcode(code.trim());
        if (byUnit != null) {
          const unitProduct = await ProductRepo.getById(byUnit.productId);
          if (unitProduct != null) {
            setSearch(unitProduct.name);
            void openProduct(byUnit.productId, byUnit.productUnit?.id ?? null);
          }
          return;
        }
        toast('لا منتج بهذا الباركود — ابحث بالاسم', 'error');
        return;
      }
      setSearch(hit.name);
      void openProduct(hit.id, null);
    } finally {
      setScanning(false);
    }
  }, [scanning, toast]);

  /** فتح منتج بخياراته — تحميل وحداته ومتغيراته ثم اختيار افتراضي. */
  const openProduct = useCallback(
    async (productId: number, preferUnitId: number | null) => {
      const product = results.find(x => x.id === productId)
        ?? (await ProductRepo.getById(productId));
      if (product == null) {
        toast('المنتج غير موجود', 'error');
        return;
      }
      const units = await UnitRepo.listForProduct(productId);
      const variants = await VariantRepo.listByProduct(productId);
      setOpenId(productId);
      setOpenUnits(units);
      setOpenVariants(variants);
      // v37 (الجولة 45 #2د): الافتراض = وحدة البيع الأساس نفسها
      //  (شريط/قطعة/حصة) — لا أول وحدة مخصصة (كرتونة/علبة):
      //  طلب التاجر نصاً «إظهار المنتجات بوحدة البيع الافتراضية
      //  في السلة (وليس الوحدة المدخلة يدوياً)». الوحدات المخصصة
      //  تظل خياراً صريحاً بضغطة واحدة على رقائقها.
      setChosenUnitId(preferUnitId ?? null);
      // v37: المتغير الافتراضي = أول متغير متوفر منه مخزون (وليس
      //  أول صف قد يكون نافداً) — الملابس والأحجام جاهزة للبيع
      //  فور فتح المنتج.
      const inStockVariant = variants.find(v => v.stock_quantity > 0);
      setChosenVariantId(
        (inStockVariant ?? variants[0] ?? null)?.id ?? null,
      );
      // v37: الكمية الافتراضية 1 — القراءة عبر parseNumber فتقبل
      //  الأرقام العربية والفاصلة العربية في حقل الكمية.
      setQtyText('1');
    },
    [results, toast],
  );

  const closeProduct = useCallback(() => {
    setOpenId(null);
    setChosenUnitId(null);
    setChosenVariantId(null);
    setQtyText('1');
  }, []);

  // v41 (الجولة 49 #3): دالة فتح مستقرة عبر latest-ref — مرجع صفوف
  //  النتائج المذكّرة لا يتغير عند تحديث النتائج أو الخيارات، فلا
  //  تُعاد الصفوف عند تبديل الوحدات/المتغيرات أبداً.
  const openProductRef = useRef(openProduct);
  openProductRef.current = openProduct;
  const openProductStable = useCallback((productId: number) => {
    void openProductRef.current(productId, null);
  }, []);

  const openProductRow = results.find(x => x.id === openId) ?? null;
  const openUnit =
    openUnits.find(u => u.id === chosenUnitId) ?? null;
  const openVariant =
    openVariants.find(v => v.id === chosenVariantId) ?? null;

  // السعر الحي: متغير الحجم (مطعم) له سعره؛ وإلا سعر الوحدة
  // (بما يعادلها من سعر الأساس) أو سعر الأساس نفسه.
  const liveUnitPrice: number = (() => {
    if (openProductRow == null) {
      return 0;
    }
    if (openVariant != null && openVariant.retail_price != null) {
      return openVariant.retail_price;
    }
    if (openUnit != null) {
      const override = openUnit.retail_price;
      if (override != null && override > 0) {
        return override;
      }
      return openProductRow.retail_price * openUnit.conversion;
    }
    return openProductRow.retail_price;
  })();
  const liveBasePerUnit = openUnit != null ? openUnit.conversion : 1;
  const liveCost: number = (() => {
    if (openProductRow == null) {
      return 0;
    }
    if (openVariant != null && openVariant.cost_price != null) {
      return openVariant.cost_price;
    }
    if (openUnit != null) {
      return openProductRow.cost_price * openUnit.conversion;
    }
    return openProductRow.cost_price;
  })();

  // v37 (الجولة 45 #2د): القراءة عبر parseNumber المطوّر — يقبل
  //  الأرقام العربية ٢ والفاصلة العربية ٫ كما في أي حقل آخر؛
  //  القديم كان يقصّها فيصبح الحقل فارغاً والمجموع «—».
  const qtyNum = parseNumber(qtyText);
  const qtyValid = !Number.isNaN(qtyNum) && qtyNum > 0;

  const variantStock = openVariant != null
    ? openVariant.stock_quantity
    : null;
  const productStock =
    openProductRow != null &&
    Number(openProductRow.stock_untracked) !== 1
      ? openProductRow.stock_quantity
      : null;

  const addCurrent = useCallback(() => {
    if (openProductRow == null || !qtyValid) {
      return;
    }
    // v37 (الجولة 45 #2د): حارس المخزون الصريح — متغير نافد أو
    //  كمية فوق المتوفر تُرفض برسالة عربية واضحة (كانت تُضاف
    //  بصمت فوق المخزون المتوفر). بلا تتبع يُتجاوز الحارس
    //  كعادته (مطعم/كافيتريا).
    const untrackedOpen = openProductRow.stock_untracked === 1;
    if (!untrackedOpen) {
      if (openVariant != null && openVariant.stock_quantity < qtyNum) {
        toast(
          `المتغير ${openVariant.color ? openVariant.color + ' ' : ''}${openVariant.size} المتوفر منه ${formatQty(openVariant.stock_quantity)} فقط — راجع الكمية`,
          'error',
        );
        return;
      }
      if (
        openVariant == null &&
        openProductRow.stock_quantity < qtyNum
      ) {
        toast(
          `المتوفر من ${openProductRow.name} ${formatQty(openProductRow.stock_quantity)} فقط — راجع الكمية`,
          'error',
        );
        return;
      }
    }
    const label = openVariant != null
      ? `${openVariant.color ? openVariant.color + ' · ' : ''}${openVariant.size}`
      : null;
    const unitName = openUnit != null ? openUnit.unitName : null;
    const pick: ExchangePick = {
      key: `${openProductRow.id}:${chosenUnitId ?? 0}:${chosenVariantId ?? 0}`,
      productId: openProductRow.id,
      name: openProductRow.name,
      quantity: qtyNum,
      unitName,
      basePerUnit: liveBasePerUnit,
      unitPrice: liveUnitPrice,
      costPrice: liveCost,
      variantId: chosenVariantId,
      variantColor: openVariant?.color ?? null,
      variantLabel: label,
    };
    onAdd(pick);
    toast(
      `أُضيف للاستبدال: ${pick.name}${
        label ? ` (${label})` : ''
      } — ${formatQty(qtyNum)} × ${formatMoney(liveUnitPrice)}`,
      'success',
    );
    closeProduct();
  }, [
    openProductRow,
    openVariant,
    openUnit,
    chosenUnitId,
    chosenVariantId,
    qtyValid,
    qtyNum,
    liveUnitPrice,
    liveBasePerUnit,
    liveCost,
    onAdd,
    toast,
    closeProduct,
  ]);

  // hardware back closes (guarded like ReturnSheet).
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (Date.now() - mountedAt.current >= 400) {
        if (openId != null) {
          closeProduct();
        } else {
          onClose();
        }
      }
      return true;
    });
    return () => sub.remove();
  }, [openId, closeProduct, onClose]);

  const picksTotal = picks.reduce(
    (sum, pick) => sum + pick.unitPrice * pick.quantity,
    0,
  );

  const sheetHeight = Math.round(Dimensions.get('window').height * 0.88);

  return (
    <View style={styles.backdrop}>
      <Pressable
        style={{flex: 1}}
        onPress={() => {
          if (Date.now() - mountedAt.current >= 400) {
            onClose();
          }
        }}
      />
      <View style={[styles.sheet, {height: sheetHeight}]}>
        <View style={styles.head}>
          <View style={styles.headIcon}>
            <Icon name="swap" size={20} color={c.accent} />
          </View>
          <View style={{flex: 1}}>
            <Text style={styles.headTitle}>
              الاستبدال بقيمة المرجع
            </Text>
            <Text style={styles.headSub}>
              اختر البضاعة البديلة — تخرج من المخزن بدل المرتجع، والفرق
              يُسوّى عند التأكيد (نقد أو دين)
            </Text>
          </View>
          <TouchableOpacity
            onPress={onClose}
            style={styles.closeBtn}>
            <Icon name="x" size={16} color={c.textDim} />
          </TouchableOpacity>
        </View>

        {/* البحث + المسح */}
        <View style={styles.searchRow}>
          <TextInput
            style={styles.searchInput}
            value={search}
            onChangeText={setSearch}
            placeholder="ابحث بالاسم أو امسح الباركود…"
            placeholderTextColor={c.textFaint}
            autoCorrect={false}
          />
          <TouchableOpacity
            style={styles.scanBtn}
            onPress={() => void doScan()}
            disabled={scanning || loading}>
            {scanning ? (
              <ActivityIndicator size="small" color={c.onAccent} />
            ) : (
              <Icon name="scan" size={18} color={c.onAccent} />
            )}
          </TouchableOpacity>
        </View>

        {/* المنتج المفتوح بخياراته */}
        {openProductRow != null ? (
          <View style={styles.optionBox}>
            <View style={styles.optionHead}>
              <View style={{flex: 1}}>
                <Text style={styles.optionName} numberOfLines={1}>
                  {openProductRow.name}
                </Text>
                <Text style={styles.optionMeta}>
                  {productStock != null
                    ? `المتوفر: ${formatQty(productStock)}`
                    : 'مخزون بلا تتبع'}
                  {variantStock != null
                    ? ` · مخزون المتغير: ${formatQty(variantStock)}`
                    : ''}
                </Text>
              </View>
              <TouchableOpacity onPress={closeProduct} style={styles.closeBtn}>
                <Icon name="x" size={14} color={c.textDim} />
              </TouchableOpacity>
            </View>
            {openVariants.length > 0 ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.chipRow}>
                {openVariants.map(v => {
                  const active = v.id === chosenVariantId;
                  // v37 (الجولة 45 #2د): متغير نافد (منتج متتبع) —
                  //  معتم وبلا ضغط: لا يُختار خطأً في زيادة قيمة
                  //  الاستبدال فوق المخزون المتوفر.
                  const out =
                    openProductRow.stock_untracked !== 1 &&
                    v.stock_quantity <= 0;
                  return (
                    <TouchableOpacity
                      key={v.id}
                      style={[
                        styles.chip,
                        active ? {backgroundColor: c.accent, borderColor: c.accent} : null,
                        out ? {opacity: 0.45} : null,
                      ]}
                      disabled={out}
                      onPress={() => setChosenVariantId(v.id)}>
                      <Text
                        style={[
                          styles.chipText,
                          active ? {color: c.onAccent} : null,
                        ]}>
                        {v.color ? `${v.color} · ` : ''}
                        {v.size}
                        {out ? ' (نافد)' : ` (${formatQty(v.stock_quantity)})`}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            ) : null}
            {openUnits.length > 0 ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.chipRow}>
                {/* v37 (الجولة 45 #2د): وحدة الأساس أولاً — الافتراض
                    عند فتح أي منتج (طلب التاجر: السلة بوحدة البيع
                    الافتراضية، والوحدات الأكبر خيار صريح). */}
                <TouchableOpacity
                  style={[
                    styles.chip,
                    chosenUnitId == null
                      ? {backgroundColor: c.accent, borderColor: c.accent}
                      : null,
                  ]}
                  onPress={() => setChosenUnitId(null)}>
                  <Text
                    style={[
                      styles.chipText,
                      chosenUnitId == null ? {color: c.onAccent} : null,
                    ]}>
                    {openProductRow.base_unit_name ?? 'قطعة'} (الأساس) —{' '}
                    {formatMoney(openProductRow.retail_price)}
                  </Text>
                </TouchableOpacity>
                {openUnits.map(u => {
                  const active = u.id === chosenUnitId;
                  const price =
                    u.retail_price != null && u.retail_price > 0
                      ? u.retail_price
                      : openProductRow.retail_price * u.conversion;
                  return (
                    <TouchableOpacity
                      key={u.id}
                      style={[
                        styles.chip,
                        active ? {backgroundColor: c.accent, borderColor: c.accent} : null,
                      ]}
                      onPress={() => setChosenUnitId(u.id)}>
                      <Text
                        style={[
                          styles.chipText,
                          active ? {color: c.onAccent} : null,
                        ]}>
                        {u.unitName} — {formatMoney(price)}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            ) : null}
            <View style={styles.qtyRow}>
              <Text style={styles.qtyLabel}>الكمية</Text>
              <TextInput
                style={styles.qtyInput}
                value={qtyText}
                onChangeText={t =>
                  // v37 (الجولة 45 #2د): يقبل الأرقام العربية
                  //  ٠-٩/۰-۹ والفاصلة العربية ٫ والفاصلة
                  //  الإنجليزية كعشرية — لا يقصّها بعد الآن
                  //  (القديم كان يفرغ الحقل مع لوحة عربية).
                  setQtyText(
                    t
                      .replace(/,/g, '.')
                      .replace(/[^\d.٫٠-٩۰-۹]/g, ''),
                  )
                }
                keyboardType="decimal-pad"
                autoCorrect={false}
              />
              <Text style={styles.qtyTotal}>
                {qtyValid
                  ? `${formatQty(qtyNum)} × ${formatMoney(liveUnitPrice)} = ${formatMoney(
                      liveUnitPrice * qtyNum,
                    )}`
                  : '—'}
              </Text>
            </View>
            <AppButton
              title="أضف إلى الاستبدال"
              icon="plus"
              variant="success"
              onPress={addCurrent}
              disabled={!qtyValid || liveUnitPrice <= 0}
            />
          </View>
        ) : null}

        {/* نتائج البحث */}
        <ScrollView
          style={{flex: 1}}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}>
          {loading ? (
            <View style={styles.centerBox}>
              <ActivityIndicator size="large" color={c.accent} />
            </View>
          ) : results.length === 0 ? (
            <View style={styles.centerBox}>
              <Text style={styles.emptyText}>
                لا نتائج — جرّب بحثاً آخر أو امسح الباركود
              </Text>
            </View>
          ) : (
            results.map(product => (
              <ExchangeProductRow
                key={product.id}
                product={product}
                onOpen={openProductStable}
              />
            ))
          )}
        </ScrollView>

        {/* سلة الاستبدال + الخلاصة */}
        {picks.length > 0 ? (
          <View style={styles.cartBox}>
            <View style={styles.cartHead}>
              <Text style={styles.cartTitle}>
                سلة الاستبدال ({picks.length})
              </Text>
              <TouchableOpacity onPress={onClear}>
                <Text style={styles.cartClear}>تفريغ</Text>
              </TouchableOpacity>
            </View>
            <ScrollView
              style={{maxHeight: 110}}
              showsVerticalScrollIndicator={false}>
              {picks.map(pick => (
                <View key={pick.key} style={styles.cartRow}>
                  <View style={{flex: 1}}>
                    <Text style={styles.cartRowName} numberOfLines={1}>
                      {pick.name}
                      {pick.variantLabel ? ` (${pick.variantLabel})` : ''}
                      {pick.unitName && pick.unitName !== 'قطعة'
                        ? ` · ${pick.unitName}`
                        : ''}
                    </Text>
                    <Text style={styles.cartRowMeta}>
                      {formatQty(pick.quantity)} × {formatMoney(pick.unitPrice)} ={' '}
                      {formatMoney(pick.unitPrice * pick.quantity)}
                    </Text>
                  </View>
                  <TouchableOpacity
                    style={styles.exchangeRemove}
                    onPress={() => onRemove(pick.key)}>
                    <Icon name="x" size={13} color={c.danger} />
                  </TouchableOpacity>
                </View>
              ))}
            </ScrollView>
            <View style={styles.balanceRow}>
              <Text style={styles.balanceText}>
                {/* v40 (الجولة 48 #2): لا رفض للزيادة — الفرق يُسوّى
                    عند التأكيد (نقد أو دين) كما يعرض شريط الفرق في
                    نافذة الإرجاع. */}
                المرتجع: {formatMoney(refundTotal)} · المستبدل:{' '}
                <Text
                  style={[
                    styles.balanceText,
                    picksTotal > refundTotal + 0.0001
                      ? {color: c.accent, fontWeight: '700'}
                      : {color: c.success, fontWeight: '700'},
                  ]}>
                  {formatMoney(picksTotal)}
                </Text>
                {Math.abs(picksTotal - refundTotal) < 0.0001
                  ? ' · تكافؤ'
                  : picksTotal > refundTotal
                  ? ` · الفرق ${formatMoney(picksTotal - refundTotal)} على الزبون`
                  : ` · الفرق ${formatMoney(refundTotal - picksTotal)} للزبون`}
              </Text>
            </View>
          </View>
        ) : null}

        <View style={styles.actions}>
          <AppButton
            title="تم — عودة للمرتجع"
            variant="primary"
            icon="check"
            onPress={onClose}
          />
        </View>
      </View>
    </View>
  );
}

/** The ExchangeSheet's own styles (v36). */
function excStyles(c: ReturnType<typeof useThemeColors>) {
  return StyleSheet.create({
    backdrop: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.55)',
    },
    sheet: {
      backgroundColor: c.surface,
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      overflow: 'hidden',
    },
    head: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      padding: 14,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    headIcon: {
      width: 38,
      height: 38,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.surfaceAlt,
    },
    headTitle: {
      fontFamily: fonts.bold,
      fontSize: 15,
      color: c.text,
    },
    headSub: {
      fontFamily: fonts.regular,
      fontSize: 11.5,
      color: c.textDim,
      marginTop: 2,
    },
    closeBtn: {
      width: 32,
      height: 32,
      borderRadius: 16,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.surfaceAlt,
    },
    searchRow: {
      flexDirection: 'row',
      gap: 8,
      padding: 12,
    },
    searchInput: {
      flex: 1,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontFamily: fonts.regular,
      fontSize: 13,
      color: c.text,
      backgroundColor: c.surfaceAlt,
    },
    scanBtn: {
      width: 44,
      borderRadius: radius.md,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.accent,
    },
    optionBox: {
      marginHorizontal: 10,
      marginBottom: 6,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      padding: 9,
      backgroundColor: c.surfaceAlt,
      gap: 6,
    },
    optionHead: {flexDirection: 'row', alignItems: 'center', gap: 6},
    optionName: {
      fontFamily: fonts.bold,
      fontSize: 13,
      color: c.text,
    },
    optionMeta: {
      fontFamily: fonts.regular,
      fontSize: 10.5,
      color: c.textDim,
      marginTop: 1,
    },
    chipRow: {flexDirection: 'row', gap: 5, paddingVertical: 1},
    chip: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 999,
      paddingHorizontal: 9,
      paddingVertical: 4,
      backgroundColor: c.surfaceHi,
    },
    chipText: {
      fontFamily: fonts.medium,
      fontSize: 11,
      color: c.text,
    },
    qtyRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    qtyLabel: {
      fontFamily: fonts.medium,
      fontSize: 12,
      color: c.textDim,
    },
    qtyInput: {
      width: 74,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.sm,
      paddingHorizontal: 8,
      paddingVertical: 6,
      fontFamily: fonts.bold,
      fontSize: 13,
      color: c.text,
      backgroundColor: c.surfaceHi,
      textAlign: 'center',
    },
    qtyTotal: {
      flex: 1,
      fontFamily: fonts.medium,
      fontSize: 11.5,
      color: c.text,
      textAlign: 'left',
    },
    list: {paddingHorizontal: 10, paddingVertical: 3},
    centerBox: {alignItems: 'center', justifyContent: 'center', padding: 24},
    emptyText: {
      fontFamily: fonts.regular,
      fontSize: 12,
      color: c.textDim,
      textAlign: 'center',
    },
    // v38 (الجولة 46 #7): صف نتيجة البحث المضغوط — طلب التاجر حرفياً
    //  (كان كبيراً جداً يأخذ مساحة كبيرة عند الاستبدال).
    productRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.sm,
      padding: 7,
      marginBottom: 4,
      backgroundColor: c.surfaceAlt,
    },
    productName: {
      fontFamily: fonts.medium,
      fontSize: 12.5,
      color: c.text,
    },
    productMeta: {
      fontFamily: fonts.regular,
      fontSize: 10.5,
      color: c.textDim,
      marginTop: 1,
    },
    cartBox: {
      margin: 10,
      marginTop: 4,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      padding: 8,
      backgroundColor: c.surfaceAlt,
    },
    cartHead: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 4,
    },
    cartTitle: {
      fontFamily: fonts.bold,
      fontSize: 12.5,
      color: c.text,
    },
    cartClear: {fontFamily: fonts.medium, fontSize: 11.5, color: c.danger},
    cartRow: {flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 3},
    cartRowName: {
      fontFamily: fonts.medium,
      fontSize: 12,
      color: c.text,
    },
    cartRowMeta: {
      fontFamily: fonts.regular,
      fontSize: 10.5,
      color: c.textDim,
      marginTop: 1,
    },
    exchangeRemove: {
      width: 26,
      height: 26,
      borderRadius: 13,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.surfaceHi,
    },
    balanceRow: {marginTop: 6, alignItems: 'center'},
    balanceText: {
      fontFamily: fonts.regular,
      fontSize: 11.5,
      color: c.textDim,
      textAlign: 'center',
    },
    actions: {padding: 10, paddingTop: 4},
  });
}

/** The ReturnSheet's own styles (kept separate from the screen's). */
function retStyles(c: ReturnType<typeof useThemeColors>) {
  return StyleSheet.create({
    // ═══ v40 (الجولة 48 #3): تذييل الإرجاع المضغوط — قيمتا المرتجع
    // والمستبدل في صف واحد، شريط فرق حي، وزر الاستبدال المضغوط
    // بجانب زر التأكيد (كان زراً عريضاً بصف كامل). ═══
    valuesPairRow: {
      flexDirection: 'row',
      gap: 8,
    },
    valueHalf: {
      flex: 1,
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.borderSoft,
      paddingHorizontal: 10,
      paddingVertical: 7,
      gap: 1,
    },
    valueHalfAccent: {
      borderColor: c.border,
    },
    valueHalfLabel: {
      fontFamily: fonts.regular,
      fontSize: 11,
      color: c.textDim,
    },
    valueHalfAmount: {
      fontFamily: fonts.black,
      fontSize: 16.5,
      color: c.text,
      fontVariant: ['tabular-nums'],
    },
    diffStrip: {
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: radius.sm,
      alignItems: 'center',
      paddingVertical: 5,
      paddingHorizontal: 8,
      marginTop: 2,
      marginBottom: 2,
      backgroundColor: c.surfaceAlt,
    },
    diffText: {
      fontFamily: fonts.bold,
      fontSize: 11.5,
      color: c.text,
      textAlign: 'center',
    },
    actionsRow: {
      flexDirection: 'row',
      gap: 8,
      alignItems: 'stretch',
      marginTop: 4,
    },
    exchangeCompactBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 5,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      paddingHorizontal: 12,
      paddingVertical: 8,
      backgroundColor: c.surfaceAlt,
      minWidth: 92,
    },
    exchangeCompactText: {
      fontFamily: fonts.bold,
      fontSize: 12.5,
      color: c.textDim,
    },
    exchangeList: {
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.lg,
      padding: 10,
      marginBottom: 10,
      gap: 6,
    },
    /** v37 (الجولة 45 #2ج): قسم أصناف الاستبدال داخل التمرير —
     *  يتقلص ويمرّره ScrollView بدل أن يدفع التذييل أسفل الشاشة. */
    exchangeListScrollSection: {
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.lg,
      padding: 10,
      marginTop: 4,
      gap: 6,
    },
    exchangeSectionTitle: {
      fontFamily: fonts.bold,
      fontSize: 12.5,
      color: c.accent,
      marginBottom: 2,
    },
    exchangeRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    exchangeRowName: {
      fontFamily: fonts.medium,
      fontSize: 13,
      color: c.text,
    },
    exchangeRowMeta: {
      fontFamily: fonts.regular,
      fontSize: 11.5,
      color: c.textDim,
      marginTop: 1,
    },
    exchangeRemove: {
      width: 30,
      height: 30,
      borderRadius: 15,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.surfaceHi,
    },
    exchangeClear: {alignItems: 'center', paddingVertical: 6},
    exchangeClearText: {
      fontFamily: fonts.medium,
      fontSize: 12,
      color: c.danger,
    },
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
    // v25 (round-32 #1): FIXED height (set inline at render time —
    // 72% of the window) instead of maxHeight — the loading spinner,
    // the error box and the full list now share ONE stable frame, so
    // the sheet never "jumps" from small to tall (the double-window
    // flash on this ROM).
    sheet: {
      backgroundColor: c.bg,
      borderTopLeftRadius: 22,
      borderTopRightRadius: 22,
      paddingTop: spacing.lg,
      paddingBottom: spacing.xl,
      paddingHorizontal: spacing.lg,
      borderWidth: 1,
      borderColor: c.borderSoft,
      overflow: 'hidden',
    },
    head: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingBottom: spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: c.borderSoft,
    },
    headIcon: {
      width: 34,
      height: 34,
      borderRadius: 11,
      backgroundColor: c.warningSoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    headTitle: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: 15.5,
    },
    headSub: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: 11,
      marginTop: 1,
    },
    closeBtn: {
      width: 30,
      height: 30,
      borderRadius: 9,
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
      gap: 5,
      paddingVertical: spacing.sm,
    },
    // v38 (الجولة 46 #7): صف المرتجع المضغوط — طلب التاجر حرفياً.
    lineCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: radius.md,
      padding: 8,
    },
    lineName: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: 12.5,
    },
    lineMeta: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: 11,
      marginTop: 1,
    },
    stepper: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
    },
    stepBtn: {
      width: 28,
      height: 28,
      borderRadius: 9,
      backgroundColor: c.surfaceHi,
      borderWidth: 1,
      borderColor: c.borderSoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    stepValue: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: 12.5,
      minWidth: 30,
      textAlign: 'center',
      fontVariant: ['tabular-nums'],
    },
    allBtn: {
      paddingHorizontal: 7,
      paddingVertical: 5,
      borderRadius: 7,
      backgroundColor: c.accentSofter,
    },
    allBtnText: {
      color: c.accent,
      fontFamily: fonts.bold,
      fontSize: 11,
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
    /* v39 (الجولة 47): أنماط ملاحظة الإرجاع حُذفت معها من النافذة. */
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
    // v28 (round-36 #3): text search + icon-only barcode reader in
    // one row (moved here from the header text chip).
    searchRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    scanBtn: {
      width: 46,
      height: 46,
      borderRadius: radius.md,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
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
      alignItems: 'flex-start',
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
    /** v26 (round-34 #1): invoice number + amount ALWAYS on one line —
     *  badges can never squeeze them again. */
    rowTitleLine: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    rowInvoice: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.caption,
      fontVariant: ['tabular-nums'],
      flexShrink: 1,
    },
    rowMeta: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      marginTop: 1,
    },
    /** v26 (round-34 #1): the wrapped badges line — chips stack and
     *  wrap; the card grows a badge line at most, never distorts. */
    rowBadges: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: 5,
      marginTop: 6,
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
      paddingVertical: 2.5,
      alignSelf: 'flex-start',
    },
    /** v20: the قسيمة chip (info tint) + the رصيد chip (success tint). */
    voucherChip: {
      backgroundColor: c.infoSoft,
    },
    prepaidChip: {
      backgroundColor: c.successSoft,
    },
    /** v26: the pricing chip — جملة keeps the info tint, مفرق turns
     *  neutral so it never fights the status chips for attention. */
    wholesaleChip: {
      backgroundColor: c.infoSoft,
    },
    retailChip: {
      backgroundColor: c.surfaceHi,
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
    // v25 (round-32 #1): the compact return chip (icon + word) that
    // replaced the wide AppButton in the detail header.
    retChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      minHeight: 38,
      paddingHorizontal: spacing.md,
      borderRadius: radius.sm,
      backgroundColor: c.warningSoft,
      borderWidth: 1,
      borderColor: c.warning,
    },
    retChipText: {
      color: c.warning,
      fontFamily: fonts.bold,
      fontSize: typography.small,
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
