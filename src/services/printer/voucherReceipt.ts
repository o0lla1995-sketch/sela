/**
 * v20 — SILA voucher redemption receipt (SILA_POS_VOUCHERS_API §7.1).
 * ─────────────────────────────────────────────────────────────────
 * The thermal template for «صرف قسيمة صلة». Prints the OFFICIAL
 * reference (POS-VR-… — the number صِلة support uses), the campaign
 * name, the voucher value and — when the redemption was cart-tied —
 * the goods/surplus/cash-extra decomposition, plus the doc's golden
 * line: «قسيمة صلة — ليست ديناً على الزبون» (§2 rule 1/5: the
 * beneficiary owes NOTHING; the institution owes the store).
 */
import {ReceiptBuilder} from './escpos';
import {formatDateTime} from '../../core/format';
import {APP_NAME, RECEIPT_WIDTH_58, RECEIPT_WIDTH_80} from '../../core/config';
import type {SaleRecord, SaleItemRecord} from '../../core/types';
import type {ReceiptSettings} from './receipt';

const LABELS = {
  invoice: 'Invoice',
  date: 'Date',
  voucherTitle: 'SILA VOUCHER',
  campaign: 'Campaign',
  beneficiary: 'Beneficiary',
  subtotal: 'Subtotal',
  discount: 'Discount',
  goods: 'Goods Total',
  voucherValue: 'VOUCHER VALUE',
  coveredByVoucher: 'Paid by voucher',
  cashExtra: 'Cash at counter',
  surplus: 'Voucher surplus',
  reference: 'SILA Ref',
  thanks: 'Thank You!',
} as const;

export interface VoucherReceiptData {
  /** The INV-V-… number reserved for this redemption. */
  receiptRef: string;
  redeemedAt: string;
  campaignName: string;
  beneficiaryLast4?: string | null;
  /** Face value from the SERVER answer (minor → ₪ here). */
  valueMinor: number;
  /** Official POS-VR-… code — the number support & matching use. */
  referenceCode?: string | null;
  /** The created INV-V sale (cart-tied redemptions only). */
  sale?: SaleRecord | null;
  items?: SaleItemRecord[];
  productNameById?: Map<number, string>;
}

export function buildVoucherReceiptJob(
  data: VoucherReceiptData,
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
    .textLine(LABELS.voucherTitle)
    .size(0, 0)
    .bold(false)
    .align(2)
    .bold(true)
    .textLine(`${LABELS.invoice}: ${data.receiptRef}`)
    .bold(false)
    .textLine(`${LABELS.date}: ${formatDateTime(data.redeemedAt)}`)
    .separator(width);

  // ── Campaign block ──
  b.align(2)
    .bold(true)
    .truncate(`${LABELS.campaign}: ${data.campaignName}`, width)
    .bold(false);
  if (data.beneficiaryLast4) {
    b.textLine(`${LABELS.beneficiary}: ****${data.beneficiaryLast4}`);
  }
  b.separator(width);

  // ── Items (cart-tied redemptions) ──
  const items = data.items ?? [];
  if (items.length > 0 && data.sale != null) {
    b.align(2);
    for (const item of items) {
      const name =
        data.productNameById?.get(item.product_id) ?? `#${item.product_id}`;
      const unitSuffix =
        item.unit_name && item.unit_name !== 'قطعة'
          ? ` (${item.unit_name})`
          : '';
      b.truncate(`${name}${unitSuffix}`, width);
      b.qtyPriceLine(item.quantity, item.unit_price, item.total_line_price);
    }
    const subtotal = data.sale.total_amount + data.sale.discount;
    b.separator(width)
      .twoColumns(LABELS.subtotal, subtotal, width)
      .twoColumns(LABELS.discount, data.sale.discount, width);
  }

  // ── The voucher decomposition (the heart of the receipt) ──
  const value = data.valueMinor / 100;
  const goods = data.sale != null ? data.sale.total_amount : null;
  b.separator(width).align(2).bold(true).size(1, 1);
  b.twoColumns(LABELS.voucherValue, value, Math.max(width - 4, 16));
  b.size(0, 0).bold(false);
  if (goods != null) {
    if (goods > value + 0.004) {
      // The cart exceeded the voucher — the beneficiary paid the
      // difference in cash at the counter.
      b.twoColumns(LABELS.coveredByVoucher, value, width)
        .twoColumns(LABELS.cashExtra, goods - value, width)
        .bold(true)
        .twoColumns(LABELS.goods, goods, width)
        .bold(false);
    } else if (goods < value - 0.004) {
      // The cart was under the voucher — the store claims the full
      // face value from the institution (the surplus arrives within
      // the campaign settlement).
      b.twoColumns(LABELS.goods, goods, width).twoColumns(
        LABELS.surplus,
        value - goods,
        width,
      );
    }
  }

  // ── Footer: the official reference + the golden line ──
  b.separator(width).align(1);
  if (data.referenceCode) {
    b.bold(true)
      .textLine(`${LABELS.reference}: ${data.referenceCode}`)
      .bold(false);
  }
  b.textLine('قسيمة صِلة — ليست ديناً على الزبون');
  b.textLine('تُسوّى قيمتها مع المؤسسة ضمن الحملة');
  b.separator(width)
    .align(1)
    .textLine(settings.footerMessage || 'شكراً لتعاملكم معنا — عداكم خيراً')
    .bold(true)
    .textLine(LABELS.thanks)
    .bold(false);
  // v25 (round-32 #4): the invoice barcode — scan-to-open.
  b.align(1).barcode('CODE128', data.receiptRef, 60).feed(3).cut();

  return b.build();
}
