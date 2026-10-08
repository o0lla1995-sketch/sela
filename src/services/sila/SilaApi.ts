/**
 * sila/SilaApi — HTTP client for the SILA POS endpoints (§6).
 * ─────────────────────────────────────────────────────────────────
 * All calls carry short timeouts (the POS is offline most of the
 * time — a hanging request must never block the cashier) and every
 * failure is classified per §11 so the sync engine knows whether to
 * retry (transient), stop (device) or surface to the merchant
 * (permanent).
 *
 * Base URL is configurable (§14) — default is the live server.
 */
import type {SilaPairing} from '../../core/types';
import {logDiag} from '../../core/diagnostics';

export const SILA_DEFAULT_BASE_URL = 'https://sila.pornxvideo.com';

/** §11 classification — drives every sync decision. v20: the
 *  vouchers API (§9) adds the 'forbidden' class — the device is
 *  fine and the voucher is fine, but the STORE is not contracted in
 *  that campaign (a merchant-contract issue, not a retry case). */
export type SilaErrorClass =
  | 'transient'
  | 'permanent'
  | 'device'
  | 'conflict'
  | 'forbidden';

export class SilaApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly errorClass: SilaErrorClass;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'SilaApiError';
    this.status = status;
    this.code = code;
    this.errorClass = classifySilaError(status, code);
  }
}

/** §11 — permanent server-side codes (no retry, merchant attention). */
const PERMANENT_CODES = new Set([
  'INVALID_SIGNATURE',
  'KEY_EXPIRED',
  'TOKEN_EXPIRED',
  'NONCE_REUSED',
  'CARD_EXPIRED',
  'CUSTOMER_NOT_ON_SILA',
  'CUSTOMER_NOT_FOUND',
  'AMOUNT_INVALID',
  'AMOUNT_EXCEEDS_OFFLINE_LIMIT',
  'AMOUNT_EXCEEDS_LIMIT',
  'MALFORMED_TOKEN',
  'MALFORMED_CARD',
  'WRONG_TOKEN_TYPE',
  'INVALID_CUSTOMER_ID',
  'INVOICE_REF_REQUIRED',
  'IDEMPOTENCY_KEY_REQUIRED',
  'DUPLICATE_INVOICE_REF',
  // v15 (round-21 #3 — §2.5): payments-endpoint codes.
  'DUPLICATE_RECEIPT_REF',
  'RECEIPT_REF_REQUIRED',
  'NO_DEBT_RELATIONSHIP',
  'RELATIONSHIP_NOT_ACTIVE',
  'VALIDATION_ERROR',
  'INVALID_JSON',
]);

const DEVICE_CODES = new Set(['DEVICE_INVALID', 'UNAUTHENTICATED']);
const CONFLICT_CODES = new Set(['IDEMPOTENT_MISMATCH']);

/** v20 (SILA_POS_VOUCHERS_API §9 — الصلاحية): 403 codes that are a
 *  merchant-contract problem, not a voucher or device problem —
 *  surfaced to the merchant, never retried. */
const FORBIDDEN_CODES = new Set([
  'MERCHANT_NOT_IN_CAMPAIGN',
  'MERCHANT_ORG_NOT_FOUND',
]);

/** v20 (SILA_POS_VOUCHERS_API §9 — دائم): voucher redemption codes
 *  that end the attempt for good (no retry, no goods delivered). */
const VOUCHER_PERMANENT_CODES = new Set([
  'VOUCHER_NOT_FOUND',
  'VOUCHER_ALREADY_REDEEMED',
  'VOUCHER_CANCELLED',
  'VOUCHER_EXPIRED',
  'INVALID_SIGNATURE',
  'CODE_MISMATCH',
  'INVALID_PAYLOAD_FORMAT',
  'CAMPAIGN_NOT_ACTIVE',
  'CAMPAIGN_PERIOD_ENDED',
  'EMPTY_PAYLOAD',
]);

