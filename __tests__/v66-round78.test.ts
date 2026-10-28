/**
 * v66 — الجولة 78: ملاحظات التاجر على نقطة البيع أندرويد.
 * ─────────────────────────────────────────────────────────────────
 * ١. نافذة الدفع: خطوة اختيار الطريقة تفتح دائماً عند البيع (كانت
 *    تُتخطى مع النقدي وحده فيظن التاجر أن نافذة الطرق معطوبة)،
 *    والبنوك والمحافظ المعطّلة تظهر داخل النافذة نفسها كرقائق
 *    تفعيل فوري بشعاراتها الرسمية — نقرة واحدة تفعّل.
 * ٢. الجذر الحقيقي لضياع طريقة الدفع من كل الواجهات: rowToSale
 *    كانت تُسقط عمود payment_method رغم وجوده في SELECT والنوع —
 *    فكانت كل فاتورة تظهر «نقدي» في القائمة والتفصيل وPDF
 *    وإعادة الطباعة. الآن يمر كما خُزّن.
 * ٣. الفواتير مميزة بطريقة الدفع: شارة بشعار الجهة الرسمي على كل
 *    صف + في تفصيل الفاتورة + على الإيصال المطبوع (أول طباعة
 *    وإعادة طباعة معاً) + فلترة كاملة بطريقة الدفع في صفحة
 *    الفواتير (تدخل تقرير PDF بنفس الفلتر).
 * ٤. الإعدادات: فخ التبديل أزيل — بطاقة الجهة كانت تُبدّل حالتها
 *    بنقرة على كامل مساحتها فنقر التاجر محافظه ظاناً أنه يختارها
 *    فعطّلها. الآن مفتاح Switch حقيقي بيد التاجر لكل جهة.
 * ٥. الإصدار: 67.0.0 (75).
 */
import {freshApp} from './helpers/app';

const read = (p: string) => require('fs').readFileSync(p, 'utf8') as string;

const POS = 'src/screens/PosScreen.tsx';
const INVOICES = 'src/screens/invoices/InvoicesScreen.tsx';
const SETTINGS = 'src/screens/settings/SettingsScreen.tsx';
const SALE_REPO = 'src/database/repositories/SaleRepo.ts';
const RECEIPT = 'src/services/printer/receipt.ts';
const CONFIG = 'src/core/config.ts';

describe('v66 — ١ نافذة الدفع: خطوة الطريقة دائماً + تفعيل فوري', () => {
  test('openPaySheet يفتح خطوة الطريقة دائماً (بلا شرط العدد)', () => {
    const src = read(POS);
    expect(src).toContain("setPaySheet('method')");
    // الشرط القديم الذي كان يتخطى النافذة عند النقدي وحده أزيل.
    expect(src).not.toContain("setPaySheet(methods.length > 1 ? 'method' : 'pay')");
  });

  test('رقائق التفعيل الفوري داخل نافذة الدفع بشعارات الجهات', () => {
    const src = read(POS);
    expect(src).toContain('disabledMethods');
    expect(src).toContain('onEnableMethod');
    expect(src).toContain('payQuickEnableChip');
    expect(src).toContain('طرق دفع أخرى — فعّل ما تستخدمه بنقرة');
    // التفعيل يكتب في مخزن الإعدادات فتتحدث الشبكة تفاعلياً.
    expect(src).toContain('paymentMethodsEnabled: {');
  });

  test('زر الرجوع في خطوة الدفع يعود لخطوة الطريقة دائماً', () => {
    const src = read(POS);
    expect(src).not.toContain(
      "title={step === 'pay' && methods.length > 1 ? 'رجوع' : 'إلغاء'}",
    );
  });
});

describe('v66 — ٢ rowToSale يمرر طريقة الدفع (الجذر)', () => {
  test('السجل يقرأ عمود payment_method كما خُزّن', () => {
    const src = read(SALE_REPO);
    expect(src).toContain('payment_method:');
    expect(src).toContain('String(row.payment_method)');
  });

  test('سلوكياً: بيع عبر جوال باي ثم قراءته بكل المسارات', async () => {
    const app = freshApp(':memory:');
    await app.connection.initDatabase();
    const {ProductRepo} = require('../src/database/repositories/ProductRepo');
    const {SaleRepo} = require('../src/database/repositories/SaleRepo');
    const {useCartStore} = require('../src/stores/cartStore');

    const id = await ProductRepo.create({
      name: 'عصير',
      cost_price: 2,
      retail_price: 6,
      wholesale_price: 5,
      stock_quantity: 40,
      category_id: null,
      image_uri: null,
    } as never);
    const product = await ProductRepo.getById(id);
    const store = useCartStore.getState();
    store.addProduct(product as never, 'RETAIL', null, 2);
    const line = useCartStore.getState().lines[0];

    await SaleRepo.createSale({
      invoiceNumber: 'T-66-JP',
      lines: [line],
      discount: 0,
      paymentType: 'RETAIL',
      paymentMethod: 'jawwal_pay',
    } as never);

    // getById (تفصيل الفاتورة وإعادة الطباعة).
    const byId = await SaleRepo.getById(1);
    expect(byId?.payment_method).toBe('jawwal_pay');

    // listRecent (إعادة الطباعة بالقائمة).
    const recent = await SaleRepo.listRecent(10);
    expect(recent[0].payment_method).toBe('jawwal_pay');

    // listPagePaged (صفحة الفواتير + تقرير PDF).
    const page = await SaleRepo.listPagePaged({limit: 10, offset: 0});
    expect(page[0].payment_method).toBe('jawwal_pay');
  });
});

