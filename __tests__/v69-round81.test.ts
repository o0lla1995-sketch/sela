/**
 * v69 — الجولة 81: ملاحظات التاجر على نقطة البيع أندرويد.
 * ─────────────────────────────────────────────────────────────────
 * ١. تبويبات التقارير أيقونات فقط دون نص بجانبها — بطلب التاجر
 *    نصاً «قم بجعل التبويبات بايقونات دون نص بجانبه في صفحة
 *    التقارير»؛ اسم التبويب النشط يبقى سطراً صغيراً تحت الشريط.
 * ٢. قيمة البضاعة: حُذفت بطاقتها من صفحة المخزون وانتقلت إلى
 *    صفحة التقارير بتبويب منفرد — قيمة حية بالتكلفة والبيع
 *    والهامش تتحدث بعد كل بيع وإرجاع «لان ما يهم التاجر ان يعرف
 *    قيمة البضاعة الحالية للمنتجات في المخزون بعد كل العمليات».
 * ٣. الاستبدال والإرجاع: التاجر يخيّر الكاشير في التعامل مع
 *    الرصيد «ليس فقط من خلال الخزينة بل من خلال المحافظ والبنوك
 *    أيضاً» — قناة تسوية (خزينة/محفظة/بنك) للإرجاع المالي
 *    النقدي ولفرق الاستبدال بالاتجاهين، تُخزن في
 *    sale_returns.refund_channel وعلى صف RET في
 *    sales.payment_method فتتغذى أرصدة القنوات في التقارير.
 * ٤. منع تكرار اسم المنتج والباركود عند إدخال منتج جديد —
 *    حارس في ProductRepo (إنشاء وتعديل) يفحص الاسم غير الحساس
 *    للحالة والباركود في المنتجات النشطة وباركودات وحداتها.
 * ٥. الإصدار: 71.0.0 (79).
 */
import {freshApp} from './helpers/app';

const read = (p: string) => require('fs').readFileSync(p, 'utf8') as string;

const REPORTS = 'src/screens/reports/ReportsScreen.tsx';
const INVENTORY = 'src/screens/inventory/InventoryScreen.tsx';
const INVOICES = 'src/screens/invoices/InvoicesScreen.tsx';
const INVOICE_SERVICE = 'src/services/InvoiceService.ts';
const SALE_REPO = 'src/database/repositories/SaleRepo.ts';
const PRODUCT_REPO = 'src/database/repositories/ProductRepo.ts';
const UNIT_REPO = 'src/database/repositories/UnitRepo.ts';
const CONNECTION = 'src/database/connection.ts';
const RETURN_RECEIPT = 'src/services/printer/returnReceipt.ts';
const LAN = 'src/services/lan/LanHandlers.ts';
const ONLINE_STORE = 'src/services/online/OnlineStoreService.ts';
const CONFIG = 'src/core/config.ts';
const GRADLE = 'android/app/build.gradle';
const TYPES = 'src/core/types.ts';
const BACKUP = 'src/services/BackupService.ts';

describe('v69 — ١ تبويبات التقارير أيقونات فقط', () => {
  test('بلا نص بجانب الأيقونة + اسم النشط تحت الشريط', () => {
    const src = read(REPORTS);
    // التبويب أيقونة واحدة يتوسطها الرمز — بلا نص جانبي.
    expect(src).not.toContain('styles.repTabText');
    expect(src).toContain('accessibilityRole="tab"');
    expect(src).toContain('accessibilityLabel={tab.label}');
    // اسم التبويب النشط وشرحه سطر صغير تحت الشريط.
    expect(src).toContain('styles.repTabHint');
    expect(src).toContain('{activeTabMeta?.label} — {activeTabMeta?.hint}');
  });
});

