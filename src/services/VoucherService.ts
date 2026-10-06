/**
 * VoucherService — the orchestration behind «صرف قسيمة صلة»
 * (SILA_POS_VOUCHERS_API §4.1/§5/§7).
 * ─────────────────────────────────────────────────────────────────
 * ONE live call per redemption — the voucher is a GLOBAL atomic
 * reservation (it may be redeemed in another store this very
 * second), so redemption is NEVER queued offline (§5 rule 1):
 *
 *   reserve INV-V-… → insert the pending attempt row (ONE
 *   idempotency_key forever + the cart snapshot) → LIVE redeem →
 *     ok       → book the row + create the INV-V sale (stock
 *                decrements, cart-tied only) + mirror the campaign
 *                snapshot + print (§7.1: goods are handed over ONLY
 *                after ok:true).
 *     transient→ the row stays pending; the sync engine retries the
 *                LIVE call with the SAME key (§7.3) and completes
 *                the sale when it lands.
 *     permanent→ failed row with a clear Arabic reason — no goods.
 *
 * Accounting (§2): the redemption is a SALE for the store and a
 * CLAIM on the institution (campaign_debts) — never a debt on the
 * beneficiary, whose account is never touched.
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
import {buildVoucherReceiptJob} from './printer/voucherReceipt';
import {ThermalPrinterService} from './printer/ThermalPrinterService';
import {VouchersRepo} from './sila/VouchersRepo';
import {
  silaRedeemVoucher,
  SilaApiError,
  silaVoucherErrorAdvice,
  type SilaVoucherRedeemResult,
} from './sila/SilaApi';
import {uuidV4} from './sila/qr';
import {useSilaStore} from '../stores/silaStore';
import {APP_VERSION} from '../core/config';
import type {
  CartLine,
  PricingMode,
  SaleRecord,
  SaleItemRecord,
  VoucherRedemptionRow,
} from '../core/types';
import type {ReceiptSettings} from './printer/receipt';

// ── INV-V-YYYYMMDD-NNNN — the VOUCHER series (v20) ───────────────
// Its own never-backwards counter, reconciled with BOTH tables that
// can remember voucher numbers (sales + voucher_redemptions), the
// same discipline as the INV-D series (v14): a restored backup can
// never make a fresh redemption collide with a receipt ref the صِلة
// server already holds (pos_receipt_ref UNIQUE per store, §4.1).

function formatVoucherInvoiceNumber(day: string, seq: number): string {
  return `INV-V-${day.replace(/-/g, '')}-${String(seq).padStart(4, '0')}`;
}

function voucherInvoiceSequence(number: string): number {
  const match = /^(?:INV-V-\d{8}-)?(\d+)$/.exec(String(number ?? '').trim());
  return match ? parseInt(match[1], 10) : 0;
}

async function maxVoucherSequenceInDb(prefix: string): Promise<number> {
  let max = 0;
  const consider = (value: unknown) => {
    const seq = voucherInvoiceSequence(String(value ?? ''));
    if (seq > max) {
      max = seq;
    }
  };
  try {
    const sales = await getDb().execute(
      'SELECT invoice_number FROM sales WHERE invoice_number LIKE ?',
      [`${prefix}%`],
    );
    for (const row of sales.rows?._array ?? []) {
      consider((row as {invoice_number?: string}).invoice_number);
    }
  } catch {
    // Best effort — the MMKV counter alone stays monotonic.
  }
  try {
    const redemptions = await getDb().execute(
      'SELECT pos_receipt_ref FROM voucher_redemptions WHERE pos_receipt_ref LIKE ?',
      [`${prefix}%`],
    );
    for (const row of redemptions.rows?._array ?? []) {
      consider((row as {pos_receipt_ref?: string}).pos_receipt_ref);
    }
  } catch {
    // Table missing on very old installs — ignore.
  }
  return max;
}

export async function reserveVoucherInvoiceNumber(): Promise<string> {
  const today = localToday();
  const prefix = `INV-V-${today.replace(/-/g, '')}-`;
  const dbMax = await maxVoucherSequenceInDb(prefix);
  const lastDay = getString(KEYS.voucherInvoiceDay, '');
  const counter = getNumber(KEYS.voucherInvoiceCounter, 0);
  const mmkvNext = lastDay === today ? counter + 1 : 1;
  const next = Math.max(mmkvNext, dbMax + 1);
  setNumber(KEYS.voucherInvoiceCounter, next);
  setString(KEYS.voucherInvoiceDay, today);
  return formatVoucherInvoiceNumber(today, next);
}

// ── The cart snapshot (crash-safe delayed completion) ────────────

interface CartSnapshot {
  lines: CartLine[];
  discount: number;
  pricingMode: PricingMode;
}

function snapshotCart(
  lines: CartLine[],
  discount: number,
  pricingMode: PricingMode,
): string | null {
  if (lines.length === 0) {
    return null;
  }
  return JSON.stringify({lines, discount, pricingMode} as CartSnapshot);
}

function parseSnapshot(json: string | null): CartSnapshot | null {
  if (!json) {
    return null;
  }
  try {
    const parsed = JSON.parse(json) as CartSnapshot;
    if (!Array.isArray(parsed.lines) || parsed.lines.length === 0) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function cartTotalMinor(snapshot: CartSnapshot | null): number {
  if (snapshot == null) {
    return 0;
  }
  const subtotal = snapshot.lines.reduce(
    (sum, line) => sum + line.unitPrice * line.quantity,
    0,
  );
  const discount = Math.min(Math.max(snapshot.discount, 0), subtotal);
  return Math.round((subtotal - discount) * 100);
}

// ── Result types ─────────────────────────────────────────────────

export interface VoucherRedeemSuccess {
  result: SilaVoucherRedeemResult;
  receiptRef: string;
  sale: SaleRecord | null;
  items: SaleItemRecord[];
  /** Cart goods value (₪ minor) when cart-tied. */
  cartMinor: number | null;
  /** Cash the beneficiary paid at the counter (cart > voucher). */
  counterExtraMinor: number;
  /** Surplus the store claims from the institution (voucher > cart). */
  surplusMinor: number;
}

