/**
 * v41 — الجولة 49: ستة إصلاحات جذرية.
 * ─────────────────────────────────────────────────────────────────
 * ① زر شكل المنتجات في نقطة البيع لم يعد أيقونة معتمة مدفونة في
 *    الزاوية اليسرى — زر معنون «الشكل» بخلفية برتقالية هادئة.
 * ② رمز الباركود: (أ) معاينة صورة الفاتورة ترسم CODE128-B حقيقياً
 *    (جدول المعيار الكامل 107 أنماط + خانة تحقق) بدل النمط الزخرفي
 *    ذي الفرغات الواسعة؛ (ب) الطباعة الحرارية ترسل GS w بعرض وحدة
 *    محسوباً يتسع داخل الورق + محرف اختيار مجموعة الرموز «{B»
 *    لمعيار Epson في CODE128.
 * ③ تبديل الوحدات في سلة الاستبدال أصبح لحظياً — أنماط مخزّنة
 *    (لا ٤٦ استدعاء StyleSheet.create لكل ضغطة) وصفوف نتائج مذكّرة
 *    (React.memo) بدالة فتح مستقرة.
 * ④ جذر «الماسح لا يفتح نافذة البيع للمنتجات ذات الخصائص»:
 *    findByBarcode يعيد صف المنتج بلا مصفوفة variants فكان فحص
 *    الخصائص يسقط دائماً — الآن تُحمّل المتغيرات وتُلصق قبل القرار.
 * ⑤ كشف المصروفات PDF: الملاحظة لم تعد تتداخل مع المبلغ — قص بعرض
 *    مقاس لكل خلية والملاحظة تُلف على سطرين داخل صندوق لا يتجاوز
 *    حافة المبلغ المقيسة (استحالة هندسية للتداخل).
 * ⑥ عدّاد حي للمدة المتبقية في الإعدادات (أيام + ساعات:دقائق:ثوانٍ
 *    كل ثانية + نقطة نبض) وحذف ملاحظة نقطة بداية الاشتراك.
 */
import {freshApp, load} from './helpers/app';

const read = (path: string) =>
  require('fs').readFileSync(path, 'utf8') as string;

