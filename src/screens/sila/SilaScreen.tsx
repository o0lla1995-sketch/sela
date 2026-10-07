/**
 * SilaScreen — دفتر صِلة (redesigned v19, round-25 #5).
 * ─────────────────────────────────────────────────────────────────
 * UNPAIRED: the merchant-authentication flow — type the one-time
 * pairing code (XXXX-XXXX) generated in the SILA merchant app, or
 * scan its QR (sila-pair:…) with the camera. One POST /api/pos/pair
 * stores the long-lived pos_token locally (§6.1).
 *
 * PAIRED — v19 TABS (the v18 single wall couldn't handle hundreds
 * of invoices/receipts; the merchant asked for a real ledger UI):
 *
 *   نظرة عامة  — pairing health, sync counters, ONE KPI row
 *                (store debts owed to you, debtors, app
 *                collections, cashier repayments), manual sync.
 *   الديون     — the debt queue with SEARCH (invoice ref /
 *                customer), state filter chips and paging.
 *   الزبائن    — customers cache with search, the origin split
 *                and the strict repayment sheet.
 *   السدادّات   — cashier repayments + Sila-app collections in
 *                two paged ledgers (collections explain themselves
 *                and can be reviewed/removed when wrong).
 *
 * The v16 «دفتر ديون المتجر» jump card is GONE (round-25 #5:
 * «احذف زر الانتقال للدين المحلي من صفحة صلة») — the dashboard's
 * الخزينة والديون card links both ledgers now.
 *
 * Repayment sheet (round-25 #4): STRICT validation — amount > 0,
 * sane upper bound, decimal-only input, and an explicit
 * confirmation whenever the amount exceeds the outstanding (the
 * server floors the debt at zero; the excess is cash the merchant
 * keeps — the books record the FULL received amount).
 */
import React, {useCallback, useEffect, useMemo, useState} from 'react';
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
  Segmented,
} from '../../components/ui';
import {Icon} from '../../components/Icon';
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
import {
  formatDate,
  formatDateTime,
  formatMoney,
  relativeTime,
} from '../../core/format';
import {APP_VERSION} from '../../core/config';
import type {SilaDebtRow, SilaCustomer, SilaPaymentRow} from '../../core/types';
import {uuidV4} from '../../services/sila/qr';
import {VouchersRepo} from '../../services/sila/VouchersRepo';
import {VouchersTab} from './VouchersTab';
import {VoucherRedeemSheet} from './VoucherRedeemSheet';

type SilaTab = 'overview' | 'debts' | 'customers' | 'payments' | 'vouchers';
type DebtFilter = 'all' | 'pending' | 'failed' | 'synced';

const PAGE_SIZE = 20;

const TAB_OPTIONS: {value: SilaTab; label: string}[] = [
  {value: 'overview', label: 'نظرة عامة'},
  {value: 'debts', label: 'الديون'},
  {value: 'customers', label: 'الزبائن'},
  {value: 'payments', label: 'السدادّات'},
  {value: 'vouchers', label: 'القسائم'},
];

const DEBT_FILTERS: {value: DebtFilter; label: string}[] = [
  {value: 'all', label: 'الكل'},
  {value: 'failed', label: 'فاشلة'},
  {value: 'pending', label: 'بانتظار'},
  {value: 'synced', label: 'مسجّلة'},
];

