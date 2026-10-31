/**
 * v70 — الجولة 82: ملاحظات التاجر على تطبيق نقطة البيع أندرويد.
 * ─────────────────────────────────────────────────────────────────
 * ١. دين مباشر على حساب الزبون بلا بيع — طلب التاجر نصاً: «لماذا
 *    لا يوجد إضافة دين مباشر إلى حساب الزبون بدون بيع؟». نافذة
 *    «دين مباشر» في ملف الزبون (مبلغ + بيان حر اختياري + معاينة
 *    الرصيد بعد التسجيل) تسير بنفس سلسلة INV-L والمسار المحاسبي
 *    (LocalDebtsRepo.addDebt) بلا فاتورة ولا حركة مخزون، والبيان
 *    يظهر في سجل الحساب وفي كشف الـ PDF.
 * ٢. تقارير الديون PDF — طلب التاجر: «زر في صفحة الدين لتحميل
 *    تقرير pdf احترافي بالديون والتقرير المفصل الخاص بالديون»:
 *    تقرير الدفتر كاملاً (كل الحسابات + بطاقات ملخص + صف إجمالي)
 *    وكشف حساب مفصل لكل زبون (ديون وسدادّات بترتيب زمني مع رصيد
 *    جاري) — محرّك أصلي واحد createDebtsReportPdf (A4 RTL Tajawal)
 *    + DebtsPdfService + مشاركة/طباعة A4 بعد الإنشاء.
 * ٣. زر «ربط وترحيل إلى صِلة» يظهر فقط عند تفعيل ربط صِلة — طلب
 *    التاجر: «لماذا الزر ظاهر ما لم يتم تفعيل تطبيق صلة وربطه؟».
 *    البوابة silaPaired من silaStore؛ بلا ربط لا طابور ولا مفتاح.
 * ٤. المنتج السريع يقبل وحدات إضافية بسعر مميّز — طلب التاجر:
 *    «إضافة وحدات للمنتج مثلا للبيع بأكثر من قطعة بسعر مميز».
 *    قسم مطوي في نافذة الإضافة السريعة (اسم + عدد حبات/وزن كغ +
 *    سعر خاص) يمر بمنظومة الوحدات نفسها (UnitRepo.getOrCreate +
 *    replaceForProduct) فيظهر في منتقي الوحدة في السلة فوراً.
 * ٥. الشريط السفلي أسفل أزرار النظام — التطبيق يستهدف API 36
 *    وأندرويد 15+ يفرض الرسم حافة-للحافة (خيار الاعتذار متجاهَل
 *    على 16) فكان شريط التبويبات الثابت 62dp يُرسم خلف شريط
 *    التنقل. الحل: هوامش الأمان في MainTabs (62 + insets.bottom)
 *    + هامش سفلي لنوذج Modal + إصلاح مضاعفة inset أعلى Toaster.
 * ٦. الإصدار: 71.0.0 (79) — التوقيع بنفس مفتاح متجر Play (يُستعاد
 *    من أسرار CI في كل بناء APK وAAB — بلا تغيير).
 */
const read = (p: string) => require('fs').readFileSync(p, 'utf8') as string;

const DEBTS_SCREEN = 'src/screens/debts/LocalDebtsScreen.tsx';
const DEBTS_PDF = 'src/services/DebtsPdfService.ts';
const QUICK_SERVICE = 'src/services/QuickProductService.ts';
const QUICK_SHEET = 'src/components/QuickProductSheet.tsx';
const NAVIGATOR = 'src/navigation/RootNavigator.tsx';
const UI = 'src/components/ui.tsx';
const BRIDGE = 'src/native/nativeBridge.ts';
const PLATFORM =
  'android/app/src/main/java/com/sela/pal/native_modules/PlatformUtilsModule.kt';
const DEBTS_REPO = 'src/database/repositories/LocalDebtsRepo.ts';
const CONFIG = 'src/core/config.ts';
const GRADLE = 'android/app/build.gradle';

describe('v70 — ١ دين مباشر بلا بيع', () => {
  test('نافذة الدين المباشر في ملف الزبون', () => {
    const src = read(DEBTS_SCREEN);
    expect(src).toContain('debtOpen');
    expect(src).toContain('دين مباشر');
    expect(src).toContain('addDirectDebt');
    expect(src).toContain('تأكيد تسجيل الدين');
    // معاينة الرصيد بعد التسجيل — الشفافية المحاسبية.
    expect(src).toContain('الرصيد القائم بعد التسجيل');
    // الحد الأقصى نفسه كتسجيل السداد.
    expect(src).toContain('أقصى مبلغ مسموح 1,000,000');
  });

  test('الدين المباشر يسلك مسار INV-L نفسه (لا مسار موازٍ)', () => {
    const src = read(DEBTS_SCREEN);
    expect(src).toContain('LocalDebtsRepo.addDebt({');
    const repo = read(DEBTS_REPO);
    expect(repo).toContain('async addDebt(');
    expect(repo).toContain('reserveLocalDebtRef');
  });

  test('بيان كل عملية يظهر في سجل حساب الزبون', () => {
    const src = read(DEBTS_SCREEN);
    expect(src).toContain('historyNote');
    expect(src).toContain('debt.description');
    expect(src).toContain('pay.note');
  });
});

