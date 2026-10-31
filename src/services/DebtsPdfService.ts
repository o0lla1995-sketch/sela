/**
 * DebtsPdfService — v70 (الجولة 82 #٢): تقارير ديون المتجر PDF.
 * ─────────────────────────────────────────────────────────────────
 * طبقتان بطلب التاجر («زر في صفحة الدين لتحميل تقرير pdf احترافي
 * بالديون والتقرير المفصل الخاص بالديون»):
 *
 *  1. تقرير الدفتر كاملاً — كل زبائن الدفتر وأرصدتهم (إجمالي
 *     الديون / المسدَّد / القائم) بترتيب الدين القائم تنازلياً
 *     مع بطاقات ملخص وصف الإجمالي الكبير.
 *  2. كشف الحساب المفصل لزبون واحد — الديون والسدادّات بترتيب
 *     زمني صاعد مع الرصيد الجاري بعد كل عملية (وثيقة محاسبية
 *     تصلح للمطالبة القضائية).
 *
 * كلاهما يُرسم بالمحرّك الأصلي نفسه (createDebtsReportPdf —
 * A4 RTL + Tajawal) ويُحفظ في Downloads/SmartVisionPOS.
 */
import {LocalDebtsRepo} from '../database/repositories/LocalDebtsRepo';
import {useSettingsStore} from '../stores/settingsStore';
import {formatDateTime, localToday} from '../core/format';
import {logDiag} from '../core/diagnostics';
import {requirePlatformUtils} from '../native/nativeBridge';

/** خلية جدول واحدة: نص + لون اختياري (debt أحمر / pay أخضر) + ثقل. */
interface Cell {
  t: string;
  tone?: 'debt' | 'pay';
  bold?: boolean;
}

const shekels = (minor: number) => `${(minor / 100).toFixed(2)} ₪`;

const BOOK_FILE = () => {
  const stamp = new Date().toISOString().slice(0, 10);
  return `sela-debts-book-${stamp}.pdf`;
};

const CUSTOMER_FILE = (idNumber: string) => {
  const stamp = new Date().toISOString().slice(0, 10);
  const safe = idNumber.replace(/\D/g, '') || 'account';
  return `sela-debt-statement-${safe}-${stamp}.pdf`;
};

/** تاريخ قصير للجدول: YYYY-MM-DD HH:MM بلا ثوانٍ. */
function shortWhen(iso: string): string {
  return iso.replace('T', ' ').slice(0, 16);
}

