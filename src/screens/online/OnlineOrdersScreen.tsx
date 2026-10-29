/**
 * OnlineOrdersScreen — طلبات البيع أونلاين + منتجات النقطة (الجولة 59).
 * ─────────────────────────────────────────────────────────────────
 * مركز متابعة طلبات متجر سيلا ماركت: قائمة بفلاتر واضحة (جديد/
 * مقبول/ مرسل/ مسلّم/ ملغي-مرفوض/ الكل)، وكل طلب يفتح بطاقة تفاصيل
 * INLINE (لا Modal — نفس درس هذا الروم) فيها بيانات المستخدم
 * (الاتصال بلمسة على رقمه)، الأصناف، التوصيل، المجموع، والأفعال:
 * قبول / رفض / إرسال (فاتورة INV-O + خصم مخزون + مبيعات اليوم) /
 * تأكيد التسليم (الدين → الخزينة بسند COLL) / إلغاء / مزامنة الآن.
 *
 * v56 (الجولة 59): قسم «منتجات النقطة» بتبويب مخصّص — طلب التاجر
 * بالنص: «أريده في صفحة الطلبات أونلاين في قسم خاص بمنتجات النقطة
 * وخيار تفعيل بجانب كل منتج يريد عرضه في متجر سيلا». كل منتج نشط
 * يظهر بمفتاح تشغيل/إيقاف؛ التفعيل يدرجه فوراً (مزامنة لحظية)،
 * والإيقاف يسحبه من المتجر خلال ثوانٍ — بلا وسائط بينية.
 */
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {
  ActivityIndicator,
  BackHandler,
  Linking,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {AppHeader, EmptyState, SectionTitle} from '../../components/ui';
import {Icon} from '../../components/Icon';
import {OnlineRepo} from '../../database/repositories/OnlineRepo';
import {ProductRepo} from '../../database/repositories/ProductRepo';
import {useCatalogStore} from '../../stores/catalogStore';
import * as OnlineStore from '../../services/online/OnlineStoreService';
import {onlineErrorText} from '../../services/online/OnlineStoreService';
import {formatDateTime, formatMoney} from '../../core/format';
import {fonts, makeStyles, spacing, useThemeColors} from '../../core/theme';
import {useToastStore} from '../../stores/toastStore';
import {useSettingsStore} from '../../stores/settingsStore';
import {
  activePaymentMethods,
  paymentMethodById,
} from '../../core/paymentMethods';
import {PaymentMethodIcon} from '../../components/PaymentMethodIcon';
import type {OnlineOrder, OnlineOrderItem, OnlineOrderStatus, Product} from '../../core/types';

type FilterKey = OnlineOrderStatus | 'all';

/** v67 (الجولة 79): المبلغ القائم للتحصيل — الإجمالي − المرتجعات
 *  حتى الآن (نفس معادلة السند في deliverOrder). */
function outstandingMinor(order: OnlineOrder): number {
  return (
    order.total_minor - Math.min(order.returned_minor, order.items_total_minor)
  );
}

const FILTERS: {key: FilterKey; label: string}[] = [
  {key: 'new', label: 'جديد'},
  {key: 'accepted', label: 'مقبول'},
  {key: 'sent', label: 'مُرسل'},
  {key: 'delivered', label: 'مُسلّم'},
  {key: 'all', label: 'الكل'},
];

const STATUS_META: Record<
  OnlineOrderStatus,
  {label: string; tone: 'accent' | 'info' | 'success' | 'warning' | 'danger'}
> = {
  new: {label: 'جديد', tone: 'accent'},
  accepted: {label: 'مقبول — بانتظار التجهيز', tone: 'info'},
  rejected: {label: 'مرفوض', tone: 'danger'},
  sent: {label: 'مُرسل — دين حتى التسليم', tone: 'warning'},
  delivered: {label: 'مُسلّم — حُصّل', tone: 'success'},
  cancelled: {label: 'ملغي', tone: 'danger'},
  returned: {label: 'مُرجع', tone: 'danger'},
};

function toneColor(
  tone: 'accent' | 'info' | 'success' | 'warning' | 'danger',
  c: ReturnType<typeof useThemeColors>,
): string {
  switch (tone) {
    case 'accent':
      return c.accent;
    case 'info':
      return c.info;
    case 'success':
      return c.success;
    case 'warning':
      return c.warning;
    default:
      return c.danger;
  }
}

/** Hardware-back closer for the INLINE detail overlay. */
function BackHandlerCloser({
  active,
  onClose,
}: {
  active: boolean;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!active) {
      return;
    }
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [active, onClose]);
  return null;
}

