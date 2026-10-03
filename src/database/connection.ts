/**
 * SQLite connection (op-sqlite JSI) + schema bootstrap.
 * ─────────────────────────────────────────────────────────────────
 * WAL journal + foreign keys ON, exact schema from the spec, plus a
 * first-run seed of default Arabic categories.
 */
import {open, type DB} from '@op-engineering/op-sqlite';
import {DB_NAME} from '../core/config';
import {logDiag} from '../core/diagnostics';
import {storage, getNumber, KEYS} from '../storage/storage';

let db: DB | null = null;

export function getDb(): DB {
  if (db == null) {
    throw new Error('قاعدة البيانات لم تُهيّأ بعد — أعد تشغيل التطبيق');
  }
  return db;
}

const DDL_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    cost_price REAL NOT NULL,
    retail_price REAL NOT NULL,
    wholesale_price REAL NOT NULL,
    stock_quantity INTEGER NOT NULL DEFAULT 0,
    category_id INTEGER,
    image_uri TEXT,
    low_stock_threshold INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(category_id) REFERENCES categories(id)
  )`,
  `CREATE TABLE IF NOT EXISTS product_embeddings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    embedding_data TEXT NOT NULL,
    angle_label TEXT,
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_number TEXT UNIQUE,
    total_amount REAL NOT NULL,
    total_cost REAL NOT NULL,
    total_profit REAL NOT NULL,
    discount REAL DEFAULT 0,
    payment_type TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS sale_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    unit_price REAL NOT NULL,
    cost_price REAL NOT NULL,
    total_line_price REAL NOT NULL,
    FOREIGN KEY(sale_id) REFERENCES sales(id),
    FOREIGN KEY(product_id) REFERENCES products(id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id)`,
  `CREATE INDEX IF NOT EXISTS idx_products_name ON products(name)`,
  `CREATE INDEX IF NOT EXISTS idx_embeddings_product ON product_embeddings(product_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sale_items_product ON sale_items(product_id)`,
];

const DEFAULT_CATEGORIES: string[] = [
  'مشروبات',
  'شوكولاتة وحلويات',
  'معلبات وبقالة',
  'ألبان وأجبان',
  'خبز ومخبوزات',
  'منتجات متنوعة',
];

/**
 * Forward-only schema migrations, versioned in MMKV.
 * v2 (Sela 2.0): products.low_stock_threshold for per-product alerts.
 */
async function applyMigrations(database: DB): Promise<void> {
  const storedVersion = getNumber(KEYS.schemaVersion, 0);
  let version: number = storedVersion > 0 ? storedVersion : 1;

  if (version < 2) {
    const existing = await database.execute(
      "SELECT COUNT(*) AS cnt FROM pragma_table_info('products') WHERE name = 'low_stock_threshold'",
    );
    const hasColumn = (existing.rows?._array?.[0] as {cnt?: number})?.cnt ?? 0;
    if (!hasColumn) {
      await database.execute(
        'ALTER TABLE products ADD COLUMN low_stock_threshold INTEGER',
      );
      logDiag('db', 'ترحيل v2: أُضيف عمود حد المخزون المنخفض');
    }
    version = 2;
  }

  if (version !== storedVersion) {
    storage.set(KEYS.schemaVersion, version as number);
  }
}

/**
 * Opens the database, applies the schema and seeds default categories.
 * Safe to call multiple times (idempotent).
 */
export async function initDatabase(): Promise<void> {
  if (db != null) {
    return;
  }
  try {
    db = open({name: DB_NAME});

    // Performance pragmas — WAL keeps reads fast while a sale writes.
    db.execute('PRAGMA journal_mode = WAL;');
    db.execute('PRAGMA foreign_keys = ON;');

    for (const statement of DDL_STATEMENTS) {
      await db.execute(statement);
    }

    await applyMigrations(db);

    const seeded = storage.getBoolean(KEYS.seededFlag);
    if (!seeded) {
      const countResult = await db.execute('SELECT COUNT(*) AS cnt FROM categories');
      const countRow = countResult.rows?._array?.[0] as {cnt?: number} | undefined;
      if ((countRow?.cnt ?? 0) === 0) {
        for (const name of DEFAULT_CATEGORIES) {
          await db.execute('INSERT INTO categories (name) VALUES (?)', [name]);
        }
        logDiag('db', `تمت إضافة ${DEFAULT_CATEGORIES.length} فئات افتراضية`);
      }
      storage.set(KEYS.seededFlag, true);
    }

    logDiag('db', 'قاعدة البيانات جاهزة');
  } catch (error) {
    logDiag('db', `فشل تهيئة قاعدة البيانات: ${toMessage(error)}`, 'error');
    throw error;
  }
}

/** DANGEROUS: wipes all business data (used by Settings → reset). */
export async function wipeAllData(): Promise<void> {
  const database = getDb();
  await database.execute('DELETE FROM sale_items');
  await database.execute('DELETE FROM sales');
  await database.execute('DELETE FROM product_embeddings');
  await database.execute('DELETE FROM products');
  await database.execute('DELETE FROM categories');
  await database.execute("DELETE FROM sqlite_sequence WHERE name IN ('categories','products','product_embeddings','sales','sale_items')");
  logDiag('db', 'تم حذف جميع البيانات بناءً على طلب المستخدم', 'warn');
}

export function toMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** Extracts a readable message from native promise rejections. */
export function nativeErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object') {
    const candidate = error as {message?: string; code?: string};
    if (candidate.message) return candidate.message;
    if (candidate.code) return `${fallback} (${candidate.code})`;
  }
  if (typeof error === 'string' && error.length > 0) return error;
  return fallback;
}
