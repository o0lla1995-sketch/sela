/**
 * v72 — الجولة 84: ملاحظات التاجر على نقطة البيع (أندرويد + سطح المكتب).
 * ─────────────────────────────────────────────────────────────────
 * ١. الدين المباشر لا يُخصم من النقد بالخزينة — طلب التاجر نصاً:
 *    «هناك مشكلة عند تسجيل الدين المباشر فإنه يسجل قيمة سالبة في
 *    النقد بالخزينة وهذا غير منطقي حيث إنه عند السداد وخصوصاً
 *    السداد من خلال محفظة أو بنك فإنه يسجل السداد ويسجل بالمحفظة
 *    لكن يبقى بقيمته السالبة بالخزينة، لذلك أفضّل ألا يضاف الدين
 *    المباشر إلى القيمة السالبة بالخزينة ويسجل في الدين القائم
 *    فقط». → عمود origin بجدول local_debts ('sale'/'direct') +
 *    ترحيل قائم (كل دين بلا فاتورة مقابلة = مباشر) + معادلة الخزينة
 *    تطرح ديون البيع فقط، والدين القائم يجمع الاثنين، والسداد وحده
 *    يُغذّي قناة الدفع (سلوك v64 القائم).
 * ٢. حذف عبارة «السلة فارغة» من شريط السلة الفارغة في نقطة البيع
 *    أندرويد — يبقى الإرشاد العملي فقط (المس/امسح) وزر الرجوع
 *    للفاتورة السابقة.
 * ٦. الإصدار: 72.0.0 (80) — نفس مفتاح توقيع Play (بلا تغيير).
 */
const read = (p: string) => require('fs').readFileSync(p, 'utf8') as string;

const REPO = 'src/database/repositories/LocalDebtsRepo.ts';
const CONNECTION = 'src/database/connection.ts';
const TYPES = 'src/core/types.ts';
const REPORT_SERVICE = 'src/services/ReportService.ts';
const BACKUP = 'src/services/BackupService.ts';
const DEBTS_SCREEN = 'src/screens/debts/LocalDebtsScreen.tsx';
const DEBTS_PDF = 'src/services/DebtsPdfService.ts';
const POS = 'src/screens/PosScreen.tsx';
const CONFIG = 'src/core/config.ts';
const GRADLE = 'android/app/build.gradle';

describe('v72 — ١ الدين المباشر لا يلمس الخزينة', () => {
  test('عمود origin في المخطط + ترحيل القائم (بلا فاتورة = مباشر)', () => {
    const src = read(CONNECTION);
    // DDL للتثبيتات الجديدة.
    expect(src).toContain("origin TEXT NOT NULL DEFAULT 'sale'");
    // ترحيل v33: كل دين بلا فاتورة بيع مقابلة يوسم مباشراً — مرة
    // واحدة، وNOT EXISTS لا ينكسر بNULL في invoice_number.
    expect(src).toContain('ترحيل v33');
    expect(src).toContain('NOT EXISTS (');
    expect(src).toContain("SET origin = 'direct'");
    // إصدار المخطط تقدم إلى 33.
    expect(src).toContain('version = 33');
  });

  test('addDebt (المسار المباشر) يوسم origin=direct', () => {
    const src = read(REPO);
    expect(src).toContain("'direct'");
    expect(src).toContain('origin');
    // والنوع يحمل الأصل.
    const types = read(TYPES);
    expect(types).toContain("origin: 'sale' | 'direct'");
  });

  test('totals: debtsMinor ديون البيع فقط + directDebtsMinor منفصل', () => {
    const src = read(REPO);
    // ديون البيع فقط (لها فواتير داخل الإيراد) تدخل معادلة الخزينة.
    expect(src).toContain(
      "WHERE migrated = 0 AND COALESCE(origin, 'sale') = 'sale'",
    );
    // الديون المباشرة تُجمع منفصلة.
    expect(src).toContain("WHERE migrated = 0 AND origin = 'direct'");
    // الدين القائم = بيع + مباشر − سدادات.
    expect(src).toContain(
      'outstandingMinor: debtsMinor + directDebtsMinor - paymentsMinor',
    );
  });

  test('معادلة الخزينة تشرح الاستثناء (المباشر خارج المعادلة)', () => {
    const src = read(REPORT_SERVICE);
    expect(src).toContain('localBook.debtsMinor');
    expect(src).toContain('origin=');
    expect(src).toContain('لا يُطرح هنا إطلاقاً');
  });

  test('النسخة الاحتياطية تحفظ الأصل وتستنتجه للنسخ القديمة', () => {
    const src = read(BACKUP);
    // التصدير يحمل العمود.
    expect(src).toContain('origin, migrated, migrated_ref, created_at');
    // الاستعادة: الأصل الصريح يفوز، والغائب يُستنتج من وجود الفاتورة.
    expect(src).toContain('COALESCE(?, CASE WHEN EXISTS (');
    expect(src).toContain("THEN 'sale' ELSE 'direct' END");
  });

  test('الواجهة تميّز الدين المباشر: سجل الحساب + الكشف + التلميح', () => {
    const screen = read(DEBTS_SCREEN);
    expect(screen).toContain("debt.origin === 'direct'");
    expect(screen).toContain('(دين مباشر)');
    // تلميح النافذة يشرح القاعدة المحاسبية الجديدة.
    expect(screen).toContain('لا يُخصم من النقد بالخزينة إطلاقاً');
    const pdf = read(DEBTS_PDF);
    expect(pdf).toContain("d.origin === 'direct'");
    expect(pdf).toContain('(دين مباشر)');
  });
});

describe('v72 — ٢ حذف عبارة «السلة فارغة» من شريط السلة', () => {
  test('الشريط الفارغ يعرض الإرشاد العملي فقط', () => {
    const src = read(POS);
    // العبارة حُذفت من شريط السلة الفارغة (تبقى في رسائل الخطأ
    // عند محاولة الدفع بسلة فارغة — سياق مختلف).
    expect(src).toContain('المس منتجاً من الشبكة بالأعلى أو امسحه');
    const strip = src.slice(
      src.indexOf('cartEmptyRow'),
      src.indexOf('recallBtn}'),
    );
    expect(strip).not.toContain('السلة فارغة');
    // زر الرجوع للفاتورة السابقة باقٍ في السلة الفارغة.
    expect(src).toContain('الرجوع للفاتورة السابقة');
  });
});

describe('v72 — ٦ الإصدار والتوقيع', () => {
  test('72.0.0 (80) في config والبناء', () => {
    const config = read(CONFIG);
    expect(config).toContain("APP_VERSION = '78.2.0'");
    expect(config).toContain('APP_BUILD_CODE = 88');
    const gradle = read(GRADLE);
    expect(gradle).toContain('versionCode 88');
    expect(gradle).toContain('versionName "78.2.0"');
  });
});
