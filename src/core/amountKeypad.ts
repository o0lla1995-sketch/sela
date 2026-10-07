/**
 * amountKeypad — v29 (round-37 #1) لوحة أرقام المبالغ المدمجة.
 * ─────────────────────────────────────────────────────────────────
 * الدرس النهائي من روم الجهاز (v25→v28): أي تغيير تخطيط JS لحظة
 * فتح لوحة النظام يجعل الـ IME يستسلم ويغلقها فوراً («تفتح وتغلق
 * مباشرة»). الحل البنيوي — نفس درس v9.2 (لوحة الوزن في نقطة
 * البيع): المبلغ يُدخل من لوحة أرقام داخل التطبيق ولا تُستدعى
 * لوحة النظام إطلاقاً لحقل المبلغ.
 *
 * هذا الملف هو المنطق الصافي (بلا React) — قابل للاختبار المباشر.
 */

/** شبكة الأزرار — نفس ترتيب لوحة الوزن المجرّبة (PosScreen). */
export const AMOUNT_KEYPAD_KEYS: string[][] = [
  ['7', '8', '9'],
  ['4', '5', '6'],
  ['1', '2', '3'],
  ['.', '0', '⌫'],
];

/** أقصى عدد خانات صحيحة (9,999,999 ₪ كفاية لأي درج). */
const MAX_INTEGER_DIGITS = 7;
/** الدينار/الأغورة — منزلتان عشريتان فقط. */
const MAX_DECIMALS = 2;

/**
 * ضغطة واحدة على لوحة المبلغ — رقم / فاصلة عشرية / حذف.
 *
 * القواعد (نقود حقيقية، ليس نصاً حراً):
 *  • رقم بعد الفاصلة: منزلتان كحد أقصى (أغورات).
 *  • رقم قبل الفاصلة: 7 خانات كحد أقصى.
 *  • «0» وحيدة تُستبدل بأول رقم (لا سوابق صفرية).
 *  • الفاصلة: واحدة فقط؛ على نص فارغ تصبح «0.».
 *  • ⌫ يحذف آخر خانة (وحرف واحد يصبح فارغاً).
 */
export function applyAmountKey(prev: string, key: string): string {
  if (key === '⌫') {
    return prev.length <= 1 ? '' : prev.slice(0, -1);
  }
  if (key === '.') {
    if (prev.includes('.')) {
      return prev;
    }
    return prev === '' ? '0.' : `${prev}.`;
  }
  if (!/^\d$/.test(key)) {
    return prev; // مفتاح غير معروف — تجاهل بهدوء.
  }
  const dot = prev.indexOf('.');
  if (dot >= 0) {
    // بعد الفاصلة: أغورتان فقط.
    if (prev.length - dot - 1 >= MAX_DECIMALS) {
      return prev;
    }
    return prev + key;
  }
  // قبل الفاصلة: سقف الخانات الصحيحة.
  if (prev.replace('.', '').length >= MAX_INTEGER_DIGITS) {
    return prev;
  }
  if (prev === '0') {
    return key;
  }
  return prev + key;
}

/** يحوّل نص المبلغ إلى minor (أغورات) — 0 عند أي خطأ. */
export function amountTextToMinor(text: string): number {
  const value = Number(text.replace(',', '.'));
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.round(value * 100);
}
