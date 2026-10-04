/**
 * BarcodeService — v9.1 (round-14 #6) internal barcode system.
 * ─────────────────────────────────────────────────────────────────
 * What professional POS apps (Loyverse, Square, Kyte) do for
 * products without a manufacturer barcode: the app GENERATES an
 * internal EAN-13 in the in-store range (prefix 20…, reserved by
 * the EAN standard for store use) with a valid check digit, so any
 * external scanner reads it as a perfectly normal EAN-13.
 *
 *   • generateInternalEan13(exists)  → unique "20…" EAN-13 code
 *   • ean13CheckDigit(digits12)      → standard EAN checksum
 *   • isValidEan13(code)             → checksum validation
 *   • encodeEan13Bars(code)          → module pattern for the SVG
 *                                      preview (guard bars + L/G/R)
 *   • encodeCode128Bars(value)       → CODE128-B pattern for the
 *                                      preview of arbitrary codes
 *
 * Pure functions, zero dependencies, 100% offline.
 */
import {INTERNAL_EAN13_PREFIX} from '../core/config';

// ── EAN-13 checksum ────────────────────────────────────────────

/** Standard EAN-13 check digit for the first 12 digits. */
export function ean13CheckDigit(first12: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const digit = first12.charCodeAt(i) - 48;
    if (digit < 0 || digit > 9) {
      throw new Error('أرقام الباركود غير صالحة');
    }
    sum += i % 2 === 0 ? digit : digit * 3;
  }
  return (10 - (sum % 10)) % 10;
}

/** Full EAN-13 (13 digits) from 12 digits + computed check digit. */
export function completeEan13(first12: string): string {
  return `${first12}${ean13CheckDigit(first12)}`;
}

/** Is `code` a checksum-valid 13-digit EAN-13? */
export function isValidEan13(code: string): boolean {
  if (!/^\d{13}$/.test(code)) {
    return false;
  }
  try {
    return ean13CheckDigit(code.slice(0, 12)) === code.charCodeAt(12) - 48;
  } catch {
    return false;
  }
}

// ── Internal code generation ────────────────────────────────────

/**
 * Generates a UNIQUE internal EAN-13 in the in-store range:
 * "20" + 10 pseudo-random digits + check digit. Uniqueness is
 * verified against the caller's `exists` probe (products AND unit
 * barcodes) with up to 12 attempts.
 */
export async function generateInternalEan13(
  exists: (code: string) => Promise<boolean>,
  maxAttempts = 12,
): Promise<string> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Time + Math.random mixed: unique across devices and sessions.
    const entropy = `${Date.now().toString().slice(-8)}${Math.floor(
      Math.random() * 10000,
    )
      .toString()
      .padStart(4, '0')}`;
    const body = `${INTERNAL_EAN13_PREFIX}${entropy.slice(0, 10).padEnd(
      10,
      '0',
    )}`;
    const code = completeEan13(body);
    if (!(await exists(code))) {
      return code;
    }
  }
  throw new Error('تعذر توليد باركود غير مستخدم — حاول مجدداً');
}

// ── EAN-13 bar pattern (for the in-app SVG preview) ─────────────

/** Digit → L-code (odd parity) widths, in modules. */
const EAN_L = [
  '0001101',
  '0011001',
  '0010011',
  '0111101',
  '0100011',
  '0110001',
  '0101111',
  '0111011',
  '0110111',
  '0001011',
];
/** Digit → G-code (even parity) — reverse-complement of L. */
const EAN_G = EAN_L.map(pattern =>
  pattern
    .split('')
    .reverse()
    .map(bit => (bit === '1' ? '0' : '1'))
    .join(''),
);
/** Digit → R-code — complement of L. */
const EAN_R = EAN_L.map(pattern =>
  pattern
    .split('')
    .map(bit => (bit === '1' ? '0' : '1'))
    .join(''),
);
/** First digit → parity pattern of digits 2–7 (L=0 / G=1). */
const EAN_PARITY = [
  'LLLLLL',
  'LLGLGG',
  'LLGGLG',
  'LLGGGL',
  'LGLLGG',
  'LGGLLG',
  'LGGGLL',
  'LGLGLG',
  'LGLGGL',
  'LGGLGL',
];

