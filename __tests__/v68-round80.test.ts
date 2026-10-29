/**
 * v68 — الجولة 80: ملاحظات التاجر على نقطة البيع أندرويد
 * (نفس ملاحظات سطح المكتب v76 — التكافؤ بين المنصتين).
 * ─────────────────────────────────────────────────────────────────
 * ١. قيمة البضاعة في المخزون: بطاقة في أعلى صفحة المخزون تحسب
 *    تكلفة×كمية لكل منتج متتبع + قيمتها بالبيع وهامشها، مع عدّ
 *    منفصل للكمية المفتوحة (بلا تتبع) كي يعرف التاجر بدقة ما
 *    الذي يشمله الرقم.
 * ٢. تقرير PDF للمخزون بالتفصيل: بند في قائمة ⋮ يبني ملفاً A4
 *    على محرك Kotlin (PdfDocument + Tajawal + RTL) مجمّعاً
 *    بالتصنيفات مع مجاميع كل تصنيف وحالة ملونة وصف الإجمالي.
 * ٤أ. شعارات الجهات الرسمية تملأ إطارها: الحواف المدمجة داخل
 *    ملفات الشعارات قُصّت (نفس ملفات سطح المكتب) والحشوة 2→1.
 * ٤ب. تنظيم صفحة التقارير بتبويبات: أربع مناطق محاسبية مستقلة
 *    بدل التمرير الطويل — وفواتير الدين والقسائم الشرائية نُقلت
 *    من بطاقة النقد إلى تبويبها المستقل.
 * ٥. الإصدار: 68.0.0 (76).
 */
import {freshApp} from './helpers/app';

const read = (p: string) => require('fs').readFileSync(p, 'utf8') as string;

const INVENTORY = 'src/screens/inventory/InventoryScreen.tsx';
const REPORTS = 'src/screens/reports/ReportsScreen.tsx';
const PM_ICON = 'src/components/PaymentMethodIcon.tsx';
const BRIDGE = 'src/native/nativeBridge.ts';
const KOTLIN = 'android/app/src/main/java/com/sela/pal/native_modules/PlatformUtilsModule.kt';
const POS = 'src/screens/PosScreen.tsx';
const SETTINGS = 'src/screens/settings/SettingsScreen.tsx';
const ORDERS = 'src/screens/online/OnlineOrdersScreen.tsx';
const SILA = 'src/screens/sila/SilaScreen.tsx';
const DEBTS = 'src/screens/debts/LocalDebtsScreen.tsx';
const CONFIG = 'src/core/config.ts';

describe('v68 — ١ قيمة البضاعة في المخزون', () => {
  test('المعادلة نفسها: تكلفة×كمية للمتتبع فقط والمفتوحة تُعد منفصلة', () => {
    const src = read(INVENTORY);
    expect(src).toContain('const stockValue = useMemo(');
    expect(src).toContain('costValue += product.cost_price * qty;');
    expect(src).toContain('retailValue += finalPriceOf(product) * qty;');
    expect(src).toContain('untrackedCount += 1;');
    // السعر النهائي بعد خصم المنتج — نفس معادلة سطح المكتب.
    expect(src).toContain('function finalPriceOf(product: Product): number');
    expect(src).toContain('Math.min(95, product.discount_pct ?? 0)');
  });

  test('البطاقة في الواجهة فوق شريط التصنيفات', () => {
    const src = read(INVENTORY);
    expect(src).toContain('قيمة البضاعة (تكلفة)');
    expect(src).toContain('قيمة بيعها');
    expect(src).toContain('كمية مفتوحة بلا قيمة محسوبة');
    expect(src).toContain('styles.valueStrip');
  });
});

