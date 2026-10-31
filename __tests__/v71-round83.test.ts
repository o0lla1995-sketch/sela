/**
 * v71 — الجولة 83: ملاحظات التاجر على تطبيق نقطة البيع (أندرويد).
 * ─────────────────────────────────────────────────────────────────
 * ١. الفاتورة تفتقر للتفاصيل — طلب التاجر نصاً: «في الفاتورة الخاصة
 *    بالمبيعات... طريقة الدفع سواء نقدي أو محفظة أو بنك ونوعه وحتى
 *    في تفاصيل أصناف الفاتورة غير واضحة وخصوصاً عندما يكون المنتج
 *    له أحجام أو وحدات أو عدد لا يميز الاختيار الخاص بالمنتج».
 *    → طريقة الدفع بنوعها وجهتها (محفظة جوال باي) + سطر قطع تحت
 *    كل صنف متعدد القطع (وحدة/باكج): «= 6 قطعة».
 * ٢. خيارات بيع بالعدد (باكجات) في المنتج السريع — «نفس المنتج يباع
 *    بالقطعة الواحدة بشيكل واحد ولكن مع خيارات أخرى تظهر عند
 *    اختيار المنتج في البيع قبل إضافته للسلة — 3 حبات بـ2 شيكل أو
 *    5 حبات بـ3 شيكل — مثل منتجات المطاعم والكافيهات ولكن ليس
 *    أحجاماً بل عدداً، ويميزها في الفاتورة» + تحديث صورة معاينة
 *    شكل الفاتورة في إعدادات الطابعة بالشكل الجديد.
 * ٣. حذفات صريحة: زر «منتج سريع» من صفحة البيع، الوحدات الإضافية
 *    من صفحة المنتج السريع (استُبدلت بالباكجات)، وخيار الباركود من
 *    نافذة الإضافة السريعة.
 * ٤. اختيار افتراضي مسبق — «عند الضغط على منتج له أحجام أو عدد يبقى
 *    زر الإضافة للسلة مغلقاً ولا حجم محدد مسبقاً... إذا لم يختر
 *    يضاف الاختيار الافتراضي ليسهل البيع بسرعة».
 * ٥. الرجوع للفاتورة السابقة من السلة الفارغة بلمسة واحدة.
 * ٦. الإصدار: 71.0.0 (79) — نفس مفتاح توقيع Play (بلا تغيير).
 */
const read = (p: string) => require('fs').readFileSync(p, 'utf8') as string;

const POS = 'src/screens/PosScreen.tsx';
const RECEIPT = 'src/services/printer/receipt.ts';
const PREVIEW = 'src/services/printer/receiptPreview.ts';
const QUICK_SERVICE = 'src/services/QuickProductService.ts';
const QUICK_SHEET = 'src/components/QuickProductSheet.tsx';
const CART = 'src/stores/cartStore.ts';
const PAYMENTS = 'src/core/paymentMethods.ts';
const CONFIG = 'src/core/config.ts';
const GRADLE = 'android/app/build.gradle';

describe('v71 — ١ الفاتورة: طريقة الدفع بنوعها + تفاصيل القطع', () => {
  test('تسمية طريقة الدفع للفاتورة: النوع + الجهة', () => {
    const src = read(PAYMENTS);
    expect(src).toContain('paymentMethodReceiptLabel');
    expect(src).toContain("method.kind === 'wallet'");
    expect(src).toContain('محفظة');
  });

  test('الإيصال يطبع طريقة الدفع بنوعها وجهتها', () => {
    const src = read(RECEIPT);
    expect(src).toContain('paymentMethodReceiptLabel');
    expect(src).toContain('طريقة الدفع: ${paymentMethodReceiptLabel(');
  });

  test('سطر القطع تحت كل صنف متعدد القطع (وحدة أكبر / باكج)', () => {
    const src = read(RECEIPT);
    expect(src).toContain('baseQty > item.quantity');
    expect(src).toContain('قطعة');
  });
});