export interface BarcodePattern {
  /** Concatenated module bits ('0' = space, '1' = bar). */
  bits: string;
  /** True when the value renders as a valid EAN-13. */
  standard: boolean;
}

/** EAN-13 module bit pattern: [guard] L6 [guard] R6 [guard]. */
export function encodeEan13Bars(code: string): BarcodePattern | null {
  if (!isValidEan13(code)) {
    return null;
  }
  const parity = EAN_PARITY[Number(code[0])];
  let bits = '101'; // start guard
  for (let i = 1; i <= 6; i++) {
    bits += parity[i - 1] === 'L' ? EAN_L[Number(code[i])] : EAN_G[Number(code[i])];
  }
  bits += '01010'; // middle guard
  for (let i = 7; i <= 12; i++) {
    bits += EAN_R[Number(code[i])];
  }
  bits += '101'; // end guard
  return {bits, standard: true};
}

// ── CODE128-B bar pattern (for previews of arbitrary codes) ─────

/** CODE128 code-set-B value for an ASCII char. */
function codeBValue(char: string): number {
  const code = char.charCodeAt(0);
  if (code >= 32 && code <= 126) {
    return code - 32;
  }
  throw new Error('باركود CODE128 يقبل الحروف الإنجليزية والأرقام فقط');
}

/** The standard CODE128 widths table (107 patterns × 6 widths). */
const CODE128_PATTERNS: string[] = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213',
  '122312', '132212', '221213', '221312', '231212', '112232', '122132',
  '122231', '113222', '123122', '123221', '223211', '221132', '221231',
  '213212', '223112', '312131', '311222', '321122', '321221', '312212',
  '322112', '322211', '212123', '212321', '232121', '111323', '131123',
  '131321', '112313', '132113', '132311', '211313', '231113', '231311',
  '112133', '112331', '132131', '113123', '113321', '133121', '313121',
  '211331', '231131', '213113', '213311', '213131', '311123', '311321',
  '331121', '312113', '312311', '332111', '314111', '221411', '431111',
  '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114',
  '413111', '241112', '134111', '111242', '121142', '121241', '114212',
  '124112', '124211', '411212', '421112', '421211', '212141', '214121',
  '412121', '111143', '111341', '131141', '114113', '114311', '411113',
  '411311', '113141', '114131', '311141', '411131', '211412', '211214',
  '211232', '2331112',
];

/** CODE128 (code set B) module pattern for an arbitrary ASCII value. */
export function encodeCode128Bars(value: string): BarcodePattern | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 24) {
    return null;
  }
  try {
    // Start B (104) + payload + mod-103 checksum + stop (106).
    const values = [104];
    for (const char of trimmed) {
      values.push(codeBValue(char));
    }
    let sum = 104; // start code B
    for (let i = 1; i < values.length; i++) {
      sum += values[i] * i;
    }
    values.push(sum % 103);
    values.push(106); // STOP
    let bits = '';
    for (const value of values) {
      const pattern = CODE128_PATTERNS[value];
      // Widths alternate bar/space starting with a bar; the STOP
      // pattern (index 106, "2331112") carries its own 2-module
      // termination bar as the 7th element.
      for (let w = 0; w < pattern.length; w++) {
        const width = pattern.charCodeAt(w) - 48;
        bits += (w % 2 === 0 ? '1' : '0').repeat(width);
      }
    }
    return {bits, standard: false};
  } catch {
    return null;
  }
}

/** Picks the right renderer for a value: EAN-13 when 13 valid
 *  digits, CODE128-B otherwise (null = not renderable). */
export function encodeBarcodeBars(value: string): BarcodePattern | null {
  const trimmed = value.trim();
  if (/^\d{13}$/.test(trimmed)) {
    return encodeEan13Bars(trimmed);
  }
  return encodeCode128Bars(trimmed);
}