export function classifySilaError(
  status: number,
  code: string,
): SilaErrorClass {
  if (CONFLICT_CODES.has(code)) {
    return 'conflict';
  }
  if (DEVICE_CODES.has(code)) {
    return 'device';
  }
  if (FORBIDDEN_CODES.has(code)) {
    return 'forbidden';
  }
  if (status === 401) {
    return 'device';
  }
  if (status === 403) {
    // An unknown 403 is still a merchant-contract/permission issue —
    // never a retry case.
    return 'forbidden';
  }
  if (PERMANENT_CODES.has(code) || VOUCHER_PERMANENT_CODES.has(code)) {
    return 'permanent';
  }
  // v21 (round-27 #4 — the wrong-code redemption that hung forever):
  // a 4xx answer whose body carried NO recognizable SILA code used to
  // fall through here as transient (HTTP_404 / HTTP_400 …), so a
  // wrong voucher code on a healthy connection left the redemption
  // «pending — waiting for connectivity» forever. HTTP semantics fix
  // it: 408 (timeout) and 429 (throttle) are the ONLY retryable 4xx —
  // every other client error is permanent (retrying the same wrong
  // code can never succeed), and 5xx stays transient.
  if (status === 408 || status === 429) {
    return 'transient';
  }
  if (status >= 400 && status < 500) {
    return 'permanent';
  }
  // 429 / 5xx / timeouts / network / leaked PG codes → retry later.
  return 'transient';
}

/** v12 (round-18 #1): the live API sometimes swaps the two error
 * fields — the `error` slot carries a raw PostgreSQL ERRCODE
 * ("42501", "22023"…) while the real SILA code sits in `message`
 * ("DEVICE_INVALID", "PAIRING_CODE_INVALID"). This predicate
 * recognises real SILA codes so toApiError can recover the swap. */
const SILA_CODE_RE = /^[A-Z][A-Z0-9_]{3,39}$/;

function looksLikeSilaCode(value: unknown): value is string {
  return typeof value === 'string' && SILA_CODE_RE.test(value);
}

/** Arabic, merchant-readable explanation for a permanent error. */
export function silaErrorAdvice(code: string): string {
  switch (code) {
    case 'TOKEN_EXPIRED':
      return 'انتهت صلاحية رمز الزبون — اطلب منه توليد رمز جديد ثم أعد التسجيل';
    case 'CARD_EXPIRED':
      return 'انتهت صلاحية بطاقة الزبون (أكثر من 30 يوماً) — اطلب منه فتح «بطاقتي» من جديد';
    case 'INVALID_SIGNATURE':
    case 'MALFORMED_TOKEN':
    case 'MALFORMED_CARD':
    case 'WRONG_TOKEN_TYPE':
      return 'الرمز الممسوح غير سليم — اطلب من الزبون توليد رمز جديد';
    case 'NONCE_REUSED':
      return 'هذا الرمز استُخدم مسبقاً — اطلب رمزاً جديداً من الزبون';
    case 'CUSTOMER_NOT_ON_SILA':
    case 'CUSTOMER_NOT_FOUND':
    case 'INVALID_CUSTOMER_ID':
      return 'الزبون غير مسجل في صِلة — لا يمكن تسجيل الدين عليه';
    case 'AMOUNT_EXCEEDS_OFFLINE_LIMIT':
      return 'المبلغ يتجاوز سقف الرمز الموقّع (₪500) — استخدم بطاقة الزبون بدلاً منه';
    case 'AMOUNT_INVALID':
    case 'AMOUNT_EXCEEDS_LIMIT':
      return 'المبلغ غير مقبول — راجع الفاتورة';
    case 'AMOUNT_EXCEEDS_DEVICE_DEBT':
      return 'المبلغ أكبر من دين هذا الزبون لدى متجرك أنت (فواتير متجرك) — '
        + 'كاشير متجرك يحصّل ديون متجرك فقط؛ إن كانت لديك فواتير دين لم تُرفع بعد فانتظر المزامنة ثم أعد المحاولة';
    case 'DUPLICATE_INVOICE_REF':
      return 'هذه الفاتورة مسجلة ديناً مسبقاً — لا يمكن تكرارها';
    case 'DUPLICATE_RECEIPT_REF':
      return 'إيصال السداد مسجل مسبقاً في صِلة — لن يتكرر';
    case 'RECEIPT_REF_REQUIRED':
      return 'رقم إيصال السداد مفقود — راجع العملية';
    case 'NO_DEBT_RELATIONSHIP':
      return 'لا توجد علاقة دين بين هذا الزبون والمتجر في صِلة — تحقق من هوية الزبون';
    case 'DUPLICATE_RECEIPT_REF':
      return 'إيصال السداد مسجل مسبقاً في صِلة — لن يتكرر';
    case 'RECEIPT_REF_REQUIRED':
      return 'رقم إيصال السداد مفقود — راجع العملية';
    case 'NO_DEBT_RELATIONSHIP':
      return 'لا توجد علاقة دين بين هذا الزبون والمتجر في صِلة — تحقق من هوية الزبون';
    case 'INVOICE_REF_REQUIRED':
    case 'IDEMPOTENCY_KEY_REQUIRED':
    case 'VALIDATION_ERROR':
    case 'INVALID_JSON':
      return 'خطأ في بيانات السجل — راجع الفاتورة أو تواصل مع الدعم';
    case 'RELATIONSHIP_NOT_ACTIVE':
      return 'علاقة الزبون مع المتجر غير مفعّلة في صِلة';
    case 'DEVICE_INVALID':
      return 'ربط هذا الجهاز ملغى أو منتهٍ — أعد الربط برمز جديد من تطبيق صِلة';
    case 'UNAUTHENTICATED':
      return 'الجهاز غير مرتبط بصِلة — أعد الربط من الإعدادات';
    case 'PAIRING_CODE_INVALID':
      return 'رمز الربط غير صحيح أو منتهٍ — ولّد رمزاً جديداً من تطبيق صِلة وأعد المحاولة';
    case 'IDEMPOTENT_MISMATCH':
      return 'تضارب تقني في مفتاح العملية — تواصل مع الدعم';
    default:
      return 'تعذر تسجيل الدين في صِلة — راجع تفاصيل الفاتورة';
  }
}

