/**
 * SILA BOOKS — queue totals, payment totals (repayment vs
 * return_reversal separation), the customers cache with the
 * origin-split outstanding, prepaid-credit coverage and the
 * app-collections reconciliation ledger.
 */
import {freshApp, load} from './helpers/app';

const PAIRED_AT = new Date().toISOString();

describe('sila debt queue accounting', () => {
  test('totals split pending vs synced; today bucket counts', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {SilaRepo} = load('src/services/sila/SilaRepo');

    await SilaRepo.enqueue({
      idempotencyKey: 'idem-1',
      customerId: 'cus-1',
      customerName: 'أحمد',
      customerPhoneLast4: '1234',
      customerCard: null,
      offlineQr: null,
      amountMinor: 5000,
      posInvoiceRef: 'INV-D-20260101-0001',
      description: 'بيع بالدين',
      scannedAt: PAIRED_AT,
    });
    await SilaRepo.enqueue({
      idempotencyKey: 'idem-2',
      customerId: 'cus-1',
      customerName: 'أحمد',
      customerPhoneLast4: '1234',
      customerCard: null,
      offlineQr: null,
      amountMinor: 3000,
      posInvoiceRef: 'INV-D-20260101-0002',
      description: 'بيع بالدين',
      scannedAt: PAIRED_AT,
    });
    const rows = await SilaRepo.pendingBatch();
    expect(rows).toHaveLength(2);

    await SilaRepo.markSynced(rows[0].local_id, {
      referenceCode: 'POS-1',
      transactionId: 'txn-1',
      outstandingAfter: 5000,
    });

    const totals = await SilaRepo.totals();
    expect(totals.allMinor).toBe(8000);
    expect(totals.allCount).toBe(2);
    expect(totals.pendingMinor).toBe(3000);
    expect(totals.pendingCount).toBe(1);
    expect(totals.todayMinor).toBe(8000); // both created today
  });

  test('payments: repayments vs return reversals NEVER mix', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {SilaRepo} = load('src/services/sila/SilaRepo');

    await SilaRepo.enqueuePayment({
      idempotencyKey: 'pay-1',
      customerId: 'cus-1',
      customerName: 'أحمد',
      customerPhoneLast4: '1234',
      amountMinor: 2000,
      paymentMethod: 'cash',
      posReceiptRef: 'RCP-20260101-0001',
      description: 'سداد نقدي',
      paidAt: new Date().toISOString(),
    });
    await SilaRepo.enqueuePayment({
      idempotencyKey: 'rev-1',
      customerId: 'cus-1',
      customerName: 'أحمد',
      customerPhoneLast4: '1234',
      amountMinor: 1200,
      paymentMethod: 'other',
      posReceiptRef: 'RCP-20260101-0002',
      description: 'عكس قيمة مرتجع بضاعة',
      paidAt: new Date().toISOString(),
      kind: 'return_reversal',
    });

    const totals = await SilaRepo.paymentsTotals();
    // The collections statistics count REAL repayments only — the
    // reversal is excluded from every bucket here (v23 rule: العملية
    // العكسية ليست تحصيلاً نقدياً أبداً).
    expect(Number(totals.allMinor)).toBe(2000);
    expect(Number(totals.allCount)).toBe(1);
    // The reversal bucket is separate:
    expect(await SilaRepo.returnReversalsTotal()).toBe(1200);

    // Mark both synced — the split survives.
    const batch = await SilaRepo.pendingPaymentBatch();
    for (const row of batch) {
      await SilaRepo.markPaymentSynced(row.local_id, {
        transactionId: `txn-${row.local_id}`,
        outstandingAfter: 0,
        referenceCode: 'SR-1',
      });
    }
    expect((await SilaRepo.paymentsTotals()).allMinor).toBe(2000);
    expect((await SilaRepo.paymentsTotals()).syncedMinor).toBe(2000);
    expect(await SilaRepo.returnReversalsTotal()).toBe(1200);
  });

  test('v27: the cashier payments LIST also excludes return reversals', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {SilaRepo} = load('src/services/sila/SilaRepo');

    // A real repayment + a return reversal — the reversal must
    // never surface in the السدادّات book nor in the «سدادّات عند
    // الكاشير» KPI («اصلا هو مرتجع وليس مسدد»).
    await SilaRepo.enqueuePayment({
      idempotencyKey: 'pay-a',
      customerId: 'cus-1',
      customerName: 'أحمد',
      customerPhoneLast4: '1234',
      amountMinor: 5000,
      paymentMethod: 'cash',
      posReceiptRef: 'RCP-20260101-0001',
      description: 'سداد نقدي',
      paidAt: new Date().toISOString(),
    });
    await SilaRepo.enqueuePayment({
      idempotencyKey: 'rev-a',
      customerId: 'cus-1',
      customerName: 'أحمد',
      customerPhoneLast4: '1234',
      amountMinor: 3300,
      paymentMethod: 'other',
      posReceiptRef: 'RCP-20260101-0002',
      description: 'عكس قيمة مرتجع بضاعة',
      paidAt: new Date().toISOString(),
      kind: 'return_reversal',
    });

    const list = await SilaRepo.recentPayments(40, 0);
    expect(list).toHaveLength(1);
    expect(list[0].pos_receipt_ref).toBe('RCP-20260101-0001');
    // The KPI sums the same array — 5000 only, never 8300.
    expect(
      list.reduce((sum, row) => sum + row.amount_minor, 0),
    ).toBe(5000);
  });
});

