/**
 * MerchantsScreen — حسابات التجار والموردين (الجولة 91 #٢).
 * ─────────────────────────────────────────────────────────────────
 * طلب التاجر: «إضافة وتطوير ميزة جديدة في التطبيق خاصة بتسجيل
 * الفواتير والمستحقات الخاصة بالتجار وصفحة لكل تاجر خاصة به
 * وبالتقارير وكل المميزات والخصائص المتوفرة في الانظمة الاحترافية
 * العالمية بما يتناسب مع تطبيق نقطة البيع أندرويد».
 *
 * البنية (نفس انضباط دفتر الديون + معايير Loyverse/Shopify للموردين):
 *  • سجل التجار: اسم + جوال + هوية (اختيارية) + ملاحظات، بحث فوري.
 *  • صفحة التاجر: كشف حساب كامل بالرصيد الجاري بعد كل حركة
 *    (فاتورة توريد ترفع ما علينا له؛ سداد/مرتجع/تحصيل تخفضه).
 *  • فاتورة التوريد: بنود حرّة (صنف × كمية × سعر) بإجمالي حي.
 *  • السداد والتحصيل عبر قنوات الدفع الفعلية (درج/بنوك/محافظ)
 *    مع سند خزينة مصاحب كي يوازن كشف الخزينة كشف التاجر؛
 *    المرتجع/الخصم بلا حركة خزينة.
 *
 * Overlays هي INLINE absolute views — لا RN Modal أبداً (نفس
 * درس هذا الجهاز مع نوافذ الماسح الأصلي).
 */
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {
  Alert,
  BackHandler,
  Keyboard,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  AppButton,
  AppHeader,
  EmptyState,
  Field,
  SectionTitle,
  StatCard,
} from '../../components/ui';
import {Icon, type IconName} from '../../components/Icon';
import {PaymentMethodIcon} from '../../components/PaymentMethodIcon';
import {
  activePaymentMethods,
  paymentMethodById,
} from '../../core/paymentMethods';
import {useSettingsStore} from '../../stores/settingsStore';
import {CashService} from '../../services/CashService';
import {ExportService} from '../../services/ExportService';
import {
  MerchantRepo,
  type MerchantBalance,
  type MerchantInvoiceItem,
  type MerchantStatementRow,
} from '../../database/repositories/MerchantRepo';
import {formatDateTime, formatMoney} from '../../core/format';
import {fonts, makeStyles, spacing, useThemeColors} from '../../core/theme';
import {useToastStore} from '../../stores/toastStore';

/** Hardware-back closer for INLINE overlays (no Modal API here). */
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

/** نوع الحركة المالية في نافذة «حركة مع التاجر». */
type FinanceKind = 'payment' | 'return' | 'collection' | 'debt';

const FINANCE_OPTIONS: {key: FinanceKind; label: string; icon: IconName}[] = [
  {key: 'debt', label: 'دين مستحق', icon: 'book'},
  {key: 'payment', label: 'سداد له', icon: 'wallet'},
  {key: 'return', label: 'مرتجع / خصم', icon: 'undo'},
  {key: 'collection', label: 'تحصيل منه', icon: 'download'},
];

const KIND_LABELS: Record<string, string> = {
  invoice: 'فاتورة توريد',
  payment: 'سداد له',
  return: 'مرتجع / خصم',
  collection: 'تحصيل منه',
  debt: 'دين مستحق مباشر',
};

/** v79 (الجولة 92 #٤): لون شارة النوع في كشف الحساب — تمييز بصري
 *  فوري لاتجاه الحركة (علينا له / له عندنا) بمعيار الأنظمة
 *  الاحترافية بدل سطر نصي واحد لكل شيء. */
const KIND_TONES: Record<
  string,
  {bg: 'dangerSoft' | 'successSoft' | 'warningSoft' | 'infoSoft'; fg: 'danger' | 'success' | 'warning' | 'info'}
> = {
  invoice: {bg: 'dangerSoft', fg: 'danger'},
  debt: {bg: 'warningSoft', fg: 'warning'},
  payment: {bg: 'successSoft', fg: 'success'},
  return: {bg: 'infoSoft', fg: 'info'},
  collection: {bg: 'successSoft', fg: 'success'},
};

/** بند مسودة في محرر فاتورة التوريد. */
interface DraftItem {
  key: string;
  name: string;
  qty: string;
  price: string;
}

let draftSeq = 0;
function newDraftItem(): DraftItem {
  draftSeq += 1;
  return {key: `i${draftSeq}`, name: '', qty: '1', price: ''};
}