/** v20 (SILA_POS_VOUCHERS_API §9): Arabic, cashier-readable advice
 *  for a failed voucher redemption — every permanent/forbidden
 *  code gets a clear «no goods» instruction. */
export function silaVoucherErrorAdvice(code: string): string {
  switch (code) {
    case 'VOUCHER_NOT_FOUND':
      return 'القسيمة غير موجودة — تأكد من الكود أو رمز الـ QR وحاول مجدداً';
    case 'VOUCHER_ALREADY_REDEEMED':
      return 'هذه القسيمة صُرفت مسبقاً (ربما في متجر آخر) — لا تُسلَّم البضاعة';
    case 'VOUCHER_CANCELLED':
      return 'القسيمة ملغاة من المؤسسة — لا تُسلَّم البضاعة';
    case 'VOUCHER_EXPIRED':
      return 'القسيمة منتهية الصلاحية — لا تُسلَّم البضاعة';
    case 'INVALID_SIGNATURE':
    case 'CODE_MISMATCH':
    case 'INVALID_PAYLOAD_FORMAT':
    case 'EMPTY_PAYLOAD':
      return 'رمز القسيمة غير سليم — أعد المسح أو اطلب من المستحق إظهار رمز جديد';
    case 'CAMPAIGN_NOT_ACTIVE':
      return 'الحملة غير مفعّلة حالياً — لا يمكن صرف هذه القسيمة';
    case 'CAMPAIGN_PERIOD_ENDED':
      return 'انتهت مدة الحملة — لا يمكن صرف هذه القسيمة';
    case 'DUPLICATE_RECEIPT_REF':
      return 'رقم الإيصال مستخدم لعملية صرف سابقة — راجع سجل القسائم';
    case 'MERCHANT_NOT_IN_CAMPAIGN':
      return 'متجرك غير متعاقد في هذه الحملة — راجع دعوة المؤسسة في تطبيق صِلة';
    case 'MERCHANT_ORG_NOT_FOUND':
      return 'حساب المتجر موقوف في صِلة — تواصل مع الدعم';
    case 'DEVICE_INVALID':
      return 'ربط هذا الجهاز ملغى أو منتهٍ — أعد الربط برمز جديد من تطبيق صِلة';
    case 'UNAUTHENTICATED':
      return 'الجهاز غير مرتبط بصِلة — أعد الربط من إعدادات صِلة';
    case 'VALIDATION_ERROR':
    case 'INVALID_JSON':
      return 'خطأ في بيانات الصرف — راجع الرمز أو تواصل مع الدعم';
    // v21 (round-27 #4): an HTTP-level rejection with NO recognizable
    // SILA code in the body (a bare 404 «Not Found» text page, a 400
    // with an unexpected shape…) — almost always a wrong/unknown
    // voucher code or payload. Cashier-ready wording, and NEVER a
    // pending retry (classifySilaError already made it permanent).
    case 'HTTP_400':
    case 'HTTP_404':
    case 'HTTP_405':
    case 'HTTP_422':
      return 'الكود غير صحيح أو القسيمة غير موجودة — تأكد من الكود العشريني أو أعد مسح رمز الـ QR';
    default:
      return 'تعذر صرف القسيمة — لا تُسلَّم البضاعة حتى تنجح العملية';
  }
}

