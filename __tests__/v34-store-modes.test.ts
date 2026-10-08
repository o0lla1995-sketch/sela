/**
 * v34 (الجولة 42 #3) — نظام أنماط المتجر الاحترافي:
 * ─────────────────────────────────────────────────────────────────
 *  • نطاق التصنيفات والوحدات لكل نمط: كل نمط يرى أصنافه فقط،
 *    والتبديل يزرع داخل النطاق (لا تراكم فوق القديم).
 *  • وسم البيانات القديمة مرة واحدة بنمط المتجر الحالي.
 *  • صيدلية: قطعة فقط (لا مبدّل وزن) + استلام بالعلبة بلغة الصيدلية.
 *  • مطعم/كافيتريا: بلا استلام وبلا باركود — إدخال سريع.
 *  • ملابس: ربطة (لون + مقاسات بكميات) تولّد منتجاً لكل مقاس
 *    بباركود داخلي ومجموعة style_group واحدة.
 *  • الشبكة: تجان مجمّع للموديل يفتح نافذة اختيار المقاس.
 */
import {freshApp, load} from './helpers/app';

const read = (path: string) =>
  require('fs').readFileSync(path, 'utf8') as string;

const MODES = 'src/core/storeModes.ts';
const CONNECTION = 'src/database/connection.ts';
const PRODUCT_FORM = 'src/screens/inventory/ProductFormScreen.tsx';
const POS = 'src/screens/PosScreen.tsx';
const SETTINGS = 'src/screens/settings/SettingsScreen.tsx';
const CATALOG = 'src/stores/catalogStore.ts';
const MANAGE_CATS = 'src/screens/inventory/ManageCategoriesScreen.tsx';
const MANAGE_UNITS = 'src/screens/inventory/ManageUnitsScreen.tsx';

describe('v34 — نطاق التصنيفات والوحدات لكل نمط (SQL حقيقي)', () => {
  test('تبديل النمط يزرع داخل نطاقه فقط — لا تراكم فوق القديم', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {CategoryRepo} = load('src/database/repositories/CategoryRepo');
    const {UnitRepo} = load('src/database/repositories/UnitRepo');

    // بقالة (الافتراضي): التصنيفات الافتراضية موسومة بقالة.
    const groceryCats = await CategoryRepo.list('grocery');
    expect(groceryCats.length).toBeGreaterThan(5);
    expect(groceryCats.every(cat => cat.store_mode === 'grocery')).toBe(true);

    // زرع الصيدلية داخل نطاقها — كما تفعل شاشة الإعدادات.
    const existing = await CategoryRepo.list('pharmacy');
    const existingNames = new Set(existing.map(cat => cat.name));
    for (const name of ['أدوية', 'عناية شخصية']) {
      if (!existingNames.has(name)) {
        await CategoryRepo.create(name, 'pharmacy');
      }
    }
    // البقالة لا ترى تصنيفات الصيدلية.
    const groceryAfter = await CategoryRepo.list('grocery');
    expect(
      groceryAfter.some(cat => cat.name === 'أدوية'),
    ).toBe(false);
    // والصيدلية لا ترى تصنيفات البقالة.
    const pharmacyCats = await CategoryRepo.list('pharmacy');
    expect(pharmacyCats.some(cat => cat.name === 'أدوية')).toBe(true);
    expect(
      pharmacyCats.some(cat => cat.name === 'مواد غذائية'),
    ).toBe(false);

    // التفرد داخل النطاق: نفس الاسم في نمطين مختلفين مسموح
    // (عالمان منفصلان)، وداخل النطاط نفسه ممنوع.
    await CategoryRepo.create('مستلزمات', 'clothing');
    await expect(CategoryRepo.create('مستلزمات', 'clothing')).rejects.toThrow();
    await expect(CategoryRepo.create('مستلزمات', 'grocery')).resolves.toBeGreaterThan(0);
  });

  test('الوحدات موسومة بنطاقها — وحدة الصيدلية لا تظهر للبقالة', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {UnitRepo} = load('src/database/repositories/UnitRepo');

    const pharmacyUnits = await UnitRepo.list('pharmacy');
    expect(pharmacyUnits.length).toBe(0);
    await UnitRepo.create('شريط', 'شريط', 'piece', 'pharmacy');
    // «كرتونة» قد تكون مزروعة من بذور البقالة — نضمن وجودها
    // بالنطاق الصحيح (خلق إن لم تكن، وتجاهل التكرار داخل النطاق).
    try {
      await UnitRepo.create('كرتونة', 'كرتون', 'piece', 'grocery');
    } catch {
      // موجودة بالفعل داخل نطاق البقالة — هذا هو المطلوب.
    }

    const groceryView = await UnitRepo.list('grocery');
    expect(groceryView.some(u => u.name === 'شريط')).toBe(false);
    expect(groceryView.some(u => u.name === 'كرتونة')).toBe(true);
    const pharmacyView = await UnitRepo.list('pharmacy');
    expect(pharmacyView.some(u => u.name === 'شريط')).toBe(true);
    expect(pharmacyView.some(u => u.name === 'كرتونة')).toBe(false);
    // بلا وسيط: الكل (النسخ الاحتياطي).
    const all = await UnitRepo.list();
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  test('وسم البيانات القديمة مرة واحدة — tagUntagged ثم لا تتكرر', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {CategoryRepo} = load('src/database/repositories/CategoryRepo');
    const {UnitRepo} = load('src/database/repositories/UnitRepo');

    // البذور موسومة بالنمط الافتراضي — قد يتبقى صف واحد من ترحيل
    // v4 (وقية) فيُوسم هنا بالوسم الأحادي (كما يفعل tagLegacyRowsOnce
    // عند أول إقلاع)، والنداء الثاني لا يجد شيئاً (أحادي فعلاً).
    const catsTagged = await CategoryRepo.tagUntagged('pharmacy');
    expect(catsTagged).toBe(0);
    await UnitRepo.tagUntagged('pharmacy');
    const unitsAgain = await UnitRepo.tagUntagged('pharmacy');
    expect(unitsAgain).toBe(0);
    // والقوائم ما زالت تعمل.
    expect((await CategoryRepo.list('grocery')).length).toBeGreaterThan(0);
  });
});

