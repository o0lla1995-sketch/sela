/**
 * v25 (round-32) — نظام المصروفات والسحب من الخزينة + تصنيف
 * الحملات من العنوان + باركود الفواتير.
 * ─────────────────────────────────────────────────────────────────
 * The tested rules:
 *
 *  1. campaignKind — the merchant's naming convention decides:
 *     «قسيمة شرائية _ X» → voucher, «طرد X» → parcel, the server's
 *     kind field only as fallback (never cross).
 *  2. activeCampaignsCount — parcel campaigns NEVER drive the POS
 *     cart's قسيمة button; purchase ones do.
 *  3. The cash-movements ledger:
 *     • numbering EXP-/WD-/DEP- per kind per day, sequential,
 *       monotonic across restarts (MMKV counter + DB max)
 *     • rows immutable — the repo exposes no update/delete
 *     • totalsFor / categoryTotals aggregate correctly per period
 *  4. treasurySnapshot: expenses + withdrawals LEAVE the expected
 *     drawer cash; deposits return (the Loyverse expected-cash
 *     discipline) — the equation balances in every combination.
 *  5. The receipt barcode: every receipt job carries a CODE128 op
 *     with the invoice number (scan-to-open contract).
 */
import {freshApp, load} from './helpers/app';

const SHEKELS = (minor: number) => minor / 100;

/** Boots a fresh registry AND initializes the schema (the app's
 *  real boot path — migrations included). */
async function bootDb() {
  const app = freshApp();
  await app.connection.initDatabase();
  return app;
}

describe('v25 — campaignKind: the title decides', () => {
  beforeEach(() => {
    freshApp();
  });

  test('«قسيمة شرائية _ اسم» is a PURCHASE campaign', () => {
    const {classifyCampaignKind} = load('src/services/sila/campaignKind');
    expect(classifyCampaignKind('voucher', 'قسيمة شرائية _ أهل الخير')).toBe(
      'voucher',
    );
  });

  test('«طرد …» is a PARCEL campaign — even if the server kind says voucher', () => {
    const {classifyCampaignKind} = load('src/services/sila/campaignKind');
    // The institution titled it طرد — the merchant's round-32 rule.
    expect(classifyCampaignKind('voucher', 'طرد رمضان 2026')).toBe('parcel');
    expect(classifyCampaignKind(null, 'طرد بدون سلة')).toBe('parcel');
  });

  test('«قسيمة …» in the title beats a parcel kind field', () => {
    const {classifyCampaignKind} = load('src/services/sila/campaignKind');
    expect(classifyCampaignKind('parcel', 'قسيمة مؤسسة سند')).toBe('voucher');
  });

  test('no title → the server kind decides; nothing → voucher default', () => {
    const {classifyCampaignKind} = load('src/services/sila/campaignKind');
    expect(classifyCampaignKind('parcel', null)).toBe('parcel');
    expect(classifyCampaignKind('parcel', '')).toBe('parcel');
    expect(classifyCampaignKind('', '')).toBe('voucher');
    expect(classifyCampaignKind(null, null)).toBe('voucher');
  });

  test('a title that says neither keeps the server kind', () => {
    const {classifyCampaignKind} = load('src/services/sila/campaignKind');
    expect(classifyCampaignKind('voucher', 'حملة مدرسية')).toBe('voucher');
    expect(classifyCampaignKind('parcel', 'حملة مدرسية')).toBe('parcel');
  });
});

describe('v25 — activeCampaignsCount: parcels never drive the cart button', () => {
  beforeEach(async () => {
    await bootDb();
  });

  async function addCampaign(
    id: string,
    name: string,
    kind: 'voucher' | 'parcel',
    storeState: 'available' | 'active' | 'completed' = 'active',
  ) {
    const {VouchersRepo} = load('src/services/sila/VouchersRepo');
    const db = load('src/database/connection').getDb();
    await db.execute(
      `INSERT INTO campaign_debts (
        campaign_id, campaign_name, kind, campaign_status, merchant_status,
        redeemed_count, redeemed_value_minor, due_minor, settlement_state
      ) VALUES (?, ?, ?, 'active', 'ok', 0, 0, 0, 'none')`,
      [id, name, kind],
    );
    if (storeState !== 'available') {
      await db.execute(
        `UPDATE campaign_debts SET store_state = ? WHERE campaign_id = ?`,
        [storeState, id],
      );
    }
  }

  test('a titled purchase campaign counts, a titled parcel does not', async () => {
    await addCampaign('c1', 'قسيمة شرائية _ مؤسسة خير', 'voucher');
    await addCampaign('c2', 'طرد شتوي', 'voucher'); // titled parcel!
    const {VouchersRepo} = load('src/services/sila/VouchersRepo');
    await expect(VouchersRepo.activeCampaignsCount()).resolves.toBe(1);
  });

  test('available / completed campaigns never count', async () => {
    await addCampaign('c1', 'قسيمة شرائية _ خير', 'voucher', 'available');
    await addCampaign('c2', 'قسيمة شرائية _ خير2', 'voucher', 'completed');
    const {VouchersRepo} = load('src/services/sila/VouchersRepo');
    await expect(VouchersRepo.activeCampaignsCount()).resolves.toBe(0);
  });
});