const HEALTH_TIMEOUT_MS = 12000;
const CALL_TIMEOUT_MS = 20000;

interface SilaEndpoint {
  baseUrl: string;
  token: string | null;
}

function endpointOf(
  pairing: SilaPairing | null,
  baseUrlOverride?: string,
): SilaEndpoint {
  const baseUrl = (
    baseUrlOverride ||
    pairing?.apiBaseUrl ||
    SILA_DEFAULT_BASE_URL
  ).replace(/\/+$/, '');
  return {baseUrl, token: pairing?.posToken ?? null};
}

async function silaFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {...init, signal: controller.signal});
  } finally {
    clearTimeout(timer);
  }
}

/** Parses the JSON error body {error, message?} into SilaApiError.
 *  v12 (round-18 #1): field-swap tolerant — when `error` is NOT a
 *  real SILA code (e.g. a leaked Postgres ERRCODE like "42501")
 *  but `message` IS one ("DEVICE_INVALID"), the real code is used
 *  so §11 classification stays correct.
 *  v21 (round-27 #4): a non-JSON body (a bare "Not Found" text
 *  page) no longer leaves the default HTTP message — the body text
 *  is surfaced so the merchant sees what the server actually said. */
async function toApiError(response: Response): Promise<SilaApiError> {
  let code = `HTTP_${response.status}`;
  let message = `فشل الاتصال بخادم صِلة (${response.status})`;
  try {
    const body = await response.json();
    if (body && typeof body === 'object') {
      const obj = body as {error?: string; message?: string};
      if (typeof obj.error === 'string' && obj.error.length > 0) {
        code = obj.error;
      }
      if (typeof obj.message === 'string' && obj.message.length > 0) {
        message = obj.message;
      }
      // Recover the swapped shape: error="42501" + message="DEVICE_INVALID".
      if (!looksLikeSilaCode(code) && looksLikeSilaCode(message)) {
        code = message;
      }
    }
  } catch {
    // Non-JSON body — try to surface its text (trimmed, bounded).
    try {
      const text = (await response.text()).trim();
      if (text.length > 0) {
        message = `${message} — ${text.slice(0, 120)}`;
      }
    } catch {
      // Body unreadable — keep the HTTP-level defaults.
    }
  }
  return new SilaApiError(response.status, code, message);
}

// ── §6.0 health ──────────────────────────────────────────────────

export async function silaHealth(
  pairing: SilaPairing | null,
  baseUrlOverride?: string,
): Promise<boolean> {
  const {baseUrl} = endpointOf(pairing, baseUrlOverride);
  try {
    const response = await silaFetch(
      `${baseUrl}/api/pos/health`,
      {method: 'GET'},
      HEALTH_TIMEOUT_MS,
    );
    return response.ok;
  } catch {
    return false;
  }
}

