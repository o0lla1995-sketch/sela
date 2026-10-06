/**
 * sila/qr — محلل رموز صِلة (SILA_POS_API §3.1, §4, §5, §13.1).
 * ─────────────────────────────────────────────────────────────────
 * PURE offline JWS parsing — no network, no signature checking
 * (signatures are verified SERVER-side at sync time, §5). The
 * parser only decides WHAT was scanned and extracts the fields the
 * cashier needs to confirm a debt:
 *
 *   sila-card:v1     → identity card: cid + NAME + phone (no amount)
 *   sila-offline-qr  → customer-signed amount (≤ ₪500) + cid
 *   sila-pair:CODE   → merchant pairing code (Settings flow)
 *   opaque token     → online session code — unusable offline
 *
 * base64url is decoded with '=' padding restored; every malformed
 * input degrades to {kind:'unknown'} instead of throwing, so a
 * random EAN barcode scanned by mistake can never crash the POS.
 */

/** base64url → UTF-8 string (padding tolerated/added). */
/* eslint-disable no-bitwise */
function base64UrlDecode(input: string): string {
  try {
    const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    // Hermes/RN global decodeURIComponent + btoa-free path:
    // manual byte walk (no Buffer dependency).
    const chars =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let raw = '';
    for (let i = 0; i < padded.length; i += 4) {
      const c1 = chars.indexOf(padded[i]);
      const c2 = chars.indexOf(padded[i + 1]);
      const c3 = chars.indexOf(padded[i + 2]);
      const c4 = chars.indexOf(padded[i + 3]);
      if (c1 < 0 || c2 < 0) {
        return '';
      }
      const triplet =
        (c1 << 18) | (c2 << 12) | ((c3 < 0 ? 0 : c3) << 6) | (c4 < 0 ? 0 : c4);
      const b1 = (triplet >> 16) & 0xff;
      const b2 = (triplet >> 8) & 0xff;
      const b3 = triplet & 0xff;
      raw += String.fromCharCode(b1);
      if (c3 >= 0 && padded[i + 2] !== '=') {
        raw += String.fromCharCode(b2);
      }
      if (c4 >= 0 && padded[i + 3] !== '=') {
        raw += String.fromCharCode(b3);
      }
    }
    // Multi-byte UTF-8 → JS string.
    return decodeURIComponent(
      raw
        .split('')
        .map(char => '%' + ('00' + char.charCodeAt(0).toString(16)).slice(-2))
        .join(''),
    );
  } catch {
    return '';
  }
}

