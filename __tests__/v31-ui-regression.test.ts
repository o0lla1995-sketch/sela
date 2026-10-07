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
    const notePos = src.indexOf('style={sheetStyles(c).noteInput}');
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

  test('وضع العدّ يُفعَّل بضغط المنتج نفسه لا بأي رد فعل تركيز', () => {
    const src = read(STOCKTAKE);
    expect(src).toContain('onPressRow');
    expect(src).toContain('onPressProduct');
    // The count input keeps NO focus reactions.
    const countInput = src.slice(
      src.indexOf('style={styles.countInput}'),
      src.indexOf('style={styles.countInput}') + 500,
    );
    expect(countInput).not.toContain('onFocus=');
  });

  test('الطيّ يسبق التركيز — التركيز المؤجّل بعد استقرار الشجرة', () => {
    const src = read(STOCKTAKE);
    // setCountMode(true) is called BEFORE the delayed focus chain.
    const collapsePos = src.indexOf('setCountMode(true)');
    const timerPos = src.indexOf('countFocusTimer.current = setTimeout');
    expect(collapsePos).toBeGreaterThan(-1);
    expect(timerPos).toBeGreaterThan(collapsePos);
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
