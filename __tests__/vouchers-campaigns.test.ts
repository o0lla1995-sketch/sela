/**
 * VOUCHERS + CAMPAIGN LIFECYCLE — the v22 rules against the real
 * VoucherService/VouchersRepo code (SilaApi network mocked):
 *
 *  • a voucher BIGGER than the cart is NEVER completed — the server
 *    truth is booked but no sale, no goods, needsTopUp=true
 *  • a cart ≥ the voucher completes: INV-V sale + counter-extra
 *  • completing a still-short cart is permanently rejected
 *  • campaign lifecycle is one-way SQL-guarded:
 *    available → active → completed (never back, never twice)
 *  • completed campaigns keep their standing dues in the books but
 *    drop the POS cart's قسيمة button
 *  • campaignsTotals: due → الدين القائم, settled → الخزينة,
 *    'available' campaigns never count
 */
import {freshApp, load} from './helpers/app';

// The network layer is mocked — the redemption RESULT is what the
// real صِلة server would answer (§5 rule 3: snapshot truth).
jest.mock('../src/services/sila/SilaApi', () => {
  const actual = jest.requireActual('../src/services/sila/SilaApi');
  class SilaApiError extends Error {
    status: number;
    code: string;
    errorClass: string;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.name = 'SilaApiError';
      this.status = status;
      this.code = code;
      this.errorClass = 'permanent';
    }
  }
  return {
    ...actual,
    SilaApiError,
    silaRedeemVoucher: jest.fn(),
  };
});

const NO_PRINT = {
  print: false,
  receiptSettings: {} as never,
};

function cartLine(
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
    cost_price: retail * 0.6,
    retail_price: retail,
    wholesale_price: retail,
    stock_quantity: stock,
    category_id: null,
    image_uri: null,
  });
  return {id, name, retail, cost: retail * 0.6};
}

function serverAnswer(valueMinor: number) {
  return {
    ok: true,
    reference_code: 'POS-VR-123',
    voucher_id: 'v-1',
    value_minor: valueMinor,
    currency: 'ILS',
    kind: 'voucher' as const,
    campaign_id: 'cmp-school',
    campaign_name: 'حملة المدارس',
    beneficiary_last4: '7878',
    merchant_name: 'متجر الاختبار',
    redeemed_at: new Date().toISOString(),
    settlement: {
      redeemed_value_minor: valueMinor,
      settled_minor: 0,
      due_minor: valueMinor,
      state: 'none' as const,
    },
  };
}

async function seedPairing() {
  const {useSilaStore} = load('src/stores/silaStore');
  useSilaStore.getState().setPairing({
    posToken: 'tok',
    deviceId: 'dev',
    merchantOrgId: 'org',
    merchantName: 'متجر الاختبار',
    tokenExpiresAt: new Date(Date.now() + 86400000).toISOString(),
    pairedAt: new Date().toISOString(),
    apiBaseUrl: 'https://sila.example',
  });
}

