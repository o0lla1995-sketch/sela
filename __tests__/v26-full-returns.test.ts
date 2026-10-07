/**
 * v26 (round-34) — the full-return + live-debt regression suite:
 *
 *  #2  FULL return of a LOCAL debt invoice (INV-L) — the old
 *      `UPDATE local_debts SET amount_minor = MAX(0, …)` hit the
 *      CHECK (amount_minor > 0) constraint the moment the refund
 *      zeroed the debt → an SQL error rolled the WHOLE transaction
 *      back («لا يسمح بإرجاع كل الأصناف جميعا»). Now the row is
 *      DELETED (mirroring the sila pending-queue discipline) and the
 *      books stay balanced.
 *  #3  A synced-debt return's reversal payment must net the LIVE
 *      standing debt immediately (pendingReversalsMinor), and the
 *      treasury equation stays balanced in every book.
 *  #5  The treasury ledger pagination (countFor + paged list) and
 *      the FULL export statement (every row of the period).
 */
import {freshApp, load} from './helpers/app';

const NO_PRINT = {
  print: false,
  receiptSettings: {
    storeName: 'متجر الاختبار',
    footerText: '',
    width: 58,
    showLogo: false,
    logoPath: null,
  } as never,
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

async function seedProduct(
  name: string,
  retail: number,
  cost: number,
  stock: number,
) {
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

async function stockOf(productId: number): Promise<number> {
  const {ProductRepo} = load('src/database/repositories/ProductRepo');
  const product = await ProductRepo.getById(productId);
  return Number(product?.stock_quantity ?? 0);
}

async function seedLocalCustomer() {
  const {LocalDebtsRepo} = load('src/database/repositories/LocalDebtsRepo');
  return LocalDebtsRepo.createCustomer({
    name: 'أبو محمد',
    idNumber: '400999888',
    phone: '0599888777',
    notes: null,
  });
}

describe('v26 #2 — FULL return of a LOCAL debt invoice', () => {
  test('returning EVERYTHING zeroes the debt row (deleted, no CHECK error)', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {InvoiceService} = load('src/services/InvoiceService');
    const {LocalDebtsRepo} = load('src/database/repositories/LocalDebtsRepo');

    const customer = await seedLocalCustomer();
    const milk = await seedProduct('حليب', 6, 4, 50);

    const sale = await InvoiceService.completeSale({
      lines: [line(milk, 5)],
      discount: 0,
      paymentType: 'RETAIL',
      localDebt: {
        localCustomerId: customer.id,
        customerName: 'أبو محمد',
        customerPhoneLast4: '7777',
      },
      ...NO_PRINT,
    } as never);
    expect(sale.sale.invoice_number).toMatch(/^INV-L-/);
    expect(await stockOf(milk.id)).toBe(45);

    // THE regression: return ALL 5 items — this used to die with the
    // SQL CHECK constraint (amount_minor = 0 forbidden).
    const prep = await InvoiceService.prepareReturn(sale.sale.id);
    const ret = await InvoiceService.createReturn({
      saleId: sale.sale.id,
      lines: prep.lines.map(l => ({
        saleItemId: l.item.id,
        productId: l.item.product_id,
        productName: l.productName,
        quantity: l.remaining,
        unitName: l.item.unit_name,
        basePerUnit: 1,
        unitPrice: l.item.unit_price,
        costPrice: l.item.cost_price,
      })),
      refundMethod: 'none',
      ...NO_PRINT,
    } as never);

    expect(ret.refund_minor).toBe(3000);
    expect(ret.debt_adjusted_minor).toBe(3000);
    expect(await stockOf(milk.id)).toBe(50);

    // The debt row is GONE — the customer owes nothing.
    expect(
      await LocalDebtsRepo.debtRowByRef(sale.sale.invoice_number),
    ).toBeNull();
    const outstanding = await LocalDebtsRepo.outstandingFor(customer.id);
    expect(Number(outstanding)).toBe(0);
    const totals = await LocalDebtsRepo.totals();
    expect(totals.debtorsCount).toBe(0);

    // A second return attempt is refused cleanly.
    await expect(
      InvoiceService.prepareReturn(sale.sale.id),
    ).rejects.toThrow('أُرجعت كل أصناف');
  });

  test('partial return then the REST — the last slice deletes the row too', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {InvoiceService} = load('src/services/InvoiceService');
    const {LocalDebtsRepo} = load('src/database/repositories/LocalDebtsRepo');

    const customer = await seedLocalCustomer();
    const cola = await seedProduct('كولا', 10, 6, 100);

    const sale = await InvoiceService.completeSale({
      lines: [line(cola, 4)],
      discount: 0,
      paymentType: 'RETAIL',
      localDebt: {
        localCustomerId: customer.id,
        customerName: 'أبو محمد',
        customerPhoneLast4: '7777',
      },
      ...NO_PRINT,
    } as never);

    // First slice: 1 of 4 → 3000 remains.
    let prep = await InvoiceService.prepareReturn(sale.sale.id);
    await InvoiceService.createReturn({
      saleId: sale.sale.id,
      lines: [
        {
          saleItemId: prep.lines[0].item.id,
          productId: cola.id,
          productName: 'كولا',
          quantity: 1,
          unitName: 'قطعة',
          basePerUnit: 1,
          unitPrice: 10,
          costPrice: 6,
        },
      ],
      refundMethod: 'none',
      ...NO_PRINT,
    } as never);
    let debt = await LocalDebtsRepo.debtRowByRef(sale.sale.invoice_number);
    expect(Number(debt?.amountMinor)).toBe(3000);

    // The rest (3) — zeroes → deleted, no SQL error.
    prep = await InvoiceService.prepareReturn(sale.sale.id);
    const ret2 = await InvoiceService.createReturn({
      saleId: sale.sale.id,
      lines: [
        {
          saleItemId: prep.lines[0].item.id,
          productId: cola.id,
          productName: 'كولا',
          quantity: 3,
          unitName: 'قطعة',
          basePerUnit: 1,
          unitPrice: 10,
          costPrice: 6,
        },
      ],
      refundMethod: 'none',
      ...NO_PRINT,
    } as never);
    expect(ret2.debt_adjusted_minor).toBe(3000);
    expect(
      await LocalDebtsRepo.debtRowByRef(sale.sale.invoice_number),
    ).toBeNull();
    expect(await stockOf(cola.id)).toBe(100);
  });

  test('the treasury equation stays balanced after the full return', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {InvoiceService} = load('src/services/InvoiceService');
    const {ReportService} = load('src/services/ReportService');

    const customer = await seedLocalCustomer();
    const bread = await seedProduct('خبز', 5, 2, 40);

    // A cash sale first so the drawer has money (20₪).
    await InvoiceService.completeSale({
      lines: [line(bread, 4)],
      discount: 0,
      paymentType: 'RETAIL',
      ...NO_PRINT,
    } as never);
    const before = await ReportService.treasurySnapshot();
    expect(before.cashTotal).toBeCloseTo(20, 5);

    // A local debt sale (15₪) fully returned — goods back, no cash moved.
    const debtSale = await InvoiceService.completeSale({
      lines: [line(bread, 3)],
      discount: 0,
      paymentType: 'RETAIL',
      localDebt: {
        localCustomerId: customer.id,
        customerName: 'أبو محمد',
        customerPhoneLast4: '7777',
      },
      ...NO_PRINT,
    } as never);
    const mid = await ReportService.treasurySnapshot();
    expect(mid.cashTotal).toBeCloseTo(20, 5); // debt sale moved no cash

    const prep = await InvoiceService.prepareReturn(debtSale.sale.id);
    await InvoiceService.createReturn({
      saleId: debtSale.sale.id,
      lines: prep.lines.map(l => ({
        saleItemId: l.item.id,
        productId: l.item.product_id,
        productName: l.productName,
        quantity: l.remaining,
        unitName: l.item.unit_name,
        basePerUnit: 1,
        unitPrice: l.item.unit_price,
        costPrice: l.item.cost_price,
      })),
      refundMethod: 'none',
      ...NO_PRINT,
    } as never);

    const after = await ReportService.treasurySnapshot();
    expect(after.cashTotal).toBeCloseTo(20, 5); // still 20 — balanced
    expect(after.revenueAllTime).toBeCloseTo(20, 5); // 20 + 15 − 15
  });
});

