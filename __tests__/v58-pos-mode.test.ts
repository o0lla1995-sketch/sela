/**
 * v58 (الجولة 62) — مود «نقطة البيع» والإضافة السريعة:
 *  ① النمط السابع مسجّل بوحداته (حبة/علبة/كرتونة/غرام).
 *  ② إنشاء سريع قطعي: سعر الحبة + علبة ×20 → وحدتان بأسعارهما
 *     والمخزون بالحبات.
 *  ③ إنشاء سريع من العلبة: 18 ₪ / 20 حبة → سعر الحبة 0.9 مشتقاً.
 *  ④ إنشاء سريع وزني: سعر الغرام → سعر الكيلو ×1000 + وحدة غرام.
 *  ⑤ المخزون الفارغ → بلا تتبع (البيع لا يُحجب أبداً).
 *  ⑥ بيع منتج علبة عبر البروتوكول بالوحدة (سعر العلبة مستعمل).
 */
import {freshApp, load} from './helpers/app';

async function bootApp() {
  const app = freshApp(':memory:');
  await app.connection.initDatabase();
  return app;
}

async function setPosMode(app: any) {
  const settingsStore = load('src/stores/settingsStore');
  settingsStore.useSettingsStore.getState().update({storeMode: 'pos'});
}

describe('v58 — مود نقطة البيع والإضافة السريعة', () => {
  test('① النمط السابع: الوحدات والبذور', () => {
    const fs = require('fs');
    const src = fs.readFileSync('src/core/storeModes.ts', 'utf8');
    expect(src).toContain("| 'pos'");
    expect(src).toContain("key: 'pos'");
    expect(src).toContain("label: 'نقطة البيع (سريع)'");
    expect(src).toContain("{name: 'حبة', short: 'حبة', kind: 'piece'}");
    expect(src).toContain("{name: 'علبة', short: 'علبة', kind: 'piece'}");
    expect(src).toContain("{name: 'غرام', short: 'غ', kind: 'weight'}");
    expect(src).toContain("untrackedStockDefault: true");
  });

  test('② قطعي بالحبة: وحدتان بأسعارهما ومخزون بالحبات', async () => {
    const app = await bootApp();
    await setPosMode(app);
    const {QuickProductService} = load('src/services/QuickProductService');
    const {UnitRepo} = load('src/database/repositories/UnitRepo');

    const result = await QuickProductService.createQuickProduct({
      name: 'مارلبورو',
      sellBy: 'piece',
      price: 1,
      perBox: 20,
      stockInput: 5, // 5 علب
    });
    expect(result.untracked).toBe(false);
    expect(result.stockBase).toBe(100); // 5 علب × 20
    expect(result.unitCount).toBe(2);

    const units = await UnitRepo.listForProduct(result.productId);
    const piece = units.find(u => u.conversion === 1);
    const box = units.find(u => u.conversion === 20);
    expect(piece).toBeDefined();
    expect(piece.retail_price).toBe(1);
    expect(box).toBeDefined();
    expect(box.retail_price).toBe(20); // مشتق: 1 × 20

    const db = app.connection.getDb();
    const row = await db.execute(
      'SELECT retail_price, stock_quantity, stock_untracked, sold_by_weight, base_unit_name FROM products WHERE id = ?',
      [result.productId],
    );
    const p = (row.rows as any[])[0];
    expect(Number(p.retail_price)).toBe(1);
    expect(Number(p.stock_quantity)).toBe(100);
    expect(Number(p.stock_untracked)).toBe(0);
    expect(Number(p.sold_by_weight)).toBe(0);
    expect(String(p.base_unit_name)).toBe('حبة');
  });

  test('③ من العلبة: سعر الحبة مشتق من سعر العلبة', async () => {
    const app = await bootApp();
    await setPosMode(app);
    const {QuickProductService} = load('src/services/QuickProductService');
    const {UnitRepo} = load('src/database/repositories/UnitRepo');

    const result = await QuickProductService.createQuickProduct({
      name: 'كنت',
      sellBy: 'box',
      price: 18,
      perBox: 20,
      stockInput: 2,
    });
    const units = await UnitRepo.listForProduct(result.productId);
    const piece = units.find(u => u.conversion === 1);
    expect(piece.retail_price).toBe(0.9); // 18 / 20
    const box = units.find(u => u.conversion === 20);
    expect(box.retail_price).toBe(18);
    expect(result.stockBase).toBe(40);
  });

  test('④ وزني بالغرام: سعر الكيلو مشتق ووحدة غرام 0.001', async () => {
    const app = await bootApp();
    await setPosMode(app);
    const {QuickProductService} = load('src/services/QuickProductService');
    const {UnitRepo} = load('src/database/repositories/UnitRepo');

    const result = await QuickProductService.createQuickProduct({
      name: 'تبغ شبه',
      sellBy: 'gram',
      price: 0.06,
      stockInput: 500, // 500 غرام
    });
    expect(result.unitCount).toBe(1);
    expect(result.stockBase).toBe(0.5); // كغ

    const units = await UnitRepo.listForProduct(result.productId);
    expect(units.length).toBe(1);
    expect(units[0].conversion).toBe(0.001);
    expect(units[0].retail_price).toBe(0.06);

    const db = app.connection.getDb();
    const row = await db.execute(
      'SELECT retail_price, sold_by_weight, stock_untracked FROM products WHERE id = ?',
      [result.productId],
    );
    const p = (row.rows as any[])[0];
    expect(Number(p.retail_price)).toBe(60); // 0.06 × 1000 للكيلو
    expect(Number(p.sold_by_weight)).toBe(1);
    expect(Number(p.stock_untracked)).toBe(0);
  });

  test('⑤ مخزون فارغ: منتج بلا تتبع لا يُحجب بالبيع', async () => {
    const app = await bootApp();
    await setPosMode(app);
    const {QuickProductService} = load('src/services/QuickProductService');

    const result = await QuickProductService.createQuickProduct({
      name: 'ولاعة',
      sellBy: 'piece',
      price: 3,
    });
    expect(result.untracked).toBe(true);
    expect(result.stockBase).toBe(0);

    // البيع يمر رغم المخزون صفر — بلا تتبع.
    const {InvoiceService} = load('src/services/InvoiceService');
    const sale = await InvoiceService.completeSale({
      lines: [
        {
          key: `${result.productId}-`,
          productId: result.productId,
          name: 'ولاعة',
          unitPrice: 3,
          costPrice: 0,
          retailPrice: 3,
          wholesalePrice: 0,
          quantity: 5,
          availableStock: 999999,
          unitId: null,
          unitName: 'قطعة',
          conversion: 1,
        },
      ],
      discount: 0,
      paymentType: 'RETAIL',
      print: false,
      receiptSettings: {
        storeName: 'متجر',
        storePhone: '',
        footerMessage: '',
        paperWidth: '58',
        codepage: 1256,
        showProfit: false,
      },
    });
    expect(sale.sale.total_amount).toBe(15);
  });

  test('⑥ بيع بالوحدة عبر بروتوكول الكاشير: سعر العلبة مستعمل', async () => {
    const app = await bootApp();
    await setPosMode(app);
    const {QuickProductService} = load('src/services/QuickProductService');
    const {CashiersRepo} = load('src/database/repositories/CashiersRepo');
    const handleLanRequest = load('src/services/lan/LanHandlers')
      .handleLanRequest;
    const {UnitRepo} = load('src/database/repositories/UnitRepo');

    const product = await QuickProductService.createQuickProduct({
      name: 'مارلبورو',
      sellBy: 'box',
      price: 18,
      perBox: 20,
      stockInput: 10, // 200 حبة
    });
    const units = await UnitRepo.listForProduct(product.productId);
    const boxUnit = units.find(u => u.conversion === 20);

    await CashiersRepo.createCashier({
      username: 'testy',
      password: 'pass1',
      displayName: 'مختبر',
    });
    await handleLanRequest({
      id: 'l1',
      method: 'POST',
      path: '/api/auth/login',
      query: {},
      body: JSON.stringify({
        username: 'testy',
        password: 'pass1',
        deviceId: 'ph-x',
        deviceLabel: 'جهاز',
      }),
      auth: null,
      ip: null,
    });
    const pending = await CashiersRepo.pendingDevices();
    await CashiersRepo.approveDevice(pending[0].id);
    const token = JSON.parse(
      (
        await handleLanRequest({
          id: 'l2',
          method: 'POST',
          path: '/api/auth/login',
          query: {},
          body: JSON.stringify({
            username: 'testy',
            password: 'pass1',
            deviceId: 'ph-x',
            deviceLabel: 'جهاز',
          }),
          auth: null,
          ip: null,
        })
      ).body,
    ).token as string;

    // بيع علبتان — سعر العلبة 18 من القاعدة لا من العميل.
    const saleRes = await handleLanRequest({
      id: 's3',
      method: 'POST',
      path: '/api/sale',
      query: {},
      body: JSON.stringify({
        lines: [{productId: product.productId, unitId: boxUnit.unit_id, quantity: 2}],
        discount: 0,
        paymentType: 'cash',
      }),
      auth: `Bearer ${token}`,
      ip: null,
    });
    expect(saleRes.status).toBe(200);
    const invoice = JSON.parse(saleRes.body).invoice;
    expect(invoice.total).toBe(36);

    // المخزون نقص 40 حبة (علبتان × 20).
    const db = app.connection.getDb();
    const row = await db.execute(
      'SELECT stock_quantity FROM products WHERE id = ?',
      [product.productId],
    );
    expect(Number((row.rows as any[])[0].stock_quantity)).toBe(160);
  });
});