describe('v25 — the cash-movements ledger', () => {
  beforeEach(async () => {
    await bootDb();
  });

  test('numbering: per-kind per-day sequential refs', async () => {
    const {CashRepo} = load('src/database/repositories/CashRepo');
    const e1 = await CashRepo.add({
      kind: 'expense',
      category: 'كهرباء',
      amountMinor: 4000,
    });
    const e2 = await CashRepo.add({
      kind: 'expense',
      category: 'إيجار',
      amountMinor: 120000,
    });
    const w1 = await CashRepo.add({
      kind: 'withdrawal',
      amountMinor: 50000,
      authMethod: 'fingerprint',
    });
    const d1 = await CashRepo.add({kind: 'deposit', amountMinor: 20000});
    expect(e1.ref).toMatch(/^EXP-\d{8}-0001$/);
    expect(e2.ref).toMatch(/^EXP-\d{8}-0002$/);
    expect(w1.ref).toMatch(/^WD-\d{8}-0001$/);
    expect(d1.ref).toMatch(/^DEP-\d{8}-0001$/);
    expect(e1.auth_method).toBe('none');
    expect(w1.auth_method).toBe('fingerprint');
    expect(w1.category).toBe('سحب رصيد');
  });

  test('invalid amounts are rejected', async () => {
    const {CashRepo} = load('src/database/repositories/CashRepo');
    await expect(
      CashRepo.add({kind: 'expense', category: 'x', amountMinor: 0}),
    ).rejects.toThrow();
    await expect(
      CashRepo.add({kind: 'expense', category: 'x', amountMinor: -5}),
    ).rejects.toThrow();
    await expect(
      CashRepo.add({kind: 'deposit', category: 'x', amountMinor: NaN}),
    ).rejects.toThrow();
  });

  test('totalsFor + categoryTotals aggregate per period', async () => {
    const {CashRepo} = load('src/database/repositories/CashRepo');
    await CashRepo.add({kind: 'expense', category: 'كهرباء', amountMinor: 4000});
    await CashRepo.add({kind: 'expense', category: 'كهرباء', amountMinor: 2000});
    await CashRepo.add({kind: 'withdrawal', category: 'سحب رصيد', amountMinor: 10000});
    await CashRepo.add({kind: 'deposit', category: 'إيداع نقدي', amountMinor: 30000});
    const today = load('src/core/format').localToday();
    const totals = await CashRepo.totalsFor(today, today);
    expect(totals.expensesMinor).toBe(6000);
    expect(totals.expensesCount).toBe(2);
    expect(totals.withdrawalsMinor).toBe(10000);
    expect(totals.depositsMinor).toBe(30000);
    expect(totals.netMinor).toBe(30000 - 6000 - 10000);
    const cats = await CashRepo.categoryTotals(today, today);
    const power = cats.find(cat => cat.category === 'كهرباء');
    expect(power?.totalMinor).toBe(6000);
    expect(power?.count).toBe(2);
    // Deposits never appear in the category breakdown.
    expect(cats.find(cat => cat.category === 'إيداع نقدي')).toBeUndefined();
  });

  test('the repo exposes NO update/delete APIs (immutable audit trail)', () => {
    const {CashRepo} = load('src/database/repositories/CashRepo');
    const methods = Object.keys(CashRepo);
    expect(methods).toEqual(
      expect.arrayContaining(['add', 'list', 'totalsFor', 'allTimeTotals']),
    );
    // No mutation path besides add().
    for (const name of methods) {
      expect(name).not.toMatch(/^(update|delete|remove|edit|erase)/i);
    }
  });
});