describe('v26 #3 — pending return reversals net the LIVE standing debt', () => {
  test('a synced-debt return drops silaOutstandingMinor immediately', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {InvoiceService} = load('src/services/InvoiceService');
    const {SilaRepo} = load('src/services/sila/SilaRepo');
    const {ReportService} = load('src/services/ReportService');

    const tuna = await seedProduct('تونة', 12, 8, 100);
    const sale = await InvoiceService.completeSale({
      lines: [line(tuna, 4)],
      discount: 0,
      paymentType: 'RETAIL',
      debt: {
        customerId: 'cus-26',
        customerName: 'سليم',
        customerPhoneLast4: '2626',
        customerCard: null,
        offlineQr: null,
        amountMinor: 4800,
      },
      ...NO_PRINT,
    } as never);

    // Simulate a synced server row with a cached outstanding snapshot.
    const debtRow = await SilaRepo.byInvoiceRef(sale.sale.invoice_number);
    await SilaRepo.markSynced(debtRow!.local_id, {
      referenceCode: 'POS-26',
      transactionId: 'txn-26',
      outstandingAfter: 4800,
    });
    // Mirror the server truth in the customers cache (the source the
    // outstanding snapshot reads).
    await SilaRepo.upsertCustomers([
      {
        customerId: 'cus-26',
        name: 'سليم',
        phoneLast4: '2626',
        outstandingMinor: 4800,
        posOutstandingMinor: 4800,
        appOutstandingMinor: 0,
        otherMinor: 0,
        creditMinor: 0,
        lastPaymentAt: null,
        lastPaymentAmountMinor: null,
      },
    ]);

    const before = await ReportService.loadBundle('all');
    expect(before.cash.silaOutstandingMinor).toBe(4800);

    // Return one tuna (12₪) — the reversal is enqueued PENDING.
    const prep = await InvoiceService.prepareReturn(sale.sale.id);
    await InvoiceService.createReturn({
      saleId: sale.sale.id,
      lines: [
        {
          saleItemId: prep.lines[0].item.id,
          productId: tuna.id,
          productName: 'تونة',
          quantity: 1,
          unitName: 'قطعة',
          basePerUnit: 1,
          unitPrice: 12,
          costPrice: 8,
        },
      ],
      refundMethod: 'none',
      ...NO_PRINT,
    } as never);

    // The LIVE standing debt dropped the moment the receipt was
    // issued — not after the next sync cycle.
    expect(await SilaRepo.pendingReversalsMinor()).toBe(1200);
    const after = await ReportService.loadBundle('all');
    expect(after.cash.silaOutstandingMinor).toBe(3600);

    // The reversal NEVER counts as collected cash.
    const afterPayments = await SilaRepo.paymentsTotals();
    expect(Number(afterPayments.allMinor)).toBe(0);
  });
});