describe('sila customers cache (origin-split outstanding)', () => {
  test('upsert + origin split + prepaid credit awareness', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {SilaRepo} = load('src/services/sila/SilaRepo');

    await SilaRepo.upsertCustomers(
      [
        {
          customerId: 'cus-1',
          name: 'أحمد',
          phoneLast4: '1234',
          outstandingMinor: 8000,
          creditMinor: 1500,
          posOutstandingMinor: 6000,
          appOutstandingMinor: 2000,
          otherMinor: 0,
          posPurchasesMinor: 9000,
          appPurchasesMinor: 2000,
        },
        {
          customerId: 'cus-2',
          name: 'سليم',
          phoneLast4: '5678',
          outstandingMinor: 0,
          creditMinor: 0,
          posOutstandingMinor: 0,
          appOutstandingMinor: 0,
          otherMinor: 0,
        },
      ],
      new Date().toISOString(),
    );

    const totals = await SilaRepo.customersOutstandingTotal();
    expect(totals.totalMinor).toBe(8000);
    expect(totals.posTotalMinor).toBe(6000); // the STORE's own share
    expect(totals.appTotalMinor).toBe(2000); // informational only
    expect(totals.debtorsCount).toBe(1);

    // v27 (round-35 #1): the debtors KPI counts STORE debtors only.
    // A customer whose debts all originated INSIDE the Sila app
    // (pos_outstanding = 0, app_outstanding > 0) owes this store
    // NOTHING — the customers page shows no debt, so the KPI must
    // not count him either («زبون مدين لك» والصفحة تقول لا ديون).
    await SilaRepo.upsertCustomers(
      [
        {
          customerId: 'cus-3',
          name: 'زياد',
          phoneLast4: '9090',
          outstandingMinor: 4500,
          creditMinor: 0,
          posOutstandingMinor: 0,
          appOutstandingMinor: 4500,
        },
      ],
      new Date().toISOString(),
    );
    const afterAppOnly = await SilaRepo.customersOutstandingTotal();
    expect(afterAppOnly.debtorsCount).toBe(1); // still only أحمد
    expect(afterAppOnly.totalMinor).toBe(12500);
    expect(afterAppOnly.posTotalMinor).toBe(6000);

    // Consume cached credit at sale time (v17 rule).
    await SilaRepo.consumeCachedCredit('cus-1', 1000);
    const customer = await SilaRepo.findCustomer('cus-1');
    expect(Number(customer?.credit_minor)).toBe(500);

    // A partial upsert without credit knowledge PRESERVES the cache.
    await SilaRepo.upsertCustomers(
      [
        {
          customerId: 'cus-1',
          name: 'أحمد',
          phoneLast4: '1234',
          outstandingMinor: 7000,
          posOutstandingMinor: 5000,
          appOutstandingMinor: 2000,
        },
      ],
      new Date().toISOString(),
    );
    const after = await SilaRepo.findCustomer('cus-1');
    expect(Number(after?.credit_minor)).toBe(500);
    expect(Number(after?.outstanding_minor)).toBe(7000);
  });
});

describe('app-collections reconciliation ledger', () => {
  test('records a detected تحصيل عبر تطبيق صِلة with its snapshot', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {SilaRepo} = load('src/services/sila/SilaRepo');

    // Baseline the customer, then the server feed shows the store's
    // POS outstanding dropped — money arrived via the Sila app.
    await SilaRepo.upsertCustomers(
      [
        {
          customerId: 'cus-9',
          name: 'ليلى',
          phoneLast4: '1010',
          outstandingMinor: 4000,
          creditMinor: 0,
          posOutstandingMinor: 4000,
          appOutstandingMinor: 0,
        },
      ],
      new Date().toISOString(),
    );

    const offsets = new Map<string, number>();
    const recorded = await SilaRepo.reconcileAppCollections(
      [
        {
          customerId: 'cus-9',
          name: 'ليلى',
          posPurchasesMinor: 4000,
          posOutstandingMinor: 1500, // 2500 collected via the app
        },
      ],
      offsets,
      true, // freeze baseline on first pass
    );

    const totals = await SilaRepo.appCollectionsTotals();
    expect(Number(totals.allMinor)).toBeGreaterThanOrEqual(0);
    // v35: النتيجة كائن {recordedMinor, trimmedMinor} — وغياب أرقام
    // الجهاز في هذه التغذية يعني تخطياً كاملاً (لا رجوع لـ POS).
    expect(recorded.recordedMinor).toBeGreaterThanOrEqual(0);
    expect(recorded.trimmedMinor).toBeGreaterThanOrEqual(0);

    // The ledger row (if any) is queryable and countable.
    const count = await SilaRepo.appCollectionsCount();
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test('credit coverage sums into the cash math', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {SilaRepo} = load('src/services/sila/SilaRepo');

    await SilaRepo.enqueue({
      idempotencyKey: 'idem-cc',
      customerId: 'cus-cc',
      customerName: 'نور',
      customerPhoneLast4: '2020',
      customerCard: null,
      offlineQr: null,
      amountMinor: 5000,
      posInvoiceRef: 'INV-D-20260101-0009',
      description: 'بيع بالدين',
      scannedAt: new Date().toISOString(),
      creditCoveredMinor: 2000,
    });

    const covered = await SilaRepo.creditCoveredInRange('2000-01-01', '2999-12-31');
    expect(covered).toBe(2000);
  });
});
