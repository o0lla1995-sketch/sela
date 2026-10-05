/**
 * LocalDebtsScreen — دفتر ديون المتجر (round-22 #4).
 * ─────────────────────────────────────────────────────────────────
 * The STORE-LOCAL debt book: customer accounts recorded by ID
 * number + name + phone, their debts and repayments — all living
 * ONLY in this device's books, completely SEPARATE from the صِلة
 * customers screen. The ID number is the cross-system dedupe key:
 * creating an account already on صِلة is refused with guidance, and
 * a linked account's صِلة QR sales redirect HERE (one truth per
 * person). v17 (round-23 #8): scanning the person's صِلة QR links
 * AND auto-migrates in one shot — the outstanding balance becomes
 * ONE fresh INV-D debt (proper UUID key), the prepaid credit is
 * recognized as a settlement, and the local account is deleted.
 *
 * Overlays are INLINE absolute views — NEVER RN Modals (this ROM
 * blacks Modals after the native scanner closes; the same lesson as
 * the POS debt sheet).
 */
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {
  Alert,
  BackHandler,
  Keyboard,
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
import {Icon} from '../../components/Icon';
import {LocalDebtsRepo} from '../../database/repositories/LocalDebtsRepo';
import {SilaRepo} from '../../services/sila/SilaRepo';
import {SilaSync} from '../../services/sila/SilaSync';
import {InvoiceService} from '../../services/InvoiceService';
import {parseSilaQr} from '../../services/sila/qr';
import {scanBarcode} from '../../services/vision/scanFlow';
import {formatDateTime, formatMoney} from '../../core/format';
import {fonts, makeStyles, spacing, useThemeColors} from '../../core/theme';
import {useToastStore} from '../../stores/toastStore';
import type {
  LocalCustomerBalance,
  LocalDebt,
  LocalPayment,
} from '../../core/types';

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

export function LocalDebtsScreen() {
  const c = useThemeColors();
  const styles = useStyles();
  const toast = useToastStore(state => state.show);

  const [balances, setBalances] = useState<LocalCustomerBalance[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [addId, setAddId] = useState('');
  const [addName, setAddName] = useState('');
  const [addPhone, setAddPhone] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  /** The open customer profile (detail sheet). */
  const [detail, setDetail] = useState<LocalCustomerBalance | null>(null);
  const [detailDebts, setDetailDebts] = useState<LocalDebt[]>([]);
  const [detailPays, setDetailPays] = useState<LocalPayment[]>([]);
  const [payOpen, setPayOpen] = useState(false);
  const [payAmount, setPayAmount] = useState('');
  const [payBusy, setPayBusy] = useState(false);
  /** v17 (round-23 #8): the link+scan flow's busy flag. */
  const [linkBusy, setLinkBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const list = await LocalDebtsRepo.listWithBalances();
      setBalances(list);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const refreshDetail = useCallback(async (customerId: number) => {
    const list = await LocalDebtsRepo.listWithBalances();
    setBalances(list);
    const entry = list.find(row => row.customer.id === customerId);
    if (entry != null) {
      setDetail(entry);
      const [debts, pays] = await Promise.all([
        LocalDebtsRepo.listDebts(customerId),
        LocalDebtsRepo.listPayments(customerId),
      ]);
      setDetailDebts(debts);
      setDetailPays(pays);
    }
  }, []);

  const openDetail = useCallback(
    async (entry: LocalCustomerBalance) => {
      setDetail(entry);
      const [debts, pays] = await Promise.all([
        LocalDebtsRepo.listDebts(entry.customer.id),
        LocalDebtsRepo.listPayments(entry.customer.id),
      ]);
      setDetailDebts(debts);
      setDetailPays(pays);
    },
    [],
  );

  const createCustomer = useCallback(async () => {
    if (addBusy) {
      return;
    }
    setAddBusy(true);
    try {
      const created = await LocalDebtsRepo.createCustomer({
        idNumber: addId,
        name: addName,
        phone: addPhone,
      });
      setAddId('');
      setAddName('');
      setAddPhone('');
      setAddOpen(false);
      await reload();
      toast(`أُنشئ حساب «${created.name}» في دفتر المتجر`, 'success');
    } catch (error) {
      Alert.alert(
        'لا يمكن إنشاء الحساب',
        error instanceof Error ? error.message : 'خطأ غير متوقع',
      );
    } finally {
      setAddBusy(false);
    }
  }, [addBusy, addId, addName, addPhone, reload, toast]);

  const confirmDelete = useCallback(
    (entry: LocalCustomerBalance) => {
      Alert.alert(
        'حذف حساب الزبون',
        `سيُحذف حساب «${entry.customer.name}» وكل ديونونه وسدادّاته من دفتر المتجر نهائياً. هل أنت متأكد؟`,
        [
          {text: 'تراجع', style: 'cancel'},
          {
            text: 'حذف نهائي',
            style: 'destructive',
            onPress: async () => {
              await LocalDebtsRepo.deleteCustomer(entry.customer.id);
              setDetail(null);
              await reload();
              toast('حُذف الحساب من الدفتر', 'info');
            },
          },
        ],
      );
    },
    [reload, toast],
  );

  const recordPayment = useCallback(async () => {
    if (detail == null || payBusy) {
      return;
    }
    const amount = Number(payAmount.replace(',', '.'));
    if (!Number.isFinite(amount) || amount <= 0) {
      Alert.alert('مبلغ غير صالح', 'أدخل مبلغ السداد');
      return;
    }
    setPayBusy(true);
    try {
      await LocalDebtsRepo.addPayment({
        localCustomerId: detail.customer.id,
        amountMinor: Math.round(amount * 100),
        method: 'cash',
      });
      setPayAmount('');
      setPayOpen(false);
      await refreshDetail(detail.customer.id);
      toast(
        `سُجّل سداد ${formatMoney(amount)} من ${detail.customer.name}`,
        'success',
      );
    } catch (error) {
      Alert.alert(
        'فشل تسجيل السداد',
        error instanceof Error ? error.message : 'خطأ غير متوقع',
      );
    } finally {
      setPayBusy(false);
    }
  }, [detail, payAmount, payBusy, refreshDetail, toast]);

  /** v17 (round-23 #8): link + AUTO-migrate — ONE scan, ONE flow.
   *  Scanning the person's صِلة QR (their card / offline code) now:
   *    1. resolves the صِلة cid,
   *    2. refreshes the server balances when online (so the prepaid
   *       credit is fresh),
   *    3. shows the EXACT migration plan (outstanding / credit
   *       coverage / net debt / account deletion),
   *    4. on confirm: links, queues the balance as ONE صِلة debt
   *       (proper UUID key — the round-22 path bounced with
   *       VALIDATION_ERROR and never migrated anything), marks the
   *       local debts migrated, and DELETES the local account —
   *       the person now lives on the صِلة side only.
   */
  const linkSilaByScan = useCallback(async () => {
    if (detail == null || linkBusy) {
      return;
    }
    try {
      const code = await scanBarcode();
      if (code == null) {
        return;
      }
      const {payload} = parseSilaQr(code);
      const cid =
        payload.kind === 'card'
          ? payload.cid
          : payload.kind === 'offline'
          ? payload.cid
          : null;
      if (cid == null) {
        Alert.alert(
          'رمز غير مناسب',
          'امسح بطاقة الزبون من تطبيق صِلة («بطاقتي») أو رمز الشراء الموقّت',
        );
        return;
      }
      setLinkBusy(true);
      // Best-effort freshness: when online, pull the latest balances
      // first — the prepaid credit decides the settlement split.
      try {
        await SilaSync.refreshBalances();
      } catch {
        // Offline — the cached credit (or zero) is used; the server
        // applies the REAL credit on upload and the synced row is
        // reconciled with credit_consumed_minor.
      }
      const silaCustomer = await SilaRepo.findCustomer(cid);
      const creditMinor = silaCustomer?.credit_minor ?? 0;
      const outstanding = detail.outstandingMinor;
      const covered = Math.max(0, Math.min(creditMinor, outstanding));
      const net = Math.max(0, outstanding - covered);
      const customerId = detail.customer.id;
      const customerPhone = detail.customer.phone;
      const customerName = detail.customer.name;

      const planLines =
        outstanding <= 0
          ? 'لا رصيد قائم على الحساب — سيُربط ويُحذف من الدفتر المحلي فوراً.'
          : `الرصيد القائم: ${formatMoney(outstanding / 100)} ₪\n` +
            (covered > 0
              ? `رصيد الزبون المسبق في صِلة: ${formatMoney(
                  creditMinor / 100,
                )} ₪ — يغطّي ${formatMoney(
                  covered / 100,
                )} ₪ (يُعامل كسداد في المتجر)\n` +
                `الدين الفعلي المُرحَّل إلى صِلة: ${formatMoney(net / 100)} ₪\n`
              : 'لا رصيد مسبق للزبون في صِلة — يُرحَّل كامل الرصيد ديناً\n') +
            'سيُحذف حساب الدفتر المحلي بعد الربط — أعمال الزبون القادمة تسجَّل عبر صِلة مباشرة.';

      Alert.alert(
        'ربط الحساب وترحيل الديون إلى صِلة',
        `${planLines}\n${
          silaCustomer?.name != null
            ? `حساب صِلة: ${silaCustomer.name}\n`
            : ''
        }يُرفع الرصيد عبر طابور المزامنة (يحتاج إنترنت) ويظهر لدى الزبون في صِلة كدين (شراء بالدين) — لا كدفعة.`,
        [
          {text: 'تراجع', style: 'cancel'},
          {
            text: 'ربط وترحيل',
            onPress: async () => {
              try {
                const result = await LocalDebtsRepo.linkAndMigrateToSila(
                  customerId,
                  cid,
                  () => InvoiceService.reserveDebtNumberForRenumber(),
                  async input => {
                    await SilaRepo.enqueue({
                      idempotencyKey: input.idempotencyKey,
                      customerId: input.customerId,
                      customerName: input.customerName,
                      customerPhoneLast4: customerPhone
                        ? customerPhone.replace(/\D/g, '').slice(-4)
                        : null,
                      customerCard: null,
                      offlineQr: null,
                      amountMinor: input.amountMinor,
                      posInvoiceRef: input.posInvoiceRef,
                      description: input.description,
                      scannedAt: new Date().toISOString(),
                      creditCoveredMinor: input.creditCoveredMinor,
                    });
                  },
                  creditMinor,
                );
                setDetail(null);
                await reload();
                void SilaSync.syncNow();
                if (!result.migrated) {
                  toast(
                    `رُبط ${customerName} بصِلة — لا رصيد قائم، وحُذف حسابه من الدفتر`,
                    'success',
                    5000,
                  );
                } else if (result.creditCoveredMinor > 0) {
                  toast(
                    `رُحّل رصيد ${customerName} إلى صِلة: ${formatMoney(
                      result.outstandingMinor / 100,
                    )} — غطّى الرصيد المسبق ${formatMoney(
                      result.creditCoveredMinor / 100,
                    )} (سداد في المتجر) والباقي ${formatMoney(
                      result.netMinor / 100,
                    )} دين. حُذف الحساب المحلي`,
                    'success',
                    6500,
                  );
                } else {
                  toast(
                    `رُحّل رصيد ${customerName} (${formatMoney(
                      result.outstandingMinor / 100,
                    )}) إلى صِلة وحُذف الحساب المحلي`,
                    'success',
                    5000,
                  );
                }
              } catch (error) {
                Alert.alert(
                  'فشل الربط والترحيل',
                  error instanceof Error ? error.message : 'خطأ غير متوقع',
                );
              }
            },
          },
        ],
      );
    } catch (error) {
      Alert.alert(
        'فشل الربط',
        error instanceof Error ? error.message : 'خطأ غير متوقع',
      );
    } finally {
      setLinkBusy(false);
    }
  }, [detail, linkBusy, reload, toast]);

  const totals = useMemo(() => {
    const outstanding = balances.reduce(
      (sum, row) => sum + row.outstandingMinor,
      0,
    );
    const collected = balances.reduce(
      (sum, row) => sum + row.paidTotalMinor,
      0,
    );
    const debtors = balances.filter(row => row.outstandingMinor > 0).length;
    return {outstanding, collected, debtors};
  }, [balances]);

  const filtered = useMemo(() => {
    const q = query.trim();
    if (q.length === 0) {
      return balances;
    }
    return balances.filter(
      row =>
        row.customer.name.includes(q) ||
        row.customer.id_number.includes(q) ||
        (row.customer.phone ?? '').includes(q),
    );
  }, [balances, query]);

  return (
    <View style={styles.screen}>
      <AppHeader title="دفتر ديون المتجر" showBack showBell={false} />
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled">
        <Text style={styles.introText}>
          حسابات دين خاصة بمتجرك (رقم هوية + اسم + جوال) — تسجيل الدين
          والسداد يتم محلياً هنا، منفصل تماماً عن زبائن تطبيق صِلة، ولا يتكرر
          الزبون في الجانبين عبر رقم الهوية.
        </Text>

        <View style={styles.statsRow}>
          <StatCard
            label={`الدين الإجمالي القائم · ${totals.debtors} مدين`}
            value={formatMoney(totals.outstanding / 100)}
            tone={totals.outstanding > 0 ? 'danger' : 'success'}
            icon="book"
          />
          <StatCard
            label="سدادّات مستلمة"
            value={formatMoney(totals.collected / 100)}
            tone="success"
            icon="wallet"
          />
        </View>

        <SectionTitle
          title={`زبائن الدفتر (${balances.length})`}
          hint="اضغط على زبون لعرض ملفه وتسجيل سداد أو ترحيل"
          action={
            <TouchableOpacity
              onPress={() => {
                setAddId('');
                setAddName('');
                setAddPhone('');
                setAddOpen(true);
              }}>
              <Text style={styles.addLink}>+ زبون جديد</Text>
            </TouchableOpacity>
          }
        />

        <TextInput
          style={styles.searchBox}
          value={query}
          onChangeText={setQuery}
          placeholder="ابحث بالاسم أو رقم الهوية أو الجوال…"
          placeholderTextColor={c.textFaint}
        />

        {!loading && filtered.length === 0 ? (
          <EmptyState
            icon="users"
            title="لا يوجد زبائن بعد"
            subtitle="أنشئ حساب دين لزبون متجرك برقم هويته واسمه ورقم جواله — الديون تُسجَّل محلياً في هذا الدفتر"
          />
        ) : (
          filtered.map(entry => (
            <TouchableOpacity
              key={entry.customer.id}
              style={styles.customerRow}
              onPress={() => void openDetail(entry)}
              activeOpacity={0.85}>
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>
                  {entry.customer.name.trim().charAt(0) || 'ز'}
                </Text>
              </View>
              <View style={{flex: 1}}>
                <View style={styles.nameRow}>
                  <Text style={styles.customerName} numberOfLines={1}>
                    {entry.customer.name}
                  </Text>
                  {entry.customer.sila_customer_id != null ? (
                    <View style={[styles.linkBadge, {borderColor: c.accent}]}>
                      <Icon name="link" size={10} color={c.accent} />
                      <Text style={[styles.linkBadgeText, {color: c.accent}]}>
                        مرتبط بصِلة
                      </Text>
                    </View>
                  ) : null}
                </View>
                <Text style={styles.customerMeta} numberOfLines={1}>
                  هوية {entry.customer.id_number}
                  {entry.customer.phone ? ` · ${entry.customer.phone}` : ''}
                </Text>
              </View>
              <View style={styles.balanceCol}>
                <Text
                  style={[
                    styles.balanceNum,
                    {color: entry.outstandingMinor > 0 ? c.danger : c.success},
                  ]}>
                  {formatMoney(entry.outstandingMinor / 100)}
                </Text>
                <Text style={styles.balanceLabel}>دين قائم</Text>
              </View>
            </TouchableOpacity>
          ))
        )}

        <View style={{height: spacing.xl}} />
      </ScrollView>

      {/* ── Add-customer sheet (INLINE overlay — never a Modal) ── */}
      {addOpen ? (
        <View style={styles.overlay}>
          <TouchableOpacity
            style={styles.overlayDim}
            activeOpacity={1}
            onPress={() => setAddOpen(false)}
          />
          <BackHandlerCloser
            active={addOpen}
            onClose={() => setAddOpen(false)}
          />
          <View style={styles.sheet}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>حساب دين جديد — دفتر المتجر</Text>
            <Field
              label="رقم الهوية *"
              value={addId}
              onChangeText={setAddId}
              keyboardType="numeric"
              placeholder="مثال: 401234567"
              returnKeyType="next"
            />
            <Field
              label="الاسم *"
              value={addName}
              onChangeText={setAddName}
              placeholder="اسم الزبون الكامل"
              returnKeyType="next"
            />
            <Field
              label="رقم الجوال"
              value={addPhone}
              onChangeText={setAddPhone}
              keyboardType="phone-pad"
              placeholder="05XXXXXXXX"
              returnKeyType="done"
            />
            <Text style={styles.sheetHint}>
              رقم الهوية يمنع تكرار الزبون: إن كان له حساب صِلة بنفس الرقم
              سيظهر تنبيه — ديونته تسجَّل عبر صِلة أو يُربط الحسابان لاحقاً.
            </Text>
            <AppButton
              title="إنشاء الحساب"
              icon="plus"
              onPress={() => void createCustomer()}
              loading={addBusy}
            />
            <AppButton
              title="إلغاء"
              variant="secondary"
              onPress={() => setAddOpen(false)}
            />
          </View>
        </View>
      ) : null}

      {/* ── Customer detail sheet ── */}
      {detail != null ? (
        <View style={styles.overlay}>
          <TouchableOpacity
            style={styles.overlayDim}
            activeOpacity={1}
            onPress={() => setDetail(null)}
          />
          <BackHandlerCloser
            active={detail != null}
            onClose={() => setDetail(null)}
          />
          <View style={styles.detailSheet}>
            <View style={styles.sheetHandle} />
            <View style={styles.detailHead}>
              <View style={styles.avatarBig}>
                <Text style={styles.avatarBigText}>
                  {detail.customer.name.trim().charAt(0) || 'ز'}
                </Text>
              </View>
              <View style={{flex: 1}}>
                <Text style={styles.detailName}>{detail.customer.name}</Text>
                <Text style={styles.detailMeta}>
                  هوية {detail.customer.id_number}
                  {detail.customer.phone ? ` · ${detail.customer.phone}` : ''}
                </Text>
                {detail.customer.sila_customer_id != null ? (
                  <View style={[styles.linkBadge, {borderColor: c.accent}]}>
                    <Icon name="link" size={10} color={c.accent} />
                    <Text style={[styles.linkBadgeText, {color: c.accent}]}>
                      مرتبط بحساب صِلة
                    </Text>
                  </View>
                ) : null}
              </View>
            </View>

            <View style={styles.detailStats}>
              <View style={styles.detailStat}>
                <Text
                  style={[
                    styles.detailStatNum,
                    {
                      color:
                        detail.outstandingMinor > 0 ? c.danger : c.success,
                    },
                  ]}>
                  {formatMoney(detail.outstandingMinor / 100)}
                </Text>
                <Text style={styles.detailStatLabel}>دين قائم</Text>
              </View>
              <View style={styles.detailStat}>
                <Text style={styles.detailStatNum}>
                  {formatMoney(detail.debtTotalMinor / 100)}
                </Text>
                <Text style={styles.detailStatLabel}>إجمالي الديون</Text>
              </View>
              <View style={styles.detailStat}>
                <Text style={styles.detailStatNum}>
                  {formatMoney(detail.paidTotalMinor / 100)}
                </Text>
                <Text style={styles.detailStatLabel}>مسدَّد</Text>
              </View>
            </View>

            <View style={styles.actionsRow}>
              <View style={{flex: 1}}>
                <AppButton
                  title="تسجيل سداد"
                  icon="wallet"
                  small
                  onPress={() => setPayOpen(true)}
                />
              </View>
              <View style={{flex: 1}}>
                {detail.customer.sila_customer_id == null ? (
                  <AppButton
                    title="ربط وترحيل إلى صِلة"
                    icon="qrFrame"
                    small
                    variant="secondary"
                    loading={linkBusy}
                    onPress={() => void linkSilaByScan()}
                  />
                ) : (
                  // v17 (round-23 #8): unreachable in the new flow —
                  // linking deletes the account — kept purely as a
                  // healing path for accounts linked by v16 that
                  // never migrated (their balance still migrates
                  // through the same one-shot flow after a re-scan).
                  <AppButton
                    title="إعادة مسح رمز صِلة للترحيل"
                    icon="link"
                    small
                    variant="secondary"
                    loading={linkBusy}
                    onPress={() => void linkSilaByScan()}
                  />
                )}
              </View>
            </View>

            <SectionTitle title="سجل العمليات" />
            <ScrollView style={styles.historyList}>
              {detailDebts.map(debt => (
                <View key={`d${debt.id}`} style={styles.historyRow}>
                  <View style={{flex: 1}}>
                    <Text style={styles.historyRef}>
                      {debt.invoice_ref}
                      {debt.migrated === 1 ? ' (مُرحّل إلى صِلة)' : ''}
                    </Text>
                    <Text style={styles.historyMeta}>
                      {formatDateTime(
                        debt.created_at.replace('T', ' ').slice(0, 19),
                      )}
                    </Text>
                  </View>
                  <Text style={[styles.historyAmount, {color: c.danger}]}>
                    +{formatMoney(debt.amount_minor / 100)}
                  </Text>
                </View>
              ))}
              {detailPays.map(pay => (
                <View key={`p${pay.id}`} style={styles.historyRow}>
                  <View style={{flex: 1}}>
                    <Text style={styles.historyRef}>{pay.receipt_ref}</Text>
                    <Text style={styles.historyMeta}>
                      {formatDateTime(
                        pay.created_at.replace('T', ' ').slice(0, 19),
                      )}
                    </Text>
                  </View>
                  <Text style={[styles.historyAmount, {color: c.success}]}>
                    −{formatMoney(pay.amount_minor / 100)}
                  </Text>
                </View>
              ))}
              {detailDebts.length === 0 && detailPays.length === 0 ? (
                <Text style={styles.emptyHistory}>لا عمليات بعد</Text>
              ) : null}
            </ScrollView>

            <AppButton
              title="حذف الحساب نهائياً"
              variant="danger"
              icon="trash"
              small
              onPress={() => confirmDelete(detail)}
            />
            <AppButton
              title="إغلاق"
              variant="secondary"
              onPress={() => setDetail(null)}
            />
          </View>
        </View>
      ) : null}

      {/* ── Repayment sheet ── */}
      {payOpen && detail != null ? (
        <View style={styles.overlay}>
          <TouchableOpacity
            style={styles.overlayDim}
            activeOpacity={1}
            onPress={() => setPayOpen(false)}
          />
          <BackHandlerCloser
            active={payOpen}
            onClose={() => setPayOpen(false)}
          />
          <View style={styles.sheet}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>
              سداد نقدي — {detail.customer.name}
            </Text>
            <Text style={styles.payBalanceText}>
              الدين القائم: {formatMoney(detail.outstandingMinor / 100)}
            </Text>
            <Field
              label="المبلغ المستلم (₪)"
              value={payAmount}
              onChangeText={setPayAmount}
              keyboardType="decimal-pad"
              placeholder="0.00"
              returnKeyType="done"
            />
            <Text style={styles.sheetHint}>
              يُسجَّل السداد في دفتر المتجر فقط (لا يُرفع إلى صِلة) ويخفض
              الرصيد القائم فوراً.
            </Text>
            <AppButton
              title="تأكيد السداد"
              icon="check"
              onPress={() => {
                Keyboard.dismiss();
                void recordPayment();
              }}
              loading={payBusy}
            />
            <AppButton
              title="إلغاء"
              variant="secondary"
              onPress={() => setPayOpen(false)}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

const useStyles = makeStyles(c =>
  StyleSheet.create({
    screen: {flex: 1, backgroundColor: c.bg},
    content: {padding: spacing.lg, gap: spacing.md},
    introText: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: 12.5,
      lineHeight: 19,
    },
    statsRow: {flexDirection: 'row', gap: spacing.md},
    addLink: {
      color: c.accent,
      fontFamily: fonts.bold,
      fontSize: 13,
    },
    searchBox: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: 12,
      color: c.text,
      fontFamily: fonts.regular,
      fontSize: 14,
      paddingHorizontal: spacing.md,
      paddingVertical: 10,
    },
    customerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: 14,
      padding: spacing.md,
    },
    avatar: {
      width: 42,
      height: 42,
      borderRadius: 21,
      backgroundColor: c.surfaceAlt,
      alignItems: 'center',
      justifyContent: 'center',
    },
    avatarText: {color: c.accent, fontFamily: fonts.bold, fontSize: 17},
    nameRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    customerName: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: 15,
      flexShrink: 1,
    },
    customerMeta: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: 12,
      marginTop: 2,
    },
    linkBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 3,
      borderWidth: 1,
      borderRadius: 999,
      paddingHorizontal: 6,
      paddingVertical: 1,
    },
    linkBadgeText: {fontFamily: fonts.bold, fontSize: 9.5},
    balanceCol: {alignItems: 'flex-end'},
    balanceNum: {
      fontFamily: fonts.bold,
      fontSize: 14.5,
      fontVariant: ['tabular-nums'],
    },
    balanceLabel: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: 10.5,
    },
    // ── overlays (inline — never Modals on this ROM) ──
    overlay: {
      ...StyleSheet.absoluteFillObject,
      zIndex: 40,
      justifyContent: 'flex-end',
    },
    overlayDim: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(0,0,0,0.55)',
    },
    sheet: {
      backgroundColor: c.surface,
      borderTopLeftRadius: 22,
      borderTopRightRadius: 22,
      padding: spacing.lg,
      gap: spacing.md,
      maxHeight: '88%',
    },
    sheetHandle: {
      alignSelf: 'center',
      width: 44,
      height: 4,
      borderRadius: 2,
      backgroundColor: c.border,
      marginBottom: 2,
    },
    sheetTitle: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: 16.5,
      textAlign: 'right',
    },
    sheetHint: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: 11.5,
      lineHeight: 17,
    },
    payBalanceText: {
      color: c.danger,
      fontFamily: fonts.bold,
      fontSize: 13.5,
    },
    detailSheet: {
      backgroundColor: c.surface,
      borderTopLeftRadius: 22,
      borderTopRightRadius: 22,
      padding: spacing.lg,
      gap: spacing.md,
      maxHeight: '92%',
    },
    detailHead: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
    },
    avatarBig: {
      width: 54,
      height: 54,
      borderRadius: 27,
      backgroundColor: c.surfaceAlt,
      alignItems: 'center',
      justifyContent: 'center',
    },
    avatarBigText: {color: c.accent, fontFamily: fonts.bold, fontSize: 21},
    detailName: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: 17,
    },
    detailMeta: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: 12.5,
      marginTop: 2,
    },
    detailStats: {
      flexDirection: 'row',
      gap: spacing.sm,
    },
    detailStat: {
      flex: 1,
      backgroundColor: c.surfaceAlt,
      borderRadius: 12,
      alignItems: 'center',
      paddingVertical: spacing.sm + 2,
    },
    detailStatNum: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: 13.5,
      fontVariant: ['tabular-nums'],
    },
    detailStatLabel: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: 10.5,
      marginTop: 1,
    },
    actionsRow: {flexDirection: 'row', gap: spacing.sm},
    historyList: {maxHeight: 210},
    historyRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 8,
      borderBottomWidth: 1,
      borderBottomColor: c.borderSoft,
    },
    historyRef: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: 12.5,
    },
    historyMeta: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: 11,
      marginTop: 1,
    },
    historyAmount: {
      fontFamily: fonts.bold,
      fontSize: 13,
      fontVariant: ['tabular-nums'],
    },
    emptyHistory: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: 12,
      textAlign: 'center',
      paddingVertical: spacing.lg,
    },
  }),
);
