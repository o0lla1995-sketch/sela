/**
 * InvoiceService — end-to-end checkout flow:
 * invoice numbering → transactional sale creation → cart clearing →
 * optional thermal printing (non-blocking, errors surfaced as toasts).
 */
import {SaleRepo} from '../database/repositories/SaleRepo';
import {ProductRepo} from '../database/repositories/ProductRepo';
import {nextInvoiceNumber, localToday} from '../core/format';
import {getNumber, setNumber, getString, setString, KEYS} from '../storage/storage';
import {logDiag} from '../core/diagnostics';
import {buildReceiptJob} from './printer/receipt';
import {ThermalPrinterService} from './printer/ThermalPrinterService';
import type {CartLine, PricingMode, SaleWithItems} from '../core/types';
import type {ReceiptSettings} from './printer/receipt';

function reserveInvoiceNumber(): string {
  const today = localToday();
  const lastDay = getString(KEYS.invoiceDay, '');
  const counter = getNumber(KEYS.invoiceCounter, 0);
  const next = nextInvoiceNumber(counter, lastDay, today);
  setNumber(KEYS.invoiceCounter, next.counter);
  setString(KEYS.invoiceDay, next.day);
  return next.invoiceNumber;
}

export interface CompleteSaleOptions {
  lines: CartLine[];
  discount: number;
  paymentType: PricingMode;
  /** Print the receipt right after a successful sale. */
  print: boolean;
  receiptSettings: ReceiptSettings;
  /** Callbacks for user feedback. */
  onPrintError?: (message: string) => void;
  productNames?: Map<number, string>;
}

export const InvoiceService = {
  async completeSale(options: CompleteSaleOptions): Promise<SaleWithItems> {
    const invoiceNumber = reserveInvoiceNumber();

    // One atomic transaction: sale + items + stock decrements.
    const result = await SaleRepo.createSale({
      invoiceNumber,
      lines: options.lines,
      discount: options.discount,
      paymentType: options.paymentType,
    });

    logDiag(
      'sale',
      `تم إتمام البيع ${invoiceNumber} بمبلغ ${result.sale.total_amount.toFixed(2)} ₪`,
    );

    if (options.print) {
      try {
        const names =
          options.productNames ??
          new Map<number, string>(
            options.lines.map(line => [line.productId, line.name]),
          );
        const job = buildReceiptJob(
          {sale: result.sale, items: result.items, productNameById: names},
          options.receiptSettings,
        );
        await ThermalPrinterService.printJob(job);
      } catch (error) {
        // The SALE IS SAVED — printing failure must never roll it back.
        const message = error instanceof Error ? error.message : String(error);
        logDiag('sale', `البيع تم حفظه لكن الطباعة فشلت: ${message}`, 'warn');
        options.onPrintError?.(message);
      }
    }

    return result;
  },

  /** Rebuilds a printable job for an already-saved invoice. */
  async reprintInvoice(saleId: number, receiptSettings: ReceiptSettings): Promise<void> {
    const sale = await SaleRepo.listRecent(200);
    const record = sale.find(entry => entry.id === saleId);
    if (!record) {
      throw new Error('الفاتورة غير موجودة');
    }
    const items = await SaleRepo.getItemsForSale(saleId);
    const names = new Map<number, string>();
    for (const item of items) {
      if (!names.has(item.product_id)) {
        const product = await ProductRepo.getById(item.product_id);
        names.set(item.product_id, product?.name ?? `#${item.product_id}`);
      }
    }
    const job = buildReceiptJob(
      {sale: record, items, productNameById: names},
      receiptSettings,
    );
    await ThermalPrinterService.printJob(job);
  },
};
