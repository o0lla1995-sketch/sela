/**
 * v37 — الجولة 45: المخزون الوهمي + تصفير التعديل + جرد الكافتيريا +
 * صفحة البقالة + نوافذ البيع/الإرجاع/الاستبدال + المسح الافتراضي +
 * التقارير + أزرار الاشتراك.
 * ─────────────────────────────────────────────────────────────────
 * ① وظيفي (على الوحدات الحقيقية):
 *    • parseNumber الجديدة: الأرقام العربية ٠٥ → 5، الفاصلة
 *      العربية 12٫5 → 12.5، الفارسية، فاصل الآلاف، والخارج
 *      القمامة → NaN (لا صفر صامت بعد اليوم).
 *    • جرد شامل: منتج بلا تتبع (كافيتريا) يدخل جلسة الجرد
 *      ويظهر في قائمتها ويُكتب عدّه عند التسوية.
 *    • ترحيل طريقة المسح: «both» القديمة (بلا لمس التاجر) →
 *      «barcode»؛ واختيار التاجر الصريح محترم حرفياً.
 * ② حرّوس المصدر لكل إصلاحات الواجهة في هذه الجولة.
 */
import {freshApp, load} from './helpers/app';

const read = (path: string) =>
  require('fs').readFileSync(path, 'utf8') as string;

const FORM = 'src/screens/inventory/ProductFormScreen.tsx';
const POS = 'src/screens/PosScreen.tsx';
const INVOICES = 'src/screens/invoices/InvoicesScreen.tsx';
const REPORTS = 'src/screens/reports/ReportsScreen.tsx';
const CONTACT = 'src/components/ContactButtons.tsx';
const SCANNER_KT =
  'android/app/src/main/java/com/sela/pal/native_modules/ScannerActivity.kt';
const STOCKTAKE = 'src/database/repositories/StocktakeRepo.ts';
const SETTINGS = 'src/stores/settingsStore.ts';
const MODES = 'src/core/storeModes.ts';
const FORMAT = 'src/core/format.ts';

describe('v37 #1أ — parseNumber: الأرقام العربية والفواصل', () => {
  test('الأرقام العربية الهندية والفارسية والفاصلة العربية تُقرأ بدقة', () => {
    freshApp();
    const {parseNumber} = load(FORMAT);
    expect(parseNumber('٠٥')).toBe(5);
    expect(parseNumber('٢٥')).toBe(25);
    expect(parseNumber('۱۲')).toBe(12); // فارسية
    expect(parseNumber('12٫5')).toBe(12.5); // فاصلة عربية عشرية
    expect(parseNumber('12٬500')).toBe(12500); // فاصل آلاف عربي
    expect(parseNumber('1,250.75')).toBe(1250.75); // فاصل آلاف إنجليزي
    expect(parseNumber('3.5')).toBe(3.5);
    expect(parseNumber('１２')).toBe(12); // fullwidth
  });

  test('الخارج القمامة NaN (لا صفر صامت) والحقل الفارغ NaN', () => {
    freshApp();
    const {parseNumber} = load(FORMAT);
    expect(parseNumber('abc')).toBeNaN();
    expect(parseNumber('')).toBeNaN();
    expect(parseNumber('--')).toBeNaN();
    // القيمة السالبة تبقى كما كانت (خصومات/تعديلات).
    expect(parseNumber('-2.5')).toBe(-2.5);
  });

  test('isParseableNumber يميز المكتوب القابل للقراءة', () => {
    freshApp();
    const {isParseableNumber} = load(FORMAT);
    expect(isParseableNumber('٢٤')).toBe(true);
    expect(isParseableNumber('12٫5')).toBe(true);
    expect(isParseableNumber('')).toBe(false);
    expect(isParseableNumber('??')).toBe(false);
  });
});

