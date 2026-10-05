/**
 * SilaScreen — لوحة صِلة: ربط حساب التاجر + طابور الديون + أرصدة
 * الزبائن (SILA_POS_API §9.1, §9.3, §13 steps 3/5/6).
 * ─────────────────────────────────────────────────────────────────
 * UNPAIRED: the merchant-authentication flow — type the one-time
 * pairing code (XXXX-XXXX) generated in the SILA merchant app, or
 * scan its QR (sila-pair:…) with the camera. One POST /api/pos/pair
 * stores the long-lived pos_token locally (§6.1).
 *
 * PAIRED: the debt dashboard — device/pairing health, the pending /
 * failed queue with per-row retry + reprint, customers' outstanding
 * balances from the cache, and manual «زامن الآن».
 */
import React, {useCallback, useEffect, useState} from 'react';
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {
  AppButton,
  AppHeader,
  Badge,
  Card,
  Screen,
  SectionTitle,
} from '../../components/ui';
import {Icon} from '../../components/Icon';
import {useNavigation} from '@react-navigation/native';
import {useSilaStore} from '../../stores/silaStore';
import {useSettingsStore} from '../../stores/settingsStore';
import {usePrinterStore} from '../../stores/printerStore';
import {useToastStore} from '../../stores/toastStore';
import {SilaRepo} from '../../services/sila/SilaRepo';
import {SilaSync} from '../../services/sila/SilaSync';
import {silaPair} from '../../services/sila/SilaApi';
import {parseSilaQr, normalizePairingCode} from '../../services/sila/qr';
import {scanBarcode} from '../../services/vision/scanFlow';
import {InvoiceService} from '../../services/InvoiceService';
import {
  fonts,
  makeStyles,
  radius,
  spacing,
  typography,
  useThemeColors,
} from '../../core/theme';
import {formatDate, formatDateTime, formatMoney, relativeTime} from '../../core/format';
import {APP_VERSION} from '../../core/config';
import type {SilaDebtRow, SilaCustomer, SilaPaymentRow} from '../../core/types';
import {uuidV4} from '../../services/sila/qr';

