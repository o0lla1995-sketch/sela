/**
 * PeriodReportPdfService — v80 (الجولة 93 #٧): تقرير الفترة الشامل
 * PDF قابل للطباعة.
 * ─────────────────────────────────────────────────────────────────
 * طلب التاجر نصاً: «لا يوجد في التقارير ما يوضح عمليات التجار بشكل
 * مختصر ويضاف الي التقارير في حال طباعتها» — وثيقة A4 عربية واحدة
 * (المحرك الأصلي createPeriodReportPdf: أقسام متعددة + جداول بأوزان
 * نسبية) تجمع في صفحات قليلة:
 *
 *   ١. ملخص المبيعات — الإيراد والربح والتكلفة والفواتير والخصومات.
 *   ٢. أرصدة طرق الدفع — نقدي + كل بنك/محفظة (فترة + رصيد الآن).
 *   ٣. النقد والديون — المحصّل النقدي بالدرج + الدين القائم.
 *   ٤. عمليات التجار بشكل مختصر — المستحق الآن + توريد/سداد/مرتجع/
 *      تحصيل بالفترة + أكبر المستحقات (طلب التاجر الأساسي).
 *   ٥. الأكثر إيراداً — أفضل ٨ أصناف بالفترة.
 */
import {ReportService, rangeFor} from './ReportService';
import {ReportRepo} from '../database/repositories/ReportRepo';
import {MerchantRepo} from '../database/repositories/MerchantRepo';
import {displayMethod} from '../core/paymentMethods';
import {useSettingsStore} from '../stores/settingsStore';
import {formatDateTime, localToday} from '../core/format';
import {logDiag} from '../core/diagnostics';
import {requirePlatformUtils} from '../native/nativeBridge';
import type {ReportRangeKey} from '../core/types';

/** خلية جدول واحدة: نص + لون اختياري (debt أحمر / pay أخضر) + ثقل. */
interface Cell {
  t: string;
  tone?: 'debt' | 'pay';
  bold?: boolean;
}

const shekels = (v: number) => `${v.toFixed(2)} ₪`;

const PERIOD_LABELS: Record<string, string> = {
  today: 'اليوم',
  yesterday: 'أمس',
  last7: 'آخر ٧ أيام',
  thisMonth: 'هذا الشهر',
  all: 'كل السجل',
  custom: 'فترة مخصصة',
};

function fileFor(key: ReportRangeKey): string {
  const stamp = new Date().toISOString().slice(0, 10);
  return `sela-period-report-${key}-${stamp}.pdf`;
}

interface Section {
  heading: string;
  summary?: {label: string; value: string}[];
  columns?: {label: string; w: number}[];
  rows?: {cells: Cell[]}[];
  note?: string;
}