describe('v26 #5 — the treasury ledger pagination', () => {
  test('countFor + paged list + the FULL export statement', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {CashRepo} = load('src/database/repositories/CashRepo');
    const {CashService} = load('src/services/CashService');
    const {localToday} = load('src/core/format');
    const today = localToday();

    // Seed 25 expenses + 10 deposits.
    for (let i = 0; i < 25; i += 1) {
      await CashRepo.add({
        kind: 'expense',
        category: 'كهرباء',
        note: null,
        amountMinor: 100 + i,
        authMethod: 'none',
      });
    }
    // Deposits need drawer cash — the treasury snapshot allows them
    // only within the drawer's balance, so call the REPO directly.
    for (let i = 0; i < 10; i += 1) {
      await CashRepo.add({
        kind: 'deposit',
        note: null,
        amountMinor: 500,
        authMethod: 'none',
      });
    }

    expect(await CashRepo.countFor(today, today, 'all')).toBe(35);
    expect(await CashRepo.countFor(today, today, 'expense')).toBe(25);
    expect(await CashRepo.countFor(today, today, 'deposit')).toBe(10);
    expect(await CashRepo.countFor('2000-01-01', today, 'all')).toBe(35);

    // Page 1 (20 rows, newest first) + page 2 (15 more) — no overlap.
    const page1 = await CashRepo.list({
      from: today,
      to: today,
      kind: 'all',
      limit: 20,
      offset: 0,
    });
    const page2 = await CashRepo.list({
      from: today,
      to: today,
      kind: 'all',
      limit: 20,
      offset: 20,
    });
    expect(page1).toHaveLength(20);
    expect(page2).toHaveLength(15);
    const ids = new Set([...page1, ...page2].map(r => r.local_id));
    expect(ids.size).toBe(35);

    // The FULL statement carries EVERY row (the archival PDF path).
    const statement = await CashService.statement(today, today, {full: true});
    expect(statement.rows).toHaveLength(35);
    expect(statement.totals.expensesCount).toBe(25);
    expect(statement.totals.depositsCount).toBe(10);

    // The default (screen) statement stays capped at its page budget.
    const capped = await CashService.statement(today, today);
    expect(capped.rows.length).toBeLessThanOrEqual(500);
    expect(capped.rows.length).toBe(35);
  });
});
