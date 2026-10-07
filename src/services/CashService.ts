/**
 * CashService — v25 (round-32 #3) the treasury movements facade.
 * ─────────────────────────────────────────────────────────────────
 * نظام المصروفات والسحب من الخزينة، مبني على دراسة آلية الأنظمة
 * العالمية (Loyverse Cash Drawer / Square Cash Management /
 * Lightspeed Register):
 *
 *  1. كل شيكل يخرج من الدرج خارج البيع = حركة موثقة برقم سند خاص
 *     (EXP/WD/DEP)، بفئة وسبب ووقت — لا حذف ولا تعديل أبداً
 *     (مسار تدقيق كامل؛ التصحيح بحركة معاكسة).
 *  2. المصروف يخصم من «النقد المتوقع بالخزينة» فوراً، والسحب
 *     كذلك، والإيداع يرجع — المعادلة تبقى متوازنة دائماً.
 *  3. سحب الرصيد مؤمَّن: البصمة أولاً إن كانت مفعّلة (الأولوية
 *     للبصمة — طلب التاجر نصاً)، وإلا رمز PIN إن كان مضبوطاً،
 *     وإلا يُسجَّل «بدون تأمين» مع تحذير واضح — وطريقة التأمين
 *     تُكتب في السند نفسه.
 *  4. لا سحب ولا مصروف يتجاوز ما في الخزينة فعلياً — سقف صارم
 *     يمنع أي «فقدان» أو سالب مفبرك في الدفاتر.
 *  5. كل حركة تُطبع سندها الحراري فوراً (إن كانت طابعة متصلة)،
 *     والفترة كلها تُصدَّر كشف PDF مؤرشف + طباعة نظام.
 */
import {CashRepo} from '../database/repositories/CashRepo';
import {ReportService} from './ReportService';
import {useAppLockStore} from '../stores/appLockStore';
import {useToastStore} from '../stores/toastStore';
import {
  biometricAuthenticate,
  requirePlatformUtils,
} from '../native/nativeBridge';
import {buildCashMovementJob, buildCashStatementJob} from './printer/cashReceipt';
import {ThermalPrinterService} from './printer/ThermalPrinterService';
import {useSettingsStore} from '../stores/settingsStore';
import {usePrinterStore} from '../stores/printerStore';
import {logDiag} from '../core/diagnostics';
import {formatDateTime, localToday} from '../core/format';
import type {
  CashAuthMethod,
  CashMovementKind,
  CashMovementRecord,
  CashMovementTotals,
} from '../core/types';
import type {ReceiptSettings} from './printer/receipt';

/** The built-in expense categories (Loyverse's expense-category
 *  pattern, grocery-tuned for the Palestinian market). */
export const EXPENSE_CATEGORIES: string[] = [
  'شراء بضاعة',
  'رواتب وأجور',
  'إيجار',
  'كهرباء',
  'مياه',
  'اتصالات وإنترنت',
  'نقل وشحن',
  'ضيافة',
  'صيانة وإصلاح',
  'نظافة',
  'تسويق ودعاية',
  'متفرقات',
];

/** v25 (round-32 #3) → v27 (round-35 #3): which security method
 *  guards ALL THREE treasury movements (deposit, withdrawal,
 *  expense) on THIS device — the fingerprint has the explicit
 *  priority (the merchant's words: «الأولوية للبصمة»), the PIN is
 *  the fallback, and 'none' means nothing is configured yet. The
 *  sheet then shows a prominent alert telling the merchant to
 *  enable protection from the security settings (the operation
 *  stays possible, recorded «بدون تأمين»). */
export function movementSecurityMode(): 'biometric' | 'pin' | 'none' {
  const lock = useAppLockStore.getState();
  if (lock.biometricEnabled) {
    return 'biometric';
  }
  if (lock.pinHash != null) {
    return 'pin';
  }
  return 'none';
}

/** v25 legacy alias — the withdrawal gate was the first (and until
 *  v27 the only) secured movement. */
export const withdrawalSecurityMode = movementSecurityMode;

/** v27 (round-35 #3): ONE biometric prompt for the treasury movement
 *  being made — resolves true only on a verified fingerprint.
 *  Cancel/lockout is false (the sheet then offers the PIN pad when a
 *  PIN exists). */
export async function authorizeWithBiometric(
  title = 'تأكيد عملية الخزينة',
  subtitle = 'أكّد هويتك بالبصمة لإتمام العملية',
  cancelLabel = 'إلغاء العملية',
): Promise<boolean> {
  return biometricAuthenticate(title, subtitle, cancelLabel);
}

/** Verifies a typed 4-digit PIN against the stored salted hash. */
export function verifyWithdrawalPin(pin: string): boolean {
  return useAppLockStore.getState().verifyPin(pin);
}

