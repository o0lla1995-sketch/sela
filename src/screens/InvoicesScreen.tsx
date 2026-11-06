/**
 * screens/InvoicesScreen.tsx — v3.0: فواتيري بهوية نقطة البيع أندرويد.
 * ─────────────────────────────────────────────────────────────────
 * طلب التاجر: «حتى في صفحة الفواتير لا تشبه مطلقاً تطبيق نقطة البيع
 * في الفلترة والبحث عن فاتورة من خلال الباركود». هذه الشاشة منقولة
 * من InvoicesScreen بنقطة البيع:
 *
 * ① بحث حي متعدد الأبعاد (رقم الفاتورة / الزبون / الصنف) — بلا
 *    اتصال، من الأرشيف المحلي مباشرة.
 * ② زر مسح بجانب البحث — باركود الإيصال (CODE128) يحمل رقم
 *    الفاتورة: مسحة واحدة تجدها وتفتح تفاصيلها (محلياً، ومن
 *    الخادم إن كانت من جهاز آخر لحسابي).
 * ③ فلترة النوع (الكل/مبيعات/مرتجعات/ديون) + فلترة الزمن
 *    (اليوم/7 أيام/الكل) — نفس نمط نقطة البيع.
 * ④ نافذة الإرجاع والاستبدال بقواعد نقطة البيع نفسها:
 *    • الكميات المتبقية الحقيقية (من الخادم للفواتير المتزامنة،
 *      ومن الأرشيف محلياً) مطروح منها كل مرتجع محلي سابق — فلا
 *      يمكن الإرجاع من الفاتورة نفسها أكثر من المتاح مهما تكرر.
 *    • الاستبدال نافذة فوق نافذة الإرجاع: بحث بالاسم + مسح
 *      باركود + خيارات المنتج (متغير/وحدة/كمية) — لا شريط
 *      منتجات مقصوص.
 *    • صف القيمتين (المرتجع/المستبدل) + شريط الفرق الحي
 *      وتسويته + أزرار تأكيد — نفس دروس الجولات 45-48.
 */
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {
  ActivityIndicator,
  I18nManager,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  AppButton,
  Badge,
  EmptyState,
  Segmented,
  useToastStore,
} from '../ui';
import {Icon} from '../Icon';
import {
  fonts,
  formatMoney,
  formatQty,
  makeStyles,
  spacing,
  typography,
  useThemeColors,
} from '../theme';
import {CashierApi, localTimestamp, newClientRef} from '../api/client';
import {
  invoiceItems,
  listInvoices,
  mergeServerInvoices,
  recordLocalOp,
  returnedQtyForLine,
  type LocalInvoice,
  type LocalInvoiceItem,
} from '../store/offline';
import {
  linePrice,
  refreshPendingStockAdjustments,
  useCatalogStore,
  variantLabel as makeVariantLabel,
  variantPrice,
} from '../store/catalog';
import type {CatalogProduct, InvoiceDetail, InvoiceLine} from '../api/types';
import {usePayMethodsStore} from '../store/payMethods';
import {PaymentMethodLogo} from '../components/PaymentMethodLogo';
import {
  filterInvoices,
  type InvoiceFilterState,
  type Kind,
  type Period,
  type SyncStatus,
} from '../store/invoiceFilters';
import {useSessionStore} from '../store/session';
import {useAppSettings} from '../store/settings';
import {scanProductBarcode} from '../native';
import {kickSync, useSyncStore} from '../store/sync';

// v3.5 (الجولة 91 — كاشير #4): الفلترة انتقلت لمنطق خالص قابل
// للاختبار في store/invoiceFilters (النوع + الزمن + قناة الدفع +
// حالة المزامنة + البحث متعدد الأبعاد).

/** v3.4: تسمية طريقة الدفع من المخزن العالمي (تسميات الخادم)،
 *  مع خريطة ثابتة احتياطية لأشهر الجهات. */
const PM_LABEL_FALLBACK: Record<string, string> = {
  bank_palestine: 'بنك فلسطين',
  bank_quds: 'بنك القدس',
  bank_islami: 'البنك الإسلامي',
  jawwal_pay: 'جوال باي',
  palpay: 'بال باي',
  malchat: 'مال تشات',
};

function payMethodLabel(
  id: string,
  methods: {id: string; label: string}[],
): string {
  const hit = methods.find(m => m.id === id);
  if (hit != null) {
    return hit.label;
  }
  return PM_LABEL_FALLBACK[id] ?? id;
}