describe('v25 — treasurySnapshot: expenses/withdrawals leave the drawer', () => {
  beforeEach(async () => {
    await bootDb();
  });

  /** Creates one cash sale of `amountMinor` so the drawer has cash. */
  async function seedCashSale(amountMinor: number): Promise<void> {
    const {SaleRepo} = load('src/database/repositories/SaleRepo');
    const db = load('src/database/connection').getDb();
    const saleInsert = await db.execute(
      `INSERT INTO sales (invoice_number, total_amount, total_cost, total_profit, discount, payment_type, created_at)
       VALUES (?, ?, 0, ?, 0, 'RETAIL', datetime('now'))`,
      [`INV-TEST-${amountMinor}`, SHEKELS(amountMinor), SHEKELS(amountMinor)],
    );
    expect(saleInsert.insertId).toBeGreaterThan(0);
    void SaleRepo;
  }

  test('an expense reduces the expected drawer cash 1:1', async () => {
    await seedCashSale(100000); // 1000.00 ₪ in the drawer.
    const {ReportService} = load('src/services/ReportService');
    const before = await ReportService.treasurySnapshot();
    const {CashRepo} = load('src/database/repositories/CashRepo');
    await CashRepo.add({kind: 'expense', category: 'كهرباء', amountMinor: 15000});
    const after = await ReportService.treasurySnapshot();
    // cashTotal is ALREADY in shekels (15000 minor = 150 ₪).
    expect(after.cashTotal).toBeCloseTo(before.cashTotal - 150, 2);
    expect(after.expensesAllTime).toBeCloseTo(150, 2);
  });

  test('a withdrawal reduces, a deposit returns — the net balances', async () => {
    await seedCashSale(200000);
    const {ReportService} = load('src/services/ReportService');
    const {CashRepo} = load('src/database/repositories/CashRepo');
    const before = await ReportService.treasurySnapshot();
    await CashRepo.add({
      kind: 'withdrawal',
      amountMinor: 50000,
      authMethod: 'pin',
    });
    const afterWithdrawal = await ReportService.treasurySnapshot();
    expect(afterWithdrawal.cashTotal).toBeCloseTo(before.cashTotal - 500, 2);
    await CashRepo.add({kind: 'deposit', amountMinor: 20000});
    const afterDeposit = await ReportService.treasurySnapshot();
    expect(afterDeposit.cashTotal).toBeCloseTo(
      before.cashTotal - 500 + 200,
      2,
    );
    expect(afterDeposit.withdrawalsAllTime).toBeCloseTo(500, 2);
    expect(afterDeposit.depositsAllTime).toBeCloseTo(200, 2);
  });

  test('CashService.recordExpense refuses to exceed the drawer', async () => {
    await seedCashSale(50000); // 500 ₪.
    const {CashService} = load('src/services/CashService');
    await expect(
      CashService.recordExpense({category: 'كهرباء', amountMinor: 60000}),
    ).rejects.toThrow(/أكبر من النقد الموجود/);
    // A within-drawer expense passes.
    const movement = await CashService.recordExpense({
      category: 'كهرباء',
      amountMinor: 45000,
    });
    expect(movement.ref).toMatch(/^EXP-/);
  });

  test('CashService.recordWithdrawal enforces the same hard ceiling', async () => {
    await seedCashSale(30000); // 300 ₪.
    const {CashService} = load('src/services/CashService');
    await expect(
      CashService.recordWithdrawal({
        amountMinor: 31000,
        authMethod: 'none',
      }),
    ).rejects.toThrow(/أكثر من النقد الموجود/);
    const movement = await CashService.recordWithdrawal({
      amountMinor: 30000,
      authMethod: 'fingerprint',
    });
    expect(movement.auth_method).toBe('fingerprint');
    // The drawer is now exactly zero.
    const {ReportService} = load('src/services/ReportService');
    const treasury = await ReportService.treasurySnapshot();
    expect(treasury.cashTotal).toBeCloseTo(0, 2);
  });
});

describe('v25 — the scan-to-open receipt barcode', () => {
  beforeEach(() => {
    freshApp(); // Pure builder test — no DB needed for the job itself.
  });

  test('the cash receipt job carries a CODE128 op with the invoice number', () => {
    const {buildReceiptJob} = load('src/services/printer/receipt');
    const job = buildReceiptJob(
      {
        sale: {
          id: 1,
          invoice_number: 'INV-20261007-0001',
          total_amount: 45,
          total_cost: 30,
          total_profit: 15,
          discount: 0,
          payment_type: 'RETAIL',
          created_at: '2026-10-07 10:00:00',
          return_kind: null,
          returned_minor: 0,
        },
        items: [],
        productNameById: new Map(),
      } as never,
      {
        storeName: 'متجر',
        storePhone: '',
        footerMessage: '',
        paperWidth: '80',
        codepage: 1256,
        showProfit: false,
      },
    );
    const barcodeOp = job.find(
      op => typeof op === 'object' && op !== null && (op as {op?: string}).op === 'barcode',
    ) as {op?: string; system?: string; value?: string} | undefined;
    expect(barcodeOp).toBeDefined();
    expect(barcodeOp?.system).toBe('CODE128');
    expect(barcodeOp?.value).toBe('INV-20261007-0001');
  });

  test('byInvoiceNumber finds the exact invoice (and RET rows too)', async () => {
    await bootDb();
    const {SaleRepo} = load('src/database/repositories/SaleRepo');
    const db = load('src/database/connection').getDb();
    await db.execute(
      `INSERT INTO sales (invoice_number, total_amount, total_cost, total_profit, discount, payment_type, created_at)
       VALUES ('INV-20261007-0042', 50, 30, 20, 0, 'RETAIL', datetime('now'))`,
    );
    await db.execute(
      `INSERT INTO sales (invoice_number, total_amount, total_cost, total_profit, discount, payment_type, created_at, return_kind)
       VALUES ('RET-20261007-0001', -20, -10, -10, 0, 'RETAIL', datetime('now'), 'cash')`,
    );
    const hit = await SaleRepo.byInvoiceNumber('INV-20261007-0042');
    expect(hit?.invoice_number).toBe('INV-20261007-0042');
    const ret = await SaleRepo.byInvoiceNumber('RET-20261007-0001');
    expect(ret?.invoice_number).toBe('RET-20261007-0001');
    // No partial matches, no empty codes.
    expect(await SaleRepo.byInvoiceNumber('INV-20261007')).toBeNull();
    expect(await SaleRepo.byInvoiceNumber('   ')).toBeNull();
  });
});