describe('v69 — ٢ قيمة البضاعة بتبويب منفرد في التقارير', () => {
  test('البطاقة حُذفت من صفحة المخزون وبقيت معادلتها لتقرير PDF', () => {
    const src = read(INVENTORY);
    expect(src).not.toContain('styles.valueStrip');
    expect(src).not.toContain('styles.valueHero');
    expect(src).toContain('const stockValue = useMemo(');
  });

  test('تبويب مستقل بقيمة حية تُحدَّث بعد كل بيع وإرجاع', () => {
    const src = read(REPORTS);
    expect(src).toContain("key: 'stockValue'");
    expect(src).toContain('قيمة البضاعة');
    // الكتالوج يُعاد تحميله عند دخول الشاشة فتبقى القيمة حية.
    expect(src).toContain('void refreshCatalog();');
    expect(src).toContain('تتحدث تلقائياً بعد كل عملية بيع وإرجاع');
    // نفس معادلة المخزون: تكلفة×كمية للمتتبع، والمفتوحة تُعد منفصلة.
    expect(src).toContain('costValue += lineCost;');
    expect(src).toContain('untrackedCount += 1;');
    expect(src).toContain('function finalPriceOf(product: Product): number');
    // تفصيل بالتصنيفات بترتيب الأغلى تكلفةً.
    expect(src).toContain('.sort((a, b) => b.cost - a.cost)');
    expect(src).toContain('styles.svCatRow');
  });
});

describe('v69 — ٣ قناة التسوية (محافظ وبنوك) في الإرجاع والاستبدال', () => {
  test('الترحيل v32: عمود refund_channel في sale_returns', () => {
    const src = read(CONNECTION);
    expect(src).toContain("if (version < 32) {");
    expect(src).toContain(
      'ALTER TABLE sale_returns ADD COLUMN refund_channel TEXT',
    );
    // جدول جديد يحمل العمود من أول إنشاء.
    expect(src).toContain('refund_channel TEXT');
    expect(src).toContain('ترحيل v32');
  });

  test('النوع والسجل يحملان القناة — والصف RET يوجه أرصدة القنوات', () => {
    expect(read(TYPES)).toContain('refund_channel: string | null;');
    const repo = read(SALE_REPO);
    expect(repo).toContain('refundChannel?: string | null;');
    // القناة على صف RET في sales.payment_method — محرك الأرصدة
    // القائم يقرأها بلا أي تغيير استعلام.
    expect(repo).toContain(
      '(invoice_number, total_amount, total_cost, total_profit, discount, payment_type, created_at, return_kind, cashier_id, payment_method)',
    );
    expect(repo).toContain("refundChannel ?? 'cash',");
    // والإيصال نفسه يحملها في sale_returns.refund_channel.
    expect(repo).toContain(
      'return_number, sale_id, invoice_ref, book, refund_method, refund_minor, debt_adjusted_minor, is_exchange, exchange_minor, note, created_at, cashier_id, refund_channel',
    );
  });

  test('الخدمة تمرر القناة والواجهة تخيّر التاجر', () => {
    expect(read(INVOICE_SERVICE)).toContain(
      'refundChannel?: string | null;',
    );
    const src = read(INVOICES);
    // الحالة والاختيار.
    expect(src).toContain(
      "const [refundChannel, setRefundChannel] = useState<string>('cash');",
    );
    // رقائق القنوات: الخزينة + المحافظ/البنوك المفعلة فقط.
    expect(src).toContain('activePaymentMethods(');
    expect(src).toContain('settings.paymentMethodsEnabled,');
    expect(src).toContain("method.id === 'cash' ? 'الخزينة' : method.label");
    // تظهر للإرجاع المالي النقدي ولفرق الاستبدال بالاتجاهين.
    expect(src).toContain('Math.abs(exchangeDiff) > 0.0001');
    // وترسل للخدمة للكتاب النقدي فقط.
    expect(src).toContain("refundChannel:");
    expect(src).toContain("book === 'cash' &&");
    // ورسالة النجاح تسمّي القناة وتشرح ما نُفّذ.
    expect(src).toContain('paymentMethodLabel(refundChannel)');
    expect(src).toContain('حوّل للزبون الفرق');
    expect(src).toContain('استلم الفرق');
  });

  test('الإيصال المطبوع يسمّي القناة + سطرها في تفاصيل الفاتورة', () => {
    const receipt = read(RETURN_RECEIPT);
    expect(receipt).toContain("viaChannel: 'Via',");
    expect(receipt).toContain('paymentMethodLabel(data.ret.refund_channel)');
    const invoices = read(INVOICES);
    expect(invoices).toContain(
      "` · عبر ${paymentMethodLabel(ret.refund_channel)}`",
    );
  });

  test('مسار الكاشير LAN يمرر القناة اختيارياً (توافق خلفي)', () => {
    expect(read(LAN)).toContain(
      "typeof body.refundChannel === 'string'",
    );
  });

  test('النسخة الاحتياطية تحمل القناة وتستعيدها', () => {
    const backup = read(BACKUP);
    expect(backup).toContain('sr.refund_channel,');
    expect(backup).toContain('ret.refund_channel ?? null,');
  });
});

