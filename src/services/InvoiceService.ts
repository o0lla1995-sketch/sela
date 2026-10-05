/**
 * InvoiceService — end-to-end checkout flow:
 * invoice numbering → transactional sale creation → cart clearing →
 * optional thermal printing (non-blocking, errors surfaced as toasts).
 */
import {SaleRepo} from '../database/repositories/SaleRepo';
import {ProductRepo} from '../database/repositories/ProductRepo';
import {getDb} from '../database/connection';
import {localToday} from '../core/format';
import {
  getNumber,
  setNumber,
  getString,
  setString,
  KEYS,
} from '../storage/storage';
import {logDiag} from '../core/diagnostics';
import {buildReceiptJob} from './printer/receipt';
import {buildDebtReceiptJob} from './printer/debtReceipt';
import {ThermalPrinterService} from './printer/ThermalPrinterService';
import {SilaRepo} from './sila/SilaRepo';
import {uuidV4} from './sila/qr';
import type {CartLine, PricingMode, SaleWithItems} from '../core/types';
import type {ReceiptSettings} from './printer/receipt';

/** INV-YYYYMMDD-NNNN for a day + sequence. */
function formatInvoiceNumber(day: string, seq: number): string {
  return `INV-${day.replace(/-/g, '')}-${String(seq).padStart(4, '0')}`;
}

/** Parses the numeric suffix of an invoice number (0 when malformed). */
function invoiceSequence(number: string): number {
  const match = /^(?:INV-\d{8}-)?(\d+)$/.exec(String(number ?? '').trim());
  return match ? parseInt(match[1], 10) : 0;
}

/** The highest invoice sequence already stored for a day prefix. */
async function maxSequenceInDb(prefix: string): Promise<number> {
  let max = 0;
  try {
    const result = await getDb().execute(
      'SELECT invoice_number FROM sales WHERE invoice_number LIKE ?',
      [`${prefix}%`],
    );
    for (const row of result.rows?._array ?? []) {
      const seq = invoiceSequence(String(row.invoice_number ?? ''));
      if (seq > max) {
        max = seq;
      }
    }
  } catch (error) {
    // The reservation still works from the MMKV counter alone.
    logDiag(
      'sale',
      `تعذر قراء تسلسل الفواتير: ${
        error instanceof Error ? error.message : String(error)
      }`,
      'warn',
    );
  }
  return max;
}

/**
 * v10 (round-16 #1): DB-AWARE invoice reservation.
 * ─────────────────────────────────────────────────────────────────
 * The old reservation trusted the MMKV counter alone. After
 * restoring an old backup the database can hold HIGHER invoice
 * numbers for today than the counter — the next sale then generated
 * a number that already existed, hit the UNIQUE constraint and the
 * whole sale failed ("رقم الفاتورة موجود مسبقاً"). The counter now
 * reconciles with the DATABASE on every reservation: the next number
 * is always max(MMKV next, highest stored sequence for today) + 1,
 * so selling continues right after the last registered invoice no
 * matter where the data came from.
 */
async function reserveInvoiceNumber(): Promise<string> {
  const today = localToday();
  const prefix = `INV-${today.replace(/-/g, '')}-`;
  const dbMax = await maxSequenceInDb(prefix);
  const lastDay = getString(KEYS.invoiceDay, '');
  const counter = getNumber(KEYS.invoiceCounter, 0);
  const mmkvNext = lastDay === today ? counter + 1 : 1;
  const next = Math.max(mmkvNext, dbMax + 1);
  setNumber(KEYS.invoiceCounter, next);
  setString(KEYS.invoiceDay, today);
  return formatInvoiceNumber(today, next);
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
  /** v11 (SILA §9.2): when set the sale is a SILA deferred debt —
   *  a debt_queue row is created at sale time with ONE idempotency
   *  key (§7 rule 1) and the receipt uses the debt template with
   *  the customer block + pending-sync note. */
  debt?: {
    customerId: string | null;
    customerName: string;
    customerPhoneLast4: string | null;
    customerCard: string | null;
    offlineQr: string | null;
    /** The DEBT amount in minor units — from the signed offline QR
     *  when present, otherwise the invoice total (§4 rules). */
    amountMinor: number;
  };
}

