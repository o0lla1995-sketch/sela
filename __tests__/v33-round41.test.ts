/**
 * v33 (round-41) — اختبارات حراسة الجولة:
 * (#1) تسديد الدين المحلي: المبلغ ≤ الدين القائم دائماً — مسار
 *      الدفع الزائد القديم (رصيد دائن) حُذف بطلب التاجر.
 * (#2) نافذة بيع بالدين: زرا صِلة يظهران فقط عند الربط الفعلي.
 * (#4) أنماط المتجر: ستة أنماط بتعريفات سليمة والبقالة افتراضية.
 * (#9) صفحة المنتج: أقسام قابلة للطي وترتيب الهوية أولاً.
 * (#10) الرئيسية: الخزينة والديون أعلى ثم قسم اليوم.
 * (#11) صلة 0075: أعمدة device_* ومصادر الحقيقة الجديدة.
 */
const read = (path: string) =>
  require('fs').readFileSync(path, 'utf8') as string;

const DEBTS = 'src/screens/debts/LocalDebtsScreen.tsx';
const POS = 'src/screens/PosScreen.tsx';
const MODES = 'src/core/storeModes.ts';
const SETTINGS_STORE = 'src/stores/settingsStore.ts';
const SETTINGS = 'src/screens/settings/SettingsScreen.tsx';
const PRODUCT_FORM = 'src/screens/inventory/ProductFormScreen.tsx';
const HOME = 'src/screens/HomeScreen.tsx';
const SILA_API = 'src/services/sila/SilaApi.ts';
const SILA_REPO = 'src/services/sila/SilaRepo.ts';
const SILA_SCREEN = 'src/screens/sila/SilaScreen.tsx';
const CONNECTION = 'src/database/connection.ts';

describe('v33 #1 — تسديد الدين المحلي ≤ الدين القائم', () => {
  test('المبلغ الأكبر من الدين يُرفض — لا مسار دفع زائد', () => {
    const src = read(DEBTS);
    expect(src).toContain('amountMinor > outstandingMinor');
    expect(src).toContain('أدخل مبلغاً أقل أو مساوياً للدين القائم');
    // مسار «سيُطفأ الدين والزيادة رصيد دائن» حُذف نهائياً.
    expect(src).not.toContain('رصيداً دائناً للزبون تُخصم من مشترياته');
  });

  test('لا سداد بلا دين قائم', () => {
    const src = read(DEBTS);
    expect(src).toContain("outstandingMinor <= 0");
    expect(src).toContain('لا يوجد دين قائم على هذا الزبون');
  });
});

describe('v33 #2 — زرا صِلة في نافذة بيع بالدين عند الربط فقط', () => {
  test('الزران داخل بوابية silaPaired', () => {
    const src = read(POS);
    const gate = src.indexOf('{silaPaired ? (');
    const scan = src.indexOf('مسح رمز الزبون', gate);
    const pick = src.indexOf('اختيار من الزبائن', scan);
    const local = src.indexOf('زبون من دفتر المتجر');
    expect(gate).toBeGreaterThan(-1);
    expect(scan).toBeGreaterThan(gate);
    expect(pick).toBeGreaterThan(scan);
    // الزر المحلي بعد البوابة — يعمل بلا ربط.
    expect(local).toBeGreaterThan(-1);
  });

  test('لا أزرار معتمة dead-state بلا ربط', () => {
    const src = read(POS);
    expect(src).not.toContain('!silaPaired && {opacity: 0.55}');
  });
});

