/**
 * v80-round93.test.ts — الجولة 93 (نقطة البيع أندرويد): حرّوس إصلاحات
 * التاجر الثلاثة ضد الانحدار:
 *
 *  ① لا ازدواج في أرصدة القنوات — أرقام «النقد» (الرئيسية والتقارير)
 *     نقية من مبيعات ومقبوضات البنوك والمحافظ، وللقنوات صفوفها
 *     المعلوماتية الخاصة (شكوى التاجر: «يتم اضافة الرصيد بشكل مزدوج
 *     في النقدي والبنك»).
 *  ② كشوف التجار PDF قابل للطباعة — أُلغي تصدير Excel/CSV كلياً
 *     («اريده تقرير pdf قابل للطباعة وليس تقرير اكسل او csv لغيهما»).
 *  ③ نافذة التاجر أُعيد تنظيمها — لا أزرار متراكمة (فاتورة بحجم
 *     كامل + شبكة ٢×٢ للمال + إدارة هامشية).
 *  ④ عمليات التجار في التقارير — بطاقة مختصرة في تبويب الملخص +
 *     تقرير الفترة الشامل PDF (محرك أقسام أصلي جديد).
 *  ⑤ قناة تسوية المرتجع تتخلف عن القناة الأصلية للفاتورة.
 *  ⑥ مسامير الإصدار 80.0.0 / 90.
 */
import {readFileSync} from 'fs';
import {join} from 'path';

const R = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

describe('v80 (الجولة 93) — النقد بلا ازدواج مع القنوات', () => {
  test('ReportService: نطاق القنوات غير النقدية يُستعلم بفترة التقرير', () => {
    const repo = R('src/database/repositories/ReportRepo.ts');
    expect(repo).toContain('async nonCashInRange(');
    const service = R('src/services/ReportService.ts');
    expect(service).toContain('ReportRepo.nonCashInRange(range)');
    // المبيعات النقدية بالفترة تُخصم منها مبيعات القنوات.
    expect(service).toContain('nonCashRange.salesNetMinor / 100;');
  });

  test('CashRepo: إجماليات مفصولة نقدي/قنوات (لا خصم مزدوج من الدرج)', () => {
    const repo = R('src/database/repositories/CashRepo.ts');
    expect(repo).toContain('async totalsForSplit(');
    // المجموعة على القناة — مصروف محفظة لا يمسّ الدرج النقدي.
    expect(repo).toContain("GROUP BY COALESCE(payment_method, 'cash'), kind");
    const service = R('src/services/ReportService.ts');
    expect(service).toContain('CashRepo.totalsForSplit(range.from, range.to)');
    expect(service).toContain('cashMovementsSplit.cash.expensesMinor / 100');
  });

  test('الرئيسية: مبيعات نقدية نقية + صفوف القنوات المستقلة', () => {
    const home = R('src/screens/HomeScreen.tsx');
    expect(home).toContain('nonCashSalesAllTime ?? 0');
    expect(home).toContain('مبيعات عبر البنوك والمحافظ');
    expect(home).toContain('سدادّات استُلمت عبر البنوك والمحافظ');
    // معادلة cashTotal تبقى بميزان واحد (الاستثناءات تُطرح مرة).
    const service = R('src/services/ReportService.ts');
    expect(service).toContain('nonCashExclusions.salesNetMinor / 100');
    expect(service).toContain('nonCashExclusions.repaymentsMinor / 100');
  });

  test('التقارير: البطل نقدي صافٍ + سطر معلوماتي للقنوات', () => {
    const reports = R('src/screens/reports/ReportsScreen.tsx');
    expect(reports).toContain('النقد المحصّل بالدرج بالفترة');
    expect(reports).toContain('صافي حركة الدرج النقدي بالفترة');
    expect(reports).toContain('عبر البنوك والمحافظ (أرصدتها في بطاقة القنوات)');
  });
});

