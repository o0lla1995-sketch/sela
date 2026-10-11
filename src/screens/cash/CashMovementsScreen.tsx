/**
 * CashMovementsScreen — v25 (round-32 #3) الخزينة والمصروفات.
 * ─────────────────────────────────────────────────────────────────
 * نظام المصروفات والسحب من الخزينة، على نمط الأنظمة العالمية
 * (Loyverse Cash Drawer / Square Cash Management):
 *
 *   • النقد المتوقع بالدرج الآن — بعد خصم كل المصروفات والمسحوبات
 *     وإضافة الإيداعات (نفس معادلة الرئيسية، لحظة بلحظة).
 *   • ثلاث حركات موثقة بسندات مرقمة: مصروف (EXP-) بسلة فئات،
 *     سحب رصيد (WD-)، وإيداع (DEP-) — وكل واحدة منها (v27)
 *     مؤمّنة بالبصمة أولاً ثم برمز PIN، مع تنبيه واضح للتاجر
 *     لتفعيل الحماية حين لا يكون أي منها مفعّلاً.
 *   • لا حركة تتجاوز ما في الدرج فعلياً — سقف صارم يمنع أي فقدان.
 *   • السجل غير قابل للتعديل (مسار تدقيق) — كل سند يعرض طريقة
 *     التأمين المستخدمة عند السحب.
 *   • كشف PDF عربي A4 للفترة + مشاركة + طباعة نظام + طباعة
 *     حرارية سريعة للجيب.
 *
 * ROM discipline: كل النوافذ INLINE absolute overlays — أبداً RN
 * Modal (نفس درس روم الجهاز من v24: المودال تسوّده بعد الماسح).
 *
 * v29 (round-37 #1) — الدرس النهائي للوحة المفاتيح: المبلغ يُدخل
 * من لوحة أرقام مدمجة داخل النافذة (نفس نمط v9.2 للوزن —
 * Loyverse/Square) ولا يوجد أي TextInput للمبلغ أصلاً، وارتفاع
 * النافذة ثابت، وصفر مستمعات Keyboard في الشاشة كلها.
 *
 * v31 (round-39 #2) — لوحة الأرقام لا تختفي أبداً: أُلغي إخفاء
 * لوحة الأرقام أثناء تركيز الملاحظة/الفئة المخصصة (طلب التاجر،
 * وهو أيضاً بنمط قاتل الـ IME على روم الجهاز — أي تغيّر شجرة
 * لحظة التركيز يغلق اللوحة). الملاحظة والفئة المخصصة مثبّتان
 * تحت المبلغ كسطر واحد مضغوط فيبقيان مرئيين فوق لوحة النظام،
 * والفئات وحدها في الوسط القابل للتمرير — الشجرة كاملة ثابتة
 * مهما فُتح أو أُغلق من لوحات.
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  ActivityIndicator,
  Animated,
  BackHandler,
  I18nManager,
  Image as RNImage,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  ViewStyle,
  useWindowDimensions,
} from 'react-native';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {
  AppButton,
  AppHeader,
  Badge,
  Card,
  EmptyState,
  SectionTitle,
  Segmented,
} from '../../components/ui';
import {Icon} from '../../components/Icon';
import {PinPad} from '../../components/PinPad';
import {CashService, EXPENSE_CATEGORIES, authorizeWithBiometric, verifyWithdrawalPin, movementSecurityMode} from '../../services/CashService';
import {CashRepo} from '../../database/repositories/CashRepo';
import {useAppLockStore} from '../../stores/appLockStore';
import {useToastStore} from '../../stores/toastStore';
import {usePrinterStore} from '../../stores/printerStore';
import {
  fonts,
  makeStyles,
  radius,
  spacing,
  typography,
  useThemeColors,
} from '../../core/theme';
import {
  formatDateTime,
  formatMoney,
  localDateShift,
  localMonthStart,
  localToday,
} from '../../core/format';
/** v29 (round-37 #1): لوحة أرقام المبلغ المدمجة — منطق صافٍ قابل
 *  للاختبار (نفس شبكة لوحة الوزن في نقطة البيع). */
import {AMOUNT_KEYPAD_KEYS, amountTextToMinor, applyAmountKey} from '../../core/amountKeypad';
/** v46: تصوير السند بالماسح الأصلي (كاميرا ملء الشاشة بمصرّح
 *  مسبق — نفس مسار بصمات المنتجات المجرب). */
import {capturePhoto} from '../../services/vision/scanFlow';
/** v46: وحدة انتقاء الصور (المعرض) + أدوات الملفات (تنظيف الملفات
 *  اليتيمة والتحقق من وجود صورة السند عند المراجعة). */
import {
  PlatformUtilsNative,
  SelaImagePickerNative,
} from '../../native/nativeBridge';
import type {
  CashMovementKind,
  CashMovementRecord,
  CashMovementTotals,
} from '../../core/types';

/** v46: مسار ملف محلي → uri قابل للعرض في <Image> (نفس نمط
 *  ProductForm المجرب: file:// + المسار المطلق). */
function fileUri(path: string): string {
  return path.startsWith('file:') ? path : `file://${path}`;
}

/** v46: حذف صامت لملف مؤقت — لا يرمي أبداً (يُستدعى من مسارات
 *  التنظيف فقط، وأي فشل فيه لا يبرر تعطيل تدفق المستخدم). */
async function deleteQuiet(path: string): Promise<void> {
  try {
    await PlatformUtilsNative?.deleteFile(path);
  } catch {
    // تجاهل مقصود — تنظيف أفضل-جهد.
  }
}

/** v46: سقف البعد الأطول لصورة السند المحفوظة — يكفي لقراءة سند
 *  A4 صورةً واضحة ويبقي الملف خفيفاً (150-400KB عادة). */
const VOUCHER_MAX_DIM = 1600;

type PeriodKey = 'today' | 'week' | 'month' | 'all';

const PERIOD_OPTIONS: {value: PeriodKey; label: string}[] = [
  {value: 'today', label: 'اليوم'},
  {value: 'week', label: '7 أيام'},
  {value: 'month', label: 'الشهر'},
  {value: 'all', label: 'الكل'},
];

type KindFilter = 'all' | CashMovementKind;

/** v33 (round-41 #7): الصفحة الأولى = آخر 10 حركات فقط («يظهر
 *  اخر 10 حركات في المدة») — وكلما نزل التاجر للأسفل تُضاف صفحة
 *  تلقائياً (onScroll قرب القاع) بلا أي زر. الصفحات اللاحقة أكبر
 *  (30) كي يكبر السجل بسرعة عند التمرير الطويل. */
const LEDGER_PAGE = 10;
const LEDGER_PAGE_MORE = 30;
/** المسافة من قاع الشاشة (px) التي تُطلق تحميل الصفحة التالية. */
const LEDGER_AUTOSCROLL_PX = 520;

const KIND_CHIPS: {key: KindFilter; label: string}[] = [
  {key: 'all', label: 'الكل'},
  {key: 'expense', label: 'مصروفات'},
  {key: 'withdrawal', label: 'سحب رصيد'},
  {key: 'deposit', label: 'إيداعات'},
];

/** v39 (الجولة 47): شرائح فلترة الفئة — نقاط المصروف كاملة (طلب
 *  التاجر: «البحث في سجل الحركات من خلال... ما اختاره من نقاط في
 *  اصرف») مع فئتي السحب والإيداع الثابتتين. */
const FILTER_CATEGORIES: string[] = [
  ...EXPENSE_CATEGORIES,
  'سحب رصيد',
  'إيداع نقدي',
];

const KIND_META: Record<
  CashMovementKind,
  {
    label: string;
    icon: 'send' | 'download' | 'wallet';
    tone: 'danger' | 'success' | 'warning';
  }
> = {
  expense: {label: 'مصروف', icon: 'send', tone: 'danger'},
  withdrawal: {label: 'سحب رصيد', icon: 'wallet', tone: 'warning'},
  deposit: {label: 'إيداع', icon: 'download', tone: 'success'},
};

const AUTH_LABEL: Record<string, string> = {
  fingerprint: 'بصمة',
  pin: 'رمز PIN',
  none: 'بدون تأمين',
};

function periodRange(key: PeriodKey): {from: string; to: string} {
  const today = localToday();
  switch (key) {
    case 'today':
      return {from: today, to: today};
    case 'week':
      return {from: localDateShift(-6), to: today};
    case 'month':
      return {from: localMonthStart(), to: today};
    default:
      return {from: '2000-01-01', to: today};
  }
}