describe('v34 — ربطة الملابس: منتج لكل مقاس بمجموعة واحدة', () => {
  test('إنشاء الربطة يولّد منتجات مترابطة بباركودات داخلية فريدة', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {ProductRepo} = load('src/database/repositories/ProductRepo');
    const {SilaRepo} = load('src/services/sila/SilaRepo');

    // إنشاء ربطة كما يفعل saveLot: موديل واحد، لون واحد، 3 مقاسات.
    const group = 'بنطال جينز|أسود';
    const sizes = [
      {size: '30', qty: 2},
      {size: '32', qty: 3},
      {size: '34', qty: 1},
    ];
    const barcodes: string[] = [];
    for (const entry of sizes) {
      const id = await ProductRepo.create({
        name: `بنطال جينز — أسود · ${entry.size}`,
        cost_price: 40,
        retail_price: 80,
        wholesale_price: 65,
        stock_quantity: entry.qty,
        category_id: null,
        image_uri: null,
        style_group: group,
        variant_size: entry.size,
        variant_color: 'أسود',
        barcode: `20000000000${barcodes.length + 1}`,
      });
      expect(id).toBeGreaterThan(0);
      barcodes.push(`20000000000${barcodes.length + 1}`);
    }

    // كل مقاس منتج كامل بمخزونه وباركوده — والمجموعة واحدة.
    const all = await ProductRepo.list();
    const lotProducts = all.filter(p => p.style_group === group);
    expect(lotProducts).toHaveLength(3);
    expect(lotProducts.every(p => p.variant_color === 'أسود')).toBe(true);
    expect(lotProducts.map(p => p.variant_size).sort()).toEqual(['30', '32', '34']);
    expect(new Set(lotProducts.map(p => p.barcode)).size).toBe(3);
    // مجموع المخزون = مجموع كميات المقاسات.
    expect(lotProducts.reduce((sum, p) => sum + p.stock_quantity, 0)).toBe(6);

    // التعديل يحافظ على المجموعة (update يمرر style_group كما هو).
    const first = lotProducts[0];
    await ProductRepo.update(first.id, {
      name: first.name,
      cost_price: 45,
      retail_price: 90,
      wholesale_price: 70,
      stock_quantity: 5,
      category_id: null,
      image_uri: null,
      style_group: first.style_group,
      variant_size: first.variant_size,
      variant_color: first.variant_color,
      barcode: first.barcode,
    });
    const after = await ProductRepo.getById(first.id);
    expect(after?.style_group).toBe(group);
    expect(after?.variant_size).toBe(first.variant_size);
    expect(after?.retail_price).toBe(90);
    void SilaRepo; // سياق الاستيراد فقط
  });
});

