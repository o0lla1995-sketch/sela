/**
 * v42 — الجولة 50: ستة طلبات (ضغط صف جملة/مفرق + أيقونة الشكل،
 * زر تحميل تطبيق صِلة، رسم مبيعات يتبع الفترة، حذف عنوان
 * الخزينة والديون، زر تصغير السلة).
 * ─────────────────────────────────────────────────────────────────
 * ① صف جملة/مفرق مضغوط: مبدّل بالقياس المضغوط (dense) قابل
 *    للانكماش داخل غلاف flexShrink — لا يدفع زر الشكل خارج
 *    الشاشة على الأجهزة الضيقة/ذات الخط الكبير — وزر الشكل
 *    أيقونة فقط دون نص (مربع ٤٠×٤٠ برتقالي هادئ).
 * ② صفحة الربط بصِلة: زر تحميل التطبيق يفتح متجر Google Play
 *    مباشرة على https://play.google.com/store/apps/details?id=com.sila.pay
 * ③ أداء المبيعات يتبع الفترة المحددة: كل عمود يحمل تاريخه
 *    الفعلي (اليوم/أمس/٧ أيام: تاريخ + اسم اليوم تحته؛ الشهر:
 *    أرقام الأيام؛ «الكل»: سلسلة شهرية بأسماء الشهور الشامية)
 *    — ولا اقتطاع slice(-10) — وحارس السلسلة اليومية لم يعد
 *    يقطع عند ١٢٠ يوماً، والفترات الأطول من ٦٢ يوماً سلسلة
 *    شهرية تبدأ من أول شهر نشاط فعلي.
 * ④ الرئيسية: عنوان «الخزينة والديون» حُذف — الشاشة تبدأ
 *    مباشرة ببطاقة الأرقام.
 * ⑤ السلة: زر تصغير بجانب زر التكبير يطوي اللوحة كلها إلى
 *    شريط سطر واحد، ولمسة الشريط أو إضافة سطر جديد تعيدانها.
 * ⑥ أيقونة المتجر: صورة PNG عالية الدقة قابلة للتحميل (تُسلَّم
 *    خارج الشيفرة في مجلد التنزيلات — حرّوس المصدر تتحقق من
 *    مولّدها).
 */
import {freshApp, load} from './helpers/app';

const read = (path: string) =>
  require('fs').readFileSync(path, 'utf8') as string;

// v44 (الجولة 52 #2): المبدّل عاد للحجم الطبيعي الواسع وغلافه
// يتمدد flex:1 — لا انكماش ولا اقتطاع نص (هجر قياس v42 المضغوط
// بطلب التاجر: توسيع الزرين مع بقاء زر الشكل بجوارهما دائماً).
const POS_DENSE_SEGMENTED =
  /<Segmented[\s\S]*?options=\{[\s\S]*?\}\s*\n\s*dense\s*\n\s*\/>/;