export function CashMovementsScreen() {
  const c = useThemeColors();
  const styles = useStyles();
  const toast = useToastStore(state => state.show);
  const printerStatus = usePrinterStore(state => state.status);
  // v27 (round-35 #3): the unsecured badge jumps to the security
  // settings («تنبيه التاجر لتفعيلهم»).
  const navigation = useNavigation<any>();

  const [period, setPeriod] = useState<PeriodKey>('month');
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  // v39 (الجولة 47): البحث في سجل الحركات — نص حر (الملاحظة/السند/
  //  الفئة) وفلتر فئة (نقاط الاصرف) — طلب التاجر نصاً: «البحث في
  //  سجل الحركات من خلال الملاحظة او ما اختاره من نقاط في اصرف».
  const [searchText, setSearchText] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  /** v39: نافذة مراجعة حركة من السجل — تفتح بالضغط على صف السند. */
  const [detailRow, setDetailRow] = useState<CashMovementRecord | null>(null);
  const [reprintBusy, setReprintBusy] = useState(false);
  /** v46: عارض صورة السند ملء الشاشة (من نافذة المراجعة). */
  const [viewerPhoto, setViewerPhoto] = useState<{
    path: string;
    label: string;
  } | null>(null);
  const [rows, setRows] = useState<CashMovementRecord[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [totals, setTotals] = useState<CashMovementTotals | null>(null);
  const [drawerMinor, setDrawerMinor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  /** The open entry sheet's mode (null = closed). */
  const [sheetMode, setSheetMode] = useState<CashMovementKind | null>(null);
  /** v25: the created-PDF chooser (share / system print / thermal). */
  const [pdfReady, setPdfReady] = useState(false);

  const range = useMemo(() => periodRange(period), [period]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // v26 (round-34 #5): the ledger loads ONE page (newest first)
      // plus the period's TOTAL count — years of accumulated
      // vouchers no longer mount in one shot; «تحميل المزيد» appends
      // the next page on demand.
      // v39: البحث الحر وفلتر الفئة يسريان على الصفحة والعدّ معاً.
      const [page, count, totalsAll, drawer] = await Promise.all([
        CashRepo.list({
          from: range.from,
          to: range.to,
          kind: kindFilter,
          limit: LEDGER_PAGE,
          offset: 0,
          search: appliedSearch,
          category: categoryFilter,
        }),
        CashRepo.countFor(
          range.from,
          range.to,
          kindFilter,
          appliedSearch,
          categoryFilter,
        ),
        CashService.statement(range.from, range.to),
        CashService.drawerNowMinor(),
      ]);
      setRows(page);
      setTotalCount(count);
      setTotals(totalsAll.totals);
      setDrawerMinor(drawer);
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'تعذر تحميل حركات الخزينة',
        'error',
      );
    } finally {
      setLoading(false);
    }
  }, [range, kindFilter, appliedSearch, categoryFilter, toast]);

  /** v39 (الجولة 47): مهلة قصيرة للبحث — الكتابة الهادئة تطلق
   *  البحث تلقائياً بعد 450ms بلا زر (بلا استعجال على كل حرف). */
  useEffect(() => {
    const timer = setTimeout(() => {
      setAppliedSearch(searchText.trim());
    }, 450);
    return () => clearTimeout(timer);
  }, [searchText]);

  /** v26 (round-34 #5): appends the next page of the ledger. */
  const loadMore = useCallback(async () => {
    if (loadingMore || loading || rows.length >= totalCount) {
      return;
    }
    setLoadingMore(true);
    try {
      const page = await CashRepo.list({
        from: range.from,
        to: range.to,
        kind: kindFilter,
        limit: rows.length === 0 ? LEDGER_PAGE : LEDGER_PAGE_MORE,
        offset: rows.length,
        search: appliedSearch,
        category: categoryFilter,
      });
      setRows(prev =>
        page.length === 0
          ? prev
          : [...prev, ...page.filter(r => !prev.some(p => p.local_id === r.local_id))],
      );
      if (page.length < LEDGER_PAGE_MORE) {
        // Everything loaded — pin the counter to the real total.
        const count = await CashRepo.countFor(
          range.from,
          range.to,
          kindFilter,
          appliedSearch,
          categoryFilter,
        );
        setTotalCount(count);
      }
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'تعذر تحميل المزيد',
        'error',
      );
    } finally {
      setLoadingMore(false);
    }
  }, [
    loadingMore,
    loading,
    rows.length,
    totalCount,
    range,
    kindFilter,
    appliedSearch,
    categoryFilter,
    toast,
  ]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const filteredTotals = useMemo(() => {
    if (totals == null) {
      return null;
    }
    if (kindFilter === 'expense') {
      return {
        label: 'مصروفات الفترة',
        minor: totals.expensesMinor,
        count: totals.expensesCount,
      };
    }
    if (kindFilter === 'withdrawal') {
      return {
        label: 'مسحوبات الفترة',
        minor: totals.withdrawalsMinor,
        count: totals.withdrawalsCount,
      };
    }
    if (kindFilter === 'deposit') {
      return {
        label: 'إيداعات الفترة',
        minor: totals.depositsMinor,
        count: totals.depositsCount,
      };
    }
    return {
      label: 'صافي الحركة (إيداعات − مصروفات − مسحوبات)',
      minor: totals.netMinor,
      count:
        totals.expensesCount + totals.withdrawalsCount + totals.depositsCount,
    };
  }, [totals, kindFilter]);

  /** v25: creates the A4 PDF then offers share / print. */
  const exportPdf = useCallback(async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      const location = await CashService.exportStatementPdf(
        range.from,
        range.to,
      );
      toast(`أُنشئ كشف PDF: ${location}`, 'success', 5000);
      setPdfReady(true);
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'فشل إنشاء كشف PDF',
        'error',
      );
    } finally {
      setBusy(false);
    }
  }, [busy, range, toast]);

  const sharePdf = useCallback(async () => {
    try {
      await CashService.shareStatementPdf(range.from, range.to);
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'تعذّرت مشاركة الكشف',
        'error',
      );
    }
  }, [range, toast]);

  const printPdf = useCallback(async () => {
    try {
      await CashService.printStatementPdf(range.from, range.to);
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'تعذّرت طباعة الكشف',
        'error',
      );
    }
  }, [range, toast]);

  const printThermal = useCallback(async () => {
    if (printerStatus !== 'connected') {
      toast('لا توجد طابعة متصلة — أوصل الطابعة أولاً', 'error');
      return;
    }
    try {
      await CashService.printStatementThermal(range.from, range.to);
      toast('طُبع كشف الخزينة على الطابعة الحرارية', 'success');
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'فشلت الطباعة الحرارية',
        'error',
      );
    }
  }, [printerStatus, range, toast]);

  const onMovementDone = useCallback(
    async (movement: CashMovementRecord) => {
      setSheetMode(null);
      const meta = KIND_META[movement.kind];
      toast(
        `سُجّل ${meta.label} ${movement.ref} بمبلغ ${formatMoney(
          movement.amount_minor / 100,
        )} — ${movement.kind === 'deposit' ? 'أُضيف إلى' : 'خُصم من'} الخزينة`,
        'success',
        4500,
      );
      await load();
    },
    [load, toast],
  );

  /** v33 (round-41 #7): التحميل التلقائي — كلما اقترب التمرير من
   *  قاع الصفحة تُسحب الصفحة التالية من السجل تلقائياً بلا زر. */
  const onLedgerScroll = useCallback(
    (event: {nativeEvent: {contentOffset: {y: number}; contentSize: {height: number}; layoutMeasurement: {height: number}}}) => {
      const {y} = event.nativeEvent.contentOffset;
      const contentH = event.nativeEvent.contentSize.height;
      const viewH = event.nativeEvent.layoutMeasurement.height;
      if (contentH - viewH - y <= LEDGER_AUTOSCROLL_PX) {
        void loadMore();
      }
    },
    [loadMore],
  );

  return (
    <View style={styles.screen}>
      <AppHeader title="الخزينة والمصروفات" showBack />

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={120}
        onScroll={onLedgerScroll}>
        {/* ── The drawer hero — expected cash NOW ── */}
        <Card style={styles.drawerCard}>
          <View style={styles.drawerRow}>
            <View style={[styles.drawerIcon, {backgroundColor: c.successSoft}]}>
              <Icon name="wallet" size={24} color={c.success} />
            </View>
            <View style={{flex: 1}}>
              <Text style={styles.drawerLabel}>النقد المتوقع بالخزينة الآن</Text>
              <Text style={[styles.drawerValue, {color: c.success}]}>
                {drawerMinor == null ? '…' : formatMoney(drawerMinor / 100)}
              </Text>
              <Text style={styles.drawerMeta}>
                بعد خصم كل المصروفات والمسحوبات وإضافة الإيداعات
              </Text>
            </View>
          </View>
          {/* v27 (round-35 #3): the badge covers ALL THREE operations
              now — and the unsecured state is a tappable alert that
              jumps straight to the security settings. */}
          {movementSecurityMode() === 'none' ? (
            <TouchableOpacity
              style={styles.securityHint}
              onPress={() => navigation.navigate('Security')}
              activeOpacity={0.8}>
              <Icon name="alert" size={14} color={c.warning} />
              <Text style={styles.securityHintText}>
                عمليات الخزينة غير مؤمَّنة (إيداع/سحب/مصروف) — فعّل البصمة
                أو رمز PIN من إعدادات الأمان. اضغط هنا للتفعيل
              </Text>
            </TouchableOpacity>
          ) : (
            <View
              style={[styles.securityHint, {backgroundColor: c.successSoft}]}>
              <Icon name="fingerprint" size={14} color={c.success} />
              <Text style={[styles.securityHintText, {color: c.success}]}>
                {movementSecurityMode() === 'biometric'
                  ? 'عمليات الخزينة الثلاث مؤمَّنة بالبصمة'
                  : 'عمليات الخزينة الثلاث مؤمَّنة برمز PIN'}
              </Text>
            </View>
          )}
        </Card>

        {/* ── The three actions ── */}
        <View style={styles.actionsRow}>
          <TouchableOpacity
            style={[styles.actionBtn, {borderColor: c.danger}]}
            onPress={() => setSheetMode('expense')}
            activeOpacity={0.8}>
            <View style={[styles.actionIcon, {backgroundColor: c.dangerSoft}]}>
              <Icon name="send" size={18} color={c.danger} />
            </View>
            <Text style={[styles.actionLabel, {color: c.danger}]}>مصروف</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.actionBtn, {borderColor: c.warning}]}
            onPress={() => setSheetMode('withdrawal')}
            activeOpacity={0.8}>
            <View style={[styles.actionIcon, {backgroundColor: c.warningSoft}]}>
              <Icon name="wallet" size={18} color={c.warning} />
            </View>
            <Text style={[styles.actionLabel, {color: c.warning}]}>
              سحب رصيد
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.actionBtn, {borderColor: c.success}]}
            onPress={() => setSheetMode('deposit')}
            activeOpacity={0.8}>
            <View style={[styles.actionIcon, {backgroundColor: c.successSoft}]}>
              <Icon name="download" size={18} color={c.success} />
            </View>
            <Text style={[styles.actionLabel, {color: c.success}]}>إيداع</Text>
          </TouchableOpacity>
        </View>

        {/* ── Period + kind filters ── */}
        <Segmented
          value={period}
          onChange={setPeriod}
          options={PERIOD_OPTIONS}
          compact
        />
        <View style={styles.chipRow}>
          {KIND_CHIPS.map(chip => {
            const active = kindFilter === chip.key;
            return (
              <TouchableOpacity
                key={chip.key}
                style={[
                  styles.chip,
                  active && {backgroundColor: c.accent, borderColor: c.accent},
                ]}
                onPress={() => setKindFilter(chip.key)}
                activeOpacity={0.7}>
                <Text
                  style={[
                    styles.chipText,
                    {color: active ? c.onAccent : c.textDim},
                  ]}>
                  {chip.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* ── The filtered totals card ── */}
        {filteredTotals != null ? (
          <Card style={styles.totalsCard}>
            <Text style={styles.totalsLabel}>{filteredTotals.label}</Text>
            <Text
              style={[
                styles.totalsValue,
                {
                  color:
                    kindFilter === 'deposit'
                      ? c.success
                      : kindFilter === 'all'
                      ? (filteredTotals.minor ?? 0) >= 0
                        ? c.success
                        : c.danger
                      : c.danger,
                },
              ]}>
              {formatMoney(filteredTotals.minor / 100)}
            </Text>
            <Text style={styles.totalsMeta}>
              {filteredTotals.count} سند موثّق في الفترة
            </Text>
            {kindFilter === 'all' && totals != null ? (
              <View style={styles.totalsBreak}>
                <Text style={styles.totalsBreakLine}>
                  مصروفات {formatMoney(totals.expensesMinor / 100)} · مسحوبات{' '}
                  {formatMoney(totals.withdrawalsMinor / 100)} · إيداعات{' '}
                  {formatMoney(totals.depositsMinor / 100)}
                </Text>
              </View>
            ) : null}
          </Card>
        ) : null}

        {/* ── كشف الفترة — v33 (round-41 #7): انتقل فوق سجل
            الحركات بطلب التاجر — الأدوات الأرشيفية قبل السجل. ── */}
        <SectionTitle
          title="كشف الفترة"
          hint="PDF عربي A4 — يُحفظ في مجلد التنزيلات"
        />
        <Card style={styles.pdfCard}>
          <View style={styles.pdfRow}>
            <AppButton
              title="إنشاء كشف PDF"
              icon="download"
              onPress={() => void exportPdf()}
              loading={busy}
              style={{flex: 1}}
            />
            <AppButton
              title="طباعة حرارية"
              icon="printer"
              variant="secondary"
              onPress={() => void printThermal()}
              disabled={printerStatus !== 'connected'}
              style={{flex: 1}}
            />
          </View>
          {pdfReady ? (
            <View style={styles.pdfRow}>
              <AppButton
                title="مشاركة الكشف"
                icon="send"
                variant="secondary"
                small
                onPress={() => void sharePdf()}
                style={{flex: 1}}
              />
              <AppButton
                title="طباعة الكشف (A4)"
                icon="printer"
                variant="secondary"
                small
                onPress={() => void printPdf()}
                style={{flex: 1}}
              />
            </View>
          ) : (
            <Text style={styles.pdfHint}>
              بعد الإنشاء: شاركه واتساب/إيميل أو اطبعه على أي طابعة A4 موصولة
              بالهاتف — واطبع نسخة الجيب الحرارية فوراً
            </Text>
          )}
        </Card>

        {/* ── The movements ledger ── */}
        <SectionTitle
          title="سجل الحركات"
          hint={
            totalCount > 0
              ? `عرض ${rows.length} من ${totalCount} سند — مرقمة ولا تُعدّل`
              : 'سندات مرقمة غير قابلة للتعديل — مسار تدقيق كامل'
          }
        />
        {/* v39 (الجولة 47): البحث في السجل — نص حر يطابق الملاحظة أو
            رقم السند أو الفئة (طلب التاجر: «البحث في سجل الحركات من
            خلال الملاحظة»)، وشرائح فئات المصروف (نقاط الاصرف) تحتته.
            الضغط على أي سند يفتح نافذة مراجعته. */}
        <View style={styles.searchCard}>
          <Icon name="search" size={16} color={c.textDim} />
          <TextInput
            style={styles.searchInput}
            value={searchText}
            onChangeText={setSearchText}
            placeholder="ابحث بالملاحظة أو رقم السند أو الفئة…"
            placeholderTextColor={c.textFaint}
            returnKeyType="search"
            onSubmitEditing={() => setAppliedSearch(searchText.trim())}
          />
          {searchText.length > 0 ? (
            <TouchableOpacity
              onPress={() => {
                setSearchText('');
                setAppliedSearch('');
              }}
              hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
              <Icon name="x" size={15} color={c.textDim} />
            </TouchableOpacity>
          ) : null}
        </View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.categoryChips}>
          <TouchableOpacity
            style={[
              styles.categoryChip,
              categoryFilter == null ? {backgroundColor: c.accent, borderColor: c.accent} : null,
            ]}
            onPress={() => setCategoryFilter(null)}
            activeOpacity={0.75}>
            <Text
              style={[
                styles.categoryChipText,
                {color: categoryFilter == null ? c.onAccent : c.textDim},
              ]}>
              كل الفئات
            </Text>
          </TouchableOpacity>
          {FILTER_CATEGORIES.map(cat => {
            const active = categoryFilter === cat;
            return (
              <TouchableOpacity
                key={cat}
                style={[
                  styles.categoryChip,
                  active ? {backgroundColor: c.accent, borderColor: c.accent} : null,
                ]}
                onPress={() => setCategoryFilter(active ? null : cat)}
                activeOpacity={0.75}>
                <Text
                  style={[
                    styles.categoryChipText,
                    {color: active ? c.onAccent : c.textDim},
                  ]}>
                  {cat}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
        {(appliedSearch.length > 0 || categoryFilter != null) && !loading ? (
          <Text style={styles.filterNote}>
            نتائج مرشّحة
            {categoryFilter != null ? ` — فئة «${categoryFilter}»` : ''}
            {appliedSearch.length > 0 ? ` — بحث «${appliedSearch}»` : ''} · اضغط
            «كل الفئات» وامسح البحث للعودة للسجل الكامل
          </Text>
        ) : null}
        {loading ? (
          <View style={styles.centerBox}>
            <ActivityIndicator size="large" color={c.accent} />
          </View>
        ) : rows.length === 0 ? (
          <EmptyState
            icon="wallet"
            title="لا حركات في هذه الفترة"
            subtitle="سجّل مصروفاً أو اسحب رصيداً وسيظهر هنا بسنده المرقّم"
          />
        ) : (
          <View style={styles.ledger}>
            {rows.map(row => {
              const meta = KIND_META[row.kind];
              const isOut = row.kind !== 'deposit';
              return (
                /* v39 (الجولة 47): الصف يُفتح للمراجعة — طلب التاجر:
                   «يمكن فتح الحركة من سجل العملية ومراجعتها». */
                <TouchableOpacity
                  key={row.local_id}
                  style={styles.ledgerRow}
                  onPress={() => setDetailRow(row)}
                  activeOpacity={0.75}>
                  <View
                    style={[
                      styles.ledgerIcon,
                      {backgroundColor: isOut ? c.dangerSoft : c.successSoft},
                    ]}>
                    <Icon
                      name={meta.icon}
                      size={16}
                      color={isOut ? c.danger : c.success}
                    />
                  </View>
                  <View style={{flex: 1}}>
                    <View style={styles.ledgerHeadRow}>
                      <Text style={styles.ledgerTitle}>{row.category}</Text>
                      <Text
                        style={[
                          styles.ledgerAmount,
                          {color: isOut ? c.danger : c.success},
                        ]}>
                        {isOut ? '−' : '+'}{' '}
                        {formatMoney(row.amount_minor / 100)}
                      </Text>
                    </View>
                    <Text style={styles.ledgerMeta}>
                      {row.ref} · {formatDateTime(row.created_at)}
                    </Text>
                    {row.note ? (
                      <Text style={styles.ledgerNote} numberOfLines={1}>
                        {row.note}
                      </Text>
                    ) : null}
                  </View>
                  {/* v27: every movement can carry a security method —
                      fingerprint/PIN badges show for all kinds; the
                      withdrawal keeps its explicit «بدون تأمين» audit
                      badge from v25. */}
                  {row.kind === 'withdrawal' ||
                  row.auth_method === 'fingerprint' ||
                  row.auth_method === 'pin' ? (
                    <Badge
                      label={AUTH_LABEL[row.auth_method] ?? '—'}
                      tone="neutral"
                    />
                  ) : null}
                </TouchableOpacity>
              );
            })}
            {/* v26 (round-34 #5): the next page — big periods grow on
                demand; the counter in the section title always says
                how much is left below. */}
            {rows.length < totalCount ? (
              <TouchableOpacity
                style={styles.loadMoreBtn}
                onPress={() => void loadMore()}
                disabled={loadingMore}
                activeOpacity={0.7}>
                {loadingMore ? (
                  <ActivityIndicator size="small" color={c.accent} />
                ) : (
                  <>
                    <Icon name="download" size={15} color={c.accent} />
                    <Text style={styles.loadMoreText}>
                      اسحب للأسفل للمزيد ({totalCount - rows.length} سند متبقية)
                    </Text>
                  </>
                )}
              </TouchableOpacity>
            ) : totalCount > LEDGER_PAGE ? (
              <Text style={styles.ledgerEndText}>
                عرض كل سندات الفترة ({totalCount})
              </Text>
            ) : null}
          </View>
        )}

      </ScrollView>

      {/* ── The entry sheet (INLINE overlay — never a Modal) ── */}
      {sheetMode != null ? (
        <MovementSheet
          mode={sheetMode}
          drawerMinor={drawerMinor ?? 0}
          onClose={() => setSheetMode(null)}
          onDone={onMovementDone}
        />
      ) : null}

      {/* v39 (الجولة 47): نافذة مراجعة حركة من السجل — طلب التاجر
          نصاً: «يمكن فتح الحركة من سجل العملية ومراجعتها». عرض كامل
          تفاصيل السند (نوعه/رقمه/فئته/ملاحظته/مبلغه/طريقة التأمين/
          تاريخه) مع إعادة طباعة السند — INLINE overlay كالعادة. */}
      {detailRow != null ? (
        <MovementDetailSheet
          movement={detailRow}
          busy={reprintBusy}
          onOpenPhoto={(p, label) => setViewerPhoto({path: p, label})}
          onClose={() => setDetailRow(null)}
          onReprint={() => {
            if (reprintBusy) {
              return;
            }
            setReprintBusy(true);
            CashService.reprintSlip(detailRow)
              .then(() => {
                toast(`أُعيد طبع سند ${detailRow.ref}`, 'success');
              })
              .catch(error => {
                toast(
                  error instanceof Error
                    ? error.message
                    : 'فشلت طباعة السند',
                  'error',
                );
              })
              .finally(() => setReprintBusy(false));
          }}
        />
      ) : null}

      {/* v46: عارض صورة السند ملء الشاشة — يفتح من نافذة المراجعة
          ويغلق بزر X أو زر الرجوع (نفس انضباط بقية النوافذ). */}
      {viewerPhoto != null ? (
        <VoucherPhotoViewer
          path={viewerPhoto.path}
          label={viewerPhoto.label}
          onClose={() => setViewerPhoto(null)}
        />
      ) : null}
    </View>
  );
}

// ────────────────────────────────────────────────────────────────
// v39 (الجولة 47): MovementDetailSheet — نافذة مراجعة سند قائم من
// السجل. السندات غير قابلة للتعديل بالتصميم (مسار تدقيق كامل) —
// المراجعة عرض كامل التفاصيل + إعادة طباعة السند فقط.
// ────────────────────────────────────────────────────────────────
// v46: VoucherChooser — خيارا إرفاق صورة السند (كاميرا / معرض)
// كتوسيع مضمن داخل بطاقة السند — بلا Modal وبلا قوائم عائمة، نفس
// انضباط ROM (كل النوافذ INLINE داخل شجرة الشاشة).
// ────────────────────────────────────────────────────────────────
function VoucherChooser({
  onCamera,
  onGallery,
  onCancel,
}: {
  onCamera: () => void;
  onGallery: () => void;
  onCancel: () => void;
}) {
  const c = useThemeColors();
  return (
    <View style={chooserStyles(c).wrap}>
      <TouchableOpacity
        style={chooserStyles(c).row}
        onPress={onCamera}
        activeOpacity={0.75}>
        <View style={chooserStyles(c).icon}>
          <Icon name="camera" size={17} color={c.accent} />
        </View>
        <View style={{flex: 1}}>
          <Text style={chooserStyles(c).title}>تصوير السند بالكاميرا</Text>
          <Text style={chooserStyles(c).sub}>
            افتح الكاميرا وصوّر ورقة السند مباشرة
          </Text>
        </View>
      </TouchableOpacity>
      <TouchableOpacity
        style={chooserStyles(c).row}
        onPress={onGallery}
        activeOpacity={0.75}>
        <View style={chooserStyles(c).icon}>
          <Icon name="image" size={17} color={c.accent} />
        </View>
        <View style={{flex: 1}}>
          <Text style={chooserStyles(c).title}>اختيار من المعرض</Text>
          <Text style={chooserStyles(c).sub}>
            اختر صورة السند من هاتفك (لقطة موجودة)
          </Text>
        </View>
      </TouchableOpacity>
      <TouchableOpacity
        style={chooserStyles(c).cancel}
        onPress={onCancel}
        activeOpacity={0.8}>
        <Text style={chooserStyles(c).cancelText}>إلغاء</Text>
      </TouchableOpacity>
    </View>
  );
}

function chooserStyles(c: ReturnType<typeof useThemeColors>) {
  return StyleSheet.create({
    wrap: {
      gap: 6,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: c.surfaceAlt,
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: radius.sm,
      padding: spacing.md,
    },
    icon: {
      width: 38,
      height: 38,
      borderRadius: 12,
      backgroundColor: c.accentSofter,
      alignItems: 'center',
      justifyContent: 'center',
    },
    title: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.body,
    },
    sub: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      marginTop: 2,
    },
    cancel: {
      alignSelf: 'center',
      paddingVertical: 6,
      paddingHorizontal: spacing.lg,
    },
    cancelText: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
  });
}

// ────────────────────────────────────────────────────────────────
function MovementDetailSheet({
  movement,
  busy,
  onClose,
  onReprint,
  onOpenPhoto,
}: {
  movement: CashMovementRecord;
  busy: boolean;
  onClose: () => void;
  onReprint: () => void;
  /** v46: يفتح عارض صورة السند ملء الشاشة (path + تسمية السند). */
  onOpenPhoto: (path: string, label: string) => void;
}) {
  const c = useThemeColors();
  const meta = KIND_META[movement.kind];
  const isOut = movement.kind !== 'deposit';

  // ── v46: التحقق من وجود ملف صورة السند ──────────────────────────
  // الصورة قد تكون من نسخة احتياطية على جهاز آخر — إن كان الملف
  // مفقوداً نعرض ملاحظة صريحة بدل صورة مكسورة.
  const photoPath = movement.photo_path ?? null;
  const [photoOk, setPhotoOk] = useState<boolean | null>(null);
  useEffect(() => {
    setPhotoOk(null);
    if (photoPath == null) {
      return;
    }
    let alive = true;
    PlatformUtilsNative?.fileExists(photoPath)
      .then(ok => {
        if (alive) {
          setPhotoOk(ok);
        }
      })
      .catch(() => {
        if (alive) {
          setPhotoOk(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [photoPath]);
  return (
    <View style={detailStyles(c).backdrop}>
      <Pressable style={{flex: 1}} onPress={onClose} />
      <View style={detailStyles(c).sheet}>
        <View style={detailStyles(c).head}>
          <View
            style={[
              detailStyles(c).headIcon,
              {backgroundColor: isOut ? c.dangerSoft : c.successSoft},
            ]}>
            <Icon
              name={meta.icon}
              size={20}
              color={isOut ? c.danger : c.success}
            />
          </View>
          <View style={{flex: 1}}>
            <Text style={detailStyles(c).headTitle}>{meta.label}</Text>
            <Text style={detailStyles(c).headSub}>{movement.ref}</Text>
          </View>
          <TouchableOpacity
            onPress={onClose}
            style={detailStyles(c).closeBtn}>
            <Icon name="x" size={16} color={c.textDim} />
          </TouchableOpacity>
        </View>

        <View style={detailStyles(c).amountRow}>
          <Text style={detailStyles(c).amountLabel}>مبلغ السند</Text>
          <Text
            style={[
              detailStyles(c).amountValue,
              {color: isOut ? c.danger : c.success},
            ]}>
            {isOut ? '−' : '+'} {formatMoney(movement.amount_minor / 100)}
          </Text>
        </View>

        <View style={detailStyles(c).rows}>
          <View style={detailStyles(c).row}>
            <Text style={detailStyles(c).rowLabel}>الفئة</Text>
            <Text style={detailStyles(c).rowValue}>{movement.category}</Text>
          </View>
          <View style={detailStyles(c).row}>
            <Text style={detailStyles(c).rowLabel}>الملاحظة</Text>
            <Text style={detailStyles(c).rowValue}>
              {movement.note ?? 'بلا ملاحظة'}
            </Text>
          </View>
          <View style={detailStyles(c).row}>
            <Text style={detailStyles(c).rowLabel}>التاريخ والوقت</Text>
            <Text style={detailStyles(c).rowValue}>
              {formatDateTime(movement.created_at)}
            </Text>
          </View>
          <View style={detailStyles(c).row}>
            <Text style={detailStyles(c).rowLabel}>التأمين</Text>
            <Text style={detailStyles(c).rowValue}>
              {AUTH_LABEL[movement.auth_method] ?? '—'}
            </Text>
          </View>
        </View>

        {/* v46: صورة السند المرفقة — معاينة داخل المراجعة،
            والضغط يفتحها ملء الشاشة بقرص التكبير. ملف مفقود
            (نسخة من جهاز آخر؟) → ملاحظة صريحة بدل صورة مكسورة. */}
        {photoPath != null ? (
          photoOk === false ? (
            <View style={detailStyles(c).photoMissing}>
              <Icon name="alert" size={14} color={c.warning} />
              <Text style={detailStyles(c).photoMissingText}>
                أُرفقت صورة بهذا السند لكن الملف غير متوفر على هذا الجهاز
              </Text>
            </View>
          ) : (
            <TouchableOpacity
              style={detailStyles(c).photoCard}
              onPress={() => onOpenPhoto(photoPath, movement.ref)}
              activeOpacity={0.85}>
              <RNImage
                source={{uri: fileUri(photoPath)}}
                style={detailStyles(c).photoImage}
                resizeMode="contain"
              />
              <View style={detailStyles(c).photoCaptionRow}>
                <Icon name="image" size={14} color={c.accent} />
                <Text style={detailStyles(c).photoCaptionText}>
                  صورة السند المرفقة — اضغط للعرض والتكبير
                </Text>
                <Icon
                  name={I18nManager.isRTL ? 'chevronLeft' : 'chevronRight'}
                  size={15}
                  color={c.textDim}
                />
              </View>
            </TouchableOpacity>
          )
        ) : null}

        <View style={detailStyles(c).noteBox}>
          <Icon name="info" size={14} color={c.warning} />
          <Text style={detailStyles(c).noteText}>
            سند مرقّم غير قابل للتعديل — خطأ القيد يُصحّح بحركة معاكسة
            (إيداع/مصروف) لا بالحذف، فيبقى مسار التدقيق كاملاً
          </Text>
        </View>

        <View style={detailStyles(c).actions}>
          <AppButton
            title="إعادة طباعة السند"
            icon="printer"
            variant="secondary"
            onPress={onReprint}
            loading={busy}
            style={{flex: 1}}
          />
          <AppButton
            title="إغلاق"
            icon="x"
            onPress={onClose}
            style={{flex: 1}}
          />
        </View>
      </View>
    </View>
  );
}

// ────────────────────────────────────────────────────────────────
// MovementSheet — نافذة تسجيل الحركة (INLINE overlay، ارتفاع ثابت
// ملء الشاشة بتجميد onLayout — v46: ارتفاع من الحاوية لا من أبعاد النافذة).
// للعمليات الثلاث: بوابة الأمان — البصمة تلقائياً أولاً، وإلا
// لوحة PIN، وإلا تحذير بارز مع زر تفعيل الحماية وتسجيل «بدون تأمين».
// ────────────────────────────────────────────────────────────────
// v46: VoucherPhotoViewer — عارض صورة السند ملء الشاشة (INLINE
// overlay — بلا Modal، نفس انضباط ROM). مراجعة احترافية بلا صعوبة:
// قرص إصبعين للتكبير، سحب بإصبع واحد عند التكبير، أزرار +/− وإعادة
// ضبط لمن لا يستخدم القرص، وزر الرجوع/إغلاق يعمل كالمعتاد. كله من
// نواة RN (Animated + PanResponder) — صفر اعتماديات جديدة.
// ────────────────────────────────────────────────────────────────
const VIEWER_MAX = 5;

function touchDist(
  a: {pageX: number; pageY: number},
  b: {pageX: number; pageY: number},
): number {
  return Math.max(1, Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY));
}

function VoucherPhotoViewer({
  path,
  label,
  onClose,
}: {
  path: string;
  label: string;
  onClose: () => void;
}) {
  const c = useThemeColors();
  const insets = useSafeAreaInsets();
  const scale = useRef(new Animated.Value(1)).current;
  const tx = useRef(new Animated.Value(0)).current;
  const ty = useRef(new Animated.Value(0)).current;
  /** المرآة الحقيقية للحالة — مصدر الحقيقة للإيماءات (كل تعديل
   *  يمر من apply فلا تنفصل القيم المنعكسة عن القيم المتحركة). */
  const cur = useRef({s: 1, x: 0, y: 0});
  const area = useRef({w: 0, h: 0});
  const pinch = useRef({dist: 0, s0: 1});
  const lastSingle = useRef<{x: number; y: number} | null>(null);
  const pctRef = useRef(100);
  const [pct, setPct] = useState(100);

  const apply = useCallback(
    (next: {s: number; x: number; y: number}) => {
      cur.current = next;
      scale.setValue(next.s);
      tx.setValue(next.x);
      ty.setValue(next.y);
      const p = Math.round(next.s * 100);
      if (p !== pctRef.current) {
        pctRef.current = p;
        setPct(p);
      }
    },
    [scale, tx, ty],
  );

  const clampPan = useCallback(
    (s: number, x: number, y: number) => {
      const maxX = (area.current.w * (s - 1)) / 2;
      const maxY = (area.current.h * (s - 1)) / 2;
      return {
        s,
        x: Math.min(Math.max(x, -maxX), maxX),
        y: Math.min(Math.max(y, -maxY), maxY),
      };
    },
    [],
  );

  const resetZoom = useCallback(() => {
    Animated.parallel([
      Animated.timing(scale, {toValue: 1, duration: 180, useNativeDriver: true}),
      Animated.timing(tx, {toValue: 0, duration: 180, useNativeDriver: true}),
      Animated.timing(ty, {toValue: 0, duration: 180, useNativeDriver: true}),
    ]).start(() => apply({s: 1, x: 0, y: 0}));
  }, [scale, tx, ty, apply]);

  const zoomBy = useCallback(
    (factor: number) => {
      const s0 = cur.current.s;
      if (s0 <= 1.001 && factor < 1) {
        return;
      }
      if (s0 >= VIEWER_MAX - 0.001 && factor > 1) {
        return;
      }
      const s1 = Math.min(Math.max(s0 * factor, 1), VIEWER_MAX);
      if (s1 <= 1.001) {
        resetZoom();
        return;
      }
      // حافظ على مركز الإطار أثناء الزوم — البان يتقاسم نفس النسبة.
      apply(clampPan(s1, cur.current.x * (s1 / s0), cur.current.y * (s1 / s0)));
    },
    [apply, clampPan, resetZoom],
  );

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          pinch.current = {dist: 0, s0: cur.current.s};
          lastSingle.current = null;
        },
        onPanResponderMove: (e, _g) => {
          const touches = (e.nativeEvent as unknown as {
            touches: {pageX: number; pageY: number}[];
          }).touches;
          if (touches.length >= 2) {
            lastSingle.current = null;
            if (pinch.current.dist === 0) {
              pinch.current = {
                dist: touchDist(touches[0], touches[1]),
                s0: cur.current.s,
              };
              return;
            }
            const d = touchDist(touches[0], touches[1]);
            const s1 = Math.min(
              Math.max(pinch.current.s0 * (d / pinch.current.dist), 1),
              VIEWER_MAX,
            );
            apply(clampPan(s1, cur.current.x, cur.current.y));
            return;
          }
          if (touches.length === 1 && cur.current.s > 1.02) {
            const t = touches[0];
            if (lastSingle.current == null) {
              lastSingle.current = {x: t.pageX, y: t.pageY};
              return;
            }
            const dx = t.pageX - lastSingle.current.x;
            const dy = t.pageY - lastSingle.current.y;
            lastSingle.current = {x: t.pageX, y: t.pageY};
            apply(clampPan(cur.current.s, cur.current.x + dx, cur.current.y + dy));
          }
        },
        onPanResponderRelease: () => {
          pinch.current = {dist: 0, s0: cur.current.s};
          lastSingle.current = null;
          if (cur.current.s <= 1.02) {
            resetZoom();
          }
        },
        onPanResponderTerminate: () => {
          pinch.current = {dist: 0, s0: cur.current.s};
          lastSingle.current = null;
        },
      }),
    [apply, clampPan, resetZoom],
  );

  // زر الرجوع يغلق العارض (نفس انضباط بقية النوافذ).
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [onClose]);

  return (
    <View style={viewerStyles(c).backdrop}>
      <View style={[viewerStyles(c).topBar, {paddingTop: Math.max(insets.top, 10)}]}>
        <View style={viewerStyles(c).labelChip}>
          <Icon name="image" size={15} color="rgba(255,255,255,0.85)" />
          <Text style={viewerStyles(c).labelText} numberOfLines={1}>
            {label} — صورة السند
          </Text>
        </View>
        <TouchableOpacity
          style={viewerStyles(c).closeBtn}
          onPress={onClose}
          activeOpacity={0.8}>
          <Icon name="x" size={18} color="#FFFFFF" />
        </TouchableOpacity>
      </View>
      <View
        style={viewerStyles(c).area}
        onLayout={e => {
          area.current = {
            w: e.nativeEvent.layout.width,
            h: e.nativeEvent.layout.height,
          };
        }}>
        <Animated.View
          style={[
            viewerStyles(c).zoomWrap,
            {transform: [{translateX: tx}, {translateY: ty}, {scale}]},
          ]}
          {...responder.panHandlers}>
          <RNImage
            source={{uri: fileUri(path)}}
            style={viewerStyles(c).image}
            resizeMode="contain"
          />
        </Animated.View>
      </View>
      <View style={[viewerStyles(c).bottomBar, {paddingBottom: Math.max(insets.bottom, 12)}]}>
        <TouchableOpacity
          style={[viewerStyles(c).zoomBtn, pct <= 100 ? viewerStyles(c).zoomBtnOff : null]}
          onPress={() => zoomBy(1 / 1.45)}
          disabled={pct <= 100}
          activeOpacity={0.8}>
          <Text style={viewerStyles(c).zoomBtnText}>−</Text>
        </TouchableOpacity>
        <Text style={viewerStyles(c).pctText}>{pct}%</Text>
        <TouchableOpacity
          style={[viewerStyles(c).zoomBtn, pct >= 500 ? viewerStyles(c).zoomBtnOff : null]}
          onPress={() => zoomBy(1.45)}
          disabled={pct >= 500}
          activeOpacity={0.8}>
          <Text style={viewerStyles(c).zoomBtnText}>+</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={viewerStyles(c).resetBtn}
          onPress={resetZoom}
          activeOpacity={0.8}>
          <Text style={viewerStyles(c).resetText}>إعادة الضبط</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function viewerStyles(c: ReturnType<typeof useThemeColors>) {
  return StyleSheet.create({
    backdrop: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(6,6,10,0.96)',
      zIndex: 95,
      elevation: 95,
    },
    topBar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.md,
    },
    labelChip: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    labelText: {
      color: 'rgba(255,255,255,0.9)',
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    closeBtn: {
      width: 42,
      height: 42,
      borderRadius: 13,
      backgroundColor: 'rgba(255,255,255,0.14)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    area: {
      flex: 1,
      overflow: 'hidden',
    },
    zoomWrap: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
    },
    image: {
      flex: 1,
      width: '100%',
      backgroundColor: 'transparent',
    },
    bottomBar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.md,
    },
    zoomBtn: {
      width: 48,
      height: 48,
      borderRadius: 15,
      backgroundColor: 'rgba(255,255,255,0.14)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    zoomBtnOff: {
      opacity: 0.35,
    },
    zoomBtnText: {
      color: '#FFFFFF',
      fontFamily: fonts.black,
      fontSize: 26,
      lineHeight: 30,
    },
    pctText: {
      color: 'rgba(255,255,255,0.9)',
      fontFamily: fonts.bold,
      fontSize: typography.small,
      minWidth: 64,
      textAlign: 'center',
      fontVariant: ['tabular-nums'],
    },
    resetBtn: {
      paddingHorizontal: spacing.lg,
      height: 48,
      borderRadius: 15,
      backgroundColor: 'rgba(255,255,255,0.14)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    resetText: {
      color: '#FFFFFF',
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
  });
}

// ────────────────────────────────────────────────────────────────

const SHEET_TITLES: Record<CashMovementKind, string> = {
  expense: 'تسجيل مصروف من الخزينة',
  withdrawal: 'سحب رصيد من الخزينة',
  deposit: 'إيداع نقدي في الخزينة',
};

const SHEET_SUBS: Record<CashMovementKind, string> = {
  expense: 'يُخصم من الخزينة ويُطبع سنده فوراً',
  withdrawal: 'السقف ما في الدرج فقط',
  deposit: 'يُضاف للخزينة ويُطبع سنده فوراً',
};

/** v27 (round-35 #3): the biometric prompt copy per movement. */
const BIO_PROMPTS: Record<CashMovementKind, {title: string; sub: string; cancel: string}> = {
  expense: {
    title: 'تسجيل مصروف من الخزينة',
    sub: 'أكّد هويتك بالبصمة لإتمام المصروف',
    cancel: 'إلغاء المصروف',
  },
  withdrawal: {
    title: 'سحب رصيد من الخزينة',
    sub: 'أكّد هويتك بالبصمة لإتمام السحب',
    cancel: 'إلغاء السحب',
  },
  deposit: {
    title: 'إيداع نقدي في الخزينة',
    sub: 'أكّد هويتك بالبصمة لإتمام الإيداع',
    cancel: 'إلغاء الإيداع',
  },
};

function MovementSheet({
  mode,
  drawerMinor,
  onClose,
  onDone,
}: {
  mode: CashMovementKind;
  drawerMinor: number;
  onClose: () => void;
  onDone: (movement: CashMovementRecord) => Promise<void> | void;
}) {
  const c = useThemeColors();
  const styles = useStyles();
  const toast = useToastStore(state => state.show);

  // v46 (الجولة الحالية): الارتفاع من الحاوية نفسها لا من أبعاد
  // النافذة — الجذر النهائي لمشكلة «يختفي جزء من لوحة الأرقام اسفل
  // الشاشة» في بعض الأجهزة: ارتفاع useWindowDimensions يفترض أنه
  // يساوي المساحة المرئية، وعلى بعض الأجهزة/الرومات (حواف ملء
  // الشاشة، تابلت، وضع أفقي) يختلف عن ارتفاع الحاوية الفعلية التي
  // تعيش فيها الطبقة المطلقة، فتمتد النافذة تحت المنطقة المرئية
  // ويُقطع أسفلها (لوحة الأرقام وزر التأكيد).
  //
  // الحل البنيوي بمرحلتين:
  //   1) أول إطار: height:'100%' نسبةً إلى الطبقة الخلفية المطلقة
  //      = المساحة المرئية بالضبط — صحيح بالبناء لا بالافتراض.
  //   2) onLayout أول تخطيط يجمّد الرقم في حالة — فيحتفظ النافذة
  //      بارتفاعها الكامل عند فتح لوحة النظام للملاحظة (adjustResize
  //      يقلّص الجذر) فتظل لوحة الأرقام مكانها تحت اللوحة وتظهر
  //      فور إغلاقها — نفس سلوك v33 المطلوب («لا تقفز للأعلى»)
  //      بلا أي Dimensions وبلا مستمعات Keyboard.
  const insets = useSafeAreaInsets();
  const [frozenH, setFrozenH] = useState<number | null>(null);
  const freezeLayout = useCallback(
    (e: {nativeEvent: {layout: {height: number}}}) => {
      setFrozenH(prev =>
        prev == null ? Math.round(e.nativeEvent.layout.height) : prev,
      );
    },
    [],
  );

  // v46: المقاييس المتكيفة — الجواب الكامل لطلب التاجر: «التطبيق
  // متجاوب مع جميع الأجهزة حتى التابلت». كل الأحجام الحرجة داخل
  // النافذة تُشتق من ارتفاعها الفعلي (المجمد) فتبدو صحيحة على أي
  // هاتف/تابلت/وضع أفقي: مفاتيح أكبر وأوضح على الشاشات العالية
  // (تابلت) ومضغوطة بحد أدنى مريح على القصيرة، ولا قيم ثابتة
  // «حظّية» بعد اليوم.
  const winW = useWindowDimensions().width;
  const availH = frozenH ?? 720; // قبل أول تخطيط: تقديرات محايدة.
  const clampNum = (v: number, lo: number, hi: number) =>
    Math.min(Math.max(v, lo), hi);
  const dyn = useMemo(
    () => ({
      // مفتاح لوحة الأرقام: 7.2% من الارتفاع بين 42 و62.
      keyH: clampNum(Math.round(availH * 0.072), 42, 62),
      // رقم المفتاح: متناسب مع ارتفاعه (نسبة 0.46).
      keyFont: clampNum(Math.round(availH * 0.072 * 0.46), 18, 26),
      // المبلغ المعروض: أكبر على التابلت (حتى 36) وأدنى 24.
      amountFont: clampNum(Math.round(availH * 0.045), 24, 36),
      // أرقام بطاقة الرصيد الحية.
      balanceFont: clampNum(Math.round(availH * 0.03), 15, 22),
      // حقل الملاحظة الكبير (سحب/إيداع) — يتقلص على الشاشات القصيرة.
      noteBigH: clampNum(Math.round(availH * 0.12), 72, 110),
      // عارض الصورة في البطاقة: مربع مضغوط داخل نموذج الإدخال.
      thumb: clampNum(Math.round(availH * 0.1), 56, 84),
    }),
    [availH],
  );

  // v26 (round-34 #4): instant render (no entrance animation — the
  // ROM lesson from the return sheet) + a 400ms close-guard so a
  // bounced opening touch on the freshly mounted backdrop can never
  // kill the window («الضغط أول مرة وكأنه فتح وأغلق بسرعة»).
  const mountedAt = useRef(Date.now());

  const [amountText, setAmountText] = useState('');
  /** v31 (round-39 #2): لا حالة تركيز إطلاقاً — لوحة الأرقام تبقى
   *  مركّبة دائماً ولا يتحرك شيء في الشجرة لحظة تركيز الملاحظة
   *  أو الفئة المخصصة (أي رد فعل JS على التركيز هو بنمط قاتل
   *  الـ IME على روم الجهاز — درس v29). حقل الملاحظة/Fئة المخصصة
   *  مثبّتان فوق منطقة الفئات القابلة للتمرير فيبقيان مرئيين
   *  دائماً مهما ارتفعت لوحة النظام. */
  const [category, setCategory] = useState(
    mode === 'expense' ? EXPENSE_CATEGORIES[0] : mode === 'withdrawal' ? 'سحب رصيد' : 'إيداع نقدي',
  );
  const [customCategory, setCustomCategory] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [showCustom, setShowCustom] = useState(false);
  /** v46: صورة السند المرفقة — مسار ملف محلي داخل filesDir/vouchers
   *  (يُحفظ مع الحركة في عمود photo_path ويمكن مراجعته من السجل).
   *  chooserOpen يعرض خياري الكاميرا/المعرض داخل البطاقة نفسها
   *  (توسيع مضمن — بلا Modal وبلا نوافذ عائمة، نفس انضباط ROM). */
  const [photoPath, setPhotoPath] = useState<string | null>(null);
  const [chooserOpen, setChooserOpen] = useState(false);
  const [attachBusy, setAttachBusy] = useState(false);
  /** v46: مرآة مرجعية لقيمة الصورة الحالية — تُقرأ في تنظيف إلغاء
   *  التركيب بلا اعتماد على إعادة إنشاء الدالة. */
  const photoRef = useRef<string | null>(null);
  photoRef.current = photoPath;
  /** v46: true لحظة نجاح الحفظ في القاعدة — بعده الملف ملك السند
   *  المسجل ولا يجوز حذفه في تنظيف إلغاء التركيب. */
  const committedRef = useRef(false);
  /** v25: the withdrawal security gate state machine.
   *  'idle' → biometric prompt (auto) | PIN pad; 'authorizing' →
   *  biometric in flight; 'pin-fallback' → the PIN pad after a
   *  cancelled fingerprint; 'passed' → the form. */
  const [authStage, setAuthStage] = useState<
    'idle' | 'authorizing' | 'pin-fallback' | 'passed'
  >('idle');
  const [authMethod, setAuthMethod] = useState<'fingerprint' | 'pin' | 'none'>(
    'none',
  );
  const [pinError, setPinError] = useState<string | null>(null);
  const [shakeSignal, setShakeSignal] = useState(0);
  const bioBusy = useRef(false);
  const navigation = useNavigation<any>();
  const securityMode = movementSecurityMode();
  const hasPin = useAppLockStore(s => s.pinHash != null);

  // v26: the guarded backdrop close (needs busy/authStage above).
  const backdropPressGuarded = useCallback(() => {
    if (busy || authStage === 'authorizing') {
      return;
    }
    if (Date.now() - mountedAt.current < 400) {
      return; // the opening touch's bounce — ignore it.
    }
    onClose();
  }, [busy, authStage, onClose]);

  // Hardware back closes (unless mid-authorization). v26: guarded
  // like the backdrop — a spurious back right after opening can no
  // longer kill the fresh sheet.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (
        !busy &&
        authStage !== 'authorizing' &&
        Date.now() - mountedAt.current >= 400
      ) {
        onClose();
      }
      return true;
    });
    return () => sub.remove();
  }, [busy, authStage, onClose]);

  // v27 (round-35 #3): the security gate — ALL THREE movements
  // (expense, withdrawal, deposit) pass it. Fingerprint FIRST
  // (auto-prompted the moment the sheet opens when enabled), the
  // PIN pad when the device has no biometrics, and a documented
  // unsecured pass (with a loud warning) when nothing is
  // configured.
  const runBiometric = useCallback(async () => {
    if (bioBusy.current) {
      return;
    }
    bioBusy.current = true;
    setAuthStage('authorizing');
    try {
      const prompt = BIO_PROMPTS[mode];
      const ok = await authorizeWithBiometric(
        prompt.title,
        prompt.sub,
        prompt.cancel,
      );
      if (ok) {
        setAuthMethod('fingerprint');
        setAuthStage('passed');
      } else {
        // Cancelled — stay on the gate; the PIN fallback button is
        // there when a PIN exists, otherwise try again.
        setAuthStage('idle');
      }
    } finally {
      bioBusy.current = false;
    }
  }, [mode]);

  useEffect(() => {
    if (securityMode === 'biometric') {
      void runBiometric();
    }
    // 'pin' → the pad below collects it; 'none' → warned + unsecured.
  }, [securityMode, runBiometric]);

  const handlePinSubmit = useCallback(
    (pin: string) => {
      if (verifyWithdrawalPin(pin)) {
        setAuthMethod('pin');
        setAuthStage('passed');
        setPinError(null);
      } else {
        setPinError('الرمز غير صحيح — حاول مجدداً');
        setShakeSignal(s => s + 1);
      }
    },
    [],
  );
  const amountMinor = useMemo(() => amountTextToMinor(amountText), [amountText]);

  const effectiveCategory =
    showCustom && customCategory.trim().length > 0
      ? customCategory.trim()
      : category;

  const isOut = mode !== 'deposit';
  const overDrawer = isOut && amountMinor > drawerMinor;

  const confirm = useCallback(async () => {
    if (busy || amountMinor <= 0 || overDrawer) {
      return;
    }
    // v27: the gate guards ALL THREE movements — expense and
    // deposit are money operations exactly like the withdrawal.
    if (securityMode !== 'none' && authStage !== 'passed') {
      toast('أكّد هويتك أولاً — البصمة أو رمز PIN', 'info');
      return;
    }
    setBusy(true);
    try {
      let movement: CashMovementRecord;
      if (mode === 'expense') {
        movement = await CashService.recordExpense({
          category: effectiveCategory,
          note: note.trim() || null,
          amountMinor,
          authMethod,
          photoPath,
        });
      } else if (mode === 'withdrawal') {
        movement = await CashService.recordWithdrawal({
          note: note.trim() || null,
          amountMinor,
          authMethod,
          photoPath,
        });
      } else {
        movement = await CashService.recordDeposit({
          note: note.trim() || null,
          amountMinor,
          authMethod,
          photoPath,
        });
      }
      // v46: الحركة سُجلت بنجاح في القاعدة — الملف الآن ملك السند
      // المسجل (عمود photo_path) ولا يجوز حذفه عند تفكيك النافذة.
      // يُعلم قبل onDone كي لا يحذفه التنظيف لو رمى onDone.
      committedRef.current = true;
      await onDone(movement);
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'فشل تسجيل الحركة',
        'error',
      );
    } finally {
      setBusy(false);
    }
  }, [
    busy,
    amountMinor,
    overDrawer,
    mode,
    securityMode,
    authStage,
    effectiveCategory,
    note,
    authMethod,
    photoPath,
    onDone,
    toast,
  ]);

  // ── v46: إرفاق صورة السند — الكاميرا والمعرض ──────────────────
  // مساران فقط، كلاهما بلا أي اعتماديات جديدة:
  //  • الكاميرا: capturePhoto (الماسح الأصلي — كاميرا ملء الشاشة
  //    بمصرّح مسبق ونفس مسار بصمات المنتجات المجرب) → الملف الأصلي
  //    الكبير في scans/ يُقلَّص ويُحفظ في vouchers/ ثم يُحذف الأصل.
  //  • المعرض: pickVoucherImage (منتقي النظام SAF — نفس مسار شعار
  //    المتجر المجرب) → نسخة مصغرة في vouchers/.
  // الاستبدال يحذف الملف السابق (ليس له صف في القاعدة بعد)، والإزالة
  // تحذفه فوراً. وتنظيف إلغاء التركيب يحذف الملف اليتيم إن أُغلقت
  // النافذة بلا تأكيد (أي مسار إغلاق: الخلفية/زر X/زر الرجوع).
  const adoptVoucher = useCallback(
    async (next: string, previous: string | null) => {
      setPhotoPath(next);
      setChooserOpen(false);
      if (previous != null) {
        await deleteQuiet(previous);
      }
    },
    [],
  );

  const attachFromCamera = useCallback(async () => {
    if (attachBusy || busy) {
      return;
    }
    setAttachBusy(true);
    setChooserOpen(false);
    try {
      const shot = await capturePhoto(); // null عند الإلغاء
      if (shot == null) {
        return;
      }
      if (SelaImagePickerNative == null) {
        throw new Error('وحدة الصور غير متوفرة في هذا الإصدار من التطبيق');
      }
      const previous = photoRef.current;
      const saved = await SelaImagePickerNative.saveVoucherFromPath(
        shot,
        VOUCHER_MAX_DIM,
      );
      await adoptVoucher(saved, previous);
      toast('أُرفقت صورة السند بالعملية', 'success');
    } catch (error) {
      toast(
        error instanceof Error
          ? error.message
          : 'تعذر تجهيز صورة السند',
        'error',
      );
    } finally {
      setAttachBusy(false);
    }
  }, [attachBusy, busy, toast, adoptVoucher]);

  const attachFromGallery = useCallback(async () => {
    if (attachBusy || busy) {
      return;
    }
    setAttachBusy(true);
    setChooserOpen(false);
    try {
      if (SelaImagePickerNative == null) {
        throw new Error('وحدة الصور غير متوفرة في هذا الإصدار من التطبيق');
      }
      const previous = photoRef.current;
      const saved = await SelaImagePickerNative.pickVoucherImage(
        VOUCHER_MAX_DIM,
      );
      await adoptVoucher(saved, previous);
      toast('أُرفقت صورة السند بالعملية', 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message.includes('لم يتم اختيار') || message.includes('أُغلق')) {
        return; // إلغاء منتقي الصور — ليس خطأ يستحق توستاً.
      }
      toast(
        error instanceof Error
          ? error.message
          : 'تعذر اختيار صورة السند',
        'error',
      );
    } finally {
      setAttachBusy(false);
    }
  }, [attachBusy, busy, toast, adoptVoucher]);

  const removeVoucher = useCallback(async () => {
    if (attachBusy || busy) {
      return;
    }
    const previous = photoRef.current;
    setPhotoPath(null);
    setChooserOpen(false);
    if (previous != null) {
      await deleteQuiet(previous);
    }
  }, [attachBusy, busy]);

  // v46: تنظيف إلغاء التركيب — الملف اليتيم. يعمل عند أي إغلاق
  // للنافذة (زر X / الخلفية / زر الرجوع) بلا تأكيد: الملف لم يُربط
  // بأي صف في القاعدة فيُحذف كي لا تتراكم ملفات بلا سندات.
  useEffect(
    () => () => {
      const orphan = photoRef.current;
      if (orphan != null && !committedRef.current) {
        void deleteQuiet(orphan);
      }
    },
    [],
  );

  // v27 (round-35 #3): the gate applies to ALL THREE movements.
  const gate = securityMode !== 'none' && authStage !== 'passed';
  // v46: قف عمود المحتوى على التابلت العريض عند 560 — نموذج بحجم
  // الهاتف أنيق بدل تمدد مبالغ، مع بقاء الخلفية ملء الشاشة (نفس
  // قاعدة الأعمدة في تطبيقات POS العالمية على التابلت).
  const colMax = useMemo<ViewStyle | null>(
    () => (winW > 600 ? {maxWidth: 560, width: '100%'} : null),
    [winW],
  );

  return (
    <View style={sheetStyles(c).backdrop}>
      <Pressable style={{flex: 1}} onPress={backdropPressGuarded} />
      {/* v46: البنية النهائية المتكيفة مع كل الأجهزة:
          • الإطار: ارتفاع '100%' من الحاوية في أول إطار (صحيح بالبناء
            على أي جهاز/روم — لا افتراض أن أبعاد النافذة تساوي المساحة
            المرئية) ثم يُجمَّد بـ onLayout فيحتفظ بارتفاعه الكامل فوق
            لوحة النظام (سلوك v33 المطلوب) ولا يتقلص أبداً.
          • الداخل: الترويسة مثبّتة، والوسط كله (بطاقة الرصيد والمبلغ
            والملاحظة وصورة السند والفئات) داخل ScrollView واحد flex:1
            يمتص كل تفاوت الأحجام، ولوحة الأرقام وزر التأكيد مثبّتان
            أسفل النافذة خارج التمرير — لا يمكن أن تُقطعا على أي جهاز
            مهما قصرت الشاشة (وضع أفقي/هواتف صغيرة) أو كبرت (تابلت).
          • على التابلت العريض يُقف عمود المحتوى عند 560 (colMax).
          • وما زال صفر مستمعات Keyboard: لوحة النظام لا تُستدعى
            للمبلغ أصلاً (لوحة مدمجة منذ v29) فلا شيء يتحرك لحظة فتح
            أي لوحة (الملاحظة وحدها اختيارية والـ ScrollView يجلبها). */}
      <View
        style={[
          sheetStyles(c).sheet,
          {
            // v46: '100%' من الحاوية أول إطار → تُجمَّد من أول onLayout.
            height: frozenH ?? '100%',
            paddingTop: Math.max(insets.top, 10),
            paddingBottom: Math.max(insets.bottom, 10),
          },
        ]}
        onLayout={freezeLayout}>
        <Pressable style={{flex: 1}} onPress={() => undefined} disabled={busy}>
          {/* ── Header ── */}
          <View style={sheetStyles(c).head}>
            <View
              style={[
                sheetStyles(c).headIcon,
                {
                  backgroundColor:
                    mode === 'expense'
                      ? c.dangerSoft
                      : mode === 'withdrawal'
                      ? c.warningSoft
                      : c.successSoft,
                },
              ]}>
              <Icon
                name={KIND_META[mode].icon}
                size={20}
                color={
                  mode === 'expense'
                    ? c.danger
                    : mode === 'withdrawal'
                    ? c.warning
                    : c.success
                }
              />
            </View>
            <View style={{flex: 1}}>
              <Text style={sheetStyles(c).headTitle}>{SHEET_TITLES[mode]}</Text>
              <Text style={sheetStyles(c).headSub}>{SHEET_SUBS[mode]}</Text>
            </View>
            <TouchableOpacity
              onPress={onClose}
              style={sheetStyles(c).closeBtn}
              disabled={busy || authStage === 'authorizing'}>
              <Icon name="x" size={16} color={c.textDim} />
            </TouchableOpacity>
          </View>

          {gate ? (
            /* ── The security gate — fingerprint prompt / PIN pad.
                v46: داخل ScrollView بمحتوى نامٍ وموسّط — لوحة PIN
                (مفاتيح 64px ثابتة في مكوّن PinPad) تتمرر بدل أن
                تُقطع على الشاشات القصيرة/الوضع الأفقي، وصف البصمة
                يظل موسّطاً في وسط المساحة على كل الأجهزة. ── */
            <ScrollView
              style={{flex: 1}}
              contentContainerStyle={[sheetStyles(c).gateScroll, colMax]}
              showsVerticalScrollIndicator={false}>
              {securityMode === 'biometric' && authStage !== 'pin-fallback' ? (
                <View style={sheetStyles(c).gateBox}>
                  <View style={sheetStyles(c).gateIcon}>
                    <Icon name="fingerprint" size={44} color={c.accent} />
                  </View>
                  <Text style={sheetStyles(c).gateTitle}>
                    أكّد هويتك بالبصمة
                  </Text>
                  <Text style={sheetStyles(c).gateSub}>
                    {BIO_PROMPTS[mode].sub} — الأولوية للبصمة دائماً
                  </Text>
                  {authStage === 'authorizing' ? (
                    <ActivityIndicator size="large" color={c.accent} />
                  ) : (
                    <AppButton
                      title="إعادة محاولة البصمة"
                      icon="fingerprint"
                      onPress={() => void runBiometric()}
                      style={{alignSelf: 'stretch'}}
                    />
                  )}
                  {hasPin ? (
                    <TouchableOpacity
                      onPress={() => setAuthStage('pin-fallback')}
                      disabled={authStage === 'authorizing'}>
                      <Text style={sheetStyles(c).gatePinLink}>
                        استخدم رمز PIN بدلاً من البصمة
                      </Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              ) : (
                <View style={sheetStyles(c).pinBox}>
                  <Text style={sheetStyles(c).gateTitle}>
                    {securityMode === 'biometric'
                      ? 'أدخل رمز PIN — بديل البصمة'
                      : 'أدخل رمز PIN لإتمام العملية'}
                  </Text>
                  <PinPad
                    title="رمز التأمين"
                    subtitle="رمز الدخول الخاص بالتطبيق"
                    errorText={pinError}
                    shakeSignal={shakeSignal}
                    onSubmit={handlePinSubmit}
                  />
                </View>
              )}
            </ScrollView>
          ) : (
            /* ── The entry form ── */
            <>
              {/* v27 (round-35 #3): the unsecured alert — ALL THREE
                  movements now pass the gate, so when NOTHING is
                  configured the merchant is told loudly to enable
                  protection (with a one-tap jump to the security
                  settings); the operation stays possible, recorded
                  «بدون تأمين». */}
              {securityMode === 'none' ? (
                <View style={sheetStyles(c).warnBox}>
                  <Icon name="alert" size={14} color={c.warning} />
                  <View style={{flex: 1}}>
                    <Text style={sheetStyles(c).warnText}>
                      لا بصمة ولا رمز PIN مفعّل — سيُسجّل السند «بدون تأمين».
                      فعّل الحماية من إعدادات الأمان لضمان عمليات الخزينة.
                    </Text>
                    <TouchableOpacity
                      style={sheetStyles(c).enableSecurityBtn}
                      onPress={() => {
                        onClose();
                        navigation.navigate('Security');
                      }}
                      activeOpacity={0.8}>
                      <Icon name="shield" size={13} color={c.warning} />
                      <Text style={sheetStyles(c).enableSecurityText}>
                        تفعيل الحماية الآن
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : null}

              {/* v33 (round-41 #7) → v46: ترتيب النافذة بطلب التاجر —
                  بطاقة رصيد حيّة ثم المبلغ (من اليمين و₪ باليسار) ثم
                  الملاحظة ثم صورة السند ثم الفئات، وكل هذا الوسط داخل
                  تمرير واحد — ولوحة الأرقام وزر التأكيد مثبّتان تحته
                  خارج التمرير فلا يُقطعان على أي جهاز أبداً. */}
              <View style={sheetStyles(c).formWrap}>
                <ScrollView
                  style={{flex: 1}}
                  contentContainerStyle={[sheetStyles(c).formScroll, colMax]}
                  showsVerticalScrollIndicator={false}
                  keyboardShouldPersistTaps="handled">
                  {/* ① بطاقة الرصيد الحيّة — أعلى النافذة. حجم
                      الأرقام متكيف من ارتفاع النافذة (v46). */}
                  <View
                    style={[
                      sheetStyles(c).balanceStrip,
                      overDrawer ? {borderColor: c.danger} : null,
                    ]}>
                    <View style={sheetStyles(c).balanceCell}>
                      <Text style={sheetStyles(c).balanceLabel}>
                        {isOut ? 'النقد المتاح بالخزينة' : 'النقد الحالي بالخزينة'}
                      </Text>
                      <Text
                        style={[
                          sheetStyles(c).balanceValue,
                          {
                            color: overDrawer ? c.danger : c.text,
                            fontSize: dyn.balanceFont,
                          },
                        ]}>
                        {formatMoney(drawerMinor / 100)}
                      </Text>
                    </View>
                    <View style={sheetStyles(c).balanceDivider} />
                    <View style={sheetStyles(c).balanceCell}>
                      <Text style={sheetStyles(c).balanceLabel}>
                        {mode === 'withdrawal'
                          ? 'الرصيد بعد السحب'
                          : mode === 'expense'
                          ? 'الرصيد بعد المصروف'
                          : 'الرصيد بعد الإيداع'}
                      </Text>
                      {overDrawer ? (
                        <Text
                          style={[
                            sheetStyles(c).balanceValue,
                            {color: c.danger, fontSize: dyn.balanceFont},
                          ]}>
                          المبلغ أكبر من المتاح!
                        </Text>
                      ) : (
                        <Text
                          style={[
                            sheetStyles(c).balanceValue,
                            {
                              color:
                                amountMinor > 0
                                  ? isOut
                                    ? c.danger
                                    : c.success
                                  : c.text,
                              fontSize: dyn.balanceFont,
                            },
                          ]}>
                          {formatMoney(
                            (isOut
                              ? drawerMinor - amountMinor
                              : drawerMinor + amountMinor) / 100,
                          )}
                        </Text>
                      )}
                    </View>
                  </View>

                  {/* ② المبلغ — المبلغ من اليمين ورمز العملة باليسار
                      (عرض فقط بلا TextInput — لوحة النظام لا تُستدعى
                      للمبلغ إطلاقاً منذ v29). حجم الخط متكيف من ارتفاع
                      النافذة (v46) — أكبر وأوضح على التابلت. */}
                  <View
                    style={[
                      sheetStyles(c).amountRow,
                      overDrawer ? {borderColor: c.danger} : null,
                    ]}>
                    <Text
                      style={[
                        sheetStyles(c).amountDisplay,
                        {fontSize: dyn.amountFont},
                        amountText === '' ? {color: c.textFaint} : null,
                      ]}>
                      {amountText === '' ? '0.00' : amountText}
                    </Text>
                    <View style={sheetStyles(c).amountSideRow}>
                      <Text style={sheetStyles(c).amountSuffix}>₪</Text>
                      {amountText !== '' ? (
                        <TouchableOpacity
                          style={sheetStyles(c).amountClearBtn}
                          onPress={() => setAmountText('')}
                          disabled={busy}
                          activeOpacity={0.75}>
                          <Icon name="x" size={13} color={c.textDim} />
                          <Text style={sheetStyles(c).amountClearText}>
                            مسح
                          </Text>
                        </TouchableOpacity>
                      ) : null}
                    </View>
                  </View>

                  {/* ③ الملاحظة — سطر واحد فوق منطقة الفئات.
                      v39 (الجولة 47): في نافذتي السحب والإيداع فقط —
                      حقل أكبر متعدد الأسطر لوصف العملية براحتها (طلب
                      التاجر صريح بهاتين النافذتين فقط)؛ المصروف يبقى
                      سطراً مضغوطاً فوق شبكة الفئات. ارتفاع الحقل الكبير
                      متكيف من ارتفاع النافذة (v46). */}
                  <TextInput
                    style={[
                      sheetStyles(c).noteInput,
                      mode !== 'expense'
                        ? [sheetStyles(c).noteInputBig, {height: dyn.noteBigH}]
                        : null,
                    ]}
                    value={note}
                    onChangeText={setNote}
                    placeholder={
                      mode === 'expense'
                        ? 'ملاحظة (اختياري) — مثال: فاتورة كهرباء شهر 10'
                        : 'ملاحظة العملية (اختياري) — مثال: سحب لتسديد المورد أبو محمد، إيداع فائق يوم البيع'
                    }
                    placeholderTextColor={c.textFaint}
                    maxLength={140}
                    editable={!busy}
                    multiline={mode !== 'expense'}
                  />

                  {/* ④ صورة السند (v46) — طلب التاجر: زر بأيقونة
                      لإمكانية رفع صورة السند أو تصويره، تُرفق بالعملية
                      ويمكن مراجعتها باحتراف من سجل الحركات. مساران بلا
                      اعتماديات جديدة: الكاميرا (الماسح الأصلي) أو
                      المعرض (منتقي النظام)، مع معاينة واستبدال وإزالة. */}
                  <View style={sheetStyles(c).voucherCard}>
                    {attachBusy ? (
                      <View style={sheetStyles(c).voucherBusy}>
                        <ActivityIndicator size="small" color={c.accent} />
                        <Text style={sheetStyles(c).voucherBusyText}>
                          جارٍ تجهيز الصورة…
                        </Text>
                      </View>
                    ) : photoPath != null ? (
                      <>
                        <View style={sheetStyles(c).voucherRow}>
                          <RNImage
                            source={{uri: fileUri(photoPath)}}
                            style={[
                              sheetStyles(c).voucherThumb,
                              {width: dyn.thumb, height: dyn.thumb},
                            ]}
                          />
                          <View style={{flex: 1}}>
                            <Text style={sheetStyles(c).voucherTitle}>
                              صورة السند مرفقة
                            </Text>
                            <Text style={sheetStyles(c).voucherSub}>
                              تُحفظ مع السند ويمكن مراجعتها من سجل الحركات
                            </Text>
                          </View>
                        </View>
                        {chooserOpen ? (
                          <VoucherChooser
                            onCamera={() => void attachFromCamera()}
                            onGallery={() => void attachFromGallery()}
                            onCancel={() => setChooserOpen(false)}
                          />
                        ) : (
                          <View style={sheetStyles(c).voucherActions}>
                            <TouchableOpacity
                              style={sheetStyles(c).voucherActionBtn}
                              onPress={() => setChooserOpen(true)}
                              disabled={busy}
                              activeOpacity={0.7}>
                              <Icon name="camera" size={14} color={c.accent} />
                              <Text
                                style={[
                                  sheetStyles(c).voucherActionText,
                                  {color: c.accent},
                                ]}>
                                استبدال الصورة
                              </Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                              style={[
                                sheetStyles(c).voucherActionBtn,
                                sheetStyles(c).voucherRemoveBtn,
                              ]}
                              onPress={() => void removeVoucher()}
                              disabled={busy}
                              activeOpacity={0.7}>
                              <Icon name="x" size={14} color={c.danger} />
                              <Text
                                style={[
                                  sheetStyles(c).voucherActionText,
                                  {color: c.danger},
                                ]}>
                                إزالة
                              </Text>
                            </TouchableOpacity>
                          </View>
                        )}
                      </>
                    ) : chooserOpen ? (
                      <VoucherChooser
                        onCamera={() => void attachFromCamera()}
                        onGallery={() => void attachFromGallery()}
                        onCancel={() => setChooserOpen(false)}
                      />
                    ) : (
                      <TouchableOpacity
                        style={sheetStyles(c).voucherAdd}
                        onPress={() => setChooserOpen(true)}
                        disabled={busy}
                        activeOpacity={0.8}>
                        <View style={sheetStyles(c).voucherAddIcon}>
                          <Icon name="imagePlus" size={20} color={c.accent} />
                        </View>
                        <View style={{flex: 1}}>
                          <Text style={sheetStyles(c).voucherAddText}>
                            إرفاق صورة السند
                          </Text>
                          <Text style={sheetStyles(c).voucherAddHint}>
                            تصوير بالكاميرا أو اختيار من المعرض — تُحفظ مع
                            السند ويمكن مراجعتها من السجل
                          </Text>
                        </View>
                        <Icon
                          name={I18nManager.isRTL ? 'chevronLeft' : 'chevronRight'}
                          size={16}
                          color={c.textFaint}
                        />
                      </TouchableOpacity>
                    )}
                  </View>

                  {/* ⑤ الفئات — فئات المصروف فقط والفئة المخصصة،
                      داخل التمرير نفسه (v46: كان له تمرير منفصل). */}
                  {mode === 'expense' ? (
                    <>
                      {showCustom ? (
                        <TextInput
                          style={sheetStyles(c).customInput}
                          value={customCategory}
                          onChangeText={setCustomCategory}
                          placeholder="اكتب اسم الفئة…"
                          placeholderTextColor={c.textFaint}
                          maxLength={40}
                          editable={!busy}
                        />
                      ) : null}
                      <View style={sheetStyles(c).catGrid}>
                        {EXPENSE_CATEGORIES.map(cat => {
                          const active = !showCustom && category === cat;
                          return (
                            <TouchableOpacity
                              key={cat}
                              style={[
                                sheetStyles(c).catChip,
                                active && {
                                  backgroundColor: c.accent,
                                  borderColor: c.accent,
                                },
                              ]}
                              onPress={() => {
                                setCategory(cat);
                                setShowCustom(false);
                              }}
                              activeOpacity={0.7}>
                              <Text
                                style={[
                                  sheetStyles(c).catChipText,
                                  {color: active ? c.onAccent : c.textDim},
                                ]}>
                                {cat}
                              </Text>
                            </TouchableOpacity>
                          );
                        })}
                        <TouchableOpacity
                          style={[
                            sheetStyles(c).catChip,
                            showCustom && {
                              backgroundColor: c.accent,
                              borderColor: c.accent,
                            },
                          ]}
                          onPress={() => setShowCustom(true)}
                          activeOpacity={0.7}>
                          <Text
                            style={[
                              sheetStyles(c).catChipText,
                              {color: showCustom ? c.onAccent : c.textDim},
                            ]}>
                            فئة أخرى…
                          </Text>
                        </TouchableOpacity>
                      </View>
                    </>
                  ) : null}
                </ScrollView>

                {/* ⑥ لوحة الأرقام — مثبّتة أسفل النافذة خارج التمرير:
                    تبقى مركّبة دائماً ولا تقفز أبداً (ارتفاع النافذة
                    مجمد من لحظة الفتح) وحجم المفاتيح وأرقامها متكيفان
                    من ارتفاع النافذة — أكبر على التابلت وأدنى مريح على
                    الهواتف القصيرة (v46). */}
                <View style={[sheetStyles(c).keypad, colMax]}>
                  {AMOUNT_KEYPAD_KEYS.map((row, rowIndex) => (
                    <View key={rowIndex} style={sheetStyles(c).keypadRow}>
                      {row.map(key => (
                        <TouchableOpacity
                          key={key}
                          style={[
                            sheetStyles(c).keypadKey,
                            {height: dyn.keyH},
                            key === '⌫' ? sheetStyles(c).keypadKeyDanger : null,
                          ]}
                          onPress={() =>
                            setAmountText(prev => applyAmountKey(prev, key))
                          }
                          disabled={busy}
                          activeOpacity={0.65}>
                          <Text
                            style={[
                              sheetStyles(c).keypadKeyText,
                              {fontSize: dyn.keyFont},
                            ]}>
                            {key}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  ))}
                </View>

                {/* ⑦ زر التأكيد — المبلغ مكتوب عليه والرصيد بعد
                    العملية معروض لحظياً في البطاقة أعلاه. مثبّت أسفل
                    النافذة خارج التمرير — مرئي دائماً على كل جهاز. */}
                <View style={colMax}>
                  <AppButton
                    title={
                      amountMinor > 0
                        ? `تأكيد ${KIND_META[mode].label} — ${formatMoney(
                            amountMinor / 100,
                          )}`
                        : 'أدخل المبلغ أولاً'
                    }
                    icon={KIND_META[mode].icon}
                    onPress={() => void confirm()}
                    loading={busy}
                    disabled={amountMinor <= 0 || overDrawer}
                  />
                </View>
              </View>
            </>
          )}
        </Pressable>
      </View>
    </View>
  );
}

/** The MovementSheet's own styles. */
function sheetStyles(c: ReturnType<typeof useThemeColors>) {
  return StyleSheet.create({
    backdrop: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      // v33 (round-41 #7): النافذة مثبتة الأعلى (ليست flex-end) —
      // بارتفاع كامل مثبّت يتجاوز القاع المتقلص فتبقى عناصرها
      // أماكنها تحت لوحة النظام بدل أن تُدفع للأعلى.
      justifyContent: 'flex-start',
      zIndex: 70,
      elevation: 70,
    },
    sheet: {
      backgroundColor: c.bg,
      // v30 (round-38 #1): نافذة بملء الشاشة — بلا حواف مدوّرة
      // ولا حشوات عمودية ثابتة (الحشوة من SafeArea inline).
      borderTopLeftRadius: 0,
      borderTopRightRadius: 0,
      paddingHorizontal: spacing.lg,
      borderWidth: 0,
      overflow: 'hidden',
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
    gateBox: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
    },
    gateIcon: {
      width: 84,
      height: 84,
      borderRadius: 26,
      backgroundColor: c.accentSofter,
      alignItems: 'center',
      justifyContent: 'center',
    },
    gateTitle: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.body,
      textAlign: 'center',
    },
    gateSub: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      textAlign: 'center',
      lineHeight: 19,
    },
    gatePinLink: {
      color: c.info,
      fontFamily: fonts.bold,
      fontSize: typography.small,
      paddingVertical: spacing.sm,
    },
    pinBox: {
      flex: 1,
      paddingTop: spacing.md,
    },
    warnBox: {
      flexDirection: 'row',
      gap: spacing.sm,
      alignItems: 'flex-start',
      backgroundColor: c.warningSoft,
      borderRadius: radius.md,
      padding: spacing.md,
      marginBottom: spacing.md,
    },
    warnText: {
      flex: 1,
      color: c.warning,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      lineHeight: 18,
    },
    /** v27 (round-35 #3): the «تفعيل الحماية الآن» jump button —
     *  shown inside the unsecured alert when no biometric and no
     *  PIN are configured. */
    enableSecurityBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      alignSelf: 'flex-start',
      marginTop: spacing.sm,
      paddingVertical: spacing.xs + 2,
      paddingHorizontal: spacing.sm,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: c.warning,
      backgroundColor: c.surfaceHi,
    },
    enableSecurityText: {
      color: c.warning,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    /** v46: بوابة الأمان داخل تمرير نامٍ — البصمة تتمركز في وسط
     *  المساحة ولوحة PIN تتمرر على الشاشات القصيرة بدل أن تُقطع. */
    gateScroll: {
      flexGrow: 1,
      justifyContent: 'center',
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.md,
    },
    /** v46: وسط نموذج الإدخال — تمرير نامٍ متمركز: المحتوى القصير
     *  يتمركز أنيقاً على الشاشات العالية (تابلت) والمحتوى الطويل
     *  (فئات المصروف + صورة السند) يتمرر على الشاشات القصيرة. */
    formScroll: {
      flexGrow: 1,
      justifyContent: 'center',
      gap: spacing.md,
      paddingBottom: spacing.sm,
    },
    /** v46: بطاقة إرفاق صورة السند داخل نموذج الإدخال. */
    voucherCard: {
      borderWidth: 1.5,
      borderStyle: 'dashed',
      borderColor: c.border,
      borderRadius: radius.md,
      padding: spacing.md,
      backgroundColor: c.surface,
    },
    voucherBusy: {
      flexDirection: 'row',
      gap: spacing.sm,
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 10,
    },
    voucherBusyText: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    voucherRow: {
      flexDirection: 'row',
      gap: spacing.md,
      alignItems: 'center',
    },
    voucherThumb: {
      borderRadius: 10,
      backgroundColor: c.surfaceAlt,
      borderWidth: 1,
      borderColor: c.borderSoft,
    },
    voucherTitle: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.body,
    },
    voucherSub: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      marginTop: 2,
    },
    voucherActions: {
      flexDirection: 'row',
      gap: spacing.sm,
    },
    voucherActionBtn: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: radius.sm,
      paddingVertical: 9,
      backgroundColor: c.surfaceAlt,
    },
    voucherRemoveBtn: {
      borderColor: c.danger,
      backgroundColor: c.dangerSoft,
    },
    voucherActionText: {
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    voucherAdd: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
    },
    voucherAddIcon: {
      width: 44,
      height: 44,
      borderRadius: 14,
      backgroundColor: c.accentSofter,
      alignItems: 'center',
      justifyContent: 'center',
    },
    voucherAddText: {
      color: c.accent,
      fontFamily: fonts.bold,
      fontSize: typography.body,
    },
    voucherAddHint: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      marginTop: 2,
    },
    form: {
      gap: spacing.sm,
      paddingVertical: spacing.sm,
    },
    /** v33 (round-41 #7): غلاف النموذج — مسافات متساوية (gap) بين
     *  بطاقة الرصيد والمبلغ والملاحظة والفئات ولوحة الأرقام وزر
     *  التأكيد، فلا التصاق ولا تداخل. */
    formWrap: {
      flex: 1,
      gap: spacing.md,
    },
    amountRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      backgroundColor: c.surfaceAlt,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.sm,
      paddingHorizontal: spacing.md,
    },
    /** v31 (round-39 #2): المبلغ — عرض فقط (لا TextInput) + زر مسح.
     *  مُدمج قليلاً (26px) لتتسع الترويسة والملاحظة ولوحة الأرقام
     *  معاً فوق أي شاشة. */
    amountDisplay: {
      flex: 1,
      color: c.text,
      fontFamily: fonts.black,
      fontSize: 26,
      paddingVertical: 9,
      textAlign: I18nManager.isRTL ? 'right' : 'left',
      fontVariant: ['tabular-nums'],
    },
    amountSuffix: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.body,
    },
    /** v33: جانب العملة — ₪ وزر المسح معاً في أقصى يسار البطاقة. */
    amountSideRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    amountClearBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 3,
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: radius.sm,
      paddingHorizontal: 8,
      paddingVertical: 4,
      backgroundColor: c.surfaceHi,
    },
    amountClearText: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.caption,
    },
    /** v31 (round-39 #2): لوحة الأرقام المدمجة — مركّبة دائماً
     *  (أبداً لا تُفكّك)، أزرار 46px مريحة تفسح للملاحظة المثبتة
     *  فوقها مساحة كافية مهما ارتفعت لوحة النظام. */
    keypad: {
      gap: spacing.xs + 2,
    },
    keypadRow: {
      flexDirection: 'row',
      gap: spacing.xs + 2,
    },
    keypadKey: {
      flex: 1,
      height: 46,
      borderRadius: radius.md,
      backgroundColor: c.surfaceAlt,
      borderWidth: 1,
      borderColor: c.borderSoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    keypadKeyDanger: {
      borderColor: c.danger,
    },
    keypadKeyText: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: 21,
      fontVariant: ['tabular-nums'],
    },
    /** v33 (round-41 #7): بطاقة الرصيد الحيّة — أعلى النافذة،
     *  أكبر قليلاً كي تُقرأ فوراً (المتاح الآن + بعد العملية). */
    balanceStrip: {
      flexDirection: 'row',
      alignItems: 'stretch',
      backgroundColor: c.surfaceAlt,
      borderWidth: 1.5,
      borderColor: c.border,
      borderRadius: radius.md,
      paddingVertical: 10,
      paddingHorizontal: spacing.md,
    },
    balanceCell: {
      flex: 1,
      alignItems: 'center',
      gap: 2,
    },
    balanceDivider: {
      width: 1,
      backgroundColor: c.borderSoft,
      marginVertical: 2,
    },
    balanceLabel: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.micro + 1,
    },
    balanceValue: {
      fontFamily: fonts.black,
      fontSize: typography.body + 2,
      fontVariant: ['tabular-nums'],
    },
    drawerHint: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.small,
    },
    catGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
    },
    catChip: {
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: 6,
      paddingHorizontal: 10,
      paddingVertical: 6,
      minHeight: 30,
      justifyContent: 'center',
      backgroundColor: c.surface,
    },
    catChipText: {
      fontFamily: fonts.bold,
      fontSize: 11.5,
    },
    customInput: {
      color: c.text,
      fontFamily: fonts.regular,
      fontSize: typography.body,
      backgroundColor: c.surfaceAlt,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: 9,
    },
    /** v31 (round-39 #2): الملاحظة — سطر واحد مضغوط مثبّت تحت
     *  المبلغ (بلا label — العنوان placeholder داخل الحقل)، يبقى
     *  مرئياً ومكتوباً دائماً حتى مع لوحة النظام مفتوحة.
     *  v39 (الجولة 47): نافذتا السحب والإيداع فقط — حقل ملاحظة
     *  أكبر متعدد الأسطر (طلب التاجر: «قم في نافذتي السحب والايداع
     *  فقط بتكبير حقل إدخال الملاحظات»)؛ نافذة المصروف تبقى سطراً
     *  واحداً مضغوطاً كي لا تزاحم شبكة الفئات. */
    noteInput: {
      color: c.text,
      fontFamily: fonts.regular,
      fontSize: typography.body,
      backgroundColor: c.surfaceAlt,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: 9,
      minHeight: 44,
      textAlignVertical: 'center',
    },
    /** v39: النسخة الكبيرة — سحب/إيداع فقط. */
    noteInputBig: {
      minHeight: 84,
      textAlignVertical: 'top',
      paddingVertical: spacing.sm,
    },
  });
}

