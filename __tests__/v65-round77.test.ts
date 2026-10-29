/**
 * v65 — الجولة 77: ملاحظات التاجر على نقطة البيع أندرويد.
 * ─────────────────────────────────────────────────────────────────
 * ١. نافذة اختيار طريقة الدفع: زر «متابعة بـ …» كان لا-op (يثبّت
 *    الخطوة على method بدل التقدم) — الآن يختار الطريقة المعلمة
 *    ويتقدم لخطوة المبلغ. وعندما لا تظهر البنوك والمحافظ يظهر
 *    تلميح صريح يقود التاجر لمكان تفعيلها (الإعدادات ← البيع).
 * ٢. الرئيسية: شريط مضغوط بأرصدة البنوك والمحافظ المفعّلة داخل
 *    بطاقة الخزينة (شعار الجهة الرسمي + الرصيد الصافي)، وملاحظة
 *    «اربط صِلة» حُذفت بطلب التاجر لتوفير المساحة.
 * ٣. نموذج المنتج (الملابس): شبكة القطع لكل (لون × مقاس) عند
 *    الإنشاء — الربطة تملأ البداية، تعديل يدوي حر، وزر «إعادة
 *    الملء من الربطة» (نفس سطح المكتب v70).
 * ٤. نموذج المنتج: ملصقات الباركود PDF — 40/50/60مم، صفحات مربعة
 *    أو A4، السعر ظاهر/مخفي، حتى 500 ملصق، رسوم Kotlin أصلي
 *    (PdfDocument + Tajawal) ثم مشاركة/طباعة نظامية.
 * ٥. الشعارات الرسمية الحقيقية للبنوك والمحافظ (أيقونات Google
 *    Play الرسمية) بدل الرسوم التقريبية — في الدفع والإعدادات
 *    والرئيسية.
 * ٦. الإصدار: 69.0.0 (76).
 */
import {load} from './helpers/app';

const read = (p: string) => require('fs').readFileSync(p, 'utf8') as string;

const POS = 'src/screens/PosScreen.tsx';
const HOME = 'src/screens/HomeScreen.tsx';
const FORM = 'src/screens/inventory/ProductFormScreen.tsx';
const ICON = 'src/components/PaymentMethodIcon.tsx';
const KOTLIN = 'android/app/src/main/java/com/sela/pal/native_modules/PlatformUtilsModule.kt';
const BRIDGE = 'src/native/nativeBridge.ts';
const PDF_SERVICE = 'src/services/BarcodeLabelsPdfService.ts';

describe('v65 — ١ نافذة الدفع: زر المتابعة يختار ويتقدم + تلميح التعطيل', () => {
  test('زر «متابعة بـ …» في خطوة الطريقة يستدعي onSelectMethod (لا onStepMethod)', () => {
    const src = read(POS);
    // الزر كان no-op: onStepMethod.call(null) يثبّت الخطوة على
    // method نفسها. الآن يختار الطريقة المعلمة فيتقدم فعلاً.
    expect(src).toContain('onPress={() => onSelectMethod(selectedId)}');
    expect(src).not.toContain('onStepMethod.call(null)');
  });

  test('تلميح «طرق الدفع الأخرى معطّلة» يظهر عند النقدي وحده', () => {
    const src = read(POS);
    expect(src).toContain('payMethodsOffHint');
    expect(src).toContain('طرق الدفع الأخرى (بنوك ومحافظ) معطّلة');
  });
});