export interface RedeemVoucherOptions {
  /** Normalized payload from parseSilaVoucherCode(). */
  payload: string;
  /** The cart to sell as the voucher's goods (optional — standalone
   *  redemptions like parcel campaigns carry no cart). */
  cart?: {
    lines: CartLine[];
    discount: number;
    pricingMode: PricingMode;
  } | null;
  print: boolean;
  receiptSettings: ReceiptSettings;
  onPrintError?: (message: string) => void;
}

/** Thrown to the UI with a cashier-ready Arabic message. */
export class VoucherRedeemError extends Error {
  readonly permanent: boolean;
  readonly pendingRetry: boolean;
  constructor(message: string, permanent: boolean, pendingRetry: boolean) {
    super(message);
    this.name = 'VoucherRedeemError';
    this.permanent = permanent;
    this.pendingRetry = pendingRetry;
  }
}

// ── The booking step (shared by the live path + the sync engine) ──

async function bookSuccess(
  row: VoucherRedemptionRow,
  result: SilaVoucherRedeemResult,
): Promise<{sale: SaleRecord | null; items: SaleItemRecord[]}> {
  const snapshot = parseSnapshot(row.cart_json);
  const totalMinor = cartTotalMinor(snapshot);
  const counterExtra = Math.max(0, totalMinor - result.value_minor);

  // 1) Book the redemption row (idempotent — a replay after a crash
  //    returns false and the sale is NOT created twice).
  const booked = await VouchersRepo.markRedeemed(
    row.local_id,
    result,
    counterExtra,
  );

  // 2) Create the INV-V sale from the snapshot (cart-tied only) —
  //    plain sale + items + stock decrements, exactly like a cash
  //    sale; the claim on the institution lives in campaign_debts.
  let sale: SaleRecord | null = null;
  let items: SaleItemRecord[] = [];
  if (booked && snapshot != null) {
    try {
      const created = await SaleRepo.createSale({
        invoiceNumber: row.pos_receipt_ref ?? '',
        lines: snapshot.lines,
        discount: snapshot.discount,
        paymentType: snapshot.pricingMode,
      });
      sale = created.sale;
      items = created.items;
      await VouchersRepo.attachSale(row.local_id, created.sale.id);
    } catch (error) {
      // The redemption itself SUCCEEDED server-side — a local sale
      // failure (e.g. stock drift) must never hide that truth. The
      // row stays ok; the merchant resolves stock via a stocktake.
      const message = error instanceof Error ? error.message : String(error);
      logDiag(
        'sila',
        `صُرفت القسيمة ${result.reference_code} لكن إنشاء فاتورة البضاعة فشل: ${message}`,
        'warn',
      );
    }
  } else if (!booked) {
    // A replay whose sale already exists — load it for the receipt.
    const fresh = await VouchersRepo.byId(row.local_id);
    if (fresh?.sale_id != null) {
      try {
        items = await SaleRepo.getItemsForSale(fresh.sale_id);
        const recent = await SaleRepo.listRecent(500);
        sale = recent.find(entry => entry.id === fresh.sale_id) ?? null;
      } catch {
        // Receipt without items is acceptable.
      }
    }
  }

  // 3) Mirror the campaign snapshot from the SERVER answer (§4.1 —
  //    write it straight into campaign_debts; never compute).
  await VouchersRepo.applyRedeemSnapshot(
    result.campaign_id,
    result.campaign_name,
    result.kind,
    result.settlement,
  );

  // v21 (round-27 #6): the redemption may have ACTIVATED a campaign
  // (first redemption at this store flips its switch on) — keep the
  // POS cart's قسيمة button counter truthful. Fire-and-forget.
  try {
    void useSilaStore.getState().refreshActiveCampaigns();
  } catch {
    // Store not ready (fresh boot race) — the focus listener recovers.
  }

  return {sale, items};
}