// ── §6.1 pair ────────────────────────────────────────────────────

export interface SilaPairResult {
  pos_token: string;
  device_id: string;
  merchant_org_id: string;
  merchant_name: string;
  expires_at: string;
}

export async function silaPair(
  pairingCode: string,
  deviceName: string,
  baseUrlOverride?: string,
): Promise<SilaPairResult> {
  const {baseUrl} = endpointOf(null, baseUrlOverride);
  let response: Response;
  try {
    response = await silaFetch(
      `${baseUrl}/api/pos/pair`,
      {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          pairing_code: pairingCode,
          device_name: deviceName,
        }),
      },
      CALL_TIMEOUT_MS,
    );
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    throw new SilaApiError(
      0,
      'NETWORK',
      aborted
        ? 'انتهت مهلة الاتصال — تحقق من الإنترنت وحاول مجدداً'
        : 'لا يوجد اتصال بالإنترنت — تحقق من الشبكة وحاول مجدداً',
    );
  }
  if (!response.ok) {
    throw await toApiError(response);
  }
  const body = await response.json();
  return body as SilaPairResult;
}

// ── §6.2 debt-records batch ──────────────────────────────────────

export interface SilaDebtRecordInput {
  /** §6.2 identity paths — v12 (round-18 #1): absent paths are
   *  OMITTED entirely. The server's zod schema rejects explicit
   *  nulls (VALIDATION_ERROR), which silently killed every debt
   *  sync in v11. Only include what the scanned code provided. */
  customer_card?: string;
  offline_qr?: string;
  customer_id?: string;
  customer_id_number?: string;
  amount_minor: string;
  currency: string;
  pos_invoice_ref: string;
  description: string;
  scanned_at: string;
  idempotency_key: string;
}

export interface SilaDebtRecordResult {
  ok: boolean;
  idempotency_key: string;
  error?: string;
  message?: string;
  transaction_id?: string;
  reference_code?: string;
  pos_invoice_ref?: string;
  customer_name?: string;
  customer_phone_last4?: string;
  amount_minor?: number;
  added_to_outstanding_minor?: number;
  outstanding_minor?: number;
  /** v17 (round-23 #3 — 0067 §5): how much prepaid credit the server
   *  consumed for this debt (min(amount, credit_balance)). The store
   *  treats it as received at sale time — the invoice is PAID by
   *  that much, not new debt. */
  credit_consumed_minor?: number;
  idempotent_replay?: boolean;
  recorded_at?: string;
  /** v15 (§2.5): DUPLICATE_INVOICE_REF answers carry the existing
   *  reference so the row can be marked synced with it. */
  existing_reference_code?: string;
}

export async function silaSendDebtBatch(
  pairing: SilaPairing,
  records: SilaDebtRecordInput[],
  posVersion: string,
): Promise<SilaDebtRecordResult[]> {
  const {baseUrl, token} = endpointOf(pairing);
  let response: Response;
  try {
    response = await silaFetch(
      `${baseUrl}/api/pos/debt-records`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? {Authorization: `Bearer ${token}`} : {}),
        },
        body: JSON.stringify({
          records,
          client_meta: {pos_version: posVersion},
        }),
      },
      CALL_TIMEOUT_MS,
    );
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    throw new SilaApiError(
      0,
      'NETWORK',
      aborted ? 'انتهت مهلة المزامنة' : 'انقطع الاتصال أثناء المزامنة',
    );
  }
  if (!response.ok) {
    throw await toApiError(response);
  }
  const body = (await response.json()) as {
    results?: SilaDebtRecordResult[];
  };
  return body.results ?? [];
}

// ── §6.3 customers ───────────────────────────────────────────────

