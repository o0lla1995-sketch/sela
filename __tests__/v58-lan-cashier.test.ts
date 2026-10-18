/**
 * v58 (الجولة 62) — الكاشير على الشبكة المحلية: حرّوس المنطق كاملاً
 * ضد قاعدة حقيقية (node:sqlite عبر harness التطبيق):
 *  ① الترحيل v28 (جداول الكاشيرين + أعمدة النسب).
 *  ② إنشاء الحساب والمصادقة (كلمة خاطئة تُرفض).
 *  ③ دورة موافقة المدير على الجهاز: pending → موافقة → دخول برمز.
 *  ④ البيع عبر البروتوكول: فاتورة منسوبة للكاشير + خصم المخزون +
 *     السلسلة INV- + الحد الأقصى للخصم + تجاهل أسعار العميل.
 *  ⑤ الإرجاع: صف RET سالب + استرجاع المخزون + إحصاءات صحيحة.
 *  ⑥ الملكية: فاتورة كاشير آخر ممنوعة (403) وبلا رمز (401).
 *  ⑦ البحث بالباركود والزبائن والإحصاءات اليومية.
 */
import {freshApp, load} from './helpers/app';

const {freshApp: boot} = require('./helpers/app');

async function bootApp() {
  const app = boot(':memory:');
  await app.connection.initDatabase();
  return app;
}

function loginRequest(username: string, password: string, deviceId = 'dev-1') {
  return {
    id: 't-login',
    method: 'POST',
    path: '/api/auth/login',
    query: {},
    body: JSON.stringify({
      username,
      password,
      deviceId,
      deviceLabel: 'جهاز اختبار',
    }),
    auth: null,
    ip: '192.168.1.50',
  };
}

async function createSeedProduct(app: any, name: string, price: number, stock: number) {
  const db = app.connection.getDb();
  const result = await db.execute(
    `INSERT INTO products (name, retail_price, wholesale_price, cost_price, stock_quantity, category_id, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, '2026-01-01 10:00:00')`,
    [name, price, price * 0.8, price * 0.5, stock],
  );
  return result.insertId as number;
}

