/**
 * cashierReportReceipt.ts — v59 (الجولة 63): تقرير الكاشير الحراري.
 * ─────────────────────────────────────────────────────────────────
 * ملخص فترة زمنية (اليوم/الأسبوع/الشهر/مخصص) لحساب كاشير واحد كما
 * يطلبه التاجر: مطبوع وسهل القراءة — إجماليات المبيعات والدفع
 * والمرتجعات، أهم المنتجات، ثم سجل الفواتير. نفس أسلوب إيصالات
 * المخزون (اسم عربي سطر مستقل ثم سطر أرقام ASCII ثنائي الأعمدة).
 */
import {ReceiptBuilder} from './escpos';
import type {EscPosOp} from '../../native/nativeBridge';
import {formatDateTime} from '../../core/format';
import {APP_NAME, RECEIPT_WIDTH_58, RECEIPT_WIDTH_80} from '../../core/config';
import type {CashierDetailedReport} from '../../database/repositories/CashiersRepo';

export interface CashierReportReceiptSettings {
  storeName: string;
  cashierName: string;
  paperWidth: '58' | '80';
  codepage: number;
}

/** ASCII-only labels (bidi-safe) للمنطقة المالية. */
const L = {
  report: 'Cashier Report',
  period: 'Period',
  invoices: 'Invoices',
  cash: 'Cash',
  debt: 'Debt Book',
  returns: 'Returns',
  net: 'NET',
  discount: 'Discounts',
  top: 'Top Products',
  ledger: 'Invoice Ledger',
  all: 'All Time',
} as const;

function money(value: number): string {
  return `${Math.abs(value).toFixed(2)} ILS`;
}

export function buildCashierReportJob(
  report: CashierDetailedReport,
  settings: CashierReportReceiptSettings,
): EscPosOp[] {
  const width =
    settings.paperWidth === '58' ? RECEIPT_WIDTH_58 : RECEIPT_WIDTH_80;
  const b = ReceiptBuilder.create()
    .codepage(settings.codepage)
    .align(1)
    .bold(true)
    .size(1, 1)
    .textLine(settings.storeName || APP_NAME)
    .size(0, 0)
    .bold(false)
    .align(1)
    .textLine(L.report)
    .align(2)
    .separator(width)
    .bold(true)
    .textLine(settings.cashierName)
    .bold(false)
    .textLine(
      `${L.period}: ${
        report.from && report.to
          ? `${report.from} ~ ${report.to}`
          : L.all
      }`,
    )
    .textLine(`${L.ledger}: ${formatDateTime(new Date().toISOString())}`)
    .separator(width);

  // ── الإجماليات ──
  b.twoColumns(`${L.invoices}`, report.salesCount, width)
    .twoColumns(L.cash, report.cashTotal, width)
    .twoColumns(L.debt, report.debtTotal, width)
    .twoColumns(L.returns, report.returnsTotal, width)
    .twoColumns(L.discount, report.discountTotal, width)
    .bold(true)
    .size(1, 1)
    .twoColumns(L.net, report.netTotal, Math.max(width - 4, 16))
    .size(0, 0)
    .bold(false)
    .separator(width);

  // ── أهم المنتجات ──
  if (report.topProducts.length > 0) {
    b.bold(true).align(2).textLine(L.top).bold(false);
    for (const product of report.topProducts.slice(0, 10)) {
      b.align(2).truncate(product.name, width);
      b.align(2).textLine(
        `${product.qty.toFixed(2)} x  = ${money(product.total)}`,
      );
    }
    b.separator(width);
  }

  // ── سجل الفواتير (آخر 40) ──
  if (report.invoices.length > 0) {
    b.bold(true).align(2).textLine(L.ledger).bold(false);
    for (const invoice of report.invoices.slice(0, 40)) {
      const mark =
        invoice.kind === 'return' ? 'RET' : invoice.kind === 'debt' ? 'DEBT' : 'CASH';
      b.align(2).textLine(`${invoice.number} [${mark}]`);
      b.align(2).textLine(
        `${invoice.createdAt.slice(0, 16)}  ${money(invoice.total)}`,
      );
    }
  }

  b.separator(width).align(1).textLine('***').feed(2).cut();
  return b.build();
}
