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

/** v42 (الجولة 50 #3): أسماء الشهور الميلاسية (الاستعمال
 *  الفلسطيني/الشامي) — لسلسلة المبيعات الشهرية في التقارير حين
 *  تمتد الفترة لأكثر من شهرين (مثل «الكل»). */
const MONTHS_AR = [
  'كانون الثاني',
  'شباط',
  'آذار',
  'نيسان',
  'أيار',
  'حزيران',
  'تموز',
  'آب',
  'أيلول',
  'تشرين الأول',
  'تشرين الثاني',
  'كانون الأول',
];

/** '2026-10' → "تشرين الأول" (اسم الشهر الشامي). */
export function monthLabel(monthStr: string): string {
  const parts = monthStr.split('-');
  const idx = Number(parts[1]) - 1;
  if (parts.length !== 2 || Number.isNaN(idx) || MONTHS_AR[idx] == null) {
    return monthStr;
  }
  return MONTHS_AR[idx];
}

/** v42 (الجولة 50 #3): '2026-10-09' → "9/10" (يوم/شهر مضغوط —
 *  السطر الفرعي تحت اسم اليوم في رسم المبيعات، فيعرف التاجر
 *  تاريخ كل عمود بالتحديد لا اسم أسبوعي مكرر فقط). */
export function dayMonthLabel(dateStr: string): string {
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (Number.isNaN(month) || Number.isNaN(day)) return dateStr;
  return `${day}/${month}`;
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

/**
 * v37 (الجولة 45 #1أ): تحويل النص المدخل إلى رقم بأمان كامل.
 * ─────────────────────────────────────────────────────────────────
 * الخلل الجذري الذي عانى منه التاجر أشهراً («حفظ المخزون الوهمي»):
 * القيمة القديمة كانت تقصّ بـ [^\d.\-] فتُسقط الأرقام العربية
 * الهندية (٠١٢٣٤٥٦٧٨٩) والفاصلة العشرية العربية (٫) والفاصلة
 * الآلاف (٬) والأرقام الفارسية (۰-۹) — أي لوحة مفاتيح عربية على
 * أندرويد ترسل «٠٥» أو «12٫5»:
 *   • «٠٥»            → تنظيف → ''  → parseFloat('')  → NaN
 *   • NaN في نموذج المنتج → stockRaw = NaN → Math.round(NaN) …
 *     وُضع حارس Number.isNaN(stockRaw) ? 0 : … فحُفظت قيمة 0
 *     مع رسالة «تم الحفظ بنجاح» — المخزون الوهمي بالنص الحرفي.
 *   • «12٫5»          → تنظيف → '125' → خمس وعشرون ضعف القيمة!
 *
 * الحل: تطبيع كامل للأشكال الرقمية كلها قبل التنظيف:
 *   ٠-٩ (U+0660..0669) و ۰-۹ (U+06F0..06F9) و ０-۹ (Fullwidth)
 *   → أرقام ASCII، ٫ (U+066B) → النقطة، ٬ (U+066C) والفواصل
 *   العربية «،» والإنجليزية «,» → تُحذف (فاصل آلاف)، ويبقى
 *   السالب (-) والنقطة (.) فقط كما كان.
 * تُستخدم في: نموذج المنتج (الأسعار/الكميات/التحويلات)، المخزون،
 * الجرد، نقطة البيع، التقارير — مصدر واحد للوحة مفاتيح أي شكل.
 */
export function parseNumber(input: string): number {
  if (input == null) {
    return NaN;
  }
  const normalized = input
    // الأرقام العربية الهندية ٠١٢٣٤٥٦٧٨٩ → 0-9
    .replace(/[\u0660-\u0669]/g, ch =>
      String(ch.charCodeAt(0) - 0x0660),
    )
    // الأرقام الفارسية/الأردية ۰۱۲۳۴۵۶۷۸۹ → 0-9
    .replace(/[\u06f0-\u06f9]/g, ch =>
      String(ch.charCodeAt(0) - 0x06f0),
    )
    // الأرقام العريضة Fullwidth ０-９ → 0-9
    .replace(/[\uff10-\uff19]/g, ch =>
      String(ch.charCodeAt(0) - 0xff10),
    )
    // الفاصلة العشرية العربية ٫ والفاصلة العشرية العربية
    // المرفوعة ¨ (نماذج لوحات المفاتيح) → نقطة عشرية واحدة
    .replace(/[\u066b\u066c\u060c]/g, ch =>
      ch === '\u066b' || ch === '\u060c' ? '.' : '',
    )
    // النقطة العشرية «.» تبقى، الفاصلة الإنجليزية «,» فاصل آلاف
    // يُحذف بعد التحقق من كونه فاصلاً عشرياً فعلاً
    .replace(/,/g, '');
  const cleaned = normalized.replace(/[^\d.\-]/g, '');
  // حارس «12.3.4»: parseFloat يقرأ 12.3 — لكن الأشكال المزدوجة
  // الناتجة عن إدخال بشري (٫ ثم .) تُقص لأول عدد سليم.
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : NaN;
}

/**
 * v37 (الجولة 45 #1أ): هل النص المدخل رقمان قابل للقراءة فعلاً؟
 * يستعمله نموذج المنتج ليمنع الحفظ الصامت بصفر: إذا كتب التاجر
 * شيئاً في حقل الكمية ولم يُقرأ رقمًا → رسالة خطأ صريحة توقف
 * الحفظ، بدل رسالة نجاح يحفظ 0.
 */
export function isParseableNumber(input: string): boolean {
  const trimmed = input == null ? '' : input.trim();
  if (trimmed.length === 0) {
    return false;
  }
  return !Number.isNaN(parseNumber(trimmed));
}

/** Truncates a string to `max` characters, adding an ellipsis. */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}