describe('v66 — ٣ الفواتير مميزة بطريقة الدفع + فلترة كاملة', () => {
  test('فلتر طريقة الدفع في الاستعلام: النقدي يشمل السجلات القديمة', () => {
    const src = read(SALE_REPO);
    expect(src).toContain("options.method != null && options.method !== 'all'");
    expect(src).toContain(
      "(s.payment_method IS NULL OR s.payment_method = '' OR s.payment_method = 'cash')",
    );
    expect(src).toContain("conditions.push('s.payment_method = ?')");
  });

  test('سلوكياً: الفلترة بمحفظة تعيد فواتيرها وحدها', async () => {
    const app = freshApp(':memory:');
    await app.connection.initDatabase();
    const {ProductRepo} = require('../src/database/repositories/ProductRepo');
    const {SaleRepo} = require('../src/database/repositories/SaleRepo');
    const {useCartStore} = require('../src/stores/cartStore');

    const id = await ProductRepo.create({
      name: 'شوكولا',
      cost_price: 1,
      retail_price: 4,
      wholesale_price: 3,
      stock_quantity: 50,
      category_id: null,
      image_uri: null,
    } as never);
    const product = await ProductRepo.getById(id);

    for (const [ref, method] of [
      ['T-66-A', 'jawwal_pay'],
      ['T-66-B', 'palpay'],
      ['T-66-C', 'cash'],
    ] as const) {
      const store = useCartStore.getState();
      store.addProduct(product as never, 'RETAIL', null, 1);
      const line = useCartStore.getState().lines[0];
      await SaleRepo.createSale({
        invoiceNumber: ref,
        lines: [line],
        discount: 0,
        paymentType: 'RETAIL',
        paymentMethod: method,
      } as never);
      useCartStore.getState().clear();
    }

    const onlyJawwal = await SaleRepo.listPagePaged({
      limit: 10,
      offset: 0,
      method: 'jawwal_pay',
    });
    expect(onlyJawwal).toHaveLength(1);
    expect(onlyJawwal[0].invoice_number).toBe('T-66-A');

    // النقدي يلتقط السجل النقدي الصريح.
    const onlyCash = await SaleRepo.listPagePaged({
      limit: 10,
      offset: 0,
      method: 'cash',
    });
    expect(onlyCash).toHaveLength(1);
    expect(onlyCash[0].invoice_number).toBe('T-66-C');

    // الكل بلا فلتر.
    const all = await SaleRepo.listPagePaged({limit: 10, offset: 0});
    expect(all).toHaveLength(3);
  });

  test('شارة طريقة الدفع بشعار الجهة على الصفوف والتفصيل والفلترة', () => {
    const src = read(INVOICES);
    // رقائق الفلترة بالشعارات الرسمية.
    expect(src).toContain('MethodFilterChip');
    expect(src).toContain('methodFilter');
    expect(src).toContain("label=\"كل الطرق\"");
    // الشارة على صف الفاتورة (شعار + اسم بلون العلامة).
    expect(src).toContain('styles.methodChip');
    // شارة في رأس تفصيل الفاتورة.
    expect(src).toContain('detailHeadBadges');
    // الفلتر يدخل تقرير PDF بنفس القيمة.
    expect(src).toContain('method: stateRef.current.methodFilter');
    expect(src).toContain('طريقة الدفع: ${paymentMethodById(');
  });

  test('الإيصال يطبع طريقة الدفع (أول طباعة وإعادة الطباعة)', () => {
    const src = read(RECEIPT);
    expect(src).toContain('paymentMethodLabel');
    expect(src).toContain('طريقة الدفع: ${paymentMethodLabel(');
  });
});

describe('v66 — ٤ الإعدادات: مفتاح Switch حقيقي (إزالة فخ التبديل)', () => {
  test('البطاقة معلوماتية والتبديل من المفتاح وحده', () => {
    const src = read(SETTINGS);
    expect(src).toContain('<Switch');
    expect(src).toContain('trackColor={{false: c.surfaceHi, true: m.color}}');
    // فخ النقر على كامل البطاقة أزيل.
    expect(src).not.toContain('[m.id]: !enabled');
    expect(src).toContain('pmHint');
  });
});

describe('v66 — ٥ الإصدار', () => {
  test('67.0.0 (75)', () => {
    const src = read(CONFIG);
    expect(src).toContain("APP_VERSION = '67.0.0'");
    expect(src).toContain('APP_BUILD_CODE = 75');
  });
});
