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
import {VoucherService} from './VoucherService';
import {LocalDebtsRepo} from '../database/repositories/LocalDebtsRepo';
import {uuidV4} from './sila/qr';
import type {CartLine, PricingMode, SaleWithItems} from '../core/types';
import type {ReceiptSettings} from './printer/receipt';

/** INV-YYYYMMDD-NNNN for a day + sequence (CASH series). */
function formatInvoiceNumber(day: string, seq: number): string {
  return `INV-${day.replace(/-/g, '')}-${String(seq).padStart(4, '0')}`;
}

/** v14 (round-20 #3): INV-D-YYYYMMDD-NNNN — the DEBT series. A
 *  distinctive D segment separates credit invoices from cash
 *  invoices at a glance (list, receipt, debt screen), and keeps
 *  the two counters from ever stealing numbers from each other. */
function formatDebtInvoiceNumber(day: string, seq: number): string {
  return `INV-D-${day.replace(/-/g, '')}-${String(seq).padStart(4, '0')}`;
}

/** Parses the numeric suffix of a CASH invoice number (0 when
 *  malformed). INV-D-… numbers deliberately do NOT match — they
 *  belong to the debt series. */
function invoiceSequence(number: string): number {
  const match = /^(?:INV-\d{8}-)?(\d+)$/.exec(String(number ?? '').trim());
  return match ? parseInt(match[1], 10) : 0;
}

/** v14 (round-20 #1): numeric suffix of a DEBT invoice number
 *  (0 when malformed, non-debt numbers included). */
function debtInvoiceSequence(number: string): number {
  const match = /^(?:INV-D-\d{8}-)?(\d+)$/.exec(String(number ?? '').trim());
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
      `تعذر قراءة تسلسل الفواتير: ${
        error instanceof Error ? error.message : String(error)
      }`,
      'warn',
    );
  }
  return max;
}

/**
 * v14 (round-20 #1): the highest DEBT sequence for a day across BOTH
 * tables that can remember credit numbers —
 *  - sales (INV-D-… invoices actually on this device),
 *  - sila_debt_queue (the pos_invoice_ref of every debt row ever
 *    enqueued here, INCLUDING failed ones whose sale rows were lost
 *    to an old-backup restore — the exact source of the
 *    «تعارض الدين مع رقم فاتورة مسبق» failures: the reservation used
 *    to regenerate a number the queue still holds, the UNIQUE
 *    constraint fired and the whole debt sale collapsed).
 * Reconciling against the queue too means a freshly generated debt
 * number is always AFTER the last one the queue remembers.
 */