describe('v34 — إعدادات الأنماط لكل مجال (دراسة v34)', () => {
  test('الصيدلية: قطعة فقط — لا مبدّل وزن إطلاقاً + استلام بالعلبة', () => {
    const src = read(MODES);
    const pharmacyBlock = src.slice(
      src.indexOf("key: 'pharmacy'"),
      src.indexOf("key: 'fruits'"),
    );
    expect(pharmacyBlock).toContain('saleModeSelector: false');
    expect(pharmacyBlock).toContain("defaultSaleMode: 'piece'");
    expect(pharmacyBlock).toContain("container: 'علبة'");
    expect(pharmacyBlock).toContain("perContainer: 'عدد بالعلبة'");
    // وحدات الصيدلية كلها pieces — لا وزن.
    expect(pharmacyBlock).not.toContain("kind: 'weight'");
  });

  test('البقالة فقط فيها مبدّل قطعة/وزن — v35: الفواكه وزن فقط بلا مبدّل', () => {
    const src = read(MODES);
    // v35 (ملاحظة التاجر): «الفواكه بالوزن فقط بلا جملة ومفرق» —
    // المبدّل للبقالة وحدها (1)، والفواكه وزن دائم بسعر كيلو واحد.
    expect((src.match(/saleModeSelector: true/g) ?? []).length).toBe(1);
    const fruitsBlock = src.slice(
      src.indexOf("key: 'fruits'"),
      src.indexOf("key: 'restaurant'"),
    );
    expect(fruitsBlock).toContain("defaultSaleMode: 'weight'");
    expect(fruitsBlock).toContain('saleModeSelector: false');
    // سعر واحد للكيلو — لا جملة للفواكه بعد اليوم.
    expect(fruitsBlock).toContain('wholesaleLabel: null');
    // الفواكه تستلم وزناً بالأكياس — لا صناديق معدودة.
    expect(fruitsBlock).toContain('receivingByContainer: false');
    expect(fruitsBlock).toContain('receivingByBag: true');
  });

  test('المطعم والكافيتريا: إدخال سريع — بلا استلام وبلا باركود وبلا وزن', () => {
    const src = read(MODES);
    const cafeBlock = src.slice(
      src.indexOf("key: 'cafe'"),
      src.indexOf("key: 'clothing'"),
    );
    expect(cafeBlock).toContain('receiving: false');
    expect(cafeBlock).toContain('barcode: false');
    expect(cafeBlock).toContain('saleModeSelector: false');
    const restaurantBlock = src.slice(src.indexOf("key: 'restaurant'"));
    expect(restaurantBlock).toContain('receiving: false');
    expect(restaurantBlock).toContain('barcode: false');
    expect(restaurantBlock).toContain('saleModeSelector: false');
  });

  test('الملابس: ربطة + باركود داخلي + بلا صلاحية ولا وزن', () => {
    const src = read(MODES);
    const clothingBlock = src.slice(
      src.indexOf("key: 'clothing'"),
      src.indexOf("key: 'pharmacy'"),
    );
    expect(clothingBlock).toContain('lotEntry: true');
    expect(clothingBlock).toContain('barcode: true');
    expect(clothingBlock).toContain("expiry: 'hidden'");
    expect(clothingBlock).toContain('receiving: false');
    expect(clothingBlock).not.toContain("kind: 'weight'");
  });

  test('الترحيل v19: أعمدة النطاق والربطة + البذور موسومة', () => {
    const src = read(CONNECTION);
    expect(src).toContain("if (version < 19)");
    expect(src).toContain("['categories', 'store_mode', 'TEXT']");
    expect(src).toContain("['units', 'store_mode', 'TEXT']");
    expect(src).toContain("['products', 'style_group', 'TEXT']");
    expect(src).toContain("['products', 'variant_size', 'TEXT']");
    expect(src).toContain("['products', 'variant_color', 'TEXT']");
    // البذور الافتراضية موسومة بالنمط الافتراضي.
    expect(src).toContain("'INSERT INTO categories (name, store_mode) VALUES (?, ?)'");
  });
});