describe('v33 #4 — أنماط المتجر', () => {
  test('ستة أنماط بمفاتيح سليمة والبقالة أولاً (افتراضية)', () => {
    const src = read(MODES);
    for (const key of [
      "'grocery'",
      "'cafe'",
      "'clothing'",
      "'pharmacy'",
      "'fruits'",
      "'restaurant'",
    ]) {
      expect(src).toContain(`key: ${key}`);
    }
    // البقالة أولاً — fallback storeModeConfig في حال أي خلل.
    const firstConcrete = src.indexOf("key: '");
    expect(src.slice(firstConcrete, firstConcrete + 20)).toContain('grocery');
  });

  test('لكل نمط: أصناف ووحدات وطريقة بيع وسلوك أقسام', () => {
    const src = read(MODES);
    expect(src.match(/categorySeeds: \[/g)?.length).toBe(6);
    expect(src.match(/unitSeeds: \[/g)?.length).toBe(6);
    expect(src.match(/    defaultSaleMode: '/g)?.length).toBe(6);
    expect(src.match(/    saleModeSelector: /g)?.length).toBe(6);
    // فواكه = وزن افتراضياً؛ مطعم/ملابس بلا مبدّل وزن.
    expect(src).toContain("defaultSaleMode: 'weight'");
  });

  test('الإعدادات: storeMode افتراضياً بقالة + قسم نمط المتجر', () => {
    expect(read(SETTINGS_STORE)).toContain("storeMode: 'grocery'");
    const settings = read(SETTINGS);
    expect(settings).toContain('نمط المتجر');
    expect(settings).toContain('applyStoreMode');
    // التبديل يزرع ولا يحذف أبداً.
    expect(settings).toContain('CategoryRepo.create');
    expect(settings).toContain('UnitRepo.create');
  });
});

describe('v33 #9 — صفحة المنتج: طي وترتيب', () => {
  test('FoldSection موجود — v34: قسمان قابلان للطي فقط (الصلاحية والبصمة)، والاستلام صار قسماً ظاهراً دائماً قبل الأسعار', () => {
    const src = read(PRODUCT_FORM);
    expect(src).toContain('function FoldSection');
    // v34 (الجولة 42 #3): الاستلام غير مطوي — «إدخال البضائع لا بد
    // أن يكون قبل إدخال أسعار التكلفة» — فبقي طيّان فقط.
    expect((src.match(/<FoldSection/g) ?? []).length).toBe(2);
    // الترتيب المنطقي: بيانات ← تصنيف ← طريقة بيع ← إدخال البضاعة ←
    // سعر التكلفة.
    const details = src.indexOf('title="بيانات المنتج"');
    const category = src.indexOf('Category picker');
    const saleMode = src.indexOf('title="طريقة البيع"');
    const receiving = src.indexOf('title="إدخال البضاعة"');
    const cost = src.indexOf('ref={costRef}');
    expect(details).toBeGreaterThan(-1);
    expect(category).toBeGreaterThan(details);
    expect(saleMode).toBeGreaterThan(category);
    expect(receiving).toBeGreaterThan(saleMode);
    expect(cost).toBeGreaterThan(receiving);
  });

  test('الهوية أولاً ثم التصنيف ثم طريقة البيع ثم الأسعار', () => {
    const src = read(PRODUCT_FORM);
    const details = src.indexOf('title="بيانات المنتج"');
    const category = src.indexOf('Category picker');
    const saleMode = src.indexOf('title="طريقة البيع"');
    const cost = src.indexOf('ref={costRef}');
    expect(details).toBeGreaterThan(-1);
    expect(category).toBeGreaterThan(details);
    expect(saleMode).toBeGreaterThan(category);
    expect(cost).toBeGreaterThan(saleMode);
  });

  test('النمط يقود الظهور: صلاحية/استلام/بصرة/مبدّل البيع', () => {
    const src = read(PRODUCT_FORM);
    expect(src).toContain("modeConfig.expiry !== 'hidden'");
    expect(src).toContain('modeConfig.receiving ? (');
    expect(src).toContain('modeConfig.vision ? (');
    expect(src).toContain('modeConfig.saleModeSelector ? (');
    expect(src).toContain('modeConfig.defaultSaleMode');
  });

  test('الملابس v35: موديل واحد بمتغيرات من الربطة — لا توزيع على منتجات', () => {
    const src = read(PRODUCT_FORM);
    // النظام القديم (appendVariant وربطة v34 بتوليد منتج لكل مقاس)
    // حُذف — التاجر رفض التوزيع.
    expect(src).not.toContain('appendVariant');
    expect(src).not.toContain('style_group: styleGroup');
    // الربطة: ألوان متعددة × مقاسات متعددة × عدد الربط — كل
    // (لون × مقاس) متغير بمخزونه داخل المنتج الواحد.
    expect(src).toContain('saveLot');
    expect(src).toContain('lotSizes');
    expect(src).toContain('lotColors');
    expect(src).toContain('lotBundles');
    expect(src).toContain('has_variants: 1');
    expect(src).toContain('VariantRepo.replaceForProduct');
    // إجمالي القطع = ألوان × مقاسات × ربط.
    expect(src).toContain(
      'colors.length * lotSizes.length * bundles',
    );
  });
});

describe('v33 #10 — الرئيسية: الخزينة والديون أولاً', () => {
  test('v34: بطاقتا اليوم مدموجتان داخل بطاقة الخزينة والديون — لا قسم مستقل لليوم (v42: عنوان القسم حُذف بطلب التاجر)', () => {
    const src = read(HOME);
    // v42 (الجولة 50 #4): عنوان «الخزينة والديون» حُذف — البطاقة
    //  نفسها تشرح نفسها والشاشة تبدأ مباشرة بالأرقام.
    expect(src).not.toContain('title="الخزينة والديون"');
    // قسم «اليوم» المستقل حُذف — قيمه داخل البطاقة الموحدة.
    expect(src).not.toContain('title="اليوم"');
    // البطاقة نفسها وقيمها باقية في مكانها أعلى الشاشة.
    expect(src).toContain('styles.moneyCard');
    expect(src).toContain('مبيعات اليوم');
    expect(src).toContain('صافي ربح اليوم');
  });

  test('عرض الكل في تنبيهات المخزون يفتح صفحة التنبيهات المخصصة', () => {
    const src = read(HOME);
    expect(src).toContain("navigate('StockAlerts' as never)");
    expect(src).not.toContain(
      "navigate('Notifications' as never)",
    );
  });
});

describe('v33 #11 — صلة 0075: حسابات منفصلة لكل نقطة', () => {
  test('الواجهة: حقول device_* ومدخلات السجل تحمل نقطتها', () => {
    const src = read(SILA_API);
    expect(src).toContain('device_outstanding_minor?: number');
    expect(src).toContain('device_purchases_minor?: number');
    expect(src).toContain('device_payments_minor?: number');
    expect(src).toContain('pos_device_id?: string | null');
    expect(src).toContain('pos_device_name?: string | null');
  });

  test('قاعدة البيانات: ترحيل v18 بأعمدة النقطة', () => {
    const src = read(CONNECTION);
    expect(src).toContain('device_outstanding_minor');
    expect(src).toContain('ترحيل v18');
    // الترتيب: v17 قبل v18 (ترحيل الصلاحية يبقى يعمل).
    expect(src.indexOf('if (version < 17)')).toBeLessThan(
      src.indexOf('if (version < 18)'),
    );
  });

  test('المستودع: تخزين وجمع أرصدة النقطة', () => {
    const src = read(SILA_REPO);
    expect(src).toContain('deviceTotalMinor');
    expect(src).toContain('excluded.device_outstanding_minor');
  });

  test('الشاشة: سقف السداد من دين النقطة + تفصيل المنشأ', () => {
    const src = read(SILA_SCREEN);
    expect(src).toContain('customer.device_outstanding_minor > 0');
    expect(src).toContain('otherStoresMinor');
    expect(src).toContain('appOpsMinor');
    expect(src).toContain('الإجمالي الشامل لدى التاجر');
  });
});