describe('v65 — ٢ الرئيسية: شريط أرصدة القنوات + حذف ملاحظة صِلة', () => {
  test('شريط أرصدة البنوك والمحافظ المفعّلة داخل بطاقة الخزينة', () => {
    const src = read(HOME);
    expect(src).toContain('methodBalances');
    expect(src).toContain('ReportService.methodBalanceNow');
    expect(src).toContain('activePaymentMethods');
    expect(src).toContain('channelChip');
    // النقدي مستثنى من الشريط — له خانة «النقد بالخزينة».
    expect(src).toContain("filter(m => m.id !== 'cash')");
  });

  test('ملاحظة «اربط صِلة لمزامنة الديون سحابياً» حُذفت مع أنماطها', () => {
    const src = read(HOME);
    expect(src).not.toContain('silaLinkRow');
    expect(src).not.toContain('اربط صِلة لمزامنة الديون');
    // شريط الانتظار وطابع التحديث يبقيان عند الاقتران.
    expect(src).toContain('silaPendingRow');
  });
});

describe('v65 — ٣ الملابس: شبكة القطع (لون × مقاس) + إعادة الملء', () => {
  test('مسودات الشبكة والملء التلقائي وزر إعادة الملء والإجمالي الفعلي', () => {
    const src = read(FORM);
    expect(src).toContain('lotDrafts');
    expect(src).toContain('lotManuallyEdited');
    expect(src).toContain('setLotCellStock');
    expect(src).toContain('refillLotFromBundles');
    expect(src).toContain('lotPieces');
    expect(src).toContain('lotGridInput');
  });

  test('الحفظ يتبع قيم الشبكة (مجموع المتغيرات) لا حاصل الضرب وحده', () => {
    const src = read(FORM);
    expect(src).toContain('variantInputs.reduce(');
    expect(src).toContain(
      'lotDrafts.find(d => d.color === color && d.size === size)',
    );
  });
});

describe('v65 — ٤ ملصقات الباركود PDF من الهاتف', () => {
  test('الرسم الأصلي في Kotlin: createBarcodeLabelsPdf بشبكة ملصقات وإطار قص', () => {
    const kt = read(KOTLIN);
    expect(kt).toContain('fun createBarcodeLabelsPdf');
    expect(kt).toContain('DashPathEffect');
    expect(kt).toContain('bits');
  });

  test('الجسر والخدمة: نمط الوحدات يُحسب في JS (EAN-13/CODE128)', () => {
    expect(read(BRIDGE)).toContain('createBarcodeLabelsPdf');
    const svc = read(PDF_SERVICE);
    expect(svc).toContain('encodeBarcodeBars');
    expect(svc).toContain('labelMm');
    expect(svc).toContain('pageKind');
    expect(svc).toContain('showPrice');
  });

  test('الواجهة: خيارات المقاس والصفحة والسعر وزر الملف', () => {
    const src = read(FORM);
    expect(src).toContain('pdfLabelMm');
    expect(src).toContain('pdfPageKind');
    expect(src).toContain('pdfShowPrice');
    expect(src).toContain('exportBarcodeLabelsPdf');
    // النسخ حتى 500 (الحرارية تُقيّد نفسها بـ 20 داخلياً).
    expect(src).toContain('Math.min(500, v + 1)');
  });
});

describe('v65 — ٥ الشعارات الرسمية الحقيقية', () => {
  test('PaymentMethodIcon يعرض صور PNG الرسمية داخل رقاقة بيضاء', () => {
    const src = read(ICON);
    expect(src).toContain("from '../assets/pm-logos/bank_palestine.png'");
    expect(src).toContain("from '../assets/pm-logos/jawwal_pay.png'");
    expect(src).toContain("from '../assets/pm-logos/palpay.png'");
    expect(src).toContain("from '../assets/pm-logos/malchat.png'");
    expect(src).toContain("REAL_LOGOS");
    expect(src).toContain('logoChip');
  });
});

describe('v65 — ٦ الإصدار', () => {
  test('الإصدار: 69.0.0 (76) في config والبناء', () => {
    const config = read('src/core/config.ts');
    expect(config).toContain("APP_VERSION = '69.0.0'");
    expect(config).toContain('APP_BUILD_CODE = 77');
    const gradle = read('android/app/build.gradle');
    expect(gradle).toContain('versionCode 77');
    expect(gradle).toContain('versionName "69.0.0"');
  });
});
