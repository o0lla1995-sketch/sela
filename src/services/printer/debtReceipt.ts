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
  debtTitleSila: 'DEBT - SILA',
  debtTitleLocal: 'DEBT - STORE BOOK',
  /** v20 (requirement: invoices NAMED BY TYPE so the print always
   *  tells them apart): a صِلة debt invoice that prepaid credit
   *  (partially) covered — its own title, never mistaken for a
   *  pure debt receipt. */
  debtPrepaidTitleSila: 'DEBT+PREPAID - SILA',
  subtotal: 'Subtotal',
  discount: 'Discount',
  total: 'TOTAL',
  customer: 'Customer',
  reference: 'SILA Ref',
  creditCovered: 'Prepaid credit',
  netDebt: 'Net debt',
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
  /** v17 (round-23 #1): which book owns this debt — drives the
   *  title + footer wording (the local book's receipt must NOT say
   *  «سيُسجَّل في صِلة»). Defaults to 'sila' (the original template). */
  mode?: 'sila' | 'local';
  /** v17 (round-23 #3): the part of the total the customer's
   *  PREPAID credit in صِلة absorbed — printed as its own line so
   *  the merchant sees the invoice is (partially) PAID, with the
   *  NET debt spelled out. */
  creditCoveredMinor?: number;
}

export function buildDebtReceiptJob(
  data: DebtReceiptData,
  settings: ReceiptSettings,
) {
  const width =
    settings.paperWidth === '58' ? RECEIPT_WIDTH_58 : RECEIPT_WIDTH_80;
  const rasterWidth = settings.paperWidth === '58' ? 384 : 576;
  const b = ReceiptBuilder.create();

  // v20: the covered part decides the TITLE — a (partly) prepaid
  // invoice prints as DEBT+PREPAID, a pure credit invoice as DEBT.
  const coveredMinorForTitle = Math.max(
    0,
    Math.min(
      Math.round(data.creditCoveredMinor ?? 0),
      Math.round(data.sale.total_amount * 100),
    ),
  );
  const prepaidPartiallyCovered =
    data.mode !== 'local' && coveredMinorForTitle > 0;

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
    .textLine(
      data.mode === 'local'
        ? LABELS.debtTitleLocal
        : prepaidPartiallyCovered
        ? LABELS.debtPrepaidTitleSila
        : LABELS.debtTitleSila,
    )
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

  // ── v17 (round-23 #3): prepaid-credit coverage — the merchant
  //    sees the invoice is (partly) PAID by existing balance, with
  //    the NET debt spelled out («مراعاة أن هذه الفاتورة مسددة»).
  const coveredMinor = Math.max(
    0,
    Math.min(
      Math.round(data.creditCoveredMinor ?? 0),
      Math.round(data.sale.total_amount * 100),
    ),
  );
  if (coveredMinor > 0) {
    const netMinor = Math.round(data.sale.total_amount * 100) - coveredMinor;
    b.align(2)
      .twoColumns(LABELS.creditCovered, coveredMinor / 100, width)
      .bold(true)
      .twoColumns(LABELS.netDebt, netMinor / 100, width)
      .bold(false)
      .align(1);
    if (netMinor === 0) {
      b.textLine('الفاتورة مسددة بالكامل من الرصيد المسبق');
    } else {
      // v20: the Arabic split line — the customer sees exactly what
      // was paid from balance and what remains as debt.
      b.textLine(
        `مسدّد من الرصيد المسبق: ${(coveredMinor / 100).toFixed(
          2,
        )} ₪ — والباقي ديناً: ${(netMinor / 100).toFixed(2)} ₪`,
      );
    }
  }

  // ── Footer: the book that holds the debt (round-23 #1 — the
  //    local book's receipt must not mention صِلة syncing). ──
  b.separator(width).align(1);
  if (data.mode === 'local') {
    b.textLine('دين مسجّل في دفتر المتجر').textLine(
      'يُسدَّد عند الكاشير — دون تطبيق صِلة',
    );
  } else if (data.referenceCode) {
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
