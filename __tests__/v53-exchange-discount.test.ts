/**
 * v53 — الجولة 58: خصم الاستبدال + إصلاحات Hermes.
 * ─────────────────────────────────────────────────────────────────
 * ① الاستبدال يسعّر البدائل بعد خصم المنتج (liveUnitPrice بكل
 *    مساراته: متغير/تجاوز وحدة/تحويل وحدة/سعر أساس) — كان يسعّر
 *    بالسعر الكامل فيدفع الزبون فرقاً أعلى من حقه.
 * ② شاشة الاستبدال تعرض السعر المخفّض (مشطوب + نسبة) في القائمة
 *    ووحدات القياس وسطر الكمية.
 * ③ GoogleDriveService لا يستعمل URLSearchParams (غير موجودة في
 *    محرك Hermes بـ RN 0.74 — كانت تكسر ربط درايف بصمت).
 * ④ LicenseService لا يستعمل مُنشِئ URL (غير موجود في Hermes —
 *    كان يرفض كل روابط التفعيل على الجهاز).
 * ⑤ الإصدار 57.0.0 (65).
 */
import {applyProductDiscount} from '../src/stores/cartStore';

const read = (p: string) => require('fs').readFileSync(p, 'utf8') as string;

describe('v53 — خصم الاستبدال + إصلاحات Hermes', () => {
  test('① liveUnitPrice يطبّق الخصم على كل المسارات الأربعة', () => {
    const screen = read('src/screens/invoices/InvoicesScreen.tsx');
    // المتغير
    expect(screen).toContain(
      'return applyProductDiscount(openVariant.retail_price, openProductRow);',
    );
    // تجاوز سعر الوحدة
    expect(screen).toContain(
      'return applyProductDiscount(override, openProductRow);',
    );
    // سعر الأساس × معامل تحويل الوحدة
    expect(screen).toContain(
      `return applyProductDiscount(
        openProductRow.retail_price * openUnit.conversion,
        openProductRow,
      );`,
    );
    // سعر الأساس مباشرة
    expect(screen).toContain(
      `return applyProductDiscount(
      openProductRow.retail_price,
      openProductRow,
    );`,
    );
    // الاستيراد موجود
    expect(screen).toContain(
      "import {applyProductDiscount} from '../../stores/cartStore';",
    );
  });

  test('② عروض الأسعار المخفّضة في واجهة الاستبدال', () => {
    const screen = read('src/screens/invoices/InvoicesScreen.tsx');
    // بطاقة الصنف في القائمة: السعر الأصلي مشطوب + المخفّض + النسبة
    expect(screen).toContain('applyProductDiscount(product.retail_price, product)');
    // شارة النسبة في القائمة
    expect(screen).toContain('` -${Math.round(product.discount_pct ?? 0)}%`');
    // سطر الكمية: السعر قبل الخصم مشطوباً
    expect(screen).toContain('liveUnitPriceBeforeDiscount');
    expect(screen).toContain('liveDiscounted');
  });

  test('③ الحساب الرياضي للخصم مطابق للسلة', () => {
    const product = {discount_pct: 25} as never;
    // 100 → 75، مع تقريب قرشين (خانتان عشريتان)
    expect(applyProductDiscount(100, product)).toBe(75);
    expect(applyProductDiscount(10.555, product)).toBe(7.92);
    // خصم 0 = السعر كما هو
    expect(applyProductDiscount(80, {discount_pct: 0} as never)).toBe(80);
    // حد أقصى 95%
    expect(applyProductDiscount(100, {discount_pct: 100} as never)).toBe(5);
  });

  test('④ GoogleDriveService خالٍ من URLSearchParams (غير موجودة في Hermes)', () => {
    const drive = read('src/services/GoogleDriveService.ts');
    expect(drive).not.toContain('new URLSearchParams');
    expect(drive).toContain('encodeURIComponent');
  });

  test('⑤ LicenseService خالٍ من مُنشِئ URL (غير موجود في Hermes)', () => {
    const license = read('src/services/license/LicenseService.ts');
    expect(license).not.toContain('new URL(');
    // التحقق البديل بالتعابير النمطية يقبل http/https بأسماء مضيف صالحة
    const src = license;
    const fnStart = src.indexOf('export function isValidServerUrl');
    const fnBody = src.slice(fnStart, src.indexOf('\n}', fnStart));
    expect(fnBody).toMatch(/https\?/);
    expect(fnBody).not.toContain('new URL');
  });

  test('⑥ الإصدار: 58.0.0 (66)', () => {
    const config = read('src/core/config.ts');
    expect(config).toContain("APP_VERSION = '58.0.0'");
    expect(config).toContain('APP_BUILD_CODE = 66');
    const gradle = read('android/app/build.gradle');
    expect(gradle).toContain('versionName "58.0.0"');
    expect(gradle).toContain('versionCode 66');
  });
});