describe('v68 — ٢ تقرير PDF للمخزون بالتفصيل', () => {
  test('المحرك الأصلي يرسم الجدول مجمّعاً بالتصنيفات', () => {
    const kt = read(KOTLIN);
    expect(kt).toContain('fun createInventoryReportPdf(');
    expect(kt).toContain('تقرير المخزون التفصيلي');
    expect(kt).toContain('الإجمالي الكبير');
    // حالات المخزون الملونة — نفس لوحة سطح المكتب.
    expect(kt).toContain('statePaintFor');
    expect(kt).toContain('0xDC, 0x26, 0x26'); // نفد
    expect(kt).toContain('0x16, 0xA3, 0x4A'); // جيد
  });

  test('الجسر المكشوف للـJS + بناء الحمولة في الشاشة', () => {
    const bridge = read(BRIDGE);
    expect(bridge).toContain(
      'createInventoryReportPdf(',
    );
    const src = read(INVENTORY);
    expect(src).toContain('const exportInventoryPdf = useCallback(async () =>');
    expect(src).toContain("activeFilters.push(`تصنيف: ${cat.name}`)");
    expect(src).toContain('كل المنتجات النشطة');
    expect(src).toContain('sela-inventory-');
    // المجموع الكبير يُبنى من القائمة النشطة نفسها.
    expect(src).toContain('grandCost += product.cost_price * qty;');
  });

  test('بند القائمة ⋮ يفتح التقرير', () => {
    const src = read(INVENTORY);
    expect(src).toContain('تقرير PDF للمخزون');
    expect(src).toContain('كل المنتجات بالتفصيل مجمّعة بالتصنيفات');
    expect(src).toContain('void exportInventoryPdf();');
  });
});

describe('v68 — ٤أ شعارات الجهات تملأ إطارها', () => {
  test('الحشوة انخفضت 2→1', () => {
    const src = read(PM_ICON);
    expect(src).toContain('padding: 1,');
    expect(src).not.toContain('padding: 2,');
  });

  test('الأحجام كُبّرت في كل الواجهات (نفس نسب سطح المكتب)', () => {
    expect(read(POS)).toContain('<PaymentMethodIcon method={method} size={54} />');
    expect(read(POS)).toContain('<PaymentMethodIcon method={method} size={28} />');
    expect(read(POS)).toContain('<PaymentMethodIcon method={selected} size={64} />');
    expect(read(SETTINGS)).toContain('<PaymentMethodIcon method={m} size={46} />');
    expect(read(ORDERS)).toContain('<PaymentMethodIcon method={method} size={52} />');
    expect(read(SILA)).toContain('<PaymentMethodIcon method={m} size={28} />');
    expect(read(DEBTS)).toContain('<PaymentMethodIcon method={m} size={32} />');
  });
});

describe('v68 — ٤ب صفحة التقارير بتبويبات', () => {
  test('أربع تبويبات مستقلة بنفس تقسيم سطح المكتب', () => {
    const src = read(REPORTS);
    expect(src).toContain(
      "type ReportTab = 'overview' | 'cash' | 'debts' | 'products';",
    );
    expect(src).toContain("const [activeTab, setActiveTab]");
    expect(src).toContain("key: 'overview', label: 'الملخص', icon: 'chart'");
    expect(src).toContain(
      "key: 'cash', label: 'النقد والخزينة', icon: 'wallet'",
    );
    expect(src).toContain(
      "key: 'debts', label: 'الديون والقسائم', icon: 'book'",
    );
    expect(src).toContain(
      "key: 'products', label: 'المنتجات والتصدير', icon: 'list'",
    );
    expect(src).toContain('styles.repTabsRow');
    expect(src).toContain('styles.repTabOn');
  });

  test('فواتير الدين والقسائم نُقلت من بطاقة النقد إلى تبويبها', () => {
    const src = read(REPORTS);
    expect(src).toContain(
      "{activeTab === 'debts' && cash != null ? (",
    );
    expect(src).toContain('الديون والقسائم بالفترة');
    expect(src).toContain('لا فواتير دين ولا قسائم بهذه الفترة');
    // كل قسم خلف تبويبه.
    expect(src).toContain("{activeTab === 'overview' ? (");
    expect(src).toContain("{activeTab === 'cash' ? (");
    expect(src).toContain("{activeTab === 'products' ? (");
  });
});

describe('v68 — ٥ الإصدار', () => {
  test('68.0.0 (76) في config والبناء', () => {
    const config = read(CONFIG);
    expect(config).toContain("APP_VERSION = '68.0.0'");
    expect(config).toContain('APP_BUILD_CODE = 76');
    const gradle = read('android/app/build.gradle');
    expect(gradle).toContain('versionName "68.0.0"');
    expect(gradle).toContain('versionCode 76');
  });
});