describe('v42 — حرّوس المصدر: الستة طلبات', () => {
  test('① صف جملة/مفرق + زر الشكل (محدّث للجولة 52: صف واسع بلا انكماش)', () => {
    const pos = read('src/screens/PosScreen.tsx');
    const ui = read('src/components/ui.tsx');

    // v44: الغلاف يتمدد ليأخذ كل عرض الصف — المبدّل وزر الشكل
    // ظاهران معاً دائماً ولا يُدف شيء خارج الشاشة.
    expect(pos).toContain('styles.modeSegWrap');
    expect(pos).toContain('flex: 1');
    // كتلة modeSegWrap تحديداً هجرت الانكماش (بقية flexShrink
    // في الشاشة استخدامات مشروعة لأجزاء أخرى — السلة والبحث).
    expect(pos).not.toContain('modeSegWrap: {\n      flexShrink: 1');
    // زر الشكل أيقونة فقط: مربع ثابت بلا نص ولا سهم.
    expect(pos).not.toContain('styles.viewShapeBtnText');
    expect(pos).toContain('accessibilityLabel="تغيير شكل عرض المنتجات"');
    // مكوّن المبدّل ما زال يدعم القياس المضغوط لبقية الشاشات.
    expect(ui).toContain('dense?: boolean');
    expect(ui).toContain('segmentedDense');
    expect(ui).toContain('segItemDense');
    expect(ui).toContain('segTextDense');
    // v44: مبدّل نقطة البيع تحديداً هجر dense — الزران واسعان.
    expect(pos.match(POS_DENSE_SEGMENTED)).toBeNull();
  });

  test('② صفحة الربط: زر تحميل تطبيق صِلة يفتح متجر Google Play مباشرة', () => {
    const sila = read('src/screens/sila/SilaScreen.tsx');
    // الرابط المطلوب حرفياً.
    expect(sila).toContain(
      "'https://play.google.com/store/apps/details?id=com.sila.pay'",
    );
    // فتح مباشر عبر Linking.
    expect(sila).toContain('Linking.openURL(SILA_PLAY_URL)');
    // الزر داخل بطاقة الربط بأيقونة تحميل.
    expect(sila).toContain('styles.downloadAppBtn');
    expect(sila).toContain('تحميل تطبيق صِلة من Google Play');
    expect(sila).toContain('name="download"');
  });

  test('③ أ — الرسم اليومي: كل عمود يحمل تاريخه الفعلي لا أسابيع مكررة', () => {
    const reports = read('src/screens/reports/ReportsScreen.tsx');
    // الاقتطاع القديم زال — الفترة كلها ظاهرة.
    expect(reports).not.toContain('slice(-10)');
    // التسمية بالتاريخ الفعلي + اسم اليوم تحته.
    expect(reports).toContain('dayMonthLabel(point.day)');
    expect(reports).toContain('weekdayLabel(point.day)');
    // أرقام أيام الشهر للفترة الشهرية.
    expect(reports).toContain("rangeKey === 'thisMonth'");
    // العنوان يتبع حبيبية السلسلة.
    expect(reports).toContain('أداء المبيعات الشهري');
    expect(reports).toContain('أداء المبيعات اليومي');
  });

  test('③ ب — الرسم الشهري: السلسلة الشهرية والاختيار بحسب المدة', () => {
    const repo = read('src/database/repositories/ReportRepo.ts');
    const service = read('src/services/ReportService.ts');
    const chart = read('src/components/charts/BarChart.tsx');
    const format = read('src/core/format.ts');

    // المستودع: سلسلة شهرية تبدأ من أول شهر نشاط.
    expect(repo).toContain('monthlySeries');
    expect(repo).toContain('substr(${EFFECTIVE_AT}, 1, 7)');
    // حارس السلسلة اليومية رُفع من ١٢٠ إلى ٤٠٠.
    expect(repo).toContain('guard < 400');
    expect(repo).not.toContain('guard < 120');
    // الخدمة: ما تجاوز ٦٢ يوماً سلسلة شهرية.
    expect(service).toContain('spanDays > 62');
    expect(service).toContain('ReportRepo.monthlySeries(range)');
    // الرسم: سطر فرعي تحت التسمية.
    expect(chart).toContain('sublabel?: string');
    expect(chart).toContain('axisSubLabel');
    // التنسيق: أسماء الشهور الشامية + تاريخ يوم/شهر مضغوط.
    expect(format).toContain('MONTHS_AR');
    expect(format).toContain('تشرين الأول');
    expect(format).toContain('dayMonthLabel');
  });

  test('④ الرئيسية: عنوان «الخزينة والديون» حُذف والبطاقة باقية', () => {
    const home = read('src/screens/HomeScreen.tsx');
    expect(home).not.toContain('title="الخزينة والديون"');
    // البطاقة نفسها وقيمها في مكانها.
    expect(home).toContain('styles.moneyCard');
    expect(home).toContain('النقد بالخزينة');
    expect(home).toContain('الدين القائم لك');
  });

  test('⑤ السلة: زر تصغير بجانب زر التكبير + استعادة تلقائية', () => {
    const pos = read('src/screens/PosScreen.tsx');
    // الحالة والاستعادة عند إضافة سطر.
    expect(pos).toContain('cartMinimized');
    expect(pos).toContain('setCartMinimized(false)');
    expect(pos).toContain('prevLinesCountRef');
    // الزر المستقل + كبسولة الزرين معاً.
    expect(pos).toContain('minimizeCart');
    expect(pos).toContain('styles.cartSizeBtns');
    expect(pos).toContain('styles.cartSizeBtn');
    expect(pos).toContain('name="minus"');
    // الشريط يخدم التصغير أيضاً (ليس البحث فقط).
    expect(pos).toContain('(searchFocused || cartMinimized) && !cartExpanded');
    // الزران القديمان المعنونان زالا.
    expect(pos).not.toContain('styles.expandBtnText');
    expect(pos).not.toContain("cartExpanded ? 'تصغير' : 'تكبير'");
  });
});

