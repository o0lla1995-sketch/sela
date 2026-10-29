/**
 * v55 — الجولة 58: الإدراج الانتقائي للبيع أونلاين + مزامنة كل بيع.
 * ─────────────────────────────────────────────────────────────────
 * طلب التاجر بالنص: «يستطيع المستخدم تحديد فقط المنتجات الموجودة
 * لديه للبيع أونلاين علي المتجر دون باقي المنتجات حيث يتم التركيز
 * عليها فقط دون غيرها والتركيز علي تحديثها ومزامنتها مع المتجر في
 * كل عملية بيع عبر نقطة البيع او عبر المتجر».
 *
 * ① ترحيل v27: عمود products.online_listed على قاعدة قائمة.
 * ② المستودع: list({onlineListed:true}) يرجع المدرجة فقط،
 *    setOnlineListed يبدّل ويرفض المؤرشف، countOnlineListed عدّ دقيق.
 * ③ المزامنة: syncProducts ترسل المدرجة حصراً — وصور المتجر
 *    (OnlineImageSync) تفحص المدرجة فقط (لا رفع لغير المعروض).
 * ④ المزامنة بعد كل عملية بيع: notifyCatalogChanged (debounce ٥ث)
 *    من InvoiceService (بيع + إرجاع/استبدال) ومن sendOrder
 *    (طلب المتجر)، وstopEngine يلغي أي مؤقت معلّق.
 * ⑤ إصلاح الجذر: discountPct كان مفقوداً من تبعيات حفظ النموذج —
 *    سبب شكوى «الخصم لا يحفظ بالمنتج»؛ أُضيف مع online_listed.
 * ⑥ الواجهات: شاشة منتجات متجري أونلاين + تسجيلها في التنقل +
 *    بوابة الدخول من شاشة البيع أونلاين + مفتاح النموذج.
 * ⑦ الإصدار: 69.0.0 (76).
 */
import {freshApp} from './helpers/app';

const read = (p: string) => require('fs').readFileSync(p, 'utf8') as string;