describe('voucher redemption rules (cart vs voucher value)', () => {
  test('voucher BIGGER than the cart → booked but NEVER completed (needsTopUp)', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    await seedPairing();
    const {VoucherService} = load('src/services/VoucherService');
    const {SaleRepo} = load('src/database/repositories/SaleRepo');
    const {silaRedeemVoucher} = load('src/services/sila/SilaApi');
    const {VouchersRepo} = load('src/services/sila/VouchersRepo');

    const rice = await seedProduct('أرز', 10, 50);
    (silaRedeemVoucher as jest.Mock).mockResolvedValue(serverAnswer(5000));

    const before = await SaleRepo.countAll();
    const outcome = await VoucherService.redeemVoucher({
      payload: 'SILA:V1:xxx',
      cart: {lines: [cartLine(rice, 2)], discount: 0, pricingMode: 'RETAIL'}, // 20₪ < 50₪
      ...NO_PRINT,
    } as never);

    expect(outcome.needsTopUp).toBe(true);
    expect(outcome.shortfallMinor).toBe(3000);
    expect(outcome.sale).toBeNull();
    expect(await SaleRepo.countAll()).toBe(before); // NO goods sale
    expect(outcome.counterExtraMinor).toBe(0);

    // The server truth IS booked: redemption ok + campaign claim.
    const counts = await VouchersRepo.counts();
    expect(counts.ok).toBe(1);
    const campaign = await VouchersRepo.campaigns();
    expect(campaign.find(c => c.campaign_id === 'cmp-school')).toBeDefined();
  });

  test('cart ≥ voucher → INV-V sale lands with counter-extra', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    await seedPairing();
    const {VoucherService} = load('src/services/VoucherService');
    const {silaRedeemVoucher} = load('src/services/sila/SilaApi');
    const {ProductRepo} = load('src/database/repositories/ProductRepo');

    const rice = await seedProduct('أرز', 10, 50);
    (silaRedeemVoucher as jest.Mock).mockResolvedValue(serverAnswer(3000));

    const outcome = await VoucherService.redeemVoucher({
      payload: 'SILA:V1:yyy',
      cart: {lines: [cartLine(rice, 4)], discount: 0, pricingMode: 'RETAIL'}, // 40₪ ≥ 30₪
      ...NO_PRINT,
    } as never);

    expect(outcome.needsTopUp).toBe(false);
    expect(outcome.sale).not.toBeNull();
    expect(outcome.sale!.invoice_number).toMatch(/^INV-V-/);
    expect(outcome.counterExtraMinor).toBe(1000); // 40 − 30 = 10₪ at the counter
    const product = await ProductRepo.getById(rice.id);
    expect(Number(product?.stock_quantity)).toBe(46);
  });

  test('completing a still-short cart is permanently rejected', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    await seedPairing();
    const {VoucherService} = load('src/services/VoucherService');
    const {silaRedeemVoucher} = load('src/services/sila/SilaApi');

    const rice = await seedProduct('أرز', 10, 50);
    (silaRedeemVoucher as jest.Mock).mockResolvedValue(serverAnswer(5000));

    const outcome = await VoucherService.redeemVoucher({
      payload: 'SILA:V1:zzz',
      cart: {lines: [cartLine(rice, 2)], discount: 0, pricingMode: 'RETAIL'},
      ...NO_PRINT,
    } as never);
    expect(outcome.needsTopUp).toBe(true);

    // Still short (20₪ < 50₪) — the completion must refuse.
    await expect(
      VoucherService.completeCartRedemption(
        outcome.localId,
        {lines: [cartLine(rice, 1)], discount: 0, pricingMode: 'RETAIL'},
        false,
        {} as never,
      ),
    ).rejects.toThrow();

    // Topped up (5 × 10 = 50₪ ≥ 50₪) — completes now.
    const done = await VoucherService.completeCartRedemption(
      outcome.localId,
      {lines: [cartLine(rice, 5)], discount: 0, pricingMode: 'RETAIL'},
      false,
      {} as never,
    );
    expect(done.sale).not.toBeNull();
  });
});