describe('v42 — وظيفي: التسميات الزمنية', () => {
  test('dayMonthLabel: يوم/شهر مضغوط وweekdayLabel كما هو', () => {
    const {dayMonthLabel, weekdayLabel} = load('src/core/format');
    expect(dayMonthLabel('2026-10-09')).toBe('9/10');
    expect(dayMonthLabel('2026-01-02')).toBe('2/1');
    // قيمة غير تاريخية تمر كما هي (تحصّن ضد NaN).
    expect(dayMonthLabel('n/a')).toBe('n/a');
    expect(weekdayLabel('2026-10-09')).toBe('الجمعة');
  });

  test('monthLabel: أسماء الشهور الشامية', () => {
    const {monthLabel} = load('src/core/format');
    expect(monthLabel('2026-10')).toBe('تشرين الأول');
    expect(monthLabel('2026-01')).toBe('كانون الثاني');
    expect(monthLabel('2026-12')).toBe('كانون الأول');
    // قيمة غير شهرية تمر كما هي.
    expect(monthLabel('bad')).toBe('bad');
  });
});

describe('v42 — وظيفي: السلاسل تتبع الفترة', () => {
  test('monthlySeries: تجميع شهري + سد الفجوات + يبدأ من أول شهر نشاط لا من 2000', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {ReportRepo} = load('src/database/repositories/ReportRepo');
    const {localToday} = load('src/core/format');
    const today = localToday();

    // منتجان ومبيعتان: آب ٢٠٢٦ وأكتوبر ٢٠٢٦ (أيلول فجوة).
    const {ProductRepo} = load('src/database/repositories/ProductRepo');
    const {InvoiceService} = load('src/services/InvoiceService');
    const product = await ProductRepo.create({
      name: 'عصير',
      cost_price: 3,
      retail_price: 6,
      wholesale_price: 5,
      stock_quantity: 100,
      category_id: null,
      image_uri: null,
    });
    const saleLine = {
      key: `p${product}`,
      productId: product,
      name: 'عصير',
      unitPrice: 6,
      costPrice: 3,
      retailPrice: 6,
      wholesalePrice: 6,
      quantity: 10,
      availableStock: 999,
      unitId: null,
      unitName: 'قطعة',
      conversion: 1,
    };
    const mk = async (when: string) => {
      const {sale} = await InvoiceService.completeSale({
        lines: [saleLine],
        discount: 0,
        paymentType: 'RETAIL',
        print: false,
        receiptSettings: {} as never,
      } as never);
      await app.connection
        .getDb()
        .execute('UPDATE sales SET created_at = ? WHERE id = ?', [
          when,
          sale.id,
        ]);
    };
    await mk('2026-08-12 11:00:00'); // 60₪ في آب
    await mk('2026-10-03 15:00:00'); // 60₪ في تشرين الأول

    // نطاق «الكل»: من 2000-01-01 — السلسلة الشهرية تبدأ من آب
    // ٢٠٢٦ (أول نشاط) لا من عام 2000.
    const monthly = await ReportRepo.monthlySeries({
      from: '2000-01-01',
      to: today,
    });
    expect(monthly.length).toBeGreaterThan(0);
    expect(monthly[0].day).toBe('2026-08');
    expect(monthly[0].label).toBe('آب');
    expect(monthly[0].revenue).toBeCloseTo(60, 5);
    // فجوة أيلول مسدودة بصفر.
    const september = monthly.find(p => p.day === '2026-09');
    expect(september).toBeDefined();
    expect(september?.revenue).toBe(0);
    // تشرين الأول يحمل مبيعاته، وهو آخر شهر في السلسلة.
    const last = monthly[monthly.length - 1];
    expect(last.day).toBe(today.slice(0, 7));
    const october = monthly.find(p => p.day === '2026-10');
    expect(october?.revenue).toBeCloseTo(60, 5);
  });

  test('dailySeries: مدى 150 يوماً لا يُقطع عند 120 بعد اليوم', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {ReportRepo} = load('src/database/repositories/ReportRepo');
    const {localDateShift} = load('src/core/format');

    const from = localDateShift(-150);
    const to = localDateShift(0);
    const daily = await ReportRepo.dailySeries({from, to});
    // 151 يوماً كاملة — الحارس القديم كان يوقفها عند 120.
    expect(daily).toHaveLength(151);
    expect(daily[0].day).toBe(from);
    expect(daily[150].day).toBe(to);
  });
});