function safeJson(text: string): Record<string, unknown> | null {
  if (!text) {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** SILENCE_WINDOW: the server accepts codes up to 24h AFTER their
 *  exp (sync grace, §3.1/§5) — beyond that the record fails
 *  permanently, so the POS warns BEFORE the sale is committed. */
export const SILA_SYNC_GRACE_MS = 24 * 60 * 60 * 1000;

/** Offline purchase codes are capped at ₪500 (50000 minor, §3.1). */
export const SILA_OFFLINE_LIMIT_MINOR = 50000;

export interface SilaQrParseResult {
  payload: import('../../core/types').SilaQrPayload;
  /** true when exp + grace window already passed (permanent failure
   *  if sent — the cashier should ask for a fresh code). */
  expired: boolean;
}

/**
 * Parses ANY scanned string and classifies it per §4:
 * typ is read from the JWS HEADER first, as the spec mandates.
 */
export function parseSilaQr(raw: string): SilaQrParseResult {
  const text = (raw ?? '').trim();

  // Pairing code — either the bare "XXXX-XXXX" or "sila-pair:XXXX-XXXX".
  if (/^sila-pair:/i.test(text)) {
    return {
      payload: {
        kind: 'pair',
        code: text.replace(/^sila-pair:/i, ''),
        raw: text,
      },
      expired: false,
    };
  }

  // JWS-like: exactly three base64url segments.
  const parts = text.split('.');
  if (parts.length !== 3 || parts.some(part => part.length === 0)) {
    // Opaque online token (§4): a solid blob without dots.
    if (text.length >= 16 && /^[A-Za-z0-9_-]+$/.test(text)) {
      return {
        payload: {kind: 'online', raw: text},
        expired: false,
      };
    }
    return {payload: {kind: 'unknown', raw: text}, expired: false};
  }

  const header = safeJson(base64UrlDecode(parts[0]));
  const body = safeJson(base64UrlDecode(parts[1]));
  if (header == null || body == null) {
    return {payload: {kind: 'unknown', raw: text}, expired: false};
  }

  const typ = asString(header.typ);
  const exp = asNumber(body.exp);
  const expired =
    exp > 0 && Date.now() > (exp + SILA_SYNC_GRACE_MS / 1000) * 1000;

  if (typ === 'sila-card-qr') {
    return {
      payload: {
        kind: 'card',
        cid: asString(body.cid),
        name: asString(body.name),
        phone: asString(body.phone),
        exp,
        raw: text,
      },
      expired,
    };
  }

  if (typ === 'sila-offline-qr') {
    // amt arrives as a JSON number in minor units (§3.1).
    const amount = asNumber(body.amt);
    return {
      payload: {
        kind: 'offline',
        cid: asString(body.cid),
        amountMinor: Math.max(0, Math.round(amount)),
        currency: asString(body.cur) || 'ILS',
        description: asString(body.desc),
        exp,
        raw: text,
      },
      expired,
    };
  }

  // A signed JWS of an unknown type — treated as opaque.
  return {payload: {kind: 'unknown', raw: text}, expired: false};
}

/** Normalizes a hand-typed pairing code: strips the sila-pair:
 *  prefix, uppercases, keeps only the A-Z0-9 and dash shape. */
export function normalizePairingCode(input: string): string {
  return input
    .trim()
    .replace(/^sila-pair:/i, '')
    .toUpperCase()
    .replace(/\s+/g, '');
}

// ── v20 (SILA_POS_VOUCHERS_API §1/§4.1): voucher codes ───────────
// The beneficiary's code comes in TWO shapes, both valid as the
// `payload` of POST /api/pos/vouchers/redeem (sent verbatim):
//   1. The signed QR payload — 5 pipe-separated parts:
//      SILAV1|<voucher uuid>|<20-char code>|<unix exp>|<hmac-sha256 hex>
//   2. The bare 20-char code typed by the cashier.
// Signature/expiry are verified SERVER-side (§8) — the POS only
// classifies the shape and surfaces what the cashier needs.

export interface SilaVoucherCodeParse {
  valid: boolean;
  /** 'qr' (SILAV1|… payload) | 'manual' (bare 20-char code). */
  form: 'qr' | 'manual' | null;
  /** The payload to send verbatim (normalized for manual codes:
   *  trimmed + uppercased). */
  payload: string;
  /** The 20-char code when extractable (QR part 3 / manual input). */
  code: string | null;
  voucherId: string | null;
  /** unix seconds from the QR (null for manual codes). */
  expUnix: number | null;
  /** Soft local hint only — the SERVER is the redemption authority. */
  looksExpired: boolean;
  /** Arabic reason when !valid (null when valid). */
  reason: string | null;
}

const MANUAL_CODE_RE = /^[A-Za-z0-9]{20}$/;

/** Parses a scanned/typed string in the voucher redemption flow. */
export function parseSilaVoucherCode(raw: string): SilaVoucherCodeParse {
  const text = (raw ?? '').trim();
  if (!text) {
    return {
      valid: false,
      form: null,
      payload: '',
      code: null,
      voucherId: null,
      expUnix: null,
      looksExpired: false,
      reason: 'أدخل رمز القسيمة أو امسح رمز الـ QR',
    };
  }
  if (/^SILAV1\|/i.test(text)) {
    const parts = text.split('|');
    if (parts.length !== 5 || parts.some(part => part.length === 0)) {
      return {
        valid: false,
        form: 'qr',
        payload: text,
        code: null,
        voucherId: null,
        expUnix: null,
        looksExpired: false,
        reason:
          'رمز الـ QR غير مكتمل (خمسة أجزاء مطلوبة) — اطلب من المستحق إظهار الرمز من جديد',
      };
    }
    const voucherId = parts[1];
    const code = parts[2];
    const expUnix = parseInt(parts[3], 10);
    if (!MANUAL_CODE_RE.test(code)) {
      return {
        valid: false,
        form: 'qr',
        payload: text,
        code: null,
        voucherId: null,
        expUnix: null,
        looksExpired: false,
        reason: 'شكل الكود داخل الرمز غير سليم — أعد المسح',
      };
    }
    return {
      valid: true,
      form: 'qr',
      payload: text,
      code,
      voucherId,
      expUnix: Number.isFinite(expUnix) ? expUnix : null,
      looksExpired:
        Number.isFinite(expUnix) && expUnix > 0 && Date.now() > expUnix * 1000,
      reason: null,
    };
  }
  if (MANUAL_CODE_RE.test(text)) {
    return {
      valid: true,
      form: 'manual',
      payload: text.toUpperCase(),
      code: text.toUpperCase(),
      voucherId: null,
      expUnix: null,
      looksExpired: false,
      reason: null,
    };
  }
  return {
    valid: false,
    form: null,
    payload: text,
    code: null,
    voucherId: null,
    expUnix: null,
    looksExpired: false,
    reason:
      text.length === 20
        ? 'الكود يحوي محارف غير مقبولة — الأرقام والحروف الإنجليزية فقط'
        : 'الكود اليدوي 20 محرفاً بالضبط — أو امسح رمز الـ QR كاملاً',
  };
}

/** UUID v4 for idempotency keys (§6.2 — MANDATORY per record). */
export function uuidV4(): string {
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 36; i += 1) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      out += '-';
    } else if (i === 14) {
      out += '4';
    } else if (i === 19) {
      out += hex[((Math.random() * 4) | 0) + 8];
    } else {
      out += hex[(Math.random() * 16) | 0];
    }
  }
  return out;
}
