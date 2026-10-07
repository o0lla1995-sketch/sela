/**
 * v32 (round-40 #5/#6) — اختبارات حراسة:
 * (#5) نوافذ الخزينة الثلاث تعرض النقد المتاح ورصيد الخزينة بعد
 *      العملية بشكل واضح (بطاقة رصيد حيّة تحت المبلغ + صف الملخص).
 * (#6) دفتر ديون صِلة يميّز ديون هذا المتجر (من الدفاتر المحلية)
 *      عن أرصدة الخادم التي قد تجمع فواتير كل متاجر التاجر.
 */
const read = (path: string) =>
  require('fs').readFileSync(path, 'utf8') as string;

const CASH = 'src/screens/cash/CashMovementsScreen.tsx';
const SILA_REPO = 'src/services/sila/SilaRepo.ts';
const SILA = 'src/screens/sila/SilaScreen.tsx';
const HOME = 'src/screens/HomeScreen.tsx';
const REPORTS = 'src/services/ReportService.ts';

describe('v32 — الخزينة: النقد المتاح والرصيد بعد العملية', () => {
  test('بطاقة الرصيد: متاح الآن + بعد العملية تحت المبلغ مباشرة', () => {
    const src = read(CASH);
    expect(src).toContain('balanceStrip');
    expect(src).toContain('النقد المتاح بالخزينة');
    expect(src).toContain('النقد الحالي بالخزينة');
    expect(src).toContain('الرصيد بعد السحب');
    expect(src).toContain('الرصيد بعد الإيداع');
  });

  test('الرصيد بعد العملية حيّ يتبع المبلغ (خصم للسحب/المصروف وإضافة للإيداع)', () => {
    const src = read(CASH);
    // v33: نفس المعادلة — أعيد تنسيقها متعددة الأسطر داخل البطاقة
    // العلوية؛ التحقق على أجزائها الثلاثة.
    expect(src).toContain('drawerMinor - amountMinor');
    expect(src).toContain('drawerMinor + amountMinor');
    expect(src).toContain('overDrawer');
  });

  test('تحذير تجاوز المتاح يظهر في البطاقة نفسها', () => {
    const src = read(CASH);
    expect(src).toContain('المبلغ أكبر من المتاح!');
  });

  // v33 (round-41 #7): الصف الملخص حُذف بطلب التاجر («ثم زر التأكيد"
  // مباشرة) — البطاقة الحيّة أعلى النافذة تعرض الرصيد بعد العملية
  // لحظياً، والمبلغ مكتوب على زر التأكيد نفسه.
  test('v33 — الترتيب الجديد: بطاقة رصيد أعلى النافذة ثم المبلغ ثم الملاحظة ثم الفئات ثم اللوحة ثم الزر', () => {
    const src = read(CASH);
    const formWrap = src.indexOf('formWrap');
    const balance = src.indexOf('balanceStrip', formWrap);
    const amount = src.indexOf('amountRow', balance);
    const note = src.indexOf('noteInput', amount);
    const cats = src.indexOf('catGrid', note);
    const keypad = src.indexOf('keypad', cats);
    const confirm = src.indexOf('تأكيد ${KIND_META[mode].label}', keypad);
    expect(formWrap).toBeGreaterThan(-1);
    expect(balance).toBeGreaterThan(formWrap);
    expect(amount).toBeGreaterThan(balance);
    expect(note).toBeGreaterThan(amount);
    expect(cats).toBeGreaterThan(note);
    expect(keypad).toBeGreaterThan(cats);
    expect(confirm).toBeGreaterThan(keypad);
    // المبلغ من اليمين ورمز العملة باليسار — غلاف جانب العملة.
    expect(src).toContain('amountSideRow');
    expect(src).toContain("justifyContent: 'space-between'");
  });

  test('v33 — ارتفاع النافذة مثبّت من لحظة الفتح فلا تقفز لوحة الأرقام', () => {
    const src = read(CASH);
    expect(src).toContain('const [sheetHeight] = useState(windowH)');
    expect(src).toContain('height: sheetHeight');
    expect(src).toContain("justifyContent: 'flex-start'");
  });

  test('v33 — كشف الفترة قبل سجل الحركات + آخر 10 حركات بتحميل تلقائي', () => {
    const src = read(CASH);
    const statement = src.indexOf('title="كشف الفترة"');
    const ledger = src.indexOf('title="سجل الحركات"');
    expect(statement).toBeGreaterThan(-1);
    expect(statement).toBeLessThan(ledger);
    expect(src).toContain('const LEDGER_PAGE = 10');
    expect(src).toContain('LEDGER_AUTOSCROLL_PX');
    expect(src).toContain('onLedgerScroll');
  });
});

describe('v32 — ديون صِلة: تمييز هذا المتجر عن كل المتاجر', () => {
  test('المستودع: استعلامان محليان (لكل زبون + الإجمالي)', () => {
    const src = read(SILA_REPO);
    expect(src).toContain('storeOwnOutstandingByCustomer');
    expect(src).toContain('storeOwnOutstandingTotal');
    // The local-books equation: queue debts − payments − app collections.
    expect(src).toContain('FROM sila_debt_queue');
    expect(src).toContain('FROM sila_payment_queue');
    expect(src).toContain('FROM sila_app_collections');
    // Net of the prepaid-covered part.
    expect(src).toContain(
      'amount_minor - COALESCE(credit_covered_minor, 0)',
    );
  });

  test('صفحة الزبائن: الرقم الأساسي من الدفاتر المحلية والترتيب به', () => {
    const src = read(SILA);
    expect(src).toContain('ownByCustomer.get(customer.customer_id)');
    expect(src).toContain('دين متجرك (فواتير هذا المتجر)');
    expect(src).toContain('من فواتير متاجرك الأخرى');
  });

  test('زر السداد وسقفه من دفاتر المتجر مع حد أمان الخادم', () => {
    const src = read(SILA);
    expect(src).toContain('{ownMinor > 0 ? (');
    expect(src).toContain('Math.min(ownMinor, serverCapMinor)');
  });

  test('نظرة عامة: مؤشر الدين والمدينون من الدفاتر المحلية + بطاقة المتاجر الأخرى', () => {
    const src = read(SILA);
    expect(src).toContain('(totals?.ownMinor ?? 0)');
    expect(src).toContain('totals?.ownDebtors ?? 0');
    expect(src).toContain('من فواتير متاجرك الأخرى');
  });

  test('الرئيسية والتقارير تعتمد الدين المحلي للمتجر', () => {
    const home = read(HOME);
    expect(home).toContain('SilaRepo.storeOwnOutstandingTotal()');
    expect(home).toContain('ownTotals.ownMinor');
    const reports = read(REPORTS);
    expect(reports).toContain('silaOwnTotals.ownMinor');
    expect(reports).toContain('silaServerPosOutstandingMinor');
  });
});