describe('v55 — الإدراج الانتقائي للبيع أونلاين', () => {
  test('① ترحيل v27: عمود online_listed على قاعدة قائمة', async () => {
    const app = freshApp(':memory:');
    await app.connection.initDatabase();
    const db = app.connection.getDb();
    const res = db.execute(
      "SELECT COUNT(*) AS cnt FROM pragma_table_info('products') WHERE name = 'online_listed'",
    );
    const rows = (res.rows ?? []) as unknown as {cnt?: number}[];
    expect(Number(rows[0]?.cnt ?? 0)).toBe(1);
    // القيمة الافتراضية 0 — لا يدرج شيء قائم قبل أن يختار التاجر.
    const sample = db.execute(
      'SELECT COALESCE(online_listed, -1) AS v FROM products LIMIT 1',
    );
    const sampleRows = (sample.rows ?? []) as unknown as {v?: number}[];
    if (sampleRows.length > 0) {
      expect(Number(sampleRows[0].v)).toBe(0);
    }
  });

  test('② المستودع: المدرجة فقط + تبديل يرفض المؤرشف + العدّ', async () => {
    const app = freshApp(':memory:');
    await app.connection.initDatabase();
    const ProductRepo = require('../src/database/repositories/ProductRepo')
      .ProductRepo as {
      create: (i: Record<string, unknown>) => Promise<number>;
      update: (id: number, i: Record<string, unknown>) => Promise<void>;
      getById: (id: number) => Promise<{
        online_listed: number;
        is_archived: number;
      } | null>;
      list: (o?: {onlineListed?: boolean}) => Promise<
        {id: number; name: string}[]
      >;
      setOnlineListed: (id: number, listed: boolean) => Promise<boolean>;
      countOnlineListed: () => Promise<number>;
    };

    const listed = await ProductRepo.create({
      name: 'معروض أونلاين',
      cost_price: 4,
      retail_price: 8,
      wholesale_price: 7,
      stock_quantity: 50,
      category_id: null,
      image_uri: null,
      online_listed: 1,
    });
    const hidden = await ProductRepo.create({
      name: 'محلي فقط',
      cost_price: 2,
      retail_price: 5,
      wholesale_price: 4,
      stock_quantity: 30,
      category_id: null,
      image_uri: null,
      online_listed: 0,
    });

    // الإنشاء يحفظ العلم كما أُرسل.
    let row = await ProductRepo.getById(listed);
    expect(row?.online_listed).toBe(1);
    row = await ProductRepo.getById(hidden);
    expect(row?.online_listed).toBe(0);

    // list المفلترة: المدرجة فقط.
    const only = await ProductRepo.list({onlineListed: true});
    expect(only.map(p => p.name)).toEqual(['معروض أونلاين']);

    // التبديل السريع: إدراج → إلغاء → إدراج.
    expect(await ProductRepo.setOnlineListed(hidden, true)).toBe(true);
    row = await ProductRepo.getById(hidden);
    expect(row?.online_listed).toBe(1);
    expect(await ProductRepo.setOnlineListed(hidden, false)).toBe(true);
    row = await ProductRepo.getById(hidden);
    expect(row?.online_listed).toBe(0);

    // العدّ: يطابق المدرجات النشطات.
    expect(await ProductRepo.countOnlineListed()).toBe(1);

    // التبديل يرفض المؤرشف (المؤرشف لا معنى لإدراجه).
    const db = app.connection.getDb();
    db.execute('UPDATE products SET is_archived = 1 WHERE id = ?', [listed]);
    expect(await ProductRepo.setOnlineListed(listed, false)).toBe(false);
    row = await ProductRepo.getById(listed);
    expect(row?.is_archived).toBe(1);
    expect(row?.online_listed).toBe(1);
    // العدّ يستثني المؤرشف.
    expect(await ProductRepo.countOnlineListed()).toBe(0);

    // update الكامل يحمل العلم أيضاً (لا يفقد الإدراج عند التعديل).
    await ProductRepo.update(listed, {
      name: 'معروض أونلاين',
      cost_price: 4,
      retail_price: 9,
      wholesale_price: 7,
      stock_quantity: 50,
      category_id: null,
      image_uri: null,
      online_listed: 1,
    });
    row = await ProductRepo.getById(listed);
    expect(row?.online_listed).toBe(1);
  });

  test('③ مزامنة الكتالوج والصور: المدرجة حصراً', () => {
    const service = read('src/services/online/OnlineStoreService.ts');
    expect(service).toContain('onlineListed: true');
    expect(service).toMatch(/ProductRepo\.list\(\{\s*archival: 'active',\s*onlineListed: true,\s*\}\)/);
    // الصور: المنتجات المدرجة فقط — لا رفع لغير المعروض.
    const images = read('src/services/online/OnlineImageSync.ts');
    expect(images).toContain(
      'WHERE is_archived = 0 AND online_listed = 1',
    );
  });

  test('④ المزامنة بعد كل عملية بيع: ثلاث نقاط تُنادي notifyCatalogChanged', () => {
    const service = read('src/services/online/OnlineStoreService.ts');
    // الدالة موجودة وبتوقيت debounce.
    expect(service).toContain('export function notifyCatalogChanged');
    expect(service).toContain('CATALOG_SYNC_DEBOUNCE_MS = 5000');
    expect(service).toContain('function cancelPendingCatalogSync');
    // إيقاف المحرك يلغي أي مزامنة مؤجلة معلّقة.
    expect(service).toMatch(/state\.started = false;\s*cancelPendingCatalogSync\(\);/);
    // نقطة ١: فاتورة طلب المتجر (sendOrder).
    expect(service).toMatch(
      /دين أونلاين مؤقت حتى تأكيد التسليم`,\s*\);\s*\/\/ v55[\s\S]{0,200}notifyCatalogChanged\(\);/,
    );
    // نقاط ٢+٣: بيع POS والإرجاع/الاستبدال في InvoiceService.
    const inv = read('src/services/InvoiceService.ts');
    const hits = inv.match(/notifyCatalogChanged\(\);/g) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(2);
    // بيع: قبل return النتيجة داخل completeSale.
    expect(inv).toMatch(
      /options\.onPrintError\?\.\(message\);\s*\}\s*\}\s*\/\/ v55[\s\S]{0,600}notifyCatalogChanged\(\);/,
    );
    // إرجاع: داخل createReturn.
    expect(inv).toMatch(
      /input\.onPrintError\?\.\(message\);\s*\}\s*\}\s*\/\/ v55[\s\S]{0,600}notifyCatalogChanged\(\);/,
    );
  });

  test('⑤ جذر «الخصم لا يحفظ»: discountPct كان غائباً عن التبعيات', () => {
    const form = read('src/screens/inventory/ProductFormScreen.tsx');
    // المفتاحان معاً في تبعيات الحفظين (save + saveLot) — العدد ٢.
    const pairs = form.match(/discountPct,\n    onlineListed,/g) ?? [];
    expect(pairs.length).toBe(2);
    // المدخل يُحفظ في المسارين.
    const inputs = form.match(/online_listed: onlineListed \? 1 : 0,/g) ?? [];
    expect(inputs.length).toBe(2);
    // تحميل القيمة القائمة عند فتح المنتج للتعديل.
    expect(form).toContain('setOnlineListed(product.online_listed === 1)');
    /* v56 (الجولة 59): المفتاح حُذف من نموذج المنتج بطلب التاجر —
     * القيمة تُمرّر كما هي (لا فقدان إدراج عند تعديل أي حقل)،
     * والتفعيل أصبح من قسم «منتجات النقطة» في شاشة الطلبات أونلاين. */
    expect(form).not.toContain('label="عرض في متجر سيلا"');
    expect(form).toContain('منتجات النقطة');
  });

  test('⑥ الواجهات: شاشة المنتجات المدرجة + التنقل + البوابة', () => {
    expect(() => read('src/screens/online/OnlineProductsScreen.tsx')).not.toThrow();
    const screen = read('src/screens/online/OnlineProductsScreen.tsx');
    expect(screen).toContain('منتجات متجري أونلاين');
    expect(screen).toContain('إدراج منتجات في المتجر');
    expect(screen).toContain('setOnlineListed(product.id, false)');
    // التسجيل في التنقل + قائمة الأنواع.
    const nav = read('src/navigation/RootNavigator.tsx');
    expect(nav).toContain(
      "name=\"OnlineProducts\" component={OnlineProductsScreen}",
    );
    expect(nav).toContain('OnlineProducts: undefined;');
    // بوابة الدخول من شاشة إعدادات البيع أونلاين.
    const selling = read('src/screens/online/OnlineSellingScreen.tsx');
    expect(selling).toContain(
      "navigation.navigate('OnlineProducts' as never)",
    );
    expect(selling).toContain('إدارة المعروض في المتجر');
    // مفتاح النموذج يعمل حتى مع تعطيل البيع (يُحفظ وينتظر التفعيل).
    expect(selling).toContain('productsEntry');
    /* v56 (الجولة 59): قسم «منتجات النقطة» في صفحة الطلبات أونلاين —
     * طلب التاجر بالنص: قسم خاص + مفتاح تفعيل بجانب كل منتج. */
    const ordersScreen = read('src/screens/online/OnlineOrdersScreen.tsx');
    expect(ordersScreen).toContain('منتجات النقطة');
    expect(ordersScreen).toContain('toggleOnlineListing');
    expect(ordersScreen).toContain('ProductRepo.setOnlineListed');
    expect(ordersScreen).toContain('notifyCatalogChanged');
    expect(ordersScreen).toContain('معروض في متجر سيلا:');
  });

  test('⑦ الإصدار: 69.0.0 (76) في config والبناء', () => {
    const config = read('src/core/config.ts');
    expect(config).toContain("APP_VERSION = '69.0.0'");
    expect(config).toContain('APP_BUILD_CODE = 77');
    const gradle = read('android/app/build.gradle');
    expect(gradle).toContain('versionCode 77');
    expect(gradle).toContain('versionName "69.0.0"');
  });
});