export function MerchantsScreen() {
  const c = useThemeColors();
  const styles = useStyles();
  const toast = useToastStore(state => state.show);
  const paymentMethodsEnabled = useSettingsStore(
    state => state.settings.paymentMethodsEnabled,
  );
  const methods = useMemo(
    () => activePaymentMethods(paymentMethodsEnabled),
    [paymentMethodsEnabled],
  );

  const [list, setList] = useState<MerchantBalance[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);

  // ── إضافة تاجر ──
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState('');
  const [addPhone, setAddPhone] = useState('');
  const [addIdNumber, setAddIdNumber] = useState('');
  const [addNotes, setAddNotes] = useState('');
  const [addBusy, setAddBusy] = useState(false);

  // ── صفحة التاجر (كشف الحساب) ──
  const [detail, setDetail] = useState<MerchantBalance | null>(null);
  const [statement, setStatement] = useState<MerchantStatementRow[] | null>(
    null,
  );

  // ── تعديل تاجر ──
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editIdNumber, setEditIdNumber] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [editBusy, setEditBusy] = useState(false);

  // ── فاتورة توريد ──
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const [invoiceItems, setInvoiceItems] = useState<DraftItem[]>([
    newDraftItem(),
  ]);
  const [invoiceNote, setInvoiceNote] = useState('');
  const [invoiceBusy, setInvoiceBusy] = useState(false);

  // ── حركة مالية (سداد/مرتجع/تحصيل) ──
  const [financeOpen, setFinanceOpen] = useState(false);
  const [financeKind, setFinanceKind] = useState<FinanceKind>('payment');
  const [financeAmount, setFinanceAmount] = useState('');
  const [financeMethod, setFinanceMethod] = useState('cash');
  const [financeNote, setFinanceNote] = useState('');
  const [financeBusy, setFinanceBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const rows = await MerchantRepo.listWithBalances();
      setList(rows);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const refreshDetail = useCallback(async (merchantId: number) => {
    const rows = await MerchantRepo.listWithBalances();
    setList(rows);
    const entry = rows.find(row => row.merchant.id === merchantId);
    if (entry != null) {
      setDetail(entry);
      setStatement(await MerchantRepo.statement(merchantId));
    } else {
      setDetail(null);
      setStatement(null);
    }
  }, []);

  const openDetail = useCallback(async (entry: MerchantBalance) => {
    setDetail(entry);
    setStatement(null);
    setStatement(await MerchantRepo.statement(entry.merchant.id));
  }, []);

  // ── إحصاءات الرأس ──
  const summary = useMemo(() => {
    let owed = 0;
    let credit = 0;
    for (const row of list) {
      if (row.balance > 0.005) {
        owed += row.balance;
      } else if (row.balance < -0.005) {
        credit += Math.abs(row.balance);
      }
    }
    return {owed, credit, count: list.length};
  }, [list]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) {
      return list;
    }
    return list.filter(row => {
      const hay = [
        row.merchant.name,
        row.merchant.phone ?? '',
        row.merchant.id_number ?? '',
        row.merchant.notes ?? '',
      ]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [list, query]);

  // ── إنشاء تاجر ──
  const createMerchant = useCallback(async () => {
    if (addBusy) {
      return;
    }
    if (addName.trim().length === 0) {
      toast('اسم التاجر مطلوب', 'error');
      return;
    }
    setAddBusy(true);
    try {
      const created = await MerchantRepo.createMerchant({
        name: addName,
        phone: addPhone,
        idNumber: addIdNumber,
        notes: addNotes,
      });
      setAddName('');
      setAddPhone('');
      setAddIdNumber('');
      setAddNotes('');
      setAddOpen(false);
      await reload();
      toast(`أُنشئ حساب التاجر «${created.name}»`, 'success');
    } catch (error) {
      Alert.alert(
        'لا يمكن إنشاء الحساب',
        error instanceof Error ? error.message : 'خطأ غير متوقع',
      );
    } finally {
      setAddBusy(false);
    }
  }, [addBusy, addName, addPhone, addIdNumber, addNotes, reload, toast]);

  // ── تعديل تاجر ──
  const openEdit = useCallback((entry: MerchantBalance) => {
    setEditName(entry.merchant.name);
    setEditPhone(entry.merchant.phone ?? '');
    setEditIdNumber(entry.merchant.id_number ?? '');
    setEditNotes(entry.merchant.notes ?? '');
    setEditOpen(true);
  }, []);

  const saveEdit = useCallback(async () => {
    if (editBusy || detail == null) {
      return;
    }
    if (editName.trim().length === 0) {
      toast('اسم التاجر مطلوب', 'error');
      return;
    }
    setEditBusy(true);
    try {
      await MerchantRepo.updateMerchant(detail.merchant.id, {
        name: editName,
        phone: editPhone,
        idNumber: editIdNumber,
        notes: editNotes,
      });
      setEditOpen(false);
      await refreshDetail(detail.merchant.id);
      toast('حُدّثت بيانات التاجر', 'success');
    } catch (error) {
      Alert.alert(
        'لا يمكن حفظ التعديل',
        error instanceof Error ? error.message : 'خطأ غير متوقع',
      );
    } finally {
      setEditBusy(false);
    }
  }, [
    editBusy,
    detail,
    editName,
    editPhone,
    editIdNumber,
    editNotes,
    refreshDetail,
    toast,
  ]);

  // ── حذف تاجر (بلا حركات فقط) ──
  const removeMerchant = useCallback(
    (entry: MerchantBalance) => {
      Alert.alert(
        `حذف «${entry.merchant.name}»؟`,
        'الحذف ممكن فقط لتاجر بلا أي حركات في كشف حسابه.',
        [
          {text: 'إلغاء', style: 'cancel'},
          {
            text: 'حذف',
            style: 'destructive',
            onPress: async () => {
              try {
                await MerchantRepo.deleteMerchant(entry.merchant.id);
                setDetail(null);
                await reload();
                toast('حُذف حساب التاجر', 'success');
              } catch (error) {
                Alert.alert(
                  'لا يمكن الحذف',
                  error instanceof Error
                    ? error.message
                    : 'خطأ غير متوقع',
                );
              }
            },
          },
        ],
      );
    },
    [reload, toast],
  );

  // ── فاتورة توريد ──
  const invoiceTotal = useMemo(() => {
    let sum = 0;
    for (const item of invoiceItems) {
      const qty = Number(item.qty.replace(',', '.')) || 0;
      const price = Number(item.price.replace(',', '.')) || 0;
      sum += qty * price;
    }
    return Math.round(sum * 100) / 100;
  }, [invoiceItems]);

  const openInvoice = useCallback(() => {
    setInvoiceItems([newDraftItem()]);
    setInvoiceNote('');
    setInvoiceOpen(true);
  }, []);

  const saveInvoice = useCallback(async () => {
    if (invoiceBusy || detail == null) {
      return;
    }
    const items: MerchantInvoiceItem[] = [];
    for (const draft of invoiceItems) {
      const name = draft.name.trim();
      const qty = Number(draft.qty.replace(',', '.')) || 0;
      const price = Number(draft.price.replace(',', '.')) || 0;
      if (name.length === 0 && qty <= 1 && price === 0) {
        continue; // بند فارغ بالكامل — يُتجاهل.
      }
      if (name.length === 0 || qty <= 0) {
        toast(
          'أكمل اسم الصنف وكميته في كل بند (أو احذف البند الفارغ)',
          'error',
        );
        return;
      }
      items.push({
        name,
        qty,
        price,
        total: Math.round(qty * price * 100) / 100,
      });
    }
    if (items.length === 0) {
      toast('أضف بنداً واحداً على الأقل', 'error');
      return;
    }
    setInvoiceBusy(true);
    try {
      const movement = await MerchantRepo.addInvoice({
        merchantId: detail.merchant.id,
        items,
        note: invoiceNote,
      });
      setInvoiceOpen(false);
      await refreshDetail(detail.merchant.id);
      toast(
        `سُجلت فاتورة التوريد ${movement.ref} — ${formatMoney(movement.amount)}`,
        'success',
      );
    } catch (error) {
      Alert.alert(
        'تعذر حفظ الفاتورة',
        error instanceof Error ? error.message : 'خطأ غير متوقع',
      );
    } finally {
      setInvoiceBusy(false);
    }
  }, [
    invoiceBusy,
    detail,
    invoiceItems,
    invoiceNote,
    refreshDetail,
    toast,
  ]);

  // ── حركة مالية (سداد / مرتجع / تحصيل) ──
  const openFinance = useCallback((kind: FinanceKind) => {
    setFinanceKind(kind);
    setFinanceAmount('');
    setFinanceMethod('cash');
    setFinanceNote('');
    setFinanceOpen(true);
  }, []);

  const saveFinance = useCallback(async () => {
    if (financeBusy || detail == null) {
      return;
    }
    const amount = Number(financeAmount.replace(',', '.')) || 0;
    if (amount <= 0) {
      toast('أدخل مبلغاً أكبر من صفر', 'error');
      return;
    }
    setFinanceBusy(true);
    try {
      const merchantId = detail.merchant.id;
      const merchantName = detail.merchant.name;
      // v79 (الجولة 92 #٣): الدين المستحق المباشر — بلا فاتورة وبلا
      // حركة خزينة؛ يرفع المستحق له ويُسدّد لاحقاً كأي سداد.
      if (financeKind === 'debt') {
        const movement = await MerchantRepo.addDirectDebt({
          merchantId,
          amount,
          note: financeNote,
        });
        setFinanceOpen(false);
        await refreshDetail(merchantId);
        toast(
          `سُجّل دين مستحق ${movement.ref} — ${formatMoney(amount)} على حساب ${merchantName}`,
          'success',
        );
        return;
      }
      if (financeKind === 'return') {
        await MerchantRepo.addReturn({
          merchantId,
          amount,
          note: financeNote,
        });
        setFinanceOpen(false);
        await refreshDetail(merchantId);
        toast(
          `سُجّل مرتجع/خصم ${formatMoney(amount)} من حساب ${merchantName}`,
          'success',
        );
        return;
      }
      // سداد أو تحصيل — عبر قناة دفع فعلية مع سند خزينة مصاحب
      // يوازن المعادلة (السداد يخرج من القناة والتحصيل يودع فيها).
      const isPayment = financeKind === 'payment';
      const movement = isPayment
        ? await CashService.recordExpense({
            category: 'سداد لتاجر',
            note: `سداد للتاجر ${merchantName}${
              financeNote.trim() ? ` — ${financeNote.trim()}` : ''
            }`,
            amountMinor: Math.round(amount * 100),
            paymentMethod: financeMethod,
          })
        : await CashService.recordDeposit({
            note: `تحصيل من التاجر ${merchantName}${
              financeNote.trim() ? ` — ${financeNote.trim()}` : ''
            }`,
            amountMinor: Math.round(amount * 100),
            paymentMethod: financeMethod,
            category: 'تحصيل من تاجر',
          });
      if (isPayment) {
        await MerchantRepo.addPayment({
          merchantId,
          amount,
          method: financeMethod,
          note: financeNote,
          cashRef: movement.ref,
        });
      } else {
        await MerchantRepo.addCollection({
          merchantId,
          amount,
          method: financeMethod,
          note: financeNote,
          cashRef: movement.ref,
        });
      }
      setFinanceOpen(false);
      await refreshDetail(merchantId);
      toast(
        isPayment
          ? `سُجّل سداد ${formatMoney(amount)} لـ${merchantName} — سند ${movement.ref}`
          : `سُجّل تحصيل ${formatMoney(amount)} من ${merchantName} — سند ${movement.ref}`,
        'success',
      );
    } catch (error) {
      Alert.alert(
        'تعذر تسجيل الحركة',
        error instanceof Error ? error.message : 'خطأ غير متوقع',
      );
    } finally {
      setFinanceBusy(false);
    }
  }, [
    financeBusy,
    detail,
    financeAmount,
    financeKind,
    financeMethod,
    financeNote,
    refreshDetail,
    toast,
  ]);

  const financeNeedsMethod =
    financeKind === 'payment' || financeKind === 'collection';

  // ── v79 (الجولة 92 #٣): تنزيل كشف الحساب — تاجر واحد أو دفتر
  //  التجار ككل، بصيغة Excel أو CSV (نفس منسق تصدير التقارير،
  //  ملف في مجلد التنزيلات يفتح فوراً في Excel). ──
  const exportMerchantStatement = useCallback(
    (merchantId: number, name: string) => {
      Alert.alert(
        `تنزيل كشف حساب «${name}»؟`,
        'ملف كامل بكل الحركات والرصيد الجاري بعد كل حركة وصف الإجماليات — يُحفظ في مجلد التنزيلات.',
        [
          {text: 'إلغاء', style: 'cancel'},
          {
            text: 'ملف Excel',
            onPress: () => {
              void ExportService.exportMerchantStatement(merchantId, 'xls')
                .then(path =>
                  toast(`نُزّل كشف الحساب — ${path}`, 'success'),
                )
                .catch((error: unknown) =>
                  toast(
                    error instanceof Error
                      ? error.message
                      : 'تعذر تنزيل الكشف',
                    'error',
                  ),
                );
            },
          },
          {
            text: 'ملف CSV',
            onPress: () => {
              void ExportService.exportMerchantStatement(merchantId, 'csv')
                .then(path =>
                  toast(`نُزّل كشف الحساب — ${path}`, 'success'),
                )
                .catch((error: unknown) =>
                  toast(
                    error instanceof Error
                      ? error.message
                      : 'تعذر تنزيل الكشف',
                    'error',
                  ),
                );
            },
          },
        ],
      );
    },
    [toast],
  );

  const exportMerchantsBook = useCallback(() => {
    if (list.length === 0) {
      toast('لا تجار مسجلون بعد', 'error');
      return;
    }
    Alert.alert(
      'تنزيل دفتر التجار ككل؟',
      `سطر لكل تاجر من ${list.length} — الرصيد الحالي وتفكيكه الكامل وإجمالي المستحقات.`,
      [
        {text: 'إلغاء', style: 'cancel'},
        {
          text: 'ملف Excel',
          onPress: () => {
            void ExportService.exportMerchantsBook('xls')
              .then(path => toast(`نُزّل دفتر التجار — ${path}`, 'success'))
              .catch((error: unknown) =>
                toast(
                  error instanceof Error ? error.message : 'تعذر التنزيل',
                  'error',
                ),
            );
          },
        },
        {
          text: 'ملف CSV',
          onPress: () => {
            void ExportService.exportMerchantsBook('csv')
              .then(path => toast(`نُزّل دفتر التجار — ${path}`, 'success'))
              .catch((error: unknown) =>
                toast(
                  error instanceof Error ? error.message : 'تعذر التنزيل',
                  'error',
                ),
            );
          },
        },
      ],
    );
  }, [list.length, toast]);

  return (
    <View style={styles.screen}>
      <AppHeader
        title="التجار والموردون"
        subtitle="فواتير التوريد والمستحقات — دفتر ذمم دائن"
      />

      {/* إحصاءات الرأس */}
      <View style={styles.statsRow}>
        <StatCard
          label={`مستحق للتجار الآن · ${summary.count} تاجر`}
          value={formatMoney(summary.owed)}
          tone={summary.owed > 0 ? 'danger' : 'success'}
          icon="store"
        />
        <StatCard
          label="لك عند التجار (دفعات مقدمة)"
          value={formatMoney(summary.credit)}
          tone="success"
          icon="wallet"
        />
      </View>

      {/* البحث + زر الإضافة */}
      <View style={styles.searchRow}>
        <View style={styles.searchWrap}>
          <Icon name="search" size={14} color={c.textFaint} />
          <TextInput
            style={styles.searchInput}
            value={query}
            onChangeText={setQuery}
            placeholder="ابحث بالاسم أو الجوال أو الهوية…"
            placeholderTextColor={c.textFaint}
            returnKeyType="search"
          />
        </View>
        <AppButton
          title="تنزيل الدفتر"
          icon="download"
          small
          variant="secondary"
          onPress={exportMerchantsBook}
        />
        <AppButton
          title="تاجر جديد"
          icon="plus"
          small
          onPress={() => setAddOpen(true)}
        />
      </View>

      {/* القائمة */}
      {loading ? (
        <Text style={styles.emptyText}>جارٍ التحميل…</Text>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon="store"
          title={query.length > 0 ? 'لا نتائج للبحث' : 'لا تجار بعد'}
          subtitle={
            query.length > 0
              ? 'جرّب اسماً أو جزءاً من رقم الجوال'
              : 'أضف تاجرك الأول وسجّل فواتير التوريد ومستحقاته — صفحة كشف حساب خاصة بكل تاجر'
          }
        />
      ) : (
        <ScrollView
          style={styles.list}
          contentContainerStyle={{paddingBottom: spacing.xl}}
          keyboardShouldPersistTaps="handled">
          {filtered.map(entry => (
            <TouchableOpacity
              key={entry.merchant.id}
              style={styles.merchantRow}
              onPress={() => void openDetail(entry)}
              activeOpacity={0.75}>
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>
                  {entry.merchant.name.trim().charAt(0) || 'ت'}
                </Text>
              </View>
              <View style={{flex: 1, minWidth: 0}}>
                <Text style={styles.merchantName} numberOfLines={1}>
                  {entry.merchant.name}
                </Text>
                <Text style={styles.merchantMeta} numberOfLines={1}>
                  {entry.merchant.phone ?? 'بلا جوال'}
                  {entry.merchant.id_number
                    ? ` · هوية ${entry.merchant.id_number}`
                    : ''}
                  {entry.lastAt != null
                    ? ` · آخر حركة ${formatDateTime(entry.lastAt)}`
                    : ' · لا حركات بعد'}
                </Text>
              </View>
              <View style={styles.balanceCol}>
                <Text
                  style={[
                    styles.balanceNum,
                    {
                      color:
                        entry.balance > 0.005
                          ? c.danger
                          : entry.balance < -0.005
                          ? c.success
                          : c.textDim,
                    },
                  ]}>
                  {formatMoney(Math.abs(entry.balance))}
                </Text>
                <Text style={styles.balanceLabel}>
                  {entry.balance > 0.005
                    ? 'مستحق له'
                    : entry.balance < -0.005
                    ? 'لك عنده'
                    : 'مسدد'}
                </Text>
              </View>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      {/* ═══ نافذة إضافة تاجر ═══ */}
      {addOpen ? (
        <>
          <BackHandlerCloser active onClose={() => setAddOpen(false)} />
          <TouchableOpacity
            style={styles.dim}
            activeOpacity={1}
            onPress={() => setAddOpen(false)}
          />
          <View style={styles.sheet}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>تاجر جديد</Text>
            <Field
              label="اسم التاجر *"
              value={addName}
              onChangeText={setAddName}
              placeholder="مثال: شركة الفردوس للتوريد"
            />
            <Field
              label="رقم الجوال"
              value={addPhone}
              onChangeText={text =>
                setAddPhone(text.replace(/[^\d+\s-]/g, '').slice(0, 16))
              }
              keyboardType="phone-pad"
              placeholder="059xxxxxxx"
            />
            <Field
              label="رقم الهوية (اختياري)"
              value={addIdNumber}
              onChangeText={text =>
                setAddIdNumber(text.replace(/\D/g, '').slice(0, 9))
              }
              keyboardType="number-pad"
            />
            <Field
              label="ملاحظات"
              value={addNotes}
              onChangeText={setAddNotes}
              placeholder="نطاق التوريد، شروط السداد…"
              multiline
              numberOfLines={2}
            />
            <AppButton
              title="إنشاء الحساب"
              icon="plus"
              onPress={() => {
                Keyboard.dismiss();
                void createMerchant();
              }}
              loading={addBusy}
            />
          </View>
        </>
      ) : null}

      {/* ═══ صفحة التاجر — كشف الحساب ═══ */}
      {detail != null ? (
        <>
          <BackHandlerCloser
            active
            onClose={() => {
              setDetail(null);
              setStatement(null);
            }}
          />
          <TouchableOpacity
            style={styles.dim}
            activeOpacity={1}
            onPress={() => {
              setDetail(null);
              setStatement(null);
            }}
          />
          <View style={styles.detailSheet}>
            <View style={styles.sheetHandle} />
            <View style={styles.detailHeader}>
              <View style={styles.avatarBig}>
                <Text style={styles.avatarBigText}>
                  {detail.merchant.name.trim().charAt(0) || 'ت'}
                </Text>
              </View>
              <View style={{flex: 1, minWidth: 0}}>
                <Text style={styles.detailName} numberOfLines={1}>
                  {detail.merchant.name}
                </Text>
                <Text style={styles.detailMeta} numberOfLines={2}>
                  {detail.merchant.phone ?? 'بلا جوال'}
                  {detail.merchant.id_number
                    ? ` · هوية ${detail.merchant.id_number}`
                    : ''}
                  {detail.merchant.notes ? ` · ${detail.merchant.notes}` : ''}
                </Text>
              </View>
              {/* v79 (#٤): اتصال مباشر بضغطة — نافذة هاتفية احترافية. */}
              {detail.merchant.phone ? (
                <TouchableOpacity
                  style={styles.phoneButton}
                  activeOpacity={0.7}
                  onPress={() => {
                    void Linking.openURL(
                      `tel:${detail.merchant.phone?.replace(/\s+/g, '')}`,
                    );
                  }}>
                  <Icon name="phone" size={17} color={c.accent} />
                </TouchableOpacity>
              ) : null}
            </View>

            {/* بطاقة الرصيد */}
            <View
              style={[
                styles.balanceCard,
                {
                  borderColor:
                    detail.balance > 0.005
                      ? c.danger
                      : detail.balance < -0.005
                      ? c.success
                      : c.borderSoft,
                },
              ]}>
              <Text style={styles.balanceCardLabel}>
                {detail.balance > 0.005
                  ? 'المستحق له الآن (علينا)'
                  : detail.balance < -0.005
                  ? 'لك عنده (دفعات مقدمة)'
                  : 'الحساب مسدد'}
              </Text>
              <Text
                style={[
                  styles.balanceCardNum,
                  {
                    color:
                      detail.balance > 0.005
                        ? c.danger
                        : detail.balance < -0.005
                        ? c.success
                        : c.textDim,
                  },
                ]}>
                {formatMoney(Math.abs(detail.balance))}
              </Text>
              <Text style={styles.balanceCardBreak}>
                توريد {formatMoney(detail.invoiceTotal)}
                {detail.debtTotal > 0.005
                  ? ` · دين مباشر ${formatMoney(detail.debtTotal)}`
                  : ''}{' '}
                · سداد {formatMoney(detail.paymentTotal)} · مرتجع/خصم{' '}
                {formatMoney(detail.returnTotal)} · تحصيل{' '}
                {formatMoney(detail.collectionTotal)}
              </Text>
            </View>

            {/* أزرار العمليات */}
            <View style={styles.actionsRow}>
              <AppButton
                title="فاتورة توريد"
                icon="plus"
                small
                onPress={openInvoice}
              />
              <AppButton
                title="دين مستحق"
                icon="book"
                small
                variant="secondary"
                onPress={() => openFinance('debt')}
              />
            </View>
            <View style={styles.actionsRow}>
              <AppButton
                title="سداد له"
                icon="wallet"
                small
                variant="secondary"
                onPress={() => openFinance('payment')}
              />
              <AppButton
                title="مرتجع/خصم"
                icon="undo"
                small
                variant="secondary"
                onPress={() => openFinance('return')}
              />
            </View>
            <View style={styles.actionsRow}>
              <AppButton
                title="تحصيل منه"
                icon="download"
                small
                variant="secondary"
                onPress={() => openFinance('collection')}
              />
              <AppButton
                title="تنزيل الكشف"
                icon="download"
                small
                variant="ghost"
                onPress={() =>
                  exportMerchantStatement(
                    detail.merchant.id,
                    detail.merchant.name,
                  )
                }
              />
            </View>
            <View style={styles.actionsRow}>
              <AppButton
                title="تعديل البيانات"
                icon="edit"
                small
                variant="ghost"
                onPress={() => openEdit(detail)}
              />
              <AppButton
                title="حذف التاجر"
                icon="trash"
                small
                variant="danger"
                onPress={() => removeMerchant(detail)}
              />
            </View>

            {/* كشف الحساب */}
            <SectionTitle title="كشف الحساب" hint="الرصيد الجاري بعد كل حركة" />
            <ScrollView
              style={styles.historyList}
              contentContainerStyle={{gap: 8}}
              keyboardShouldPersistTaps="handled">
              {statement == null ? (
                <Text style={styles.emptyText}>جارٍ تحميل الكشف…</Text>
              ) : statement.length === 0 ? (
                <Text style={styles.emptyText}>
                  لا حركات بعد — ابدأ بفاتورة توريد أو سداد
                </Text>
              ) : (
                statement.map(row => {
                  const tone = KIND_TONES[row.movement.kind];
                  const positive =
                    row.movement.kind === 'invoice' ||
                    row.movement.kind === 'debt';
                  return (
                  <View key={row.movement.id} style={styles.historyRow}>
                    <View style={{flex: 1, minWidth: 0}}>
                      {/* v79 (#٤): شارة نوع ملونة + المرجع — قراءة فورية */}
                      <View style={styles.historyHead}>
                        {tone ? (
                          <View
                            style={[styles.kindBadge, {backgroundColor: c[tone.bg]}]}>
                            <Text
                              style={[
                                styles.kindBadgeText,
                                {color: c[tone.fg]},
                              ]}>
                              {KIND_LABELS[row.movement.kind]}
                            </Text>
                          </View>
                        ) : null}
                        <Text style={styles.historyRef} numberOfLines={1}>
                          {row.movement.ref}
                        </Text>
                      </View>
                      <Text style={styles.historyMeta} numberOfLines={1}>
                        {formatDateTime(row.movement.createdAt)}
                        {row.movement.method != null &&
                        row.movement.method !== 'cash'
                          ? ` · ${paymentMethodById(row.movement.method).label}`
                          : ''}
                        {row.movement.note ? ` · ${row.movement.note}` : ''}
                        {row.movement.cashRef
                          ? ` · سند ${row.movement.cashRef}`
                          : ''}
                      </Text>
                      {row.movement.items != null &&
                      row.movement.items.length > 0 ? (
                        <Text style={styles.historyItems} numberOfLines={2}>
                          {row.movement.items
                            .map(item => `${item.name} ×${item.qty}`)
                            .join(' · ')}
                        </Text>
                      ) : null}
                    </View>
                    <View style={styles.historyAmounts}>
                      <Text
                        style={[
                          styles.historyAmount,
                          {
                            color: positive ? c.danger : c.success,
                          },
                        ]}>
                        {positive ? '+' : '−'}
                        {formatMoney(row.movement.amount)}
                      </Text>
                      <Text style={styles.historyRunning}>
                        {formatMoney(row.runningBalance)}
                      </Text>
                    </View>
                  </View>
                  );
                })
              )}
            </ScrollView>
          </View>
        </>
      ) : null}

      {/* ═══ نافذة تعديل التاجر ═══ */}
      {editOpen && detail != null ? (
        <>
          <BackHandlerCloser active onClose={() => setEditOpen(false)} />
          <TouchableOpacity
            style={styles.dim}
            activeOpacity={1}
            onPress={() => setEditOpen(false)}
          />
          <View style={styles.sheet}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>
              تعديل بيانات «{detail.merchant.name}»
            </Text>
            <Text style={styles.sheetHint}>
              كشف الحساب والرصيد لا يتأثران بالتعديل — البيانات التعريفية فقط.
            </Text>
            <Field
              label="اسم التاجر *"
              value={editName}
              onChangeText={setEditName}
            />
            <Field
              label="رقم الجوال"
              value={editPhone}
              onChangeText={setEditPhone}
              keyboardType="phone-pad"
            />
            <Field
              label="رقم الهوية (اختياري)"
              value={editIdNumber}
              onChangeText={text =>
                setEditIdNumber(text.replace(/\D/g, '').slice(0, 9))
              }
              keyboardType="number-pad"
            />
            <Field
              label="ملاحظات"
              value={editNotes}
              onChangeText={setEditNotes}
              multiline
              numberOfLines={2}
            />
            <AppButton
              title="حفظ التعديل"
              icon="check"
              onPress={() => {
                Keyboard.dismiss();
                void saveEdit();
              }}
              loading={editBusy}
            />
          </View>
        </>
      ) : null}

      {/* ═══ نافذة فاتورة التوريد ═══ */}
      {invoiceOpen && detail != null ? (
        <>
          <BackHandlerCloser active onClose={() => setInvoiceOpen(false)} />
          <TouchableOpacity
            style={styles.dim}
            activeOpacity={1}
            onPress={() => setInvoiceOpen(false)}
          />
          <View style={styles.invoiceSheet}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>
              فاتورة توريد — {detail.merchant.name}
            </Text>
            <ScrollView
              style={{flexGrow: 0, maxHeight: 320}}
              contentContainerStyle={{gap: 8}}
              keyboardShouldPersistTaps="handled">
              {invoiceItems.map((item, index) => (
                <View key={item.key} style={styles.invoiceItemRow}>
                  <View style={{flex: 1, minWidth: 0}}>
                    <Field
                      label={`الصنف ${index + 1}`}
                      value={item.name}
                      onChangeText={text =>
                        setInvoiceItems(rows =>
                          rows.map(row =>
                            row.key === item.key
                              ? {...row, name: text}
                              : row,
                          ),
                        )
                      }
                      placeholder="اسم الصنف من التوريد"
                    />
                    <View style={styles.itemNumRow}>
                      <View style={{flex: 1}}>
                        <Field
                          label="الكمية"
                          value={item.qty}
                          onChangeText={text =>
                            setInvoiceItems(rows =>
                              rows.map(row =>
                                row.key === item.key
                                  ? {...row, qty: text.replace(/[^\d.,]/g, '')}
                                  : row,
                              ),
                            )
                          }
                          keyboardType="decimal-pad"
                        />
                      </View>
                      <View style={{flex: 1}}>
                        <Field
                          label="سعر الوحدة"
                          value={item.price}
                          onChangeText={text =>
                            setInvoiceItems(rows =>
                              rows.map(row =>
                                row.key === item.key
                                  ? {
                                      ...row,
                                      price: text.replace(/[^\d.,]/g, ''),
                                    }
                                  : row,
                              ),
                            )
                          }
                          keyboardType="decimal-pad"
                        />
                      </View>
                    </View>
                    {/* v79 (#٤): إجمالي السطر حيّاً — فاتورة تُقرأ كجدول
                        محاسبي لا كحقول متناثرة. */}
                    <Text style={styles.itemLineTotal}>
                      إجمالي السطر:{' '}
                      <Text style={{color: c.accent, fontFamily: fonts.bold}}>
                        {formatMoney(
                          (Number(item.qty.replace(',', '.')) || 0) *
                            (Number(item.price.replace(',', '.')) || 0),
                        )}
                      </Text>
                    </Text>
                  </View>
                  <TouchableOpacity
                    style={styles.itemRemove}
                    onPress={() =>
                      setInvoiceItems(rows =>
                        rows.filter(row => row.key !== item.key),
                      )
                    }
                    disabled={invoiceItems.length === 1}>
                    <Icon
                      name="trash"
                      size={14}
                      color={
                        invoiceItems.length === 1 ? c.textFaint : c.danger
                      }
                    />
                  </TouchableOpacity>
                </View>
              ))}
              <AppButton
                title="إضافة بند"
                icon="plus"
                small
                variant="secondary"
                onPress={() =>
                  setInvoiceItems(rows => [...rows, newDraftItem()])
                }
              />
              <Field
                label="ملاحظة (اختياري)"
                value={invoiceNote}
                onChangeText={setInvoiceNote}
                placeholder="رقم فاتورة التاجر، شروط…"
              />
            </ScrollView>
            <View style={styles.invoiceTotalRow}>
              <Text style={styles.invoiceTotalLabel}>إجمالي الفاتورة</Text>
              <Text style={styles.invoiceTotalNum}>
                {formatMoney(invoiceTotal)}
              </Text>
            </View>
            <AppButton
              title={`حفظ الفاتورة — ${formatMoney(invoiceTotal)}`}
              icon="check"
              onPress={() => {
                Keyboard.dismiss();
                void saveInvoice();
              }}
              loading={invoiceBusy}
            />
          </View>
        </>
      ) : null}

      {/* ═══ نافذة الحركة المالية ═══ */}
      {financeOpen && detail != null ? (
        <>
          <BackHandlerCloser active onClose={() => setFinanceOpen(false)} />
          <TouchableOpacity
            style={styles.dim}
            activeOpacity={1}
            onPress={() => setFinanceOpen(false)}
          />
          <View style={styles.sheet}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>
              حركة مع «{detail.merchant.name}»
            </Text>
            {/* نوع الحركة */}
            <View style={styles.chipRow}>
              {FINANCE_OPTIONS.map(option => (
                <TouchableOpacity
                  key={option.key}
                  style={[
                    styles.kindChip,
                    financeKind === option.key ? styles.kindChipActive : null,
                  ]}
                  onPress={() => setFinanceKind(option.key)}>
                  <Icon
                    name={option.icon}
                    size={12}
                    color={financeKind === option.key ? c.accent : c.textDim}
                  />
                  <Text
                    style={[
                      styles.kindChipText,
                      financeKind === option.key ? {color: c.accent} : null,
                    ]}>
                    {option.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            <Text style={styles.sheetHint}>
              {financeKind === 'debt'
                ? 'التزام مالي مباشر على حساب التاجر بلا فاتورة توريد (رسوم، نقد، توريد ضاعت فاتورته) — يرفع المستحق له ولا يمس الخزينة.'
                : financeKind === 'payment'
                ? 'يدفع من قناة الدفع المختارة (يُسجل سند صرف في الخزينة) ويخفض ما علينا للتاجر.'
                : financeKind === 'return'
                ? 'أرجعنا له بضاعة أو حصلنا خصماً — يخفض الرصيد بلا حركة خزينة.'
                : 'أعطانا نقوداً (تسبيق/تسوية) — يُودع في القناة المختارة ويخفض الرصيد.'}
            </Text>
            <Field
              label="المبلغ (₪) *"
              value={financeAmount}
              onChangeText={text => setFinanceAmount(text.replace(/[^\d.,]/g, ''))}
              keyboardType="decimal-pad"
            />
            {financeNeedsMethod ? (
              <View style={styles.methodGroup}>
                <Text style={styles.methodLabel}>
                  {financeKind === 'payment' ? 'الدفع من قناة' : 'الإيداع في قناة'}
                </Text>
                <View style={styles.methodRow}>
                  {methods.map(method => (
                    <TouchableOpacity
                      key={method.id}
                      style={[
                        styles.methodChip,
                        financeMethod === method.id
                          ? styles.methodChipActive
                          : null,
                      ]}
                      onPress={() => setFinanceMethod(method.id)}>
                      <PaymentMethodIcon method={method} size={26} />
                      <Text
                        style={[
                          styles.methodChipText,
                          financeMethod === method.id
                            ? {color: c.accent}
                            : null,
                        ]}>
                        {method.label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            ) : null}
            <Field
              label="ملاحظة (اختياري)"
              value={financeNote}
              onChangeText={setFinanceNote}
              placeholder="مرجع التحويل، رقم الشيك…"
            />
            <AppButton
              title={
                financeKind === 'debt'
                  ? 'تسجيل الدين المستحق'
                  : financeKind === 'payment'
                  ? 'تسجيل السداد'
                  : financeKind === 'return'
                  ? 'تسجيل المرتجع/الخصم'
                  : 'تسجيل التحصيل'
              }
              icon="check"
              onPress={() => {
                Keyboard.dismiss();
                void saveFinance();
              }}
              loading={financeBusy}
            />
          </View>
        </>
      ) : null}
    </View>
  );
}

// ── الأنماط ────────────────────────────────────────────────────────
const useStyles = makeStyles(c =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: c.bg,
    },
    statsRow: {
      flexDirection: 'row',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingTop: spacing.sm,
    },
    searchRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    searchWrap: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: c.surface,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.borderSoft,
      paddingHorizontal: 12,
      height: 42,
    },
    searchInput: {
      flex: 1,
      color: c.text,
      fontFamily: fonts.regular,
      fontSize: 13,
      padding: 0,
    },
    list: {
      flex: 1,
      paddingHorizontal: spacing.md,
    },
    merchantRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      backgroundColor: c.surface,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: c.borderSoft,
      padding: 12,
      marginBottom: 8,
    },
    avatar: {
      width: 40,
      height: 40,
      borderRadius: 12,
      backgroundColor: c.accentSoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    avatarText: {
      color: c.accent,
      fontFamily: fonts.black,
      fontSize: 16,
    },
    merchantName: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: 14,
    },
    merchantMeta: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: 11,
      marginTop: 2,
    },
    balanceCol: {
      alignItems: 'flex-end',
    },
    balanceNum: {
      fontFamily: fonts.black,
      fontSize: 14,
      fontVariant: ['tabular-nums'],
    },
    balanceLabel: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: 10.5,
      marginTop: 1,
    },
    emptyText: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: 12.5,
      textAlign: 'center',
      paddingVertical: spacing.lg,
    },
    // ── نوافذ INLINE ──
    dim: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(0,0,0,0.55)',
    },
    sheet: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: c.surface,
      borderTopLeftRadius: 22,
      borderTopRightRadius: 22,
      borderWidth: 1,
      borderColor: c.borderSoft,
      padding: spacing.md,
      gap: spacing.sm,
      maxHeight: '88%',
    },
    detailSheet: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: c.surface,
      borderTopLeftRadius: 22,
      borderTopRightRadius: 22,
      borderWidth: 1,
      borderColor: c.borderSoft,
      padding: spacing.md,
      maxHeight: '94%',
    },
    invoiceSheet: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: c.surface,
      borderTopLeftRadius: 22,
      borderTopRightRadius: 22,
      borderWidth: 1,
      borderColor: c.borderSoft,
      padding: spacing.md,
      maxHeight: '90%',
    },
    sheetHandle: {
      alignSelf: 'center',
      width: 40,
      height: 4,
      borderRadius: 2,
      backgroundColor: c.borderSoft,
      marginBottom: 6,
    },
    sheetTitle: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: 15,
    },
    sheetHint: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: 11.5,
      lineHeight: 17,
    },
    // ── صفحة التاجر ──
    detailHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    avatarBig: {
      width: 52,
      height: 52,
      borderRadius: 16,
      backgroundColor: c.accentSoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    avatarBigText: {
      color: c.accent,
      fontFamily: fonts.black,
      fontSize: 20,
    },
    detailName: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: 16,
    },
    detailMeta: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: 11,
      marginTop: 2,
    },
    balanceCard: {
      borderWidth: 1,
      borderRadius: 14,
      padding: 12,
      marginTop: 10,
      alignItems: 'center',
      backgroundColor: c.surfaceAlt,
    },
    balanceCardLabel: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: 11.5,
    },
    balanceCardNum: {
      fontFamily: fonts.black,
      fontSize: 24,
      fontVariant: ['tabular-nums'],
      marginTop: 2,
    },
    balanceCardBreak: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: 10.5,
      marginTop: 4,
      textAlign: 'center',
    },
    actionsRow: {
      flexDirection: 'row',
      gap: 6,
      marginTop: 8,
    },
    historyList: {
      flexGrow: 0,
      maxHeight: 250,
      marginTop: 4,
    },
    historyRow: {
      flexDirection: 'row',
      gap: 8,
      backgroundColor: c.surfaceAlt,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.borderSoft,
      padding: 10,
    },
    /* v79 (#٤): رأس صف الكشف — شارة نوع ملونة + المرجع. */
    historyHead: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      flexWrap: 'wrap',
    },
    kindBadge: {
      borderRadius: 6,
      paddingHorizontal: 7,
      paddingVertical: 2.5,
    },
    kindBadgeText: {
      fontFamily: fonts.bold,
      fontSize: 10,
    },
    phoneButton: {
      width: 38,
      height: 38,
      borderRadius: 12,
      backgroundColor: c.accentSoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    historyRef: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: 12.5,
    },
    historyMeta: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: 10.5,
      marginTop: 1,
    },
    historyItems: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: 10.5,
      marginTop: 3,
    },
    historyAmounts: {
      alignItems: 'flex-end',
    },
    historyAmount: {
      fontFamily: fonts.bold,
      fontSize: 13,
      fontVariant: ['tabular-nums'],
    },
    historyRunning: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: 10.5,
      marginTop: 2,
      fontVariant: ['tabular-nums'],
    },
    // ── فاتورة التوريد ──
    invoiceItemRow: {
      flexDirection: 'row',
      gap: 6,
      alignItems: 'flex-start',
    },
    itemNumRow: {
      flexDirection: 'row',
      gap: 8,
    },
    /* v79 (#٤): إجمالي السطر الحيّ في محرر فاتورة التوريد. */
    itemLineTotal: {
      color: c.textDim,
      fontFamily: fonts.medium,
      fontSize: 11,
      marginTop: 2,
      textAlign: 'left',
    },
    itemRemove: {
      width: 34,
      height: 34,
      borderRadius: 10,
      backgroundColor: c.surfaceAlt,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 18,
    },
    invoiceTotalRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      backgroundColor: c.accentSoft,
      borderRadius: 12,
      padding: 12,
      marginVertical: 8,
    },
    invoiceTotalLabel: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: 13,
    },
    invoiceTotalNum: {
      color: c.accent,
      fontFamily: fonts.black,
      fontSize: 18,
      fontVariant: ['tabular-nums'],
    },
    // ── الحركة المالية ──
    chipRow: {
      flexDirection: 'row',
      gap: 6,
      flexWrap: 'wrap',
    },
    kindChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 12,
      height: 34,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: c.borderSoft,
      backgroundColor: c.surfaceAlt,
    },
    kindChipActive: {
      borderColor: c.accent,
    },
    kindChipText: {
      fontFamily: fonts.bold,
      fontSize: 12,
      color: c.textDim,
    },
    methodGroup: {
      marginTop: 2,
    },
    methodLabel: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: 12,
      marginBottom: 6,
    },
    methodRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
    },
    methodChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 10,
      height: 40,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.borderSoft,
      backgroundColor: c.surfaceAlt,
    },
    methodChipActive: {
      borderColor: c.accent,
    },
    methodChipText: {
      fontFamily: fonts.bold,
      fontSize: 11.5,
      color: c.textDim,
    },
  }),
);