describe('v34 — صفحة المنتج: الترتيب المنطقي وسلسلة التالي', () => {
  test('إدخال البضاعة قبل أسعار التكلفة — وبملصقات المجال', () => {
    const src = read(PRODUCT_FORM);
    const receiving = src.indexOf('title="إدخال البضاعة"');
    const cost = src.indexOf('ref={costRef}');
    expect(receiving).toBeGreaterThan(-1);
    expect(receiving).toBeLessThan(cost);
    // ملصقات المجال تُستعمل في الحقول.
    expect(src).toContain("modeConfig.receivingLabels?.container");
    expect(src).toContain("modeConfig.receivingLabels?.perContainer");
    // أزرار الاستلام مقيدة بأعلام المجال.
    expect(src).toContain('modeConfig.receivingByContainer ? (');
    expect(src).toContain('modeConfig.receivingByBag ? (');
  });

  test('سلسلة زر التالي كاملة: الاسم ← الباركود ← الاستلام ← التكلفة ← المفرق ← الجملة ← الكمية ← التنبيه', () => {
    const src = read(PRODUCT_FORM);
    expect(src).toContain('receiveCountRef.current?.focus()');
    expect(src).toContain('receivePerRef.current?.focus()');
    expect(src).toContain('receiveCostRef.current?.focus()');
    expect(src).toContain(
      'onSubmitEditing={() => costRef.current?.focus()}',
    );
    expect(src).toContain('retailRef.current?.focus()');
    expect(src).toContain('wholesaleRef.current?.focus()');
    expect(src).toContain('stockRef.current?.focus()');
    expect(src).toContain('thresholdRef.current?.focus()');
  });

  test('الباركود مقيد بالمجالات التي تحتاجه', () => {
    const src = read(PRODUCT_FORM);
    expect(src).toContain('{modeConfig.barcode ? (');
    expect(src).toContain('modeConfig.barcode) {');
  });

  test('وحدات وتصنيفات النموذج من نطاق النمط الحالي', () => {
    const src = read(PRODUCT_FORM);
    expect(src).toContain('CategoryRepo.list(settings.storeMode)');
    expect(src).toContain('UnitRepo.list(settings.storeMode)');
  });
});

describe('v35 — شبكة البيع: نافذة البيع لكل منتج قبل السلة', () => {
  test('الموديل بمتغيراته تجان واحد يفتح نافذة اللون والمقاس — لا توزيع على منتجات', () => {
    const src = read(POS);
    // v35: الموديل الواحد منتج واحد بمتغيرات — نافذة البيع
    // (openSaleSheet) توجه كل منتج لنافذة موده.
    expect(src).toContain('openSaleSheet');
    expect(src).toContain("setSaleSheet({kind: 'clothing', product})");
    expect(src).toContain("setSaleSheet({kind: 'sizes', product})");
    expect(src).toContain("setSaleSheet({kind: 'unit', product})");
    expect(src).toContain("variants.some(v => v.kind === 'variant')");
    expect(src).toContain("variants.some(v => v.kind === 'size')");
    // لا تجميع style_group بعد اليوم — المتغيرات داخل المنتج.
    expect(src).not.toContain(
      "product.style_group != null && product.style_group.length > 0",
    );
  });

  test('السلة تميز سطر المتغير (اللون والمقاس) وسطر الربطة', () => {
    const src = read('src/stores/cartStore.ts');
    // سطر المتغير: خط مستقل بمفتاح المنتج+المتغير.
    expect(src).toContain('addVariantLine');
    expect(src).toContain('variantLabel');
    // ربطة الجملة: قطعة من كل مقاس باللون المختار.
    expect(src).toContain('variantId: null');
    expect(src).toContain('ربطة');
  });

  test('مسح باركود المنتج يضيفه أو يفتح نافذته (المسار الأصلي سليم)', () => {
    const src = read(POS);
    // findByBarcode ما زال مسار المسح المباشر.
    expect(read('src/database/repositories/ProductRepo.ts')).toContain(
      'findByBarcode',
    );
    expect(src).toContain('addScanned');
    void src;
  });
});

describe('v34 — الإعدادات وشاشات الإدارة بالنطاق', () => {
  test('تبديل النمط يزرع داخل النطاق ويحفظ بالنطاق', () => {
    const src = read(SETTINGS);
    expect(src).toContain('CategoryRepo.list(mode)');
    expect(src).toContain('CategoryRepo.create(name, mode)');
    expect(src).toContain('UnitRepo.create(');
    expect(src).toContain('seed.kind,');
  });

  test('شاشتا الإدارة تعملان بنطاق النمط الحالي', () => {
    expect(read(MANAGE_CATS)).toContain(
      'CategoryRepo.listWithCounts(',
    );
    expect(read(MANAGE_CATS)).toContain('settings.storeMode');
    expect(read(MANAGE_UNITS)).toContain(
      'UnitRepo.list(useSettingsStore.getState().settings.storeMode)',
    );
  });

  test('كتالوج المتجر يحمل تصنيفات النمط الحالي + وسم أحادي للقديم', () => {
    const src = read(CATALOG);
    expect(src).toContain('tagLegacyRowsOnce');
    expect(src).toContain('CategoryRepo.tagUntagged(mode)');
    expect(src).toContain('UnitRepo.tagUntagged(mode)');
    expect(src).toContain(
      'CategoryRepo.list(useSettingsStore.getState().settings.storeMode)',
    );
  });
});