export function SilaScreen() {
  const c = useThemeColors();
  const styles = useStyles();
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
  const [tab, setTab] = useState<SilaTab>('overview');
  const [syncingNow, setSyncingNow] = useState(false);

  // ── الديون tab: search + filter + paging ──
  const [debtSearch, setDebtSearch] = useState('');
  const [debtFilter, setDebtFilter] = useState<DebtFilter>('all');
  const [debts, setDebts] = useState<SilaDebtRow[]>([]);
  const [debtsTotal, setDebtsTotal] = useState(0);
  const [debtsLoading, setDebtsLoading] = useState(false);

  // ── الزبائن tab: search + client paging ──
  const [customers, setCustomers] = useState<SilaCustomer[]>([]);
  const [customerSearch, setCustomerSearch] = useState('');
  const [customersShown, setCustomersShown] = useState(PAGE_SIZE);

  // ── السدادّات tab: two paged ledgers ──
  const [payments, setPayments] = useState<SilaPaymentRow[]>([]);
  const [paymentsShown, setPaymentsShown] = useState(PAGE_SIZE);
  const [appCollections, setAppCollections] = useState<
    Awaited<ReturnType<typeof SilaRepo.recentAppCollections>>
  >([]);
  const [collectionsShown, setCollectionsShown] = useState(PAGE_SIZE);

  // ── overview KPIs (server pos part + this device's unsynced
  //  queue rows — never understate while offline) ──
  const [totals, setTotals] = useState<{
    posMinor: number;
    appMinor: number;
    debtors: number;
    queuePendingMinor: number;
    /** v32 (round-40 #6): دين هذا المتجر وعدد المدينين له — محلي. */
    ownMinor: number;
    ownDebtors: number;
    /** v33 (round-41 #11 — 0075): إجمالي دين هذه النقطة على الخادم. */
    deviceMinor: number;
  } | null>(null);

  // v15 (round-21 #3): the repayment sheet — inline absolute overlay
  // (NEVER a Modal: this ROM blacks RN Modals after the native
  // scanner closes — the same lesson as the POS debt sheet).
  const [paySheet, setPaySheet] = useState<SilaCustomer | null>(null);
  // v32 (round-40 #6): ديون هذا المتجر لكل زبون + الإجمالي — من
  // الدفاتر المحلية (فواتير المتجر − السدادّات هنا − تحصيلات
  // التطبيق − عكس المرتجعات).
  const [ownByCustomer, setOwnByCustomer] = useState<Map<string, number>>(
    new Map(),
  );
  const [payAmountText, setPayAmountText] = useState('');
  const [payBusy, setPayBusy] = useState(false);

  // v24 (round-31 #4c): the PARCEL redemption sheet lives HERE, at
  // the Screen level — an absolute overlay rendered inside the
  // VouchersTab sticks to the ScrollView's CONTENT (the merchant's
  // «النافذة تظهر أسفل الصفحة ونضطر للسكرول» complaint); hoisted
  // out it always covers the visible screen. Parcels ONLY (the
  // tab's button passes mode='parcel'). refreshKey bumps on every
  // close so the tab reloads whatever landed while it was open.
  const [parcelSheetOpen, setParcelSheetOpen] = useState(false);
  const [parcelRefresh, setParcelRefresh] = useState(0);

  // ── v20: the campaigns headline (Σ server-stated dues) shown on
  // the overview — the §4.2 indicator the merchant should see.
  // v22 (round-28 #3): the overview card now carries BOTH campaign
  // figures — what was added to the standing debt (المستحق) and
  // what was added to the treasury (المستلم). ──
  const [campaignDueMinor, setCampaignDueMinor] = useState(0);
  const [campaignSettledMinor, setCampaignSettledMinor] = useState(0);
  const [campaignCount, setCampaignCount] = useState(0);
  const [campaignActiveCount, setCampaignActiveCount] = useState(0);
  const [campaignCompletedCount, setCampaignCompletedCount] = useState(0);

  // ── data loading ───────────────────────────────────────────────

  const loadDebtsPage = useCallback(
    async (filter: DebtFilter, search: string) => {
      setDebtsLoading(true);
      try {
        const stateFilter =
          filter === 'all'
            ? undefined
            : filter === 'pending'
            ? 'pending'
            : filter;
        const [rows, count] = await Promise.all([
          SilaRepo.recent(PAGE_SIZE, 0, stateFilter, search),
          SilaRepo.debtQueueCount(stateFilter, search),
        ]);
        setDebts(rows);
        setDebtsTotal(count);
      } catch {
        // Fresh installs before the first migration tick — quiet.
      } finally {
        setDebtsLoading(false);
      }
    },
    [],
  );

  const loadMoreDebts = useCallback(async () => {
    if (debtsLoading || debts.length >= debtsTotal) {
      return;
    }
    setDebtsLoading(true);
    try {
      const stateFilter =
        debtFilter === 'all'
          ? undefined
          : debtFilter === 'pending'
          ? 'pending'
          : debtFilter;
      const rows = await SilaRepo.recent(
        PAGE_SIZE,
        debts.length,
        stateFilter,
        debtSearch,
      );
      setDebts(previous => {
        const seen = new Set(previous.map(row => row.local_id));
        return [...previous, ...rows.filter(row => !seen.has(row.local_id))];
      });
    } catch {
      // quiet
    } finally {
      setDebtsLoading(false);
    }
  }, [debtFilter, debtSearch, debts.length, debtsTotal, debtsLoading]);

  const reload = useCallback(async () => {
    try {
      const [
        customersList,
        payRows,
        collections,
        silaTotals,
        queueTotals,
        campaignTotals,
        // v32 (round-40 #6): ديون هذا المتجر من الدفاتر المحلية —
        // فواتير هذا المتجر فقط، لا أرصدة الخادم المختلطة بمتاجر
        // التاجر الأخرى المرتبطة بنفس الحساب.
        ownByCustomer,
        ownTotals,
      ] = await Promise.all([
        SilaRepo.listCustomers(),
        SilaRepo.recentPayments(200),
        SilaRepo.recentAppCollections(200),
        SilaRepo.customersOutstandingTotal(),
        SilaRepo.totals(),
        // v20: the campaigns headline for the overview card.
        VouchersRepo.campaignsTotals(),
        SilaRepo.storeOwnOutstandingByCustomer(),
        SilaRepo.storeOwnOutstandingTotal(),
      ]);
      // v32: صفحة الزبائن هي دفتر هذا المتجر — الترتيب بدين المتجر
      // نفسه (الأعلى ديناً أولاً) ثم بالاسم.
      customersList.sort((a, b) => {
        const ownA = ownByCustomer.get(a.customer_id) ?? 0;
        const ownB = ownByCustomer.get(b.customer_id) ?? 0;
        if (ownA !== ownB) {
          return ownB - ownA;
        }
        return a.name.localeCompare(b.name, 'ar');
      });
      setOwnByCustomer(ownByCustomer);
      setCustomers(customersList);
      setPayments(payRows);
      setAppCollections(collections);
      setTotals({
        posMinor: silaTotals.posTotalMinor,
        appMinor: silaTotals.appTotalMinor,
        debtors: silaTotals.debtorsCount,
        queuePendingMinor: queueTotals.pendingMinor,
        // v32: دين هذا المتجر من دفاتره المحلية.
        ownMinor: ownTotals.ownMinor,
        ownDebtors: ownTotals.debtorsCount,
        // v33 (round-41 #11 — 0075): دين هذه النقطة على الخادم.
        deviceMinor: silaTotals.deviceTotalMinor,
      });
      setCampaignDueMinor(campaignTotals.dueMinor);
      setCampaignSettledMinor(campaignTotals.settledMinorTotal);
      setCampaignCount(campaignTotals.campaignsCount);
      setCampaignActiveCount(campaignTotals.activeCount);
      setCampaignCompletedCount(campaignTotals.completedCount);
      await refreshCounts();
      await loadDebtsPage(debtFilter, debtSearch);
    } catch {
      // Fresh installs before the first migration tick — quiet.
    }
  }, [debtFilter, debtSearch, loadDebtsPage, refreshCounts]);

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reload the debts page whenever its filter/search changes.
  const [searchTimer, setSearchTimer] = useState<ReturnType<
    typeof setTimeout
  > | null>(null);
  const onDebtSearchChange = useCallback(
    (text: string) => {
      setDebtSearch(text);
      if (searchTimer != null) {
        clearTimeout(searchTimer);
      }
      const timer = setTimeout(() => {
        void loadDebtsPage(debtFilter, text);
      }, 350);
      setSearchTimer(timer);
    },
    [debtFilter, loadDebtsPage, searchTimer],
  );

  const onDebtFilterChange = useCallback(
    (filter: DebtFilter) => {
      setDebtFilter(filter);
      void loadDebtsPage(filter, debtSearch);
    },
    [debtSearch, loadDebtsPage],
  );

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

  // ── v15 (round-21 #3) + v19 (round-25 #4): repayments (§2.3) ──

  const openPaySheet = useCallback((customer: SilaCustomer) => {
    setPayAmountText('');
    setPaySheet(customer);
  }, []);

  /** v19: the strict parse — decimal-only, positive, sane ceiling. */
  const parsePayAmount = useCallback((text: string): number | null => {
    const normalized = text.trim().replace(',', '.');
    if (!/^\d+(\.\d{1,2})?$/.test(normalized)) {
      return null;
    }
    const amount = Number(normalized);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) {
      return null;
    }
    return amount;
  }, []);

  const doConfirmPayment = useCallback(
    async (amount: number) => {
      const customer = paySheet;
      if (customer == null || payBusy) {
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
          amountMinor: Math.round(amount * 100),
          paymentMethod: 'cash',
          posReceiptRef: receiptRef,
          description: `سداد نقدي — ${customer.name}`,
          paidAt: new Date().toISOString(),
        });
        setPaySheet(null);
        setPayAmountText('');
        await reload();
        toast(
          `سُجّل سداد ${formatMoney(amount)} من ${
            customer.name
          } — إيصال ${receiptRef} سيُرفع لصِلة`,
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
    },
    [payBusy, paySheet, reload, toast],
  );

  const confirmPayment = useCallback(() => {
    const customer = paySheet;
    if (customer == null) {
      return;
    }
    const amount = parsePayAmount(payAmountText);
    if (amount == null) {
      toast(
        'أدخل مبلغاً صحيحاً: أرقام فقط أكبر من صفر (وحتى فاصلتين عشريتين)',
        'error',
      );
      return;
    }
    const amountMinor = Math.round(amount * 100);
    // v24 (round-31 #2): the cashier repays STORE debts only.
    // v32 (round-40 #6): السقف من دفاتر المتجر المحلية (فواتير هذا
    // المتجر هو)، ومعه حد أمان الخادم إن كان أقل (سدادّات حدثت خارج
    // هذا المتجر) كي لا يُرفض الإيصال — الرفض الصريح دائماً بلا
    // مسار دفع زائد صامت.
    const ownMinor = ownByCustomer.get(customer.customer_id) ?? 0;
    // v33 (round-41 #11 — 0075): حد أمان الخادم من دين هذه النقطة
    // تحديداً (device_outstanding_minor — إسناد ثنائي المرحلة)؛
    // خوادم ما قبل 0075 ترسله 0 → الرجوع لسقف نقاط البيع المجمّع.
    const serverCapMinor =
      customer.device_outstanding_minor > 0
        ? customer.device_outstanding_minor
        : Math.max(0, customer.pos_outstanding_minor);
    const storeDebtMinor = Math.min(ownMinor, serverCapMinor);
    if (amountMinor > storeDebtMinor) {
      toast(
        `المبلغ أكبر من دين متجرك (${formatMoney(
          storeDebtMinor / 100,
        )}) — السداد من المتجر يطفئ ديون فواتير هذا المتجر فقط`,
        'error',
        5000,
      );
      return;
    }
    void doConfirmPayment(amount);
  }, [
    doConfirmPayment,
    parsePayAmount,
    payAmountText,
    paySheet,
    ownByCustomer,
    toast,
  ]);

  const requeuePaymentRow = useCallback(
    async (row: SilaPaymentRow) => {
      await SilaRepo.requeuePayment(row.local_id);
      await reload();
      toast(`أُعيد إيصال ${row.pos_receipt_ref} إلى طابور المزامنة`, 'info');
    },
    [reload, toast],
  );

  /** v19 (round-25 #1): review + remove a MISTAKEN app collection. */
  const removeCollection = useCallback(
    (row: {
      local_id: number;
      customer_name: string | null;
      amount_minor: number;
    }) => {
      Alert.alert(
        'حذف تحصيل تطبيق صِلة',
        `سيُحذف سجل تحصيل ${formatMoney(row.amount_minor / 100)} عن ${
          row.customer_name ?? 'زبون'
        } من الخزينة والتقارير نهائياً، ولن يعود يُسجَّل مرة أخرى.\nاحذفه فقط إذا تأكدت أنه خاطئ (مثل سجلات قديمة رُصدت دفعة واحدة).\nهل أنت متأكد؟`,
        [
          {text: 'تراجع', style: 'cancel'},
          {
            text: 'حذف نهائي',
            style: 'destructive',
            onPress: async () => {
              const ok = await SilaRepo.deleteAppCollection(row.local_id);
              if (ok) {
                await reload();
                toast('حُذف سجل التحصيل من الدفاتر', 'info');
              } else {
                toast('تعذر حذف السجل — حاول مجدداً', 'error');
              }
            },
          },
        ],
      );
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

  const filteredCustomers = useMemo(() => {
    const q = customerSearch.trim();
    if (q.length === 0) {
      return customers;
    }
    return customers.filter(
      customer =>
        customer.name.includes(q) ||
        (customer.phone_last4 ?? '').includes(q) ||
        customer.customer_id.includes(q),
    );
  }, [customers, customerSearch]);

  // ── PAIRED tab renderers ───────────────────────────────────────

  const renderOverview = () => (
    <>
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

      {/* KPI row — what the store is owed + what came in.
          v32 (round-40 #6): دين المتجر وعدد مدينيه من الدفاتر
          المحلية — فواتير هذا المتجر هو، بلا خلط بأرصدة الخادم
          التي قد تجمع فواتير كل متاجر التاجر. */}
      <View style={styles.kpiGrid}>
        <View style={styles.kpiCell}>
          <Icon name="book" size={15} color={c.warning} />
          <Text style={styles.kpiValue}>
            {formatMoney((totals?.ownMinor ?? 0) / 100)}
          </Text>
          <Text style={styles.kpiLabel}>دين فواتير متجرك (صِلة)</Text>
        </View>
        <View style={styles.kpiCell}>
          <Icon name="users" size={15} color={c.accent} />
          <Text style={styles.kpiValue}>{totals?.ownDebtors ?? 0}</Text>
          <Text style={styles.kpiLabel}>زبون مدين لك</Text>
        </View>
        <View style={styles.kpiCell}>
          <Icon name="wallet" size={15} color={c.success} />
          <Text style={styles.kpiValue}>
            {formatMoney(
              appCollections.reduce((sum, row) => sum + row.amount_minor, 0) /
                100,
            )}
          </Text>
          <Text style={styles.kpiLabel}>تحصيلات عبر التطبيق</Text>
        </View>
        <View style={styles.kpiCell}>
          <Icon name="checkCircle" size={15} color={c.info} />
          <Text style={styles.kpiValue}>
            {formatMoney(
              payments.reduce((sum, row) => sum + row.amount_minor, 0) / 100,
            )}
          </Text>
          <Text style={styles.kpiLabel}>سدادّات عند الكاشير</Text>
        </View>
      </View>

      {(totals?.appMinor ?? 0) > 0 ? (
        <Card style={styles.infoCard}>
          <Icon name="info" size={15} color={c.info} />
          <Text style={styles.infoText}>
            يوجد لدى زبائنك {formatMoney((totals?.appMinor ?? 0) / 100)} ديون
            نشأت داخل تطبيق صِلة نفسه (شراء عبر التطبيق) — تظهر للمعلومية فقط
            وليست من مبيعات متجرك ولا تدخل خزينتك.
          </Text>
        </Card>
      ) : null}

      {/* v32 (round-40 #6): «هذا المتجر مقابل كل المتاجر» — عندما تجمع
          أرصدة صِلة فواتير من متاجر التاجر الأخرى (المرتبطة بنفس
          الحساب) فوق دين هذا المتجر، يُعرض الفارق هنا للمعلومية حتى
          يعرف التاجر أن رقم «دين فواتير متجرك» أعلاه هو متجره هو
          فقط، لا كل متاجره. */}
      {(totals?.posMinor ?? 0) - (totals?.ownMinor ?? 0) >= 100 ? (
        <Card style={styles.infoCard}>
          <Icon name="store" size={15} color={c.info} />
          <Text style={styles.infoText}>
            أرصدة صِلة تجمع {formatMoney((totals?.posMinor ?? 0) / 100)}{' '}
            ديون فواتير لكل متاجر التاجر المرتبطة بالحساب — منها{' '}
            {formatMoney(
              ((totals?.posMinor ?? 0) - (totals?.ownMinor ?? 0)) / 100,
            )}{' '}
            من فواتير متاجرك الأخرى. الرقم المعتمد أعلاه «دين فواتير
            متجرك» هو فواتير هذا المتجر فقط.
          </Text>
        </Card>
      ) : null}

      {/* v22 (round-28 #3): the campaigns OVERVIEW card — the two
          figures the merchant asked for on نظرة عامة: what the
          activated campaigns ADDED to the standing debt (المستحق —
          a claim on the institutions until settled) and what they
          ADDED to the treasury (المستلم — the settled money that
          arrived). Tapping jumps to the القسائم tab. */}
      {campaignCount > 0 ? (
        <TouchableOpacity
          activeOpacity={0.8}
          onPress={() => setTab('vouchers')}>
          <Card style={styles.campaignsCard}>
            <View style={styles.campaignsHeadRow}>
              <View style={styles.campaignsIcon}>
                <Icon name="ticket" size={19} color={c.accent} />
              </View>
              <View style={{flex: 1}}>
                <Text style={styles.campaignsLabel}>
                  حملات القسائم — نظرة عامة
                </Text>
                <Text style={styles.campaignsMeta}>
                  فعّالة: {campaignActiveCount}
                  {campaignCompletedCount > 0
                    ? ` · مكتملة: ${campaignCompletedCount}`
                    : ''}
                  {' · اضغط للتفعيل والصرف والسجل'}
                </Text>
              </View>
              <Icon name="chevronLeft" size={16} color={c.textFaint} />
            </View>
            <View style={styles.campaignsStatGrid}>
              <View style={styles.campaignsStatCell}>
                <Text
                  style={[
                    styles.campaignsStatValue,
                    campaignDueMinor > 0
                      ? {color: c.warning}
                      : {color: c.success},
                  ]}>
                  {formatMoney(campaignDueMinor / 100)}
                </Text>
                <Text style={styles.campaignsStatLabel}>
                  أُضيف إلى الدين القائم (مستحق الحملات على المؤسسات)
                </Text>
              </View>
              <View style={styles.campaignsStatDivider} />
              <View style={styles.campaignsStatCell}>
                <Text style={[styles.campaignsStatValue, {color: c.success}]}>
                  {formatMoney(campaignSettledMinor / 100)}
                </Text>
                <Text style={styles.campaignsStatLabel}>
                  أُضيف إلى النقد بالخزينة (مستلم من المؤسسات)
                </Text>
              </View>
            </View>
            <Text style={styles.campaignsFootNote}>
              المستحق دينٌ قائم على المؤسسات حتى تسويته، والمستلم دخل خزينتك —
              تماماً كديون الزبائن وتحصيلاتها.
            </Text>
          </Card>
        </TouchableOpacity>
      ) : null}

      <Card style={styles.guideCard}>
        <Text style={styles.guideTitle}>ماذا يوجد في هذا الدفتر؟</Text>
        <Text style={styles.guideLine}>
          • الديون: كل فاتورة بِعتها ديناً عبر صِلة وحالة مزامنتها.
        </Text>
        <Text style={styles.guideLine}>
          • الزبائن: أرصدة زبائن صِلة لدى متجرك مع تسجيل السداد النقدي.
        </Text>
        <Text style={styles.guideLine}>
          • السدادّات: ما استلمته بالكاشير، وما سدده الزبائن من تطبيقهم (يُكتشف
          تلقائياً عند المزامنة).
        </Text>
        <Text style={styles.guideLine}>
          • القسائم: فعّل حملات المؤسسات في متجرك واصرف قسائمها — مستحقاتك على
          المؤسسة دين حتى التسوية، وليست ديناً على الزبائن.
        </Text>
      </Card>
    </>
  );

  const renderDebts = () => (
    <>
      <TextInput
        style={styles.searchBox}
        value={debtSearch}
        onChangeText={onDebtSearchChange}
        placeholder="ابحث برقم الفاتورة أو اسم الزبون…"
        placeholderTextColor={c.textFaint}
      />
      <View style={styles.filterRow}>
        {DEBT_FILTERS.map(item => (
          <TouchableOpacity
            key={item.value}
            style={[
              styles.filterChip,
              debtFilter === item.value
                ? {backgroundColor: c.accent, borderColor: c.accent}
                : null,
            ]}
            onPress={() => onDebtFilterChange(item.value)}
            activeOpacity={0.8}>
            <Text
              style={[
                styles.filterText,
                debtFilter === item.value ? {color: c.onAccent} : null,
              ]}>
              {item.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      <Text style={styles.resultCount}>
        {debtsLoading && debts.length === 0
          ? 'جارٍ التحميل…'
          : `${debtsTotal} فاتورة${debtFilter !== 'all' ? ' (مفلترة)' : ''}`}
      </Text>
      {debts.length === 0 && !debtsLoading ? (
        <Card style={styles.emptyCard}>
          <Text style={styles.emptyText}>
            لا توجد ديون مطابقة — استخدم زر «دين» في شاشة نقطة البيع لتسجيل
            فاتورة ديناً على زبون صِلة.
          </Text>
        </Card>
      ) : (
        debts.map(row => (
          <Card key={row.local_id} style={styles.queueCard}>
            <View style={styles.queueRow}>
              <View style={{flex: 1}}>
                <Text style={styles.queueCustomer} numberOfLines={1}>
                  {row.customer_name ?? 'زبون صِلة'}
                </Text>
                <Text style={styles.queueInvoice}>
                  {row.pos_invoice_ref} · {(row.amount_minor / 100).toFixed(2)}{' '}
                  ₪ ·{' '}
                  {formatDateTime(
                    row.created_at.replace('T', ' ').slice(0, 19),
                  )}
                </Text>
                {row.credit_covered_minor > 0 ? (
                  <Text style={styles.queueCreditNote}>
                    غطّى الرصيد المسبق{' '}
                    {formatMoney(row.credit_covered_minor / 100)} — الفاتورة
                    مسددة بهذا المقدار
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
                <Text style={styles.queueErrorText}>{row.error_message}</Text>
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
      {debts.length < debtsTotal ? (
        <AppButton
          title={`عرض المزيد (${debtsTotal - debts.length} متبقية)`}
          variant="secondary"
          small
          loading={debtsLoading}
          onPress={() => void loadMoreDebts()}
        />
      ) : null}
    </>
  );

  const renderCustomers = () => (
    <>
      <TextInput
        style={styles.searchBox}
        value={customerSearch}
        onChangeText={setCustomerSearch}
        placeholder="ابحث باسم الزبون أو آخر 4 أرقام من هاتفه…"
        placeholderTextColor={c.textFaint}
      />
      {/* v24 (round-31 #2): the page's charter — store debts ONLY. */}
      <Text style={styles.customersScopeNote}>
        هذه الصفحة تعرض ديون فواتير متجرك فقط على زبائن صِلة — ديون تطبيق صِلة
        غير الخاصة بمتجرك لا تظهر هنا ولا يُسدّدها الكاشير
      </Text>
      {filteredCustomers.length === 0 ? (
        <Card style={styles.emptyCard}>
          <Text style={styles.emptyText}>
            ستظهر هنا أرصدة زبائن صِلة لدى متجرك بعد أول مزامنة ناجحة.
          </Text>
        </Card>
      ) : (
        <>
          {filteredCustomers.slice(0, customersShown).map(customer => {
            /* v32 (round-40 #6) → v33 (round-41 #11 — 0075): الرقم
               الأساسي هو دين هذا المتجر من الدفاتر المحلية (فواتيره
               هو)، وسقف الخادم device_outstanding_minor (دين هذه
               النقطة بإسناد المرحلتين). الفارق عن أرصدة الخادم
               يُعرض للمعلومية مفصّلاً: متاجر التاجر الأخرى، وعمليات
               تطبيق صِلة، والشامل — القاعدة الذهبية §4.5. */
            const ownMinor = ownByCustomer.get(customer.customer_id) ?? 0;
            const deviceMinor = customer.device_outstanding_minor;
            const otherStoresMinor = Math.max(
              0,
              customer.pos_outstanding_minor -
                (deviceMinor > 0 ? deviceMinor : ownMinor),
            );
            const appOpsMinor = Math.max(0, customer.app_outstanding_minor);
            return (
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
                      ownMinor > 0 ? {color: c.danger} : {color: c.success},
                    ]}>
                    {formatMoney(ownMinor / 100)}
                  </Text>
                  <Text style={styles.customerBalanceLabel}>
                    دين متجرك (فواتير هذا المتجر)
                  </Text>
                </View>
              </View>

              {/* v24 (round-31 #2): the customers page carries STORE
                  debts ONLY. v32: الرقم من دفاتر المتجر المحلية،
                  وفارق الخادم (فواتير متاجر التاجر الأخرى أو سدادّات
                  حدثت خارج هذا المتجر) يُعرض للمعلومية فقط. */}
              {ownMinor > 0 ? (
                <View style={styles.splitBox}>
                  <Text style={styles.splitNote}>
                    دين هذا الزبون من فواتير أصدرها متجرك — يسدّده الكاشير من
                    هنا، وديون تطبيق صِلة تُسدّد من التطبيق نفسه
                  </Text>
                  {otherStoresMinor >= 100 ? (
                    <Text
                      style={[
                        styles.splitNote,
                        {color: c.textFaint},
                      ]}>
                      للمعلومية: {formatMoney(otherStoresMinor / 100)} ديون
                      فواتير من متاجر التاجر الأخرى المرتبطة بنفس الحساب —
                      لا يدخلها الكاشير ولا دفاتر هذا المتجر
                    </Text>
                  ) : null}
                  {appOpsMinor >= 100 ? (
                    <Text
                      style={[
                        styles.splitNote,
                        {color: c.textFaint},
                      ]}>
                      للمعلومية: {formatMoney(appOpsMinor / 100)} ديون نشأت من
                      عمليات تطبيق صِلة نفسه (شراء عبر التطبيق) — تُسدّد من
                      التطبيق
                    </Text>
                  ) : null}
                  {customer.outstanding_minor >= 100 &&
                  otherStoresMinor >= 100 ? (
                    <Text
                      style={[
                        styles.splitNote,
                        {color: c.textFaint},
                      ]}>
                      الإجمالي الشامل لدى التاجر (كل النقاط + التطبيق):{' '}
                      {formatMoney(customer.outstanding_minor / 100)} —
                      للتسوية الشاملة فقط، لا لدفاتر النقطة
                    </Text>
                  ) : null}
                  {customer.last_payment_at ? (
                    <Text style={styles.splitNote}>
                      آخر سداد:{' '}
                      {formatDateTime(
                        customer.last_payment_at.replace('T', ' ').slice(0, 19),
                      )}
                      {customer.last_payment_amount_minor != null
                        ? ` — ${formatMoney(
                            customer.last_payment_amount_minor / 100,
                          )}`
                        : ''}
                    </Text>
                  ) : null}
                </View>
              ) : customer.pos_outstanding_minor > 0 ? (
                <View style={styles.splitBox}>
                  <Icon name="info" size={13} color={c.info} />
                  <Text style={[styles.splitNote, {color: c.textDim}]}>
                    لا دين لمتجرك على هذا الزبون — لكن أرصدة صِلة تجمع{' '}
                    {formatMoney(customer.pos_outstanding_minor / 100)} ديون
                    فواتير من متاجر التاجر الأخرى (ليست من هذا المتجر)
                  </Text>
                </View>
              ) : (
                <View style={styles.settledRow}>
                  <Icon name="checkCircle" size={14} color={c.success} />
                  <Text style={styles.settledText}>
                    لا دين لمتجرك على هذا الزبون
                  </Text>
                </View>
              )}

              {/* v15 (§2.3): record a cashier repayment — v21
                  (round-27 #5): prominent by design. v24 (round-31
                  #2): STORE debt only. v32 (round-40 #6): السقف
                  والظهور من دفاتر المتجر المحلية — ديون هذا المتجر
                  فقط، لا فواتير متاجر التاجر الأخرى. */}
              {ownMinor > 0 ? (
                <AppButton
                  title="تسجيل سداد نقدي"
                  icon="wallet"
                  variant="primary"
                  onPress={() => openPaySheet(customer)}
                  style={{marginTop: spacing.sm}}
                />
              ) : null}
            </Card>
            );
          })}
          {filteredCustomers.length > customersShown ? (
            <AppButton
              title={`عرض المزيد (${
                filteredCustomers.length - customersShown
              } متبقية)`}
              variant="secondary"
              small
              onPress={() => setCustomersShown(shown => shown + PAGE_SIZE)}
            />
          ) : null}
        </>
      )}
    </>
  );

  const renderPayments = () => (
    <>
      <SectionTitle
        title="سدادّات استلمها الكاشير"
        hint="كل سداد نقدي استُلم عند الكاشير ويُرفع لصِلة تلقائياً"
      />
      {payments.length === 0 ? (
        <Card style={styles.emptyCard}>
          <Text style={styles.emptyText}>
            لا توجد سدادّات بعد — عند استلام مبلغ من زبون مدين اضغط «تسجيل سداد
            نقدي» في بطاقته من تبويب الزبائن.
          </Text>
        </Card>
      ) : (
        <>
          {payments.slice(0, paymentsShown).map(row => (
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
                  <Text style={styles.queueErrorText}>{row.error_message}</Text>
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
          ))}
          {payments.length > paymentsShown ? (
            <AppButton
              title={`عرض المزيد (${payments.length - paymentsShown} متبقية)`}
              variant="secondary"
              small
              onPress={() => setPaymentsShown(shown => shown + PAGE_SIZE)}
            />
          ) : null}
        </>
      )}

      <SectionTitle
        title="تحصيلات عبر تطبيق صِلة"
        hint="سددها الزبون من تطبيقه على ديون فواتير متجرك — تُكتشف عند المزامنة"
      />
      {appCollections.length === 0 ? (
        <Card style={styles.emptyCard}>
          <Text style={styles.emptyText}>
            لا توجد تحصيلات بعد — عندما يسدد زبون دينه من تطبيق صِلة ستظهر هنا
            وتُحسب في الخزينة تلقائياً.
          </Text>
        </Card>
      ) : (
        <>
          {appCollections.slice(0, collectionsShown).map(row => (
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
                    {formatMoney(row.amount_minor / 100)} · رُصد{' '}
                    {formatDateTime(
                      row.detected_at.replace('T', ' ').slice(0, 19),
                    )}
                  </Text>
                </View>
                <Badge label="استُلم عبر صِلة" tone="success" />
              </View>
              <View style={styles.collActionsRow}>
                <Text style={styles.collNote}>
                  سدّد الزبون هذا المبلغ من تطبيق صِلة على ديون فواتير متجرك —
                  صِلة تسلّمك قيمته ضمن تحويلاتها.
                </Text>
                <TouchableOpacity
                  style={styles.collDeleteBtn}
                  onPress={() => removeCollection(row)}
                  activeOpacity={0.8}>
                  <Icon name="trash" size={13} color={c.danger} />
                  <Text style={styles.collDeleteText}>حذف</Text>
                </TouchableOpacity>
              </View>
            </Card>
          ))}
          {appCollections.length > collectionsShown ? (
            <AppButton
              title={`عرض المزيد (${
                appCollections.length - collectionsShown
              } متبقية)`}
              variant="secondary"
              small
              onPress={() => setCollectionsShown(shown => shown + PAGE_SIZE)}
            />
          ) : null}
        </>
      )}
    </>
  );

  return (
    <Screen>
      <AppHeader title="دفتر صِلة" showBack showBell={false} />
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
          /* ── PAIRED: the tabbed debt dashboard (v19) ── */
          <>
            {/* Store identity card (compact) */}
            <Card style={styles.identityCard}>
              <View style={styles.identityRow}>
                <View style={styles.identityIcon}>
                  <Icon name="store" size={20} color={c.accent} />
                </View>
                <View style={{flex: 1}}>
                  <Text style={styles.identityName} numberOfLines={1}>
                    {pairing.merchantName}
                  </Text>
                  <Text style={styles.identityMeta}>
                    مرتبط منذ {formatDate(pairing.pairedAt.slice(0, 10))}
                    {syncState === 'device_invalid' ? ' · الربط منتهٍ' : ''}
                  </Text>
                </View>
                <Badge
                  label={syncState === 'device_invalid' ? 'منتهٍ' : 'مرتبط'}
                  tone={syncState === 'device_invalid' ? 'danger' : 'success'}
                />
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

            <Segmented value={tab} onChange={setTab} options={TAB_OPTIONS} />

            {tab === 'overview' ? (
              renderOverview()
            ) : tab === 'debts' ? (
              renderDebts()
            ) : tab === 'customers' ? (
              renderCustomers()
            ) : tab === 'vouchers' ? (
              <VouchersTab
                receiptSettings={{
                  storeName: settings.storeName,
                  storePhone: settings.storePhone,
                  footerMessage: settings.footerMessage,
                  storeLogoPath: settings.storeLogoPath,
                  paperWidth: settings.paperWidth,
                  codepage: settings.codepage,
                  showProfit: settings.showProfitOnReceipt,
                }}
                printerConnected={printerStatus === 'connected'}
                onOpenParcelRedeem={() => setParcelSheetOpen(true)}
                refreshKey={parcelRefresh}
              />
            ) : (
              renderPayments()
            )}
          </>
        )}

        {/* v15 (round-21 #3) + v19 (round-25 #4) + v21 (round-27 #5):
            repayment sheet — INLINE absolute overlay (NEVER a Modal
            on this ROM). v21: moved OUT of the ScrollView — an
            absolute overlay inside the scroll content sticks to the
            PAGE (the merchant's «النافذة معلقة في الصفحة» complaint);
            at the Screen level it always covers the visible screen.
            STRICT validation + overpayment confirmation. */}
      </ScrollView>
      {parcelSheetOpen ? (
        /* v24 (round-31 #4c/#5): the PARCELS-only redemption sheet —
            hoisted to the Screen level (an absolute overlay inside
            the VouchersTab's ScrollView sticks to the page bottom).
            mode='parcel': purchase coupons are rejected here and
            belong to the POS cart only. */
        <VoucherRedeemSheet
          visible={parcelSheetOpen}
          mode="parcel"
          onClose={() => {
            setParcelSheetOpen(false);
            setParcelRefresh(key => key + 1);
          }}
          cart={null}
          receiptSettings={{
            storeName: settings.storeName,
            storePhone: settings.storePhone,
            footerMessage: settings.footerMessage,
            storeLogoPath: settings.storeLogoPath,
            paperWidth: settings.paperWidth,
            codepage: settings.codepage,
            showProfit: settings.showProfitOnReceipt,
          }}
          printerConnected={printerStatus === 'connected'}
        />
      ) : null}
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
                {/* v32 (round-40 #6): السقف من دفاتر المتجر المحلية. */}
                <Text style={styles.payCustomerMeta}>
                  دين متجرك:{' '}
                  {formatMoney(
                    (ownByCustomer.get(paySheet.customer_id) ?? 0) / 100,
                  )}
                  <Text style={[styles.payCustomerMeta, {color: c.textFaint}]}>
                    {'  '}— فواتير هذا المتجر فقط
                  </Text>
                </Text>
              </View>
            </View>

            <Text style={styles.payLabel}>المبلغ المستلم (₪)</Text>
            <TextInput
              style={styles.payInput}
              value={payAmountText}
              onChangeText={text =>
                setPayAmountText(text.replace(/[^\d.,]/g, ''))
              }
              placeholder="0.00"
              placeholderTextColor={c.textFaint}
              keyboardType="decimal-pad"
              autoCorrect={false}
            />
            {(ownByCustomer.get(paySheet.customer_id) ?? 0) > 0 ? (
              <TouchableOpacity
                style={styles.payQuickBtn}
                onPress={() =>
                  setPayAmountText(
                    ((ownByCustomer.get(paySheet.customer_id) ?? 0) / 100)
                      .toFixed(2)
                      .replace(/\.00$/, ''),
                  )
                }
                activeOpacity={0.8}>
                <Text style={styles.payQuickText}>
                  السداد الكامل لدين المتجر (
                  {formatMoney(
                    (ownByCustomer.get(paySheet.customer_id) ?? 0) / 100,
                  )})
                </Text>
              </TouchableOpacity>
            ) : null}
            <Text style={styles.payHint}>
              قيود صارمة: مبلغ أكبر من صفر، أرقام فقط بفاصلة عشرية واحدة (مثال
              12.50)، ولا يُقبل مبلغ أكبر من دين فواتير متجرك — السداد من المتجر
              يطفئ ديون متجرك فقط، وديون تطبيق صِلة الأخرى تُسدّد من التطبيق
              نفسه. السداد يطفئ أقدم دين أولاً (FIFO) بنفس قاعدة صِلة.
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
                onPress={confirmPayment}
                style={{flex: 1.6}}
              />
            </View>
          </View>
        </View>
      ) : null}
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
    identityCard: {gap: spacing.sm},
    identityRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
    },
    identityIcon: {
      width: 42,
      height: 42,
      borderRadius: 13,
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
    // ── overview KPIs ──
    kpiGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.sm,
    },
    kpiCell: {
      width: '48.5%',
      flexGrow: 1,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: radius.md,
      padding: spacing.md,
      alignItems: 'center',
      gap: 3,
    },
    kpiValue: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: typography.body + 1,
      fontVariant: ['tabular-nums'],
    },
    kpiLabel: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      textAlign: 'center',
    },
    infoCard: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.sm,
      backgroundColor: c.surface,
    },
    /** v22 (round-28 #3): the campaigns OVERVIEW card — what the
     *  activated campaigns added to the standing debt and to the
     *  treasury, in one glance. */
    campaignsCard: {
      gap: spacing.sm,
    },
    campaignsHeadRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    campaignsIcon: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: c.accentSofter,
      alignItems: 'center',
      justifyContent: 'center',
    },
    campaignsLabel: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    campaignsMeta: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro,
      marginTop: 2,
    },
    campaignsStatGrid: {
      flexDirection: 'row',
      alignItems: 'stretch',
      gap: spacing.sm,
    },
    campaignsStatCell: {
      flex: 1,
      backgroundColor: 'rgba(255,255,255,0.03)',
      borderRadius: radius.sm,
      padding: spacing.sm,
      alignItems: 'center',
      gap: 4,
    },
    campaignsStatDivider: {
      width: 1,
      backgroundColor: c.border,
    },
    campaignsStatValue: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: typography.body + 2,
    },
    campaignsStatLabel: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.micro,
      textAlign: 'center',
      lineHeight: 14,
    },
    campaignsFootNote: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro,
      lineHeight: 15,
    },
    infoText: {
      flex: 1,
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      lineHeight: 19,
    },
    guideCard: {gap: 6},
    guideTitle: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    guideLine: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 2,
      lineHeight: 19,
    },
    // ── debts tab ──
    searchBox: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: radius.md,
      color: c.text,
      fontFamily: fonts.regular,
      fontSize: 14,
      paddingHorizontal: spacing.md,
      paddingVertical: 10,
    },
    filterRow: {
      flexDirection: 'row',
      gap: spacing.xs,
    },
    filterChip: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.sm + 2,
      paddingHorizontal: spacing.sm + 2,
      paddingVertical: 5,
      backgroundColor: c.surface,
    },
    filterText: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: 12,
    },
    resultCount: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
    },
    // ── queue rows ──
    queueCard: {gap: spacing.sm},
    queueRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
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
    // ── collections rows ──
    collActionsRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    collNote: {
      flex: 1,
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      lineHeight: 16,
    },
    collDeleteBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingVertical: 4,
      paddingHorizontal: 8,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: c.dangerSoft,
    },
    collDeleteText: {
      color: c.danger,
      fontFamily: fonts.bold,
      fontSize: typography.micro + 1,
    },
    // ── customers ──
    /** v24 (round-31 #2): the customers page's scope charter. */
    customersScopeNote: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro,
      lineHeight: 15,
      marginTop: -spacing.xs,
    },
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
    emptyText: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      lineHeight: 20,
      textAlign: 'center',
    },
    // ── origin split + repayment sheet ──
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