describe('v37 #1ج — جرد شامل لكل المنتجات (شكوى الكافتيريا)', () => {
  test('منتج بلا تتبع يدخل جلسة الجرد ويُعدّ وتُطبّق تسويته', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {ProductRepo} = load('src/database/repositories/ProductRepo');
    const {StocktakeRepo} = load(STOCKTAKE);

    // منتجان: متتبع (بقالة) وبلا تتبع (كافيتريا) — النمط الذي
    // كان يُقصّ كلياً من جلسة الجرد فلا يظهر في قائمتها.
    const trackedId = await ProductRepo.create({
      name: 'شوكولاتة',
      cost_price: 2,
      retail_price: 3,
      wholesale_price: 2.5,
      stock_quantity: 10,
      category_id: null,
      image_uri: null,
    });
    const untrackedId = await ProductRepo.create({
      name: 'قهوة أمريكانو',
      cost_price: 1,
      retail_price: 6,
      wholesale_price: 6,
      stock_quantity: 0,
      category_id: null,
      image_uri: null,
      stock_untracked: 1,
      base_unit_name: 'كوب',
    });
    expect(trackedId).toBeGreaterThan(0);
    expect(untrackedId).toBeGreaterThan(0);

    const session = await StocktakeRepo.start();
    expect(session.status).toBe('open');
    const items = await StocktakeRepo.listItems(session.id);
    const ids = new Set(items.map(item => item.product_id));
    // الشكوى نصاً: «منتجات تابعة لمود الكافتيريا لا تظهر في قائمة
    // الجرد» — الآن تظهر إلزامياً.
    expect(ids.has(untrackedId)).toBe(true);
    expect(ids.has(trackedId)).toBe(true);

    // عدّ الكافتيريا 7 أكواب وطبّق التسوية.
    await StocktakeRepo.setCounted(session.id, untrackedId, 7);
    await StocktakeRepo.setCounted(session.id, trackedId, 10);
    await StocktakeRepo.complete(session.id, true);
    const after = await ProductRepo.getById(untrackedId);
    expect(after?.stock_quantity).toBe(7);
    // ومنتج بلا تتبع حُفظ كميته عند تعديله العام (أدناه في حرّوس
    // المصدر) فلا تضيع تسوية الجرد بأي تعديل لاحق.
  });

  test('SQL جلسة الجرد لم يعد يقصّ stock_untracked', () => {
    const src = read(STOCKTAKE);
    const startBlock = src.slice(
      src.indexOf('async start()'),
      src.indexOf('async cancel()'),
    );
    expect(startBlock).not.toContain('stock_untracked = 0');
    expect(startBlock).toContain('WHERE p.is_archived = 0');
  });
});

describe('v37 #1أ+1ب — نموذج المنتج: الحفظ الأمين والتحقق القارئ', () => {
  test('حارس الكمية غير المقروءة يوقف الحفظ (لا نجاح وهمي)', () => {
    const src = read(FORM);
    expect(src).toContain('قيمة الكمية غير مقروءة');
    expect(src).toContain('stockTyped && Number.isNaN(stockParsed)');
  });

  test('تعديل منتج بلا تتبع يحفظ مخزونه القائم (لا تصفير)', () => {
    const src = read(FORM);
    // المسار الحرفي للشكوى: كان untrackedStock ? 0 يكتب صفراً فوق
    // الكمية عند أي تعديل عام؛ الآن يقرأ loadedStockRef.current.
    expect(src).toContain('? loadedStockRef.current');
    expect(src).not.toContain('untrackedStock\n      ? 0');
  });

  test('التحقق القارئ بعد الحفظ (read-back) موجود عبر كل المودات', () => {
    const src = read(FORM);
    expect(src).toContain('تعذر تحديث المخزون بدقة');
    expect(src).toContain('تعذر تحديث حالة تتبع المخزون');
    expect(src).toContain('const verify = await ProductRepo.getById(targetId)');
  });

  test('صفحة البقالة: بطاقة حالة بلا مبدّل + تسمية تكلفة ديناميكية', () => {
    const src = read(FORM);
    expect(src).toContain('بالقطعة — يُحدد عند إدخال البضاعة');
    expect(src).toContain('بالوزن (كغ) — من استلام البضاعة');
    // التسمية الديناميكية: وزن → للكيلو (كانت تُظهر «للقطعة» على
    // حقل بالكيلو!).
    expect(src).toContain("'سعر التكلفة للكيلو (₪) *'");
    const modes = read(MODES);
    expect((modes.match(/saleModeSelector: true/g) ?? []).length).toBe(0);
  });
});

