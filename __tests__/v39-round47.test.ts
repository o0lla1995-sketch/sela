/**
 * v39 — الجولة 47: السبب الجذري لتصفير المخزون + فتح نوافذ البيع
 * فور التعرف + الخزينة (بحث ومراجعة).
 * ─────────────────────────────────────────────────────────────────
 * ① وظيفي (على قاعدة حقيقية):
 *    • الجذر: أي تعديل لمنتج قائم (بقالة/صيدلية/فواكه…) كان يستدعي
 *      VariantRepo.replaceForProduct(targetId, []) «لتنظيف المتغيرات»
 *      فتكتب stock_quantity = 0 فوق الكمية المحفوظة للتو — «تم الحفظ
 *      بنجاح» فوق مخزون مصفَّر. الآن التنظيف الفارغ لا يمس المخزون.
 *    • منتج بأحجام (مطعم/كافيتريا): حفظ الأحجام لا يصفر كمية المنتج
 *      (الأحجام تحمل أسعارها فقط).
 *    • موديل ملابس: sync=true يبقى — مخزون الموديل = مجموع متغيراته.
 *    • الخزينة: list/countFor بالبحث الحر (ملاحظة/سند/فئة) وفلتر
 *      الفئة — النتائج والعدد مطابقان.
 * ② حرّوس المصدر لإصلاحات الواجهة في هذه الجولة.
 */
import {freshApp, load} from './helpers/app';

const read = (path: string) =>
  require('fs').readFileSync(path, 'utf8') as string;

const FORM = 'src/screens/inventory/ProductFormScreen.tsx';
const POS = 'src/screens/PosScreen.tsx';
const VARIANT_REPO = 'src/database/repositories/VariantRepo.ts';
const CASH_REPO = 'src/database/repositories/CashRepo.ts';
const CASH_SCREEN = 'src/screens/cash/CashMovementsScreen.tsx';
const INVOICES = 'src/screens/invoices/InvoicesScreen.tsx';
const SCANNER_MODULE =
  'android/app/src/main/java/com/sela/native_modules/SelaScannerModule.kt';
const SCANNER_ACTIVITY =
  'android/app/src/main/java/com/sela/native_modules/ScannerActivity.kt';
const SCAN_FLOW = 'src/services/vision/scanFlow.ts';
const BRIDGE = 'src/native/nativeBridge.ts';