describe('v69 — ٤ منع تكرار اسم المنتج والباركود', () => {
  test('الحارس في الإنشاء والتعديل — نشطين فقط، والاسم غير حساس للحالة', () => {
    const src = read(PRODUCT_REPO);
    expect(src).toContain('async function assertNameBarcodeAvailable(');
    expect(src).toContain('WHERE LOWER(TRIM(name)) = LOWER(?)');
    expect(src).toContain('يوجد منتج بنفس الاسم');
    expect(src).toContain('لا يمكن تكرار الباركود');
    // الإنشاء والتعديل كلاهما يحرسان (التعديل يستثني المنتج نفسه).
    expect(src).toContain(
      'await assertNameBarcodeAvailable(name, input.barcode, undefined, {',
    );
    expect(src).toContain(
      'await assertNameBarcodeAvailable(name, input.barcode, id, {',
    );
    // المؤرشف لا يمنع إعادة الإضافة (الحي يفوز عند المسح — قاعدة v23).
    expect(src).toContain('AND is_archived = 0 AND id != ?');
    // ثغرة النظام (سطر التوصيل) تتجاوز فحص الاسم صراحة.
    expect(src).toContain('allowDuplicateName?: boolean;');
  });

  test('باركودات الوحدات لا تتكرر عبر المنتجات', () => {
    const src = read(UNIT_REPO);
    expect(src).toContain('لا باركود وحدة مكرراً');
    expect(src).toContain('باركود الوحدة ${code} مستخدم');
  });

  test('منتج التوصيل النظامي يتجاوز فحص الاسم', () => {
    expect(read(ONLINE_STORE)).toContain('allowDuplicateName: true,');
  });
});

describe('v69 — ٥ الإصدار', () => {
  test('71.0.0 (79) في config والبناء', () => {
    const config = read(CONFIG);
    expect(config).toContain("APP_VERSION = '71.0.0'");
    expect(config).toContain('APP_BUILD_CODE = 79');
    const gradle = read(GRADLE);
    expect(gradle).toContain('versionCode 79');
    expect(gradle).toContain('versionName "71.0.0"');
  });
});

/* حارس تكاملي: قاعدة بيانات نظيفة تُهيَّأ بالترحيل الأخير v32. */
describe('v69 — تكامل الترحيل', () => {
  beforeEach(() => {
    globalThis.__SELA_DB_PATH = ':memory:';
  });

  test('قاعدة جديدة تصل v32 بلا أخطاء', async () => {
    const app = freshApp();
    await expect(app.connection.initDatabase()).resolves.toBeUndefined();
    expect(app.storage.getNumber(app.storage.KEYS.schemaVersion, 0)).toBe(32);
    // العمود الجديد موجود على تثبيت نظيف.
    const db = app.connection.getDb();
    const ret = db.execute(
      "SELECT COUNT(*) AS cnt FROM pragma_table_info('sale_returns') WHERE name = 'refund_channel'",
    );
    expect(Number((ret.rows as any[])[0].cnt)).toBe(1);
  });
});
