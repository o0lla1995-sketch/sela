/**
 * v30 (round-38 #3) — إسناد المرتجعات لفترة الفاتورة الأصلية.
 * ─────────────────────────────────────────────────────────────────
 * قاعدة التاجر: «إرجاع مبيعات قديمة لا يجعل مبيعات اليوم بالسالب،
 * وصافي الربح لا يصبح سالباً، والمفترض ألا تُحتسب المنتجات المرجعة
 * في اليوم الذي أُرجعت فيه».
 *
 * Every RET row is attributed to its ORIGINAL invoice's period:
 *   • مرتجع فاتورة قديمة اليوم ومبيعات اليوم صفر → اليوم يبقى صفراً
 *     (لا سالب) في الإيراد والربح، ويظهر المرتجع في مؤشر «المرتجعات»
 *     بيوم معالجته (شفافية كاملة).
 *   • يوم البيع الأصلي يُعاد صياغته صافياً من المرتجع.
 *   • مرتجع فاتورة اليوم نفسها يظل يُصفّي اليوم (سلوك v23 محفوظاً).
 *   • السلاسل اليومية/الساعية/الأفضل مبيعياً/فواتير الدين/التصدير
 *     كلها بالإسناد نفسه فلا تناقض بين أي رقمين.
 */
import {freshApp, load} from './helpers/app';

const NO_PRINT = {
  print: false,
  receiptSettings: {} as never,
};

function line(
  product: {id: number; name: string; retail: number; cost: number},
  quantity: number,
) {
  return {
    key: `p${product.id}`,
    productId: product.id,
    name: product.name,
    unitPrice: product.retail,
    costPrice: product.cost,
    retailPrice: product.retail,
    wholesalePrice: product.retail,
    quantity,
    availableStock: 999,
    unitId: null,
    unitName: 'قطعة',
    conversion: 1,
  };
}

async function seedProduct(name: string, retail: number, cost: number, stock: number) {
  const {ProductRepo} = load('src/database/repositories/ProductRepo');
  const id = await ProductRepo.create({
    name,
    cost_price: cost,
    retail_price: retail,
    wholesale_price: retail,
    stock_quantity: stock,
    category_id: null,
    image_uri: null,
  });
  return {id, name, retail, cost};
}

/** Backdates a sale — simulates an invoice from an earlier day. */
async function backdateSale(app: ReturnType<typeof freshApp>, saleId: number, when: string) {
  await app.connection.getDb().execute(
    'UPDATE sales SET created_at = ? WHERE id = ?',
    [when, saleId],
  );
}

async function cashSale(productId: {id: number; name: string; retail: number; cost: number}, qty: number) {
  const {InvoiceService} = load('src/services/InvoiceService');
  const sale = await InvoiceService.completeSale({
    lines: [line(productId, qty)],
    discount: 0,
    paymentType: 'RETAIL',
    ...NO_PRINT,
  } as never);
  return sale.sale;
}

async function returnAll(saleId: number) {
  const {InvoiceService} = load('src/services/InvoiceService');
  const prep = await InvoiceService.prepareReturn(saleId);
  return InvoiceService.createReturn({
    saleId,
    lines: prep.lines.map(l => ({
      saleItemId: l.item.id,
      productId: l.item.product_id,
      productName: l.productName,
      quantity: l.remaining,
      unitName: 'قطعة',
      basePerUnit: 1,
      unitPrice: l.item.unit_price,
      costPrice: l.item.cost_price,
    })),
    refundMethod: 'cash',
    ...NO_PRINT,
  } as never);
}

const OLD_DAY = '2026-09-15';