export interface SilaCustomerServerRow {
  customer_id: string;
  customer_name: string;
  customer_phone_last4: string | null;
  outstanding_minor: number;
  credit_minor: number;
  status: string;
  last_transaction_at: string | null;
  /** v15 (round-21 #3 — 0069 origin split §2.4): present once the
   *  server migration is live; absent → 0 (backwards compatible).
   *  pos_* = debts born from THIS store's invoices, app_* = debts
   *  born inside the Sila app — the split that ends the
   *  double-counting («تداخل عمليات الدين بالمتجر وتطبيق صِلة»). */
  pos_outstanding_minor?: number;
  app_outstanding_minor?: number;
  other_minor?: number;
  pos_purchases_minor?: number;
  app_purchases_minor?: number;
  /** v33 (round-41 #11 — 0075 store accounting): دين هذا الجهاز
   *  تحديداً بعد الإسناد ثنائي المرحلة (سدادّات نقطتك تطفئ دين
   *  نقطتك أولاً ثم الفائض يطفئ الأقدم عالمياً) — هذا هو «دين
   *  متجرك» من جهة الخادم. قبل 0075 لا يُرسل → 0 (توافق رجعي). */
  device_outstanding_minor?: number;
  device_purchases_minor?: number;
  device_payments_minor?: number;
  last_payment_at?: string | null;
  last_payment_amount_minor?: number | null;
  last_payment_method?: string | null;
  /** v16 (round-22 #1): last ledger entries with their origin —
   *  recent_entries carries pos_invoice_ref / pos_receipt_ref per
   *  entry (0069), recent_pos_refs is the older per-debt list. Both
   *  feed the counter-advance that prevents DUPLICATE_*_REF after a
   *  reinstall restarts the numbering. */
  recent_entries?: {
    entry_type?: string;
    amount_signed?: number;
    origin?: string;
    reference_code?: string | null;
    pos_invoice_ref?: string | null;
    pos_receipt_ref?: string | null;
    payment_method?: string | null;
    created_at?: string;
    /** 0075: نقطة البيع المنشأة للقيد (null = عمليات تطبيق صِلة). */
    pos_device_id?: string | null;
    pos_device_name?: string | null;
  }[];
  recent_pos_refs?: {
    reference_code?: string | null;
    pos_invoice_ref?: string | null;
    amount_minor?: number;
    synced_at?: string;
  }[];
}

export async function silaFetchCustomers(
  pairing: SilaPairing,
  updatedSince?: string | null,
): Promise<SilaCustomerServerRow[]> {
  const {baseUrl, token} = endpointOf(pairing);
  const query = updatedSince
    ? `?updated_since=${encodeURIComponent(updatedSince)}`
    : '';
  let response: Response;
  try {
    response = await silaFetch(
      `${baseUrl}/api/pos/customers${query}`,
      {
        method: 'GET',
        headers: token ? {Authorization: `Bearer ${token}`} : {},
      },
      CALL_TIMEOUT_MS,
    );
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    throw new SilaApiError(
      0,
      'NETWORK',
      aborted ? 'انتهت مهلة التحديث' : 'انقطع الاتصال أثناء تحديث الأرصدة',
    );
  }
  if (!response.ok) {
    throw await toApiError(response);
  }
  const body = (await response.json()) as {
    customers?: SilaCustomerServerRow[];
    /** 0075: هوية هذا الجهاز عند التاجر (الاسم قد يعدّله التاجر من
     *  تطبيق صِلة — §2.4 «لا تعتمد على الاسم في أي منطق»). */
    device?: {device_id?: string; device_name?: string} | null;
    device_outstanding_minor_total?: number;
    pos_outstanding_minor_total?: number;
    app_outstanding_minor_total?: number;
  };
  logDiag(
    'sila',
    `تم جلب ${body.customers?.length ?? 0} زبون من صِلة` +
      (body.device?.device_name
        ? ` (نقطة البيع: ${body.device.device_name})`
        : ''),
  );
  return body.customers ?? [];
}

// ── v15 (round-21 #3): POST /api/pos/payments (§2.3 — migration 0069) ──
// The repayment upload path that was missing entirely: cashier-received
// payments (cash/card at the counter) now reach Sila with a unique
// pos_receipt_ref + ONE idempotency key per receipt, so balances stop
// diverging («الإحصائيات غير صحيحة بعد السداد») and the customer gets
// notified by Sila exactly as if they paid in the app.

