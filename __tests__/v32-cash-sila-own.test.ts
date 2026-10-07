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
    expect(src).toContain(
      'isOut ? drawerMinor - amountMinor : drawerMinor + amountMinor',
    );
  });

  test('تحذير تجاوز المتاح يظهر في البطاقة نفسها', () => {
    const src = read(CASH);
    expect(src).toContain('المبلغ أكبر من المتاح!');
  });

  test('صف الملخص فوق زر التأكيد يكرر الرصيد بعد العملية', () => {
    const src = read(CASH);
    expect(src).toContain('رصيد الخزينة بعد العملية');
    expect(src).toContain('afterValue');
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
