/**
 * MerchantsPdfService — v80 (الجولة 93 #٢): كشوف حسابات التجار PDF.
 * ─────────────────────────────────────────────────────────────────
 * طلب التاجر نصاً: «تقارير التجار او التاجر نفسه اريده تقرير pdf
 * قابل للطباعة وليس تقرير اكسل او csv لغيهما» — أُلغيت صيغتا
 * Excel/CSV من كشف التاجر ودفتر التجار كلياً وحلّ محلهما PDF
 * احترافي بنفس محرّك تقارير الديون المجرب (A4 RTL + Tajawal):
 *
 *  1. كشف حساب تاجر واحد — كل الحركات بالرصيد الجاري بعد كل
 *     حركة (الأقدم أولاً كما في الدفاتر المحاسبية) + صف الإجماليات.
 *  2. دفتر التجار كاملاً — سطر لكل تاجر برصيده وتفكيكه.
 *
 * كلاهما يُحفظ في Downloads/SmartVisionPOS ويُشارك ويُطبع عبر
 * طباعة النظام (قابل للطباعة على أي طابعة A4).
 */
import {MerchantRepo} from '../database/repositories/MerchantRepo';
import {useSettingsStore} from '../stores/settingsStore';
import {formatDateTime, localToday} from '../core/format';
import {logDiag} from '../core/diagnostics';
import {paymentMethodLabel} from '../core/paymentMethods';
import {requirePlatformUtils} from '../native/nativeBridge';

/** خلية جدول واحدة: نص + لون اختياري (debt أحمر / pay أخضر) + ثقل. */
interface Cell {
  t: string;
  tone?: 'debt' | 'pay';
  bold?: boolean;
}

const shekels = (v: number) => `${v.toFixed(2)} ₪`;

const BOOK_FILE = () =>
  `sela-merchants-book-${new Date().toISOString().slice(0, 10)}.pdf`;

const MERCHANT_FILE = (name: string) => {
  const stamp = new Date().toISOString().slice(0, 10);
  const safe = name.replace(/\s+/g, '_').replace(/[^\w\u0600-\u06FF.-]/g, '');
  return `sela-merchant-statement-${safe || 'account'}-${stamp}.pdf`;
};

/** تاريخ قصير للجدول: YYYY-MM-DD HH:MM بلا ثوانٍ. */
function shortWhen(iso: string): string {
  return iso.replace('T', ' ').slice(0, 16);
}

const KIND_LABELS: Record<string, string> = {
  invoice: 'فاتورة توريد',
  payment: 'سداد له',
  return: 'مرتجع/خصم',
  collection: 'تحصيل منه',
  debt: 'دين مستحق مباشر',
};