export interface SilaPaymentRecordInput {
  /** §2.3 identity paths — absent paths are OMITTED entirely
   *  (same zod discipline as debt records). */
  customer_id?: string;
  customer_card?: string;
  customer_id_number?: string;
  amount_minor: string;
  payment_method: string;
  pos_receipt_ref: string;
  description: string;
  paid_at: string;
  idempotency_key: string;
}

export interface SilaPaymentRecordResult {
  ok: boolean;
  idempotency_key: string;
  error?: string;
  message?: string;
  transaction_id?: string;
  reference_code?: string;
  pos_receipt_ref?: string;
  customer_name?: string;
  amount_minor?: number;
  outstanding_minor?: number;
  idempotent_replay?: boolean;
  paid_at?: string;
  /** §2.5: DUPLICATE_RECEIPT_REF answers carry the existing
   *  reference so the row can be marked synced with it. */
  existing_reference_code?: string;
}

export async function silaSendPaymentBatch(
  pairing: SilaPairing,
  records: SilaPaymentRecordInput[],
  posVersion: string,
): Promise<SilaPaymentRecordResult[]> {
  const {baseUrl, token} = endpointOf(pairing);
  let response: Response;
  try {
    response = await silaFetch(
      `${baseUrl}/api/pos/payments`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? {Authorization: `Bearer ${token}`} : {}),
        },
        body: JSON.stringify({
          records,
          client_meta: {pos_version: posVersion},
        }),
      },
      CALL_TIMEOUT_MS,
    );
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    throw new SilaApiError(
      0,
      'NETWORK',
      aborted ? 'انتهت مهلة رفع السداد' : 'انقطع الاتصال أثناء رفع السداد',
    );
  }
  if (!response.ok) {
    throw await toApiError(response);
  }
  const body = (await response.json()) as {
    results?: SilaPaymentRecordResult[];
  };
  return body.results ?? [];
}

// ── v20 (SILA_POS_VOUCHERS_API §4.1): POST /api/pos/vouchers/redeem ──
// The ONE live call behind «صرف قسيمة صلة» — a single documented
// redemption against the merchant's paired store. NOT an offline
// queue (§5 rule 1): the voucher may be redeemed elsewhere at this
// very moment, so the call is live and the goods are handed over
// ONLY after ok:true (§7.1 rule).

export interface SilaVoucherRedeemInput {
  /** The scanned QR payload (SILAV1|… 5 parts) OR the hand-typed
   *  20-char code — sent verbatim, no local processing (§4.1). */
  payload: string;
  /** 1-60 chars — the store's INV-V-… number; one receipt = one
   *  redemption per store (DUPLICATE_RECEIPT_REF otherwise). */
  pos_receipt_ref?: string;
  /** UUID v4 generated per attempt and NEVER changed — a network
   *  cut before the answer replays the same key and gets the same
   *  result (idempotent_replay) with zero double redemption. */
  idempotency_key: string;
  /** Real redemption time, store-local ISO — clamped server-side to
   *  [now − 24h, now] so the voucher lands in the right month's
   *  statistics. */
  redeemed_at: string;
}

export interface SilaVoucherRedeemResult {
  ok: boolean;
  /** POS-VR-… — the OFFICIAL redemption number in صِلة (print it on
   *  the receipt; support & reconciliation use it). */
  reference_code: string;
  voucher_id: string;
  value_minor: number;
  currency: string;
  /** voucher | parcel. */
  kind: 'voucher' | 'parcel';
  campaign_id: string;
  campaign_name: string;
  beneficiary_last4: string | null;
  merchant_name: string;
  redeemed_at: string;
  /** The campaign's settlement snapshot AFTER this redemption was
   *  booked — write it straight into campaign_debts (§5 rule 3). */
  settlement: {
    redeemed_value_minor: number;
    settled_minor: number;
    due_minor: number;
    state: 'none' | 'partial' | 'full';
  };
  /** True when the same idempotency_key was already processed — the
   *  same redemption answered twice; NOT a second redemption. */
  idempotent_replay?: boolean;
}