export const VoucherService = {
  /**
   * The LIVE redemption flow (§7.1). Throws VoucherRedeemError with
   * a cashier-ready Arabic message on every failure path; the goods
   * are handed over ONLY when this resolves.
   */
  async redeemVoucher(
    options: RedeemVoucherOptions,
  ): Promise<VoucherRedeemSuccess> {
    const pairing = useSilaStore.getState().pairing;
    if (pairing == null) {
      throw new VoucherRedeemError(
        'الجهاز غير مرتبط بصِلة — اربط حساب التاجر أولاً من صفحة صِلة',
        true,
        false,
      );
    }

    const receiptRef = await reserveVoucherInvoiceNumber();
    const redeemedAt = new Date().toISOString();
    const row = await VouchersRepo.createRedemption({
      idempotencyKey: uuidV4(),
      payload: options.payload,
      posReceiptRef: receiptRef,
      redeemedAt,
      cartJson: options.cart
        ? snapshotCart(
            options.cart.lines,
            options.cart.discount,
            options.cart.pricingMode,
          )
        : null,
    });

    try {
      const result = await silaRedeemVoucher(
        pairing,
        {
          payload: options.payload,
          pos_receipt_ref: receiptRef,
          idempotency_key: row.idempotency_key,
          redeemed_at: redeemedAt,
        },
        APP_VERSION,
      );

      const {sale, items} = await bookSuccess(row, result);
      const snapshot = parseSnapshot(row.cart_json);
      const totalMinor = cartTotalMinor(snapshot);
      const counterExtra = Math.max(0, totalMinor - result.value_minor);
      const surplus = Math.max(0, result.value_minor - totalMinor);

      if (options.print) {
        try {
          const names = new Map<number, string>();
          if (options.cart) {
            for (const line of options.cart.lines) {
              names.set(line.productId, line.name);
            }
          } else {
            for (const item of items) {
              if (!names.has(item.product_id)) {
                const product = await ProductRepo.getById(item.product_id);
                names.set(
                  item.product_id,
                  product?.name ?? `#${item.product_id}`,
                );
              }
            }
          }
          const job = buildVoucherReceiptJob(
            {
              receiptRef,
              redeemedAt,
              campaignName: result.campaign_name,
              beneficiaryLast4: result.beneficiary_last4,
              valueMinor: result.value_minor,
              referenceCode: result.reference_code,
              sale,
              items,
              productNameById: names,
            },
            options.receiptSettings,
          );
          await ThermalPrinterService.printJob(job);
        } catch (error) {
          // The redemption IS booked — printing failure must never
          // hide that (the receipt can be reprinted from القسائم).
          const message =
            error instanceof Error ? error.message : String(error);
          logDiag('sila', `الصرف تم لكن الطباعة فشلت: ${message}`, 'warn');
          options.onPrintError?.(message);
        }
      }

      return {
        result,
        receiptRef,
        sale,
        items,
        cartMinor: snapshot ? totalMinor : null,
        counterExtraMinor: counterExtra,
        surplusMinor: surplus,
      };
    } catch (error) {
      if (error instanceof SilaApiError) {
        const advice = silaVoucherErrorAdvice(error.code);
        if (
          error.errorClass === 'transient' ||
          error.errorClass === 'conflict'
        ) {
          // §7.3: keep the row pending — the engine replays the SAME
          // idempotency key on a live call until it resolves.
          await VouchersRepo.markRetry(row.local_id);
          throw new VoucherRedeemError(
            `${advice}\n(العملية محفوظة وستُكمل تلقائياً عند عودة الاتصال — لا تُسلَّم البضاعة بعد)`,
            false,
            true,
          );
        }
        if (error.errorClass === 'device' || error.errorClass === 'forbidden') {
          // Device/contract problems are NOT the voucher's fault —
          // the row stays pending until the merchant re-pairs (the
          // §8 debt-engine guarantee, applied to vouchers too).
          await VouchersRepo.markRetry(row.local_id);
          throw new VoucherRedeemError(advice, false, true);
        }
        await VouchersRepo.markFailed(row.local_id, error.code, advice);
        throw new VoucherRedeemError(advice, true, false);
      }
      const message = error instanceof Error ? error.message : String(error);
      await VouchersRepo.markRetry(row.local_id);
      throw new VoucherRedeemError(`تعذر صرف القسيمة: ${message}`, false, true);
    }
  },

  /**
   * §7.3 — completes a pending attempt when connectivity returns.
   * Called by the sync engine with the SAME idempotency key; the
   * server answers ok (or idempotent_replay) exactly once, or ends
   * the attempt with a permanent failure.
   */
  async completePendingRedemption(
    row: VoucherRedemptionRow,
  ): Promise<'ok' | 'failed' | 'retry'> {
    const pairing = useSilaStore.getState().pairing;
    if (pairing == null) {
      return 'retry';
    }
    try {
      const result = await silaRedeemVoucher(
        pairing,
        {
          payload: row.payload,
          pos_receipt_ref: row.pos_receipt_ref ?? undefined,
          idempotency_key: row.idempotency_key,
          redeemed_at: row.redeemed_at,
        },
        APP_VERSION,
      );
      await bookSuccess(row, result);
      logDiag(
        'sila',
        `اكتمل صرف قسيمة ${result.reference_code} — ${result.campaign_name}`,
      );
      return 'ok';
    } catch (error) {
      if (error instanceof SilaApiError) {
        if (
          error.errorClass === 'transient' ||
          error.errorClass === 'conflict' ||
          error.errorClass === 'device' ||
          error.errorClass === 'forbidden'
        ) {
          await VouchersRepo.markRetry(row.local_id);
          return 'retry';
        }
        const advice = silaVoucherErrorAdvice(error.code);
        await VouchersRepo.markFailed(row.local_id, error.code, advice);
        return 'failed';
      }
      await VouchersRepo.markRetry(row.local_id);
      return 'retry';
    }
  },

  /** Reprints a redemption receipt from the local row (القسائم tab
   *  + the invoices center INV-V routing). */
  async reprintByReceiptRef(
    receiptRef: string,
    settings: ReceiptSettings,
  ): Promise<void> {
    const row = await VouchersRepo.byReceiptRef(receiptRef);
    if (row == null) {
      throw new Error('هذا ليس إيصال صرف قسيمة');
    }
    let sale: SaleRecord | null = null;
    let items: SaleItemRecord[] = [];
    const names = new Map<number, string>();
    if (row.sale_id != null) {
      items = await SaleRepo.getItemsForSale(row.sale_id);
      const recent = await SaleRepo.listRecent(500);
      sale = recent.find(entry => entry.id === row.sale_id) ?? null;
      for (const item of items) {
        if (!names.has(item.product_id)) {
          const product = await ProductRepo.getById(item.product_id);
          names.set(item.product_id, product?.name ?? `#${item.product_id}`);
        }
      }
    }
    const job = buildVoucherReceiptJob(
      {
        receiptRef: row.pos_receipt_ref ?? receiptRef,
        redeemedAt: row.redeemed_at,
        campaignName: row.campaign_name ?? 'حملة صِلة',
        beneficiaryLast4: row.beneficiary_last4,
        valueMinor: row.value_minor,
        referenceCode: row.reference_code,
        sale,
        items,
        productNameById: names,
      },
      settings,
    );
    await ThermalPrinterService.printJob(job);
  },
};