describe('campaign lifecycle (one-way, SQL-guarded)', () => {
  async function seedCampaign(storeState?: string) {
    const {VouchersRepo} = load('src/services/sila/VouchersRepo');
    await VouchersRepo.upsertCampaignFromFeed({
      campaign_id: 'cmp-1',
      campaign_name: 'حملة الشتاء',
      kind: 'voucher',
      campaign_status: 'active',
      merchant_status: 'active',
      starts_at: null,
      ends_at: null,
      redeemed_count: 3,
      redeemed_value_minor: 9000,
      settled_minor: 4000,
      settled_pending_minor: 1000,
      settled_confirmed_minor: 3000,
      due_minor: 5000,
      settlement_state: 'partial',
      last_redemption_at: null,
      last_settlement_at: null,
      settlements: [],
    } as never);
    if (storeState) {
      const db = (load('src/database/connection') as {getDb: () => never})
        .getDb();
      db.execute(
        `UPDATE campaign_debts SET store_state = ? WHERE campaign_id = 'cmp-1'`,
        [storeState],
      );
    }
    return VouchersRepo;
  }

  test('available → active → completed, never backwards, never twice', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const VouchersRepo = await seedCampaign();

    // Available campaigns never count in the books.
    expect((await VouchersRepo.campaignsTotals()).campaignsCount).toBe(0);
    expect(await VouchersRepo.activeCampaignsCount()).toBe(0);

    // ACTIVATE — one-way.
    expect(await VouchersRepo.activateCampaign('cmp-1')).toBe(true);
    // Double activation is impossible.
    expect(await VouchersRepo.activateCampaign('cmp-1')).toBe(false);
    expect(await VouchersRepo.activeCampaignsCount()).toBe(1);

    // Activated campaigns enter the books: due → الدين القائم.
    const totals = await VouchersRepo.campaignsTotals();
    expect(totals.campaignsCount).toBe(1);
    expect(totals.dueMinor).toBe(5000);
    expect(totals.settledMinorTotal).toBe(4000); // → النقد بالخزينة
    expect(totals.settledConfirmedMinor).toBe(3000);

    // COMPLETE — one-way; the قسيمة button drops but dues stay.
    expect(await VouchersRepo.completeCampaign('cmp-1')).toBe(true);
    expect(await VouchersRepo.completeCampaign('cmp-1')).toBe(false);
    expect(await VouchersRepo.activateCampaign('cmp-1')).toBe(false);
    expect(await VouchersRepo.activeCampaignsCount()).toBe(0);

    const after = await VouchersRepo.campaignsTotals();
    expect(after.campaignsCount).toBe(1); // STILL in the books
    expect(after.dueMinor).toBe(5000); // standing dues preserved
    expect(after.completedCount).toBe(1);
  });

  test('a redemption snapshot never un-completes a completed campaign', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const VouchersRepo = await seedCampaign('completed');

    // A late redemption mirror arrives (sync replay) — the lifecycle
    // state must survive.
    await VouchersRepo.applyRedeemSnapshot(
      'cmp-1',
      'حملة الشتاء',
      'voucher',
      {
        redeemed_value_minor: 12000,
        settled_minor: 6000,
        due_minor: 6000,
        state: 'partial',
      } as never,
    );
    const rows = await VouchersRepo.campaigns();
    const cmp = rows.find(r => r.campaign_id === 'cmp-1');
    expect(cmp?.store_state).toBe('completed');
    expect(Number(cmp?.due_minor)).toBe(6000); // snapshot updated
  });
});

