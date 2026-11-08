/**
 * v82 (الجولة 95) — أمانة الاسترجاع من النسخة الاحتياطية: دورة كاملة
 * حقيقية على قاعدة بيانات فعلية (زرع كل مجال → نسخة → قاعدة جديدة
 * تحاكي حذف بيانات التطبيق → استرجاع → مطابقة كل جدول وكل رصيد).
 * ─────────────────────────────────────────────────────────────────
 * جذر شكوى التاجر: بعد الاسترجاع «الديون لم تسترجع وأخطاء كبيرة في
 * أرصدة المحافظ والرصيد الإجمالي يتغير». الجذور التي يصطادها
 * هذا الملف:
 *  ① sales.payment_method لم تكن تسافر مع النسخة → كل مبيعات القنوات
 *     تتحول نقداً بعد الاسترجاع (أرصدة المحافظ تنهار).
 *  ② cash_movements (المصاريف/السحوبات/الإيداعات بكل القنوات) لم تكن
 *     تُنسخ أصلاً → الخزينة تفقد عملياتها غير البيعية.
 *  ③ الطلبات الأونلاين (وبنودها) لم تكن تُنسخ → ديون الأونلاين تختفي.
 *  ④ الاستبدالات وسجل تعديل الفواتير وحسابات الكاشيرين لم تكن تُنسخ.
 *  ⑤ الاسترجاع فوق قاعدة فيها بيانات لم يمسح الجداول غير المستعادة →
 *     خلط بيانات قديمة بالمستعادة (يجب أن يكون استبدالاً كاملاً).
 */
import {freshApp, tempDb, load} from './helpers/app';

const {freshApp: boot} = require('./helpers/app');

/** نهيئة قاعدة حقيقية بمسار ملف (كي نحاكي جهازاً آخر). */
async function bootDb(name: string) {
  const app = boot(tempDb(name));
  await app.connection.initDatabase();
  return app;
}

interface Snapshot {
  [table: string]: Record<string, unknown>[];
}

/** لقطة جدول مرتبة بمفتاح مستقر (لا بمعرّف AUTOINCREMENT). */
async function snap(
  db: any,
  table: string,
  orderBy: string,
): Promise<Record<string, unknown>[]> {
  const result = await db.execute(`SELECT * FROM ${table} ORDER BY ${orderBy}`);
  return ((result.rows ?? []) as Record<string, unknown>[]).map(row =>
    Object.fromEntries(
      Object.entries(row).map(([k, v]) => [k, v == null ? null : v]),
    ),
  );
}

/** مفتاح الترتيب المستقر لكل جدول (لا كلها لها id). */
const ORDER_BY: Record<string, string> = {
  products: 'name',
  product_variants: 'color, size',
  product_units: 'product_id, unit_id',
  sales: 'invoice_number',
  sale_items: 'sale_id, id',
  sale_returns: 'return_number',
  sale_return_items: 'return_id, id',
  sale_return_exchanges: 'id',
  sale_edits: 'id',
  stocktakes: 'id',
  stocktake_items: 'id',
  local_customers: 'id_number',
  local_debts: 'invoice_ref',
  local_payments: 'receipt_ref',
  sila_customers: 'customer_id',
  sila_debt_queue: 'idempotency_key',
  sila_payment_queue: 'idempotency_key',
  sila_app_collections: 'detected_at',
  merchants: 'name',
  merchant_movements: 'ref',
  cash_movements: 'ref',
  online_orders: 'order_number',
  online_order_items: 'id',
  lan_cashiers: 'username',
  lan_devices: 'device_id',
  campaign_debts: 'campaign_id',
  campaign_settlements: 'settlement_id',
  voucher_redemptions: 'idempotency_key',
};