describe('v70 — ٢ تقارير الديون PDF', () => {
  test('المحرّك الأصلي createDebtsReportPdf في Kotlin', () => {
    const kotlin = read(PLATFORM);
    expect(kotlin).toContain('fun createDebtsReportPdf(');
    // جدول عام بأعمدة موزونة + خلايا ملونة (دين/سداد) + ترقيم صفحات.
    expect(kotlin).toContain('paintForTone');
    expect(kotlin).toContain('debtPaint');
    expect(kotlin).toContain('payPaint');
  });

  test('الجسر + الخدمة: تصدير ومشاركة وطباعة للدفتر والزبون', () => {
    const bridge = read(BRIDGE);
    expect(bridge).toContain('createDebtsReportPdf(');
    const svc = read(DEBTS_PDF);
    expect(svc).toContain('exportBookPdf');
    expect(svc).toContain('shareBookPdf');
    expect(svc).toContain('printBookPdf');
    expect(svc).toContain('exportCustomerPdf');
    expect(svc).toContain('shareCustomerPdf');
    expect(svc).toContain('printCustomerPdf');
  });

  test('زر التقرير في صفحة الدين وزر الكشف المفصل في ملف الزبون', () => {
    const src = read(DEBTS_SCREEN);
    expect(src).toContain('تقرير الديون PDF');
    expect(src).toContain('كشف حساب PDF مفصل');
    expect(src).toContain('مشاركة الكشف');
    expect(src).toContain('طباعة الكشف (A4)');
  });

  test('كشف الحساب المفصل: رصيد جاري بعد كل عملية', () => {
    const svc = read(DEBTS_PDF);
    expect(svc).toContain('let running = 0');
    expect(svc).toContain('الرصيد بعد');
    expect(svc).toContain('دين +');
    expect(svc).toContain('سداد −');
  });
});

describe('v70 — ٣ زر صِلة خلف بوابة الربط', () => {
  test('البوابة من silaStore والحصر الشرطي حول الأزرار', () => {
    const src = read(DEBTS_SCREEN);
    expect(src).toContain("useSilaStore(state => state.pairing != null)");
    expect(src).toContain('{silaPaired ? (');
    // زر الترحيل نفسه لا يُحذف — يُحصر.
    expect(src).toContain('ربط وترحيل إلى صِلة');
  });
});

describe('v70 — ٤ وحدات إضافية → استُبدلت بخيارات بيع بالعدد (v71 الجولة 83)', () => {
  test('الخدمة بنت خيارات العدد (باكجات) على منظومة متغيرات الأحجام', () => {
    const svc = read(QUICK_SERVICE);
    // v71: الباكجات حلّت محل الوحدات الإضافية بطلب التاجر.
    expect(svc).toContain('QuickPackage');
    expect(svc).toContain('quickPackageLabel');
    expect(svc).toContain('parsePackageCount');
    expect(svc).toContain('packages');
    // الوحدات الإضافية القديمة أُزيلت نهائياً.
    expect(svc).not.toContain('extraUnits');
    expect(svc).not.toContain('QuickExtraUnit');
  });

  test('واجهة قسم مطوي بصفوف (عدد + سعر) وحذف صف', () => {
    const sheet = read(QUICK_SHEET);
    expect(sheet).toContain('خيارات بيع بالعدد');
    expect(sheet).toContain('إضافة خيار آخر');
    expect(sheet).toContain('parsePackageRows');
    expect(sheet).toContain('packages');
  });
});

describe('v70 — ٥ الشريط السفلي فوق أزرار النظام', () => {
  test('هوامش الأمان في شريط التبويبات', () => {
    const nav = read(NAVIGATOR);
    expect(nav).toContain('useSafeAreaInsets');
    expect(nav).toContain('height: 62 + insets.bottom');
    expect(nav).toContain('paddingBottom: 8 + insets.bottom');
  });

  test('هامش سفلي لنافذة Modal + إصلاح مضاعفة inset الـ Toaster', () => {
    const sheet = read(QUICK_SHEET);
    expect(sheet).toContain('paddingBottom: spacing.xxl + insets.bottom');
    const ui = read(UI);
    expect(ui).toContain('Math.max(statusBarHeight ?? 24, insets.top)');
  });
});

describe('v70 — ٦ الإصدار والتوقيع', () => {
  test('71.0.0 (79) في config والبناء', () => {
    const config = read(CONFIG);
    expect(config).toContain("APP_VERSION = '71.0.0'");
    expect(config).toContain('APP_BUILD_CODE = 79');
    const gradle = read(GRADLE);
    expect(gradle).toContain('versionCode 79');
    expect(gradle).toContain('versionName "71.0.0"');
  });

  test('CI يوقّع بنفس مفتاح Play في كل بناء (بلا تغيير)', () => {
    const ci = read('.github/workflows/android-release.yml');
    expect(ci).toContain('ANDROID_KEYSTORE_BASE64');
    expect(ci).toContain('play-release.keystore');
    expect(ci).toContain('keystore.properties');
  });
});