describe('v37 #2أ+2ج — نافذة البيع الموحدة: نمط مُثبت + تذييل مثبّت', () => {
  test('التمرير الأوسط flexShrink (نمط ورقة الوزن) لا flex:1', () => {
    const src = read(POS);
    expect(src).toContain('variantScroll: {');
    expect(src).toContain('flexShrink: 1');
    // النمط الجديد مستعمل فعلاً في تمرير نافذة البيع.
    expect(src).toContain(
      '<ScrollView\n          style={styles.variantScroll}\n          contentContainerStyle={styles.variantList}',
    );
    // النمط الهش القديم (flex:1 داخل أب maxHeight-only) الذي رسم
    // الترويسة وحدها على جهاز التاجر يجب ألا يعود لتمرير النافذة:
    // تمرير النافذة صار بأسلوب variantScroll دائماً.
    expect(src).toContain("maxHeight: '78%'");
    // وزر التأكيد في تذييل مثبّت أسفل النافذة (لا داخل التمرير).
    expect(src).toContain('<View style={styles.sheetFooter}>');
  });

  test('التذييل المثبّت: المجموع + زر التأكيد + الحاشية خارج التمرير', () => {
    const src = read(POS);
    expect(src).toContain('sheetFooter: {');
    expect(src).toContain('borderTopWidth: 1');
    // زر التأكيد موجود في التذييل لكل مود (ملابس مفرق/جملة،
    // أحجام، وحدات) — لا يمكن أن يختفي أسفل الشاشة.
    expect(src).toContain(`title={\`إضافة للسلة\${\n                  activeVariant != null`);
  });
});

describe('v37 #2ج+2د — نافذة الإرجاع والاستبدال', () => {
  test('قائمة بدائل الاستبدال داخل التمرير والتذييل محدود', () => {
    const src = read(INVOICES);
    expect(src).toContain('exchangeListScrollSection');
    expect(src).toContain('أصناف الاستبدال البديلة');
    // توسيع النافذة: 72% → 82%.
    expect(src).toContain("height * 0.82");
    expect(src).not.toContain("height * 0.72");
  });

  test('الاستبدال: الوحدة الافتراضية هي الأساس (لا أول وحدة مخصصة)', () => {
    const src = read(INVOICES);
    expect(src).toContain('setChosenUnitId(preferUnitId ?? null)');
    expect(src).not.toContain(
      'setChosenUnitId(\n        preferUnitId ??\n          (units.length > 0 ? units[0].id : null),\n      );',
    );
    // رقاقة الأساس أولاً في شريط الوحدات.
    expect(src).toContain('(الأساس) —');
  });

  test('الاستبدال: متغير متوفر افتراضياً + حارس مخزون صريح', () => {
    const src = read(INVOICES);
    expect(src).toContain('const inStockVariant = variants.find(v => v.stock_quantity > 0)');
    expect(src).toContain('(inStockVariant ?? variants[0] ?? null)?.id ?? null');
    expect(src).toContain('المتوفر منه');
    expect(src).toContain('المتوفر من ${openProductRow.name}');
    // المتغير النافد معتم وممنوع.
    expect(src).toContain("{out ? ' (نافد)' :");
  });

  test('الاستبدال: حقل الكمية يقبل الأرقام العربية', () => {
    const src = read(INVOICES);
    expect(src).toContain('const qtyNum = parseNumber(qtyText)');
    expect(src).not.toContain(
      'setQtyText(t.replace(\',\', \'.\').replace(/[^\\d.]/g, \'\'))',
    );
  });
});

