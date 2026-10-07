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
 * النافذة ثابت يُلتقط مرة عند الفتح، وصفر مستمعات Keyboard في
 * الشاشة كلها — لا شيء يتحرك حين تُفتح أي لوحة، فلا يستسلم الـ
 * IME ويغلقها. الملاحظة (اختيارية) تظل TextField عادية بلا أي
 * رد فعل JS على اللوحة.
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  ActivityIndicator,
  BackHandler,
  Dimensions,
  I18nManager,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
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
import type {
  CashMovementKind,
  CashMovementRecord,
  CashMovementTotals,
} from '../../core/types';

type PeriodKey = 'today' | 'week' | 'month' | 'all';

const PERIOD_OPTIONS: {value: PeriodKey; label: string}[] = [
  {value: 'today', label: 'اليوم'},
  {value: 'week', label: '7 أيام'},
  {value: 'month', label: 'الشهر'},
  {value: 'all', label: 'الكل'},
];

type KindFilter = 'all' | CashMovementKind;

/** v26 (round-34 #5): the ledger's page size — the on-screen list
 *  grows by one page per «تحميل المزيد» press instead of mounting
 *  the whole history (months of accumulated vouchers) in one shot,
 *  and the total counter tells the merchant there is more below. */
const LEDGER_PAGE = 60;

const KIND_CHIPS: {key: KindFilter; label: string}[] = [
  {key: 'all', label: 'الكل'},
  {key: 'expense', label: 'مصروفات'},
  {key: 'withdrawal', label: 'سحب رصيد'},
  {key: 'deposit', label: 'إيداعات'},
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
      const [page, count, totalsAll, drawer] = await Promise.all([
        CashRepo.list({
          from: range.from,
          to: range.to,
          kind: kindFilter,
          limit: LEDGER_PAGE,
          offset: 0,
        }),
        CashRepo.countFor(range.from, range.to, kindFilter),
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
  }, [range, kindFilter, toast]);

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
        limit: LEDGER_PAGE,
        offset: rows.length,
      });
      setRows(prev =>
        page.length === 0
          ? prev
          : [...prev, ...page.filter(r => !prev.some(p => p.local_id === r.local_id))],
      );
      if (page.length < LEDGER_PAGE) {
        // Everything loaded — pin the counter to the real total.
        const count = await CashRepo.countFor(range.from, range.to, kindFilter);
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
  }, [loadingMore, loading, rows.length, totalCount, range, kindFilter, toast]);

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

  return (
    <View style={styles.screen}>
      <AppHeader title="الخزينة والمصروفات" showBack />

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}>
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

        {/* ── The movements ledger ── */}
        <SectionTitle
          title="سجل الحركات"
          hint={
            totalCount > 0
              ? `عرض ${rows.length} من ${totalCount} سند — مرقمة ولا تُعدّل`
              : 'سندات مرقمة غير قابلة للتعديل — مسار تدقيق كامل'
          }
        />
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
                <View key={row.local_id} style={styles.ledgerRow}>
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
                </View>
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
                      تحميل المزيد ({totalCount - rows.length} سند متبقية)
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

        {/* ── The statement actions ── */}
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
    </View>
  );
}

// ────────────────────────────────────────────────────────────────
// MovementSheet — نافذة تسجيل الحركة (INLINE overlay، ارتفاع ثابت
// 72%، ظهور تدريجي — نفس انضباط نافذة الإرجاع v25 round-32 #1).
// للعمليات الثلاث: بوابة الأمان — البصمة تلقائياً أولاً، وإلا
// لوحة PIN، وإلا تحذير بارز مع زر تفعيل الحماية وتسجيل «بدون تأمين».
// ────────────────────────────────────────────────────────────────

const SHEET_TITLES: Record<CashMovementKind, string> = {
  expense: 'تسجيل مصروف من الخزينة',
  withdrawal: 'سحب رصيد من الخزينة',
  deposit: 'إيداع نقدي في الخزينة',
};