export const InvoiceService = {
  async completeSale(options: CompleteSaleOptions): Promise<SaleWithItems> {
    // v10 (round-16 #1): a UNIQUE collision (a number this device
    // didn't know about — e.g. mid-sale restore races) re-reserves
    // from the DB and retries instead of failing the sale.
    let result: SaleWithItems | null = null;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 4 && result == null; attempt += 1) {
      const invoiceNumber = await reserveInvoiceNumber();
      try {
        // One atomic transaction: sale + items + stock decrements.
        result = await SaleRepo.createSale({
          invoiceNumber,
          lines: options.lines,
          discount: options.discount,
          paymentType: options.paymentType,
        });
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        if (!/UNIQUE/i.test(message)) {
          throw error;
        }
        logDiag(
          'sale',
          `تضارب رقم الفاتورة ${invoiceNumber} — إعادة الحجز من قاعدة البيانات`,
          'warn',
        );
      }
    }
    if (result == null) {
      throw lastError instanceof Error
        ? lastError
        : new Error('تعذر حجز رقم فاتورة — حاول مرة أخرى');
    }

    logDiag(
      'sale',
      `تم إتمام البيع ${
        result.sale.invoice_number
      } بمبلغ ${result.sale.total_amount.toFixed(2)} ₪`,
    );

    // v11 (SILA §9.2): the debt row is created AT SALE TIME — one
    // idempotency key, replayed verbatim on every retry (§7).
    if (options.debt != null) {
      await SilaRepo.enqueue({
        idempotencyKey: uuidV4(),
        customerId: options.debt.customerId,
        customerName: options.debt.customerName,
        customerPhoneLast4: options.debt.customerPhoneLast4,
        customerCard: options.debt.customerCard,
        offlineQr: options.debt.offlineQr,
        amountMinor: options.debt.amountMinor,
        posInvoiceRef: result.sale.invoice_number,
        description: `بيع بضاعة — فاتورة ${result.sale.invoice_number}`,
        scannedAt: new Date().toISOString(),
      });
    }

    if (options.print) {
      try {
        const names =
          options.productNames ??
          new Map<number, string>(
            options.lines.map(line => [line.productId, line.name]),
          );
        const job =
          options.debt != null
            ? buildDebtReceiptJob(
                {
                  sale: result.sale,
                  items: result.items,
                  productNameById: names,
                  customerName: options.debt.customerName,
                  customerPhoneLast4: options.debt.customerPhoneLast4,
                  referenceCode: null,
                },
                options.receiptSettings,
              )
            : buildReceiptJob(
                {
                  sale: result.sale,
                  items: result.items,
                  productNameById: names,
                },
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
  async reprintInvoice(
    saleId: number,
    receiptSettings: ReceiptSettings,
  ): Promise<void> {
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

  /**
   * v11 (SILA): reprints a debt receipt BY INVOICE REFERENCE —
   * includes the customer block and, once synced, the official
   * POS-… reference code.
   */
  async reprintDebtReceiptByRef(
    invoiceRef: string,
    receiptSettings: ReceiptSettings,
  ): Promise<void> {
    const debt = await SilaRepo.byInvoiceRef(invoiceRef);
    if (debt == null) {
      throw new Error('هذه ليست فاتورة دين صِلة');
    }
    const sales = await SaleRepo.listRecent(500);
    const record = sales.find(entry => entry.invoice_number === invoiceRef);
    if (!record) {
      throw new Error('الفاتورة غير موجودة');
    }
    const items = await SaleRepo.getItemsForSale(record.id);
    const names = new Map<number, string>();
    for (const item of items) {
      if (!names.has(item.product_id)) {
        const product = await ProductRepo.getById(item.product_id);
        names.set(item.product_id, product?.name ?? `#${item.product_id}`);
      }
    }
    const job = buildDebtReceiptJob(
      {
        sale: record,
        items,
        productNameById: names,
        customerName: debt.customer_name ?? 'زبون صِلة',
        customerPhoneLast4: debt.customer_phone_last4,
        referenceCode: debt.reference_code,
      },
      receiptSettings,
    );
    await ThermalPrinterService.printJob(job);
  },

  /**
   * v10 (round-16 #1): re-syncs the MMKV invoice counter with the
   * DATABASE after a backup restore — walks every stored invoice,
   * finds the latest day + its highest sequence and stores them, so
   * the very first post-restore sale continues after the last
   * restored invoice instead of colliding with it.
   */
  async syncInvoiceCounterFromDb(): Promise<void> {
    try {
      const result = await getDb().execute('SELECT invoice_number FROM sales');
      let bestDay = '';
      let bestSeq = 0;
      const byDay = new Map<string, number>();
      for (const row of result.rows?._array ?? []) {
        const value = String(row.invoice_number ?? '');
        const match = /^INV-(\d{8})-(\d+)$/.exec(value.trim());
        if (match == null) {
          continue;
        }
        const day = `${match[1].slice(0, 4)}-${match[1].slice(
          4,
          6,
        )}-${match[1].slice(6, 8)}`;
        const seq = parseInt(match[2], 10);
        byDay.set(day, Math.max(byDay.get(day) ?? 0, seq));
        if (day > bestDay) {
          bestDay = day;
        }
      }
      if (bestDay !== '') {
        bestSeq = byDay.get(bestDay) ?? 0;
        setString(KEYS.invoiceDay, bestDay);
        setNumber(KEYS.invoiceCounter, bestSeq);
        logDiag(
          'sale',
          `تمت مزامنة عداد الفواتير مع قاعدة البيانات: آخر فاتورة ${formatInvoiceNumber(
            bestDay,
            bestSeq,
          )}`,
        );
      }
    } catch (error) {
      // The DB-aware reservation still recovers on the next sale.
      logDiag(
        'sale',
        `تعذر مزامنة عداد الفواتير: ${
          error instanceof Error ? error.message : String(error)
        }`,
        'warn',
      );
    }
  },
};
