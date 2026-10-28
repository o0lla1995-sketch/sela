/**
 * v67 (الجولة 79) — حرّوس الجذرية الثلاث لأندرويد:
 * ① نافذة الدفع: جذر اختفاء البنوك والمحافظ كان انهيار شبكة الطرق
 *    إلى ارتفاع صفر (ScrollView بـ flex:1 داخل حاوية بلا ارتفاع
 *    محدد — paySheet بلا height، فقط maxHeight). العلاج flexShrink
 *    (نفس درس نافذة الوزن العاملة) في كل خطوات النافذة الثلاث.
 * ② الوحدات والمتغيرات تبقى محفوظة: وحدات الطول/الحجم صارت متاحة
 *    في نموذج المنتج + إنشاء وحدة من داخل النموذج + المقاسات
 *    والألوان المخصصة تُحفظ دائماً في الإعدادات وتظهر في كل منتج
 *    جديد (كانت حالة مؤقتة تضيع مع «حفظ وإضافة آخر»).
 * ③ استلام دفع الطلبات أونلاين بكل الطرق المفعلة — سند التحصيل
 *    على القناة الصحيحة وفاتورة الطلب تحمل الطريقة.
 */
import {readFileSync} from 'fs';
import {resolve} from 'path';

const ROOT = resolve(__dirname, '..');

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf8');
}

const POS = 'src/screens/PosScreen.tsx';
const FORM = 'src/screens/inventory/ProductFormScreen.tsx';
const SETTINGS = 'src/stores/settingsStore.ts';
const ORDERS = 'src/screens/online/OnlineOrdersScreen.tsx';
const ONLINE = 'src/services/online/OnlineStoreService.ts';

describe('v67 ① — جذر اختفاء طرق الدفع من نافذة الدفع', () => {
  test('لا flex:1 خاماً داخل نافذة الدفع بعد اليوم', () => {
    const pos = read(POS);
    expect(pos).not.toContain("style={{flex: 1}}\n            contentContainerStyle={styles.payMethodsGrid}");
    expect(pos).not.toContain("style={{flex: 1}}\n            contentContainerStyle={styles.payScroll}");
  });

  test('خطوات النافذة الثلاث تستعمل payScrollArea (flexShrink)', () => {
    const pos = read(POS);
    const uses = pos.split('style={styles.payScrollArea}').length - 1;
    expect(uses).toBe(3);
    expect(pos).toContain('payScrollArea: {');
    expect(pos).toContain('flexShrink: 1,');
  });
});

describe('v67 ②أ — الوحدات: الطول والحجم متاحة + إنشاء من النموذج', () => {
  test('unitKindAllowed يفسح الطول والحجم حسب طريقة البيع', () => {
    const form = read(FORM);
    expect(form).toContain("unit.kind === 'length'");
    expect(form).toContain("unit.kind === 'volume'");
    expect(form).toContain('const unitKindAllowed = useCallback(');
  });

  test('منتقي الوحدة داخل الصف يستعمل الفلطر الواحد نفسه', () => {
    const form = read(FORM);
    expect(form).toContain('unitKindAllowed(unit)),');
    // لا فلطر قديم ثنائي متبقٍ داخل الصف (قطعة فقط للأقطعي)
    expect(form).not.toContain("? unit.kind === 'weight'\n                              : unit.kind === 'piece'");
  });

  test('إنشاء وحدة جديدة يحفظها في القاعدة فوراً', () => {
    const form = read(FORM);
    expect(form).toContain('UnitRepo.create(');
    expect(form).toContain("'وحدة جديدة'");
    expect(form).toContain('ستظهر في كل منتج جديد');
  });
});

describe('v67 ②ب — المقاسات والألوان المخصصة تبقى محفوظة', () => {
  test('مخزن الإعدادات يحمل القائمتين الدائمتين', () => {
    const settings = read(SETTINGS);
    expect(settings).toContain('customSizes: Record<string, string[]>;');
    expect(settings).toContain('customColors: Record<string, string[]>;');
    expect(settings).toContain('export function addCustomVariantOption(');
    expect(settings).toContain('export function removeCustomVariantOption(');
    expect(settings).toContain('export function customVariantOptions(');
  });

  test('النموذج يدمج المحفوظ في الرقائق ويحفظ كل إضافة', () => {
    const form = read(FORM);
    expect(form).toContain('...savedCustomSizes,');
    expect(form).toContain('...savedCustomColors,');
    expect(form).toContain("addCustomVariantOption('size'");
    expect(form).toContain("addCustomVariantOption('color'");
    expect(form).toContain("removeCustomVariantOption('size'");
    expect(form).toContain("removeCustomVariantOption('color'");
    // رسالة الحفظ الدائم تشرح للتاجر ما حدث
    expect(form).toContain('سيظهر في كل منتج جديد');
  });
});

describe('v67 ③ — استلام دفع الطلبات أونلاين بكل الطرق', () => {
  test('deliverOrder يستقبل طريقة الدفع ويقيد بها السند والفاتورة', () => {
    const online = read(ONLINE);
    expect(online).toContain("paymentMethod: string = 'cash',");
    expect(online).toContain('paymentMethod,');
    expect(online).toContain(
      'UPDATE sales SET payment_method = ? WHERE invoice_number = ?',
    );
  });

  test('نافذة التحصيل تعرض الطرق المفعلة وتأكيداً يحمل الطريقة', () => {
    const orders = read(ORDERS);
    expect(orders).toContain('استلام دفع الطلب');
    expect(orders).toContain('collectMethods');
    expect(orders).toContain('activePaymentMethods');
    expect(orders).toContain('openCollect');
    expect(orders).toContain('confirmCollect');
    expect(orders).toContain('تحصيل عبر');
  });

  test('زر التسليم يفتح نافذة الطرق لا التحصيل النقدي الصامت', () => {
    const orders = read(ORDERS);
    expect(orders).toContain('تأكيد التسليم واستلام الدفع');
    expect(orders).not.toContain('تأكيد التسليم (الدين → الخزينة)');
  });
});