export const PeriodReportPdfService = {
  /** يبني حمولة التقرير الشامل ويصدّرها PDF → الموقع. */
  async exportPeriodPdf(rangeKey: ReportRangeKey): Promise<string> {
    const range = rangeFor(rangeKey);
    const settings = useSettingsStore.getState().settings;

    const [bundle, methodsPeriod, methodsLive, merchantTotals] =
      await Promise.all([
        ReportService.loadBundle(rangeKey),
        ReportRepo.methodLedgerTotals(range),
        ReportRepo.methodLedgerTotals({from: '2000-01-01', to: '2999-12-31'}),
        MerchantRepo.totals(range.from, range.to),
      ]);

    const sections: Section[] = [];

    // ── ١. ملخص المبيعات ──
    const s = bundle.summary;
    sections.push({
      heading: 'ملخص المبيعات',
      summary: [
        {label: 'إجمالي المبيعات (صافي المرتجعات)', value: shekels(s.revenue)},
        {label: 'صافي الربح', value: shekels(s.netProfit)},
        {label: 'تكلفة البضاعة المباعة', value: shekels(s.cogs)},
        {label: 'عدد الفواتير', value: `${s.invoicesCount}`},
        {label: 'متوسط الفاتورة', value: shekels(s.avgInvoice)},
        {label: 'إجمالي الخصومات', value: shekels(s.discountTotal)},
      ],
      note:
        `المرتجعات: ${s.returnsCount} إشعاراً بقيمة ${shekels(s.returnsTotal)} — ` +
        'الإيراد والأرقام أعلاه صافية منها تلقائياً.',
    });

    // ── ٢. أرصدة طرق الدفع ──
    const methodRows: {cells: Cell[]}[] = [];
    for (const row of methodsLive) {
      const method = displayMethod(row.method);
      const period = methodsPeriod.find(p => p.method === row.method);
      methodRows.push({
        cells: [
          {t: method.label, bold: true},
          {
            t: `${period?.salesCount ?? 0} فاتورة`,
          },
          {t: shekels(period?.salesIn ?? 0)},
          {
            t: shekels(row.net),
            bold: true,
            tone: row.net < 0 ? ('debt' as const) : undefined,
          },
        ],
      });
    }
    if (methodRows.length > 0) {
      sections.push({
        heading: 'أرصدة طرق الدفع (النقدي درجٌ مستقل)',
        columns: [
          {label: 'القناة', w: 2.2},
          {label: 'فواتير بالفترة', w: 1.4},
          {label: 'مبيعات الفترة', w: 1.4},
          {label: 'الرصيد الآن', w: 1.4},
        ],
        rows: methodRows,
        note:
          'رصيد «الآن» هو دفتر القناة عبر التاريخ: مبيعات + سدادّات + ' +
          'إيداعات − مرتجعات − مسحوبات − مصروفات.',
      });
    }

    // ── ٣. النقد والديون ──
    const cash = bundle.cash;
    sections.push({
      heading: 'النقد والديون',
      summary: [
        {label: 'النقد المحصّل بالدرج بالفترة', value: shekels(cash.collected)},
        {
          label: 'صافي حركة الدرج النقدي بالفترة',
          value: shekels(cash.netCashAfterMovements),
        },
        {label: 'النقد بالخزينة الآن', value: shekels(cash.cashNowMinor / 100)},
        {
          label: 'فواتير الدين بالفترة',
          value: `${cash.creditSalesCount} فاتورة · ${shekels(cash.creditSalesAmount)}`,
        },
        {
          label: 'الدين القائم الآن (دفتر المتجر)',
          value: shekels(cash.localOutstandingMinor / 100),
        },
        {
          label: 'عبر البنوك والمحافظ بالفترة (مبيعات)',
          value: shekels(cash.nonCashSalesAmount),
        },
      ],
      note:
        'أرقام النقد أعلاه نقية من مبيعات ومقبوضات البنوك والمحافظ — ' +
        'أرصدتها في قسم القنوات أعلاه، فلا ازدواج في أي مبلغ.',
    });

    // ── ٤. عمليات التجار بشكل مختصر (طلب التاجر الأساسي) ──
    if (merchantTotals.count > 0) {
      const merchantSummary: {label: string; value: string}[] = [
        {
          label: `مستحق للتجار الآن · ${merchantTotals.count} تاجر`,
          value: shekels(merchantTotals.owedNow),
        },
        {label: 'لك عند التجار (دفعات مقدمة)', value: shekels(merchantTotals.creditNow)},
        {label: 'توريد بالفترة', value: shekels(merchantTotals.purchasesInRange)},
        {label: 'ديون مباشرة بالفترة', value: shekels(merchantTotals.debtsInRange)},
        {label: 'سدادات بالفترة', value: shekels(merchantTotals.paymentsInRange)},
        {label: 'مرتجعات/خصومات بالفترة', value: shekels(merchantTotals.returnsInRange)},
        {label: 'تحصيلات منه بالفترة', value: shekels(merchantTotals.collectionsInRange)},
      ];
      const topRows: {cells: Cell[]}[] = merchantTotals.topOwed
        .slice(0, 8)
        .map((row, index) => ({
          cells: [
            {t: `${index + 1}`},
            {t: row.merchant.name, bold: true},
            {
              t: shekels(row.balance),
              tone: 'debt' as const,
              bold: true,
            },
          ] as Cell[],
        }));
      sections.push({
        heading: 'عمليات التجار — ملخص مختصر',
        summary: merchantSummary,
        ...(topRows.length > 0
          ? {
              columns: [
                {label: '#', w: 0.5},
                {label: 'التاجر', w: 2.8},
                {label: 'المستحق له', w: 1.4},
              ],
              rows: topRows,
            }
          : {}),
        note:
          'التوريد والسداد والمرتجع والتحصيل تعكس حركة هذه الفترة فقط؛ ' +
          '«المستحق الآن» رصيد حي عبر التاريخ. كشف أي تاجر التفصيلي ' +
          'يُصدَّر من نافذة التاجر في شاشة التجار (PDF قابل للطباعة).',
      });
    }

    // ── ٥. الأكثر إيراداً ──
    if (bundle.topByRevenue.length > 0) {
      sections.push({
        heading: 'الأكثر إيراداً بالفترة',
        columns: [
          {label: '#', w: 0.5},
          {label: 'الصنف', w: 2.8},
          {label: 'الكمية', w: 1.1},
          {label: 'الإيراد', w: 1.3},
          {label: 'الربح', w: 1.3},
        ],
        rows: bundle.topByRevenue.slice(0, 8).map((row, index) => ({
          cells: [
            {t: `${index + 1}`},
            {t: row.name, bold: true},
            {t: `${row.quantity}`},
            {t: shekels(row.revenue)},
            {
              t: shekels(row.profit),
              tone: row.profit < 0 ? ('debt' as const) : ('pay' as const),
            },
          ] as Cell[],
        })),
      });
    }

    const payload = {
      storeName: settings.storeName || 'متجر سيلا',
      title: 'تقرير الفترة الشامل',
      periodLabel: `${PERIOD_LABELS[rangeKey] ?? rangeKey} — ${range.from} إلى ${range.to}`,
      generatedAt: formatDateTime(localToday()),
      sections,
      footer:
        'تقرير شامل قابل للطباعة — يشمل عمليات التجار المختصرة · أُنشئ بواسطة تطبيق sela',
    };

    const location = await requirePlatformUtils().createPeriodReportPdf(
      fileFor(rangeKey),
      JSON.stringify(payload),
    );
    logDiag('reports', `أُنشئ تقرير الفترة الشامل PDF (${rangeKey})`);
    return location;
  },

  /** مشاركة تقرير الفترة (واتساب / إيميل / طابعات PDF). */
  async sharePeriodPdf(rangeKey: ReportRangeKey): Promise<void> {
    await requirePlatformUtils().shareExportedPdf(
      fileFor(rangeKey),
      'تقرير الفترة الشامل',
    );
  },

  /** طباعة تقرير الفترة عبر طباعة النظام (A4). */
  async printPeriodPdf(rangeKey: ReportRangeKey): Promise<void> {
    await requirePlatformUtils().printExportedPdf(
      fileFor(rangeKey),
      'تقرير الفترة الشامل',
    );
  },
};
