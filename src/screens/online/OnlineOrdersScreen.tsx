/**
 * OnlineOrdersScreen — طلبات البيع أونلاين (الجولة 56).
 * ─────────────────────────────────────────────────────────────────
 * مركز متابعة طلبات متجر سيلا ماركت: قائمة بفلاتر واضحة (جديد/
 * مقبول/ مرسل/ مسلّم/ ملغي-مرفوض/ الكل)، وكل طلب يفتح بطاقة تفاصيل
 * INLINE (لا Modal — نفس درس هذا الروم) فيها بيانات المستخدم
 * (الاتصال بلمسة على رقمه)، الأصناف، التوصيل، المجموع، والأفعال:
 * قبول / رفض / إرسال (فاتورة INV-O + خصم مخزون + مبيعات اليوم) /
 * تأكيد التسليم (الدين → الخزينة بسند COLL) / إلغاء / مزامنة الآن.
 */
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {
  ActivityIndicator,
  BackHandler,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {AppHeader, EmptyState, SectionTitle} from '../../components/ui';
import {Icon} from '../../components/Icon';
import {OnlineRepo} from '../../database/repositories/OnlineRepo';
import * as OnlineStore from '../../services/online/OnlineStoreService';
import {onlineErrorText} from '../../services/online/OnlineStoreService';
import {formatDateTime, formatMoney} from '../../core/format';
import {fonts, makeStyles, spacing, useThemeColors} from '../../core/theme';
import {useToastStore} from '../../stores/toastStore';
import type {OnlineOrder, OnlineOrderItem, OnlineOrderStatus} from '../../core/types';

type FilterKey = OnlineOrderStatus | 'all';

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

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setOrders(await OnlineRepo.list(filter === 'all' ? 'all' : filter));
    } finally {
      setLoading(false);
    }
  }, [filter]);

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

  const counts = useMemo(() => {
    const map = new Map<FilterKey, number>();
    for (const o of orders) {
      map.set(o.status, (map.get(o.status) ?? 0) + 1);
    }
    return map;
  }, [orders]);

  return (
    <View style={styles.root}>
      <AppHeader title="طلبات البيع أونلاين" subtitle="متجر سيلا ماركت" />
      <BackHandlerCloser
        active={detail != null}
        onClose={() => setDetail(null)}
      />
      <View style={styles.content}>
        {/* فلاتر واضحة + مزامنة يدوية */}
        <View style={styles.filterRow}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={styles.chips}>
              {FILTERS.map(f => (
                <TouchableOpacity
                  key={f.key}
                  style={[
                    styles.chip,
                    filter === f.key
                      ? {backgroundColor: c.accent, borderColor: c.accent}
                      : null,
                  ]}
                  onPress={() => setFilter(f.key)}
                  activeOpacity={0.8}>
                  <Text
                    style={[
                      styles.chipText,
                      filter === f.key ? {color: '#FFFFFF'} : null,
                    ]}>
                    {f.label}
                    {counts.get(f.key) != null && filter === f.key
                      ? ` (${counts.get(f.key)})`
                      : ''}
                  </Text>
                </TouchableOpacity>
              ))}
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
        ) : orders.length === 0 ? (
          <EmptyState
            icon="cart"
            title="لا طلبات في هذه الحالة"
            subtitle="الطلبات الجديدة من تطبيق المتجر تصل هنا فوراً مع إشعار"
          />
        ) : (
          <ScrollView contentContainerStyle={styles.listWrap}>
            {orders.map(order => {
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
                <View key={item.product_ref} style={styles.itemRow}>
                  <Text style={styles.itemName}>{item.product_name}</Text>
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
                    onPress={() =>
                      void runAction(async () => {
                        await OnlineStore.deliverOrder(detail);
                        return 'تم تأكيد التسليم — حُوّل المبلغ من الدين إلى الخزينة بسند تحصيل';
                      }, 'deliver')
                    }
                    disabled={busyAction != null}>
                    <Text style={styles.actionBtnText}>
                      تأكيد التسليم (الدين → الخزينة)
                    </Text>
                  </TouchableOpacity>
                  <Text style={styles.hintText}>
                    يُسجّل سند تحصيل بالمبلغ القائم ويُطبع من سجل الخزينة —
                    الإرجاع بعد التسليم يتم من مركز الفواتير على فاتورة{' '}
                    {detail.invoice_ref ?? 'INV-O'} كأي بيع عادي.
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
    },
    chipText: {
      fontFamily: fonts.bold,
      fontSize: 12.5,
      color: c.textDim,
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
