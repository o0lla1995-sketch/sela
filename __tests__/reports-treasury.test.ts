/**
 * REPORTS + TREASURY — the accounting invariants the merchant audits:
 *
 *  • cash sale + full cash return  → drawer nets back to zero
 *  • cash sale + partial return    → drawer = sale − refund
 *  • sila debt sale + full return  → drawer untouched (no cash ever)
 *  • synced sila debt + return     → the reversal NEVER counts as
 *                                    collected cash
 *  • local debt + return           → the local book shrinks
 *  • campaign activation           → due enters الدين القائم in the
 *                                    period bundle AND the treasury
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

async function seedProduct(name: string, retail: number, stock: number) {
  const {ProductRepo} = load('src/database/repositories/ProductRepo');
  const id = await ProductRepo.create({
    name,
    cost_price: retail * 0.5,
    retail_price: retail,
    wholesale_price: retail,
    stock_quantity: stock,
    category_id: null,
    image_uri: null,
  });
  return {id, name, retail, cost: retail * 0.5};
}

async function returnAll(saleId: number, unitPrice: number, cost: number) {
  const {InvoiceService} = load('src/services/InvoiceService');
  const prep = await InvoiceService.prepareReturn(saleId);
  return InvoiceService.createReturn({
    saleId,
    lines: prep.lines.map(l => ({
      saleItemId: l.item.id,
      productId: l.item.product_id,
      productName: l.productName,
      quantity: l.remaining,
      unitName: l.item.unit_name,
      basePerUnit: 1,
      unitPrice,
      costPrice: cost,
    })),
    refundMethod: 'cash',
    ...NO_PRINT,
  } as never);
}

describe('treasury invariants with returns', () => {
  test('cash sale + FULL cash return → the drawer nets back to zero', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {InvoiceService} = load('src/services/InvoiceService');
    const {ReportService} = load('src/services/ReportService');

    const cola = await seedProduct('كولا', 10, 100);
    const sale = await InvoiceService.completeSale({
      lines: [line(cola, 3)],
      discount: 0,
      paymentType: 'RETAIL',
      ...NO_PRINT,
    } as never);

    let treasury = await ReportService.treasurySnapshot();
    expect(treasury.revenueAllTime).toBeCloseTo(30, 5);
    expect(treasury.creditSalesAllTime).toBeCloseTo(0, 5);
    expect(treasury.cashTotal).toBeCloseTo(30, 5); // 30 in the drawer

    await returnAll(sale.sale.id, 10, 5);

    treasury = await ReportService.treasurySnapshot();
    expect(treasury.revenueAllTime).toBeCloseTo(0, 5); // 30 − 30
    expect(treasury.cashTotal).toBeCloseTo(0, 5); // refunded at the counter
  });

  test('cash sale + PARTIAL return → drawer = sale − refund', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {InvoiceService} = load('src/services/InvoiceService');
    const {ReportService} = load('src/services/ReportService');

    const cola = await seedProduct('كولا', 10, 100);
    await InvoiceService.completeSale({
      lines: [line(cola, 4)],
      discount: 0,
      paymentType: 'RETAIL',
      ...NO_PRINT,
    } as never);

    const sale2 = await InvoiceService.completeSale({
      lines: [line(cola, 2)],
      discount: 0,
      paymentType: 'RETAIL',
      ...NO_PRINT,
    } as never);

    // Return 1 item from the SECOND invoice (10₪ back).
    const {InvoiceService: IS} = load('src/services/InvoiceService');
    const prep = await IS.prepareReturn(sale2.sale.id);
    await IS.createReturn({
      saleId: sale2.sale.id,
      lines: [
        {
          saleItemId: prep.lines[0].item.id,
          productId: cola.id,
          productName: 'كولا',
          quantity: 1,
          unitName: 'قطعة',
          basePerUnit: 1,
          unitPrice: 10,
          costPrice: 5,
        },
      ],
      refundMethod: 'cash',
      ...NO_PRINT,
    } as never);

    const treasury = await ReportService.treasurySnapshot();
    expect(treasury.revenueAllTime).toBeCloseTo(50, 5); // 40 + 20 − 10
    expect(treasury.cashTotal).toBeCloseTo(50, 5);
  });

  test('sila debt sale + FULL return → the drawer never moves', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {InvoiceService} = load('src/services/InvoiceService');
    const {ReportService} = load('src/services/ReportService');

    const tuna = await seedProduct('تونة', 12, 100);
    const sale = await InvoiceService.completeSale({
      lines: [line(tuna, 5)],
      discount: 0,
      paymentType: 'RETAIL',
      debt: {
        customerId: 'cus-r1',
        customerName: 'رامي',
        customerPhoneLast4: '1111',
        customerCard: null,
        offlineQr: null,
        amountMinor: 6000,
      },
      ...NO_PRINT,
    } as never);

    let treasury = await ReportService.treasurySnapshot();
    expect(treasury.revenueAllTime).toBeCloseTo(60, 5);
    expect(treasury.creditSalesAllTime).toBeCloseTo(60, 5); // debt — no cash
    expect(treasury.cashTotal).toBeCloseTo(0, 5);

    await returnAll(sale.sale.id, 12, 6);

    treasury = await ReportService.treasurySnapshot();
    expect(treasury.revenueAllTime).toBeCloseTo(0, 5);
    expect(treasury.creditSalesAllTime).toBeCloseTo(0, 5); // queue row deleted
    expect(treasury.cashTotal).toBeCloseTo(0, 5);
  });

  test('synced sila debt + partial return → the reversal is not collected cash', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {InvoiceService} = load('src/services/InvoiceService');
    const {ReportService} = load('src/services/ReportService');
    const {SilaRepo} = load('src/services/sila/SilaRepo');

    const tuna = await seedProduct('تونة', 12, 100);
    const sale = await InvoiceService.completeSale({
      lines: [line(tuna, 4)],
      discount: 0,
      paymentType: 'RETAIL',
      debt: {
        customerId: 'cus-r2',
        customerName: 'سامر',
        customerPhoneLast4: '2222',
        customerCard: null,
        offlineQr: null,
        amountMinor: 4800,
      },
      ...NO_PRINT,
    } as never);

    const debtRow = await SilaRepo.byInvoiceRef(sale.sale.invoice_number);
    await SilaRepo.markSynced(debtRow!.local_id, {
      referenceCode: 'POS-9',
      transactionId: 'txn-9',
      outstandingAfter: 4800,
    });

    // Return 2 items (24₪) — reversal enqueued.
    const {InvoiceService: IS} = load('src/services/InvoiceService');
    const prep = await IS.prepareReturn(sale.sale.id);
    await IS.createReturn({
      saleId: sale.sale.id,
      lines: [
        {
          saleItemId: prep.lines[0].item.id,
          productId: tuna.id,
          productName: 'تونة',
          quantity: 2,
          unitName: 'قطعة',
          basePerUnit: 1,
          unitPrice: 12,
          costPrice: 6,
        },
      ],
      refundMethod: 'none',
      ...NO_PRINT,
    } as never);

    const treasury = await ReportService.treasurySnapshot();
    // Revenue nets 48 − 24 = 24 …
    expect(treasury.revenueAllTime).toBeCloseTo(24, 5);
    // …credit sales keep the FULL synced amount (4800) but the
    // reversal total (2400) subtracts — net 24₪ of real standing debt…
    expect(treasury.creditSalesAllTime).toBeCloseTo(24, 5);
    // …and the drawer NEVER saw any of this money.
    expect(treasury.cashTotal).toBeCloseTo(0, 5);
  });

  test('local debt + return → the local book shrinks, drawer untouched', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {InvoiceService} = load('src/services/InvoiceService');
    const {ReportService} = load('src/services/ReportService');
    const {LocalDebtsRepo} = load('src/database/repositories/LocalDebtsRepo');

    const customer = await LocalDebtsRepo.createCustomer({
      name: 'وسيم',
      idNumber: '400999888',
      phone: '0598887777',
      notes: null,
    });
    const milk = await seedProduct('حليب', 6, 100);
    const sale = await InvoiceService.completeSale({
      lines: [line(milk, 5)],
      discount: 0,
      paymentType: 'RETAIL',
      localDebt: {
        localCustomerId: customer.id,
        customerName: 'وسيم',
        customerPhoneLast4: '7777',
      },
      ...NO_PRINT,
    } as never);

    let treasury = await ReportService.treasurySnapshot();
    expect(treasury.cashTotal).toBeCloseTo(0, 5);
    expect(treasury.creditSalesAllTime).toBeCloseTo(30, 5);

    // A 12₪ repayment enters the drawer…
    await LocalDebtsRepo.addPayment({
      localCustomerId: customer.id,
      amountMinor: 1200,
      method: 'cash',
      note: null,
    });
    treasury = await ReportService.treasurySnapshot();
    expect(treasury.cashTotal).toBeCloseTo(12, 5);

    // …then a 2-item return (12₪) shrinks the debt, not the drawer.
    const {InvoiceService: IS} = load('src/services/InvoiceService');
    const prep = await IS.prepareReturn(sale.sale.id);
    await IS.createReturn({
      saleId: sale.sale.id,
      lines: [
        {
          saleItemId: prep.lines[0].item.id,
          productId: milk.id,
          productName: 'حليب',
          quantity: 2,
          unitName: 'قطعة',
          basePerUnit: 1,
          unitPrice: 6,
          costPrice: 3,
        },
      ],
      refundMethod: 'none',
      ...NO_PRINT,
    } as never);

    treasury = await ReportService.treasurySnapshot();
    expect(treasury.cashTotal).toBeCloseTo(12, 5); // unchanged
    const outstanding = await LocalDebtsRepo.outstandingFor(customer.id);
    // 30₪ debt − 12₪ paid at the counter − 12₪ of returned goods = 6₪.
    expect(Number(outstanding)).toBe(600);
  });
});

describe('campaign dues in the period bundle', () => {
  test('activation puts due into الدين القائم (bundle + treasury)', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {ReportService} = load('src/services/ReportService');
    const {VouchersRepo} = load('src/services/sila/VouchersRepo');

    await VouchersRepo.upsertCampaignFromFeed({
      campaign_id: 'cmp-win',
      campaign_name: 'حملة الشتاء',
      kind: 'voucher',
      campaign_status: 'active',
      merchant_status: 'active',
      starts_at: null,
      ends_at: null,
      redeemed_count: 2,
      redeemed_value_minor: 7000,
      settled_minor: 2500,
      settled_pending_minor: 500,
      settled_confirmed_minor: 2000,
      due_minor: 4500,
      settlement_state: 'partial',
      last_redemption_at: null,
      last_settlement_at: null,
      settlements: [],
    } as never);
    await VouchersRepo.activateCampaign('cmp-win');

    const bundle = await ReportService.loadBundle('today');
    expect(bundle.cash.campaignDueMinor).toBe(4500);

    const treasury = await ReportService.treasurySnapshot();
    expect(treasury.campaignDueAllTime).toBeCloseTo(45, 5);
    expect(treasury.campaignSettlementsAllTime).toBeCloseTo(25, 5);
  });
});