export function InvoicesScreen() {
  const c = useThemeColors();
  const styles = useStyles();
  const toast = useToastStore(s => s.show);
  const perms = useSessionStore(s => s.perms);
  const online = useSyncStore(s => s.online);

  const [period, setPeriod] = useState<Period>('today');
  const [kind, setKind] = useState<Kind>('all');
  /** v3.5 (الجولة 91 — كاشير #4): فلاتر جديدة — قناة الدفع
   *  (نقدي/بنك/محفظة المفعّلة عند التاجر) وحالة المزامنة
   *  (متزامنة/بانتظار/مرفوضة). */
  const [payFilter, setPayFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<SyncStatus>('all');
  const [search, setSearch] = useState('');
  const [invoices, setInvoices] = useState<LocalInvoice[] | null>(null);
  const [openRef, setOpenRef] = useState<string | null>(null);
  const [scanBusy, setScanBusy] = useState(false);

  const load = useCallback(async () => {
    setInvoices(await listInvoices(300));
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      void load();
    }, 5000);
    return () => clearInterval(timer);
  }, [load]);

  /** البحث متعدد الأبعاد: رقم/زبون/صنف — من الأرشيف المحلي. */
  const [itemsCache, setItemsCache] = useState<
    Record<string, LocalInvoiceItem[]>
  >({});
  useEffect(() => {
    void (async () => {
      const list = invoices ?? [];
      if (list.length === 0) {
        return;
      }
      const missing = list
        .filter(inv => itemsCache[inv.ref] == null)
        .slice(0, 40);
      if (missing.length === 0) {
        return;
      }
      const next: Record<string, LocalInvoiceItem[]> = {...itemsCache};
      for (const inv of missing) {
        next[inv.ref] = await invoiceItems(inv.ref);
      }
      setItemsCache(next);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoices]);

  const payMethods = usePayMethodsStore(state => state.methods);
  const filtered = useMemo(() => {
    if (!invoices) {
      return [];
    }
    // v3.5: المنطق الخالص في store/invoiceFilters — النوع والزمن
    // والقناة والحالة والبحث متعدد الأبعاد معاً.
    const filters: InvoiceFilterState = {
      period,
      kind,
      pay: payFilter,
      status: statusFilter,
      query: search,
    };
    return filterInvoices(invoices, filters, itemsCache);
  }, [invoices, itemsCache, kind, period, payFilter, search, statusFilter]);

  const openInvoice = filtered.find(inv => inv.ref === openRef) ?? null;

  /** مسح باركود الإيصال → فتح الفاتورة (محلياً ثم من الخادم). */
  const scanInvoice = useCallback(async () => {
    if (scanBusy) {
      return;
    }
    setScanBusy(true);
    try {
      const code = (await scanProductBarcode()).trim();
      if (code.length === 0) {
        return;
      }
      const all = await listInvoices(300);
      const hit = all.find(
        inv =>
          inv.displayNumber === code ||
          inv.syncedNumber === code ||
          inv.displayNumber.endsWith(code) ||
          (inv.syncedNumber ?? '').endsWith(code),
      );
      if (hit) {
        setKind('all');
        setPeriod('all');
        setSearch('');
        setPayFilter('all');
        setStatusFilter('all');
        setOpenRef(hit.ref);
        return;
      }
      if (online) {
        try {
          const payload = await CashierApi.invoiceByNumber(code);
          if (payload.invoice != null) {
            await mergeServerInvoices([payload.invoice]);
            await load();
            setKind('all');
            setPeriod('all');
            setSearch('');
            setPayFilter('all');
            setStatusFilter('all');
            const merged = await listInvoices(300);
            const localHit = merged.find(
              inv => inv.syncedNumber === payload.invoice!.number,
            );
            if (localHit) {
              setOpenRef(localHit.ref);
              return;
            }
          }
        } catch {
          // الخادم لم يجدها أيضاً.
        }
      }
      toast(
        `لا فاتورة بهذا الباركود (${code}) — الباركود يجب أن يكون من إيصال لحسابك`,
        'error',
      );
    } catch {
      // أُلغي المسح.
    } finally {
      setScanBusy(false);
    }
  }, [scanBusy, online, toast, load]);

  return (
    <View style={styles.screen}>
      {/* البحث + زر المسح (نفس صف نقطة البيع) */}
      <View style={styles.searchRow}>
        <Pressable
          style={[styles.scanBtn, scanBusy ? {opacity: 0.6} : null]}
          onPress={() => void scanInvoice()}
          disabled={scanBusy}>
          {scanBusy ? (
            <ActivityIndicator size="small" color={c.onAccent} />
          ) : (
            <Icon name="barcode" size={19} color={c.onAccent} />
          )}
        </Pressable>
        <View style={styles.searchBox}>
          <Icon name="search" size={15} color={c.textFaint} />
          <TextInput
            style={styles.searchInput}
            value={search}
            onChangeText={setSearch}
            placeholder="ابحث برقم الفاتورة أو الزبون أو الصنف…"
            placeholderTextColor={c.textFaint}
          />
          {search.length > 0 ? (
            <Pressable
              onPress={() => setSearch('')}
              hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
              <Icon name="x" size={14} color={c.textDim} />
            </Pressable>
          ) : null}
        </View>
      </View>

      {/* فلترة النوع — نمط نقطة البيع */}
      <View style={styles.kindRow}>
        {(
          [
            {key: 'all', label: 'الكل'},
            {key: 'sales', label: 'مبيعات'},
            {key: 'returns', label: 'مرتجعات'},
            {key: 'debts', label: 'ديون'},
          ] as {key: Kind; label: string}[]
        ).map(item => {
          const active = kind === item.key;
          return (
            <Pressable
              key={item.key}
              style={[
                styles.kindChip,
                active ? styles.kindChipActive : null,
              ]}
              onPress={() => setKind(item.key)}>
              <Text
                style={[
                  styles.kindText,
                  active ? {color: c.accent, fontFamily: fonts.bold} : null,
                ]}>
                {item.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* v3.5 (الجولة 91 — كاشير #4): فلتر قناة الدفع — رقائق
          ديناميكية من طرق الدفع المفعّلة عند التاجر (بنوك ومحافظ)
          + النقدي؛ يظهر فقط عند وجود أكثر من نقدي. */}
      {payMethods.length > 1 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.payFilterRow}
          contentContainerStyle={{gap: 6, paddingHorizontal: spacing.md}}>
          {[{id: 'all', label: 'كل القنوات', color: c.accent}, ...payMethods].map(
            method => {
              const active = payFilter === method.id;
              return (
                <Pressable
                  key={method.id}
                  style={[
                    styles.payChip,
                    active
                      ? {borderColor: c.accent, backgroundColor: c.accentSoft}
                      : null,
                  ]}
                  onPress={() => setPayFilter(method.id)}>
                  {method.id !== 'all' && method.id !== 'cash' ? (
                    <PaymentMethodLogo methodId={method.id} size={16} />
                  ) : method.id === 'cash' ? (
                    <View
                      style={[styles.payChipCash, {backgroundColor: method.color}]}>
                      <Text style={styles.payChipMark}>₪</Text>
                    </View>
                  ) : null}
                  <Text
                    style={[
                      styles.payChipText,
                      active ? {color: c.accent, fontFamily: fonts.bold} : null,
                    ]}
                    numberOfLines={1}>
                    {method.label}
                  </Text>
                </Pressable>
              );
            },
          )}
        </ScrollView>
      ) : null}

      {/* v3.5: فلتر حالة المزامنة — لإيجاد المعلقة والمرفوضة بسرعة. */}
      <View style={styles.kindRow}>
        {(
          [
            {key: 'all', label: 'كل الحالات'},
            {key: 'synced', label: 'متزامنة'},
            {key: 'pending', label: 'بانتظار المزامنة'},
            {key: 'rejected', label: 'مرفوضة'},
          ] as {key: SyncStatus; label: string}[]
        ).map(item => {
          const active = statusFilter === item.key;
          return (
            <Pressable
              key={item.key}
              style={[
                styles.kindChip,
                active ? styles.kindChipActive : null,
              ]}
              onPress={() => setStatusFilter(item.key)}>
              <Text
                style={[
                  styles.kindText,
                  active ? {color: c.accent, fontFamily: fonts.bold} : null,
                ]}>
                {item.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.padded}>
        <Segmented<Period>
          value={period}
          onChange={setPeriod}
          options={[
            {value: 'today', label: 'اليوم'},
            {value: 'week', label: '7 أيام'},
            {value: 'all', label: 'الكل'},
          ]}
        />
      </View>

      {invoices == null ? (
        <ActivityIndicator color={c.accent} style={{marginTop: 24}} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon="receipt"
          title={search.length > 0 ? 'لا نتائج' : 'لا فواتير في هذه الفترة'}
          subtitle={
            search.length > 0
              ? `لا فاتورة تطابق «${search}» — جرّب رقماً أقصر أو اسم الزبون`
              : 'كل فاتورة تُسجَّل على جهازك — حتى دون اتصال بنقطة البيع'
          }
        />
      ) : (
        <ScrollView
          contentContainerStyle={{
            padding: spacing.md,
            gap: 8,
            paddingBottom: 24,
          }}>
          {filtered.map(invoice => (
            <Pressable
              key={invoice.ref}
              style={styles.row}
              onPress={() => setOpenRef(invoice.ref)}>
              <View
                style={[
                  styles.kindChipIcon,
                  invoice.kind === 'return'
                    ? {backgroundColor: c.dangerSoft}
                    : invoice.payKind === 'debt'
                    ? {backgroundColor: c.infoSoft}
                    : invoice.payKind === 'exchange'
                    ? {backgroundColor: c.accentSoft}
                    : {backgroundColor: c.successSoft},
                ]}>
                <Icon
                  name={
                    invoice.kind === 'return'
                      ? 'undo'
                      : invoice.payKind === 'exchange'
                      ? 'swap'
                      : 'receipt'
                  }
                  size={16}
                  color={
                    invoice.kind === 'return'
                      ? c.danger
                      : invoice.payKind === 'debt'
                      ? c.info
                      : invoice.payKind === 'exchange'
                      ? c.accent
                      : c.success
                  }
                />
              </View>
              <View style={{flex: 1, minWidth: 0}}>
                <View
                  style={{flexDirection: 'row', alignItems: 'center', gap: 6}}>
                  <Text style={styles.number} numberOfLines={1}>
                    {invoice.displayNumber}
                  </Text>
                  {invoice.status === 'pending' ? (
                    <Badge label="بانتظار المزامنة" tone="warning" />
                  ) : invoice.status === 'rejected' ? (
                    <Badge label="مرفوضة" tone="danger" />
                  ) : null}
                </View>
                <Text style={styles.dim}>
                  {invoice.createdAt.slice(0, 16)}
                  {invoice.kind === 'sale' && invoice.payKind === 'debt'
                    ? ' · دين'
                    : ''}
                  {invoice.kind === 'return' &&
                  invoice.payKind === 'exchange'
                    ? ' · استبدال'
                    : invoice.kind === 'return'
                    ? ' · مرتجع'
                    : ''}
                  {invoice.kind === 'sale' &&
                  invoice.payKind === 'cash' &&
                  invoice.payMethod != null &&
                  invoice.payMethod !== 'cash'
                    ? ` · ${payMethodLabel(invoice.payMethod, payMethods)}`
                    : ''}
                  {invoice.customerName ? ` · ${invoice.customerName}` : ''}
                </Text>
              </View>
              <Text
                style={[
                  styles.total,
                  invoice.kind === 'return' ? {color: c.danger} : null,
                ]}>
                {formatMoney(invoice.total)}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      {openInvoice ? (
        <InvoiceDetailSheet
          invoice={openInvoice}
          online={online}
          canReturn={perms.canReturn}
          deviceId={useSessionStore.getState().deviceId}
          printReceipts={useAppSettings.getState().printReceipts}
          onClose={() => setOpenRef(null)}
          onChanged={() => {
            void load();
            void useCatalogStore.getState().refresh();
          }}
          onToast={toast}
        />
      ) : null}
    </View>
  );
}

/** صنف استبدال مختار (نفس نموذج نقطة البيع ExchangePick). */
interface ExchangePick {
  key: string;
  productId: number;
  name: string;
  quantity: number;
  unitId: number | null;
  unitName: string | null;
  variantId: number | null;
  variantLabel: string | null;
  unitPrice: number;
}

/**
 * v3.1 (الجولة 65) — سطر إرجاع موحّد: الصنف كما يعرفه هذا الجهاز
 * مرتبطاً بنظيره عند الخادم. بهذا تُحل ثلاث جذور منع الإرجاع:
 *  ① معرّف صنف الخادم يُرسل بدل المعرّف المحلي (كان الخادم يرفضه).
 *  ② فواتير أجهزة أخرى لنفس حسابي (بلا أصناف محلية) تُبنى أسطرها
 *     من لقطة الخادم مباشرة — فيصبح إرجاعها ممكناً.
 *  ③ المطابقة بالتوقيع الكامل (منتج + متغير + وحدة) لا برقم
 *     المنتج وحده.
 */
interface ReturnLine {
  key: string;
  /** معرّف الصنف في أرشيفي المحلي (null لفواتير الأجهزة الأخرى). */
  localId: number | null;
  /** معرّف صنف الخادم الحقيقي — يُرسل مع الإرجاع إن عُرف. */
  serverItemId: number | null;
  productId: number;
  name: string;
  variantLabel: string | null;
  unitName: string | null;
  quantity: number;
  unitPrice: number;
  /**
   * أساس المتبقي: لقطة الخادم الرسمية إن حُمّلت (تتضمن كل مرتجع
   * متزامن)، وإلا الكمية الأصلية المحلية.
   */
  baseRemaining: number;
}

/** تطبيع أسماء وحدة القاعدة (حبة/قطعة/فارغ = وحدة واحدة). */
function sameBaseUnit(a: string | null, b: string | null): boolean {
  const norm = (v: string | null) =>
    v == null || v === '' || v === 'حبة' || v === 'قطعة' ? '' : v;
  return norm(a) === norm(b);
}

/**
 * ربط سطر محلي بنظيره عند الخادم — بالتوقيع الكامل (منتج + متغير +
 * وحدة مطبَّعة)، مع منع استهلاك سطر خادم واحد لسطرين محليين.
 */
function matchServerLine(
  serverLines: InvoiceLine[],
  productId: number,
  variantLabel: string | null,
  unitName: string | null,
  taken: Set<number>,
): InvoiceLine | null {
  const candidates = serverLines.filter(
    line =>
      line.productId === productId &&
      (line.variantLabel ?? null) === variantLabel &&
      sameBaseUnit(line.unitName ?? null, unitName) &&
      !taken.has(line.saleItemId),
  );
  if (candidates.length === 0) {
    return null;
  }
  // الأعلى أولوية: سطر ما زال له متبقٍ؛ وإلا الأول.
  return candidates.find(line => line.remaining > 0.0001) ?? candidates[0];
}

/** تفاصيل فاتورة من الأرشيف المحلي + الإرجاع/الاستبدال. */
function InvoiceDetailSheet({
  invoice,
  online,
  canReturn,
  deviceId,
  printReceipts,
  onClose,
  onChanged,
  onToast,
}: {
  invoice: LocalInvoice;
  online: boolean;
  canReturn: boolean;
  deviceId: string;
  printReceipts: boolean;
  onClose: () => void;
  onChanged: () => void;
  onToast: (message: string, kind?: 'success' | 'error' | 'info') => void;
}) {
  const payMethods = usePayMethodsStore(state => state.methods);
  const c = useThemeColors();
  const styles = useDetailStyles();
  const [items, setItems] = useState<LocalInvoiceItem[]>([]);
  const [serverDetail, setServerDetail] = useState<InvoiceDetail | null>(null);
  const [returnOpen, setReturnOpen] = useState(false);
  const [_busy, _setBusy] = useState(false);

  const isSale = invoice.kind === 'sale';

  useEffect(() => {
    void invoiceItems(invoice.ref).then(setItems);
  }, [invoice.ref]);

  // v3.1: تفاصيل الخادم (المتبقي الرسمي + معرّفات أصنافه الحقيقية)
  // للفواتير المتزامنة — وبالبحث برقم الفاتورة مباشرة (invoiceByNumber)
  // بدل قصرها على آخر 100 فاتورة، فتشمل الفواتير الأقدم أيضاً.
  useEffect(() => {
    setServerDetail(null);
    if (invoice.status !== 'synced' || !online || invoice.syncedNumber == null) {
      return;
    }
    const syncedNumber = invoice.syncedNumber;
    void (async () => {
      try {
        let hitId: number | null = null;
        try {
          const byNumber = await CashierApi.invoiceByNumber(syncedNumber);
          if (byNumber.invoice != null) {
            hitId = byNumber.invoice.id;
          }
        } catch {
          // نجرب مسار القائمة كخطة بديلة.
        }
        if (hitId == null) {
          const list = await CashierApi.invoices(100, 0);
          hitId =
            (list.invoices ?? []).find(
              inv => inv.number === syncedNumber,
            )?.id ?? null;
        }
        if (hitId != null) {
          const detail = await CashierApi.invoice(hitId);
          setServerDetail(detail);
        }
      } catch {
        // الأرشيف المحلي يكفي للعرض؛ الإرجاع يحتاج الاتصال أو الطابور.
      }
    })();
  }, [invoice.ref, invoice.status, invoice.syncedNumber, online]);

  /**
   * v3.1 (الجولة 65) — الأسطر الموحّدة للعرض والإرجاع:
   *  • أصناف محلية مرتبطة بنظيرها عند الخادم (معرّفه + متبقيه).
   *  • فواتير الأجهزة الأخرى (بلا أصناف محلية): تُبنى أسطرها من
   *    لقطة الخادم مباشرة — فيصبح إرجاعها واستبدالها ممكناً.
   */
  const returnLines = useMemo<ReturnLine[]>(() => {
    const serverLines = serverDetail?.lines ?? [];
    const taken = new Set<number>();
    if (items.length === 0) {
      return serverLines.map(line => ({
        key: `srv-${line.saleItemId}`,
        localId: null,
        serverItemId: line.saleItemId,
        productId: line.productId,
        name: line.productName,
        variantLabel: line.variantLabel ?? null,
        unitName: line.unitName ?? null,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        baseRemaining: line.remaining,
      }));
    }
    return items.map(item => {
      const serverLine = matchServerLine(
        serverLines,
        item.productId,
        item.variantLabel,
        item.unitName,
        taken,
      );
      if (serverLine != null) {
        taken.add(serverLine.saleItemId);
      }
      return {
        key: `loc-${item.id}`,
        localId: item.id,
        serverItemId: serverLine?.saleItemId ?? null,
        productId: item.productId,
        name: item.name,
        variantLabel: item.variantLabel,
        unitName: item.unitName,
        quantity: item.quantity,
        unitPrice: serverLine?.unitPrice ?? item.unitPrice,
        baseRemaining: serverLine ? serverLine.remaining : item.quantity,
      };
    });
  }, [items, serverDetail]);

  return (
    <View style={styles.overlay} pointerEvents="box-none">
      <Pressable style={styles.dim} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.headerRow}>
          <View style={styles.headIcon}>
            <Icon name="receipt" size={19} color={c.accent} />
          </View>
          <View style={{flex: 1, minWidth: 0}}>
            <Text style={styles.title} numberOfLines={1}>
              فاتورة {invoice.displayNumber}
            </Text>
            <Text style={styles.sub} numberOfLines={1}>
              {invoice.createdAt.slice(0, 16)}
              {invoice.customerName ? ` · ${invoice.customerName}` : ''}
            </Text>
          </View>
          <Pressable style={styles.closeBtn} onPress={onClose} hitSlop={8}>
            <Icon name="x" size={15} color={c.textDim} />
          </Pressable>
        </View>

        <View style={styles.metaRow}>
          <Badge
            label={
              invoice.kind === 'return'
                ? invoice.payKind === 'exchange'
                  ? 'استبدال'
                  : 'مرتجع'
                : invoice.payKind === 'debt'
                ? 'بيع بالدين'
                : 'بيع نقدي'
            }
            tone={
              invoice.kind === 'return'
                ? 'danger'
                : invoice.payKind === 'debt'
                ? 'info'
                : 'success'
            }
          />
          {/* v3.4 (الجولة 77 — كاشير #3): شارة طريقة الدفع الفعلية —
              بنك أو محفظة مفعّلة بشعارها الرسمي، فتطابق الفاتورة
              نقطة البيع ولا يبدو كل شيء «نقدي». */}
          {invoice.kind === 'sale' &&
            invoice.payKind === 'cash' &&
            invoice.payMethod != null &&
            invoice.payMethod !== 'cash' && (
              <View style={styles.pmBadge}>
                <PaymentMethodLogo
                  methodId={invoice.payMethod}
                  label={payMethodLabel(invoice.payMethod, payMethods)}
                  size={17}
                />
                <Text style={styles.pmBadgeText} numberOfLines={1}>
                  {payMethodLabel(invoice.payMethod, payMethods)}
                </Text>
              </View>
            )}
          {invoice.status === 'pending' ? (
            <Badge label="بانتظار المزامنة" tone="warning" />
          ) : null}
          {invoice.status === 'rejected' ? (
            <Badge label="مرفوضة" tone="danger" />
          ) : null}
        </View>

        {invoice.status === 'rejected' && invoice.rejectReason ? (
          <View style={styles.rejectBox}>
            <Icon name="alert" size={16} color={c.danger} />
            <Text style={styles.rejectText}>{invoice.rejectReason}</Text>
          </View>
        ) : null}

        <ScrollView
          style={{flexGrow: 0, maxHeight: 300}}
          contentContainerStyle={{gap: 6}}
          showsVerticalScrollIndicator={false}>
          {returnLines.length === 0 ? (
            items.length === 0 ? (
              <Text style={styles.dimText}>
                {online && invoice.status === 'synced'
                  ? 'يجلب تفاصيل الأصناف من نقطة البيع…'
                  : 'فاتورة من جهاز آخر — تفاصيل أصنافها عند عودة الاتصال بنقطة البيع.'}
              </Text>
            ) : null
          ) : (
            returnLines.map(line => (
              <View key={line.key} style={styles.itemRow}>
                <View style={{flex: 1, minWidth: 0}}>
                  <Text style={styles.itemName} numberOfLines={2}>
                    {line.name}
                    {line.variantLabel ? ` (${line.variantLabel})` : ''}
                    {line.unitName &&
                    line.unitName !== 'حبة' &&
                    line.unitName !== 'قطعة'
                      ? ` (${line.unitName})`
                      : ''}
                  </Text>
                  <Text style={styles.dimText}>
                    {formatQty(line.quantity)} × {formatMoney(line.unitPrice)} ={' '}
                    {formatMoney(line.unitPrice * line.quantity)}
                  </Text>
                  {isSale ? (
                    <Text style={styles.remainingText}>
                      قابل للإرجاع: {formatQty(line.baseRemaining)}
                    </Text>
                  ) : null}
                </View>
              </View>
            ))
          )}
        </ScrollView>

        <View style={styles.totalsRow}>
          <Text style={styles.dimText}>
            الخصم {formatMoney(invoice.discount)} · الإجمالي
          </Text>
          <Text style={styles.totalText}>{formatMoney(invoice.total)}</Text>
        </View>

        {isSale && canReturn && returnLines.length > 0 ? (
          <AppButton
            title="إرجاع / استبدال أصناف"
            icon="undo"
            variant="secondary"
            onPress={() => setReturnOpen(true)}
          />
        ) : null}
      </View>

      {returnOpen ? (
        <ReturnSheet
          invoice={invoice}
          lines={returnLines}
          hasServerSnapshot={serverDetail != null}
          online={online}
          deviceId={deviceId}
          printReceipts={printReceipts}
          onClose={() => setReturnOpen(false)}
          onChanged={onChanged}
          onToast={onToast}
        />
      ) : null}
    </View>
  );
}

/**
 * نافذة الإرجاع/الاستبدال — نفس بنية نقطة البيع (الجولات 45-48):
 * اختيار كميات المرتجع بمحددات الخطوة + «الكل» فوق المتبقي الحقيقي،
 * الاستبدال نافذة طبقة أعلى بقيم حية وفرق يُسوّى، وزر تأكيد دائم
 * الثبات أسفل الشاشة.
 *
 * v3.1 (الجولة 65): الأسطر الموحّدة ReturnLine — معرّف صنف الخادم
 * الحقيقي يُرسل عند معرفته، ومعه توقيع الصنف (منتج + متغير + وحدة)
 * ليحلّه الخادم عند غيابه (فواتير معلّقة أو من جهاز آخر) — كان
 * المعرّف المحلي يُرسل فيرفض الخادم الإرجاع دائماً تقريباً.
 */
function ReturnSheet({
  invoice,
  lines,
  hasServerSnapshot,
  online,
  deviceId,
  printReceipts,
  onClose,
  onChanged,
  onToast,
}: {
  invoice: LocalInvoice;
  lines: ReturnLine[];
  /** لقطة الخادم محمّلة؟ إذاً متبقيها يشمل المرتجعات المتزامنة —
   *  لا نخصم منها سوى المرتجعات المحلية غير المرفوعة بعد. */
  hasServerSnapshot: boolean;
  online: boolean;
  deviceId: string;
  printReceipts: boolean;
  onClose: () => void;
  onChanged: () => void;
  onToast: (message: string, kind?: 'success' | 'error' | 'info') => void;
}) {
  const c = useThemeColors();
  const styles = useReturnStyles();
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [exchangePicks, setExchangePicks] = useState<ExchangePick[]>([]);
  const [exchangeOpen, setExchangeOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // المرتجعات المحلية السابقة من هذه الفاتورة بالذات (source_ref):
  // مع لقطة الخادم نعدّ المعلّقة فقط (المتزامنة محسوبة داخل اللقطة)،
  // وبلا لقطة نعدّها كلها فوق الكمية الأصلية المحلية.
  const [localReturned, setLocalReturned] = useState<Record<string, number>>({});
  useEffect(() => {
    void (async () => {
      const out: Record<string, number> = {};
      for (const line of lines) {
        out[line.key] = await returnedQtyForLine(
          invoice.ref,
          line.productId,
          line.variantLabel,
          line.unitName,
          hasServerSnapshot,
        );
      }
      setLocalReturned(out);
    })();
  }, [invoice.ref, lines, hasServerSnapshot]);

  const remainingFor = useCallback(
    (line: ReturnLine): number => {
      return Math.max(0, line.baseRemaining - (localReturned[line.key] ?? 0));
    },
    [localReturned],
  );

  const setQty = useCallback(
    (line: ReturnLine, qty: number) => {
      const remaining = remainingFor(line);
      const clamped = Math.min(Math.max(qty, 0), remaining);
      setQuantities(prev => ({...prev, [line.key]: clamped}));
    },
    [remainingFor],
  );

  const refundTotal = lines.reduce((sum, line) => {
    const qty = quantities[line.key] ?? 0;
    return sum + line.unitPrice * qty;
  }, 0);
  const pickedCount = lines.filter(
    line => (quantities[line.key] ?? 0) > 0,
  ).length;
  const exchangeTotal = exchangePicks.reduce(
    (sum, pick) => sum + pick.unitPrice * pick.quantity,
    0,
  );
  const exchangeModeOn = exchangePicks.length > 0;
  const exchangeDiff = refundTotal - exchangeTotal;

  const confirm = useCallback(async () => {
    if (busy || refundTotal <= 0) {
      return;
    }
    if (exchangeModeOn && exchangeTotal <= 0) {
      onToast('قيمة الاستبدال غير صالحة — راجع الأصناف البديلة', 'error');
      return;
    }
    setBusy(true);
    const createdAt = localTimestamp();
    const clientRef = newClientRef(deviceId || 'dev');
    // v3.1: أسطر موحّدة — معرّف صنف الخادم عند معرفته (وإلا 0)
    // + توقيع الصنف كاملاً ليحلّه الخادم بمطابقة دقيقة.
    const selected = lines
      .filter(line => (quantities[line.key] ?? 0) > 0)
      .map(line => ({
        saleItemId: line.serverItemId ?? 0,
        productId: line.productId,
        variantLabel: line.variantLabel,
        unitName: line.unitName,
        quantity: quantities[line.key] ?? 0,
      }));
    const exchangeLines = exchangeModeOn
      ? exchangePicks.map(pick => ({
          productId: pick.productId,
          unitId: pick.unitId,
          variantId: pick.variantId,
          // v3.5 (الجولة 91 — كاشير #3): التسمية والاسم مع أسطر
          // الاستبدال أيضاً — يشفي بها الخادم الربط إن استُبدلت
          // المعرّفات بتحرير المنتج.
          variantLabel: pick.variantLabel,
          unitName: pick.unitName,
          quantity: pick.quantity,
        }))
      : undefined;

    // قيمة العرض المحلية — الخادم يحسم بالأسعار الرسمية.
    const net = exchangeModeOn ? exchangeTotal - refundTotal : -refundTotal;

    // v3.1: معرّف فاتورة الخادم من مرجع سحب الأجهزة الأخرى (srv-N).
    const srvRefId = invoice.ref.startsWith('srv-')
      ? Number(invoice.ref.slice(4)) || 0
      : 0;

    // ① مباشرة (فاتورة متزامنة + اتصال).
    if (invoice.status === 'synced' && online) {
      try {
        // البحث برقم الفاتورة مباشرة أولاً (يشمل الأقدم من آخر 100)،
        // ثم مسار القائمة كخطة بديلة.
        let saleId = srvRefId;
        if (saleId === 0 && invoice.syncedNumber != null) {
          try {
            const byNumber = await CashierApi.invoiceByNumber(
              invoice.syncedNumber,
            );
            if (byNumber.invoice != null) {
              saleId = byNumber.invoice.id;
            }
          } catch {
            // نجرب مسار القائمة.
          }
        }
        if (saleId === 0) {
          const list = await CashierApi.invoices(100, 0);
          const hit = (list.invoices ?? []).find(
            inv => inv.number === invoice.syncedNumber,
          );
          if (!hit) {
            throw new Error('لم تُعثر الفاتورة عند الخادم');
          }
          saleId = hit.id;
        }
        const payload = await CashierApi.return({
          saleId,
          lines: selected.map(s => ({
            saleItemId: s.saleItemId,
            productId: s.productId,
            variantLabel: s.variantLabel,
            unitName: s.unitName,
            quantity: s.quantity,
          })),
          exchange: exchangeLines,
          refundMethod: exchangeModeOn ? 'none' : 'cash',
          clientRef,
          createdAt,
          print: printReceipts,
        });
        onToast(
          exchangeModeOn
            ? exchangeDiff > 0.0001
              ? `سُجّل الاستبدال — سلّم الزبون الفرق ${formatMoney(exchangeDiff)} نقداً من الخزينة`
              : exchangeDiff < -0.0001
              ? `سُجّل الاستبدال — قبض الفرق ${formatMoney(-exchangeDiff)} نقداً من الزبون`
              : 'سُجّل الاستبدال المتكافئ — لا فرق'
            : 'سُجِّل المرتجع في نقطة البيع',
          'success',
        );
        if (payload.printed) {
          onToast('طُبع إيصال المرتجع من طابعة نقطة البيع', 'info');
        }
        onChanged();
        onClose();
        return;
      } catch (error) {
        onToast(
          error instanceof Error ? error.message : 'فشل تسجيل المرتجع',
          'error',
        );
        return;
      } finally {
        setBusy(false);
      }
    }

    // ② الطابور المحلي — يعمل حتى دون اتصال.
    try {
      await recordLocalOp({
        ref: clientRef,
        kind: 'return',
        displayNumber: `م-ر-${invoice.displayNumber}`,
        payKind: exchangeModeOn ? 'exchange' : 'refund',
        total: net,
        discount: 0,
        customerName: null,
        createdAt,
        // v3.1: ربط المرتجع بفاتورته المصدر — به تُحسب المتبقي
        // المحلي بدقة (كانت تعدّ مرتجعات فواتير أخرى بنفس المنتج).
        sourceRef: invoice.ref,
        lines: selected.map(s => {
          const item = lines.find(
            l =>
              l.productId === s.productId &&
              (l.variantLabel ?? null) === (s.variantLabel ?? null) &&
              (l.unitName ?? null) === (s.unitName ?? null),
          );
          // v3.2: حل معامل التحويل ومعرّف المتغير من الكتالوج
          // المحلي — لتسوية المخزون المعلّق للمرتجع بدقة (الخادم
          // يفصلها نهائياً من فاتورة المصدر عند المزامنة).
          const catalogProduct = useCatalogStore
            .getState()
            .products.find(p => p.id === s.productId);
          const catalogVariant =
            s.variantLabel != null && catalogProduct != null
              ? catalogProduct.variants.find(
                  v =>
                    `${v.color} · ${v.size}` === s.variantLabel ||
                    v.size === s.variantLabel,
                )
              : undefined;
          const conversion =
            catalogProduct != null && s.unitName != null
              ? catalogProduct.units.find(u => u.name === s.unitName)
                  ?.conversion ?? 1
              : 1;
          return {
            productId: s.productId,
            name: item?.name ?? `#${s.productId}`,
            variantId: catalogVariant?.id ?? null,
            variantLabel: item?.variantLabel ?? null,
            unitId: null,
            unitName: item?.unitName ?? null,
            quantity: s.quantity,
            unitPrice: item?.unitPrice ?? 0,
            lineTotal: (item?.unitPrice ?? 0) * s.quantity,
            conversion,
          };
        }),
        payload: {
          // فواتير الأجهزة الأخرى (srv-N): معرّف الخادم معروف من
          // المرجع نفسه؛ فواتيرنا: يفهمها الخادم عبر saleClientRef.
          ...(srvRefId > 0 ? {saleId: srvRefId} : {saleClientRef: invoice.ref}),
          lines: selected.map(s => ({
            saleItemId: s.saleItemId,
            productId: s.productId,
            variantLabel: s.variantLabel,
            unitName: s.unitName,
            quantity: s.quantity,
          })),
          exchange: exchangeLines,
          refundMethod: exchangeModeOn ? 'none' : 'cash',
          clientRef,
          createdAt,
        },
      });
      onToast(
        exchangeModeOn
          ? 'سُجِّل الاستبدال محلياً — يُزامَن فور عودة الاتصال'
          : 'سُجِّل المرتجع محلياً — يُزامَن فور عودة الاتصال',
        'success',
      );
      // v3.2: المرتجع يعيد المخزون محلياً فوق آخر مزامنة فوراً.
      void refreshPendingStockAdjustments();
      kickSync();
      onChanged();
      onClose();
    } catch (error) {
      onToast(
        error instanceof Error ? error.message : 'تعذر تسجيل المرتجع',
        'error',
      );
    } finally {
      setBusy(false);
    }
  }, [
    busy,
    deviceId,
    exchangeDiff,
    exchangeModeOn,
    exchangePicks,
    exchangeTotal,
    invoice.displayNumber,
    invoice.ref,
    invoice.status,
    invoice.syncedNumber,
    lines,
    onChanged,
    onClose,
    onToast,
    online,
    printReceipts,
    quantities,
    refundTotal,
  ]);

  const stepFor = (remaining: number) =>
    Number.isInteger(remaining) ? 1 : 0.5;

  return (
    <View style={styles.overlayLayer} pointerEvents="box-none">
      <Pressable style={styles.dim} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.headerRow}>
          <View style={styles.headIcon}>
            <Icon name="undo" size={20} color={c.warning} />
          </View>
          <View style={{flex: 1, minWidth: 0}}>
            <Text style={styles.title}>إرجاع أصناف للفاتورة</Text>
            <Text style={styles.sub}>
              اختر الكميات المُرجعة — تُستعاد للمخزون فوراً
            </Text>
          </View>
          <Pressable style={styles.closeBtn} onPress={onClose} hitSlop={8}>
            <Icon name="x" size={15} color={c.textDim} />
          </Pressable>
        </View>

        <ScrollView
          style={{flex: 1}}
          contentContainerStyle={{gap: 8, paddingBottom: 8}}
          showsVerticalScrollIndicator={false}>
          {lines.map(line => {
            const qty = quantities[line.key] ?? 0;
            const remaining = remainingFor(line);
            const step = stepFor(remaining);
            const fully = remaining <= 0;
            return (
              <View
                key={line.key}
                style={[styles.lineCard, fully ? {opacity: 0.5} : null]}>
                <View style={{flex: 1, minWidth: 0}}>
                  <Text style={styles.lineName} numberOfLines={2}>
                    {line.name}
                    {line.variantLabel ? ` (${line.variantLabel})` : ''}
                    {line.unitName &&
                    line.unitName !== 'حبة' &&
                    line.unitName !== 'قطعة'
                      ? ` (${line.unitName})`
                      : ''}
                  </Text>
                  <Text style={styles.lineMeta}>
                    {fully
                      ? 'أُرجع كاملاً — لا متبقٍ'
                      : `المتبقي قابل للإرجاع: ${formatQty(remaining)} · ${formatMoney(line.unitPrice)} للوحدة`}
                  </Text>
                  {qty > 0 ? (
                    <Text style={[styles.lineMeta, {color: c.warning}]}>
                      قيمة الإرجاع: {formatMoney(line.unitPrice * qty)}
                    </Text>
                  ) : null}
                </View>
                <View style={styles.stepper}>
                  <Pressable
                    style={styles.stepBtn}
                    hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
                    onPress={() => setQty(line, qty - step)}
                    disabled={busy || qty <= 0 || fully}>
                    <Icon name="minus" size={13} color={c.text} />
                  </Pressable>
                  <Text style={styles.stepValue}>{formatQty(qty)}</Text>
                  <Pressable
                    style={styles.stepBtn}
                    hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
                    onPress={() => setQty(line, qty + step)}
                    disabled={busy || qty >= remaining || fully}>
                    <Icon name="plus" size={13} color={c.text} />
                  </Pressable>
                  <Pressable
                    style={styles.allBtn}
                    hitSlop={{top: 6, bottom: 6, left: 6, right: 6}}
                    onPress={() => setQty(line, remaining)}
                    disabled={busy || qty >= remaining || fully}>
                    <Text style={styles.allBtnText}>الكل</Text>
                  </Pressable>
                </View>
              </View>
            );
          })}

          {/* قائمة أصناف الاستبدال البديلة — داخل التمرير (نفس نقطة البيع). */}
          {exchangeModeOn ? (
            <View style={styles.exchangeSection}>
              <Text style={styles.exchangeSectionTitle}>
                أصناف الاستبدال البديلة ({exchangePicks.length}) — بقيمة{' '}
                {formatMoney(exchangeTotal)}
              </Text>
              {exchangePicks.map(pick => (
                <View key={pick.key} style={styles.exchangeRow}>
                  <View style={{flex: 1, minWidth: 0}}>
                    <Text style={styles.exchangeRowName} numberOfLines={1}>
                      {pick.name}
                      {pick.variantLabel ? ` (${pick.variantLabel})` : ''}
                      {pick.unitName && pick.unitName !== 'حبة'
                        ? ` · ${pick.unitName}`
                        : ''}
                    </Text>
                    <Text style={styles.exchangeRowMeta}>
                      {formatQty(pick.quantity)} × {formatMoney(pick.unitPrice)} ={' '}
                      {formatMoney(pick.unitPrice * pick.quantity)}
                    </Text>
                  </View>
                  <Pressable
                    style={styles.exchangeRemove}
                    onPress={() =>
                      setExchangePicks(prev =>
                        prev.filter(x => x.key !== pick.key),
                      )
                    }
                    disabled={busy}>
                    <Icon name="x" size={13} color={c.danger} />
                  </Pressable>
                </View>
              ))}
              <Pressable
                style={styles.exchangeClear}
                onPress={() => setExchangePicks([])}
                disabled={busy}>
                <Text style={styles.exchangeClearText}>
                  إلغاء الاستبدال — العودة للإرجاع المالي
                </Text>
              </Pressable>
            </View>
          ) : null}
        </ScrollView>

        {/* التذييل المحدود الارتفاع — زر التأكيد دائم الظهور. */}
        <View style={styles.summaryBox}>
          {exchangeModeOn ? (
            <View style={styles.valuesPairRow}>
              <View style={styles.valueHalf}>
                <Text style={styles.valueHalfLabel}>
                  المرتجع ({pickedCount} صنف)
                </Text>
                <Text style={styles.valueHalfAmount}>
                  {formatMoney(refundTotal)}
                </Text>
              </View>
              <View style={[styles.valueHalf, styles.valueHalfAccent]}>
                <Text style={[styles.valueHalfLabel, {color: c.accent}]}>
                  المستبدل ({exchangePicks.length} صنف)
                </Text>
                <Text style={[styles.valueHalfAmount, {color: c.accent}]}>
                  {formatMoney(exchangeTotal)}
                </Text>
              </View>
            </View>
          ) : (
            <View style={styles.valuesPairRow}>
              <View style={styles.valueHalf}>
                <Text style={styles.valueHalfLabel}>
                  إجمالي قيمة المرتجع ({pickedCount} صنف)
                </Text>
                <Text style={styles.valueHalfAmount}>
                  {formatMoney(refundTotal)}
                </Text>
              </View>
            </View>
          )}

          {exchangeModeOn ? (
            <View
              style={[
                styles.diffStrip,
                exchangeDiff > 0.0001
                  ? {borderColor: c.warning}
                  : exchangeDiff < -0.0001
                  ? {borderColor: c.success}
                  : null,
              ]}>
              <Text
                style={[
                  styles.diffText,
                  exchangeDiff < -0.0001
                    ? {color: c.success}
                    : exchangeDiff > 0.0001
                    ? {color: c.warning}
                    : null,
                ]}>
                {Math.abs(exchangeDiff) < 0.0001
                  ? 'استبدال متكافئ — لا فرق'
                  : exchangeDiff > 0
                  ? `الفرق ${formatMoney(exchangeDiff)} — سلّمه نقداً من الخزينة`
                  : `الفرق ${formatMoney(-exchangeDiff)} — اقبضه نقداً من الزبون`}
              </Text>
            </View>
          ) : null}

          <View style={styles.actionsRow}>
            {lines.length > 0 ? (
              <Pressable
                style={[
                  styles.exchangeCompactBtn,
                  exchangeModeOn
                    ? {borderColor: c.accent, backgroundColor: c.accentSoft}
                    : null,
                ]}
                onPress={() => {
                  if (pickedCount === 0) {
                    onToast(
                      'اختر كميات المرتجع أولاً — الاستبدال يقابل قيمة ما تُرجعه',
                      'info',
                    );
                  }
                  setExchangeOpen(true);
                }}
                disabled={busy}>
                <Icon
                  name="swap"
                  size={15}
                  color={exchangeModeOn ? c.accent : c.textDim}
                />
                <Text
                  style={[
                    styles.exchangeCompactText,
                    exchangeModeOn ? {color: c.accent} : null,
                  ]}
                  numberOfLines={1}>
                  {exchangeModeOn
                    ? `الاستبدال (${exchangePicks.length})`
                    : 'استبدال'}
                </Text>
              </Pressable>
            ) : null}
            <AppButton
              title={exchangeModeOn ? 'تأكيد الاستبدال' : 'تأكيد الإرجاع'}
              icon={exchangeModeOn ? 'swap' : 'undo'}
              onPress={() => void confirm()}
              loading={busy}
              disabled={busy || refundTotal <= 0 || pickedCount === 0}
              style={{flex: 1.6}}
            />
          </View>

          {invoice.status === 'pending' ? (
            <Text style={styles.hintText}>
              الفاتورة الأصلية بانتظار المزامنة — المرتجع سيُحل عنها تلقائياً
              بعد مزامنتها (طابورك بالتسلسل).
            </Text>
          ) : !online ? (
            <Text style={styles.hintText}>
              لا اتصال الآن — يُسجَّل المرتجع محلياً ويُزامَن تلقائياً.
            </Text>
          ) : null}
        </View>
      </View>

      {/* نافذة الاستبدال — طبقة فوق نافذة الإرجاع (نفس نقطة البيع). */}
      {exchangeOpen ? (
        <ExchangeSheet
          refundTotal={refundTotal}
          picks={exchangePicks}
          onAdd={pick =>
            setExchangePicks(prev => {
              const existing = prev.find(x => x.key === pick.key);
              if (existing != null) {
                return prev.map(x => (x.key === pick.key ? {...x, ...pick} : x));
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

/**
 * نافذة الاستبدال — بحث بالاسم + مسح باركود → اختيار منتج → خياراته
 * (الكمية، الوحدة، المتغير) → «أضف إلى الاستبدال» (نفس نقطة البيع).
 */
function ExchangeSheet({
  refundTotal,
  picks,
  onAdd,
  onRemove: _onRemove,
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
  const styles = useExchangeStyles();
  const products = useCatalogStore(s => s.products);
  const toast = useToastStore(s => s.show);
  const [search, setSearch] = useState('');
  const [openProduct, setOpenProduct] = useState<CatalogProduct | null>(null);
  const [openVariantId, setOpenVariantId] = useState<number | null>(null);
  const [openUnitId, setOpenUnitId] = useState<number | null>(null);
  const [openQty, setOpenQty] = useState(1);
  const [scanBusy, setScanBusy] = useState(false);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (query.length === 0) {
      return products.slice(0, 30);
    }
    return products
      .filter(
        product =>
          product.name.toLowerCase().includes(query) ||
          (product.barcode ?? '').includes(query) ||
          product.units.some(u => (u.barcode ?? '').includes(query)),
      )
      .slice(0, 30);
  }, [products, search]);

  const scanExchange = useCallback(async () => {
    if (scanBusy) {
      return;
    }
    setScanBusy(true);
    try {
      const code = (await scanProductBarcode()).trim();
      if (code.length === 0) {
        return;
      }
      const hit = products.find(
        p => p.barcode === code || p.units.some(u => u.barcode === code),
      );
      if (hit == null) {
        toast(`لا منتج بهذا الباركود (${code}) — ابحث بالاسم`, 'error');
        return;
      }
      setSearch('');
      setOpenProduct(hit);
      setOpenVariantId(null);
      setOpenUnitId(null);
      setOpenQty(1);
    } catch {
      // أُلغي المسح.
    } finally {
      setScanBusy(false);
    }
  }, [products, scanBusy, toast]);

  useEffect(() => {
    if (openProduct == null) {
      return;
    }
    setOpenVariantId(null);
    setOpenUnitId(null);
    setOpenQty(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openProduct?.id]);

  const sizeVariants =
    openProduct?.variants.filter(v => v.kind === 'size') ?? [];
  const clothingVariants =
    openProduct?.variants.filter(v => v.kind === 'variant') ?? [];
  const chosenVariant =
    openVariantId != null
      ? openProduct?.variants.find(v => v.id === openVariantId) ?? null
      : null;
  const chosenUnit = openProduct?.units.find(u => u.id === openUnitId) ?? null;
  const unitPrice =
    openProduct == null
      ? 0
      : chosenVariant
      ? variantPrice(openProduct, chosenVariant)
      : linePrice(openProduct, openUnitId);

  const addOpenPick = () => {
    if (openProduct == null || openQty <= 0) {
      return;
    }
    onAdd({
      key: `${openProduct.id}-u${openUnitId ?? ''}-v${openVariantId ?? ''}`,
      productId: openProduct.id,
      name: openProduct.name,
      quantity: openQty,
      unitId: openUnitId,
      unitName: chosenUnit ? chosenUnit.name : null,
      variantId: openVariantId,
      variantLabel: chosenVariant ? makeVariantLabel(chosenVariant) : null,
      unitPrice,
    });
    setOpenProduct(null);
  };

  return (
    <View style={styles.overlayTop} pointerEvents="box-none">
      <Pressable style={styles.dim} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.headerRow}>
          <View style={styles.headIcon}>
            <Icon name="swap" size={20} color={c.accent} />
          </View>
          <View style={{flex: 1, minWidth: 0}}>
            <Text style={styles.title}>الاستبدال بقيمة المرتجع</Text>
            <Text style={styles.sub} numberOfLines={1}>
              قيمة المرتجع {formatMoney(refundTotal)} — اختر البدائل والفرق
              يُسوّى عند التأكيد
            </Text>
          </View>
          <Pressable style={styles.closeBtn} onPress={onClose} hitSlop={8}>
            <Icon name="x" size={15} color={c.textDim} />
          </Pressable>
        </View>

        {openProduct == null ? (
          <>
            <View style={styles.searchRow}>
              <Pressable
                style={[styles.scanBtn, scanBusy ? {opacity: 0.6} : null]}
                onPress={() => void scanExchange()}
                disabled={scanBusy}>
                <Icon name="barcode" size={18} color={c.onAccent} />
              </Pressable>
              <View style={styles.searchBox}>
                <Icon name="search" size={14} color={c.textFaint} />
                <TextInput
                  style={styles.searchInput}
                  value={search}
                  onChangeText={setSearch}
                  placeholder="ابحث بالاسم أو امسح الباركود…"
                  placeholderTextColor={c.textFaint}
                />
                {search.length > 0 ? (
                  <Pressable
                    onPress={() => setSearch('')}
                    hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                    <Icon name="x" size={13} color={c.textDim} />
                  </Pressable>
                ) : null}
              </View>
            </View>

            <ScrollView
              style={{flex: 1}}
              contentContainerStyle={{gap: 6, paddingBottom: 8}}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled">
              {filtered.map(product => {
                const price = product.hasVariants
                  ? formatMoney(
                      Math.min(
                        ...product.variants.map(v => variantPrice(product, v)),
                      ),
                    )
                  : formatMoney(linePrice(product, null));
                return (
                  <Pressable
                    key={product.id}
                    style={styles.productRow}
                    onPress={() => setOpenProduct(product)}>
                    <View style={{flex: 1, minWidth: 0}}>
                      <Text style={styles.productName} numberOfLines={1}>
                        {product.name}
                        {product.hasVariants
                          ? product.variants[0]?.kind === 'size'
                            ? ` · ${product.variants.length} أحجام`
                            : ' · متغيرات'
                          : ''}
                      </Text>
                      <Text style={styles.productMeta}>
                        {price}
                        {product.hasVariants ? '+' : ''}
                        {product.byWeight ? '/كغ' : ''}
                        {product.units.length > 0
                          ? ` · ${product.units.map(u => u.short).join(' · ')}`
                          : ''}
                      </Text>
                    </View>
                    <Icon name="plus" size={15} color={c.accent} />
                  </Pressable>
                );
              })}
              {filtered.length === 0 ? (
                <Text style={styles.emptyText}>
                  لا منتج يطابق «{search}»
                </Text>
              ) : null}
            </ScrollView>

            {picks.length > 0 ? (
              <Pressable style={styles.clearRow} onPress={onClear}>
                <Text style={styles.clearText}>
                  إلغاء الاستبدال كاملاً ({picks.length})
                </Text>
              </Pressable>
            ) : null}
          </>
        ) : (
          <>
            <ScrollView
              style={{flex: 1}}
              contentContainerStyle={{gap: 12, paddingBottom: 8}}
              showsVerticalScrollIndicator={false}>
              <View style={styles.openHead}>
                <View style={{flex: 1, minWidth: 0}}>
                  <Text style={styles.productName} numberOfLines={1}>
                    {openProduct.name}
                  </Text>
                  <Text style={styles.productMeta}>
                    {chosenVariant
                      ? makeVariantLabel(chosenVariant)
                      : chosenUnit
                      ? chosenUnit.name
                      : openProduct.byWeight
                      ? 'وزن (كغ)'
                      : 'حبة'}{' '}
                    · {formatMoney(unitPrice)}
                  </Text>
                </View>
                <Pressable
                  style={styles.closeBtn}
                  onPress={() => setOpenProduct(null)}
                  hitSlop={8}>
                  <Icon name="x" size={15} color={c.textDim} />
                </Pressable>
              </View>

              {/* أحجام المطعم */}
              {sizeVariants.length > 0 ? (
                <View style={styles.group}>
                  <Text style={styles.groupTitle}>الحجم</Text>
                  <View style={styles.chipRow}>
                    {sizeVariants.map(v => (
                      <Pressable
                        key={v.id}
                        style={[
                          styles.chip,
                          openVariantId === v.id ? styles.chipActive : null,
                        ]}
                        onPress={() => setOpenVariantId(v.id)}>
                        <Text
                          style={[
                            styles.chipText,
                            openVariantId === v.id ? {color: c.accent} : null,
                          ]}>
                          {v.size}
                        </Text>
                        <Text style={styles.chipPrice}>
                          {formatMoney(variantPrice(openProduct, v))}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              ) : null}

              {/* ملابس لون×مقاس */}
              {clothingVariants.length > 0 ? (
                <View style={styles.group}>
                  <Text style={styles.groupTitle}>اللون · المقاس</Text>
                  <View style={styles.chipRow}>
                    {clothingVariants.map(v => (
                      <Pressable
                        key={v.id}
                        style={[
                          styles.chip,
                          openVariantId === v.id ? styles.chipActive : null,
                          v.stockQty <= 0 ? {opacity: 0.45} : null,
                        ]}
                        onPress={() => setOpenVariantId(v.id)}>
                        <Text
                          style={[
                            styles.chipText,
                            openVariantId === v.id ? {color: c.accent} : null,
                          ]}>
                          {v.color} · {v.size}
                        </Text>
                        <Text style={styles.chipPrice}>
                          {v.stockQty > 0
                            ? `متاح ${formatQty(v.stockQty)}`
                            : 'نفد'}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              ) : null}

              {/* الوحدات */}
              {openProduct.units.length > 0 && !chosenVariant ? (
                <View style={styles.group}>
                  <Text style={styles.groupTitle}>وحدة البيع</Text>
                  <View style={styles.chipRow}>
                    <Pressable
                      style={[
                        styles.chip,
                        openUnitId == null ? styles.chipActive : null,
                      ]}
                      onPress={() => setOpenUnitId(null)}>
                      <Text
                        style={[
                          styles.chipText,
                          openUnitId == null ? {color: c.accent} : null,
                        ]}>
                        حبة
                      </Text>
                      <Text style={styles.chipPrice}>
                        {formatMoney(openProduct.retailPrice)}
                      </Text>
                    </Pressable>
                    {openProduct.units.map(unit => (
                      <Pressable
                        key={unit.id}
                        style={[
                          styles.chip,
                          openUnitId === unit.id ? styles.chipActive : null,
                        ]}
                        onPress={() => setOpenUnitId(unit.id)}>
                        <Text
                          style={[
                            styles.chipText,
                            openUnitId === unit.id ? {color: c.accent} : null,
                          ]}>
                          {unit.name}
                        </Text>
                        <Text style={styles.chipPrice}>
                          {formatMoney(
                            unit.retailPrice ??
                              openProduct.retailPrice * unit.conversion,
                          )}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              ) : null}

              {/* الكمية */}
              <View style={styles.group}>
                <Text style={styles.groupTitle}>الكمية</Text>
                <View style={styles.qtyRow}>
                  <Pressable
                    style={styles.qtyBtn}
                    onPress={() => setOpenQty(q => Math.max(1, q - 1))}>
                    <Icon name="minus" size={15} color={c.text} />
                  </Pressable>
                  <Text style={styles.qtyValue}>{formatQty(openQty)}</Text>
                  <Pressable
                    style={styles.qtyBtn}
                    onPress={() => setOpenQty(q => q + 1)}>
                    <Icon name="plus" size={15} color={c.text} />
                  </Pressable>
                </View>
              </View>
            </ScrollView>

            <AppButton
              title={`أضف إلى الاستبدال · ${formatMoney(unitPrice * openQty)}`}
              icon="plus"
              onPress={addOpenPick}
            />
            <Pressable
              style={styles.backRow}
              onPress={() => setOpenProduct(null)}>
              <Text style={styles.clearText}>رجوع للبحث</Text>
            </Pressable>
          </>
        )}
      </View>
    </View>
  );
}

// ── الأنماط ──────────────────────────────────────────────────────
const useStyles = makeStyles(c =>
  ({
    screen: {flex: 1, backgroundColor: c.bg},
    searchRow: {
      flexDirection: 'row',
      gap: 8,
      paddingHorizontal: spacing.md,
      paddingTop: spacing.sm + 2,
      paddingBottom: 6,
      alignItems: 'center',
    },
    scanBtn: {
      width: 46,
      height: 46,
      borderRadius: 13,
      backgroundColor: c.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    searchBox: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 13,
      height: 46,
      paddingHorizontal: 12,
    },
    searchInput: {
      flex: 1,
      color: c.text,
      fontFamily: fonts.regular,
      fontSize: typography.body,
      padding: 0,
      textAlign: I18nManager.isRTL ? 'right' : 'left',
    },
    kindRow: {
      flexDirection: 'row',
      gap: 6,
      paddingHorizontal: spacing.md,
      paddingBottom: 6,
    },
    kindChip: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 999,
      paddingHorizontal: 12,
      paddingVertical: 5,
    },
    kindChipActive: {borderColor: c.accent, backgroundColor: c.accentSofter},
    kindText: {
      color: c.textDim,
      fontFamily: fonts.medium,
      fontSize: typography.small,
    },
    padded: {paddingHorizontal: spacing.md, paddingBottom: 6},
    // v3.5 (الجولة 91 — كاشير #4): رقائق فلتر قناة الدفع.
    payFilterRow: {flexGrow: 0, paddingBottom: 4},
    payChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 999,
      paddingHorizontal: 10,
      paddingVertical: 4,
    },
    payChipCash: {
      width: 16,
      height: 16,
      borderRadius: 5,
      alignItems: 'center',
      justifyContent: 'center',
    },
    payChipMark: {color: '#FFFFFF', fontSize: 10, fontWeight: '900'},
    payChipText: {
      color: c.textDim,
      fontFamily: fonts.medium,
      fontSize: typography.small,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: c.surface,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: c.borderSoft,
      padding: spacing.md,
    },
    kindChipIcon: {
      width: 40,
      height: 40,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
    },
    number: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.body,
      textAlign: 'right',
      flexShrink: 1,
    },
    dim: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      textAlign: 'right',
      lineHeight: 18,
    },
    total: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: typography.body,
    },
  }) as const,
);

const useDetailStyles = makeStyles(c =>
  ({
    overlay: {
      ...StyleSheet.absoluteFillObject,
      zIndex: 40,
      elevation: 40,
      justifyContent: 'flex-end',
    },
    dim: {flex: 1, backgroundColor: c.overlay},
    sheet: {
      backgroundColor: c.surface,
      borderTopLeftRadius: 22,
      borderTopRightRadius: 22,
      borderWidth: 1,
      borderColor: c.borderSoft,
      padding: spacing.lg,
      gap: spacing.md,
      maxHeight: '88%',
    },
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    headIcon: {
      width: 38,
      height: 38,
      borderRadius: 12,
      backgroundColor: c.surfaceHi,
      alignItems: 'center',
      justifyContent: 'center',
    },
    title: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: typography.heading,
      textAlign: 'right',
      flexShrink: 1,
    },
    sub: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      textAlign: 'right',
    },
    closeBtn: {
      width: 32,
      height: 32,
      borderRadius: 10,
      backgroundColor: c.surfaceHi,
      alignItems: 'center',
      justifyContent: 'center',
    },
    metaRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      flexWrap: 'wrap',
    },
    /* v3.4: شارة طريقة الدفع (بنك/محفظة) بشعارها الرسمي. */
    pmBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      backgroundColor: c.surfaceAlt,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 999,
      paddingHorizontal: 7,
      paddingVertical: 3,
    },
    pmBadgeText: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.small - 0.5,
    },
    rejectBox: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: c.dangerSoft,
      borderRadius: 10,
      padding: spacing.sm + 2,
    },
    rejectText: {
      color: c.danger,
      fontFamily: fonts.medium,
      fontSize: typography.small,
      flex: 1,
      textAlign: 'right',
    },
    itemRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: c.surfaceAlt,
      borderRadius: 10,
      padding: spacing.sm + 2,
    },
    itemName: {
      color: c.text,
      fontFamily: fonts.medium,
      fontSize: typography.small + 1,
      textAlign: 'right',
    },
    dimText: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      textAlign: 'right',
      lineHeight: 18,
    },
    remainingText: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro,
      textAlign: 'right',
    },
    totalsRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      borderTopWidth: 1,
      borderTopColor: c.borderSoft,
      paddingTop: spacing.sm,
    },
    totalText: {
      color: c.accent,
      fontFamily: fonts.black,
      fontSize: typography.heading,
    },
  }) as const,
);

const useReturnStyles = makeStyles(c =>
  ({
    overlayLayer: {
      ...StyleSheet.absoluteFillObject,
      zIndex: 50,
      elevation: 50,
      justifyContent: 'flex-end',
    },
    dim: {flex: 1, backgroundColor: c.overlay},
    sheet: {
      backgroundColor: c.surface,
      borderTopLeftRadius: 22,
      borderTopRightRadius: 22,
      borderWidth: 1,
      borderColor: c.borderSoft,
      padding: spacing.lg,
      gap: spacing.md,
      height: '84%',
    },
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    headIcon: {
      width: 38,
      height: 38,
      borderRadius: 12,
      backgroundColor: c.surfaceHi,
      alignItems: 'center',
      justifyContent: 'center',
    },
    title: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: typography.heading,
      textAlign: 'right',
      flexShrink: 1,
    },
    sub: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      textAlign: 'right',
    },
    closeBtn: {
      width: 32,
      height: 32,
      borderRadius: 10,
      backgroundColor: c.surfaceHi,
      alignItems: 'center',
      justifyContent: 'center',
    },
    lineCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: c.surfaceAlt,
      borderRadius: 12,
      padding: spacing.sm + 2,
    },
    lineName: {
      color: c.text,
      fontFamily: fonts.medium,
      fontSize: typography.small + 1,
      textAlign: 'right',
    },
    lineMeta: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      textAlign: 'right',
      lineHeight: 17,
    },
    stepper: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    stepBtn: {
      width: 30,
      height: 30,
      borderRadius: 9,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    stepValue: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.body,
      minWidth: 34,
      textAlign: 'center',
    },
    allBtn: {
      borderRadius: 9,
      backgroundColor: c.accentSofter,
      paddingHorizontal: 9,
      paddingVertical: 6,
    },
    allBtnText: {
      color: c.accent,
      fontFamily: fonts.bold,
      fontSize: typography.micro + 1,
    },
    exchangeSection: {gap: 6, marginTop: 4},
    exchangeSectionTitle: {
      color: c.accent,
      fontFamily: fonts.bold,
      fontSize: typography.small,
      textAlign: 'right',
    },
    exchangeRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: c.accentSofter,
      borderWidth: 1,
      borderColor: c.accentSoft,
      borderRadius: 11,
      padding: spacing.sm + 2,
    },
    exchangeRowName: {
      color: c.text,
      fontFamily: fonts.medium,
      fontSize: typography.small + 1,
      textAlign: 'right',
    },
    exchangeRowMeta: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      textAlign: 'right',
    },
    exchangeRemove: {padding: 5},
    exchangeClear: {alignItems: 'center', paddingVertical: 6},
    exchangeClearText: {
      color: c.danger,
      fontFamily: fonts.medium,
      fontSize: typography.small,
    },
    summaryBox: {
      borderTopWidth: 1,
      borderTopColor: c.borderSoft,
      paddingTop: spacing.sm,
      gap: 8,
    },
    valuesPairRow: {
      flexDirection: 'row',
      gap: 8,
    },
    valueHalf: {
      flex: 1,
      backgroundColor: c.surfaceAlt,
      borderRadius: 12,
      paddingHorizontal: 12,
      paddingVertical: 9,
      gap: 2,
    },
    valueHalfAccent: {backgroundColor: c.accentSofter},
    valueHalfLabel: {
      color: c.textDim,
      fontFamily: fonts.medium,
      fontSize: typography.micro + 1,
      textAlign: 'right',
    },
    valueHalfAmount: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: typography.body + 1,
      textAlign: 'right',
    },
    diffStrip: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 11,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    diffText: {
      color: c.textDim,
      fontFamily: fonts.medium,
      fontSize: typography.small,
      textAlign: 'right',
    },
    actionsRow: {flexDirection: 'row', gap: 8, alignItems: 'center'},
    exchangeCompactBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 13,
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
    exchangeCompactText: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    hintText: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      textAlign: 'center',
      lineHeight: 16,
    },
  }) as const,
);

const useExchangeStyles = makeStyles(c =>
  ({
    overlayTop: {
      ...StyleSheet.absoluteFillObject,
      zIndex: 60,
      elevation: 60,
      justifyContent: 'flex-end',
    },
    dim: {flex: 1, backgroundColor: c.overlay},
    sheet: {
      backgroundColor: c.surface,
      borderTopLeftRadius: 22,
      borderTopRightRadius: 22,
      borderWidth: 1,
      borderColor: c.borderSoft,
      padding: spacing.lg,
      gap: spacing.md,
      height: '88%',
    },
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    headIcon: {
      width: 38,
      height: 38,
      borderRadius: 12,
      backgroundColor: c.accentSofter,
      alignItems: 'center',
      justifyContent: 'center',
    },
    title: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: typography.heading,
      textAlign: 'right',
      flexShrink: 1,
    },
    sub: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      textAlign: 'right',
    },
    closeBtn: {
      width: 32,
      height: 32,
      borderRadius: 10,
      backgroundColor: c.surfaceHi,
      alignItems: 'center',
      justifyContent: 'center',
    },
    searchRow: {
      flexDirection: 'row',
      gap: 8,
      alignItems: 'center',
    },
    scanBtn: {
      width: 44,
      height: 44,
      borderRadius: 12,
      backgroundColor: c.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    searchBox: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: c.surfaceAlt,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 12,
      height: 44,
      paddingHorizontal: 11,
    },
    searchInput: {
      flex: 1,
      color: c.text,
      fontFamily: fonts.regular,
      fontSize: typography.body - 1,
      padding: 0,
      textAlign: I18nManager.isRTL ? 'right' : 'left',
    },
    productRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      backgroundColor: c.surfaceAlt,
      borderRadius: 12,
      padding: spacing.sm + 2,
    },
    productName: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.small + 1,
      textAlign: 'right',
    },
    productMeta: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      textAlign: 'right',
    },
    emptyText: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      textAlign: 'center',
      paddingVertical: spacing.lg,
    },
    clearRow: {alignItems: 'center', paddingVertical: 6},
    clearText: {
      color: c.danger,
      fontFamily: fonts.medium,
      fontSize: typography.small,
    },
    openHead: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      backgroundColor: c.accentSofter,
      borderRadius: 12,
      padding: spacing.sm + 2,
    },
    group: {gap: 8},
    groupTitle: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.small,
      textAlign: 'right',
    },
    chipRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
    chip: {
      backgroundColor: c.surfaceHi,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 12,
      paddingHorizontal: 13,
      paddingVertical: 8,
      gap: 2,
      alignItems: 'center',
    },
    chipActive: {borderColor: c.accent},
    chipText: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    chipPrice: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
    },
    qtyRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    qtyBtn: {
      width: 40,
      height: 40,
      borderRadius: 12,
      backgroundColor: c.surfaceHi,
      borderWidth: 1,
      borderColor: c.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    qtyValue: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: typography.heading,
      minWidth: 52,
      textAlign: 'center',
    },
    backRow: {alignItems: 'center', paddingVertical: 2},
  }) as const,
);