/** v39 (الجولة 47): أنماط نافذة مراجعة السند — نفس لغة نافذة
 *  الإدخال (INLINE overlay، بلا Modal أبداً — درس هذا الروم). */
function detailStyles(c: ReturnType<typeof useThemeColors>) {
  return StyleSheet.create({
    backdrop: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(0,0,0,0.55)',
      justifyContent: 'flex-end',
      zIndex: 90,
    },
    sheet: {
      backgroundColor: c.bg,
      borderTopLeftRadius: radius.lg,
      borderTopRightRadius: radius.lg,
      padding: spacing.lg,
      gap: spacing.md,
      borderTopWidth: 3,
      borderColor: c.accent,
    },
    head: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
    },
    headIcon: {
      width: 44,
      height: 44,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
    },
    headTitle: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: typography.body + 1,
    },
    headSub: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.small,
      fontVariant: ['tabular-nums'],
    },
    closeBtn: {
      width: 34,
      height: 34,
      borderRadius: 12,
      backgroundColor: c.surfaceAlt,
      borderWidth: 1,
      borderColor: c.borderSoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    amountRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      backgroundColor: c.surfaceAlt,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
    },
    amountLabel: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    amountValue: {
      fontFamily: fonts.black,
      fontSize: 24,
      fontVariant: ['tabular-nums'],
    },
    rows: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: radius.md,
      overflow: 'hidden',
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.md,
      paddingVertical: 10,
      borderBottomWidth: 1,
      borderBottomColor: c.borderSoft,
      gap: spacing.md,
    },
    rowLabel: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    rowValue: {
      color: c.text,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      flex: 1,
      textAlign: 'left',
    },
    /** v46: بطاقة صورة السند داخل نافذة المراجعة. */
    photoCard: {
      borderWidth: 1.5,
      borderColor: c.accentSoft,
      borderRadius: radius.md,
      padding: spacing.md,
      backgroundColor: c.surface,
      gap: spacing.sm,
    },
    photoImage: {
      width: '100%',
      height: 180,
      borderRadius: radius.sm,
      backgroundColor: c.surfaceAlt,
    },
    photoCaptionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    photoCaptionText: {
      flex: 1,
      color: c.accent,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    photoMissing: {
      flexDirection: 'row',
      gap: spacing.sm,
      alignItems: 'flex-start',
      backgroundColor: c.warningSoft,
      borderRadius: radius.md,
      padding: spacing.md,
    },
    photoMissingText: {
      flex: 1,
      color: c.warning,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      lineHeight: 18,
    },
    noteBox: {
      flexDirection: 'row',
      gap: spacing.sm,
      alignItems: 'flex-start',
      backgroundColor: c.warningSoft,
      borderRadius: radius.md,
      padding: spacing.md,
    },
    noteText: {
      flex: 1,
      color: c.text,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      lineHeight: 18,
    },
    actions: {
      flexDirection: 'row',
      gap: spacing.sm,
    },
  });
}

