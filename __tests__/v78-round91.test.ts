/**
 * v78 — الجولة 91: ملاحظات التاجر الأربع + ميزة التجار.
 * ─────────────────────────────────────────────────────────────────
 *  ١. «ترتيب المتغيرات الخاصة بوحدات المنتج من أحجام بترتيب تنازلي
 *     حيث تظهر متغيرات الصنف بالترتيب علي حسب السعر من الاقل في
 *     الأعلي الي الأكبر» — الأحجام والوحدات تُرتَّب تصاعدياً بالسعر
 *     في نافذة البيع ونموذج المنتج ولوحة الوزن.
 *  ٢. «إضافة وتطوير ميزة جديدة بتسجيل الفواتير والمستحقات الخاصة
 *     بالتجار وصفحة لكل تاجر خاصة به وبالتقارير» — دفتر ذمم دائنة
 *     كامل: جدولان + مستودع + شاشة كشف حساب + تكامل خزينة + تقارير
 *     + نسخ احتياطي.
 *  ٣. «جعل إدخال رقم الهوية غير اجباري في دفتر الديون عند إضافة او
 *     تعديل زبون» — الفارغ مسموح ويُخزن NULL؛ 9 أرقام إن أُدخل.
 *  ٤. «يجب الا يتم ارسال إشعارات نفاذ المخزون للمنتجات التي بدون
 *     تتبع» — الاستبعاد (منذ v35) + تنظيف الإشعارات التاريخية
 *     العالقة لمن صار بلا تتبع.
 */
import {describe, expect, test} from '@jest/globals';
import {readFileSync} from 'node:fs';

const read = (p: string) => readFileSync(p, 'utf8') as string;

const POS = 'src/screens/PosScreen.tsx';
const FORM = 'src/screens/inventory/ProductFormScreen.tsx';
const DEBTS_SCREEN = 'src/screens/debts/LocalDebtsScreen.tsx';
const DEBTS_REPO = 'src/database/repositories/LocalDebtsRepo.ts';
const CONNECTION = 'src/database/connection.ts';
const MERCHANT_REPO = 'src/database/repositories/MerchantRepo.ts';
const MERCHANT_SCREEN = 'src/screens/merchants/MerchantsScreen.tsx';
const NAVIGATOR = 'src/navigation/RootNavigator.tsx';
const HOME = 'src/screens/HomeScreen.tsx';
const REPORTS = 'src/screens/reports/ReportsScreen.tsx';
const BACKUP = 'src/services/BackupService.ts';
const CASH_SERVICE = 'src/services/CashService.ts';
const ALERTS = 'src/services/StockAlertsService.ts';
const NOTIF_STORE = 'src/stores/notificationsStore.ts';
const CONFIG = 'src/core/config.ts';
const GRADLE = 'android/app/build.gradle';

