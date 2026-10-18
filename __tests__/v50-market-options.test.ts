/**
 * v50 — خيارات الشراء في سيلا ماركت (خادم 4.3).
 * ─────────────────────────────────────────────────────────────────
 * حرّوس الجسر الكامل بين متغيرات المنتج في POS وخيارات الشراء
 * التي يراها المشتري في تطبيق المتجر:
 *
 * ① ترحيل v25: جدول أسطر الطلبات الأونلاين يُعاد بناؤه بعمود
 *    variant وفهرس تفريد تعبيري (طلب، منتج، خيار) — المنتج نفسه
 *    بخيارين سطران، والبيانات القديمة تُنقل سالمة.
 * ② بناء الخيارات: متغيرات الملابس (لون × مقاس) → مجموعات خيارات،
 *    والأحجام المطعمية (سعر لكل حجم) تُستثنى عمداً.
 * ③ المزامنة: unitLabel (وحدة البيع) وخيارات الشراء تُرسلان.
 * ④ الاستطلاع: variant يُخزَّن مع كل سطر ويُعرض للتاجر.
 * ⑤ الإرسال: سطران للمنتج نفسه بخيارين مختلفين لا يطمس أحدهما
 *    الآخر (مفتاح يشمل الخيار + الاسم يحمله).
 * ⑥ الإصدار: 59.0.0 (67).
 */
import {freshApp, tempDb} from './helpers/app';
import fs from 'fs';

const read = (path: string) =>
  require('fs').readFileSync(path, 'utf8') as string;

/** شكل الجدول كما كان في v48/v49 (بلا variant مع UNIQUE قديم). */
const ONLINE_ITEMS_V49 = `
CREATE TABLE IF NOT EXISTS online_order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_order_id INTEGER NOT NULL,
  product_id INTEGER,
  product_ref TEXT,
  product_name TEXT NOT NULL,
  unit_price_minor INTEGER NOT NULL DEFAULT 0,
  quantity REAL NOT NULL DEFAULT 0,
  line_total_minor INTEGER NOT NULL DEFAULT 0,
  UNIQUE(server_order_id, product_ref)
)`;

