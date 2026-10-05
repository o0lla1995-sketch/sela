/**
 * SILA debt receipt — thermal template for deferred (دين) invoices.
 * ─────────────────────────────────────────────────────────────────
 * Mirrors the normal receipt but adds the SILA block: customer
 * name, the "سيُسجَّل في صِلة عند المزامنة" note (§9.2) and — once
 * the record syncs — the official reference code (POS-…) which is
 * the number both the merchant and the customer use for support
 * and reconciliation (§2 rule 4).
 */
import {ReceiptBuilder} from './escpos';
import {formatDateTime} from '../../core/format';
import {APP_NAME, RECEIPT_WIDTH_58, RECEIPT_WIDTH_80} from '../../core/config';
import type {SaleRecord, SaleItemRecord} from '../../core/types';
import type {ReceiptSettings} from './receipt';

const LABELS = {
  invoice: 'Invoice',
  date: 'Date',
  debtTitle: 'DEBT - SILA',
  subtotal: 'Subtotal',
  discount: 'Discount',
  total: 'TOTAL',
  customer: 'Customer',
  reference: 'SILA Ref',
  pending: 'SILA: pending sync',
  thanks: 'Thank You!',
} as const;

export interface DebtReceiptData {
  sale: SaleRecord;
  items: SaleItemRecord[];
  productNameById: Map<number, string>;
  /** Customer display name from the scanned card/QR (§9.2). */
  customerName: string;
  /** Last 4 phone digits when the card carried them. */
  customerPhoneLast4?: string | null;
  /** Official POS-… code — present after a successful sync. */
  referenceCode?: string | null;
}

export function buildDebtReceiptJob(
  data: DebtReceiptData,
  settings: ReceiptSettings,
) {
  const width =
    settings.paperWidth === '58' ? RECEIPT_WIDTH_58 : RECEIPT_WIDTH_80;
  const rasterWidth = settings.paperWidth === '58' ? 384 : 576;
  const b = ReceiptBuilder.create();

  if (settings.storeLogoPath) {
    b.image(settings.storeLogoPath, rasterWidth).feed(1);
  }

  // ── Header ──
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
  b.align(1)
    .textLine(APP_NAME)
    .align(2)
    .separator(width)
    .bold(true)
    .size(1, 1)
    .align(1)
    .textLine(LABELS.debtTitle)
    .size(0, 0)
    .bold(false)
    .align(2)
    .bold(true)
    .textLine(`${LABELS.invoice}: ${data.sale.invoice_number}`)
    .bold(false)
    .textLine(`${LABELS.date}: ${formatDateTime(data.sale.created_at)}`)
    .separator(width);

  // ── Customer block (the whole point of a debt receipt) ──
  b.align(2).bold(true).truncate(data.customerName, width).bold(false);
  if (data.customerPhoneLast4) {
    b.textLine(`${LABELS.customer}: ****${data.customerPhoneLast4}`);
  }
  b.separator(width);

  // ── Items ──
  b.align(2);
  for (const item of data.items) {
    const name =
      data.productNameById.get(item.product_id) ?? `#${item.product_id}`;
    const unitSuffix =
      item.unit_name && item.unit_name !== 'قطعة' ? ` (${item.unit_name})` : '';
    b.truncate(`${name}${unitSuffix}`, width);
    b.qtyPriceLine(item.quantity, item.unit_price, item.total_line_price);
  }

  // ── Totals ──
  const subtotal = data.sale.total_amount + data.sale.discount;
  b.separator(width)
    .twoColumns(LABELS.subtotal, subtotal, width)
    .twoColumns(LABELS.discount, data.sale.discount, width)
    .bold(true)
    .size(1, 1)
    .twoColumns(LABELS.total, data.sale.total_amount, Math.max(width - 4, 16))
    .size(0, 0)
    .bold(false);

  // ── SILA footer: official reference or the pending note ──
  b.separator(width).align(1);
  if (data.referenceCode) {
    b.bold(true)
      .textLine(`${LABELS.reference}: ${data.referenceCode}`)
      .bold(false)
      .textLine('مسجّل في صِلة لدى الزبون والتاجر');
  } else {
    b.textLine('دين مسجّل محلياً عبر صِلة').textLine(
      'سيُسجَّل في صِلة عند المزامنة',
    );
  }
  b.separator(width)
    .align(1)
    .textLine(settings.footerMessage || 'شكراً لتعاملكم معنا — عداكم خيراً')
    .bold(true)
    .textLine(LABELS.thanks)
    .bold(false)
    .feed(3)
    .cut();

  return b.build();
}