/** Resolves the receipt settings snapshot from the settings store. */
function receiptSettings(): ReceiptSettings {
  const s = useSettingsStore.getState().settings;
  return {
    storeName: s.storeName,
    storePhone: s.storePhone,
    footerMessage: s.footerMessage,
    storeLogoPath: s.storeLogoPath,
    paperWidth: s.paperWidth,
    codepage: s.codepage,
    showProfit: false,
  };
}

/** Prints the movement's slip — a print failure NEVER rolls the
 *  movement back (the same discipline as sales/returns). */
async function printMovementSlip(
  movement: CashMovementRecord,
): Promise<void> {
  const status = usePrinterStore.getState().status;
  if (status !== 'connected') {
    return;
  }
  try {
    const treasury = await ReportService.treasurySnapshot();
    const job = buildCashMovementJob(
      {movement, drawerAfterMinor: Math.round(treasury.cashTotal * 100)},
      receiptSettings(),
    );
    await ThermalPrinterService.printJob(job);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logDiag('cash', `فشلت طباعة سند ${movement.ref}: ${message}`, 'warn');
    useToastStore
      .getState()
      .show(`سُجّلت الحركة لكن طباعة السند فشلت: ${message}`, 'error');
  }
}

export const CashService = {
  /** Records a business EXPENSE paid from the drawer. v27: the
   *  caller's passed security gate lands in the audit trail. */
  async recordExpense(input: {
    category: string;
    note?: string | null;
    amountMinor: number;
    authMethod?: CashAuthMethod;
  }): Promise<CashMovementRecord> {
    const treasury = await ReportService.treasurySnapshot();
    if (input.amountMinor > Math.round(treasury.cashTotal * 100)) {
      throw new Error(
        `المبلغ أكبر من النقد الموجود بالخزينة (${treasury.cashTotal.toFixed(
          2,
        )} ₪) — لا يمكن تسجيل مصروف بأكثر من الموجود`,
      );
    }
    const movement = await CashRepo.add({
      kind: 'expense',
      category: input.category,
      note: input.note,
      amountMinor: input.amountMinor,
      authMethod: input.authMethod ?? 'none',
    });
    await printMovementSlip(movement);
    return movement;
  },

  /** Records the OWNER's cash WITHDRAWAL — only after the caller
   *  passed the security gate (the auth method is written into the
   *  row so the audit trail matches the prompt that approved it). */
  async recordWithdrawal(input: {
    note?: string | null;
    amountMinor: number;
    authMethod: CashAuthMethod;
  }): Promise<CashMovementRecord> {
    const treasury = await ReportService.treasurySnapshot();
    const drawerMinor = Math.round(treasury.cashTotal * 100);
    if (input.amountMinor > drawerMinor) {
      throw new Error(
        `لا يمكن سحب أكثر من النقد الموجود بالخزينة (${(
          drawerMinor / 100
        ).toFixed(2)} ₪) — راجع المبلغ أو أودع نقداً أولاً`,
      );
    }
    const movement = await CashRepo.add({
      kind: 'withdrawal',
      category: 'سحب رصيد',
      note: input.note,
      amountMinor: input.amountMinor,
      authMethod: input.authMethod,
    });
    await printMovementSlip(movement);
    return movement;
  },

  /** Records cash put BACK into the drawer (تغذية خزينة). v27: the
   *  caller's passed security gate lands in the audit trail. */
  async recordDeposit(input: {
    note?: string | null;
    amountMinor: number;
    authMethod?: CashAuthMethod;
  }): Promise<CashMovementRecord> {
    const movement = await CashRepo.add({
      kind: 'deposit',
      category: 'إيداع نقدي',
      note: input.note,
      amountMinor: input.amountMinor,
      authMethod: input.authMethod ?? 'none',
    });
    await printMovementSlip(movement);
    return movement;
  },

  /** The period statement bundle (list + totals + categories).
   *  v26 (round-34 #5): `full: true` lifts the row cap to 10,000 for
   *  the ARCHIVAL exports (PDF A4 / thermal) — a statement document
   *  must carry every voucher of the period; the on-screen ledger
   *  keeps the paged 500 cap. */
  async statement(
    from: string,
    to: string,
    opts?: {full?: boolean},
  ): Promise<{
    rows: CashMovementRecord[];
    totals: CashMovementTotals;
    categories: {category: string; count: number; totalMinor: number}[];
  }> {
    const [rows, totals, categories] = await Promise.all([
      CashRepo.list({
        from,
        to,
        kind: 'all',
        limit: opts?.full ? 10000 : 500,
      }),
      CashRepo.totalsFor(from, to),
      CashRepo.categoryTotals(from, to),
    ]);
    return {rows, totals, categories};
  },

  /** The expected drawer cash AFTER every recorded movement — the
   *  hard ceiling every withdrawal/expense is checked against. */
  async drawerNowMinor(): Promise<number> {
    const treasury = await ReportService.treasurySnapshot();
    return Math.round(treasury.cashTotal * 100);
  },

  /** v25 (round-32 #3): builds the A4 PDF statement for the period
   *  and saves it into Downloads/SmartVisionPOS — the archival copy
   *  (the merchant's «كشف pdf كامل خاص السحب والمصروفات»). */
  async exportStatementPdf(from: string, to: string): Promise<string> {
    const data = await this.statement(from, to, {full: true});
    const treasury = await ReportService.treasurySnapshot();
    const settings = useSettingsStore.getState().settings;
    const shekels = (minor: number) => `${(minor / 100).toFixed(2)} ₪`;
    const payload = {
      storeName: settings.storeName || 'sela',
      title: 'كشف المصروفات والسحوبات من الخزينة',
      periodLabel: `${from} إلى ${to}`,
      generatedAt: formatDateTime(localToday()),
      summary: [
        {label: 'المصروفات', value: shekels(data.totals.expensesMinor)},
        {
          label: 'عدد المصروفات',
          value: `${data.totals.expensesCount}`,
        },
        {label: 'المسحوبات', value: shekels(data.totals.withdrawalsMinor)},
        {
          label: 'عدد المسحوبات',
          value: `${data.totals.withdrawalsCount}`,
        },
        {label: 'الإيداعات', value: shekels(data.totals.depositsMinor)},
        {
          label: 'صافي الحركة',
          value: shekels(data.totals.netMinor),
        },
        {
          label: 'النقد المتوقع بالخزينة الآن',
          value: shekels(Math.round(treasury.cashTotal * 100)),
        },
      ],
      categories: data.categories.map(cat => ({
        name: cat.category,
        count: `${cat.count}`,
        total: shekels(cat.totalMinor),
      })),
      rows: data.rows.map(row => ({
        ref: row.ref,
        kind:
          row.kind === 'withdrawal'
            ? 'سحب رصيد'
            : row.kind === 'deposit'
            ? 'إيداع'
            : 'مصروف',
        category: row.category,
        note: row.note ?? '',
        amount: `${row.kind === 'deposit' ? '+' : '-'}${shekels(
          row.amount_minor,
        )}`,
        date: row.created_at,
      })),
      footer: 'سجل حركات الخزينة — وثيقة محاسبية غير قابلة للتعديل',
    };
    const fileName = `sela-cash-statement-${from}-to-${to}.pdf`;
    const platform = requirePlatformUtils();
    const location = await platform.createStatementPdf(
      fileName,
      JSON.stringify(payload),
    );
    logDiag('cash', `أُنشئ كشف PDF للمصروفات والسحوبات (${from} → ${to})`);
    return location;
  },

  /** Opens the system share sheet for the exported statement PDF
   *  (WhatsApp / email / any PDF printer app). */
  async shareStatementPdf(from: string, to: string): Promise<void> {
    const fileName = `sela-cash-statement-${from}-to-${to}.pdf`;
    await requirePlatformUtils().shareExportedPdf(
      fileName,
      'كشف المصروفات والسحوبات',
    );
  },

  /** Prints the exported statement via Android's system print
   *  framework (cloud / Wi-Fi / USB printers). */
  async printStatementPdf(from: string, to: string): Promise<void> {
    const fileName = `sela-cash-statement-${from}-to-${to}.pdf`;
    await requirePlatformUtils().printExportedPdf(
      fileName,
      `كشف الخزينة ${from} → ${to}`,
    );
  },

  /** Prints the period statement on the THERMAL printer — the
   *  merchant's pocket audit trail (fast, no PDF needed). */
  async printStatementThermal(from: string, to: string): Promise<void> {
    const status = usePrinterStore.getState().status;
    if (status !== 'connected') {
      throw new Error('لا توجد طابعة متصلة — أوصل الطابعة أولاً');
    }
    const data = await this.statement(from, to, {full: true});
    const treasury = await ReportService.treasurySnapshot();
    const job = buildCashStatementJob(
      {
        periodLabel: `${from} → ${to}`,
        rows: data.rows,
        expensesMinor: data.totals.expensesMinor,
        withdrawalsMinor: data.totals.withdrawalsMinor,
        depositsMinor: data.totals.depositsMinor,
        netMinor: data.totals.netMinor,
        drawerNowMinor: Math.round(treasury.cashTotal * 100),
      },
      receiptSettings(),
    );
    await ThermalPrinterService.printJob(job);
  },
};

export type {CashMovementKind};
