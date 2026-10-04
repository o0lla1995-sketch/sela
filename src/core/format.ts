/**
 * Formatting helpers — money (₪), local dates (Asia/Jerusalem device time)
 * and invoice numbering.
 *
 * IMPORTANT: `sales.created_at` values are always written as LOCAL device
 * time strings ('YYYY-MM-DD HH:MM:SS'), never as SQLite CURRENT_TIMESTAMP
 * (which is UTC). This keeps the "today" / "peak hours" reports correct for
 * the shop's local timezone without any server.
 */
import {CURRENCY} from './config';

/** 12.5 → "12.50 ₪" */
export function formatMoney(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  const fixed = Math.abs(safe).toFixed(2);
  const withThousands = addThousandsSeparator(fixed);
  return `${safe < 0 ? '-' : ''}${withThousands} ${CURRENCY}`;
}

function addThousandsSeparator(digits: string): string {
  const [intPart, decPart] = digits.split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return decPart != null ? `${grouped}.${decPart}` : grouped;
}

/** Plain number for receipts (no currency, western digits). */
export function formatAmount(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  return safe.toFixed(2);
}

/**
 * v8.3 (round-12 #4): quantity formatter for WEIGHT-sold lines and
 * stock badges — 1.25 stays "1.25", 2 stays "2", 0.25 stays "0.25"
 * (trailing zeros trimmed, up to 3 decimals = gram precision).
 */
export function formatQty(value: number, maxDecimals = 3): string {
  const safe = Number.isFinite(value) ? value : 0;
  const rounded = Number(safe.toFixed(maxDecimals));
  return String(rounded);
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** Current local date as 'YYYY-MM-DD'. */
export function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Current local timestamp as 'YYYY-MM-DD HH:MM:SS'. */
export function localNow(): string {
  const d = new Date();
  return `${localToday()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(
    d.getSeconds(),
  )}`;
}

/** Date shifted by N days (local) as 'YYYY-MM-DD'. */
export function localDateShift(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** First day of the current local month as 'YYYY-MM-DD'. */
export function localMonthStart(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`;
}

const WEEKDAYS_AR = [
  'الأحد',
  'الاثنين',
  'الثلاثاء',
  'الأربعاء',
  'الخميس',
  'الجمعة',
  'السبت',
];

/** '2026-01-02' → "الجمعة" (short Arabic weekday). */
export function weekdayLabel(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return WEEKDAYS_AR[d.getDay()] ?? dateStr;
}

/** '2026-01-02 14:03:09' → "2026/01/02 - 02:03 م" */
export function formatDateTime(value: string): string {
  if (!value) return '';
  const [date, time = ''] = value.split(' ');
  const iso = date.replace(/-/g, '/');
  const [h = '0', m = '0'] = time.split(':');
  const hour = Number(h);
  const period = hour >= 12 ? 'م' : 'ص';
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${iso} - ${pad(hour12)}:${m} ${period}`;
}

/** '2026-01-02' → "2026/01/02" */
export function formatDate(dateStr: string): string {
  return dateStr ? dateStr.replace(/-/g, '/') : '';
}

/**
 * Generates the next invoice number: INV-YYYYMMDD-NNNN.
 * The NNNN part is a persistent daily sequence.
 */
export function nextInvoiceNumber(
  counter: number,
  lastDay: string,
  today: string,
): {invoiceNumber: string; counter: number; day: string} {
  const effectiveDay = lastDay === today ? today : today;
  const next = lastDay === today ? counter + 1 : 1;
  const compactDay = effectiveDay.replace(/-/g, '');
  return {
    invoiceNumber: `INV-${compactDay}-${pad(next, 4)}`,
    counter: next,
    day: effectiveDay,
  };
}

/** Relative Arabic time: "الآن" / "قبل 5 دقائق" / "قبل ساعتين" / date. */
export function relativeTime(value: string): string {
  if (!value) return '';
  const then = new Date(value.replace(' ', 'T'));
  if (Number.isNaN(then.getTime())) return value;
  const diffMs = Date.now() - then.getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'الآن';
  if (minutes < 60) {
    return minutes === 1 ? 'قبل دقيقة' : `قبل ${minutes} دقيقة`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    if (hours === 1) return 'قبل ساعة';
    if (hours === 2) return 'قبل ساعتين';
    return `قبل ${hours} ساعة`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    if (days === 1) return 'قبل يوم';
    if (days === 2) return 'قبل يومين';
    return `قبل ${days} أيام`;
  }
  return formatDate(value.split(' ')[0]);
}

/** Valid, readable number from arbitrary text input. */
export function parseNumber(input: string): number {
  const cleaned = input.replace(/[^\d.\-]/g, '');
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : NaN;
}

/** Truncates a string to `max` characters, adding an ellipsis. */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}
