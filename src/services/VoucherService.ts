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
  /** v22 (round-28 #1): always 0 now — a voucher bigger than the
   *  cart is NEVER completed with a surplus claim; see needsTopUp.
   *  Kept for receipt/report compatibility. */
  surplusMinor: number;
  /** v22 (round-28 #1): TRUE when the cart was SMALLER than the
   *  voucher. The redemption IS booked server-side (the claim on
   *  the institution exists and the campaign books are mirrored),
   *  but NO INV-V sale was created and NO goods may be handed
   *  over — the cashier must top the cart up to at least the
   *  voucher value and complete the handover from the POS banner
   *  (completeCartRedemption). */
  needsTopUp: boolean;
  /** The shortfall (₪ minor) the cart is missing vs the voucher. */
  shortfallMinor: number;
  /** The redemption row's local id (for the deferred completion). */
  localId: number;
}

export interface RedeemVoucherOptions {
  /** Normalized payload from parseSilaVoucherCode(). */
  payload: string;
  /** v24 (round-31 #5): the FLOW this redemption is opened from —
   *   'cart'  → the POS checkout button (purchase coupons ONLY);
   *   'parcel'→ the القسائم tab's parcel button (parcels ONLY).
   *  The API offers no pre-validation endpoint, so the kind is
   *  only known from the server's answer — a mismatch is enforced
   *  the moment it is known: the redemption IS booked (the server
   *  consumed the code atomically — the books must mirror that
   *  truth) but NO goods sale is created and a hard Arabic error
   *  explains the wrong window. Default: derived from the cart. */
  mode?: 'cart' | 'parcel';
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

/** v22 (round-28 #1): books the REDEMPTION itself — the row goes
 *  'ok' with the server's facts and the campaign claim mirror is
 *  written (applyRedeemSnapshot). NO goods sale is created here;
 *  the sale is a separate, explicitly-confirmed step so a cart
 *  smaller than the voucher can never complete as a sale. */
async function bookRedemption(
  row: VoucherRedemptionRow,
  result: SilaVoucherRedeemResult,
): Promise<void> {
  const snapshot = parseSnapshot(row.cart_json);
  const totalMinor = cartTotalMinor(snapshot);
  const counterExtra = Math.max(0, totalMinor - result.value_minor);

  // 1) Book the redemption row (idempotent — a replay after a crash
  //    returns false and the sale is NOT created twice).
  await VouchersRepo.markRedeemed(row.local_id, result, counterExtra);

  // 2) Mirror the campaign snapshot from the SERVER answer (§4.1 —
  //    write it straight into campaign_debts; never compute).
  await VouchersRepo.applyRedeemSnapshot(
    result.campaign_id,
    result.campaign_name,
    result.kind,
    result.settlement,
  );

  // v21 (round-27 #6) / v22 (round-28 #4): the redemption may have
  // ACTIVATED a campaign (a real redemption at this store commits
  // it) — keep the POS cart's قسيمة button counter truthful.
  try {
    void useSilaStore.getState().refreshActiveCampaigns();
  } catch {
    // Store not ready (fresh boot race) — the focus listener recovers.
  }
}

/** Creates the INV-V goods sale from a cart (cart-tied only) —
 *  plain sale + items + stock decrements, exactly like a cash sale;
 *  the claim on the institution lives in campaign_debts. A LOCAL
 *  sale failure never hides the server-side redemption truth. */
async function createGoodsSale(
  row: VoucherRedemptionRow,
  lines: CartLine[],
  discount: number,
  pricingMode: PricingMode,
): Promise<{sale: SaleRecord | null; items: SaleItemRecord[]}> {
  try {
    const created = await SaleRepo.createSale({
      invoiceNumber: row.pos_receipt_ref ?? '',
      lines,
      discount,
      paymentType: pricingMode,
    });
    await VouchersRepo.attachSale(row.local_id, created.sale.id);
    return {sale: created.sale, items: created.items};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logDiag(
      'sila',
      `صُرفت القسيمة ${
        row.pos_receipt_ref ?? ''
      } لكن إنشاء فاتورة البضاعة فشل: ${message}`,
      'warn',
    );
    return {sale: null, items: []};
  }
}

async function bookSuccess(
  row: VoucherRedemptionRow,
  result: SilaVoucherRedeemResult,
): Promise<{sale: SaleRecord | null; items: SaleItemRecord[]}> {
  // 1) The redemption + the campaign claim mirror (v22 split).
  await bookRedemption(row, result);

  // 2) The INV-V sale from the stored snapshot (cart-tied only).
  let sale: SaleRecord | null = null;
  let items: SaleItemRecord[] = [];
  const snapshot = parseSnapshot(row.cart_json);
  if (snapshot != null) {
    const booked = await VouchersRepo.byId(row.local_id);
    if (booked?.sale_id == null) {
      const created = await createGoodsSale(
        row,
        snapshot.lines,
        snapshot.discount,
        snapshot.pricingMode,
      );
      sale = created.sale;
      items = created.items;
    } else {
      // A replay whose sale already exists — load it for the receipt.
      try {
        items = await SaleRepo.getItemsForSale(booked.sale_id);
        const recent = await SaleRepo.listRecent(500);
        sale = recent.find(entry => entry.id === booked.sale_id) ?? null;
      } catch {
        // Receipt without items is acceptable.
      }
    }
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

      // v24 (round-31 #5): STRICT FLOW SEPARATION — purchase coupons
      // redeem ONLY from the POS cart, parcels ONLY from the القسائم
      // tab's parcel button. The server consumed the code the moment
      // it answered (atomic, no undo endpoint), so a mismatch is:
      //   • booked truthfully (the redemption row + the campaign
      //     mirror — the claim exists server-side whatever we do),
      //   • but NO goods sale, NO receipt, and a hard error telling
      //     the cashier exactly what happened and where the code
      //     should have gone. The books never diverge from صِلة.
      const mode = options.mode ?? (options.cart != null ? 'cart' : 'parcel');
      if (mode === 'parcel' && result.kind === 'voucher') {
        await bookRedemption(row, result);
        logDiag(
          'sila',
          `كود قسيمة شرائية (${result.campaign_name}) صُرف من نافذة الطرود — حُسم من الخادم وسُجّل، ولا بضاعة تُسلّم من هنا`,
          'warn',
        );
        throw new VoucherRedeemError(
          `هذا كود قسيمة شرائية لحملة «${result.campaign_name}» — القسائم الشرائية تُصرف من سلة البيع فقط (زر قسيمة في شاشة البيع).\nالكود حُسم من خادم صِلة باسم متجرك وسُجّل في سجل الصرف — لا تُسلّم بضاعة من هنا، وراجع سجل الصرف في صفحة القسائم أو تواصل مع دعم صِلة لتسويتها.`,
          true,
          false,
        );
      }
      if (mode === 'cart' && result.kind === 'parcel') {
        await bookRedemption(row, result);
        logDiag(
          'sila',
          `كود طرد (${result.campaign_name}) صُرف من سلة البيع — حُسم من الخادم وسُجّل، ولا تُسلّم بضاعة من هنا`,
          'warn',
        );
        throw new VoucherRedeemError(
          `هذا كود طرد لحملة «${result.campaign_name}» — الطرود تُصرف من صفحة القسائم في دفتر صِلة فقط (زر صرف الطرد).\nالكود حُسم من خادم صِلة باسم متجرك وسُجّل في سجل الصرف — لم تُنشأ فاتورة بضاعة والسلة كما هي، راجع سجل الصرف في صفحة القسائم أو تواصل مع دعم صِلة لتسويته.`,
          true,
          false,
        );
      }

      const snapshot = parseSnapshot(row.cart_json);
      const totalMinor = cartTotalMinor(snapshot);

      // v22 (round-28 #1): THE redemption rule — a voucher BIGGER
      // than the cart is never completed. The server call is atomic
      // and the voucher is consumed the moment it answers (there is
      // no validation endpoint in the API), so the enforcement lands
      // here: the redemption + the claim on the institution are
      // booked (server truth), but NO sale is created, NOTHING is
      // printed and NO goods may be handed over. The cashier tops
      // the cart up and completes from the POS banner
      // (completeCartRedemption).
      if (snapshot != null && totalMinor < result.value_minor) {
        await bookRedemption(row, result);
        logDiag(
          'sila',
          `قسيمة ${result.reference_code} بقيمة ${
            result.value_minor / 100
          } ₪ أكبر من السلة (${
            totalMinor / 100
          } ₪) — حُجز الصرف ولا يُسلَّم حتى تكملة السلة بفارق ${
            (result.value_minor - totalMinor) / 100
          } ₪`,
          'warn',
        );
        return {
          result,
          receiptRef,
          sale: null,
          items: [],
          cartMinor: totalMinor,
          counterExtraMinor: 0,
          surplusMinor: 0,
          needsTopUp: true,
          shortfallMinor: result.value_minor - totalMinor,
          localId: row.local_id,
        };
      }

      const {sale, items} = await bookSuccess(row, result);
      const counterExtra = Math.max(0, totalMinor - result.value_minor);

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
        surplusMinor: 0,
        needsTopUp: false,
        shortfallMinor: 0,
        localId: row.local_id,
      };
    } catch (error) {
      // v24 (round-31 #5): a flow-mismatch error thrown above is
      // ALREADY booked and carries its own cashier-ready message —
      // pass it through untouched (markRetry here would flip the
      // just-booked 'ok' row back to 'pending').
      if (error instanceof VoucherRedeemError) {
        throw error;
      }
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
   * v22 (round-28 #1): completes a NEEDS-TOP-UP redemption — the
   * server already redeemed the voucher (the claim exists), the
   * cashier has now topped the cart up to at least the voucher
   * value, and the goods sale + receipt land HERE. Idempotent: a
   * redemption whose sale already exists just returns it. Throws
   * VoucherRedeemError (permanent) while the cart is still short.
   */
  async completeCartRedemption(
    localId: number,
    cart: {
      lines: CartLine[];
      discount: number;
      pricingMode: PricingMode;
    },
    print: boolean,
    receiptSettings: ReceiptSettings,
    onPrintError?: (message: string) => void,
  ): Promise<VoucherRedeemSuccess> {
    const row = await VouchersRepo.byId(localId);
    if (row == null) {
      throw new VoucherRedeemError(
        'لم يُعثر على عملية الصرف المعلّقة — راجع سجل الصرف في صفحة القسائم',
        true,
        false,
      );
    }
    if (row.state !== 'ok') {
      throw new VoucherRedeemError(
        'هذه القسيمة لم تُحسم بعد — لا يمكن إتمام التسليم قبل نجاح الصرف',
        true,
        false,
      );
    }

    const subtotal = cart.lines.reduce(
      (sum, line) => sum + line.unitPrice * line.quantity,
      0,
    );
    const discount = Math.min(Math.max(cart.discount, 0), subtotal);
    const totalMinor = Math.round((subtotal - discount) * 100);
    if (totalMinor < row.value_minor) {
      throw new VoucherRedeemError(
        `قيمة السلة ما زالت أقل من قيمة القسيمة — أضف بضاعة بفارق ${(
          (row.value_minor - totalMinor) /
          100
        ).toFixed(2)} ₪ على الأقل ثم أعد المحاولة`,
        true,
        false,
      );
    }
    const counterExtra = totalMinor - row.value_minor;
    await VouchersRepo.updateCounterExtra(localId, counterExtra);

    // Idempotent — create the goods sale only once.
    let sale: SaleRecord | null = null;
    let items: SaleItemRecord[] = [];
    if (row.sale_id == null) {
      const created = await createGoodsSale(
        row,
        cart.lines,
        cart.discount,
        cart.pricingMode,
      );
      sale = created.sale;
      items = created.items;
    } else {
      try {
        items = await SaleRepo.getItemsForSale(row.sale_id);
        const recent = await SaleRepo.listRecent(500);
        sale = recent.find(entry => entry.id === row.sale_id) ?? null;
      } catch {
        // Receipt without items is acceptable.
      }
    }

    if (print) {
      try {
        const names = new Map<number, string>();
        for (const line of cart.lines) {
          names.set(line.productId, line.name);
        }
        const job = buildVoucherReceiptJob(
          {
            receiptRef: row.pos_receipt_ref ?? '',
            redeemedAt: row.redeemed_at,
            campaignName: row.campaign_name ?? 'حملة صلة',
            beneficiaryLast4: row.beneficiary_last4,
            valueMinor: row.value_minor,
            referenceCode: row.reference_code,
            sale,
            items,
            productNameById: names,
          },
          receiptSettings,
        );
        await ThermalPrinterService.printJob(job);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logDiag('sila', `اكتمل الصرف لكن الطباعة فشلت: ${message}`, 'warn');
        onPrintError?.(message);
      }
    }

    return {
      result: {
        ok: true,
        reference_code: row.reference_code ?? '',
        voucher_id: row.voucher_id ?? '',
        value_minor: row.value_minor,
        currency: 'ILS',
        kind: row.campaign_kind ?? 'voucher',
        campaign_id: row.campaign_id ?? '',
        campaign_name: row.campaign_name ?? 'حملة صلة',
        beneficiary_last4: row.beneficiary_last4,
        merchant_name: '',
        redeemed_at: row.redeemed_at,
        settlement: {
          redeemed_value_minor: 0,
          settled_minor: 0,
          due_minor: 0,
          state: 'none',
        },
      },
      receiptRef: row.pos_receipt_ref ?? '',
      sale,
      items,
      cartMinor: totalMinor,
      counterExtraMinor: counterExtra,
      surplusMinor: 0,
      needsTopUp: false,
      shortfallMinor: 0,
      localId,
    };
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
