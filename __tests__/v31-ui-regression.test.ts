/**
 * v31 (round-39) — حرس الانحدار: دروس لوحة المفاتيح ووضع البيع.
 * ─────────────────────────────────────────────────────────────────
 * هذه الجولة أعادت هيكلة واجهات ثلاثاً (وضع العدّ بالجرد، لوحة
 * أرقام الخزينة الدائمة، البيع السريع فوق القفل). معظم التغيير
 * تخطيطي، والخطر الحقيقي هو أن يُعيد مستقبلٌ ما — عن غير قصد —
 * الأنماط التي قتلت لوحة المفاتيح على روم الجهاز أربع جولات:
 * أي تغيّر شجرة لحظة فتح اللوحة يُغلقها فوراً. هذه الاختبارات
 * تقرأ المصدر وتثبّت الثوابت الحرجة.
 */
import {ROOT} from './helpers/app';
import fs from 'fs';
import path from 'path';

const read = (file: string): string =>
  fs.readFileSync(path.join(ROOT, file), 'utf8');

const CASH = 'src/screens/cash/CashMovementsScreen.tsx';
const STOCKTAKE = 'src/screens/inventory/StocktakeScreen.tsx';
const LOCK = 'src/components/AppLockGate.tsx';
const POS = 'src/screens/PosScreen.tsx';

describe('v31 — نوافذ الخزينة: لوحة الأرقام دائمة', () => {
  test('لا حالة تركيز تخفي اللوحة (نمط قاتل الـ IME ممنوع)', () => {
    const src = read(CASH);
    expect(src).not.toContain('textFocused');
    expect(src).not.toContain('onFocus={() =>');
    expect(src).not.toContain('onBlur={() =>');
  });

  test('اللوحة مركّبة بلا أي شرط — تفكيكها يعيد فتح النافذة', () => {
    const src = read(CASH);
    // The keypad renders unconditionally (a plain <View>, never
    // wrapped in a ternary).
    expect(src).toContain('<View style={sheetStyles(c).keypad}>');
    expect(src).not.toMatch(/\{!\w+\s*\?\s*\(\s*<View style=\{sheetStyles\(c\)\.keypad\}/);
  });

  test('حُذف صندوق «تم التأمين» الأخضر من النافذة (طلب التاجر)', () => {
    const src = read(CASH);
    expect(src).not.toMatch(/\{authStage === 'passed' \? \(/);
  });

  test('الملاحظة والفئة المخصصة مثبّتان خارج منطقة التمرير', () => {
    const src = read(CASH);
    // Both inputs sit BEFORE the collapsible ScrollView (pinned
    // under the amount) so they stay visible above the system IME.
    // v39 (الجولة 47): style الملاحظة صار مصفوفة (النسخة الكبيرة
    // للسحب/الإيداع) — البحث عن مفتاح noteInput داخل المصفوفة.
    const notePos = src.indexOf('sheetStyles(c).noteInput');
    const scrollPos = src.indexOf('contentContainerStyle={sheetStyles(c).form}');
    expect(notePos).toBeGreaterThan(-1);
    expect(scrollPos).toBeGreaterThan(notePos);
  });
});

describe('v31 — الجرد الفعلي: وضع العدّ بضغط المنتج', () => {
  test('صفر مستمعات Keyboard (إصلاح v29.1 محفوظ بعد إضافة وضع العدّ)', () => {
    const src = read(STOCKTAKE);
    expect(src).not.toContain('keyboardDidShow');
    expect(src).not.toContain('keyboardDidHide');
    expect(src).not.toContain('Keyboard.addListener');
  });

  test('v32 — وضع العدّ الأحادي: الضغط على منتج أو حقل عدّه يفتح بطاقة التركيز', () => {
    const src = read(STOCKTAKE);
    expect(src).toContain('onPressRow');
    // v32: enterCountMode (كان onPressProduct) — بطاقة تركيز أحادية.
    expect(src).toContain('enterCountMode');
    expect(src).toContain('FocusCountCard');
    // The v32 contract: pressing the ROW input focuses then delegates
    // to enterCountMode (blur first → layout swap → delayed focus).
    const rowInput = src.slice(
      src.indexOf('style={styles.countInput}'),
      src.indexOf('style={styles.countInput}') + 700,
    );
    expect(rowInput).toContain('onFocus={onInputFocus}');
  });

  test('v32 — حقل بطاقة التركيز ثابت لا يُفكّك ولا يحمل أي رد فعل تركيز', () => {
    const src = read(STOCKTAKE);
    const focusInput = src.slice(
      src.indexOf('style={styles.focusInput}'),
      src.indexOf('style={styles.focusInput}') + 700,
    );
    expect(focusInput).not.toContain('onFocus=');
    // The text lives in the PARENT so the input is never remounted
    // while navigating between products (keyboard never closes).
    expect(src).toContain('const [focusText, setFocusText]');
    expect(src).toContain('text={focusText}');
  });

  test('v32 — لوحة المفاتيح: زر التالي ينقل للمنتج التالي داخل البطاقة', () => {
    const src = read(STOCKTAKE);
    expect(src).toContain('onAdvance(1)');
    expect(src).toContain('onSubmitEditing={() => {');
  });

  test('الطيّ يسبق التركيز — التركيز المؤجّل بعد استقرار الشجرة', () => {
    const src = read(STOCKTAKE);
    // setCountMode(true) is called BEFORE the delayed focus chain.
    const collapsePos = src.indexOf('setCountMode(true)');
    const timerPos = src.indexOf('countFocusTimer.current = setTimeout');
    expect(collapsePos).toBeGreaterThan(-1);
    expect(timerPos).toBeGreaterThan(collapsePos);
  });

  test('v32 — شريط البحث لا يتحرك بين الوضعين (نفس ارتفاع الشريطين)', () => {
    const src = read(STOCKTAKE);
    expect(src).toContain('minHeight: 44');
    // The focus card sits inside a handled ScrollView so buttons
    // work with a single tap while the keyboard is open.
    const cardWrap = src.slice(
      src.indexOf('focusCardScroll'),
      src.indexOf('focusCardScroll') + 400,
    );
    expect(src).toContain('keyboardShouldPersistTaps="handled"');
  });
});

describe('v31 — قفل التطبيق: نقطة البيع قبل تسجيل الدخول', () => {
  test('الوضع المقفل يعرض نقطة البيع كاملة + زر الدخول', () => {
    const src = read(LOCK);
    expect(src).toContain('QuickSaleView');
    expect(src).toContain('PosScreen');
    expect(src).toContain('onOpenLogin');
    expect(src).toContain('الدخول');
  });

  test('البصمة التلقائية تُطلب على شاشة الدخول لا فوق سطح البيع', () => {
    const src = read(LOCK);
    expect(src).toContain('locked && showLogin && biometricEnabled');
  });

  test('شاشة الدخول تعرض الرجوع لنقطة البيع دون فتح التطبيق', () => {
    const src = read(LOCK);
    expect(src).toContain('onBackToSale');
    expect(src).toContain('رجوع لنقطة البيع');
  });

  test('نقطة البيع التبويبية تحتفظ بحشوتها الأصلية حرفياً', () => {
    const src = read(POS);
    expect(src).toContain('topGap ?? insets.top + spacing.sm');
  });
});
