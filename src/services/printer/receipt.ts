/**
 * Professional thermal receipt template.
 * ─────────────────────────────────────────────────────────────────
 * Structure: store header (bold, double size) → invoice meta →
 * item lines → totals → optional manager-only net profit →
 * thank-you footer → feed & cut.
 */
import {ReceiptBuilder} from './escpos';
import {formatAmount, formatDateTime} from '../../core/format';
import {APP_NAME, RECEIPT_WIDTH_58, RECEIPT_WIDTH_80} from '../../core/config';
import type {SaleRecord, SaleItemRecord, Product} from '../../core/types';

export interface ReceiptSettings {
  storeName: string;
  storePhone: string;
  footerMessage: string;
  paperWidth: '58' | '80';
  codepage: number;
  showProfit: boolean;
}

export interface ReceiptData {
  sale: SaleRecord;
  items: SaleItemRecord[];
  /** Product lookup so receipts can print names even after re-pricing. */
  productNameById: Map<number, string>;
}

/** ASCII-only labels used in the money area (bidi-safe). */
const LABELS = {
  invoice: 'Invoice',
  date: 'Date',
  paymentRetail: 'RETAIL',
  paymentWholesale: 'WHOLESALE',
  subtotal: 'Subtotal',
  discount: 'Discount',
  total: 'TOTAL',
  profit: 'Net Profit',
  qty: 'Qty x Price = Amount',
  thanks: 'Thank You!',
} as const;

export function buildReceiptJob(data: ReceiptData, settings: ReceiptSettings) {
  const width = settings.paperWidth === '58' ? RECEIPT_WIDTH_58 : RECEIPT_WIDTH_80;
  const b = ReceiptBuilder.create();

  // ── Header ────────────────────────────────────────────────────
  b.codepage(settings.codepage)
    .align(1)
    .bold(true)
    .size(1, 1)
    .textLine(settings.storeName || APP_NAME)
    .size(0, 0)
    .bold(false);
  if (settings.storePhone.trim()) {
    b.align(1).textLine(`Tel: ${settings.storePhone.trim()}`);
  }
  b.align(1).textLine(APP_NAME)
    .align(2)
    .separator(width)
    .bold(true)
    .textLine(`${LABELS.invoice}: ${data.sale.invoice_number}`)
    .bold(false)
    .textLine(`${LABELS.date}: ${formatDateTime(data.sale.created_at)}`)
    .textLine(
      `${data.sale.payment_type === 'WHOLESALE' ? LABELS.paymentWholesale : LABELS.paymentRetail}`,
    )
    .separator(width);

  // ── Items ─────────────────────────────────────────────────────
  // Arabic name on its own right-aligned line, then ASCII money line.
  b.align(2);
  for (const item of data.items) {
    const name =
      data.productNameById.get(item.product_id) ?? `#${item.product_id}`;
    b.truncate(name, width);
    b.qtyPriceLine(item.quantity, item.unit_price, item.total_line_price);
  }

  // ── Totals ────────────────────────────────────────────────────
  const subtotal =
    data.sale.total_amount + data.sale.discount;
  b.separator(width)
    .twoColumns(LABELS.subtotal, subtotal, width)
    .twoColumns(LABELS.discount, data.sale.discount, width)
    .bold(true)
    .size(1, 1)
    .twoColumns(LABELS.total, data.sale.total_amount, Math.max(width - 4, 16))
    .size(0, 0)
    .bold(false);

  // Manager-only net profit (never printed unless explicitly enabled).
  if (settings.showProfit) {
    b.bold(true)
      .twoColumns(LABELS.profit, data.sale.total_profit, width)
      .bold(false);
  }

  // ── Footer ────────────────────────────────────────────────────
  b.separator(width)
    .align(1)
    .textLine(settings.footerMessage || 'شكراً لتعاملكم معنا — عداكم خيراً')
    .align(1)
    .bold(true)
    .textLine(LABELS.thanks)
    .bold(false)
    .feed(3)
    .cut();

  return b.build();
}

/** Small self-test receipt used by "طباعة تجريبية". */
export function buildTestJob(settings: ReceiptSettings) {
  const width = settings.paperWidth === '58' ? RECEIPT_WIDTH_58 : RECEIPT_WIDTH_80;
  const b = ReceiptBuilder.create();
  b.codepage(settings.codepage)
    .align(1)
    .bold(true)
    .size(1, 1)
    .textLine(settings.storeName || APP_NAME)
    .size(0, 0)
    .bold(false)
    .align(1)
    .textLine('طباعة تجريبية - Test Print')
    .separator(width)
    .align(2)
    .textLine('شوكولاتة بالحليب 40 جرام')
    .qtyPriceLine(2, 4.5, 9)
    .textLine('عصير برتقال طبيعي')
    .qtyPriceLine(1, 6, 6)
    .separator(width)
    .twoColumns(LABELS.subtotal, 15, width)
    .twoColumns(LABELS.discount, 0, width)
    .bold(true)
    .twoColumns(LABELS.total, 15, width)
    .bold(false)
    .separator(width)
    .align(1)
    .textLine('العربية: أ ب ت ث ج ح خ د ذ ر ز')
    .textLine('English: ABCDEFG 12345')
    .textLine(`${settings.paperWidth}mm - CP${settings.codepage}`)
    .textLine('تمت الطباعة بنجاح')
    .feed(3)
    .cut();
  return b.build();
}