export async function silaRedeemVoucher(
  pairing: SilaPairing,
  input: SilaVoucherRedeemInput,
  posVersion: string,
): Promise<SilaVoucherRedeemResult> {
  const {baseUrl, token} = endpointOf(pairing);
  let response: Response;
  try {
    response = await silaFetch(
      `${baseUrl}/api/pos/vouchers/redeem`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? {Authorization: `Bearer ${token}`} : {}),
        },
        body: JSON.stringify({
          payload: input.payload,
          pos_receipt_ref: input.pos_receipt_ref,
          idempotency_key: input.idempotency_key,
          redeemed_at: input.redeemed_at,
          client_meta: {pos_version: posVersion},
        }),
      },
      CALL_TIMEOUT_MS,
    );
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    throw new SilaApiError(
      0,
      'NETWORK',
      aborted
        ? 'انتهت مهلة الصرف — سيُعاد تلقائياً بنفس مفتاح العملية'
        : 'انقطع الاتصال أثناء الصرف — سيُعاد تلقائياً عند عودة الإنترنت',
    );
  }
  if (!response.ok) {
    throw await toApiError(response);
  }
  const body = (await response.json()) as SilaVoucherRedeemResult;
  logDiag(
    'sila',
    `صُرفت قسيمة ${body.campaign_name} بقيمة ${body.value_minor / 100} ₪ (${
      body.reference_code
    })`,
  );
  return body;
}

// ── v20 (§4.2): GET /api/pos/vouchers/settlements ──────────────────
// The ONE source of settlement truth — every campaign the store is
// contracted in, with its balances and latest settlements. Called
// by the 60s loop with updated_since (light) and after every
// successful redemption.

export interface SilaCampaignSettlementEntry {
  settlement_id: string;
  amount_minor: number;
  /** compensation (تعويض) | advance (دفعة مقدمة). */
  kind: string;
  status: 'pending' | 'confirmed' | 'disputed' | 'cancelled';
  method: string | null;
  reference: string | null;
  created_at: string;
}

export interface SilaCampaignServerRow {
  campaign_id: string;
  campaign_name: string;
  kind: 'voucher' | 'parcel';
  campaign_status: string;
  starts_at: string | null;
  ends_at: string | null;
  merchant_status: string;
  redeemed_count: number;
  redeemed_value_minor: number;
  last_redemption_at: string | null;
  settled_minor: number;
  settled_pending_minor: number;
  settled_confirmed_minor: number;
  last_settlement_at: string | null;
  settlement_state: 'none' | 'partial' | 'full';
  due_minor: number;
  settlements: SilaCampaignSettlementEntry[];
}

export interface SilaSettlementsFeed {
  ok: boolean;
  merchant_org_id: string;
  merchant_name: string;
  updated_since: string | null;
  campaigns: SilaCampaignServerRow[];
  totals: {
    campaigns_count: number;
    redeemed_value_minor: number;
    due_minor: number;
  };
}

export async function silaFetchSettlements(
  pairing: SilaPairing,
  updatedSince?: string | null,
): Promise<SilaSettlementsFeed> {
  const {baseUrl, token} = endpointOf(pairing);
  const query = updatedSince
    ? `?updated_since=${encodeURIComponent(updatedSince)}`
    : '';
  let response: Response;
  try {
    response = await silaFetch(
      `${baseUrl}/api/pos/vouchers/settlements${query}`,
      {
        method: 'GET',
        headers: token ? {Authorization: `Bearer ${token}`} : {},
      },
      CALL_TIMEOUT_MS,
    );
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    throw new SilaApiError(
      0,
      'NETWORK',
      aborted ? 'انتهت مهلة جلب التسويات' : 'انقطع الاتصال أثناء جلب التسويات',
    );
  }
  if (!response.ok) {
    throw await toApiError(response);
  }
  const body = (await response.json()) as SilaSettlementsFeed;
  logDiag(
    'sila',
    `جُلبت تسويات ${body.campaigns?.length ?? 0} حملة — المستحق ${(
      (body.totals?.due_minor ?? 0) / 100
    ).toFixed(2)} ₪`,
  );
  return body;
}
