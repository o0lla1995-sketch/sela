/**
 * v29 (round-37 #1) — لوحة أرقام المبلغ المدمجة في نوافذ الخزينة.
 * ─────────────────────────────────────────────────────────────────
 * المبلغ لم يعد TextInput تستدعي لوحة النظام (التي كانت تُغلق فوراً
 * على روم الجهاز) — صار عرضاً + لوحة أرقام داخل التطبيق. هذه
 * الاختبارات تثبّت قواعد النقود في المنطق الصافي applyAmountKey
 * (منطق الضغطات) و amountTextToMinor (التحويل إلى أغورات).
 */
import {load} from './helpers/app';

const {applyAmountKey, amountTextToMinor, AMOUNT_KEYPAD_KEYS} = load(
  'src/core/amountKeypad',
);

/** يطبّق سلسلة ضغطات متتالية على نص البداية. */
const type = (keys: string[], start = '') =>
  keys.reduce((acc, key) => applyAmountKey(acc, key), start);

describe('v29 — applyAmountKey: لوحة أرقام المبلغ', () => {
  test('أرقام متتالية تُبنى نصاً واحداً', () => {
    expect(type(['1', '2', '5'])).toBe('125');
    expect(type(['7', '8', '9'])).toBe('789');
  });

  test('«0» وحيدة تُستبدل بأول رقم — لا سوابق صفرية', () => {
    expect(applyAmountKey('', '0')).toBe('0');
    expect(applyAmountKey('0', '0')).toBe('0');
    expect(applyAmountKey('0', '5')).toBe('5');
    expect(type(['0', '0', '3'])).toBe('3');
  });

  test('الفاصلة: واحدة فقط، وعلى نص فارغ تصبح «0.»', () => {
    expect(applyAmountKey('', '.')).toBe('0.');
    expect(applyAmountKey('12', '.')).toBe('12.');
    // فاصلة ثانية تُهمل.
    expect(applyAmountKey('12.', '.')).toBe('12.');
    expect(applyAmountKey('0.', '.')).toBe('0.');
  });

  test('منزلتان عشريتان فقط (أغورات) — الخانة الثالثة تُهمل', () => {
    expect(type(['1', '2', '.', '5', '0'])).toBe('12.50');
    expect(applyAmountKey('12.50', '9')).toBe('12.50');
    expect(applyAmountKey('0.99', '1')).toBe('0.99');
    // «0.5» ← رقم بعد الفاصلة يعمل (المنزلة الثانية متاحة).
    expect(applyAmountKey('0.5', '5')).toBe('0.55');
  });

  test('⌫ يحذف آخر خانة، وحرف واحد يعود فارغاً', () => {
    expect(applyAmountKey('125', '⌫')).toBe('12');
    expect(applyAmountKey('1', '⌫')).toBe('');
    expect(applyAmountKey('', '⌫')).toBe('');
    expect(applyAmountKey('12.50', '⌫')).toBe('12.5');
    // الحذف يُبقي الفاصلة ثم يحذفها كأي خانة.
    expect(applyAmountKey('12.', '⌫')).toBe('12');
  });

  test('سقف 7 خانات صحيحة (9,999,999 ₪)', () => {
    // 9,999,999 — سبع خانات.
    expect(type(['9', '9', '9', '9', '9', '9', '9'])).toBe('9999999');
    // الخانة الثامنة تُهمل.
    expect(applyAmountKey('9999999', '9')).toBe('9999999');
    // والفاصلة بعدها مسموحة (الأغورات).
    expect(applyAmountKey('9999999', '.')).toBe('9999999.');
  });

  test('مفاتيح غير معروفة تُهمل بهدوء', () => {
    expect(applyAmountKey('12', 'x')).toBe('12');
    expect(applyAmountKey('12', '')).toBe('12');
    expect(applyAmountKey('', 'delete')).toBe('');
  });

  test('الشبكة: 4 صفوف × 3 أزرار بنفس ترتيب لوحة الوزن', () => {
    expect(AMOUNT_KEYPAD_KEYS).toEqual([
      ['7', '8', '9'],
      ['4', '5', '6'],
      ['1', '2', '3'],
      ['.', '0', '⌫'],
    ]);
  });
});

describe('v29 — amountTextToMinor: التحويل إلى أغورات', () => {
  test('مبالغ صحيحة وعشرية', () => {
    expect(amountTextToMinor('125')).toBe(12500);
    expect(amountTextToMinor('12.50')).toBe(1250);
    expect(amountTextToMinor('0.99')).toBe(99);
    expect(amountTextToMinor('9999999.99')).toBe(999999999);
  });

  test('فارغ / صفر / خطأ ⇒ 0', () => {
    expect(amountTextToMinor('')).toBe(0);
    expect(amountTextToMinor('0')).toBe(0);
    expect(amountTextToMinor('0.00')).toBe(0);
    expect(amountTextToMinor('abc')).toBe(0);
  });

  test('الفاصلة العشرية الاعتيادية بعد الفتح تعمل', () => {
    expect(amountTextToMinor('12.')).toBe(1200);
  });

  test('فاصلة أوروبية «,» مفهومة (توافق خلفي)', () => {
    expect(amountTextToMinor('12,50')).toBe(1250);
  });
});