describe('v39 #1 — جذر تصفير المخزون عند أي تعديل (وظيفي كامل)', () => {
  test('تعديل منتج عادي + وحدة جديدة لا يصفر المخزون', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {ProductRepo} = load('src/database/repositories/ProductRepo');
    const {UnitRepo} = load('src/database/repositories/UnitRepo');
    const {VariantRepo} = load(VARIANT_REPO);

    // منتج بقالة موجود بكمية 150 قطعة.
    const id = await ProductRepo.create({
      name: 'شامبو هيد آند شولدرز',
      cost_price: 8,
      retail_price: 12,
      wholesale_price: 10,
      stock_quantity: 150,
      category_id: null,
      image_uri: null,
    });
    expect((await ProductRepo.getById(id))!.stock_quantity).toBe(150);

    // مسار الحفظ كما تنفذه صفحة المنتج حرفياً عند التعديل:
    // تحديث المنتج (بكمية يدوية معدّلة 200) ثم تنظيف المتغيرات
    // الفارغ — هذا هو المسار الذي كان يكتب صفراً فوق الـ 200.
    await ProductRepo.update(id, {
      name: 'شامبو هيد آند شولدرز',
      cost_price: 8,
      retail_price: 12,
      wholesale_price: 10,
      stock_quantity: 200,
      category_id: null,
      image_uri: null,
    });
    await VariantRepo.replaceForProduct(id, []);

    const after = await ProductRepo.getById(id);
    expect(after!.stock_quantity).toBe(200);

    // وإضافة وحدة جديدة للمنتج القائم (تعديل آخر) — تبقى الكمية.
    // (getOrCreate: وحدات النمط مزروعة مسبقاً بتهيئة القاعدة.)
    const unitId = await UnitRepo.getOrCreate(
      'كرتونة',
      'كرتون',
      'piece',
      'grocery',
    );
    await UnitRepo.replaceForProduct(id, [
      {unit_id: unitId, conversion: 12, barcode: null, retail_price: null, wholesale_price: null},
    ]);
    await VariantRepo.replaceForProduct(id, []);
    const afterUnits = await ProductRepo.getById(id);
    expect(afterUnits!.stock_quantity).toBe(200);
  });

  test('منتج بأحجام (مطعم) — حفظ الأحجام لا يصفر كمية المنتج', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {ProductRepo} = load('src/database/repositories/ProductRepo');
    const {VariantRepo} = load(VARIANT_REPO);

    const id = await ProductRepo.create({
      name: 'شاي بالنعنع',
      cost_price: 2,
      retail_price: 6,
      wholesale_price: 6,
      stock_quantity: 80,
      category_id: null,
      image_uri: null,
      base_unit_name: 'كوب',
    });
    // مسار الأحجام: كل حجم بسعره ومخزونه 0 — والمنتج يبقى بكميته.
    await VariantRepo.replaceForProduct(id, [
      {kind: 'size', color: '', size: 'صغير', stock_quantity: 0, retail_price: 5, cost_price: null},
      {kind: 'size', color: '', size: 'كبير', stock_quantity: 0, retail_price: 8, cost_price: null},
    ]);
    const after = await ProductRepo.getById(id);
    expect(after!.stock_quantity).toBe(80);

    // والأحجام نفسها محفوظة بأسعارها.
    const {VariantRepo: VR} = load(VARIANT_REPO);
    const variants = await VR.listByProduct(id);
    expect(variants.length).toBe(2);
    expect(variants.map(v => v.size).sort()).toEqual(['صغير', 'كبير']);
  });

  test('موديل ملابس — sync يبقى: مخزون الموديل = مجموع متغيراته', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {ProductRepo} = load('src/database/repositories/ProductRepo');
    const {VariantRepo} = load(VARIANT_REPO);

    const id = await ProductRepo.create({
      name: 'تيشيرت قطن',
      cost_price: 10,
      retail_price: 25,
      wholesale_price: 20,
      stock_quantity: 0,
      category_id: null,
      image_uri: null,
      has_variants: 1,
      base_unit_name: 'قطعة',
    });
    await VariantRepo.replaceForProduct(
      id,
      [
        {kind: 'variant', color: 'أسود', size: 'L', stock_quantity: 5},
        {kind: 'variant', color: 'أبيض', size: 'M', stock_quantity: 3},
        {kind: 'variant', color: 'أزرق', size: 'XL', stock_quantity: 7},
      ],
      true,
    );
    const after = await ProductRepo.getById(id);
    expect(after!.stock_quantity).toBe(15);
  });
});

describe('v39 #2 — الخزينة: البحث وفلتر الفئة (وظيفي)', () => {
  test('البحث بالملاحظة والفئة يرشّح السجل والعدّ معاً', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {CashRepo} = load(CASH_REPO);

    await CashRepo.add({
      kind: 'expense',
      category: 'كهرباء',
      note: 'فاتورة كهرباء شهر 10',
      amountMinor: 25000,
    });
    await CashRepo.add({
      kind: 'expense',
      category: 'مشتريات',
      note: 'أكياس وأغراض نظافة',
      amountMinor: 8000,
    });
    await CashRepo.add({
      kind: 'withdrawal',
      note: 'سحب لتسديد المورد أبو محمد',
      amountMinor: 50000,
    });

    // البحث بالملاحظة.
    const byNote = await CashRepo.list({
      from: '2000-01-01',
      to: '2100-01-01',
      search: 'كهرباء',
    });
    expect(byNote.length).toBe(1);
    expect(byNote[0].category).toBe('كهرباء');

    // البحث برقم السند (EXP-...).
    const expRow = byNote[0];
    const byRef = await CashRepo.list({
      from: '2000-01-01',
      to: '2100-01-01',
      search: expRow.ref.slice(0, 8),
    });
    expect(byRef.some(r => r.local_id === expRow.local_id)).toBe(true);

    // فلتر الفئة (نقاط الاصرف).
    const byCategory = await CashRepo.list({
      from: '2000-01-01',
      to: '2100-01-01',
      category: 'كهرباء',
    });
    expect(byCategory.length).toBe(1);
    expect(byCategory[0].note).toContain('كهرباء');

    // العدّ يطابق الترشيح.
    const countAll = await CashRepo.countFor('2000-01-01', '2100-01-01');
    const countCat = await CashRepo.countFor(
      '2000-01-01',
      '2100-01-01',
      'all',
      undefined,
      'كهرباء',
    );
    const countSearch = await CashRepo.countFor(
      '2000-01-01',
      '2100-01-01',
      'all',
      'أبو محمد',
    );
    expect(countAll).toBe(3);
    expect(countCat).toBe(1);
    expect(countSearch).toBe(1);

    // البحث والفئة معاً (تقاطع).
    const both = await CashRepo.list({
      from: '2000-01-01',
      to: '2100-01-01',
      search: 'كهرباء',
      category: 'مشتريات',
    });
    expect(both.length).toBe(0);
  });
});