export function OnlineOrdersScreen() {
  const c = useThemeColors();
  const styles = useStyles();
  const toast = useToastStore(state => state.show);

  const [filter, setFilter] = useState<FilterKey>('new');
  const [orders, setOrders] = useState<OnlineOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [detail, setDetail] = useState<OnlineOrder | null>(null);
  const [detailItems, setDetailItems] = useState<OnlineOrderItem[]>([]);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectText, setRejectText] = useState('');

  /* v56: قسم «منتجات النقطة» — الإدراج في متجر سيلا من هنا. */
  const refreshCatalog = useCatalogStore(state => state.refresh);
  const [tab, setTab] = useState<'orders' | 'products'>('orders');
  const [products, setProducts] = useState<Product[]>([]);
  const [productsLoading, setProductsLoading] = useState(false);
  const [productQuery, setProductQuery] = useState('');
  const [togglingId, setTogglingId] = useState<number | null>(null);

  const reloadProducts = useCallback(async () => {
    setProductsLoading(true);
    try {
      setProducts(await ProductRepo.list({archival: 'active'}));
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'تعذر تحميل منتجات النقطة',
        'error',
      );
    } finally {
      setProductsLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (tab === 'products' && products.length === 0 && !productsLoading) {
      void reloadProducts();
    }
  }, [tab, products.length, productsLoading, reloadProducts]);

  /** تفعيل/إيقاف عرض منتج في متجر سيلا — مزامنة لحظية. */
  const toggleOnlineListing = useCallback(
    async (product: Product) => {
      if (togglingId != null) {
        return;
      }
      setTogglingId(product.id);
      const target = product.online_listed !== 1;
      try {
        const done = await ProductRepo.setOnlineListed(product.id, target);
        if (!done) {
          toast('لا يمكن إدراج منتج مؤرشف', 'error');
          return;
        }
        setProducts(prev =>
          prev.map(p =>
            p.id === product.id ? {...p, online_listed: target ? 1 : 0} : p,
          ),
        );
        await refreshCatalog();
        try {
          const {notifyCatalogChanged} = require('../../services/online/OnlineStoreService') as
            typeof import('../../services/online/OnlineStoreService');
          notifyCatalogChanged();
        } catch {
          // الدورة الـ ١٥ دقيقة شبكة الأمان.
        }
        toast(
          target
            ? `«${product.name}» معروض الآن في متجر سيلا`
            : `أُوقف عرض «${product.name}» — يختفي من المتجر خلال ثوانٍ`,
          'success',
        );
      } catch (error) {
        toast(
          error instanceof Error ? error.message : 'تعذر تغيير الإدراج',
          'error',
        );
      } finally {
        setTogglingId(null);
      }
    },
    [refreshCatalog, togglingId, toast],
  );

  const listedCount = useMemo(
    () => products.filter(p => p.online_listed === 1).length,
    [products],
  );

  const filteredProducts = useMemo(() => {
    const q = productQuery.trim();
    if (q.length === 0) {
      return products;
    }
    return products.filter(p => p.name.includes(q));
  }, [products, productQuery]);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      /* v57 (الجولة 61): نحمّل كل الطلبات دفعة واحدة — شارات العدد
       * على كل فلتر تحتاج عدّ الحالات كلها (طلب التاجر: «عدد
       * العمليات الحالية والتي لم تتم معالجتها كرقم تنبيه»)،
       * والتصفية تجري محلياً فوراً بلا نداء جديد عند كل تبديل. */
      setOrders(await OnlineRepo.list('all'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const syncNow = useCallback(async () => {
    setRefreshing(true);
    try {
      const fresh = await OnlineStore.pollOrders();
      await reload();
      toast(
        fresh > 0
          ? `وصل ${fresh} طلب جديد`
          : 'لا طلبات جديدة — الطلبات محدّثة',
        'success',
      );
    } catch (error) {
      toast(onlineErrorText(error), 'error');
    } finally {
      setRefreshing(false);
    }
  }, [reload, toast]);

  const openDetail = useCallback(async (order: OnlineOrder) => {
    setDetail(order);
    setRejectOpen(false);
    setRejectText('');
    setDetailItems(await OnlineRepo.itemsFor(order.server_id));
  }, []);

  const runAction = useCallback(
    async (action: () => Promise<string | void>, tag: string) => {
      if (busyAction != null) {
        return;
      }
      setBusyAction(tag);
      try {
        const message = await action();
        if (typeof message === 'string' && message.length > 0) {
          toast(message, 'success');
        }
        setDetail(null);
        await reload();
      } catch (error) {
        toast(onlineErrorText(error), 'error');
      } finally {
        setBusyAction(null);
      }
    },
    [busyAction, reload, toast],
  );

  /* v67 (الجولة 79 — أهم مطلب): استلام دفع الطلبات أونلاين — قبل
   * تأكيد التسليم يختار البائع طريقة التحصيل (نقدي أو أي بنك/
   * محفظة مفعلة): سند التحصيل يُسجل على القناة الصحيحة وفاتورة
   * الطلب تحمل الطريقة فتظهر مميزة في مركز الفواتير وتقارير
   * الأرصدة. نافذة INLINE بنفس نمط التطبيق (لا Modal). */
  const [collectOpen, setCollectOpen] = useState<OnlineOrder | null>(null);
  const [collectMethod, setCollectMethod] = useState('cash');
  const paymentMethodsEnabled = useSettingsStore(
    s => s.settings.paymentMethodsEnabled,
  );
  const collectMethods = useMemo(
    () => activePaymentMethods(paymentMethodsEnabled),
    [paymentMethodsEnabled],
  );

  const openCollect = useCallback((order: OnlineOrder) => {
    setCollectMethod('cash');
    setCollectOpen(order);
  }, []);

  const confirmCollect = useCallback(() => {
    if (collectOpen == null) {
      return;
    }
    const order = collectOpen;
    const method = paymentMethodById(collectMethod);
    setCollectOpen(null);
    setDetail(null);
    void runAction(async () => {
      await OnlineStore.deliverOrder(order, collectMethod);
      return `تم تأكيد التسليم — حُصّل ${(outstandingMinor(order) / 100).toFixed(2)} ₪ عبر ${method.label} بسند تحصيل على قناته — وفاتورة الطلب تحمل الطريقة`; 
    }, 'deliver');
  }, [collectOpen, collectMethod, runAction]);

  const counts = useMemo(() => {
    const map = new Map<FilterKey, number>();
    for (const o of orders) {
      map.set(o.status, (map.get(o.status) ?? 0) + 1);
    }
    map.set('all', orders.length);
    return map;
  }, [orders]);

  /* v57: القائمة المعروضة — تصفية محلية فورية فوق القائمة الكاملة. */
  const visible = useMemo(
    () => (filter === 'all' ? orders : orders.filter(o => o.status === filter)),
    [orders, filter],
  );

  return (
    <View style={styles.root}>
      <AppHeader title="طلبات البيع أونلاين" subtitle="متجر سيلا ماركت" />
      <BackHandlerCloser
        active={detail != null}
        onClose={() => setDetail(null)}
      />
      <View style={styles.content}>
        {/* v56: تبويب الصفحة — الطلبات / منتجات النقطة (طلب التاجر:
            قسم خاص بمنتجات النقطة وخيار تفعيل بجانب كل منتج). */}
        <View style={styles.tabRow}>
          <TouchableOpacity
            style={[styles.tab, tab === 'orders' ? styles.tabActive : null]}
            onPress={() => setTab('orders')}
            activeOpacity={0.8}>
            <Icon
              name="cart"
              size={15}
              color={tab === 'orders' ? '#FFFFFF' : c.textDim}
            />
            <Text
              style={[
                styles.tabText,
                tab === 'orders' ? {color: '#FFFFFF'} : null,
              ]}>
              الطلبات
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.tab, tab === 'products' ? styles.tabActive : null]}
            onPress={() => setTab('products')}
            activeOpacity={0.8}>
            <Icon
              name="store"
              size={15}
              color={tab === 'products' ? '#FFFFFF' : c.textDim}
            />
            <Text
              style={[
                styles.tabText,
                tab === 'products' ? {color: '#FFFFFF'} : null,
              ]}>
              منتجات النقطة
            </Text>
          </TouchableOpacity>
        </View>

        {tab === 'products' ? (
          <ProductsSection
            products={filteredProducts}
            totalCount={products.length}
            listedCount={listedCount}
            loading={productsLoading}
            query={productQuery}
            onQuery={text => {
              setProductQuery(text);
            }}
            togglingId={togglingId}
            onToggle={toggleOnlineListing}
            onReload={() => void reloadProducts()}
          />
        ) : (
        <>
        {/* فلاتر واضحة + مزامنة يدوية */}
        <View style={styles.filterRow}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={styles.chips}>
              {FILTERS.map(f => {
                const n = counts.get(f.key) ?? 0;
                const active = filter === f.key;
                /* v57: شارة رقم على كل فلتر — الحالات التي تنتظر
                 * عملاً من التاجر (جديد/مقبول/مُرسل) تُبرز بلون العلامة
                 * كرقم تنبيه (طلب التاجر بالنص)، والمكتملة بلون هادئ. */
                const actionable =
                  f.key === 'new' || f.key === 'accepted' || f.key === 'sent';
                return (
                  <TouchableOpacity
                    key={f.key}
                    style={[
                      styles.chip,
                      active
                        ? {backgroundColor: c.accent, borderColor: c.accent}
                        : null,
                    ]}
                    onPress={() => setFilter(f.key)}
                    activeOpacity={0.8}>
                    <Text
                      style={[
                        styles.chipText,
                        active ? {color: '#FFFFFF'} : null,
                      ]}>
                      {f.label}
                    </Text>
                    {n > 0 ? (
                      <View
                        style={[
                          styles.chipBadge,
                          {
                            backgroundColor: active
                              ? '#FFFFFF'
                              : actionable
                                ? c.accent
                                : c.accentSoft,
                          },
                        ]}>
                        <Text
                          style={[
                            styles.chipBadgeText,
                            {
                              color: active
                                ? c.accent
                                : actionable
                                  ? '#FFFFFF'
                                  : c.textDim,
                            },
                          ]}>
                          {n}
                        </Text>
                      </View>
                    ) : null}
                  </TouchableOpacity>
                );
              })}
            </View>
          </ScrollView>
          <TouchableOpacity
            style={styles.syncBtn}
            onPress={() => void syncNow()}
            disabled={refreshing}
            activeOpacity={0.8}>
            {refreshing ? (
              <ActivityIndicator size="small" color={c.accent} />
            ) : (
              <Icon name="refresh" size={16} color={c.accent} />
            )}
          </TouchableOpacity>
        </View>

        {loading ? (
          <View style={styles.centerWrap}>
            <ActivityIndicator size="large" color={c.accent} />
          </View>
        ) : visible.length === 0 ? (
          <EmptyState
            icon="cart"
            title="لا طلبات في هذه الحالة"
            subtitle={
              orders.length > 0
                ? `لديك ${orders.length} طلباً في حالات أخرى — بدّل الفلتر أعلاه`
                : 'الطلبات الجديدة من تطبيق المتجر تصل هنا فوراً مع إشعار'
            }
          />
        ) : (
          <ScrollView contentContainerStyle={styles.listWrap}>
            {visible.map(order => {
              const meta = STATUS_META[order.status];
              return (
                <TouchableOpacity
                  key={order.order_number}
                  style={styles.card}
                  activeOpacity={0.85}
                  onPress={() => void openDetail(order)}>
                  <View style={styles.cardTop}>
                    <Text style={styles.orderNumber} selectable>
                      {order.order_number}
                    </Text>
                    <View
                      style={[
                        styles.statusPill,
                        {backgroundColor: toneColor(meta.tone, c) + '22'},
                      ]}>
                      <Text
                        style={[styles.statusText, {color: toneColor(meta.tone, c)}]}>
                        {meta.label}
                      </Text>
                    </View>
                  </View>
                  <View style={styles.cardMid}>
                    <Icon name="user" size={14} color={c.textDim} />
                    <Text style={styles.customerName}>{order.customer_name}</Text>
                    <Text style={styles.dim}>·</Text>
                    <Text style={styles.dim} selectable>
                      {order.customer_phone}
                    </Text>
                  </View>
                  <View style={styles.cardBottom}>
                    <Text style={styles.dim}>
                      {formatDateTime(order.created_at)} · {order.region_name ?? '—'}
                    </Text>
                    <Text style={styles.total}>
                      {formatMoney(order.total_minor / 100)}
                    </Text>
                  </View>
                  {order.status === 'new' ? (
                    <View style={styles.newBadge}>
                      <Text style={styles.newBadgeText}>بانتظار قرارك</Text>
                    </View>
                  ) : null}
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        )}
        </>
        )}
      </View>

      {/* تفاصيل الطلب — INLINE overlay (لا Modal على هذا الروم) */}
      {detail != null ? (
        <View style={styles.overlay}>
          <TouchableOpacity
            style={styles.overlayBack}
            activeOpacity={1}
            onPress={() => setDetail(null)}
          />
          <View style={styles.sheet}>
            <View style={styles.sheetHeader}>
              <View style={{flex: 1}}>
                <Text style={styles.sheetTitle}>{detail.order_number}</Text>
                <Text style={styles.sheetSub}>
                  {STATUS_META[detail.status].label}
                  {detail.invoice_ref != null
                    ? ` · فاتورة ${detail.invoice_ref}`
                    : ''}
                </Text>
              </View>
              <TouchableOpacity
                style={styles.closeBtn}
                onPress={() => setDetail(null)}>
                <Icon name="x" size={18} color={c.textDim} />
              </TouchableOpacity>
            </View>

            <ScrollView style={{flex: 1}} contentContainerStyle={styles.sheetBody}>
              {/* الزبون */}
              <SectionTitle title="بيانات المستخدم" />
              <View style={styles.infoRow}>
                <Icon name="user" size={14} color={c.textDim} />
                <Text style={styles.infoValue}>{detail.customer_name}</Text>
              </View>
              <TouchableOpacity
                style={styles.infoRow}
                onPress={() =>
                  void Linking.openURL(`tel:${detail.customer_phone}`)
                }>
                <Icon name="phone" size={14} color={c.accent} />
                <Text style={[styles.infoValue, {color: c.accent}]} selectable>
                  {detail.customer_phone}
                </Text>
                <Text style={styles.dim}> (اضغط للاتصال)</Text>
              </TouchableOpacity>
              <View style={styles.infoRow}>
                <Icon name="shield" size={14} color={c.textDim} />
                <Text style={styles.infoValue} selectable>
                  هوية {detail.customer_id_number}
                </Text>
              </View>
              {detail.address ? (
                <View style={styles.infoRow}>
                  <Icon name="store" size={14} color={c.textDim} />
                  <Text style={styles.infoValue}>
                    {detail.address} — {detail.region_name ?? ''}
                  </Text>
                </View>
              ) : null}
              {detail.note ? (
                <View style={styles.noteBox}>
                  <Text style={styles.noteText}>ملاحظة: {detail.note}</Text>
                </View>
              ) : null}

              {/* الأصناف */}
              <SectionTitle title="الأصناف" />
              {detailItems.map(item => (
                <View
                  key={`${item.product_ref}:${item.variant ?? ''}`}
                  style={styles.itemRow}>
                  <View style={{flex: 1, gap: 2}}>
                    <Text style={styles.itemName}>{item.product_name}</Text>
                    {item.variant ? (
                      <Text style={styles.itemVariant}>{item.variant}</Text>
                    ) : null}
                  </View>
                  <Text style={styles.dim}>
                    ×{item.quantity} · {formatMoney(item.unit_price_minor / 100)}
                  </Text>
                  <Text style={styles.itemTotal}>
                    {formatMoney(item.line_total_minor / 100)}
                  </Text>
                </View>
              ))}
              <View style={styles.sumRow}>
                <Text style={styles.dim}>التوصيل ({detail.region_name ?? '—'})</Text>
                <Text style={styles.itemTotal}>
                  {formatMoney(detail.delivery_fee_minor / 100)}
                </Text>
              </View>
              <View style={[styles.sumRow, styles.sumTotal]}>
                <Text style={styles.sumTotalText}>الإجمالي</Text>
                <Text style={styles.sumTotalText}>
                  {formatMoney(detail.total_minor / 100)}
                </Text>
              </View>
              {detail.returned_minor > 0 ? (
                <View style={styles.sumRow}>
                  <Text style={[styles.dim, {color: c.danger}]}>
                    مرتجع منه
                  </Text>
                  <Text style={[styles.itemTotal, {color: c.danger}]}>
                    {formatMoney(detail.returned_minor / 100)}
                  </Text>
                </View>
              ) : null}

              {/* الأفعال حسب الحالة */}
              <SectionTitle title="الإجراءات" />
              {detail.status === 'new' || detail.status === 'accepted' ? (
                rejectOpen ? (
                  <View>
                    <TextInput
                      style={styles.rejectInput}
                      value={rejectText}
                      onChangeText={setRejectText}
                      placeholder="سبب الرفض (يظهر للمستخدم)"
                      placeholderTextColor={c.textDim}
                      multiline
                    />
                    <View style={styles.actionRow}>
                      <TouchableOpacity
                        style={[styles.actionBtn, {backgroundColor: c.danger}]}
                        onPress={() =>
                          void runAction(async () => {
                            await OnlineStore.rejectOrder(
                              detail.order_number,
                              rejectText.trim() || 'غير متوفر حالياً',
                            );
                            return 'تم رفض الطلب وإبلاغ المستخدم';
                          }, 'reject')
                        }
                        disabled={busyAction != null}>
                        <Text style={styles.actionBtnText}>تأكيد الرفض</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.actionBtn, styles.ghostBtn]}
                        onPress={() => setRejectOpen(false)}>
                        <Text style={[styles.actionBtnText, {color: c.text}]}>
                          رجوع
                        </Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ) : (
                  <View style={styles.actionRow}>
                    {detail.status === 'new' ? (
                      <TouchableOpacity
                        style={[styles.actionBtn, {backgroundColor: c.success}]}
                        onPress={() =>
                          void runAction(async () => {
                            await OnlineStore.acceptOrder(
                              detail.order_number,
                            );
                            return 'تم قبول الطلب — جهّزه ثم أرسله';
                          }, 'accept')
                        }
                        disabled={busyAction != null}>
                        <Text style={styles.actionBtnText}>قبول الطلب</Text>
                      </TouchableOpacity>
                    ) : null}
                    <TouchableOpacity
                      style={[styles.actionBtn, {backgroundColor: c.accent}]}
                      onPress={() =>
                        void runAction(async () => {
                          const invoice =
                            await OnlineStore.sendOrder(detail);
                          return `أُرسل الطلب بفاتورة ${invoice} — سُجّل في مبيعات اليوم والدين حتى التسليم`;
                        }, 'send')
                      }
                      disabled={busyAction != null}>
                      {busyAction === 'send' ? (
                        <ActivityIndicator size="small" color="#FFFFFF" />
                      ) : (
                        <Text style={styles.actionBtnText}>
                          تجهيز وإرسال (فاتورة)
                        </Text>
                      )}
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.actionBtn, styles.ghostBtn]}
                      onPress={() => setRejectOpen(true)}>
                      <Text style={[styles.actionBtnText, {color: c.danger}]}>
                        رفض
                      </Text>
                    </TouchableOpacity>
                  </View>
                )
              ) : null}
              {detail.status === 'sent' ? (
                <View style={styles.actionCol}>
                  <TouchableOpacity
                    style={[styles.actionBtn, {backgroundColor: c.success}]}
                    /* v67 (الجولة 79 — أهم مطلب): التسليم يفتح نافذة
                     * اختيار طريقة التحصيل أولاً — نقدي أو أي بنك/
                     * محفظة مفعلة — ثم يُسجل السند على قناته الصحيحة
                     * وفاتورة الطلب تحمل الطريقة. */
                    onPress={() => openCollect(detail)}
                    disabled={busyAction != null}>
                    {busyAction === 'deliver' ? (
                      <ActivityIndicator size="small" color="#FFFFFF" />
                    ) : (
                      <Text style={styles.actionBtnText}>
                        تأكيد التسليم واستلام الدفع
                      </Text>
                    )}
                  </TouchableOpacity>
                  <Text style={styles.hintText}>
                    اختر طريقة التحصيل (نقدي أو بنك/محفظة مفعلة) — يُسجّل سند
                    تحصيل بالمبلغ القائم على القناة التي اخترتها، وفاتورة الطلب
                    تُميَّز بطريتها في مركز الفواتير. الإرجاع بعد التسليم من
                    مركز الفواتير على فاتورة {detail.invoice_ref ?? 'INV-O'}.
                  </Text>
                </View>
              ) : null}
              {detail.status === 'delivered' || detail.status === 'returned' ? (
                <Text style={styles.hintText}>
                  {detail.invoice_ref
                    ? `الإرجاع/الاستبدال يتم من مركز الفواتير على فاتورة ${detail.invoice_ref} — مسار الإرجاع القياسي بكل مزاياه (كلي/جزئي/استبدال).`
                    : 'اكتملت دورة هذا الطلب.'}
                </Text>
              ) : null}
            </ScrollView>
          </View>
        </View>
      ) : null}

      {/* v67 (الجولة 79 — أهم مطلب): نافذة استلام دفع الطلب أونلاين —
          اختيار طريقة التحصيل قبل تأكيد التسليم. INLINE overlay. */}
      {collectOpen != null ? (
        <View style={styles.overlay}>
          <BackHandlerCloser
            active={collectOpen != null}
            onClose={() => setCollectOpen(null)}
          />
          <TouchableOpacity
            style={styles.overlayBack}
            activeOpacity={1}
            onPress={() => setCollectOpen(null)}
          />
          <View style={styles.collectSheet}>
            <View style={styles.sheetHeader}>
              <View style={{flex: 1}}>
                <Text style={styles.sheetTitle}>
                  استلام دفع الطلب {collectOpen.order_number}
                </Text>
                <Text style={styles.sheetSub}>
                  المبلغ القائم:{' '}
                  {formatMoney(outstandingMinor(collectOpen) / 100)} — اختر
                  الطريقة التي حُصّل بها
                </Text>
              </View>
              <TouchableOpacity
                style={styles.closeBtn}
                onPress={() => setCollectOpen(null)}>
                <Icon name="x" size={18} color={c.textDim} />
              </TouchableOpacity>
            </View>
            <ScrollView
              style={styles.collectScroll}
              contentContainerStyle={styles.collectGrid}
              showsVerticalScrollIndicator={false}>
              {collectMethods.map(method => {
                const selected = method.id === collectMethod;
                return (
                  <TouchableOpacity
                    key={method.id}
                    style={[
                      styles.collectCard,
                      selected
                        ? {borderColor: c.accent, backgroundColor: c.surfaceHi}
                        : null,
                    ]}
                    activeOpacity={0.7}
                    onPress={() => setCollectMethod(method.id)}>
                    <PaymentMethodIcon method={method} size={52} />
                    <Text style={styles.collectName} numberOfLines={1}>
                      {method.label}
                    </Text>
                    <Text style={styles.collectKind} numberOfLines={1}>
                      {method.kind === 'cash'
                        ? 'الخزينة النقدية'
                        : method.kind === 'bank'
                        ? 'تحويل بنكي'
                        : 'محفظة إلكترونية'}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            <View style={styles.collectActions}>
              <TouchableOpacity
                style={[styles.actionBtn, styles.ghostBtn, {flex: 1}]}
                onPress={() => setCollectOpen(null)}
                disabled={busyAction != null}>
                <Text style={[styles.actionBtnText, {color: c.danger}]}>
                  إلغاء
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.actionBtn,
                  {backgroundColor: c.success, flex: 1.8},
                ]}
                onPress={confirmCollect}
                disabled={busyAction != null}>
                {busyAction === 'deliver' ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <Text style={styles.actionBtnText}>
                    تحصيل عبر {paymentMethodById(collectMethod).label} وتأكيد
                    التسليم
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      ) : null}
    </View>
  );
}


/* ═══ v56 (الجولة 59): قسم «منتجات النقطة» ═══════════════════════
 * طلب التاجر بالنص: قسم خاص بمنتجات النقطة في صفحة الطلبات أونلاين
 * وخيار تفعيل بجانب كل منتج يريد عرضه في متجر سيلا. كل تبديل مفتاح
 * يُدرج/يسحب المنتج فوراً مع مزامنة لحظية — التاجر يرى متجره يتحدث
 * خلال ثوانٍ بلا خطوات إضافية. */
function ProductsSection({
  products,
  totalCount,
  listedCount,
  loading,
  query,
  onQuery,
  togglingId,
  onToggle,
  onReload,
}: {
  products: Product[];
  totalCount: number;
  listedCount: number;
  loading: boolean;
  query: string;
  onQuery: (text: string) => void;
  togglingId: number | null;
  onToggle: (product: Product) => void;
  onReload: () => void;
}) {
  const c = useThemeColors();
  const styles = useStyles();

  return (
    <View style={{flex: 1}}>
      {/* إحصاءة الإدراج — الصورة الكاملة بلمحة */}
      <View style={styles.prodStatsRow}>
        <Icon name="store" size={16} color={c.accent} />
        <Text style={styles.prodStatsText}>
          معروض في متجر سيلا:{' '}
          <Text style={{fontFamily: fonts.black, color: c.accent}}>
            {listedCount}
          </Text>{' '}
          من {totalCount} منتجاً
        </Text>
      </View>

      {/* بحث فوري — الوصول لمنتج بعينه بين مئات المنتجات */}
      <View style={styles.prodSearchWrap}>
        <Icon name="search" size={15} color={c.textDim} />
        <TextInput
          style={styles.prodSearchInput}
          placeholder="ابحث في منتجات النقطة…"
          placeholderTextColor={c.textDim}
          value={query}
          onChangeText={onQuery}
        />
        {query.length > 0 ? (
          <TouchableOpacity onPress={() => onQuery('')} hitSlop={8}>
            <Icon name="x" size={15} color={c.textDim} />
          </TouchableOpacity>
        ) : null}
      </View>

      {loading ? (
        <View style={styles.centerWrap}>
          <ActivityIndicator size="large" color={c.accent} />
        </View>
      ) : products.length === 0 ? (
        <EmptyState
          icon="box"
          title={query.length > 0 ? 'لا نتائج مطابقة' : 'لا منتجات نشطة'}
          subtitle={
            query.length > 0
              ? 'جرّب كلمة أخرى'
              : 'أضف منتجات من المخزون أولاً ثم فعّل عرضها هنا'
          }
        />
      ) : (
        <ScrollView contentContainerStyle={styles.listWrap}>
          {products.map(product => {
            const listed = product.online_listed === 1;
            const busy = togglingId === product.id;
            const outOfStock = product.stock_quantity <= 0;
            return (
              <View key={product.id} style={styles.prodRow}>
                <View style={{flex: 1, gap: 3}}>
                  <Text style={styles.prodName} numberOfLines={1}>
                    {product.name}
                  </Text>
                  <View style={{flexDirection: 'row', alignItems: 'center', gap: 6}}>
                    <Text style={styles.prodMeta}>
                      {formatMoney(product.retail_price)}
                    </Text>
                    <Text style={styles.prodDim}>·</Text>
                    <Text
                      style={[
                        styles.prodDim,
                        outOfStock ? {color: c.danger} : null,
                      ]}>
                      {outOfStock
                        ? 'نفد المخزون'
                        : `المخزون ${product.stock_quantity}`}
                    </Text>
                  </View>
                </View>
                <Switch
                  value={listed}
                  disabled={busy}
                  onValueChange={() => onToggle(product)}
                  trackColor={{false: c.surfaceHi, true: c.accent}}
                  thumbColor="#FFFFFF"
                />
              </View>
            );
          })}
        </ScrollView>
      )}

      <TouchableOpacity
        style={styles.prodReloadBtn}
        onPress={onReload}
        activeOpacity={0.8}>
        <Icon name="refresh" size={15} color={c.accent} />
        <Text style={styles.prodReloadText}>تحديث قائمة المنتجات</Text>
      </TouchableOpacity>
    </View>
  );
}

const useStyles = makeStyles(c =>
  StyleSheet.create({
    root: {flex: 1, backgroundColor: c.bg},
    content: {flex: 1, padding: spacing.lg, gap: spacing.md},
    filterRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    chips: {flexDirection: 'row', gap: 6},
    chip: {
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
      borderRadius: 16,
      paddingHorizontal: 14,
      paddingVertical: 7,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    chipText: {
      fontFamily: fonts.bold,
      fontSize: 12.5,
      color: c.textDim,
    },
    /* v57: شارة العدد داخل رقاقة الفلتر — رقم تنبيه واضح. */
    chipBadge: {
      minWidth: 20,
      height: 20,
      borderRadius: 10,
      paddingHorizontal: 5,
      alignItems: 'center',
      justifyContent: 'center',
    },
    chipBadgeText: {
      fontFamily: fonts.black,
      fontSize: 10.5,
    },
    syncBtn: {
      width: 38,
      height: 38,
      borderRadius: 19,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    centerWrap: {flex: 1, alignItems: 'center', justifyContent: 'center'},
    listWrap: {gap: spacing.md, paddingBottom: 40},
    card: {
      backgroundColor: c.surface,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: c.borderSoft,
      padding: spacing.md,
      gap: 8,
    },
    /* v56: قسم منتجات النقطة. */
    tabRow: {
      flexDirection: 'row',
      gap: 8,
      marginBottom: 10,
    },
    tab: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.borderSoft,
      backgroundColor: c.surface,
      paddingVertical: 9,
    },
    tabActive: {backgroundColor: c.accent, borderColor: c.accent},
    tabText: {fontFamily: fonts.bold, fontSize: 12.5, color: c.textDim},
    prodStatsRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: c.surfaceAlt,
      borderRadius: 12,
      paddingHorizontal: 12,
      paddingVertical: 9,
      marginBottom: 8,
    },
    prodStatsText: {fontFamily: fonts.medium, fontSize: 12.5, color: c.text},
    prodSearchWrap: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: 12,
      paddingHorizontal: 12,
      paddingVertical: 4,
      marginBottom: 8,
    },
    prodSearchInput: {
      flex: 1,
      fontFamily: fonts.regular,
      fontSize: 13,
      color: c.text,
      paddingVertical: 8,
      textAlign: 'right',
    },
    prodRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: 12,
      padding: spacing.md,
      marginBottom: 8,
    },
    prodName: {fontFamily: fonts.bold, fontSize: 13.5, color: c.text},
    prodMeta: {fontFamily: fonts.bold, fontSize: 12, color: c.accent},
    prodDim: {fontFamily: fonts.regular, fontSize: 11.5, color: c.textDim},
    prodReloadBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      paddingVertical: 10,
    },
    prodReloadText: {fontFamily: fonts.bold, fontSize: 12, color: c.accent},
    cardTop: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: 8,
    },
    orderNumber: {
      fontFamily: fonts.bold,
      fontSize: 14.5,
      color: c.text,
    },
    statusPill: {borderRadius: 10, paddingHorizontal: 10, paddingVertical: 4},
    statusText: {fontFamily: fonts.bold, fontSize: 11.5},
    cardMid: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      flexWrap: 'wrap',
    },
    customerName: {
      fontFamily: fonts.bold,
      fontSize: 13.5,
      color: c.text,
    },
    dim: {fontFamily: fonts.regular, fontSize: 12, color: c.textDim},
    cardBottom: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    total: {fontFamily: fonts.black, fontSize: 15, color: c.accent},
    newBadge: {
      position: 'absolute',
      top: -8,
      left: 12,
      backgroundColor: c.accent,
      borderRadius: 8,
      paddingHorizontal: 8,
      paddingVertical: 2,
    },
    newBadgeText: {
      fontFamily: fonts.bold,
      fontSize: 10,
      color: '#FFFFFF',
    },
    overlay: {
      ...StyleSheet.absoluteFillObject,
      justifyContent: 'flex-end',
      zIndex: 40,
    },
    overlayBack: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(0,0,0,0.55)',
    },
    sheet: {
      height: '86%',
      backgroundColor: c.bg,
      borderTopLeftRadius: 22,
      borderTopRightRadius: 22,
      borderWidth: 1,
      borderColor: c.borderSoft,
      overflow: 'hidden',
    },
    sheetHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      padding: spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: c.borderSoft,
      gap: 10,
    },
    sheetTitle: {fontFamily: fonts.black, fontSize: 16, color: c.text},
    sheetSub: {
      fontFamily: fonts.regular,
      fontSize: 12,
      color: c.textDim,
      marginTop: 2,
    },
    closeBtn: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: c.surface,
      alignItems: 'center',
      justifyContent: 'center',
    },
    sheetBody: {padding: spacing.md, gap: 8, paddingBottom: 40},
    /* ── v67 (الجولة 79): نافذة استلام دفع الطلب أونلاين ── */
    collectSheet: {
      maxHeight: '72%',
      backgroundColor: c.bg,
      borderTopLeftRadius: 22,
      borderTopRightRadius: 22,
      borderWidth: 1,
      borderColor: c.borderSoft,
      overflow: 'hidden',
    },
    collectScroll: {flexShrink: 1},
    collectGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'space-between',
      gap: spacing.sm,
      padding: spacing.md,
      paddingBottom: spacing.sm,
    },
    collectCard: {
      width: '31%',
      minWidth: 100,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      paddingVertical: 12,
      paddingHorizontal: 6,
      borderRadius: 14,
      borderWidth: 2,
      borderColor: c.border,
      backgroundColor: c.surfaceAlt,
    },
    collectName: {
      color: c.text,
      fontSize: 13,
      fontFamily: fonts.bold,
    },
    collectKind: {
      color: c.textFaint,
      fontSize: 10.5,
      fontFamily: fonts.medium,
    },
    collectActions: {
      flexDirection: 'row',
      gap: spacing.sm,
      padding: spacing.md,
      paddingTop: spacing.sm,
      borderTopWidth: 1,
      borderTopColor: c.borderSoft,
    },
    infoRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingVertical: 3,
    },
    infoValue: {fontFamily: fonts.bold, fontSize: 13.5, color: c.text},
    noteBox: {
      backgroundColor: c.surfaceAlt,
      borderRadius: 10,
      padding: 10,
      marginTop: 4,
    },
    noteText: {fontFamily: fonts.regular, fontSize: 12.5, color: c.text},
    itemRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingVertical: 5,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.borderSoft,
    },
    itemName: {fontFamily: fonts.bold, fontSize: 13, color: c.text, flex: 1},
    itemVariant: {
      fontFamily: fonts.medium,
      fontSize: 11.5,
      color: c.accent,
      writingDirection: 'rtl',
    },
    itemTotal: {fontFamily: fonts.bold, fontSize: 13, color: c.text},
    sumRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingVertical: 4,
    },
    sumTotal: {
      borderTopWidth: 1,
      borderTopColor: c.border,
      marginTop: 4,
      paddingTop: 8,
    },
    sumTotalText: {
      fontFamily: fonts.black,
      fontSize: 15,
      color: c.text,
    },
    actionRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
      marginTop: 6,
    },
    actionCol: {gap: 8, marginTop: 6},
    actionBtn: {
      borderRadius: 12,
      paddingHorizontal: 16,
      paddingVertical: 12,
      alignItems: 'center',
      justifyContent: 'center',
      minWidth: 120,
    },
    actionBtnText: {
      fontFamily: fonts.bold,
      fontSize: 13,
      color: '#FFFFFF',
    },
    ghostBtn: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
    },
    rejectInput: {
      backgroundColor: c.surfaceAlt,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.border,
      padding: 12,
      fontFamily: fonts.regular,
      fontSize: 13.5,
      color: c.text,
      textAlignVertical: 'top',
      minHeight: 76,
    },
    hintText: {
      fontFamily: fonts.regular,
      fontSize: 12,
      color: c.textDim,
      lineHeight: 18,
    },
  }),
);