describe('v78 — ١ ترتيب الأحجام والوحدات تصاعدياً بالسعر', () => {
  test('نافذة البيع: الأحجام تُفرز بالسعر الفعلي (الأقل أولاً)', () => {
    const src = read(POS);
    expect(src).toContain("const sizeVariants = [...(product.variants ?? [])]");
    const idx = src.indexOf("const sizeVariants = [...(product.variants ?? [])]");
    const block = src.slice(idx, idx + 700);
    expect(block).toContain(".sort(");
    expect(block).toContain("(a.retail_price ?? product.retail_price)");
  });

  test('نافذة البيع: وحدات الصيدلية تُفرز بسعر unitPriceFor', () => {
    const src = read(POS);
    // الموضعان: شبكة الوحدات ولوحة الوزن — كلاهما .sort قبل .map.
    const matches = src.match(
      /\.sort\(\s*\(a, b\) =>\s*unitPriceFor\(product, a, pricingMode\) -\s*unitPriceFor\(product, b, pricingMode\)/g,
    );
    expect(matches != null && matches.length >= 2).toBe(true);
  });

  test('نموذج المنتج: صفوف الوحدات والأحجام تُحمّل مرتبة بالسعر', () => {
    const src = read(FORM);
    expect(src).toContain('productUnits\n                .slice()');
    expect(src).toContain('a.retail_price ??\n                      product.retail_price * a.conversion');
    expect(src).toContain('sizeVariants\n                    .slice()');
  });
});

describe('v78 — ٢ ميزة حسابات التجار (ذمم دائنة)', () => {
  test('المخطط: جدولا merchants وmerchant_movements بالفهارس', () => {
    const src = read(CONNECTION);
    expect(src).toContain('CREATE TABLE IF NOT EXISTS merchants');
    expect(src).toContain('CREATE TABLE IF NOT EXISTS merchant_movements');
    expect(src).toContain(
      "kind TEXT NOT NULL CHECK (kind IN ('invoice','payment','return','collection','debt'))",
    );
    expect(src).toContain('idx_merchant_moves');
    // المسح الكامل يشمل الجدولين.
    expect(src).toMatch(
      /DELETE FROM sqlite_sequence[^\n]*'merchants','merchant_movements'/,
    );
  });

  test('المستودع: المعادلة (توريد − سداد − مرتجع − تحصيل) والمراجع', () => {
    const src = read(MERCHANT_REPO);
    expect(src).toContain('invoiceTotal +');
    expect(src).toContain('debtTotal -');
    expect(src).toContain('paymentTotal -');
    expect(src).toContain("invoice: 'توريد'");
    expect(src).toContain("payment: 'سداد'");
    expect(src).toContain("return: 'مرتجع'");
    expect(src).toContain("collection: 'تحصيل'");
    // الحذف ممنوع لمن له حركات — أثر مالي لا يُمح.
    expect(src).toContain('لا يمكن حذف التاجر');
    // كشف الحساب بالرصيد الجاري.
    expect(src).toContain('runningBalance');
    // الإجماليات للتقارير.
    expect(src).toContain('owedNow');
    expect(src).toContain('topOwed');
  });

  test('الشاشة: كشف حساب لكل تاجر + فاتورة توريد + سداد عبر القنوات', () => {
    const src = read(MERCHANT_SCREEN);
    expect(src).toContain('التجار والموردون');
    expect(src).toContain('كشف الحساب');
    expect(src).toContain('فاتورة توريد');
    expect(src).toContain('سداد له');
    expect(src).toContain('مرتجع / خصم');
    expect(src).toContain('تحصيل منه');
    // السداد/التحصيل عبر قنوات الدفع الفعلية بسند خزينة.
    expect(src).toContain('CashService.recordExpense');
    expect(src).toContain('CashService.recordDeposit');
    expect(src).toContain('سداد لتاجر');
    expect(src).toContain('تحصيل من تاجر');
    expect(src).toContain('activePaymentMethods');
  });

  test('التنقل والوصول: شاشة مسجلة + زر في الرئيسية + قسم في التقارير', () => {
    expect(read(NAVIGATOR)).toContain(
      "import {MerchantsScreen} from '../screens/merchants/MerchantsScreen';",
    );
    expect(read(NAVIGATOR)).toContain(
      '<Stack.Screen name="Merchants" component={MerchantsScreen} />',
    );
    const home = read(HOME);
    expect(home).toContain(
      "{key: 'merchants', label: 'التجار', icon: 'store', target: 'Merchants'}",
    );
    const reports = read(REPORTS);
    expect(reports).toContain('حسابات التجار');
    expect(reports).toContain('مستحق للتجار الآن');
    expect(reports).toContain('MerchantRepo.totals');
  });

  test('الخزينة: فئة «سداد لتاجر» + فئة إيداع اختيارية', () => {
    const cash = read(CASH_SERVICE);
    expect(cash).toContain("'سداد لتاجر',");
    expect(cash).toContain('category?: string | null;');
    expect(cash).toContain("input.category?.trim() || 'إيداع نقدي'");
  });

  test('النسخ الاحتياطي: الجدولان يُصدَّران ويُستعادان بإعادة ربط المعرّفات', () => {
    const src = read(BACKUP);
    expect(src).toContain('merchants?: {');
    expect(src).toContain('merchant_movements?: {');
    expect(src).toContain('FROM merchants`');
    expect(src).toContain('FROM merchant_movements`');
    expect(src).toContain('const merchantMap = new Map<number, number>();');
    expect(src).toContain(
      "DELETE FROM sqlite_sequence WHERE name IN ('local_customers','local_debts','local_payments','merchants','merchant_movements')",
    );
  });
});

describe('v78 — ٣ رقم الهوية اختياري في دفتر الديون', () => {
  test('المستودع: isValidOptionalIdNumber + NULL للفارغ + إنشاء بالمعرف', () => {
    const src = read(DEBTS_REPO);
    expect(src).toContain('export function isValidOptionalIdNumber');
    expect(src).toContain(
      "idNumber.length > 0 && !ID_NUMBER_RE.test(idNumber)",
    );
    expect(src).toContain(
      'idNumber.length > 0 ? idNumber : null',
    );
    expect(src).toContain('await this.byId(');
    // تفرد الهوية والتحقق من صِلة لمن أدخل هوية فقط.
    expect(src).toContain('if (idNumber.length > 0) {');
  });

  test('الشاشة: التحقق يقبل الفارغ والتسمية «اختياري»', () => {
    const src = read(DEBTS_SCREEN);
    expect(src).toContain(
      "addId.trim().length > 0 && !isValidIdNumber(addId.trim())",
    );
    expect(src).toContain(
      "editId.trim().length > 0 && !isValidIdNumber(editId.trim())",
    );
    expect(src).toContain('رقم الهوية (اختياري — 9 أرقام)');
    expect(src).toContain('بلا رقم هوية');
    // التفرد عند التعديل لمن أدخل هوية فقط.
    expect(src).toContain('editId.trim().length > 0 &&');
  });
});

describe('v78 — ٤ لا إشعارات نفاد للمنتجات بلا تتبع', () => {
  test('الاستبعاد (v35) ما زال محروساً في المسارين', () => {
    const src = read(ALERTS);
    expect(src).toContain(
      'if (product.stock_untracked === 1) {\n          continue;\n        }',
    );
    expect(src).toContain('activeAlerts');
  });

  test('تنظيف الإشعارات التاريخية العالقة لمن صار بلا تتبع', () => {
    const store = read(NOTIF_STORE);
    expect(store).toContain('dropStockAlertsFor');
    expect(store).toContain("item.kind === 'out_of_stock' || item.kind === 'low_stock'");
    const alerts = read(ALERTS);
    expect(alerts).toContain('notificationsStore.dropStockAlertsFor(untrackedIds)');
    expect(alerts).toContain('const untrackedIds = new Set<number>();');
  });
});

describe('v78 — الإصدار', () => {
  test('config.ts وbuild.gradle عند 80.0.0 / 90', () => {
    const config = read(CONFIG);
    expect(config).toContain("APP_VERSION = '81.0.0'");
    expect(config).toContain('APP_BUILD_CODE = 91');
    const gradle = read(GRADLE);
    expect(gradle).toContain('versionName "81.0.0"');
    expect(gradle).toContain('versionCode 91');
  });
});

describe('v78.1 — كاشير #١: طرق الدفع من نقطة البيع الأندرويد', () => {
  test('نقطة النهاية /api/payment-methods بنفس شكل سطح المكتب', () => {
    const src = read('src/services/lan/LanHandlers.ts');
    expect(src).toContain("path === '/api/payment-methods'");
    expect(src).toContain(
      'activePaymentMethods(\n        getSettings().paymentMethodsEnabled,\n      )',
    );
  });

  test('كاشير #٣: شفاء المتغير بالتسمية والزبون بالاسم عند المزامنة', () => {
    const src = read('src/services/lan/LanHandlers.ts');
    expect(src).toContain('شفاء المتغير بالتسمية');
    expect(src).toContain('line.variantLabel != null');
    expect(src).toContain('شفاء الزبون بالاسم');
    expect(src).toContain('body.customerName != null');
  });
});

describe('v78.2 — كاشير #٣ تكملة: شفاء الوحدات والاستبدال', () => {
  test('شفاء الوحدة بالاسم في مسار البيع قبل الرفض', () => {
    const src = read('src/services/lan/LanHandlers.ts');
    expect(src).toContain('شفاء الوحدة بالاسم');
    // المطابقة بالاسم أو الاختصار (علبة/علب) ثم الرفض إن بقي ميتاً.
    expect(src).toContain('u.name === wantedUnit || u.short === wantedUnit');
    expect(src).toContain('وحدة غير متاحة لـ «${product.name}»');
  });

  test('شفاء بدائل الاستبدال بالتسمية والاسم (نفس قواعد البيع)', () => {
    const src = read('src/services/lan/LanHandlers.ts');
    expect(src).toContain('شفاء بدائل الاستبدال بالتسمية/الاسم');
    expect(src).toContain('wantedEx');
    expect(src).toContain('wantedUnitEx');
    // المعرفات قابلة للشفاء (let) في المسارين.
    expect(src).toContain('// v78.2: let — قد يُشفى المعرفان بالتسمية/الاسم أدناه.');
    expect(src).toContain('// v78.2: let — قد يُشفى المعرفان (المتغير بالتسمية والوحدة');
  });
});