export function SilaScreen() {
  const c = useThemeColors();
  const styles = useStyles();
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const toast = useToastStore(state => state.show);

  const pairing = useSilaStore(state => state.pairing);
  const pairingBusy = useSilaStore(state => state.pairingBusy);
  const pending = useSilaStore(state => state.pending);
  const failed = useSilaStore(state => state.failed);
  const synced = useSilaStore(state => state.synced);
  const syncState = useSilaStore(state => state.syncState);
  const lastSyncAt = useSilaStore(state => state.lastSyncAt);
  const lastSyncMessage = useSilaStore(state => state.lastSyncMessage);
  const setPairing = useSilaStore(state => state.setPairing);
  const clearPairing = useSilaStore(state => state.clearPairing);
  const refreshCounts = useSilaStore(state => state.refreshCounts);
  const setPairingBusy = useSilaStore(state => state.setPairingBusy);

  const settings = useSettingsStore(state => state.settings);
  const printerStatus = usePrinterStore(state => state.status);

  const [codeText, setCodeText] = useState('');
  const [queue, setQueue] = useState<SilaDebtRow[]>([]);
  const [customers, setCustomers] = useState<SilaCustomer[]>([]);
  const [payments, setPayments] = useState<SilaPaymentRow[]>([]);
  // v18 (round-24 #1): the Sila-app collections ledger — money the
  // app collected on the store's behalf (customer repaid through
  // the app, detected by the reconciliation engine on each sync).
  const [appCollections, setAppCollections] = useState<
    {
      local_id: number;
      customer_id: string;
      customer_name: string | null;
      amount_minor: number;
      detected_at: string;
    }[]
  >([]);
  const [syncingNow, setSyncingNow] = useState(false);
  // v15 (round-21 #3): the repayment sheet — inline absolute overlay
  // (NEVER a Modal: this ROM blacks RN Modals after the native
  // scanner closes — the same lesson as the POS debt sheet).
  const [paySheet, setPaySheet] = useState<SilaCustomer | null>(null);
  const [payAmountText, setPayAmountText] = useState('');
  const [payBusy, setPayBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [rows, list, payRows, collections] = await Promise.all([
        SilaRepo.recent(50),
        SilaRepo.listCustomers(),
        SilaRepo.recentPayments(30),
        // v18 (round-24 #1): the app-collections ledger (newest 20).
        SilaRepo.recentAppCollections(20),
      ]);
      setQueue(rows);
      setCustomers(list);
      setPayments(payRows);
      setAppCollections(collections);
      await refreshCounts();
    } catch {
      // Fresh installs before the first migration tick — quiet.
    }
  }, [refreshCounts]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // ── Pairing (§9.1) ─────────────────────────────────────────────

  const doPair = useCallback(
    async (rawCode: string) => {
      const code = normalizePairingCode(rawCode);
      if (code.length < 6) {
        toast(
          'أدخل رمز الربط كما يظهر في تطبيق صِلة (مثال: A7K2-Q93M)',
          'error',
        );
        return;
      }
      setPairingBusy(true);
      try {
        const result = await silaPair(code, `sela POS ${APP_VERSION}`);
        setPairing({
          posToken: result.pos_token,
          deviceId: result.device_id,
          merchantOrgId: result.merchant_org_id,
          merchantName: result.merchant_name,
          tokenExpiresAt: result.expires_at,
          pairedAt: new Date().toISOString(),
          apiBaseUrl: 'https://sila.pornxvideo.com',
        });
        setCodeText('');
        SilaSync.start();
        void SilaSync.syncNow();
        // v16 (round-22 #1): fresh pairing on a reinstalled device —
        // jump today's debt/receipt counters past every ref the صِلة
        // server remembers so new numbers don't collide with the
        // server's memory from earlier installs.
        void SilaSync.advanceCountersFromServer();
        toast(
          `تم ربط المتجر بحساب «${result.merchant_name}» في صِلة`,
          'success',
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        toast(message, 'error');
      } finally {
        setPairingBusy(false);
      }
    },
    [setPairing, setPairingBusy, toast],
  );

  const scanPairQr = useCallback(async () => {
    if (pairingBusy) {
      return;
    }
    setPairingBusy(true);
    try {
      const code = await scanBarcode();
      if (code == null) {
        return;
      }
      const {payload} = parseSilaQr(code);
      if (payload.kind === 'pair') {
        await doPair(payload.code);
      } else {
        toast(
          'هذا ليس رمز ربط نقطة البيع — ولّده من تطبيق صِلة: الإعدادات ← ربط نقطة البيع',
          'error',
        );
      }
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'فشل مسح رمز الربط',
        'error',
      );
    } finally {
      setPairingBusy(false);
    }
  }, [doPair, pairingBusy, setPairingBusy, toast]);

  const confirmUnpair = useCallback(() => {
    Alert.alert(
      'فك ربط صِلة',
      'سيُلغى ربط هذا الجهاز بحساب التاجر. الديون المسجلة محلياً تبقى محفوظة ويمكن مزامنتها بعد إعادة الربط.',
      [
        {text: 'تراجع', style: 'cancel'},
        {
          text: 'فك الربط',
          style: 'destructive',
          onPress: () => {
            SilaSync.stop();
            clearPairing();
            toast('تم فك ربط صِلة من هذا الجهاز', 'info');
          },
        },
      ],
    );
  }, [clearPairing, toast]);

  // ── Queue actions ──────────────────────────────────────────────

  const syncNow = useCallback(async () => {
    if (syncingNow) {
      return;
    }
    setSyncingNow(true);
    try {
      // v12 (round-18 #1): the outcome is spoken — manual sync is
      // never silent again.
      const outcome = await SilaSync.syncNow();
      await reload();
      toast(
        outcome.message,
        outcome.pending + outcome.paymentsPending === 0 &&
          outcome.state !== 'no_internet'
          ? 'success'
          : 'info',
      );
    } catch (error) {
      toast(error instanceof Error ? error.message : 'فشلت المزامنة', 'error');
    } finally {
      setSyncingNow(false);
    }
  }, [reload, syncingNow, toast]);

  const requeueRow = useCallback(
    async (row: SilaDebtRow) => {
      await SilaRepo.requeue(row.local_id);
      await reload();
      toast(`أُعيدت فاتورة ${row.pos_invoice_ref} إلى طابور المزامنة`, 'info');
    },
    [reload, toast],
  );

  const reprintDebt = useCallback(
    async (row: SilaDebtRow) => {
      try {
        await InvoiceService.reprintDebtReceiptByRef(row.pos_invoice_ref, {
          storeName: settings.storeName,
          storePhone: settings.storePhone,
          footerMessage: settings.footerMessage,
          storeLogoPath: settings.storeLogoPath,
          paperWidth: settings.paperWidth,
          codepage: settings.codepage,
          showProfit: settings.showProfitOnReceipt,
        });
        toast('أُرسل إيصال الدين إلى الطابعة', 'success');
      } catch (error) {
        toast(
          error instanceof Error ? error.message : 'تعذرت إعادة الطباعة',
          'error',
        );
      }
    },
    [settings, toast],
  );

  // ── v15 (round-21 #3): repayments (§2.3 — the missing upload path) ──

  const openPaySheet = useCallback((customer: SilaCustomer) => {
    setPayAmountText('');
    setPaySheet(customer);
  }, []);

  const confirmPayment = useCallback(async () => {
    const customer = paySheet;
    if (customer == null || payBusy) {
      return;
    }
    const amount = Number(payAmountText.replace(',', '.'));
    if (!Number.isFinite(amount) || amount <= 0) {
      toast('أدخل مبلغ سداد صحيحاً أكبر من صفر', 'error');
      return;
    }
    const amountMinor = Math.round(amount * 100);
    if (amountMinor > customer.outstanding_minor) {
      toast(
        `المبلغ أكبر من الدين القائم (${formatMoney(
          customer.outstanding_minor / 100,
        )}) — لا يُستلم عبر صِلة أكثر من المستحق`,
        'error',
      );
      return;
    }
    setPayBusy(true);
    try {
      const receiptRef = await SilaRepo.reserveReceiptRef();
      await SilaRepo.enqueuePayment({
        idempotencyKey: uuidV4(),
        customerId: customer.customer_id,
        customerName: customer.name,
        customerPhoneLast4: customer.phone_last4,
        amountMinor,
        paymentMethod: 'cash',
        posReceiptRef: receiptRef,
        description: `سداد نقدي — ${customer.name}`,
        paidAt: new Date().toISOString(),
      });
      setPaySheet(null);
      setPayAmountText('');
      await reload();
      toast(
        `سُجّل سداد ${formatMoney(amount)} من ${customer.name} — إيصال ${receiptRef} سيُرفع لصِلة`,
        'success',
        5000,
      );
      // Opportunistic upload right away.
      void SilaSync.syncNow().then(() => reload());
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'تعذر تسجيل السداد',
        'error',
      );
    } finally {
      setPayBusy(false);
    }
  }, [payBusy, payAmountText, paySheet, reload, toast]);

  const requeuePaymentRow = useCallback(
    async (row: SilaPaymentRow) => {
      await SilaRepo.requeuePayment(row.local_id);
      await reload();
      toast(`أُعيد إيصال ${row.pos_receipt_ref} إلى طابور المزامنة`, 'info');
    },
    [reload, toast],
  );

  // ── Render helpers ─────────────────────────────────────────────

  const stateBadge = (state: SilaDebtRow['state']) => {
    if (state === 'synced') {
      return <Badge label="مسجّل في صِلة" tone="success" />;
    }
    if (state === 'failed') {
      return <Badge label="فاشل" tone="danger" />;
    }
    if (state === 'syncing') {
      return <Badge label="قيد المزامنة" tone="warning" />;
    }
    return <Badge label="بانتظار المزامنة" tone="neutral" />;
  };

  const paymentStateBadge = (state: SilaPaymentRow['state']) => {
    if (state === 'synced') {
      return <Badge label="مرفوع لصِلة" tone="success" />;
    }
    if (state === 'failed') {
      return <Badge label="فاشل" tone="danger" />;
    }
    if (state === 'syncing') {
      return <Badge label="قيد الرفع" tone="warning" />;
    }
    return <Badge label="بانتظار الرفع" tone="neutral" />;
  };

  const syncStatusLine = () => {
    if (syncState === 'device_invalid') {
      return {
        icon: 'alert' as const,
        color: c.danger,
        text: lastSyncMessage ?? 'ربط الجهاز منتهٍ — أعد الربط برمز جديد',
      };
    }
    if (syncState === 'no_internet') {
      return {
        icon: 'wifiOff' as const,
        color: c.warning,
        text: lastSyncMessage ?? 'لا يوجد اتصال — الطابور محفوظ',
      };
    }
    if (syncState === 'syncing') {
      return {
        icon: 'refresh' as const,
        color: c.accent,
        text: lastSyncMessage ?? 'جارٍ المزامنة…',
      };
    }
    return {
      icon: 'checkCircle' as const,
      color: c.success,
      text: lastSyncMessage ?? 'كل شيء متزامن',
    };
  };

  const status = syncStatusLine();

  return (
    <Screen>
      <AppHeader title="صِلة — الدين الفلسطيني" showBack showBell={false} />
      <ScrollView
        contentContainerStyle={[
          styles.content,
          {paddingBottom: insets.bottom + spacing.xxl},
        ]}
        keyboardShouldPersistTaps="handled">
        {pairing == null ? (
          /* ── UNPAIRED: merchant authentication (§9.1) ── */
          <>
            <Card style={styles.introCard}>
              <View style={styles.introIconRow}>
                <View style={styles.introIcon}>
                  <Icon name="qrFrame" size={26} color={c.accent} />
                </View>
                <View style={{flex: 1}}>
                  <Text style={styles.introTitle}>
                    اربط حساب التاجر في صِلة
                  </Text>
                  <Text style={styles.introText}>
                    صِلة منظومة الدين الفلسطينية — بعد الربط يستطيع الكاشير بيع
                    أي فاتورة ديناً على زبون بمسح رمزه من تطبيق صِلة، ويُزامَن
                    الدين تلقائياً عند توفر الإنترنت.
                  </Text>
                </View>
              </View>

              <View style={styles.stepRow}>
                <Text style={styles.stepNum}>١</Text>
                <Text style={styles.stepText}>
                  افتح تطبيق صِلة بحساب التاجر ← الإعدادات ← «ربط نقطة البيع»
                </Text>
              </View>
              <View style={styles.stepRow}>
                <Text style={styles.stepNum}>٢</Text>
                <Text style={styles.stepText}>
                  اضغط «إنشاء رمز ربط جديد» — الرمز صالح 15 دقيقة لمرة واحدة
                </Text>
              </View>
              <View style={styles.stepRow}>
                <Text style={styles.stepNum}>٣</Text>
                <Text style={styles.stepText}>
                  أدخل الرمز هنا أو امسح رمز الربط مباشرة
                </Text>
              </View>
            </Card>

            <Card style={styles.pairCard}>
              <Text style={styles.fieldLabel}>رمز الربط</Text>
              <TextInput
                style={styles.codeInput}
                value={codeText}
                onChangeText={setCodeText}
                placeholder="A7K2-Q93M"
                placeholderTextColor={c.textFaint}
                autoCapitalize="characters"
                autoCorrect={false}
              />
              <AppButton
                title="ربط المتجر"
                icon="key"
                onPress={() => void doPair(codeText)}
                loading={pairingBusy}
              />
              <TouchableOpacity
                style={styles.scanPairBtn}
                onPress={() => void scanPairQr()}
                disabled={pairingBusy}
                activeOpacity={0.8}>
                <Icon name="camera" size={16} color={c.accent} />
                <Text style={styles.scanPairText}>مسح رمز الربط بالكاميرا</Text>
              </TouchableOpacity>
            </Card>
          </>
        ) : (
          /* ── PAIRED: the debt dashboard ── */
          <>
            {/* Store identity card */}
            <Card style={styles.identityCard}>
              <View style={styles.identityRow}>
                <View style={styles.identityIcon}>
                  <Icon name="store" size={22} color={c.accent} />
                </View>
                <View style={{flex: 1}}>
                  <Text style={styles.identityName} numberOfLines={1}>
                    {pairing.merchantName}
                  </Text>
                  <Text style={styles.identityMeta}>
                    مرتبط منذ {formatDate(pairing.pairedAt.slice(0, 10))} ·
                    صلاحية الربط حتى{' '}
                    {formatDate(pairing.tokenExpiresAt.slice(0, 10))}
                  </Text>
                </View>
                <Badge label="مرتبط" tone="success" />
              </View>
              {syncState === 'device_invalid' ? (
                <View style={styles.deviceInvalidBox}>
                  <Icon name="alert" size={16} color={c.danger} />
                  <Text style={styles.deviceInvalidText}>
                    ربط هذا الجهاز منتهٍ أو ملغى من تطبيق التاجر — الديون محفوظة
                    محلياً ولن تُفقد. أعد الربط برمز جديد لاستئناف المزامنة.
                  </Text>
                </View>
              ) : null}
            </Card>

            {/* Sync status card */}
            <Card style={styles.syncCard}>
              <View style={styles.syncHeaderRow}>
                <Icon name={status.icon} size={18} color={status.color} />
                <Text style={[styles.syncStateText, {color: status.color}]}>
                  {status.text}
                </Text>
              </View>
              <View style={styles.syncCountsRow}>
                <View style={styles.syncCountBox}>
                  <Text style={[styles.syncCountNum, {color: c.warning}]}>
                    {pending}
                  </Text>
                  <Text style={styles.syncCountLabel}>بانتظار المزامنة</Text>
                </View>
                <View style={styles.syncCountBox}>
                  <Text style={[styles.syncCountNum, {color: c.danger}]}>
                    {failed}
                  </Text>
                  <Text style={styles.syncCountLabel}>فاشلة</Text>
                </View>
                <View style={styles.syncCountBox}>
                  <Text style={[styles.syncCountNum, {color: c.success}]}>
                    {synced}
                  </Text>
                  <Text style={styles.syncCountLabel}>مسجّلة في صِلة</Text>
                </View>
              </View>
              {lastSyncAt ? (
                <Text style={styles.lastSyncText}>
                  آخر مزامنة:{' '}
                  {relativeTime(lastSyncAt.replace('T', ' ').slice(0, 19))}
                </Text>
              ) : null}
              <View style={styles.syncActionsRow}>
                <AppButton
                  title="زامن الآن"
                  icon="refresh"
                  small
                  onPress={() => void syncNow()}
                  loading={syncingNow}
                  style={{flex: 1}}
                />
                <TouchableOpacity
                  style={styles.unpairBtn}
                  onPress={confirmUnpair}
                  activeOpacity={0.8}>
                  <Icon name="x" size={15} color={c.danger} />
                  <Text style={styles.unpairText}>فك الربط</Text>
                </TouchableOpacity>
              </View>
            </Card>

            {/* Debt queue */}
            <SectionTitle title="سجل الديون" />
            {/* v16 (round-22 #4): the STORE-LOCAL debt book — a
                dedicated page, separate from صِلة customers (accounts
                by ID number; debts stay in this store's books). */}
            <TouchableOpacity
              style={styles.localBookCard}
              onPress={() => navigation.navigate('LocalDebts' as never)}
              activeOpacity={0.85}>
              <View style={styles.localBookIcon}>
                <Icon name="book" size={20} color={c.accent} />
              </View>
              <View style={{flex: 1}}>
                <Text style={styles.localBookTitle}>دفتر ديون المتجر</Text>
                <Text style={styles.localBookText}>
                  حسابات دين محلية بالهوية والاسم والجوال — منفصلة عن زبائن
                  صِلة، مع ترحيل الديون إلى صِلة عند الربط
                </Text>
              </View>
              <Icon name="chevronLeft" size={16} color={c.textFaint} />
            </TouchableOpacity>
            {queue.length === 0 ? (
              <Card style={styles.emptyCard}>
                <Text style={styles.emptyText}>
                  لا توجد ديون بعد — استخدم زر «دين» في شاشة نقطة البيع لتسجيل
                  فاتورة ديناً على زبون صِلة.
                </Text>
              </Card>
            ) : (
              queue.map(row => (
                <Card key={row.local_id} style={styles.queueCard}>
                  <View style={styles.queueRow}>
                    <View style={{flex: 1}}>
                      <Text style={styles.queueCustomer} numberOfLines={1}>
                        {row.customer_name ?? 'زبون صِلة'}
                      </Text>
                      <Text style={styles.queueInvoice}>
                        {row.pos_invoice_ref} ·{' '}
                        {(row.amount_minor / 100).toFixed(2)} ₪ ·{' '}
                        {formatDateTime(
                          row.created_at.replace('T', ' ').slice(0, 19),
                        )}
                      </Text>
                      {row.credit_covered_minor > 0 ? (
                        <Text style={styles.queueCreditNote}>
                          غطّى الرصيد المسبق{' '}
                          {formatMoney(row.credit_covered_minor / 100)} —
                          الفاتورة مسددة بهذا المقدار
                        </Text>
                      ) : null}
                    </View>
                    {stateBadge(row.state)}
                  </View>
                  {row.state === 'synced' && row.reference_code ? (
                    <Text style={styles.queueRef}>
                      رقم العملية في صِلة: {row.reference_code}
                    </Text>
                  ) : null}
                  {row.state === 'failed' && row.error_message ? (
                    <View style={styles.queueErrorBox}>
                      <Icon name="alert" size={13} color={c.danger} />
                      <Text style={styles.queueErrorText}>
                        {row.error_message}
                      </Text>
                    </View>
                  ) : null}
                  {row.state === 'failed' ? (
                    <View style={styles.queueActionsRow}>
                      <AppButton
                        title="إعادة المحاولة"
                        icon="refresh"
                        small
                        variant="secondary"
                        onPress={() => void requeueRow(row)}
                        style={{flex: 1}}
                      />
                      {printerStatus === 'connected' ? (
                        <AppButton
                          title="طباعة الإيصال"
                          icon="printer"
                          small
                          variant="ghost"
                          onPress={() => void reprintDebt(row)}
                          style={{flex: 1}}
                        />
                      ) : null}
                    </View>
                  ) : null}
                </Card>
              ))
            )}

            {/* Customers balances (§9.3) — v15: origin split (§3.3) */}
            <SectionTitle
              title="أرصدة الزبائن لدى متجرك"
              hint="رصيد كل زبون بأصل كل جزء — فواتير متجرك منفصلة عن تطبيق صِلة"
            />
            {customers.length === 0 ? (
              <Card style={styles.emptyCard}>
                <Text style={styles.emptyText}>
                  ستظهر هنا أرصدة زبائن صِلة لدى متجرك بعد أول مزامنة ناجحة.
                </Text>
              </Card>
            ) : (
              customers.map(customer => (
                <Card key={customer.customer_id} style={styles.customerCard}>
                  <View style={styles.customerRow}>
                    <View style={{flex: 1}}>
                      <Text style={styles.customerName} numberOfLines={1}>
                        {customer.name}
                      </Text>
                      <Text style={styles.customerMeta}>
                        {customer.phone_last4
                          ? `هاتف: ****${customer.phone_last4}`
                          : 'زبون صِلة'}
                        {customer.last_synced_at
                          ? ` · آخر تحديث ${relativeTime(
                              customer.last_synced_at
                                .replace('T', ' ')
                                .slice(0, 19),
                            )}`
                          : ''}
                      </Text>
                    </View>
                    <View style={styles.customerBalance}>
                      <Text
                        style={[
                          styles.customerBalanceNum,
                          customer.outstanding_minor > 0
                            ? {color: c.danger}
                            : {color: c.success},
                        ]}>
                        {formatMoney(customer.outstanding_minor / 100)}
                      </Text>
                      <Text style={styles.customerBalanceLabel}>دين قائم</Text>
                    </View>
                  </View>

                  {/* v15 (§3.3): the origin split — mandatory display */}
                  {customer.outstanding_minor > 0 ? (
                    <View style={styles.splitBox}>
                      <View style={styles.splitRow}>
                        <Text style={styles.splitLabel}>
                          منها فواتير متجري
                        </Text>
                        <Text
                          style={[
                            styles.splitValue,
                            {color: c.accent},
                          ]}>
                          {formatMoney(
                            customer.pos_outstanding_minor / 100,
                          )}{' '}
                          ₪
                        </Text>
                      </View>
                      <View style={styles.splitRow}>
                        <Text style={styles.splitLabel}>منها من تطبيق صِلة</Text>
                        <Text
                          style={[
                            styles.splitValue,
                            {color: c.info},
                          ]}>
                          {formatMoney(
                            customer.app_outstanding_minor / 100,
                          )}{' '}
                          ₪
                        </Text>
                      </View>
                      {customer.other_minor !== 0 ? (
                        <View style={styles.splitRow}>
                          <Text style={styles.splitLabel}>تعديلات يدوية</Text>
                          <Text
                            style={[
                              styles.splitValue,
                              {color: c.warning},
                            ]}>
                            {formatMoney(customer.other_minor / 100)}
                          </Text>
                        </View>
                      ) : null}
                      {customer.last_payment_at ? (
                        <Text style={styles.splitNote}>
                          آخر سداد:{' '}
                          {formatDateTime(
                            customer.last_payment_at
                              .replace('T', ' ')
                              .slice(0, 19),
                          )}
                          {customer.last_payment_amount_minor != null
                            ? ` — ${formatMoney(
                                customer.last_payment_amount_minor / 100,
                              )}`
                            : ''}
                        </Text>
                      ) : null}
                    </View>
                  ) : null}

                  {/* v15 (§2.3): record a cashier repayment */}
                  {customer.outstanding_minor > 0 ? (
                    <AppButton
                      title="تسجيل سداد نقدي"
                      icon="wallet"
                      small
                      variant="secondary"
                      onPress={() => openPaySheet(customer)}
                    />
                  ) : (
                    <View style={styles.settledRow}>
                      <Icon
                        name="checkCircle"
                        size={14}
                        color={c.success}
                      />
                      <Text style={styles.settledText}>
                        لا دين قائم على هذا الزبون
                      </Text>
                    </View>
                  )}
                </Card>
              ))
            )}

            {/* v15 (round-21 #3): repayments log */}
            <SectionTitle
              title="سجل السدادّات"
              hint="كل سداد استُلم عند الكاشير ويُرفع لصِلة تلقائياً"
            />
            {payments.length === 0 ? (
              <Card style={styles.emptyCard}>
                <Text style={styles.emptyText}>
                  لا توجد سدادّات بعد — عند استلام مبلغ من زبون مدين اضغط
                  «تسجيل سداد نقدي» في بطاقته.
                </Text>
              </Card>
            ) : (
              payments.map(row => (
                <Card key={`pay-${row.local_id}`} style={styles.queueCard}>
                  <View style={styles.queueRow}>
                    <View style={{flex: 1}}>
                      <Text style={styles.queueCustomer} numberOfLines={1}>
                        {row.customer_name ?? 'زبون صِلة'}
                      </Text>
                      <Text style={styles.queueInvoice}>
                        {row.pos_receipt_ref} ·{' '}
                        {formatMoney(row.amount_minor / 100)} ·{' '}
                        {formatDateTime(
                          row.created_at.replace('T', ' ').slice(0, 19),
                        )}
                      </Text>
                    </View>
                    {paymentStateBadge(row.state)}
                  </View>
                  {row.state === 'synced' && row.reference_code ? (
                    <Text style={styles.queueRef}>
                      رقم العملية في صِلة: {row.reference_code}
                    </Text>
                  ) : null}
                  {row.state === 'failed' && row.error_message ? (
                    <View style={styles.queueErrorBox}>
                      <Icon name="alert" size={13} color={c.danger} />
                      <Text style={styles.queueErrorText}>
                        {row.error_message}
                      </Text>
                    </View>
                  ) : null}
                  {row.state === 'failed' ? (
                    <View style={styles.queueActionsRow}>
                      <AppButton
                        title="إعادة المحاولة"
                        icon="refresh"
                        small
                        variant="secondary"
                        onPress={() => void requeuePaymentRow(row)}
                        style={{flex: 1}}
                      />
                    </View>
                  ) : null}
                </Card>
              ))
            )}

            {/* v18 (round-24 #1): the Sila-app collections ledger — the
                money the app collected on the store's behalf. Before
                v18 these repayments made the debt «disappear» with no
                record anywhere; now every detection is a visible row
                and part of the treasury. */}
            <SectionTitle
              title="تحصيلات عبر تطبيق صِلة"
              hint="سددها الزبون من التطبيق على ديون فواتير متجرك — تُكتشف عند المزامنة"
            />
            {appCollections.length === 0 ? (
              <Card style={styles.emptyCard}>
                <Text style={styles.emptyText}>
                  لا توجد تحصيلات بعد — عندما يسدد زبون دينه من تطبيق صِلة
                  ستظهر هنا وتُحسب في الخزينة تلقائياً.
                </Text>
              </Card>
            ) : (
              appCollections.map(row => (
                <Card key={`coll-${row.local_id}`} style={styles.queueCard}>
                  <View style={styles.queueRow}>
                    <View style={styles.queueRowIcon}>
                      <Icon name="wallet" size={15} color={c.success} />
                    </View>
                    <View style={{flex: 1}}>
                      <Text style={styles.queueCustomer} numberOfLines={1}>
                        {row.customer_name ?? 'زبون صِلة'}
                      </Text>
                      <Text style={styles.queueInvoice}>
                        {formatMoney(row.amount_minor / 100)} ·{' '}
                        {formatDateTime(
                          row.detected_at.replace('T', ' ').slice(0, 19),
                        )}
                      </Text>
                    </View>
                    <Badge label="استُلم عبر صِلة" tone="success" />
                  </View>
                </Card>
              ))
            )}
          </>
        )}

        {/* v15 (round-21 #3): repayment sheet — INLINE absolute overlay
            (NEVER a Modal on this ROM). Amount in ₪ + quick-fill the
            full outstanding; confirm enqueues RCP receipt + uploads. */}
        {paySheet != null ? (
          <View style={styles.payOverlay}>
            <TouchableOpacity
              style={styles.payOverlayDim}
              activeOpacity={1}
              onPress={() => setPaySheet(null)}
            />
            <View style={styles.paySheet}>
              <View style={styles.payHandle} />
              <Text style={styles.payTitle}>تسجيل سداد نقدي</Text>
              <View style={styles.payCustomerRow}>
                <Icon name="wallet" size={20} color={c.accent} />
                <View style={{flex: 1}}>
                  <Text style={styles.payCustomerName} numberOfLines={1}>
                    {paySheet.name}
                  </Text>
                  <Text style={styles.payCustomerMeta}>
                    الدين القائم:{' '}
                    {formatMoney(paySheet.outstanding_minor / 100)}
                    {paySheet.app_outstanding_minor > 0
                      ? ` (منها ${formatMoney(
                          paySheet.app_outstanding_minor / 100,
                        )} عبر تطبيق صِلة)`
                      : ''}
                  </Text>
                </View>
              </View>

              <Text style={styles.payLabel}>المبلغ المستلم (₪)</Text>
              <TextInput
                style={styles.payInput}
                value={payAmountText}
                onChangeText={setPayAmountText}
                placeholder="0.00"
                placeholderTextColor={c.textFaint}
                keyboardType="decimal-pad"
                autoCorrect={false}
              />
              <TouchableOpacity
                style={styles.payQuickBtn}
                onPress={() =>
                  setPayAmountText(
                    (paySheet.outstanding_minor / 100)
                      .toFixed(2)
                      .replace(/\.00$/, ''),
                  )
                }
                activeOpacity={0.8}>
                <Text style={styles.payQuickText}>
                  السداد الكامل ({formatMoney(paySheet.outstanding_minor / 100)}{' '}
                  ₪)
                </Text>
              </TouchableOpacity>
              <Text style={styles.payHint}>
                السداد يطفئ أقدم دين أولاً (FIFO) بنفس قاعدة صِلة — سواء نشأ
                الدين من فواتير متجرك أو من التطبيق. يُرفع السداد لصِلة بإيصال
                فريد وساعة الإنترنت.
              </Text>
              <View style={styles.payActions}>
                <AppButton
                  title="إلغاء"
                  variant="secondary"
                  onPress={() => setPaySheet(null)}
                  style={{flex: 1}}
                />
                <AppButton
                  title="تأكيد السداد"
                  variant="success"
                  icon="check"
                  loading={payBusy}
                  onPress={() => void confirmPayment()}
                  style={{flex: 1.6}}
                />
              </View>
            </View>
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const useStyles = makeStyles(c =>
  StyleSheet.create({
    content: {
      padding: spacing.lg,
      gap: spacing.md,
    },
    // ── intro / pairing ──
    introCard: {gap: spacing.md},
    introIconRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.md,
    },
    introIcon: {
      width: 52,
      height: 52,
      borderRadius: 16,
      backgroundColor: c.accentSofter,
      alignItems: 'center',
      justifyContent: 'center',
    },
    introTitle: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: typography.body,
    },
    introText: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      lineHeight: 20,
      marginTop: 4,
    },
    stepRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    stepNum: {
      width: 24,
      height: 24,
      borderRadius: 12,
      backgroundColor: c.accentSofter,
      color: c.accent,
      fontFamily: fonts.bold,
      fontSize: 13,
      textAlign: 'center',
      textAlignVertical: 'center',
      lineHeight: 24,
      overflow: 'hidden',
    },
    stepText: {
      flex: 1,
      color: c.text,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      lineHeight: 19,
    },
    pairCard: {gap: spacing.md},
    fieldLabel: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    codeInput: {
      backgroundColor: c.surfaceHi,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
      color: c.text,
      fontFamily: fonts.black,
      fontSize: typography.heading,
      textAlign: 'center',
      letterSpacing: 2,
      paddingVertical: spacing.md,
    },
    scanPairBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      paddingVertical: spacing.sm,
    },
    scanPairText: {
      color: c.accent,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    // ── identity ──
    identityCard: {gap: spacing.md},
    identityRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
    },
    identityIcon: {
      width: 48,
      height: 48,
      borderRadius: 14,
      backgroundColor: c.accentSofter,
      alignItems: 'center',
      justifyContent: 'center',
    },
    identityName: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: typography.body,
    },
    identityMeta: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      marginTop: 2,
      lineHeight: 18,
    },
    deviceInvalidBox: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.sm,
      backgroundColor: c.dangerSoft,
      borderRadius: radius.sm,
      padding: spacing.md,
    },
    deviceInvalidText: {
      flex: 1,
      color: c.danger,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      lineHeight: 19,
    },
    // ── sync ──
    syncCard: {gap: spacing.md},
    syncHeaderRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    syncStateText: {
      flex: 1,
      fontFamily: fonts.bold,
      fontSize: typography.small,
      lineHeight: 19,
    },
    syncCountsRow: {
      flexDirection: 'row',
      gap: spacing.sm,
    },
    syncCountBox: {
      flex: 1,
      backgroundColor: c.surfaceHi,
      borderRadius: radius.md,
      paddingVertical: spacing.md,
      alignItems: 'center',
      gap: 2,
    },
    syncCountNum: {
      fontFamily: fonts.black,
      fontSize: typography.heading,
    },
    syncCountLabel: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
    },
    lastSyncText: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      textAlign: 'center',
    },
    syncActionsRow: {
      flexDirection: 'row',
      gap: spacing.sm,
      alignItems: 'center',
    },
    unpairBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.md,
    },
    unpairText: {
      color: c.danger,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    // ── queue ──
    queueCard: {gap: spacing.sm},
    queueRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    // v18 (round-24 #1): the little wallet chip on app-collection rows.
    queueRowIcon: {
      width: 32,
      height: 32,
      borderRadius: 10,
      backgroundColor: c.successSoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    queueCustomer: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    queueCreditNote: {
      color: c.success,
      fontFamily: fonts.bold,
      fontSize: 11,
      marginTop: 2,
    },
    queueInvoice: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      marginTop: 2,
    },
    queueRef: {
      color: c.success,
      fontFamily: fonts.bold,
      fontSize: typography.micro + 1,
    },
    queueErrorBox: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 8,
      backgroundColor: c.dangerSoft,
      borderRadius: radius.sm,
      padding: spacing.sm,
    },
    queueErrorText: {
      flex: 1,
      color: c.danger,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      lineHeight: 17,
    },
    queueActionsRow: {
      flexDirection: 'row',
      gap: spacing.sm,
    },
    // ── customers ──
    customerCard: {},
    customerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    customerName: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    customerMeta: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      marginTop: 2,
    },
    customerBalance: {
      alignItems: 'flex-end',
    },
    customerBalanceNum: {
      fontFamily: fonts.black,
      fontSize: typography.body,
    },
    customerBalanceLabel: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro,
    },
    emptyCard: {},
    // v16 (round-22 #4): the local debt-book entry card.
    localBookCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: c.surface,
      borderWidth: 1.5,
      borderColor: c.accentSoft,
      borderRadius: radius.lg,
      padding: spacing.md,
    },
    localBookIcon: {
      width: 38,
      height: 38,
      borderRadius: 12,
      backgroundColor: c.accentSoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    localBookTitle: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: 14,
    },
    localBookText: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: 11.5,
      lineHeight: 16.5,
      marginTop: 2,
    },
    emptyText: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      lineHeight: 20,
      textAlign: 'center',
    },
    // ── v15 (round-21 #3): origin split + repayment sheet ──
  splitBox: {
    backgroundColor: c.surfaceHi,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.borderSoft,
    padding: spacing.sm + 2,
    gap: 3,
    marginTop: spacing.sm,
  },
  splitRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  splitLabel: {
    color: c.textDim,
    fontFamily: fonts.regular,
    fontSize: typography.micro + 1,
  },
  splitValue: {
    fontFamily: fonts.bold,
    fontSize: typography.micro + 1,
    fontVariant: ['tabular-nums'],
  },
  splitNote: {
    color: c.textFaint,
    fontFamily: fonts.regular,
    fontSize: typography.micro,
    marginTop: 2,
  },
  settledRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: spacing.xs,
  },
  settledText: {
    color: c.success,
    fontFamily: fonts.bold,
    fontSize: typography.micro + 1,
  },
  payOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'flex-end',
    zIndex: 60,
    elevation: 60,
  },
  payOverlayDim: {
    flex: 1,
    backgroundColor: c.overlay,
  },
  paySheet: {
    backgroundColor: c.surface,
    borderTopLeftRadius: radius.lg + 4,
    borderTopRightRadius: radius.lg + 4,
    padding: spacing.lg,
    gap: spacing.sm,
    paddingBottom: spacing.xxl,
  },
  payHandle: {
    alignSelf: 'center',
    width: 44,
    height: 4,
    borderRadius: 2,
    backgroundColor: c.border,
    marginBottom: spacing.xs,
  },
  payTitle: {
    color: c.text,
    fontFamily: fonts.black,
    fontSize: typography.heading,
    textAlign: 'center',
    marginBottom: spacing.xs,
  },
  payCustomerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: c.accentSofter,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: c.border,
  },
  payCustomerName: {
    color: c.text,
    fontFamily: fonts.bold,
    fontSize: typography.body,
  },
  payCustomerMeta: {
    color: c.textDim,
    fontFamily: fonts.regular,
    fontSize: typography.micro + 1,
    marginTop: 1,
  },
  payLabel: {
    color: c.textDim,
    fontFamily: fonts.bold,
    fontSize: typography.small,
  },
  payInput: {
    backgroundColor: c.surfaceHi,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.border,
    color: c.text,
    fontFamily: fonts.black,
    fontSize: typography.heading,
    textAlign: 'center',
    paddingVertical: spacing.md,
  },
  payQuickBtn: {
    alignItems: 'center',
    paddingVertical: spacing.xs,
  },
  payQuickText: {
    color: c.accent,
    fontFamily: fonts.bold,
    fontSize: typography.small,
  },
  payHint: {
    color: c.textFaint,
    fontFamily: fonts.regular,
    fontSize: typography.micro + 1,
    lineHeight: 17,
    textAlign: 'center',
  },
  payActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  }),
);