describe('v39 #3 — حرّوس المصدر: نوافذ فورية عند المسح', () => {
  test('الماسح الأصلي: closeScanner + requestClose موجودة ومتصلة', () => {
    const module = read(SCANNER_MODULE);
    expect(module).toContain('fun closeScanner(');
    expect(module).toContain('ScannerActivity.requestClose()');

    const activity = read(SCANNER_ACTIVITY);
    expect(activity).toContain('fun requestClose()');
    expect(activity).toContain('finishCancelled()');
  });

  test('الجسر وscanFlow يعرّفان closeScannerNow', () => {
    expect(read(BRIDGE)).toContain('closeScanner(): Promise<boolean>');
    expect(read(SCAN_FLOW)).toContain('export async function closeScannerNow');
  });

  test('نقطة البيع: باركود منتج متغيرات يغلق الماسح فوراً ويفتح الخصائص', () => {
    const pos = read(POS);
    // مسار الباركود: منتج الوزن ومنتج المتغيرات كلاهما closeScannerNow.
    expect(pos).toContain("v.kind === 'variant'");
    expect(pos).toMatch(
      /if \(\(product\.variants \?\? \[\]\)\.some\(v => v\.kind === 'variant'\)\) \{[\s\S]*?await closeScannerNow\(\);/,
    );
    // مسار البصري: منتج الوزن يفتح لوحته فور التعرف.
    expect(pos).toContain('أدخل وزنه الآن');
    expect(pos).toContain('void closeScannerNow();');
  });
});

describe('v39 #4 — حرّوس المصدر: الواجهات المتبقية', () => {
  test('نافذة الإرجاع: ملاحظة الإرجاع حُذفت وتحذيرات الحواف توست', () => {
    const invoices = read(INVOICES);
    expect(invoices).not.toContain('debtActionBox');
    expect(invoices).not.toContain('debtAction.length > 0');
    // التحذيرات الحرجة بقيت توست لحظة التأكيد.
    expect(invoices).toContain("debtState.kind === 'missing'");
    expect(invoices).toContain("debtState.kind === 'migrated'");
  });

  test('الخزينة: نافذة مراجعة + بحث + ملاحظة أكبر للسحب/الإيداع', () => {
    const screen = read(CASH_SCREEN);
    expect(screen).toContain('MovementDetailSheet');
    expect(screen).toContain('noteInputBig');
    expect(screen).toContain("mode !== 'expense' ? sheetStyles(c).noteInputBig");
    expect(screen).toContain('categoryFilter');
    expect(screen).toContain('FILTER_CATEGORIES');
    expect(screen).toContain('searchInput');
  });

  test('صفحة المنتج: رفع من المعرض + حفظ وإضافة آخر + تحقق نهائي', () => {
    const form = read(FORM);
    expect(form).toContain('pickProductPhotoFromGallery');
    expect(form).toContain('pickAngleFromGallery');
    expect(form).toContain('حفظ وإضافة آخر');
    // التحقق النهائي بعد كل الكتابات (لا قبلها).
    const verifyIndex = form.indexOf('تعذر تحديث المخزون بدقة');
    const variantIndex = form.indexOf(
      'await VariantRepo.replaceForProduct(targetId, []);',
    );
    expect(verifyIndex).toBeGreaterThan(variantIndex);
    // الملابس فقط تزامن المخزون (المعامل الثالث true).
    expect(form).toMatch(
      /isClothingModel[\s\S]{0,900}VariantRepo\.replaceForProduct\([\s\S]{0,500}true,\s*\);/,
    );
  });

  test('VariantRepo: syncProductStock=false افتراضياً ولا يكتب المخزون إلا بطلب', () => {
    const repo = read(VARIANT_REPO);
    expect(repo).toContain('syncProductStock = false');
    expect(repo).toContain('if (syncProductStock) {');
  });
});