describe('v37 #2ب — طريقة المسح الافتراضية: باركود فقط', () => {
  test('الافتراض barcode + ترحيل أحادي يحترم اختيار التاجر', () => {
    freshApp();
    // ① محفوظ قديم «both» بلا لمس → يُرحَّل إلى barcode.
    const {storage} = freshApp();
    const KEYS = storage.KEYS;
    const {setJson} = storage;
    setJson(KEYS.settings, {
      storeName: 'متجر',
      scannerMode: 'both',
      // لا scannerModeTouched — كان مجرد افتراض قديم.
    });
    const store1 = load(SETTINGS);
    expect(store1.useSettingsStore.getState().settings.scannerMode).toBe(
      'barcode',
    );

    // ② اختيار التاجر الصريح (لمس الإعداد) → يُحترم حرفياً.
    freshApp();
    const storage2 = load('src/storage/storage');
    storage2.setJson(storage2.KEYS.settings, {
      storeName: 'متجر',
      scannerMode: 'both',
      scannerModeTouched: true,
    });
    const store2 = load(SETTINGS);
    expect(store2.useSettingsStore.getState().settings.scannerMode).toBe(
      'both',
    );
    expect(store2.useSettingsStore.getState().settings.scannerModeTouched).toBe(
      true,
    );
  });

  test('الإعداد الجديد يُختم عند التغيير اليدوي', () => {
    const src = read('src/screens/settings/SettingsScreen.tsx');
    expect(src).toContain('scannerModeTouched: true');
    const store = read(SETTINGS);
    expect(store).toContain("scannerMode: 'barcode'");
  });
});

describe('v37 #2هـ — تنبيهات شاشة المسح (Kotlin)', () => {
  test('البطاقة الجديدة: قرص أيقونة + نص 16sp + مهل أطول', () => {
    const src = read(SCANNER_KT);
    expect(src).toContain('private var resultBanner: LinearLayout? = null');
    expect(src).toContain('private var resultIconView: TextView? = null');
    expect(src).toContain('private var resultMessageView: TextView? = null');
    expect(src).toContain('textSize = 16f');
    expect(src).toContain('if (ok) 2200L else 3600L');
    expect(src).not.toContain('if (ok) 1900L else 3000L');
  });
});

describe('v37 #3أ — قسم الأكثر إيراداً وربحاً في التقارير', () => {
  test('ترويسة متمركزة + ميداليات + شريط نسبي + صفوف مضغوطة', () => {
    const src = read(REPORTS);
    expect(src).toContain('topHead: {');
    expect(src).toContain('topHeadTitle');
    expect(src).toContain('topRankGold');
    expect(src).toContain('topRankSilver');
    expect(src).toContain('topRankBronze');
    expect(src).toContain('topBarTrack');
    expect(src).toContain('topBarFill');
    // إزالة المسافات الواسعة: الفجوة md → sm.
    expect(src).toContain('gap: spacing.sm,\n      paddingVertical: 8,');
    expect(src).toContain('الأكثر إيراداً وربحاً');
  });
});

describe('v37 #3ب — أزرار التواصل أيقونات فقط', () => {
  test('قرص دائري 48px بلا نص — التسمية في accessibilityLabel', () => {
    const src = read(CONTACT);
    expect(src).toContain('width: 48');
    expect(src).toContain('borderRadius: 24');
    expect(src).toContain('accessibilityRole="link"');
    // النص اللاتفي اختفى من الزر نفسه.
    expect(src).not.toContain('styles.label');
    expect(src).not.toContain(
      '<Text style={[styles.label, {color: c.onAccent}]}',
    );
  });
});