describe('v80 (الجولة 93) — كشوف التجار PDF قابل للطباعة', () => {
  test('MerchantsPdfService موجود بنفس محرك تقارير الديون', () => {
    const service = R('src/services/MerchantsPdfService.ts');
    expect(service).toContain('exportStatementPdf');
    expect(service).toContain('exportBookPdf');
    expect(service).toContain('printStatementPdf');
    expect(service).toContain('printBookPdf');
    expect(service).toContain('createDebtsReportPdf');
  });

  test('تصدير Excel/CSV لكشوف التجار أُلغي كلياً', () => {
    const exportService = R('src/services/ExportService.ts');
    expect(exportService).not.toContain('exportMerchantStatement');
    expect(exportService).not.toContain('exportMerchantsBook');
    const screen = R('src/screens/merchants/MerchantsScreen.tsx');
    expect(screen).not.toContain('ExportService.exportMerchantStatement');
    expect(screen).not.toContain("ملف Excel");
    expect(screen).not.toContain("ملف CSV");
    // والبديل موصول فعلاً — v81: زر «كشف PDF» في صف الفاتورة
    // وحوار التنزيل يصف الوثيقة بأنها قابلة للطباعة.
    expect(screen).toContain('MerchantsPdfService.exportStatementPdf');
    expect(screen).toContain('MerchantsPdfService.exportBookPdf');
    expect(screen).toContain('title="كشف PDF"');
    expect(screen).toContain('PDF قابل للطباعة');
  });
});

describe('v80 (الجولة 93) — نافذة التاجر المحسّنة', () => {
  test('الأزرار الهرمية: فاتورة بحجم كامل + شبكة ٢×٢ + إدارة هامشية', () => {
    const screen = R('src/screens/merchants/MerchantsScreen.tsx');
    expect(screen).toContain('فاتورة توريد جديدة');
    expect(screen).toContain('styles.actionsGrid');
    expect(screen).toContain("style={{flexBasis: '48%', flexGrow: 1}}");
    // v81 (الجولة 94 #٣): صف الإدارة انتقل للهيدر أيقونات، والكشف
    // صار في صف الفاتورة نفسه — لا صفوف أزرار متساوية متراكبة.
    expect(screen).toContain('styles.primaryRow');
    expect(screen).not.toContain('styles.adminRow');
    // لا صفوف أزرار متساوية متراكبة بعد الآن.
    expect(screen).not.toContain('title="تنزيل الكشف"');
  });
});

describe('v80 (الجولة 93) — عمليات التجار في التقارير + تقرير PDF شامل', () => {
  test('بطاقة ملخص التجار في تبويب الملخص', () => {
    const reports = R('src/screens/reports/ReportsScreen.tsx');
    expect(reports).toContain('عمليات التجار — ملخص مختصر');
    expect(reports).toContain('أكبر المستحقات:');
  });

  test('PeriodReportPdfService + المحرك الأصلي createPeriodReportPdf', () => {
    const service = R('src/services/PeriodReportPdfService.ts');
    expect(service).toContain('exportPeriodPdf');
    expect(service).toContain('printPeriodPdf');
    expect(service).toContain('عمليات التجار — ملخص مختصر');
    // قسم التجار داخل أقسام التقرير الشامل.
    expect(service).toContain('topOwed');
    const bridge = R('src/native/nativeBridge.ts');
    expect(bridge).toContain('createPeriodReportPdf(');
    const kotlin = R(
      'android/app/src/main/java/com/sela/pal/native_modules/PlatformUtilsModule.kt',
    );
    expect(kotlin).toContain('fun createPeriodReportPdf(');
    expect(kotlin).toContain('val sections = optArray(json, "sections")');
  });

  test('زر التقرير الشامل موصول في صفحة التقارير', () => {
    const reports = R('src/screens/reports/ReportsScreen.tsx');
    expect(reports).toContain('إنشاء تقرير PDF شامل للفترة');
    expect(reports).toContain('openPeriodPdf');
  });
});

describe('v80 (الجولة 93) — قناة تسوية المرتجع الأصلية', () => {
  test('نافذة الإرجاع تتخلف عن قناة الفاتورة الأصلية', () => {
    const invoices = R('src/screens/invoices/InvoicesScreen.tsx');
    expect(invoices).toContain("setRefundChannel(prep.sale.payment_method)");
    expect(invoices).toContain("prep.book === 'cash'");
  });
});

describe('v80 — الإصدار', () => {
  test('config.ts وbuild.gradle عند الإصدار الجاري (محدّث لـ v81)', () => {
    const config = R('src/core/config.ts');
    expect(config).toContain("APP_VERSION = '81.0.0'");
    expect(config).toContain('APP_BUILD_CODE = 91');
    const gradle = R('android/app/build.gradle');
    expect(gradle).toContain('versionName "81.0.0"');
    expect(gradle).toContain('versionCode 91');
  });
});