describe('v41 — حرّوس المصدر: الستة إصلاحات', () => {
  test('① زر الشكل معنون ومرئي بجانب جملة/مفرق', () => {
    const pos = read('src/screens/PosScreen.tsx');
    // النص المعروض على الزر نفسه + نمط نصه.
    expect(pos).toContain('الشكل');
    expect(pos).toContain('styles.viewShapeBtnText');
    // خلفية برتقالية هادئة بدل سطح معتم.
    expect(pos).toContain('backgroundColor: c.accentSoft');
    // الزر يعرض نصاً بعد الأيقونة (لم يعد أيقونة صامتة فقط).
    expect(pos).toMatch(/<Icon[^/]*\/>\s*<Text\s+style=\{\[/);
  });

  test('② أ — معاينة الفاتورة ترسم CODE128 حقيقياً (لا نمط زخرفي)', () => {
    const native = read(
      'android/app/src/main/java/com/sela/native_modules/PlatformUtilsModule.kt',
    );
    // جدول المعيار الكامل (107 أنماط — من 212222 حتى 2331112).
    expect(native).toContain('CODE128_PATTERNS');
    expect(native).toContain('"2331112"');
    expect(native).toContain('"211214"');
    // المرمّز: START B + بيانات + خانة تحقق + STOP.
    expect(native).toContain('code128BModules');
    expect(native).toContain('appendPattern(104)');
    expect(native).toContain('checksum % 103');
    expect(native).toContain('appendPattern(106)');
    // النمط الزخرفي القديم (فرغات واسعة) زال.
    expect(native).not.toContain('i % 4');
  });

  test('② ب — الطباعة الحرارية: GS w + «{B» لمعيار Epson', () => {
    const thermal = read(
      'android/app/src/main/java/com/sela/native_modules/ThermalPrinterModule.kt',
    );
    // GS w (0x1D 0x77) يُرسل قبل GS h.
    expect(thermal).toContain('0x1D, 0x77');
    // محرف اختيار مجموعة الرموز B + مضاعفة الأقواس الحرفية.
    expect(thermal).toContain('"{B" + ascii.replace("{", "{{")');
    // المفتاح القادم من JS.
    expect(thermal).toContain('command.getInt("width").coerceIn(1, 6)');
  });

  test('② ج — كل بناة الإيصالات يحسبون عرض الوحدة قبل الطباعة', () => {
    const escpos = read('src/services/printer/escpos.ts');
    expect(escpos).toContain('code128Modules(payloadLength: number)');
    expect(escpos).toContain('barcodeModuleWidthFor(');
    for (const file of [
      'src/services/printer/receipt.ts',
      'src/services/printer/debtReceipt.ts',
      'src/services/printer/returnReceipt.ts',
      'src/services/printer/voucherReceipt.ts',
      'src/services/printer/label.ts',
    ]) {
      const src = read(file);
      expect(src).toContain('barcodeModuleWidthFor');
    }
  });

  test('③ — تبديل وحدات الاستبدال لحظي: ذاكرة أنماط + صفوف مذكّرة', () => {
    const invoices = read('src/screens/invoices/InvoicesScreen.tsx');
    // ذاكرة الأنماط على مستوى الوحدة.
    expect(invoices).toContain('exchangeStylesCache');
    expect(invoices).toContain('function exchangeStyles(');
    // صف منتج مذكّر بدالة فتح مستقرة عبر latest-ref.
    expect(invoices).toContain('const ExchangeProductRow = React.memo');
    expect(invoices).toContain('openProductStable');
    expect(invoices).toContain('openProductRef.current = openProduct');
    // الاستدعاءات المباشرة excStyles(c). داخل JSX زالت.
    expect(invoices).not.toContain('excStyles(c).');
  });

  test('④ — الماسح يفتح نافذة البيع: تعبئة المتغيرات قبل القرار', () => {
    const pos = read('src/screens/PosScreen.tsx');
    // الاستيراد.
    expect(pos).toContain(
      "import {VariantRepo} from '../database/repositories/VariantRepo';",
    );
    // التعبئة داخل handleBarcode قبل فحص الخصائص.
    expect(pos).toContain('found.has_variants === 1');
    expect(pos).toContain('await VariantRepo.listByProduct(found.id)');
  });

  test('⑤ — كشف المصروفات: قص مقاس وتلفيف الملاحظة بعيداً عن المبلغ', () => {
    const native = read(
      'android/app/src/main/java/com/sela/native_modules/PlatformUtilsModule.kt',
    );
    // قص بعرض مقاس (وليس بعدد محارف).
    expect(native).toContain('fun ellipsizeTo(');
    expect(native).toContain('measureText');
    // الملاحظة تُلف داخل StaticLayout بحد أقصى سطران ولا تلمس المبلغ.
    expect(native).toContain('StaticLayout');
    expect(native).toContain('noteLeftLimit');
    expect(native).toContain('lineCount > 2');
    // القص القديم بعدد المحارف زال.
    expect(native).not.toContain('note.take(24)');
    expect(native).not.toContain('category.take(14)');
  });

  test('⑥ — عدّاد حي وحذف ملاحظة نقطة البداية', () => {
    const sub = read('src/screens/settings/SubscriptionSection.tsx');
    // دقات كل ثانية + مكونات الزمن الحية.
    expect(sub).toContain('setInterval(() => setNow(Date.now()), 1000)');
    expect(sub).toContain('remainingHours');
    expect(sub).toContain('remainingSeconds');
    expect(sub).toContain('pad2');
    // نقطة النبض.
    expect(sub).toContain('Animated.loop');
    expect(sub).toContain('liveDot');
    // ملاحظة نقطة بداية الاشتراك حُذفت نهائياً.
    expect(sub).not.toContain('serverAnchorNote');
    expect(sub.includes('نقطة بداية الاشتراك محفوظة على الخادم')).toBe(false);
    // خلية بداية الخطة زالت من الشبكة.
    expect(sub).not.toContain('بداية الخطة');
  });
});

describe('v41 — وظيفي: عرض وحدة الباركود يحترم عرض الورق', () => {
  test('CODE128 لرقم فاتورة 17 محرفاً: وحدة واحدة على 58مم واثنتان على 80مم', () => {
    const {ReceiptBuilder} = load('src/services/printer/escpos');
    const b = ReceiptBuilder.create();
    // 17 محرفاً = 222 وحدة (START 11 + 17×11 + CHECK 11 + STOP 13).
    expect(b.code128Modules(17)).toBe(11 * 17 + 35);
    // 58مم (384 نقطة، 352 قابلة للاستخدام) → وحدة واحدة.
    expect(b.barcodeModuleWidthFor(b.code128Modules(17), 384)).toBe(1);
    // 80مم (576 نقطة) → وحدتان.
    expect(b.barcodeModuleWidthFor(b.code128Modules(17), 576)).toBe(2);
    // EAN13 (95 وحدة): 58مم → 3 (سقف المنطق).
    expect(b.barcodeModuleWidthFor(95, 384)).toBe(3);
    // الحمولة تمر كما هي إلى العملية (GS w من JS إلى الأصلي).
    const ops = ReceiptBuilder.create()
      .barcode('CODE128', 'INV-20261009-0001', 60, 1)
      .build();
    const barcodeOp = ops.find(op => op.op === 'barcode') as {
      op: string;
      system?: string;
      value?: string;
      height?: number;
      width?: number;
    };
    expect(barcodeOp).toBeDefined();
    expect(barcodeOp.system).toBe('CODE128');
    expect(barcodeOp.value).toBe('INV-20261009-0001');
    expect(barcodeOp.height).toBe(60);
    expect(barcodeOp.width).toBe(1);
  });
});

describe('v41 — وظيفي: الماسح يفتح نافذة البيع لمنتج متغيرات (تعبئة variants)', () => {
  test('منتج ملابس بباركود عام: التعبئة تجعل فحص الخصائص يعمل', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {VariantRepo} = load('src/database/repositories/VariantRepo');
    const {ProductRepo} = load('src/database/repositories/ProductRepo');

    // منتج بمتغيرات (مسار نموذج المنتج).
    const productId = await ProductRepo.create({
      name: 'قميص رياضي',
      cost_price: 20,
      retail_price: 45,
      wholesale_price: 38,
      stock_quantity: 10,
      category_id: null,
      image_uri: null,
      barcode: 'CLOTH-001',
      has_variants: 1,
      stock_untracked: 0,
    });
    await VariantRepo.replaceForProduct(productId, [
      {
        kind: 'variant',
        color: 'أزرق',
        size: 'L',
        stock_quantity: 5,
        retail_price: 45,
      },
      {
        kind: 'variant',
        color: 'أزرق',
        size: 'XL',
        stock_quantity: 3,
        retail_price: 47,
      },
    ]);

    // findByBarcode (ما يستدعيه الماسح) لا يعيد المتغيرات — هذا هو
    // الجذر الذي أصلحته الجولة 49 في handleBarcode.
    const bare = await ProductRepo.findByBarcode('CLOTH-001');
    expect(bare).not.toBeNull();
    expect(bare.has_variants).toBe(1);
    expect(bare.variants ?? []).toHaveLength(0);

    // التعبئة التي يقوم بها الماسح الآن تعيد صفوف المتغيرات الحية.
    const variants = await VariantRepo.listByProduct(bare.id);
    expect(variants.length).toBe(2);
    // فحص الخصائص الذي كان يسقط قبل الإصلاح يعمل بعده.
    expect(variants.some(v => v.kind === 'variant' || v.kind === 'size')).toBe(
      true,
    );
  });
});