describe('v58 — الكاشير على الشبكة المحلية', () => {
  test('① الترحيل v28: جداول الكاشيرين وأعمدة النسب', async () => {
    const app = await bootApp();
    const db = app.connection.getDb();
    const cashierCols = await db.execute(
      "SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name IN ('lan_cashiers','lan_devices')",
    );
    expect(Number((cashierCols.rows as any[])[0].cnt)).toBe(2);
    const salesCol = await db.execute(
      "SELECT COUNT(*) AS cnt FROM pragma_table_info('sales') WHERE name = 'cashier_id'",
    );
    expect(Number((salesCol.rows as any[])[0].cnt)).toBe(1);
    const retCol = await db.execute(
      "SELECT COUNT(*) AS cnt FROM pragma_table_info('sale_returns') WHERE name = 'cashier_id'",
    );
    expect(Number((retCol.rows as any[])[0].cnt)).toBe(1);
    expect(app.storage.getNumber(app.storage.KEYS.schemaVersion, 0)).toBe(29);
  });

  test('② الحساب والمصادقة: الصحيح يمر والخاطئ يُرفض', async () => {
    const app = await bootApp();
    const {CashiersRepo} = load('src/database/repositories/CashiersRepo');
    await CashiersRepo.createCashier({
      username: 'ahmad',
      password: '1234',
      displayName: 'أحمد',
      maxDiscountPct: 10,
    });
    const okCashier = await CashiersRepo.authenticate('ahmad', '1234');
    expect(okCashier?.display_name).toBe('أحمد');
    const bad = await CashiersRepo.authenticate('ahmad', '9999');
    expect(bad).toBeNull();
    const unknown = await CashiersRepo.authenticate('ghost', '1234');
    expect(unknown).toBeNull();
    // كلمة المرور لا تُخزَّن نصاً أبداً.
    const db = app.connection.getDb();
    const row = await db.execute(
      "SELECT password_hash, salt FROM lan_cashiers WHERE username = 'ahmad'",
    );
    const stored = (row.rows as any[])[0];
    expect(String(stored.password_hash)).not.toContain('1234');
    expect(String(stored.password_hash).length).toBeGreaterThanOrEqual(64);
  });

  test('③ دورة الموافقة: pending ثم رمز بعد موافقة المدير', async () => {
    const app = await bootApp();
    const {CashiersRepo} = load('src/database/repositories/CashiersRepo');
    const handleLanRequest = load('src/services/lan/LanHandlers')
      .handleLanRequest;
    await CashiersRepo.createCashier({
      username: 'sami',
      password: 'pass1',
      displayName: 'سامي',
    });

    // أول دخول: الجهاز معلّق بانتظار المدير.
    const first = await handleLanRequest(loginRequest('sami', 'pass1', 'tab-9'));
    const firstBody = JSON.parse(first.body);
    expect(first.status).toBe(200);
    expect(firstBody.status).toBe('pending');

    const pending = await CashiersRepo.pendingDevices();
    expect(pending.length).toBe(1);
    expect(pending[0].device_id).toBe('tab-9');

    // المدير يوافق → الدخول التالي يعطي رمزاً.
    await CashiersRepo.approveDevice(pending[0].id);
    const second = await handleLanRequest(loginRequest('sami', 'pass1', 'tab-9'));
    const secondBody = JSON.parse(second.body);
    expect(secondBody.status).toBe('ok');
    expect(typeof secondBody.token).toBe('string');
    expect(secondBody.token.length).toBeGreaterThanOrEqual(32);

    // الرمز يعمل: طلب بلا رمز 401، وبالرمز يمر.
    const pingNoAuth = await handleLanRequest({
      id: 't1',
      method: 'GET',
      path: '/api/invoices',
      query: {},
      body: '',
      auth: null,
      ip: null,
    });
    expect(pingNoAuth.status).toBe(401);
    const invoices = await handleLanRequest({
      id: 't2',
      method: 'GET',
      path: '/api/invoices',
      query: {},
      body: '',
      auth: `Bearer ${secondBody.token}`,
      ip: null,
    });
    expect(invoices.status).toBe(200);
    expect(JSON.parse(invoices.body).invoices.length).toBe(0);
  });

  test('④ البيع: نسبة للكاشير + خصم مخزون + سقف الخصم + أسعار الخادم', async () => {
    const app = await bootApp();
    const {CashiersRepo} = load('src/database/repositories/CashiersRepo');
    const handleLanRequest = load('src/services/lan/LanHandlers')
      .handleLanRequest;
    await CashiersRepo.createCashier({
      username: 'layan',
      password: 'pass1',
      displayName: 'ليان',
      maxDiscountPct: 10,
    });
    const login = await handleLanRequest(
      loginRequest('layan', 'pass1', 'ph-1'),
    );
    // الجهاز الجديد معلق — نوافق عليه ثم نعيد الدخول.
    const pending = await CashiersRepo.pendingDevices();
    await CashiersRepo.approveDevice(pending[0].id);
    const token = JSON.parse(
      (await handleLanRequest(loginRequest('layan', 'pass1', 'ph-1'))).body,
    ).token as string;

    const productId = await createSeedProduct(app, 'شوكولاتة', 4, 100);

    // العميل يرسل سعراً وهمياً 0.01 — الخادم يتجاهله ويسعّر من القاعدة.
    // ويطلب خصماً 50 ₪ على فاتورة 8 ₪ — السقف 10% = 0.8 فقط.
    const saleRes = await handleLanRequest({
      id: 't-sale',
      method: 'POST',
      path: '/api/sale',
      query: {},
      body: JSON.stringify({
        lines: [{productId, quantity: 2, unitPrice: 0.01}],
        discount: 50,
        paymentType: 'cash',
      }),
      auth: `Bearer ${token}`,
      ip: null,
    });
    expect(saleRes.status).toBe(200);
    const saleBody = JSON.parse(saleRes.body);
    // 2 × 4 = 8، خصم مسموح 0.8 → الإجمالي 7.2
    expect(saleBody.invoice.total).toBeCloseTo(7.2, 5);
    expect(saleBody.invoice.number).toMatch(/^INV-/);

    const db = app.connection.getDb();
    const saleRow = await db.execute(
      `SELECT cashier_id, total_amount, discount FROM sales WHERE invoice_number = ?`,
      [saleBody.invoice.number],
    );
    const row = (saleRow.rows as any[])[0];
    const cashiers = await CashiersRepo.list();
    expect(Number(row.cashier_id)).toBe(cashiers[0].id);
    expect(Number(row.discount)).toBeCloseTo(0.8, 5);

    const stockRow = await db.execute(
      'SELECT stock_quantity FROM products WHERE id = ?',
      [productId],
    );
    expect(Number((stockRow.rows as any[])[0].stock_quantity)).toBe(98);

    // الفاتورة في قائمة الكاشير نفسه.
    const listRes = await handleLanRequest({
      id: 't-list',
      method: 'GET',
      path: '/api/invoices',
      query: {},
      body: '',
      auth: `Bearer ${token}`,
      ip: null,
    });
    const list = JSON.parse(listRes.body).invoices;
    expect(list.length).toBe(1);
    expect(list[0].total).toBeCloseTo(7.2, 5);
  });

  test('⑤ الإرجاع: صف RET + استرجاع المخزون + الإحصاءات', async () => {
    const app = await bootApp();
    const {CashiersRepo} = load('src/database/repositories/CashiersRepo');
    const handleLanRequest = load('src/services/lan/LanHandlers')
      .handleLanRequest;
    await CashiersRepo.createCashier({
      username: 'mona',
      password: 'pass1',
      displayName: 'منى',
    });
    const pending0 = await CashiersRepo.pendingDevices();
    expect(pending0.length).toBe(0);
    await handleLanRequest(loginRequest('mona', 'pass1', 'ph-2'));
    const pending = await CashiersRepo.pendingDevices();
    await CashiersRepo.approveDevice(pending[0].id);
    const token = JSON.parse(
      (await handleLanRequest(loginRequest('mona', 'pass1', 'ph-2'))).body,
    ).token as string;

    const productId = await createSeedProduct(app, 'عصير', 6, 50);
    const saleRes = await handleLanRequest({
      id: 's1',
      method: 'POST',
      path: '/api/sale',
      query: {},
      body: JSON.stringify({lines: [{productId, quantity: 3}]}),
      auth: `Bearer ${token}`,
      ip: null,
    });
    const invoice = JSON.parse(saleRes.body).invoice;

    // تفاصيل الفاتورة: أسطر قابلة للإرجاع.
    const detail = await handleLanRequest({
      id: 'd1',
      method: 'GET',
      path: '/api/invoice',
      query: {id: String(invoice.id)},
      body: '',
      auth: `Bearer ${token}`,
      ip: null,
    });
    const detailBody = JSON.parse(detail.body);
    expect(detailBody.lines.length).toBe(1);
    expect(detailBody.lines[0].remaining).toBe(3);

    // إرجاع قطعتين نقداً.
    const returnRes = await handleLanRequest({
      id: 'r1',
      method: 'POST',
      path: '/api/return',
      query: {},
      body: JSON.stringify({
        saleId: invoice.id,
        lines: [{saleItemId: detailBody.lines[0].saleItemId, quantity: 2}],
        refundMethod: 'cash',
      }),
      auth: `Bearer ${token}`,
      ip: null,
    });
    expect(returnRes.status).toBe(200);
    const returnBody = JSON.parse(returnRes.body);
    expect(returnBody.return.number).toMatch(/^RET-/);
    expect(returnBody.return.refundMinor).toBe(1200);

    const db = app.connection.getDb();
    const stockRow = await db.execute(
      'SELECT stock_quantity FROM products WHERE id = ?',
      [productId],
    );
    expect(Number((stockRow.rows as any[])[0].stock_quantity)).toBe(49);

    // الإحصاءات: بيع 18 ومرتجع 12 → الصافي 6.
    const statsRes = await handleLanRequest({
      id: 'st1',
      method: 'GET',
      path: '/api/stats',
      query: {},
      body: '',
      auth: `Bearer ${token}`,
      ip: null,
    });
    const stats = JSON.parse(statsRes.body);
    expect(stats.today.salesTotal).toBeCloseTo(18, 5);
    expect(stats.today.returnsTotal).toBeCloseTo(-12, 5);
    expect(stats.today.net).toBeCloseTo(6, 5);
    expect(stats.allTime.salesCount).toBe(1);
  });

  test('⑥ الملكية: فاتورة كاشير آخر ممنوعة، والكاشير الموقوف يُقطع', async () => {
    const app = await bootApp();
    const {CashiersRepo} = load('src/database/repositories/CashiersRepo');
    const handleLanRequest = load('src/services/lan/LanHandlers')
      .handleLanRequest;

    for (const name of ['fofo', 'koko']) {
      await CashiersRepo.createCashier({
        username: name,
        password: 'pass1',
        displayName: name,
      });
      await handleLanRequest(loginRequest(name, 'pass1', `ph-${name}`));
    }
    const pending = await CashiersRepo.pendingDevices();
    for (const device of pending) {
      await CashiersRepo.approveDevice(device.id);
    }
    const tokenFofo = JSON.parse(
      (await handleLanRequest(loginRequest('fofo', 'pass1', 'ph-fofo'))).body,
    ).token as string;
    const tokenKoko = JSON.parse(
      (await handleLanRequest(loginRequest('koko', 'pass1', 'ph-koko'))).body,
    ).token as string;

    const productId = await createSeedProduct(app, 'علكة', 2, 30);
    const saleRes = await handleLanRequest({
      id: 's2',
      method: 'POST',
      path: '/api/sale',
      query: {},
      body: JSON.stringify({lines: [{productId, quantity: 1}]}),
      auth: `Bearer ${tokenFofo}`,
      ip: null,
    });
    const invoice = JSON.parse(saleRes.body).invoice;

    // كوكو يحاول فتح فاتورة فوفو → 403.
    const foreign = await handleLanRequest({
      id: 'd2',
      method: 'GET',
      path: '/api/invoice',
      query: {id: String(invoice.id)},
      body: '',
      auth: `Bearer ${tokenKoko}`,
      ip: null,
    });
    expect(foreign.status).toBe(403);

    // المدير يوقف فوفو → رمزه يبطل فوراً.
    const cashiers = await CashiersRepo.list();
    const fofo = cashiers.find(x => x.username === 'fofo');
    await CashiersRepo.updateCashier(fofo.id, {isActive: 0});
    const blocked = await handleLanRequest({
      id: 'd3',
      method: 'GET',
      path: '/api/stats',
      query: {},
      body: '',
      auth: `Bearer ${tokenFofo}`,
      ip: null,
    });
    expect(blocked.status).toBe(401);
  });

  test('⑦ الكتالوج والباركود والزبائن وحد الدخول الفاشل', async () => {
    const app = await bootApp();
    const {CashiersRepo} = load('src/database/repositories/CashiersRepo');
    const handleLanRequest = load('src/services/lan/LanHandlers')
      .handleLanRequest;
    await CashiersRepo.createCashier({
      username: 'zaid',
      password: 'pass1',
      displayName: 'زيد',
    });
    await handleLanRequest(loginRequest('zaid', 'pass1', 'ph-3'));
    const pending = await CashiersRepo.pendingDevices();
    await CashiersRepo.approveDevice(pending[0].id);
    const token = JSON.parse(
      (await handleLanRequest(loginRequest('zaid', 'pass1', 'ph-3'))).body,
    ).token as string;

    // منتج بوحدة علبة وباركود.
    const db = app.connection.getDb();
    const productResult = await db.execute(
      `INSERT INTO products (name, retail_price, wholesale_price, cost_price, stock_quantity, barcode, created_at)
       VALUES ('مارلبورو', 1, 1, 0.5, 40, '6221031500111', '2026-01-01 10:00:00')`,
    );
    const productId = productResult.insertId as number;
    const unitResult = await db.execute(
      `INSERT INTO units (name, short_name, sort_order, kind) VALUES ('علبة', 'علبة', 1, 'piece')`,
    );
    await db.execute(
      `INSERT INTO product_units (product_id, unit_id, conversion, retail_price, barcode)
       VALUES (?, ?, 20, 18, '6221031500111')`,
      [productId, unitResult.insertId],
    );

    const catalogRes = await handleLanRequest({
      id: 'c1',
      method: 'GET',
      path: '/api/catalog',
      query: {},
      body: '',
      auth: `Bearer ${token}`,
      ip: null,
    });
    const catalog = JSON.parse(catalogRes.body);
    const cig = catalog.products.find(p => p.id === productId);
    expect(cig).toBeDefined();
    expect(cig.units.length).toBe(1);
    expect(cig.units[0].conversion).toBe(20);

    // البحث بالباركود يجد المنتج بوحدته.
    const barcodeRes = await handleLanRequest({
      id: 'b1',
      method: 'GET',
      path: '/api/products',
      query: {barcode: '6221031500111'},
      body: '',
      auth: `Bearer ${token}`,
      ip: null,
    });
    const barcodeBody = JSON.parse(barcodeRes.body);
    expect(barcodeBody.product.id).toBe(productId);

    // زبائن الدفتر.
    await db.execute(
      `INSERT INTO local_customers (id_number, name, created_at) VALUES ('912345678', 'أبو خليل', '2026-01-01')`,
    );
    const customersRes = await handleLanRequest({
      id: 'cu1',
      method: 'GET',
      path: '/api/customers',
      query: {},
      body: '',
      auth: `Bearer ${token}`,
      ip: null,
    });
    const customers = JSON.parse(customersRes.body).customers;
    expect(customers.length).toBe(1);
    expect(customers[0].name).toBe('أبو خليل');

    // خمس محاولات فاشلة → قفل مؤقت.
    for (let i = 0; i < 5; i += 1) {
      await handleLanRequest(loginRequest('zaid', 'wrong', 'ph-3'));
    }
    const locked = await handleLanRequest(loginRequest('zaid', 'wrong', 'ph-3'));
    expect(locked.status).toBe(429);
  });
});