async function maxDebtSequenceInDb(debtPrefix: string): Promise<number> {
  let max = 0;
  const consider = (value: unknown) => {
    const seq = debtInvoiceSequence(String(value ?? ''));
    if (seq > max) {
      max = seq;
    }
  };
  try {
    const salesResult = await getDb().execute(
      'SELECT invoice_number FROM sales WHERE invoice_number LIKE ?',
      [`${debtPrefix}%`],
    );
    for (const row of salesResult.rows?._array ?? []) {
      consider(row.invoice_number);
    }
  } catch {
    // Best effort — the MMKV counter alone stays monotonic.
  }
  try {
    const queueResult = await getDb().execute(
      'SELECT pos_invoice_ref FROM sila_debt_queue WHERE pos_invoice_ref LIKE ?',
      [`${debtPrefix}%`],
    );
    for (const row of queueResult.rows?._array ?? []) {
      consider(row.pos_invoice_ref);
    }
  } catch {
    // Table missing on very old installs — ignore.
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

/**
 * v14 (round-20 #1/#3): DB-AWARE reservation for the DEBT series —
 * the same reconciliation discipline as the cash series, but across
 * the debt counter AND both debt-number sources (sales + the صِلة
 * debt queue). The next credit invoice number is always AFTER the
 * last one any of them remembers, so a restored backup or a failed
 * sync row can never make a new debt sale collide with a number the
 * queue (or the صِلة server behind it) already holds.
 */
async function reserveDebtInvoiceNumber(): Promise<string> {
  const today = localToday();
  const prefix = `INV-D-${today.replace(/-/g, '')}-`;
  const dbMax = await maxDebtSequenceInDb(prefix);
  const lastDay = getString(KEYS.debtInvoiceDay, '');
  const counter = getNumber(KEYS.debtInvoiceCounter, 0);
  const mmkvNext = lastDay === today ? counter + 1 : 1;
  const next = Math.max(mmkvNext, dbMax + 1);
  setNumber(KEYS.debtInvoiceCounter, next);
  setString(KEYS.debtInvoiceDay, today);
  return formatDebtInvoiceNumber(today, next);
}

/** v14 (round-20 #1): "YYYYMMDD" → "YYYY-MM-DD". */
function dayOf(compact: string): string {
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

/**
 * v14 (round-20 #1): NEVER-BACKWARDS counter reconcile.
 * Picks, per series, whichever (day, sequence) is further along —
 * the LATER day wins outright; the same day keeps the HIGHER
 * sequence. An older restore can pull the database behind, but the
 * MMKV counters stay at the furthest point this device ever reached,
 * so the next invoice of that series continues after the last one
 * ever issued here (what the merchant asked for verbatim).
 */
function reconcileNeverBackwards(
  byDay: Map<string, number>,
  dayKey: string,
  counterKey: string,
): void {
  let dbDay = '';
  let dbSeq = 0;
  for (const [day, seq] of byDay) {
    if (day > dbDay) {
      dbDay = day;
      dbSeq = seq;
    } else if (day === dbDay && seq > dbSeq) {
      dbSeq = seq;
    }
  }
  const mmkvDay = getString(dayKey, '');
  const mmkvSeq = getNumber(counterKey, 0);
  if (dbDay === '') {
    return; // Nothing new to learn for this series.
  }
  if (mmkvDay > dbDay || (mmkvDay === dbDay && mmkvSeq >= dbSeq)) {
    // MMKV is already at (or past) the DB — keep it. Moving it
    // backwards here is exactly the rewind that re-issued numbers
    // the صِلة server already holds.
    return;
  }
  setString(dayKey, dbDay);
  setNumber(counterKey, dbSeq);
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
    /** v17 (round-23 #3): the prepaid-credit part the server is
     *  expected to absorb (min(amount, cached credit)) — the store
     *  books the invoice as PAID by this much. */
    creditCoveredMinor?: number;
  };
  /** v16 (round-22 #4): when set the sale is a STORE-LOCAL credit
   *  sale (دفتر المتجر) — the debt lands ONLY in local_debts (INV-L
   *  series) and never syncs to صِلة. The debt amount is always the
   *  invoice total. */
  localDebt?: {
    localCustomerId: number;
    customerName: string;
    customerPhoneLast4: string | null;
  };
}

export const InvoiceService = {
  async completeSale(options: CompleteSaleOptions): Promise<SaleWithItems> {
    // v10 (round-16 #1): a UNIQUE collision (a number this device
    // didn't know about — e.g. mid-sale restore races) re-reserves
    // from the DB and retries instead of failing the sale.
    // v14 (round-20 #1): debt sales reserve from the SEPARATE
    // INV-D series and v14 (round-20 #2) the debt-queue row joins
    // the SAME transaction — a UNIQUE hit on either sales or
    // sila_debt_queue rolls EVERYTHING back and the loop retries
    // with a fresh number. A failed debt sale is therefore never
    // half-recorded: no invoice, no stock decrement, no queue row.
    const isDebt = options.debt != null;
    const isLocalDebt = options.localDebt != null;
    let result: SaleWithItems | null = null;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 4 && result == null; attempt += 1) {
      const invoiceNumber = isDebt
        ? await reserveDebtInvoiceNumber()
        : isLocalDebt
        ? await LocalDebtsRepo.reserveLocalDebtRef()
        : await reserveInvoiceNumber();
      try {
        // One atomic transaction: sale + items + stock decrements
        // (+ the debt-queue row for credit sales).
        result = await SaleRepo.createSale({
          invoiceNumber,
          lines: options.lines,
          discount: options.discount,
          paymentType: options.paymentType,
          debtRow:
            options.debt == null
              ? undefined
              : {
                  idempotencyKey: uuidV4(),
                  customerId: options.debt.customerId,
                  customerName: options.debt.customerName,
                  customerPhoneLast4: options.debt.customerPhoneLast4,
                  customerCard: options.debt.customerCard,
                  offlineQr: options.debt.offlineQr,
                  amountMinor: options.debt.amountMinor,
                  creditCoveredMinor: options.debt.creditCoveredMinor ?? 0,
                  description: `بيع بالدين — فاتورة ${invoiceNumber}`,
                  scannedAt: new Date().toISOString(),
                },
          localDebtRow:
            options.localDebt == null
              ? undefined
              : {
                  localCustomerId: options.localDebt.localCustomerId,
                  customerName: options.localDebt.customerName,
                  amountMinor: (() => {
                    // Mirror SaleRepo's total: subtotal − clamped
                    // discount (the debt is ALWAYS the invoice total
                    // for local book sales — no signed QR involved).
                    const subtotal = options.lines.reduce(
                      (sum, line) => sum + line.unitPrice * line.quantity,
                      0,
                    );
                    const discount = Math.min(
                      Math.max(options.discount, 0),
                      subtotal,
                    );
                    return Math.round((subtotal - discount) * 100);
                  })(),
                  description: `بيع بالدين (دفتر المتجر) — فاتورة ${invoiceNumber}`,
                },
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
        : new Error(
            isDebt
              ? 'تعذر حجز رقم فاتورة الدين — لم يُسجَّل البيع، أعد المحاولة'
              : 'تعذر حجز رقم فاتورة — حاول مرة أخرى',
          );
    }

    logDiag(
      'sale',
      `تم إتمام البيع ${result.sale.invoice_number}${
        isDebt ? ' (دين)' : ''
      } بمبلغ ${result.sale.total_amount.toFixed(2)} ₪`,
    );

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
                  mode: 'sila',
                  creditCoveredMinor: options.debt.creditCoveredMinor ?? 0,
                },
                options.receiptSettings,
              )
            : options.localDebt != null
            ? buildDebtReceiptJob(
                {
                  sale: result.sale,
                  items: result.items,
                  productNameById: names,
                  customerName: options.localDebt.customerName,
                  customerPhoneLast4: options.localDebt.customerPhoneLast4,
                  referenceCode: null,
                  mode: 'local',
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

  /** Rebuilds a printable job for an already-saved invoice.
   *  v17 (round-23 #1): DEBT invoices (INV-D صِلة / INV-L دفتر
   *  المتجر) reprint with the DEBT template — the customer block is
   *  the whole point of a debt receipt, and it used to vanish on
   *  every reprint from the invoice center (the normal template has
   *  no customer line). */
  async reprintInvoice(
    saleId: number,
    receiptSettings: ReceiptSettings,
  ): Promise<void> {
    const sale = await SaleRepo.listRecent(500);
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

    // ── v17 (round-23 #1): debt-invoice reprints keep the debt look ──
    const ref = record.invoice_number;
    // v20: VOUCHER redemptions (INV-V) reprint with the voucher
    // template — the campaign block + the official POS-VR reference
    // are the whole point of that receipt.
    if (ref.startsWith('INV-V-')) {
      await VoucherService.reprintByReceiptRef(ref, receiptSettings);
      return;
    }
    if (ref.startsWith('INV-D-')) {
      // صِلة debt — the queue row carries the creditor + the
      // official POS-… reference once synced.
      const debt = await SilaRepo.byInvoiceRef(ref);
      const job = buildDebtReceiptJob(
        {
          sale: record,
          items,
          productNameById: names,
          customerName: debt?.customer_name ?? 'زبون صِلة',
          customerPhoneLast4: debt?.customer_phone_last4 ?? null,
          referenceCode: debt?.reference_code ?? null,
          mode: 'sila',
          creditCoveredMinor: debt?.credit_covered_minor ?? 0,
        },
        receiptSettings,
      );
      await ThermalPrinterService.printJob(job);
      return;
    }
    if (ref.startsWith('INV-L-')) {
      // دفتر المتجر debt — the local book carries the creditor.
      const local = await LocalDebtsRepo.creditorByInvoiceRef(ref);
      const job = buildDebtReceiptJob(
        {
          sale: record,
          items,
          productNameById: names,
          customerName: local?.name ?? 'زبون الدفتر',
          customerPhoneLast4: local?.phone
            ? local.phone.replace(/\D/g, '').slice(-4)
            : null,
          referenceCode: null,
          mode: 'local',
        },
        receiptSettings,
      );
      await ThermalPrinterService.printJob(job);
      return;
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
   * v10 (round-16 #1) → v14 (round-20 #1): re-syncs the MMKV invoice
   * counters with the DATABASE after a backup restore.
   * ─────────────────────────────────────────────────────────────────
   * v10 reconciled by OVERWRITING the counter from the DB — correct
   * when the restore brought NEWER numbers, but it also moved the
   * counter BACKWARDS when the restore was OLDER than what this
   * device had already issued. The next sale then regenerated a
   * number the صِلة server still remembers (it never forgets a
   * pos_invoice_ref) → DUPLICATE_INVOICE_REF → «عملية الدين فاشلة»
   * — the merchant's exact complaint: the debt conflicted with a
   * pre-existing invoice number because no invoice was created after
   * the last one.
   * v14 rule: the counters only ever move FORWARD. For each series
   * (cash INV-… and debt INV-D-…) the reconcile picks whichever
   * (day, sequence) is further along — the later day wins, and
   * within the same day the higher sequence wins. Restoring an old
   * backup can therefore lower the DATABASE contents but never the
   * numbering: the next invoice of each series is always issued
   * AFTER the last one this device ever printed, exactly as the
   * merchant expects. Debt numbers additionally reconcile against
   * the sila_debt_queue refs (failed rows can outlive their sales).
   */
  async syncInvoiceCounterFromDb(): Promise<void> {
    try {
      const result = await getDb().execute('SELECT invoice_number FROM sales');
      const cashByDay = new Map<string, number>();
      const debtByDay = new Map<string, number>();
      for (const row of result.rows?._array ?? []) {
        const value = String(row.invoice_number ?? '').trim();
        let match = /^INV-(\d{8})-(\d+)$/.exec(value);
        if (match != null) {
          const day = dayOf(match[1]);
          cashByDay.set(
            day,
            Math.max(cashByDay.get(day) ?? 0, parseInt(match[2], 10)),
          );
          continue;
        }
        match = /^INV-D-(\d{8})-(\d+)$/.exec(value);
        if (match != null) {
          const day = dayOf(match[1]);
          debtByDay.set(
            day,
            Math.max(debtByDay.get(day) ?? 0, parseInt(match[2], 10)),
          );
        }
      }
      // Debt refs also live in the queue — failed rows can outlive
      // their sales rows (old-backup restores), so count them too.
      try {
        const queue = await getDb().execute(
          'SELECT pos_invoice_ref FROM sila_debt_queue',
        );
        for (const row of queue.rows?._array ?? []) {
          const match = /^INV-D-(\d{8})-(\d+)$/.exec(
            String(row.pos_invoice_ref ?? '').trim(),
          );
          if (match != null) {
            const day = dayOf(match[1]);
            debtByDay.set(
              day,
              Math.max(debtByDay.get(day) ?? 0, parseInt(match[2], 10)),
            );
          }
        }
      } catch {
        // Very old installs without the table — sales cover it.
      }

      reconcileNeverBackwards(cashByDay, KEYS.invoiceDay, KEYS.invoiceCounter);
      reconcileNeverBackwards(
        debtByDay,
        KEYS.debtInvoiceDay,
        KEYS.debtInvoiceCounter,
      );

      logDiag(
        'sale',
        `تمت مزامنة عدادات الفواتير (نقدي ${getString(
          KEYS.invoiceDay,
          '',
        )} #${getNumber(KEYS.invoiceCounter, 0)} / دين ${getString(
          KEYS.debtInvoiceDay,
          '',
        )} #${getNumber(
          KEYS.debtInvoiceCounter,
          0,
        )}) — لا تتراجع الأرقام أبداً`,
      );
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

  /** v16 (round-22 #1): a FRESH debt number for renumbering a debt
   *  whose upload collided server-side (DUPLICATE_INVOICE_REF after a
   *  reinstall restarted the numbering). Uses the same DB-aware
   *  never-rewind reservation as a new sale. */
  async reserveDebtNumberForRenumber(): Promise<string> {
    return reserveDebtInvoiceNumber();
  },

  /**
   * v16 (round-22 #1): advance the TODAY counters past refs the صِلة
   * server already remembers.
   * ─────────────────────────────────────────────────────────────────
   * The server NEVER forgets a pos_invoice_ref / pos_receipt_ref — a
   * fresh install (or an old-backup restore) can re-issue numbers the
   * server holds from an earlier device, so every upload answers
   * DUPLICATE_*_REF. The refs the server knows are visible in the
   * customers feed (recent_entries / recent_pos_refs) — after pairing
   * and after a restore we bump today's debt + receipt counters beyond
   * the highest sequence seen there, so most new numbers are fresh
   * from the start (the renumber path covers whatever the feed didn't
   * show — it only carries the last entries per customer).
   */
  async advanceCountersFromServerRefs(
    refs: string[],
  ): Promise<{debt: number; receipts: number}> {
    const today = localToday();
    const compact = today.replace(/-/g, '');
    let debtMax = 0;
    let receiptMax = 0;
    for (const raw of refs) {
      const value = String(raw ?? '').trim();
      let match = /^INV-D-(\d{8})-(\d+)$/.exec(value);
      if (match != null) {
        if (match[1] === compact) {
          debtMax = Math.max(debtMax, parseInt(match[2], 10));
        }
        continue;
      }
      match = /^RCP-(\d{8})-(\d+)$/.exec(value);
      if (match != null && match[1] === compact) {
        receiptMax = Math.max(receiptMax, parseInt(match[2], 10));
      }
    }
    // Debt series.
    const debtDay = getString(KEYS.debtInvoiceDay, '');
    const debtCounter = getNumber(KEYS.debtInvoiceCounter, 0);
    const debtNext = Math.max(
      debtDay === today ? debtCounter + 1 : 1,
      debtMax + 1,
    );
    if (debtNext > (debtDay === today ? debtCounter + 1 : 1)) {
      setNumber(KEYS.debtInvoiceCounter, debtNext);
      setString(KEYS.debtInvoiceDay, today);
      logDiag('sale', `تقدّم عداد ديون اليوم خلف صِلة حتى #${debtNext}`);
    }
    // Receipt series.
    const receiptDay = getString(KEYS.paymentReceiptDay, '');
    const receiptCounter = getNumber(KEYS.paymentReceiptCounter, 0);
    const receiptNext = Math.max(
      receiptDay === today ? receiptCounter + 1 : 1,
      receiptMax + 1,
    );
    if (receiptNext > (receiptDay === today ? receiptCounter + 1 : 1)) {
      setNumber(KEYS.paymentReceiptCounter, receiptNext);
      setString(KEYS.paymentReceiptDay, today);
      logDiag('sila', `تقدّم عداد إيصالات اليوم خلف صِلة حتى #${receiptNext}`);
    }
    return {debt: debtMax, receipts: receiptMax};
  },
};