const SHEET_SUBS: Record<CashMovementKind, string> = {
  expense: 'مؤمّن بالبصمة أو رمز PIN — يُخصم من الخزينة ويُطبع سنده فوراً',
  withdrawal: 'مؤمّن بالبصمة أو رمز PIN — السقف ما في الدرج فقط',
  deposit: 'مؤمّن بالبصمة أو رمز PIN — يُضاف للخزينة ويُطبع سنده فوراً',
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

  // v29 (round-37 #1): ارتفاع ثابت يُلتقط مرة واحدة عند فتح
  // النافذة — لا useWindowDimensions ولا أي مستمع Keyboard: حين
  // تُفتح لوحة الملاحظات (اختيارية) لا يتغير أي بعد في الشجرة،
  // والـ ScrollView داخل النافذة يكفي لجلب الحقل المركّز للظهور.
  // هذا بعد أربع جولات فاشلة (v25–v28) من «الرفع/التعويض» —
  // المشكلة لم تكن في مقدار الرفع بل في وجود رد فعل JS أصلاً:
  // أي إعادة تخطيط لحظة استقرار الـ IME تجعل روم الجهاز يغلق
  // اللوحة. المبلغ نفسه صار من لوحة أرقام مدمجة (لا TextInput).
  const fixedSheetHeight = useMemo(
    () =>
      Math.round(
        Math.max(240, Dimensions.get('window').height * 0.72),
      ),
    [],
  );

  // v26 (round-34 #4): instant render (no entrance animation — the
  // ROM lesson from the return sheet) + a 400ms close-guard so a
  // bounced opening touch on the freshly mounted backdrop can never
  // kill the window («الضغط أول مرة وكأنه فتح وأغلق بسرعة»).
  const mountedAt = useRef(Date.now());

  const [amountText, setAmountText] = useState('');
  const [category, setCategory] = useState(
    mode === 'expense' ? EXPENSE_CATEGORIES[0] : mode === 'withdrawal' ? 'سحب رصيد' : 'إيداع نقدي',
  );
  const [customCategory, setCustomCategory] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [showCustom, setShowCustom] = useState(false);
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
        });
      } else if (mode === 'withdrawal') {
        movement = await CashService.recordWithdrawal({
          note: note.trim() || null,
          amountMinor,
          authMethod,
        });
      } else {
        movement = await CashService.recordDeposit({
          note: note.trim() || null,
          amountMinor,
          authMethod,
        });
      }
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
    onDone,
    toast,
  ]);

  // v27 (round-35 #3): the gate applies to ALL THREE movements.
  const gate = securityMode !== 'none' && authStage !== 'passed';

  return (
    <View style={sheetStyles(c).backdrop}>
      <Pressable style={{flex: 1}} onPress={backdropPressGuarded} />
      {/* v29 (round-37 #1): ارتفاع ثابت — لا تعويض ولا رفع. أي
          لوحة تُفتح (ملاحظة اختيارية فقط) تترك هذه الشجرة كما هي
          تماماً؛ لا شيء يتغير حول الحقل المركّز فلا ييأس الـ IME.
          المبلغ يُدخل من لوحة الأرقام المدمجة أدناه — لوحة النظام
          لا تُستدعى للمبلغ إطلاقاً. */}
      <View
        style={[sheetStyles(c).sheet, {height: fixedSheetHeight}]}>
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
            /* ── The security gate — fingerprint prompt / PIN pad ── */
            <View style={{flex: 1}}>
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
            </View>
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
              {authStage === 'passed' ? (
                <View style={[sheetStyles(c).warnBox, {backgroundColor: c.successSoft}]}>
                  <Icon name="checkCircle" size={14} color={c.success} />
                  <Text style={[sheetStyles(c).warnText, {color: c.success}]}>
                    تم التأمين {authMethod === 'fingerprint' ? 'بالبصمة' : 'برمز PIN'} —
                    أكمل العملية
                  </Text>
                </View>
              ) : null}

              <ScrollView
                style={{flex: 1}}
                contentContainerStyle={sheetStyles(c).form}
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled">
                {/* v29 (round-37 #1): المبلغ — عرض فقط + لوحة أرقام
                    مدمجة. لا TextInput هنا: لوحة النظام لا تُستدعى
                    للمبلغ إطلاقاً (نفس نمط لوحة الوزن v9.2 — درس
                    روم الجهاز النهائي: أي تغيير تخطيط لحظة فتح
                    اللوحة يقتلها، فلا تُفتح أصلاً). */}
                <Text style={sheetStyles(c).formLabel}>المبلغ (₪)</Text>
                <View
                  style={[
                    sheetStyles(c).amountRow,
                    overDrawer ? {borderColor: c.danger} : null,
                  ]}>
                  <Text
                    style={[
                      sheetStyles(c).amountDisplay,
                      amountText === '' ? {color: c.textFaint} : null,
                    ]}>
                    {amountText === '' ? '0.00' : amountText}
                  </Text>
                  <Text style={sheetStyles(c).amountSuffix}>₪</Text>
                  {amountText !== '' ? (
                    <TouchableOpacity
                      style={sheetStyles(c).amountClearBtn}
                      onPress={() => setAmountText('')}
                      disabled={busy}
                      activeOpacity={0.75}>
                      <Icon name="x" size={13} color={c.textDim} />
                      <Text style={sheetStyles(c).amountClearText}>مسح</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
                <Text
                  style={[
                    sheetStyles(c).drawerHint,
                    overDrawer ? {color: c.danger} : null,
                  ]}>
                  {isOut
                    ? `النقد المتاح بالخزينة: ${formatMoney(drawerMinor / 100)}`
                    : `النقد الحالي بالخزينة: ${formatMoney(drawerMinor / 100)}`}
                  {overDrawer ? ' — المبلغ أكبر من المتاح!' : ''}
                </Text>

                {/* لوحة الأرقام المدمجة — أرقام وفاصلة وحذف فقط،
                    بقواعد النقود (أغورتان، بلا سوابق صفرية). */}
                <View style={sheetStyles(c).keypad}>
                  {AMOUNT_KEYPAD_KEYS.map((row, rowIndex) => (
                    <View key={rowIndex} style={sheetStyles(c).keypadRow}>
                      {row.map(key => (
                        <TouchableOpacity
                          key={key}
                          style={[
                            sheetStyles(c).keypadKey,
                            key === '⌫' ? sheetStyles(c).keypadKeyDanger : null,
                          ]}
                          onPress={() =>
                            setAmountText(prev => applyAmountKey(prev, key))
                          }
                          disabled={busy}
                          activeOpacity={0.65}>
                          <Text style={sheetStyles(c).keypadKeyText}>{key}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  ))}
                </View>

                {/* Expense categories */}
                {mode === 'expense' ? (
                  <>
                    <Text style={sheetStyles(c).formLabel}>فئة المصروف</Text>
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
                    {showCustom ? (
                      <TextInput
                        style={sheetStyles(c).customInput}
                        value={customCategory}
                        onChangeText={setCustomCategory}
                        placeholder="اكتب اسم الفئة"
                        placeholderTextColor={c.textFaint}
                        editable={!busy}
                      />
                    ) : null}
                  </>
                ) : null}

                {/* Note */}
                <Text style={sheetStyles(c).formLabel}>ملاحظة (اختياري)</Text>
                <TextInput
                  style={sheetStyles(c).noteInput}
                  value={note}
                  onChangeText={setNote}
                  placeholder="مثال: فاتورة كهرباء شهر 10"
                  placeholderTextColor={c.textFaint}
                  multiline
                  editable={!busy}
                />
              </ScrollView>

              {/* ── Confirm ── */}
              <View style={sheetStyles(c).summaryBox}>
                <View style={sheetStyles(c).totalRow}>
                  <Text style={sheetStyles(c).totalLabel}>
                    {isOut ? 'سيُخصم من الخزينة' : 'سيُضاف إلى الخزينة'}
                  </Text>
                  <Text
                    style={[
                      sheetStyles(c).totalValue,
                      {color: isOut ? c.danger : c.success},
                    ]}>
                    {formatMoney(amountMinor / 100)}
                  </Text>
                </View>
                <AppButton
                  title="تأكيد وتسجيل السند"
                  icon={KIND_META[mode].icon}
                  onPress={() => void confirm()}
                  loading={busy}
                  disabled={amountMinor <= 0 || overDrawer}
                />
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
      justifyContent: 'flex-end',
      zIndex: 70,
      elevation: 70,
    },
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
    form: {
      gap: spacing.sm,
      paddingVertical: spacing.md,
    },
    formLabel: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.small,
      marginTop: spacing.xs,
    },
    amountRow: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: c.surfaceAlt,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.sm,
      paddingHorizontal: spacing.md,
    },
    /** v29 (round-37 #1): المبلغ — عرض فقط (لا TextInput) + زر مسح. */
    amountDisplay: {
      flex: 1,
      color: c.text,
      fontFamily: fonts.black,
      fontSize: 24,
      paddingVertical: 10,
      textAlign: I18nManager.isRTL ? 'right' : 'left',
      fontVariant: ['tabular-nums'],
    },
    amountSuffix: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.body,
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
    /** v29 (round-37 #1): لوحة الأرقام المدمجة — نفس مقاسات لوحة
     *  الوزن المجرّبة في نقطة البيع (PosScreen). */
    keypad: {
      gap: spacing.xs + 2,
      marginTop: spacing.xs,
    },
    keypadRow: {
      flexDirection: 'row',
      gap: spacing.xs + 2,
    },
    keypadKey: {
      flex: 1,
      height: 50,
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
      paddingVertical: 8,
    },
    noteInput: {
      color: c.text,
      fontFamily: fonts.regular,
      fontSize: typography.body,
      backgroundColor: c.surfaceAlt,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: 10,
      minHeight: 70,
      textAlignVertical: 'top',
    },
    summaryBox: {
      borderTopWidth: 1,
      borderTopColor: c.borderSoft,
      paddingTop: spacing.md,
      gap: spacing.md,
    },
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
      fontFamily: fonts.black,
      fontSize: typography.heading,
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