const useStyles = makeStyles(c =>
  StyleSheet.create({
    screen: {flex: 1, backgroundColor: c.bg},
    content: {
      padding: spacing.lg,
      paddingBottom: spacing.xxl,
      gap: spacing.md,
    },
    drawerCard: {padding: spacing.lg},
    drawerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
    },
    drawerIcon: {
      width: 52,
      height: 52,
      borderRadius: 16,
      alignItems: 'center',
      justifyContent: 'center',
    },
    drawerLabel: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    drawerValue: {
      fontFamily: fonts.black,
      fontSize: 26,
      marginTop: 2,
    },
    drawerMeta: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      marginTop: 2,
    },
    securityHint: {
      flexDirection: 'row',
      gap: spacing.sm,
      alignItems: 'center',
      backgroundColor: c.warningSoft,
      borderRadius: radius.md,
      padding: spacing.md,
      marginTop: spacing.md,
    },
    securityHintText: {
      flex: 1,
      color: c.warning,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      lineHeight: 18,
    },
    actionsRow: {
      flexDirection: 'row',
      gap: spacing.sm,
    },
    actionBtn: {
      flex: 1,
      borderWidth: 1.5,
      borderRadius: radius.md,
      padding: spacing.md,
      alignItems: 'center',
      gap: 8,
      backgroundColor: c.surface,
    },
    actionIcon: {
      width: 44,
      height: 44,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
    },
    actionLabel: {
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    chipRow: {
      flexDirection: 'row',
      gap: 6,
      flexWrap: 'wrap',
    },
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
    chipText: {
      fontFamily: fonts.bold,
      fontSize: 11.5,
    },
    totalsCard: {padding: spacing.lg, alignItems: 'center'},
    totalsLabel: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.small,
      textAlign: 'center',
    },
    totalsValue: {
      fontFamily: fonts.black,
      fontSize: 28,
      marginTop: 4,
    },
    totalsMeta: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      marginTop: 2,
    },
    totalsBreak: {
      marginTop: spacing.sm,
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    totalsBreakLine: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      textAlign: 'center',
    },
    centerBox: {paddingVertical: spacing.xxl},
    ledger: {gap: spacing.sm},
    /** v26 (round-34 #5): the load-more footer of the paged ledger. */
    loadMoreBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      borderWidth: 1.5,
      borderStyle: 'dashed',
      borderColor: c.accentSoft,
      borderRadius: radius.md,
      paddingVertical: 14,
      backgroundColor: c.surface,
    },
    loadMoreText: {
      color: c.accent,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    ledgerEndText: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      textAlign: 'center',
      paddingVertical: 10,
    },
    ledgerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: radius.md,
      padding: spacing.md,
    },
    ledgerIcon: {
      width: 38,
      height: 38,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
    },
    ledgerHeadRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    ledgerTitle: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.caption,
      flexShrink: 1,
    },
    ledgerAmount: {
      fontFamily: fonts.black,
      fontSize: typography.body,
    },
    ledgerMeta: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      marginTop: 2,
    },
    ledgerNote: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      marginTop: 2,
    },
    /** v39 (الجولة 47): البحث في السجل + شرائح الفئات. */
    searchCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      height: 46,
    },
    searchInput: {
      flex: 1,
      color: c.text,
      fontFamily: fonts.regular,
      fontSize: typography.body,
      paddingVertical: 0,
      textAlign: I18nManager.isRTL ? 'right' : 'left',
    },
    categoryChips: {
      gap: 6,
      paddingBottom: 2,
    },
    categoryChip: {
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: 6,
      paddingHorizontal: 10,
      paddingVertical: 5,
      minHeight: 28,
      justifyContent: 'center',
      backgroundColor: c.surface,
    },
    categoryChipText: {
      fontFamily: fonts.bold,
      fontSize: 11.5,
    },
    filterNote: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.small,
    },
    pdfCard: {padding: spacing.lg, gap: spacing.sm},
    pdfRow: {
      flexDirection: 'row',
      gap: spacing.sm,
    },
    pdfHint: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      lineHeight: 18,
      textAlign: 'center',
    },
  }),
);