const ONLINE_ORDERS_CORE = `
CREATE TABLE IF NOT EXISTS online_orders (
  server_id INTEGER PRIMARY KEY,
  order_number TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'new',
  customer_name TEXT NOT NULL DEFAULT '',
  customer_phone TEXT NOT NULL DEFAULT '',
  customer_id_number TEXT NOT NULL DEFAULT '',
  region_name TEXT,
  address TEXT,
  note TEXT,
  delivery_fee_minor INTEGER NOT NULL DEFAULT 0,
  items_total_minor INTEGER NOT NULL DEFAULT 0,
  total_minor INTEGER NOT NULL DEFAULT 0,
  returned_minor INTEGER NOT NULL DEFAULT 0,
  invoice_ref TEXT,
  sale_id INTEGER,
  reject_reason TEXT,
  cancel_reason TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  server_created_at INTEGER NOT NULL DEFAULT 0,
  server_updated_at INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

describe('v50 — خيارات الشراء في سيلا ماركت', () => {
  test('① ترحيل v25: بناء بديل بعمود variant وفهرس تفريد تعبيري', async () => {
    // قاعدة بيانات ملف قديمة (شكل v49) ببيانات قائمة.
    const file = tempDb('v50');
    const raw = require('node:sqlite').DatabaseSync;
    const old = new raw(file);
    old.exec(ONLINE_ORDERS_CORE);
    old.exec(ONLINE_ITEMS_V49);
    old.exec(`INSERT INTO online_orders (server_id, order_number)
              VALUES (7, 'ORD-20261012-000001')`);
    old.exec(`INSERT INTO online_order_items
                (server_order_id, product_id, product_ref, product_name,
                 unit_price_minor, quantity, line_total_minor)
              VALUES (7, 12, '12', 'قميص قطن', 5900, 2, 11800)`);
    old.close();

    const app = freshApp(file);
    await expect(app.connection.initDatabase()).resolves.toBeUndefined();
    const db = app.connection.getDb();

    // العمود الجديد موجود والبيانات القديمة سليمة.
    const cols = (db.execute('PRAGMA table_info(online_order_items)')
      .rows as {name: string}[]).map(r => String(r.name));
    expect(cols).toContain('variant');
    const row = db.execute(
      "SELECT product_name, variant, line_total_minor FROM online_order_items WHERE server_order_id = 7",
    ).rows[0] as {product_name: string; variant: string | null};
    expect(row.product_name).toBe('قميص قطن');
    expect(row.variant).toBeNull();
    expect(Number(row.line_total_minor)).toBe(11800);

    // فهرس التفريد التعبيري: نفس المنتج بخيارين سطران، والخيار
    // نفسه مكرراً يُرفض.
    db.execute(`INSERT INTO online_order_items
                  (server_order_id, product_ref, product_name, variant, unit_price_minor, quantity, line_total_minor)
                VALUES (7, '12', 'قميص قطن', 'المقاس: L', 5900, 1, 5900)`);
    db.execute(`INSERT INTO online_order_items
                  (server_order_id, product_ref, product_name, variant, unit_price_minor, quantity, line_total_minor)
                VALUES (7, '12', 'قميص قطن', 'المقاس: XL', 5900, 1, 5900)`);
    const count = (db.execute(
      "SELECT COUNT(*) AS n FROM online_order_items WHERE server_order_id = 7",
    ).rows[0] as {n: number}).n;
    expect(Number(count)).toBe(3); // القديم + خياران مختلفان
    expect(() =>
      db.execute(`INSERT INTO online_order_items
                    (server_order_id, product_ref, product_name, variant, unit_price_minor, quantity, line_total_minor)
                  VALUES (7, '12', 'قميص قطن', 'المقاس: L', 5900, 1, 5900)`),
    ).toThrow();
    try {
      fs.rmSync(file, {force: true});
    } catch {
      // Ignore.
    }
  });

  test('① fresh install: التفريد التعبيري موجود من الدرج', async () => {
    const app = freshApp();
    await expect(app.connection.initDatabase()).resolves.toBeUndefined();
    const db = app.connection.getDb();
    const idx = db.execute(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_online_items_variant_unique'",
    ).rows as {name: string}[];
    expect(idx.length).toBe(1);
  });

  test('② بناء الخيارات: ملابس فقط، والمخزون الصفري مستبعد', () => {
    const service = read('src/services/online/OnlineStoreService.ts');
    // مجموعات اللون والمقاس من متغيرات kind='variant'.
    expect(service).toContain("groups.push({name: 'اللون', values: colors.slice(0, 12)})");
    expect(service).toContain("groups.push({name: 'المقاس', values: sizes.slice(0, 12)})");
    // الأحجام المطعمية مستثنية عمداً (سعر مختلف لكل حجم).
    expect(service).toContain("v.kind === 'variant'");
    // لا خيارات لمنتج بلا متغيرات ملابس.
    expect(service).toContain('return groups.length > 0 ? groups : undefined');
  });

  test('③ المزامنة: unitLabel + options في الحمولة', () => {
    const service = read('src/services/online/OnlineStoreService.ts');
    expect(service).toContain('unitLabel: product.base_unit_name ?? undefined');
    expect(service).toContain('options: marketOptionsOf(product, variantsByProduct)');
    expect(service).toContain('const variantsByProduct = await VariantRepo.listAll()');
    const api = read('src/services/online/OnlineApi.ts');
    expect(api).toContain('options?: {name: string; values: string[]}[]');
  });

  test('④ الاستطلاع والتخزين: variant مع كل سطر + عرضه للتاجر', () => {
    const repo = read('src/database/repositories/OnlineRepo.ts');
    expect(repo).toContain('variant: (row.variant as string) ?? null');
    expect(repo).toContain('item.variant ?? null');
    const types = read('src/core/types.ts');
    expect(types).toContain('variant?: string | null');
    const screen = read('src/screens/online/OnlineOrdersScreen.tsx');
    expect(screen).toContain('styles.itemVariant');
    expect(screen).toContain('{item.variant ? (');
  });

  test('⑤ الإرسال: مفتاح السطر يشمل الخيار والاسم يحمله', () => {
    const service = read('src/services/online/OnlineStoreService.ts');
    expect(service).toContain('key: `online-${item.product_ref}-${variantTag}`');
    expect(service).toContain('`${product.name} — ${variantTag}`');
  });

  test('⑥ الإصدار: 59.0.0 (67) في config والبناء', () => {
    const config = read('src/core/config.ts');
    expect(config).toContain("APP_VERSION = '59.0.0'");
    expect(config).toContain('APP_BUILD_CODE = 67');
    const gradle = read('android/app/build.gradle');
    expect(gradle).toContain('versionName "59.0.0"');
    expect(gradle).toContain('versionCode 67');
  });
});