export const DebtsPdfService = {
  /** يبني حمولة تقرير الدفتر كاملاً ويصدّرها PDF → الموقع. */
  async exportBookPdf(): Promise<string> {
    const balances = await LocalDebtsRepo.listWithBalances();
    const settings = useSettingsStore.getState().settings;

    const outstanding = balances.reduce((s, r) => s + r.outstandingMinor, 0);
    const collected = balances.reduce((s, r) => s + r.paidTotalMinor, 0);
    const debtTotal = balances.reduce((s, r) => s + r.debtTotalMinor, 0);
    const debtors = balances.filter(r => r.outstandingMinor > 0).length;

    const columns = [
      {label: 'الزبون', w: 3.0},
      {label: 'الهوية', w: 1.6},
      {label: 'الجوال', w: 1.6},
      {label: 'إجمالي الديون', w: 1.3},
      {label: 'المسدَّد', w: 1.3},
      {label: 'القائم', w: 1.4},
    ];
    const rows = balances.map(entry => {
      const tone =
        entry.outstandingMinor > 0
          ? ('debt' as const)
          : entry.outstandingMinor < 0
          ? ('pay' as const)
          : undefined;
      const cells: Cell[] = [
        {t: entry.customer.name},
        {t: entry.customer.id_number},
        {t: entry.customer.phone ?? '—'},
        {t: shekels(entry.debtTotalMinor)},
        {t: shekels(entry.paidTotalMinor)},
        {
          t:
            entry.outstandingMinor < 0
              ? `رصيد دائن ${shekels(Math.abs(entry.outstandingMinor))}`
              : shekels(entry.outstandingMinor),
          tone,
          bold: true,
        },
      ];
      return {cells};
    });

    const payload = {
      kind: 'book',
      storeName: settings.storeName || 'متجر سيلا',
      title: 'تقرير ديون المتجر',
      scopeLabel: `دفتر ديون المتجر — ${balances.length} حساباً`,
      subtitle: 'أرصدة القائم فقط (الديون غير المُرحَّلة إلى صِلة)',
      generatedAt: formatDateTime(localToday()),
      summary: [
        {label: 'الدين الإجمالي القائم', value: shekels(outstanding)},
        {label: `عدد المدينين`, value: `${debtors}`},
        {label: 'سدادّات مستلمة (كلي)', value: shekels(collected)},
        {label: 'إجمالي الديون المسجّلة', value: shekels(debtTotal)},
      ],
      columns,
      rows,
      totalRow: {
        cells: [
          {t: 'الإجمالي', bold: true},
          {t: ''},
          {t: ''},
          {t: shekels(debtTotal), bold: true},
          {t: shekels(collected), bold: true},
          {t: shekels(outstanding), bold: true},
        ],
      },
      footer: `أُنشئ بواسطة تطبيق sela — ${balances.length} حساباً في دفتر المتجر`,
    };

    const location = await requirePlatformUtils().createDebtsReportPdf(
      BOOK_FILE(),
      JSON.stringify(payload),
    );
    logDiag('localDebts', 'أُنشئ تقرير PDF لدفتر الديون');
    return location;
  },

  /** مشاركة تقرير الدفتر (واتساب / إيميل / أي طابعة PDF). */
  async shareBookPdf(): Promise<void> {
    await requirePlatformUtils().shareExportedPdf(
      BOOK_FILE(),
      'تقرير ديون المتجر',
    );
  },

  /** طباعة تقرير الدفتر عبر طباعة النظام (A4). */
  async printBookPdf(): Promise<void> {
    await requirePlatformUtils().printExportedPdf(
      BOOK_FILE(),
      'تقرير ديون المتجر',
    );
  },

  /** يبني كشف الحساب المفصل لزبون واحد ويصدّره PDF → الموقع. */
  async exportCustomerPdf(customerId: number): Promise<string> {
    const balances = await LocalDebtsRepo.listWithBalances();
    const entry = balances.find(row => row.customer.id === customerId);
    if (entry == null) {
      throw new Error('لم يُعثر على حساب الزبون');
    }
    const [debts, pays] = await Promise.all([
      LocalDebtsRepo.listDebts(customerId),
      LocalDebtsRepo.listPayments(customerId),
    ]);
    const settings = useSettingsStore.getState().settings;

    // عمليات مدموجة بترتيب زمني صاعد مع رصيد جاري.
    type Op = {at: string; kind: 'debt' | 'pay'};
    const ops: Op[] = [
      ...debts.map(d => ({at: d.created_at, kind: 'debt' as const})),
      ...pays.map(p => ({at: p.created_at, kind: 'pay' as const})),
    ];
    ops.sort((a, b) => a.at.localeCompare(b.at));

    const debtById = new Map(debts.map(d => [d.created_at, d]));
    const payById = new Map(pays.map(p => [p.created_at, p]));

    const columns = [
      {label: 'التاريخ', w: 1.8},
      {label: 'البيان', w: 3.4},
      {label: 'المرجع', w: 1.5},
      {label: 'دين +', w: 1.1},
      {label: 'سداد −', w: 1.1},
      {label: 'الرصيد بعد', w: 1.4},
    ];

    let running = 0;
    const rows = ops.map(op => {
      let ref = '';
      let label = '';
      let debtCell: Cell = {t: ''};
      let payCell: Cell = {t: ''};
      if (op.kind === 'debt') {
        const d = debtById.get(op.at)!;
        running += d.amount_minor;
        ref = d.invoice_ref;
        const migratedTag =
          d.migrated === 1 ? ' (مُرحّل إلى صِلة)' : '';
        label = d.description?.trim() || 'دين';
        // بيان العملية يطبع دائماً حالة الترحيل — الوثيقة
        // المحاسبية يجب أن تُظهر أين يعيش الدين الآن.
        label = `${label}${migratedTag}`;
        debtCell = {t: `+${shekels(d.amount_minor)}`, tone: 'debt', bold: true};
      } else {
        const p = payById.get(op.at)!;
        running -= p.amount_minor;
        ref = p.receipt_ref;
        label = p.note?.trim() || 'سداد';
        payCell = {t: `−${shekels(p.amount_minor)}`, tone: 'pay', bold: true};
      }
      const cells: Cell[] = [
        {t: shortWhen(op.at)},
        {t: label},
        {t: ref},
        debtCell,
        payCell,
        {
          t: shekels(running),
          bold: true,
          tone: running < 0 ? ('pay' as const) : undefined,
        },
      ];
      return {cells};
    });

    const payload = {
      kind: 'customer',
      storeName: settings.storeName || 'متجر سيلا',
      title: 'كشف حساب زبون — دفتر المتجر',
      scopeLabel: entry.customer.name,
      subtitle:
        `هوية ${entry.customer.id_number}` +
        (entry.customer.phone ? ` · جوال ${entry.customer.phone}` : '') +
        (entry.customer.sila_customer_id != null ? ' · مرتبط بصِلة' : ''),
      generatedAt: formatDateTime(localToday()),
      summary: [
        {
          label: 'الدين القائم',
          value:
            entry.outstandingMinor < 0
              ? `رصيد دائن ${shekels(Math.abs(entry.outstandingMinor))}`
              : shekels(entry.outstandingMinor),
        },
        {label: 'إجمالي الديون', value: shekels(entry.debtTotalMinor)},
        {label: 'المسدَّد', value: shekels(entry.paidTotalMinor)},
        {
          label: 'آخر نشاط',
          value: entry.lastActivityAt
            ? shortWhen(entry.lastActivityAt)
            : 'لا عمليات',
        },
      ],
      columns,
      rows,
      footer: `كشف حساب ${entry.customer.name} — وثيقة من دفتر ديون المتجر (${ops.length} عملية)`,
    };

    const location = await requirePlatformUtils().createDebtsReportPdf(
      CUSTOMER_FILE(entry.customer.id_number),
      JSON.stringify(payload),
    );
    logDiag(
      'localDebts',
      `أُنشئ كشف حساب PDF لـ ${entry.customer.name} (${ops.length} عملية)`,
    );
    return location;
  },

  /** مشاركة كشف حساب الزبون. */
  async shareCustomerPdf(customerId: number): Promise<void> {
    const balances = await LocalDebtsRepo.listWithBalances();
    const entry = balances.find(row => row.customer.id === customerId);
    const fileName = CUSTOMER_FILE(entry?.customer.id_number ?? '');
    await requirePlatformUtils().shareExportedPdf(
      fileName,
      `كشف حساب ${entry?.customer.name ?? 'الزبون'}`,
    );
  },

  /** طباعة كشف حساب الزبون عبر طباعة النظام (A4). */
  async printCustomerPdf(customerId: number): Promise<void> {
    const balances = await LocalDebtsRepo.listWithBalances();
    const entry = balances.find(row => row.customer.id === customerId);
    const fileName = CUSTOMER_FILE(entry?.customer.id_number ?? '');
    await requirePlatformUtils().printExportedPdf(
      fileName,
      `كشف حساب ${entry?.customer.name ?? 'الزبون'}`,
    );
  },
};
