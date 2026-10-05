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

/** §11 classification — drives every sync decision. */
export type SilaErrorClass = 'transient' | 'permanent' | 'device' | 'conflict';

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
  'RELATIONSHIP_NOT_ACTIVE',
  'VALIDATION_ERROR',
  'INVALID_JSON',
]);

const DEVICE_CODES = new Set(['DEVICE_INVALID', 'UNAUTHENTICATED']);
const CONFLICT_CODES = new Set(['IDEMPOTENT_MISMATCH']);

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
  if (status === 401) {
    return 'device';
  }
  if (PERMANENT_CODES.has(code)) {
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
    case 'DUPLICATE_INVOICE_REF':
      return 'هذه الفاتورة مسجلة ديناً مسبقاً — لا يمكن تكرارها';
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
 *  so §11 classification stays correct. */
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
    // Non-JSON body — keep the HTTP-level defaults.
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
  idempotent_replay?: boolean;
  recorded_at?: string;
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
  };
  logDiag('sila', `تم جلب ${body.customers?.length ?? 0} زبون من صِلة`);
  return body.customers ?? [];
}