export const MerchantsPdfService = {
  /** كشف حساب تاجر واحد PDF → الموقع. */
  async exportStatementPdf(merchantId: number): Promise<string> {
    const merchant = await MerchantRepo.byId(merchantId);
    if (merchant == null) {
      throw new Error('حساب التاجر غير موجود');
    }
    // الكشف يُبنى تصاعدياً (الأقدم أولاً) — كما في الدفاتر المحاسبية
    // (المستودع يعيد الأحدث أولاً — نعكسه).
    const statement = (
      await MerchantRepo.statement(merchantId, 2000)
    )
      .slice()
      .reverse();
    if (statement.length === 0) {
      throw new Error('لا حركات في كشف حساب هذا التاجر بعد');
    }
    const settings = useSettingsStore.getState().settings;

    const positives = statement.filter(
      row => row.movement.kind === 'invoice' || row.movement.kind === 'debt',
    );
    const negatives = statement.filter(
      row => row.movement.kind !== 'invoice' && row.movement.kind !== 'debt',
    );
    const balance = statement[statement.length - 1]?.runningBalance ?? 0;

    const columns = [
      {label: 'التاريخ', w: 1.6},
      {label: 'البيان', w: 2.7},
      {label: 'المرجع', w: 1.3},
      {label: 'عليه + (₪)', w: 1.1},
      {label: 'له − (₪)', w: 1.1},
      {label: 'الرصيد بعد', w: 1.3},
    ];
    let running = 0;
    const rows = statement.map(row => {
      const positive =
        row.movement.kind === 'invoice' || row.movement.kind === 'debt';
      if (positive) {
        running += row.movement.amount;
      } else {
        running -= row.movement.amount;
      }
      const itemsText =
        row.movement.items
          ?.map(item => `${item.name} ×${item.qty}`)
          .join(' · ') ?? '';
      const label = [
        KIND_LABELS[row.movement.kind] ?? row.movement.kind,
        row.movement.method != null && row.movement.method !== 'cash'
          ? `(${paymentMethodLabel(row.movement.method)})`
          : '',
        row.movement.note?.trim() ?? '',
        itemsText,
      ]
        .filter(Boolean)
        .join(' — ');
      const cells: Cell[] = [
        {t: shortWhen(row.movement.createdAt)},
        {t: label},
        {t: row.movement.ref},
        positive
          ? {
              t: `+${shekels(row.movement.amount)}`,
              tone: 'debt',
              bold: true,
            }
          : {t: ''},
        positive
          ? {t: ''}
          : {
              t: `−${shekels(row.movement.amount)}`,
              tone: 'pay',
              bold: true,
            },
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
      title: 'كشف حساب تاجر',
      scopeLabel: merchant.name,
      subtitle:
        (merchant.phone ? `جوال ${merchant.phone}` : '') +
        (merchant.id_number ? `${merchant.phone ? ' · ' : ''}هوية ${merchant.id_number}` : ''),
      generatedAt: formatDateTime(localToday()),
      summary: [
        {
          label: balance > 0.005 ? 'المستحق له الآن (علينا)' : 'الحساب مسدد/لك عنده',
          value:
            balance > 0.005
              ? shekels(balance)
              : balance < -0.005
              ? `رصيد دائن ${shekels(Math.abs(balance))}`
              : shekels(0),
        },
        {label: 'عدد الحركات', value: `${statement.length}`},
        {label: 'إجمالي عليه (توريد + ديون)', value: shekels(positives.reduce((s, r) => s + r.movement.amount, 0))},
        {label: 'إجمالي له (سداد + مرتجع + تحصيل)', value: shekels(negatives.reduce((s, r) => s + r.movement.amount, 0))},
      ],
      columns,
      rows,
      totalRow: {
        cells: [
          {t: 'الإجماليات', bold: true},
          {t: ''},
          {t: ''},
          {t: shekels(positives.reduce((s, r) => s + r.movement.amount, 0)), bold: true},
          {t: shekels(negatives.reduce((s, r) => s + r.movement.amount, 0)), bold: true},
          {t: shekels(balance), bold: true},
        ],
      },
      footer: `كشف حساب التاجر ${merchant.name} — وثيقة محاسبية من دفتر التجار (${statement.length} حركة)`,
    };

    const location = await requirePlatformUtils().createDebtsReportPdf(
      MERCHANT_FILE(merchant.name),
      JSON.stringify(payload),
    );
    logDiag(
      'merchants',
      `أُنشئ كشف حساب PDF للتاجر ${merchant.name} (${statement.length} حركة)`,
    );
    return location;
  },

  /** مشاركة كشف التاجر (واتساب / إيميل / طابعات PDF). */
  async shareStatementPdf(merchantId: number): Promise<void> {
    const merchant = await MerchantRepo.byId(merchantId);
    await requirePlatformUtils().shareExportedPdf(
      MERCHANT_FILE(merchant?.name ?? ''),
      `كشف حساب التاجر ${merchant?.name ?? ''}`,
    );
  },

  /** طباعة كشف التاجر عبر طباعة النظام (A4). */
  async printStatementPdf(merchantId: number): Promise<void> {
    const merchant = await MerchantRepo.byId(merchantId);
    await requirePlatformUtils().printExportedPdf(
      MERCHANT_FILE(merchant?.name ?? ''),
      `كشف حساب التاجر ${merchant?.name ?? ''}`,
    );
  },

  /** دفتر التجار كاملاً PDF → الموقع. */
  async exportBookPdf(): Promise<string> {
    const list = await MerchantRepo.listWithBalances();
    if (list.length === 0) {
      throw new Error('لا تجار مسجلون بعد');
    }
    const settings = useSettingsStore.getState().settings;

    const owedNow = list.reduce((s, e) => s + Math.max(0, e.balance), 0);
    const creditNow = list.reduce((s, e) => s + Math.max(0, -e.balance), 0);

    const columns = [
      {label: 'التاجر', w: 2.6},
      {label: 'الجوال', w: 1.5},
      {label: 'توريد', w: 1.1},
      {label: 'دين مباشر', w: 1.1},
      {label: 'سداد', w: 1.1},
      {label: 'مرتجع/خصم', w: 1.1},
      {label: 'تحصيل', w: 1.1},
      {label: 'الرصيد الآن', w: 1.4},
    ];
    const rows = list.map(entry => {
      const tone =
        entry.balance > 0.005
          ? ('debt' as const)
          : entry.balance < -0.005
          ? ('pay' as const)
          : undefined;
      const cells: Cell[] = [
        {t: entry.merchant.name},
        {t: entry.merchant.phone ?? '—'},
        {t: shekels(entry.invoiceTotal)},
        {t: shekels(entry.debtTotal)},
        {t: shekels(entry.paymentTotal)},
        {t: shekels(entry.returnTotal)},
        {t: shekels(entry.collectionTotal)},
        {
          t:
            entry.balance < -0.005
              ? `رصيد دائن ${shekels(Math.abs(entry.balance))}`
              : shekels(entry.balance),
          tone,
          bold: true,
        },
      ];
      return {cells};
    });

    const payload = {
      kind: 'book',
      storeName: settings.storeName || 'متجر سيلا',
      title: 'دفتر حسابات التجار',
      scopeLabel: `كل التجار — ${list.length} تاجراً`,
      subtitle: 'فواتير التوريد والمستحقات — دفتر ذمم دائن',
      generatedAt: formatDateTime(localToday()),
      summary: [
        {label: 'المستحق للتجار الآن', value: shekels(owedNow)},
        {label: 'لك عند التجار (دفعات مقدمة)', value: shekels(creditNow)},
        {label: 'عدد التجار', value: `${list.length}`},
        {
          label: 'إجمالي التوريد',
          value: shekels(list.reduce((s, e) => s + e.invoiceTotal, 0)),
        },
      ],
      columns,
      rows,
      totalRow: {
        cells: [
          {t: 'الإجماليات', bold: true},
          {t: ''},
          {t: shekels(list.reduce((s, e) => s + e.invoiceTotal, 0)), bold: true},
          {t: shekels(list.reduce((s, e) => s + e.debtTotal, 0)), bold: true},
          {t: shekels(list.reduce((s, e) => s + e.paymentTotal, 0)), bold: true},
          {t: shekels(list.reduce((s, e) => s + e.returnTotal, 0)), bold: true},
          {t: shekels(list.reduce((s, e) => s + e.collectionTotal, 0)), bold: true},
          {t: shekels(list.reduce((s, e) => s + e.balance, 0)), bold: true},
        ],
      },
      footer: `دفتر حسابات التجار — وثيقة محاسبية من تطبيق sela (${list.length} تاجراً)`,
    };

    const location = await requirePlatformUtils().createDebtsReportPdf(
      BOOK_FILE(),
      JSON.stringify(payload),
    );
    logDiag('merchants', `أُنشئ دفتر التجار PDF (${list.length} تاجراً)`);
    return location;
  },

  /** مشاركة دفتر التجار. */
  async shareBookPdf(): Promise<void> {
    await requirePlatformUtils().shareExportedPdf(
      BOOK_FILE(),
      'دفتر حسابات التجار',
    );
  },

  /** طباعة دفتر التجار عبر طباعة النظام (A4). */
  async printBookPdf(): Promise<void> {
    await requirePlatformUtils().printExportedPdf(
      BOOK_FILE(),
      'دفتر حسابات التجار',
    );
  },
};