describe('v30 — إسناد المرتجع لفترة الفاتورة الأصلية', () => {
  test('مرتجع فاتورة قديمة ومبيعات اليوم صفر: اليوم يبقى صفراً لا سالباً', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {ReportRepo} = load('src/database/repositories/ReportRepo');
    const {localToday} = load('src/core/format');
    const today = localToday();

    // An OLD cash sale: 10 × 10₪ (cost 6) = 100₪, profit 40₪.
    const cola = await seedProduct('كولا', 10, 6, 100);
    const oldSale = await cashSale(cola, 10);
    await backdateSale(app, oldSale.id, `${OLD_DAY} 14:30:00`);

    // Full return processed TODAY.
    await returnAll(oldSale.id);

    // TODAY: zero sales — must stay ZERO, never negative.
    const todaySummary = await ReportRepo.summary({from: today, to: today});
    expect(todaySummary.revenue).toBeCloseTo(0, 5);
    expect(todaySummary.netProfit).toBeCloseTo(0, 5);
    expect(todaySummary.itemsCount).toBeCloseTo(0, 5);
    expect(todaySummary.invoicesCount).toBe(0);
    // The refund the merchant processed today stays VISIBLE — its own KPI.
    expect(todaySummary.returnsCount).toBe(1);
    expect(todaySummary.returnsTotal).toBeCloseTo(100, 5);

    // The ORIGINAL day: restated net of the return (100 − 100 = 0).
    const oldSummary = await ReportRepo.summary({from: OLD_DAY, to: OLD_DAY});
    expect(oldSummary.revenue).toBeCloseTo(0, 5);
    expect(oldSummary.netProfit).toBeCloseTo(0, 5);
    expect(oldSummary.invoicesCount).toBe(1); // the invoice itself still exists
    expect(oldSummary.returnsCount).toBe(0); // not PROCESSED on that day
  });

  test('مرتجع قديم لا يخدش مبيعات اليوم الحقيقية ولا صافي ربحها', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {ReportRepo} = load('src/database/repositories/ReportRepo');
    const {localToday} = load('src/core/format');
    const today = localToday();

    // OLD sale: 100₪ (profit 40). Today's OWN sale: 30₪ (profit 10).
    const cola = await seedProduct('كولا', 10, 6, 100);
    const chips = await seedProduct('شيبس', 6, 4, 100);
    const oldSale = await cashSale(cola, 10);
    await backdateSale(app, oldSale.id, `${OLD_DAY} 14:30:00`);
    await cashSale(chips, 5);

    await returnAll(oldSale.id);

    const todaySummary = await ReportRepo.summary({from: today, to: today});
    expect(todaySummary.revenue).toBeCloseTo(30, 5); // 30 − 0 (not 30 − 100)
    expect(todaySummary.netProfit).toBeCloseTo(10, 5); // 10 − 0 (not −30)
    expect(todaySummary.invoicesCount).toBe(1);
    expect(todaySummary.returnsCount).toBe(1);
    expect(todaySummary.returnsTotal).toBeCloseTo(100, 5);
    expect(todaySummary.avgInvoice).toBeCloseTo(30, 5);
  });

  test('مرتجع فاتورة اليوم نفسها يظل يُصفّي اليوم (سلوك v23 محفوظاً)', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {ReportRepo} = load('src/database/repositories/ReportRepo');
    const {localToday} = load('src/core/format');
    const today = localToday();

    const cola = await seedProduct('كولا', 10, 6, 100);
    const sale = await cashSale(cola, 4); // 40₪, profit 16₪
    await returnAll(sale.id);

    const summary = await ReportRepo.summary({from: today, to: today});
    expect(summary.revenue).toBeCloseTo(0, 5);
    expect(summary.netProfit).toBeCloseTo(0, 5);
    expect(summary.invoicesCount).toBe(1);
    expect(summary.returnsCount).toBe(1);
    expect(summary.returnsTotal).toBeCloseTo(40, 5);
  });

  test('السلسلة اليومية: عمود اليوم الأصلي يُعاد صياغته وعمود اليوم لا ينقص', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {ReportRepo} = load('src/database/repositories/ReportRepo');
    const {localToday} = load('src/core/format');
    const today = localToday();

    const cola = await seedProduct('كولا', 10, 6, 100);
    const oldSale = await cashSale(cola, 8); // 80₪
    await backdateSale(app, oldSale.id, `${OLD_DAY} 10:00:00`);
    await returnAll(oldSale.id);

    const daily = await ReportRepo.dailySeries({from: OLD_DAY, to: today});
    const oldPoint = daily.find(p => p.day === OLD_DAY);
    const todayPoint = daily.find(p => p.day === today);
    expect(oldPoint?.revenue).toBeCloseTo(0, 5); // restated 80 − 80
    expect(todayPoint?.revenue).toBeCloseTo(0, 5); // never −80
    // The whole-range summary reconciles with the bars' sum.
    const rangeSummary = await ReportRepo.summary({from: OLD_DAY, to: today});
    const barsSum = daily.reduce((sum, p) => sum + p.revenue, 0);
    expect(barsSum).toBeCloseTo(rangeSummary.revenue, 5);
    expect(rangeSummary.revenue).toBeCloseTo(0, 5);
  });

  test('الأفضل مبيعاً: مرتجع قديم لا يزرع صفاً سالباً في منتجات اليوم', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {ReportRepo} = load('src/database/repositories/ReportRepo');
    const {localToday} = load('src/core/format');
    const today = localToday();

    const cola = await seedProduct('كولا', 10, 6, 100);
    const oldSale = await cashSale(cola, 10);
    await backdateSale(app, oldSale.id, `${OLD_DAY} 09:00:00`);
    await returnAll(oldSale.id);

    // Today: 2 fresh cola sales (net of nothing).
    await cashSale(cola, 2);

    const todayTop = await ReportRepo.topProducts({from: today, to: today}, 10);
    expect(todayTop).toHaveLength(1);
    expect(todayTop[0].quantity).toBeCloseTo(2, 5); // 2, not 2 − 10
    expect(todayTop[0].revenue).toBeCloseTo(20, 5);
    expect(todayTop[0].profit).toBeCloseTo(8, 5);

    // The OLD day nets to zero for the product.
    const oldTop = await ReportRepo.topProducts({from: OLD_DAY, to: OLD_DAY}, 10);
    expect(oldTop[0].quantity).toBeCloseTo(0, 5);
    expect(oldTop[0].revenue).toBeCloseTo(0, 5);
  });

  test('فواتير الدين: مرتجع دين قديم لا يجعل ديون اليوم سالبة', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {ReportRepo} = load('src/database/repositories/ReportRepo');
    const {InvoiceService} = load('src/services/InvoiceService');
    const LocalDebts = load('src/database/repositories/LocalDebtsRepo');
    const {localToday} = load('src/core/format');
    const today = localToday();

    const customer = await LocalDebts.LocalDebtsRepo.createCustomer({
      name: 'محمد',
      idNumber: '400123456',
      phone: '0561234567',
      notes: null,
    });

    // An OLD local-book debt sale: 5 × 6₪ = 30₪.
    const milk = await seedProduct('حليب', 6, 4, 100);
    const sale = await InvoiceService.completeSale({
      lines: [line(milk, 5)],
      discount: 0,
      paymentType: 'RETAIL',
      localDebt: {
        localCustomerId: customer.id,
        customerName: 'محمد',
        customerPhoneLast4: '4567',
      },
      ...NO_PRINT,
    } as never);
    expect(sale.sale.invoice_number).toMatch(/^INV-L-/);
    await backdateSale(app, sale.sale.id, `${OLD_DAY} 12:00:00`);

    // Full return processed TODAY.
    await returnAll(sale.sale.id);

    const todayDebt = await ReportRepo.debtSalesSummary({from: today, to: today});
    expect(todayDebt.localAmount).toBeCloseTo(0, 5); // never −30
    expect(todayDebt.localCount).toBe(0);

    const oldDebt = await ReportRepo.debtSalesSummary({from: OLD_DAY, to: OLD_DAY});
    expect(oldDebt.localAmount).toBeCloseTo(0, 5); // restated 30 − 30
    expect(oldDebt.localCount).toBe(1);
  });

  test('التصدير التفصيلي يتطابق مع الملخص (مبالغ تُسوى بنفس الإسناد)', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {ReportRepo} = load('src/database/repositories/ReportRepo');
    const {localToday} = load('src/core/format');
    const today = localToday();

    const cola = await seedProduct('كولا', 10, 6, 100);
    const oldSale = await cashSale(cola, 7); // 70₪
    await backdateSale(app, oldSale.id, `${OLD_DAY} 16:00:00`);
    await returnAll(oldSale.id);
    await cashSale(cola, 3); // today's own 30₪

    // Today's export: only today's invoice — no RET row (its original
    // is out of range), so the export's sum equals the summary card.
    const todayRows = await ReportRepo.salesDetail({from: today, to: today});
    expect(todayRows).toHaveLength(1);
    expect(todayRows[0].invoice).toMatch(/^INV-/);
    const todaySum = todayRows.reduce((sum, r) => sum + r.total, 0);
    const todaySummary = await ReportRepo.summary({from: today, to: today});
    expect(todaySum).toBeCloseTo(todaySummary.revenue, 5);

    // The OLD day's export: the invoice AND its RET row (net zero).
    const oldRows = await ReportRepo.salesDetail({from: OLD_DAY, to: OLD_DAY});
    expect(oldRows).toHaveLength(2);
    const retRow = oldRows.find(r => r.invoice.startsWith('RET-'));
    expect(retRow?.paymentType).toBe('مرتجع');
    const oldSum = oldRows.reduce((sum, r) => sum + r.total, 0);
    const oldSummary = await ReportRepo.summary({from: OLD_DAY, to: OLD_DAY});
    expect(oldSum).toBeCloseTo(oldSummary.revenue, 5);
    expect(oldSum).toBeCloseTo(0, 5);
  });

  test('حزمة الرئيسية كاملة: مبيعات اليوم وصافي الربح صفر بعد إرجاع قديم كامل', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {ReportService} = load('src/services/ReportService');

    const cola = await seedProduct('كولا', 12, 8, 100);
    const oldSale = await cashSale(cola, 10); // 120₪, profit 40₪
    await backdateSale(app, oldSale.id, `${OLD_DAY} 18:00:00`);
    await returnAll(oldSale.id);

    const bundle = await ReportService.loadBundle('today');
    expect(bundle.summary.revenue).toBeCloseTo(0, 5);
    expect(bundle.summary.netProfit).toBeCloseTo(0, 5);
    expect(bundle.summary.invoicesCount).toBe(0);
    expect(bundle.summary.returnsCount).toBe(1);
    expect(bundle.cash.creditSalesAmount).toBeCloseTo(0, 5);
  });
});