describe('v71 — ٢ خيارات بيع بالعدد (باكجات) في المنتج السريع', () => {
  test('الخدمة تبني الباكجات متغيرات أحجام (حبة + كل باكج بعدده وسعره)', () => {
    const svc = read(QUICK_SERVICE);
    expect(svc).toContain('QuickPackage');
    expect(svc).toContain('quickPackageLabel');
    expect(svc).toContain("kind: 'size'");
    expect(svc).toContain("size: 'حبة'");
    expect(svc).toContain('parsePackageCount');
    // الباكج للقطعي فقط.
    expect(svc).toContain('خيارات بيع العدد متاحة للمنتجات القطعية فقط');
  });

  test('سطر الباكج في السلة يخصم المخزون بالقطع (conversion = عدد الحبات)', () => {
    const cart = read(CART);
    expect(cart).toContain('toPackageLine');
    expect(cart).toContain('addPackageLine');
    expect(cart).toContain('conversion: count');
  });

  test('نقطة البيع توجّه خيار «N حبات» إلى سطر الباكج', () => {
    const pos = read(POS);
    expect(pos).toContain('parsePackageCount(sizeVariant.size)');
    expect(pos).toContain('addPackageLine(product, sizeVariant, packageCount, qty)');
  });

  test('الواجهة: قسم مطوي بصفوف (عدد + سعر) وإضافة خيار', () => {
    const sheet = read(QUICK_SHEET);
    expect(sheet).toContain('خيارات بيع بالعدد');
    expect(sheet).toContain('عدد الحبات');
    expect(sheet).toContain('سعر الباكج');
    expect(sheet).toContain('إضافة خيار آخر');
    expect(sheet).toContain('parsePackageRows');
  });

  test('معاينة شكل الفاتورة تعرض الإضافات الجديدة (طريقة الدفع + باكج + قطع)', () => {
    const preview = read(PREVIEW);
    expect(preview).toContain('paymentMethodReceiptLabel');
    expect(preview).toContain('طريقة الدفع:');
    expect(preview).toContain("variantLabel: '3 حبات'");
    expect(preview).toContain('قطعة');
  });
});

describe('v71 — ٣ الحذفات الصريحة', () => {
  test('زر «منتج سريع» حُذف من صفحة البيع', () => {
    const pos = read(POS);
    expect(pos).not.toContain('QuickProductSheet');
    expect(pos).not.toContain('quickAddOpen');
    expect(pos).not.toContain('quickAddBtn');
  });

  test('خيار الباركود حُذف من نافذة المنتج السريع', () => {
    const sheet = read(QUICK_SHEET);
    expect(sheet).not.toContain('باركود (اختياري)');
    expect(sheet).not.toContain('setBarcode');
  });

  test('الوحدات الإضافية القديمة حُذفت (استُبدلت بالباكجات)', () => {
    const sheet = read(QUICK_SHEET);
    expect(sheet).not.toContain('وحدات إضافية');
    expect(sheet).not.toContain('parseExtraRows');
  });
});

describe('v71 — ٤ الاختيار الافتراضي في نافذة البيع', () => {
  test('أول حجم/خيار معيّن مسبقاً — زر الإضافة فعّال دائماً', () => {
    const pos = read(POS);
    expect(pos).toContain('sizeVariants.find(v => v.id === pickedSizeId) ??');
    expect(pos).toContain('sizeVariants[0] ??');
    expect(pos).not.toContain("'اختر الحجم أولاً'");
  });

  test('الملابس: أول مقاس متوفر افتراضياً', () => {
    const pos = read(POS);
    expect(pos).toContain('colorVariants[0] ??');
  });
});

describe('v71 — ٥ الرجوع للفاتورة السابقة من السلة الفارغة', () => {
  test('restoreLines في مخزن السلة (استبدال كامل بأسعار الفاتورة)', () => {
    const cart = read(CART);
    expect(cart).toContain('restoreLines');
    expect(cart).toContain('normalizeLine');
  });

  test('زر الاسترجاع بآخر فاتورة برقمها وإجماليها', () => {
    const pos = read(POS);
    expect(pos).toContain('buildRecallLines');
    expect(pos).toContain('recallLastInvoice');
    expect(pos).toContain('الرجوع للفاتورة السابقة');
    expect(pos).toContain('SaleRepo.listRecent(1)');
    expect(pos).toContain('restoreLines(');
  });

  test('بناء الأسطر يحفظ الأسعار الأصلية ومعامل تحويل الباكجات', () => {
    const pos = read(POS);
    expect(pos).toContain('baseQty / qty');
    expect(pos).toContain('item.variant_label ?? null');
  });
});

describe('v71 — ٦ الإصدار والتوقيع', () => {
  test('71.0.0 (79) في config والبناء', () => {
    expect(read(CONFIG)).toContain("APP_VERSION = '71.0.0'");
    expect(read(CONFIG)).toContain('APP_BUILD_CODE = 79');
    expect(read(GRADLE)).toContain('versionCode 79');
    expect(read(GRADLE)).toContain('versionName "71.0.0"');
  });

  test('CI يوقّع بنفس مفتاح Play في كل بناء (بلا تغيير)', () => {
    const ci = read('.github/workflows/android-release.yml');
    expect(ci).toContain('ANDROID_KEYSTORE_BASE64');
    expect(ci).toContain('play-release.keystore');
  });
});