// ────────────────────────────────────────────────────────────────
// v24 (round-31 #4/#5): the STRICT parcel ↔ purchase-coupon
// separation. The cart's قسيمة button belongs to PURCHASE campaigns
// only; the القسائم tab's button redeems PARCELS only; a mismatched
// code is booked truthfully (the server consumed it) but NEVER
// completes a goods sale.
// ────────────────────────────────────────────────────────────────
describe('v24: parcel ↔ purchase separation', () => {
  async function seedCampaignOfKind(
    id: string,
    kind: 'voucher' | 'parcel',
    status: string,
  ) {
    const {VouchersRepo} = load('src/services/sila/VouchersRepo');
    await VouchersRepo.upsertCampaignFromFeed({
      campaign_id: id,
      campaign_name: `حملة ${id}`,
      kind,
      campaign_status: status,
      merchant_status: 'active',
      starts_at: null,
      ends_at: null,
      redeemed_count: 0,
      redeemed_value_minor: 0,
      settled_minor: 0,
      settled_pending_minor: 0,
      settled_confirmed_minor: 0,
      due_minor: 0,
      settlement_state: 'none',
      last_redemption_at: null,
      last_settlement_at: null,
      settlements: [],
    } as never);
    await VouchersRepo.activateCampaign(id);
    return VouchersRepo;
  }

  test('cart button: PARCEL campaigns never count; unknown status words still count; dead ones never', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {getDb} = load('src/database/connection') as {
      getDb: () => {execute: (q: string, p?: unknown[]) => {rowsAffected: number}};
    };

    // A PARCEL campaign, activated — must NOT drive the cart button.
    await seedCampaignOfKind('cmp-parcel', 'parcel', 'active');
    const {VouchersRepo} = load('src/services/sila/VouchersRepo');
    expect(await VouchersRepo.activeCampaignsCount()).toBe(0);

    // A PURCHASE campaign whose server status word is UNKNOWN
    // ('running') — the merchant activated it, the button MUST show
    // (the old equality test hid it → the round-31 complaint).
    await seedCampaignOfKind('cmp-run', 'voucher', 'running');
    expect(await VouchersRepo.activeCampaignsCount()).toBe(1);

    // A NULL status counts too (defensive server).
    await seedCampaignOfKind('cmp-null', 'voucher', 'active');
    getDb().execute(
      `UPDATE campaign_debts SET campaign_status = NULL WHERE campaign_id = 'cmp-null'`,
    );
    expect(await VouchersRepo.activeCampaignsCount()).toBe(2);

    // Clearly DEAD statuses hide the button even while activated.
    await seedCampaignOfKind('cmp-dead', 'voucher', 'ended');
    expect(await VouchersRepo.activeCampaignsCount()).toBe(2);
    const {VouchersRepo: VR} = load('src/services/sila/VouchersRepo');
    getDb().execute(
      `UPDATE campaign_debts SET campaign_status = 'cancelled' WHERE campaign_id = 'cmp-run'`,
    );
    expect(await VR.activeCampaignsCount()).toBe(1);
  });

  test('PURCHASE coupon at the PARCEL window → booked truthfully + hard error, no goods sale', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {silaRedeemVoucher} = load('src/services/sila/SilaApi') as {
      silaRedeemVoucher: jest.Mock;
    };
    await seedPairing();
    (silaRedeemVoucher as jest.Mock).mockResolvedValue(serverAnswer(5000));

    const {VoucherService} = load('src/services/VoucherService');
    await expect(
      VoucherService.redeemVoucher({
        payload: 'SILA:V1:zzz',
        mode: 'parcel',
        cart: null,
        ...NO_PRINT,
      } as never),
    ).rejects.toThrow('القسائم الشرائية تُصرف من سلة البيع فقط');

    // The redemption IS in the log as server truth (state ok) —
    // but NO INV-V goods sale exists.
    const {VouchersRepo} = load('src/services/sila/VouchersRepo');
    const rows = await VouchersRepo.recent(10, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('ok');
    expect(rows[0].sale_id).toBeNull();
  });

  test('PARCEL code at the CART → booked truthfully + hard error, cart sale never created', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {silaRedeemVoucher} = load('src/services/sila/SilaApi') as {
      silaRedeemVoucher: jest.Mock;
    };
    await seedPairing();
    (silaRedeemVoucher as jest.Mock).mockResolvedValue({
      ...serverAnswer(5000),
      kind: 'parcel',
      campaign_id: 'cmp-parcel-2',
      campaign_name: 'طرود العيد',
    });

    const rice = await seedProduct('أرز', 10, 50);
    const {VoucherService} = load('src/services/VoucherService');
    await expect(
      VoucherService.redeemVoucher({
        payload: 'SILA:V1:zzz',
        mode: 'cart',
        cart: {lines: [cartLine(rice, 5)], discount: 0, pricingMode: 'RETAIL'},
        ...NO_PRINT,
      } as never),
    ).rejects.toThrow('الطرود تُصرف من صفحة القسائم في دفتر صِلة فقط');

    // Booked ok — but no INV-V invoice was created for the cart.
    const {VouchersRepo} = load('src/services/sila/VouchersRepo');
    const rows = await VouchersRepo.recent(10, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('ok');
    expect(rows[0].sale_id).toBeNull();
    const {SaleRepo} = load('src/database/repositories/SaleRepo');
    const recent = await SaleRepo.listRecent(50);
    expect(recent.filter(s => s.invoice_number.startsWith('INV-V-'))).toHaveLength(0);
  });

  test('PARCEL at the PARCEL window → success, no sale row, the claim mirror lands', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {silaRedeemVoucher} = load('src/services/sila/SilaApi') as {
      silaRedeemVoucher: jest.Mock;
    };
    await seedPairing();
    (silaRedeemVoucher as jest.Mock).mockResolvedValue({
      ...serverAnswer(3000),
      kind: 'parcel',
      campaign_id: 'cmp-parcel-3',
      campaign_name: 'طرود الشتاء',
    });

    const {VoucherService} = load('src/services/VoucherService');
    const outcome = await VoucherService.redeemVoucher({
      payload: 'SILA:V1:zzz',
      mode: 'parcel',
      cart: null,
      ...NO_PRINT,
    } as never);
    expect(outcome.needsTopUp).toBe(false);
    expect(outcome.sale).toBeNull();

    // The campaign claim mirror landed from the server answer.
    const {VouchersRepo} = load('src/services/sila/VouchersRepo');
    const campaigns = await VouchersRepo.campaigns();
    const cmp = campaigns.find(r => r.campaign_id === 'cmp-parcel-3');
    expect(cmp).toBeDefined();
    expect(Number(cmp?.redeemed_value_minor)).toBe(3000);
  });
});
