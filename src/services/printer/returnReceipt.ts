/**
 * v23 (round-29 #2): إشعار مرتجع — the thermal template for a
 * product RETURN against an invoice.
 * ─────────────────────────────────────────────────────────────────
 * Structure: store header → RETURN title (impossible to mistake
 * for a sale) → the ORIGINAL invoice number + date → the returned
 * lines (name, qty × price = value) → the refund total → the debt
 * adjustment line (which book shrank and by how much — صِلة reversal
 * / local book / cash refund) → footer.
 */
import {ReceiptBuilder} from './escpos';
import {formatDateTime} from '../../core/format';
import {APP_NAME, RECEIPT_WIDTH_58, RECEIPT_WIDTH_80} from '../../core/config';
import type {SaleReturnItem, SaleReturnRecord} from '../../core/types';
import type {ReceiptSettings} from './receipt';

const LABELS = {
  returnTitle: 'RETURN / REFUND',
  returnNo: 'Return No',
  date: 'Date',
  originalInvoice: 'Original Invoice',
  refundTotal: 'REFUND TOTAL',
  debtAdjusted: 'Debt Reduced',
  silaReversal: 'SILA debt reversal queued',
  localAdjusted: 'Store-book debt reduced',
  cashRefund: 'Cash refunded to customer',
  noRefund: 'Goods exchange - no refund',
  qty: 'Qty x Price = Amount',
  thanks: 'Thank You!',
} as const;

export interface ReturnReceiptData {
  ret: SaleReturnRecord;
  items: SaleReturnItem[];
}

export function buildReturnReceiptJob(
  data: ReturnReceiptData,
  settings: ReceiptSettings,
) {
  const width =
    settings.paperWidth === '58' ? RECEIPT_WIDTH_58 : RECEIPT_WIDTH_80;
  const rasterWidth = settings.paperWidth === '58' ? 384 : 576;
  const b = ReceiptBuilder.create();

  // ── Optional store logo ──
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
  b.align(2)
    .separator(width)
    .bold(true)
    .size(1, 1)
    .align(1)
    .textLine(LABELS.returnTitle)
    .size(0, 0)
    .bold(false)
    .align(2)
    .textLine(`${LABELS.returnNo}: ${data.ret.return_number}`)
    .textLine(`${LABELS.date}: ${formatDateTime(data.ret.created_at)}`)
    .bold(true)
    .textLine(`${LABELS.originalInvoice}: ${data.ret.invoice_ref}`)
    .bold(false)
    .separator(width);

  // ── Returned lines ──
  b.align(2);
  for (const item of data.items) {
    const unitSuffix =
      item.unit_name && item.unit_name !== 'قطعة' ? ` (${item.unit_name})` : '';
    b.truncate(`${item.product_name}${unitSuffix}`, width);
    b.qtyPriceLine(item.quantity, item.unit_price, item.line_total);
  }

  // ── Refund total + the debt adjustment ──
  b.separator(width)
    .bold(true)
    .size(1, 1)
    .twoColumns(
      LABELS.refundTotal,
      data.ret.refund_minor / 100,
      Math.max(width - 4, 16),
    )
    .size(0, 0)
    .bold(false);

  if (data.ret.debt_adjusted_minor > 0) {
    b.bold(true)
      .twoColumns(
        LABELS.debtAdjusted,
        data.ret.debt_adjusted_minor / 100,
        width,
      )
      .bold(false)
      .align(2)
      .textLine(
        data.ret.book === 'sila' ? LABELS.silaReversal : LABELS.localAdjusted,
      );
  } else {
    b.align(2).textLine(
      data.ret.refund_method === 'cash' ? LABELS.cashRefund : LABELS.noRefund,
    );
  }

  // ── Footer ──
  b.separator(width)
    .align(1)
    .textLine(settings.footerMessage || 'شكراً لتعاملكم معنا — عداكم خيراً')
    .align(1)
    .bold(true)
    .textLine(LABELS.thanks)
    .bold(false);
  // v25 (round-32 #4): the RETURN receipt's own barcode — scanning
  //  it opens the RET row (its lines/history) directly.
  b.align(1).barcode('CODE128', data.ret.return_number, 60).feed(2).cut();

  return b.build();
}