describe('v82 — أمانة الاسترجاع: دورة كاملة على قاعدة حقيقية', () => {
  test('كل مجال يُنسخ ويُسترجع بنفس القيم (مطابقة الجداول والأرصدة)', async () => {
    // ── المرحلة ١: الزرع ─────────────────────────────────────────
    const app1 = await bootDb('seed');
    const db1 = app1.connection.getDb();

    // كتالوج: تصنيف + وحدة + منتجان (أحدهما بمتغيرات ملابس).
    await db1.execute(
      "INSERT INTO categories (name, store_mode) VALUES ('مشروبات', 'grocery')",
    );
    await db1.execute(
      "INSERT INTO units (name, short_name, sort_order, kind, store_mode) VALUES ('كرتونة', 'كرت', 1, 'piece', 'grocery')",
    );
    const p1 = await db1.execute(
      `INSERT INTO products (name, cost_price, retail_price, wholesale_price, stock_quantity, barcode, created_at)
       VALUES ('شوكولاتة', 2, 5, 4, 50, 'B-100', '2026-11-01 09:00:00')`,
    );
    const pid1 = Number(p1.insertId);
    const p2 = await db1.execute(
      `INSERT INTO products (name, cost_price, retail_price, wholesale_price, stock_quantity, has_variants, created_at)
       VALUES ('قميص أزرق', 20, 45, 38, 0, 1, '2026-11-01 09:05:00')`,
    );
    const pid2 = Number(p2.insertId);
    const v1 = await db1.execute(
      `INSERT INTO product_variants (product_id, kind, color, size, stock_quantity, retail_price, cost_price)
       VALUES (?, 'variant', 'أزرق', 'L', 4, 45, 20)`,
      [pid2],
    );
    const vid1 = Number(v1.insertId);
    await db1.execute(
      `INSERT INTO product_units (product_id, unit_id, conversion, barcode, retail_price, wholesale_price)
       VALUES (?, 1, 24, 'B-100-C', 110, 96)`,
      [pid1],
    );

    // كاشير وجهازه (فواتيره تنسب إليه).
    const cashier = await db1.execute(
      `INSERT INTO lan_cashiers (username, password_hash, salt, display_name, is_active, max_discount_pct, can_debt, can_return, created_at)
       VALUES ('ahmad', 'HASH123', 'SALT123', 'أحمد', 1, 15, 1, 1, '2026-11-01 08:00:00')`,
    );
    const cashierId = Number(cashier.insertId);
    await db1.execute(
      `INSERT INTO lan_devices (cashier_id, device_id, device_label, status, token, ip, first_seen_at)
       VALUES (?, 'dev-7', 'كاشينر ١', 'approved', 'TOK-7', '192.168.1.9', '2026-11-01 08:10:00')`,
      [cashierId],
    );

    // فواتير: نقدية + محفظة (bank-of-palestine) + دين INV-L + مرتجع
    // RET بقناة + فاتورة كاشير + تعديل فاتورة.
    const s1 = await db1.execute(
      `INSERT INTO sales (invoice_number, total_amount, total_cost, total_profit, discount, payment_type, created_at, payment_method)
       VALUES ('INV-20261101-0001', 50, 30, 20, 0, 'RETAIL', '2026-11-01 10:00:00', 'cash')`,
    );
    const sale1 = Number(s1.insertId);
    const s2 = await db1.execute(
      `INSERT INTO sales (invoice_number, total_amount, total_cost, total_profit, discount, payment_type, created_at, payment_method, client_ref, edit_count, edited_at, cashier_id)
       VALUES ('INV-20261101-0002', 200, 120, 80, 10, 'RETAIL', '2026-11-01 10:30:00', 'bank_of_palestine', 'CR-77', 1, '2026-11-01 11:00:00', ?)`,
      [cashierId],
    );
    const sale2 = Number(s2.insertId);
    const li1 = await db1.execute(
      `INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, cost_price, total_line_price, unit_name, base_quantity)
       VALUES (?, ?, 3, 5, 2, 15, 'قطعة', 3)`,
      [sale1, pid1],
    );
    const line1 = Number(li1.insertId);
    await db1.execute(
      `INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, cost_price, total_line_price, variant_label, variant_id)
       VALUES (?, ?, 2, 45, 20, 90, 'أزرق · L', ?)`,
      [sale2, pid2, vid1],
    );
    // مرتجع RET على الفاتورة الأولى بقناة المحفظة + استبدال قميص.
    const ret1 = await db1.execute(
      `INSERT INTO sale_returns (return_number, sale_id, invoice_ref, book, refund_method, refund_minor, debt_adjusted_minor, note, created_at, refund_channel, cashier_id)
       VALUES ('RET-20261101-0001', ?, 'INV-20261101-0001', 'cash', 'cash', 1000, 0, 'مرتجع جزئي', '2026-11-02 12:00:00', 'bank_of_palestine', ?)`,
      [sale1, cashierId],
    );
    const retId1 = Number(ret1.insertId);
    await db1.execute(
      `INSERT INTO sale_return_items (return_id, sale_item_id, product_id, product_name, quantity, unit_name, base_quantity, unit_price, line_total, cost_price)
       VALUES (?, ?, ?, 'شوكولاتة', 1, 'قطعة', 1, 5, 5, 2)`,
      [retId1, line1, pid1],
    );
    await db1.execute(
      `INSERT INTO sale_return_exchanges (return_id, product_id, product_name, quantity, unit_name, base_quantity, unit_price, line_total, cost_price, variant_id, variant_color, variant_label)
       VALUES (?, ?, 'قميص أزرق', 1, 'قطعة', 1, 45, 45, 20, ?, 'أزرق', 'أزرق · L')`,
      [retId1, pid2, vid1],
    );
    // سجل تعديل الفاتورة الثانية.
    await db1.execute(
      `INSERT INTO sale_edits (sale_id, edited_at, before_json, after_json, delta_minor, note)
       VALUES (?, '2026-11-01 11:00:00', '{"t":1}', '{"t":2}', 500, 'تصحيح كمية')`,
      [sale2],
    );

    // دفتر المتجر: زبون محلي + دين بيع INV-L + دين مباشر + سداد بمحفظة.
    const lc = await db1.execute(
      `INSERT INTO local_customers (id_number, name, phone, notes, created_at)
       VALUES ('999123456', 'خالد', '0599111222', 'جار', '2026-11-01 09:00:00')`,
    );
    const lcId = Number(lc.insertId);
    await db1.execute(
      `INSERT INTO local_debts (local_customer_id, invoice_ref, amount_minor, description, origin, created_at)
       VALUES (?, 'INV-L-20261101-0001', 7000, 'دين بيع', 'sale', '2026-11-01 10:15:00')`,
      [lcId],
    );
    await db1.execute(
      `INSERT INTO local_debts (local_customer_id, invoice_ref, amount_minor, description, origin, created_at)
       VALUES (?, 'INV-L-20261102-0001', 2500, 'دين مباشر', 'direct', '2026-11-02 09:00:00')`,
      [lcId],
    );
    await db1.execute(
      `INSERT INTO local_payments (local_customer_id, receipt_ref, amount_minor, method, note, created_at)
       VALUES (?, 'RCP-L-20261102-0001', 3000, 'bank_of_palestine', 'سداد تحويل', '2026-11-02 14:00:00')`,
      [lcId],
    );

    // صلة: زبون cache + طابور دين متزامن + سداد + تحصيل تطبيق.
    await db1.execute(
      `INSERT INTO sila_customers (customer_id, name, phone_last4, id_number, outstanding_minor, credit_minor, pos_outstanding_minor, device_outstanding_minor, device_purchases_minor, device_payments_minor, last_synced_at)
       VALUES ('cid-1', 'سامي', '1234', '888777666', 12000, 0, 12000, 4000, 9000, 5000, '2026-11-02 08:00:00')`,
    );
    await db1.execute(
      `INSERT INTO sila_debt_queue (idempotency_key, customer_id, customer_name, amount_minor, currency, pos_invoice_ref, scanned_at, state, created_at)
       VALUES ('idem-1', 'cid-1', 'سامي', 12000, 'ILS', 'INV-D-20261101-0001', '2026-11-01 10:20:00', 'synced', '2026-11-01 10:20:00')`,
    );
    await db1.execute(
      `INSERT INTO sila_payment_queue (idempotency_key, customer_id, customer_name, amount_minor, payment_method, pos_receipt_ref, paid_at, state, kind, created_at)
       VALUES ('idem-p1', 'cid-1', 'سامي', 4000, 'jawwal_pay', 'RCP-D-20261102-0001', '2026-11-02 15:00:00', 'synced', 'repayment', '2026-11-02 15:00:00')`,
    );
    await db1.execute(
      `INSERT INTO sila_app_collections (customer_id, customer_name, amount_minor, detected_at)
       VALUES ('cid-1', 'سامي', 1000, '2026-11-02 16:00:00')`,
    );

    // الخزينة: مصروف نقدي + سحب من محفظة + إيداع بنكي + تحصيل أونلاين.
    await db1.execute(
      `INSERT INTO cash_movements (ref, kind, category, note, amount_minor, auth_method, payment_method, created_at)
       VALUES ('EXP-20261101-0001', 'expense', 'كهرباء', 'فاتورة شركة', 8000, 'none', NULL, '2026-11-01 18:00:00')`,
    );
    await db1.execute(
      `INSERT INTO cash_movements (ref, kind, category, note, amount_minor, auth_method, payment_method, created_at)
       VALUES ('WD-20261102-0001', 'withdrawal', 'سحب رصيد', 'تحويل لجيب', 20000, 'pin', 'jawwal_pay', '2026-11-02 18:00:00')`,
    );
    await db1.execute(
      `INSERT INTO cash_movements (ref, kind, category, note, amount_minor, auth_method, payment_method, created_at)
       VALUES ('DEP-20261102-0001', 'deposit', 'إيداع نقدي', 'فكة', 5000, 'none', 'bank_of_palestine', '2026-11-02 19:00:00')`,
    );
    await db1.execute(
      `INSERT INTO cash_movements (ref, kind, category, note, amount_minor, auth_method, payment_method, created_at)
       VALUES ('COLL-20261102-0001', 'online_collection', 'تحصيل طلب أونلاين', 'ORD-1001', 6000, 'none', NULL, '2026-11-02 20:00:00')`,
    );

    // فاتورة الطلب الأونلاين (INV-O) — يُعاد ربط الطلب بها بعد
    // الاسترجاع برقمها المستقر.
    const s3 = await db1.execute(
      `INSERT INTO sales (invoice_number, total_amount, total_cost, total_profit, discount, payment_type, created_at, payment_method)
       VALUES ('INV-O-20261102-0001', 60, 35, 25, 0, 'RETAIL', '2026-11-02 19:30:00', 'cash')`,
    );
    void s3;

    // طلب أونلاين مُسلَّم غير محصَّل (دين أونلاين حي) + بنداه.
    await db1.execute(
      `INSERT INTO online_orders (server_id, order_number, status, customer_name, customer_phone, customer_id_number, region_name, address, note, delivery_fee_minor, items_total_minor, total_minor, returned_minor, invoice_ref, revision, server_created_at, server_updated_at)
       VALUES (1001, 'ORD-1001', 'delivered', 'ليلى', '0599333444', '777666555', 'الشمال', 'شارع ١', 'اتصل', 500, 5500, 6000, 0, 'INV-O-20261102-0001', 2, 1730550000, 1730559900)`,
    );
    await db1.execute(
      `INSERT INTO online_order_items (server_order_id, product_id, product_ref, product_name, variant, unit_price_minor, quantity, line_total_minor)
       VALUES (1001, ?, 'P1', 'شوكولاتة', NULL, 500, 5, 2500)`,
      [pid1],
    );
    await db1.execute(
      `INSERT INTO online_order_items (server_order_id, product_id, product_ref, product_name, variant, unit_price_minor, quantity, line_total_minor)
       VALUES (1001, ?, 'P2', 'قميص أزرق', 'أزرق · L', 3000, 1, 3000)`,
      [pid2],
    );

    // تجار: تاجر + فاتورة توريد + سداد بمحفظة + دين مستحق مباشر.
    const merch = await db1.execute(
      `INSERT INTO merchants (name, phone, id_number, notes, created_at)
       VALUES ('مصنع الجودة', '0599555666', '666555444', 'مورد رئيسي', '2026-11-01 09:00:00')`,
    );
    const merchId = Number(merch.insertId);
    await db1.execute(
      `INSERT INTO merchant_movements (merchant_id, ref, kind, amount, method, note, items_json, cash_ref, created_at)
       VALUES (?, 'SUP-20261101-0001', 'invoice', 500, 'cash', 'توريد', '[{"n":"شوكولاتة"}]', 'EXP-20261101-0001', '2026-11-01 13:00:00')`,
      [merchId],
    );
    await db1.execute(
      `INSERT INTO merchant_movements (merchant_id, ref, kind, amount, method, note, items_json, cash_ref, created_at)
       VALUES (?, 'PAY-20261102-0001', 'payment', 200, 'jawwal_pay', 'دفعة', NULL, 'WD-20261102-0001', '2026-11-02 13:00:00')`,
      [merchId],
    );
    await db1.execute(
      `INSERT INTO merchant_movements (merchant_id, ref, kind, amount, method, note, items_json, cash_ref, created_at)
       VALUES (?, 'DEBT-20261102-0001', 'debt', 75, NULL, 'رسوم نقل', NULL, NULL, '2026-11-02 13:30:00')`,
      [merchId],
    );

    // جرد + قسائم (مجاميع تعود كما هي).
    const st = await db1.execute(
      `INSERT INTO stocktakes (started_at, completed_at, status, note)
       VALUES ('2026-11-02 07:00:00', '2026-11-02 08:00:00', 'completed', 'جرد أسبوعي')`,
    );
    const stId = Number(st.insertId);
    await db1.execute(
      `INSERT INTO stocktake_items (stocktake_id, product_id, variant_id, variant_label, system_qty, counted_qty)
       VALUES (?, ?, NULL, NULL, 50, 48)`,
      [stId, pid1],
    );
    await db1.execute(
      `INSERT INTO campaign_debts (campaign_id, campaign_name, kind, store_state, redeemed_count, redeemed_value_minor, settled_minor, due_minor, settlement_state)
       VALUES ('camp-1', 'قسيمة مؤسسة سند', 'voucher', 'active', 3, 9000, 4000, 5000, 'partial')`,
    );
    await db1.execute(
      `INSERT INTO campaign_settlements (settlement_id, campaign_id, campaign_name, amount_minor, kind, status, method, reference, created_at)
       VALUES ('stl-1', 'camp-1', 'قسيمة مؤسسة سند', 4000, 'settlement', 'confirmed', 'bank', 'TR-9', '2026-11-02 21:00:00')`,
    );
    await db1.execute(
      `INSERT INTO voucher_redemptions (idempotency_key, payload, campaign_id, campaign_name, value_minor, pos_receipt_ref, state, redeemed_at, counter_extra_minor, created_at)
       VALUES ('vr-1', '{}', 'camp-1', 'قسيمة مؤسسة سند', 3000, 'INV-V-20261102-0001', 'ok', '2026-11-02 12:00:00', 500, '2026-11-02 12:00:00')`,
    );

    // ── المرحلة ٢: النسخة الاحتياطية ─────────────────────────────
    const {BackupService} = load('src/services/BackupService');
    const {ReportRepo} = load('src/database/repositories/ReportRepo');
    const {json} = await BackupService.buildBackupJson({compact: true});
    const doc = JSON.parse(json);
    expect(doc.backupVersion).toBe(6);
    expect(doc.app).toBe('sela');
    // الملف يحمل المجالات الجديدة كلها.
    expect(doc.cash_movements.length).toBe(4);
    expect(doc.online_orders.length).toBe(1);
    expect(doc.online_order_items.length).toBe(2);
    expect(doc.sale_return_exchanges.length).toBe(1);
    expect(doc.sale_edits.length).toBe(1);
    expect(doc.lan_cashiers.length).toBe(1);
    expect(doc.lan_devices.length).toBe(1);
    expect(doc.sales.filter((s: any) => s.payment_method === 'bank_of_palestine').length).toBe(1);
    expect(doc.merchant_movements.filter((m: any) => m.kind === 'debt').length).toBe(1);
    expect(doc.sila_customers[0].device_outstanding_minor).toBe(4000);

    // ── المرحلة ٣: قاعدة جديدة تحاكي «حذف بيانات التطبيق» ───────
    const app2 = await bootDb('fresh');
    const db2 = app2.connection.getDb();
    // زرع بيانات قديمة مختلفة تماماً — الاسترجاع يجب أن يستبدلها كاملة.
    await db2.execute(
      "INSERT INTO products (name, cost_price, retail_price, wholesale_price, stock_quantity) VALUES ('منتج قديم', 1, 2, 1.5, 5)",
    );
    await db2.execute(
      `INSERT INTO cash_movements (ref, kind, category, amount_minor, auth_method, payment_method, created_at)
       VALUES ('EXP-20200101-0001', 'expense', 'قديم', 100, 'none', NULL, '2020-01-01 10:00:00')`,
    );
    await db2.execute(
      `INSERT INTO online_orders (server_id, order_number, status, customer_name, total_minor)
       VALUES (9009, 'ORD-OLD', 'new', 'زبون قديم', 100)`,
    );
    await db2.execute(
      `INSERT INTO lan_cashiers (username, password_hash, salt, display_name, created_at)
       VALUES ('olduser', 'X', 'Y', 'قديم', '2020-01-01 08:00:00')`,
    );

    // ── المرحلة ٤: الاسترجاع ────────────────────────────────────
    // (إعادة التحميل من سجل app2 — نسخة الخدمة القديمة تشير لقاعدة
    //  المصدر، ودرس مهم: كل وحدة تعمل فوق قاعدة必须 أن تُحمَّل فوق
    //  سجلّها الصحيح.)
    const {BackupService: BackupService2} = load(
      'src/services/BackupService',
    );
    const parsed = BackupService2.parseAndValidateBackup(json);
    const summary = await BackupService2.restoreBackup(parsed);
    expect(summary.products).toBe(2);
    expect(summary.sales).toBe(3);

    // ── المرحلة ٥: المطابقة ─────────────────────────────────────
    const TABLES = Object.keys(ORDER_BY);
    const before: Snapshot = {};
    for (const table of TABLES) {
      before[table] = await snap(db1, table, ORDER_BY[table]);
    }

    /** مطابقة تجاهل أعمدة المعرّفات المعاد ترقيمها. */
    const strip = (rows: Record<string, unknown>[], cols: string[]) =>
      rows.map(row =>
        Object.fromEntries(
          Object.entries(row).filter(([k]) => !cols.includes(k)),
        ),
      );

    const idCols = [
      'id',
      'sale_id',
      'product_id',
      'category_id',
      'local_customer_id',
      'merchant_id',
      'return_id',
      'sale_item_id',
      'stocktake_id',
      'variant_id',
      'cashier_id',
      'server_order_id',
      'local_id',
      'sale_id_',
    ];
    for (const [table, rowsBefore] of Object.entries(before)) {
      const rowsAfter = await snap(db2, table, ORDER_BY[table]);
      expect({table, count: rowsAfter.length}).toEqual({
        table,
        count: rowsBefore.length,
      });
      expect({table, rows: strip(rowsAfter, idCols)}).toEqual({
        table,
        rows: strip(rowsBefore, idCols),
      });
    }

    // الاستبدال الكامل: لا أثر للبيانات القديمة أبداً.
    const oldProduct = await db2.execute(
      "SELECT COUNT(*) AS c FROM products WHERE name = 'منتج قديم'",
    );
    expect(Number((oldProduct.rows as any[])[0].c)).toBe(0);
    const oldCash = await db2.execute(
      "SELECT COUNT(*) AS c FROM cash_movements WHERE ref = 'EXP-20200101-0001'",
    );
    expect(Number((oldCash.rows as any[])[0].c)).toBe(0);
    const oldOrder = await db2.execute(
      "SELECT COUNT(*) AS c FROM online_orders WHERE order_number = 'ORD-OLD'",
    );
    expect(Number((oldOrder.rows as any[])[0].c)).toBe(0);
    const oldCashier = await db2.execute(
      "SELECT COUNT(*) AS c FROM lan_cashiers WHERE username = 'olduser'",
    );
    expect(Number((oldCashier.rows as any[])[0].c)).toBe(0);

    // الروابط الداخلية تشير للصفوف الصحيحة بعد إعادة الترقيم.
    const relinkedOrder = await db2.execute(
      `SELECT o.sale_id, s.invoice_number FROM online_orders o
       JOIN sales s ON s.id = o.sale_id WHERE o.order_number = 'ORD-1001'`,
    );
    expect(relinkedOrder.rows.length).toBe(1);
    expect((relinkedOrder.rows as any[])[0].invoice_number).toBe(
      'INV-O-20261102-0001',
    );
    const cashierSale = await db2.execute(
      `SELECT s.invoice_number, lc.username FROM sales s
       JOIN lan_cashiers lc ON lc.id = s.cashier_id
       WHERE s.invoice_number = 'INV-20261101-0002'`,
    );
    expect((cashierSale.rows as any[])[0].username).toBe('ahmad');
    const debtOrigin = await db2.execute(
      "SELECT origin, invoice_ref FROM local_debts ORDER BY invoice_ref",
    );
    expect((debtOrigin.rows as any[]).map((r: any) => r.origin)).toEqual([
      'sale',
      'direct',
    ]);

    // ── المرحلة ٦: أرصدة القنوات متطابقة قبل وبعد ───────────────
    const range = {from: '2000-01-01', to: '2999-12-31'};
    const totalsBefore = await ReportRepo.methodLedgerTotals(range);
    // نسخة ReportRepo من سجل app2 (فوق القاعدة المستعادة).
    const {ReportRepo: ReportRepo2} = load(
      'src/database/repositories/ReportRepo',
    );
    const totalsAfter = await ReportRepo2.methodLedgerTotals(range);
    const byMethod = (rows: any[]) =>
      Object.fromEntries(rows.map((r: any) => [r.method, r.net]));
    expect(totalsAfter.length).toBe(totalsBefore.length);
    expect(byMethod(totalsAfter)).toEqual(byMethod(totalsBefore));
    // القناتان ظاهرتان بالأرصدة (وليس نقداً فقط).
    const methods = new Set(totalsAfter.map((r: any) => r.method));
    expect(methods.has('bank_of_palestine')).toBe(true);
    expect(methods.has('jawwal_pay')).toBe(true);
  });

  test('نسخة قديمة (v5) بلا حقول v82 تست_restore بنفس الانضباط', async () => {
    const app = await bootDb('legacy');
    const db = app.connection.getDb();
    await db.execute(
      `INSERT INTO products (name, cost_price, retail_price, wholesale_price, stock_quantity, created_at)
       VALUES (' legacy ', 1, 2, 1.5, 5, '2026-01-01 00:00:00')`,
    );
    const legacy = {
      app: 'sela',
      backupVersion: 5,
      createdAt: '2026-01-01T00:00:00.000Z',
      appVersion: '82.0.0 (92)',
      categories: [],
      units: [],
      products: [
        {
          id: 1,
          name: 'منتج قديم',
          cost_price: 1,
          retail_price: 2,
          wholesale_price: 1.5,
          stock_quantity: 5,
          category_id: null,
          image_uri: null,
          low_stock_threshold: null,
          barcode: null,
          created_at: '2026-01-01 00:00:00',
        },
      ],
      product_units: [],
      embeddings: [],
      sales: [
        {
          id: 1,
          invoice_number: 'INV-OLD-0001',
          total_amount: 10,
          total_cost: 6,
          total_profit: 4,
          discount: 0,
          payment_type: 'RETAIL',
          created_at: '2026-01-01 01:00:00',
        },
      ],
      sale_items: [],
      stocktakes: [],
      stocktake_items: [],
      settings: {},
    };
    const {BackupService} = load('src/services/BackupService');
    const parsed = BackupService.parseAndValidateBackup(
      JSON.stringify(legacy),
    );
    const summary = await BackupService.restoreBackup(parsed);
    expect(summary.products).toBe(1);
    // فاتورة بلا قناة = نقدي (افتراض العمود) لا خطأ.
    const sale = await db.execute(
      "SELECT payment_method, edit_count FROM sales WHERE invoice_number = 'INV-OLD-0001'",
    );
    expect((sale.rows as any[])[0].payment_method).toBe('cash');
    expect(Number((sale.rows as any[])[0].edit_count)).toBe(0);
  });
});
