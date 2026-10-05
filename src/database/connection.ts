/**
 * SQLite connection (op-sqlite JSI) + schema bootstrap.
 * ─────────────────────────────────────────────────────────────────
 * WAL journal + foreign keys ON, exact schema from the spec, plus a
 * first-run seed of default Arabic categories.
 */
import {open, type DB} from '@op-engineering/op-sqlite';
import {DB_NAME, DEFAULT_UNITS, STANDARD_UNITS_V5} from '../core/config';
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
  `CREATE TABLE IF NOT EXISTS units (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    short_name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL DEFAULT 'piece'
  )`,
  `CREATE TABLE IF NOT EXISTS product_units (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    unit_id INTEGER NOT NULL,
    conversion REAL NOT NULL DEFAULT 1,
    barcode TEXT,
    retail_price REAL,
    wholesale_price REAL,
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE,
    FOREIGN KEY(unit_id) REFERENCES units(id) ON DELETE CASCADE,
    UNIQUE(product_id, unit_id)
  )`,
  `CREATE TABLE IF NOT EXISTS stocktakes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    status TEXT NOT NULL DEFAULT 'open',
    note TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS stocktake_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stocktake_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    system_qty REAL NOT NULL DEFAULT 0,
    counted_qty REAL,
    FOREIGN KEY(stocktake_id) REFERENCES stocktakes(id) ON DELETE CASCADE,
    FOREIGN KEY(product_id) REFERENCES products(id),
    UNIQUE(stocktake_id, product_id)
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
    barcode TEXT,
    -- v8.3 (round-12 #4): 1 = sold BY WEIGHT — prices are per kilo,
    -- stock is fractional kilograms and the POS opens a weight pad
    -- instead of counting pieces (the professional grocery pattern:
    -- Loyverse / Square scale-weighed products).
    sold_by_weight INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(category_id) REFERENCES categories(id)
  )`,
  `CREATE TABLE IF NOT EXISTS product_embeddings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    embedding_data TEXT NOT NULL,
    angle_label TEXT,
    thumbnail_path TEXT,
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
  'CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id)',
  'CREATE INDEX IF NOT EXISTS idx_products_name ON products(name)',
  'CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode)',
  'CREATE INDEX IF NOT EXISTS idx_product_units_product ON product_units(product_id)',
  'CREATE INDEX IF NOT EXISTS idx_product_units_barcode ON product_units(barcode)',
  'CREATE INDEX IF NOT EXISTS idx_stocktakes_status ON stocktakes(status)',
  'CREATE INDEX IF NOT EXISTS idx_stocktake_items_session ON stocktake_items(stocktake_id)',
  'CREATE INDEX IF NOT EXISTS idx_embeddings_product ON product_embeddings(product_id)',
  'CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at)',
  'CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id)',
  'CREATE INDEX IF NOT EXISTS idx_sale_items_product ON sale_items(product_id)',
  // ── v11 (SILA debt integration — SILA_POS_API §7) ────────────
  `CREATE TABLE IF NOT EXISTS sila_debt_queue (
    local_id INTEGER PRIMARY KEY AUTOINCREMENT,
    idempotency_key TEXT NOT NULL UNIQUE,
    customer_id TEXT,
    customer_name TEXT,
    customer_phone_last4 TEXT,
    customer_card TEXT,
    offline_qr TEXT,
    amount_minor INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'ILS',
    pos_invoice_ref TEXT NOT NULL UNIQUE,
    description TEXT,
    scanned_at TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending'
      CHECK (state IN ('pending','syncing','synced','failed')),
    reference_code TEXT,
    transaction_id TEXT,
    outstanding_after INTEGER,
    synced_at TEXT,
    error_code TEXT,
    error_message TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS sila_customers (
    customer_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone_last4 TEXT,
    id_number TEXT,
    outstanding_minor INTEGER NOT NULL DEFAULT 0,
    last_synced_at TEXT
  )`,
  // ── v15 (round-21 #3 — SILA_POS_DEBT_SEPARATION §3.1) ────────
  // The repayments queue: cashier-received payments uploaded to
  // /api/pos/payments with ONE idempotency key per receipt — the
  // missing upload path that made balances diverge (سداد عند
  // الكاشير لم يكن يُرفع أبداً لصِلة).
  `CREATE TABLE IF NOT EXISTS sila_payment_queue (
    local_id INTEGER PRIMARY KEY AUTOINCREMENT,
    idempotency_key TEXT NOT NULL UNIQUE,
    customer_id TEXT,
    customer_name TEXT,
    customer_phone_last4 TEXT,
    amount_minor INTEGER NOT NULL,
    payment_method TEXT NOT NULL DEFAULT 'cash',
    pos_receipt_ref TEXT NOT NULL UNIQUE,
    description TEXT,
    paid_at TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending'
      CHECK (state IN ('pending','syncing','synced','failed')),
    reference_code TEXT,
    transaction_id TEXT,
    outstanding_after INTEGER,
    synced_at TEXT,
    error_code TEXT,
    error_message TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  'CREATE INDEX IF NOT EXISTS idx_sila_dq_state ON sila_debt_queue(state, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_sila_pq_state ON sila_payment_queue(state, created_at)',
  // ── v16 (round-22 #4): the STORE-LOCAL debt book — customers of
  // this store with ID number / name / phone, their debts (INV-L
  // series) and repayments (RCP-L series). NEVER uploaded to صِلة;
  // the migration path re-registers them as fresh INV-D debts.
  `CREATE TABLE IF NOT EXISTS local_customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    id_number TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    phone TEXT,
    notes TEXT,
    sila_customer_id TEXT,
    sila_linked_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS local_debts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    local_customer_id INTEGER NOT NULL REFERENCES local_customers(id) ON DELETE CASCADE,
    invoice_ref TEXT NOT NULL UNIQUE,
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    description TEXT,
    migrated INTEGER NOT NULL DEFAULT 0,
    migrated_ref TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS local_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    local_customer_id INTEGER NOT NULL REFERENCES local_customers(id) ON DELETE CASCADE,
    receipt_ref TEXT NOT NULL UNIQUE,
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    method TEXT NOT NULL DEFAULT 'cash'
      CHECK (method IN ('cash','card','other')),
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  'CREATE INDEX IF NOT EXISTS idx_local_debts_cust ON local_debts(local_customer_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_local_pays_cust ON local_payments(local_customer_id, created_at DESC)',
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
 * v3 (sela 3.0): units system + product barcodes + stocktake tables.
 * v4 (sela 8.3): products.sold_by_weight (weight-sold products —
 *                prices per kilo, fractional kg stock) + the وقية
 *                (250 g) regional unit joins the seed catalog.
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

  if (version < 3) {
    const productsCols = await database.execute(
      "SELECT COUNT(*) AS cnt FROM pragma_table_info('products') WHERE name = 'barcode'",
    );
    const hasBarcode =
      (productsCols.rows?._array?.[0] as {cnt?: number})?.cnt ?? 0;
    if (!hasBarcode) {
      await database.execute('ALTER TABLE products ADD COLUMN barcode TEXT');
    }

    const saleItemsCols = await database.execute(
      "SELECT COUNT(*) AS cnt FROM pragma_table_info('sale_items') WHERE name = 'unit_name'",
    );
    const hasUnitName =
      (saleItemsCols.rows?._array?.[0] as {cnt?: number})?.cnt ?? 0;
    if (!hasUnitName) {
      await database.execute(
        'ALTER TABLE sale_items ADD COLUMN unit_name TEXT',
      );
      await database.execute(
        'ALTER TABLE sale_items ADD COLUMN base_quantity REAL',
      );
    }

    // New v3 tables (also in DDL for fresh installs — IF NOT EXISTS both ways).
    await database.execute(
      `CREATE TABLE IF NOT EXISTS units (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        short_name TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0
      )`,
    );
    await database.execute(
      `CREATE TABLE IF NOT EXISTS product_units (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL,
        unit_id INTEGER NOT NULL,
        conversion REAL NOT NULL DEFAULT 1,
        barcode TEXT,
        retail_price REAL,
        wholesale_price REAL,
        FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE,
        FOREIGN KEY(unit_id) REFERENCES units(id) ON DELETE CASCADE,
        UNIQUE(product_id, unit_id)
      )`,
    );
    await database.execute(
      `CREATE TABLE IF NOT EXISTS stocktakes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME,
        status TEXT NOT NULL DEFAULT 'open',
        note TEXT
      )`,
    );
    await database.execute(
      `CREATE TABLE IF NOT EXISTS stocktake_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stocktake_id INTEGER NOT NULL,
        product_id INTEGER NOT NULL,
        system_qty REAL NOT NULL DEFAULT 0,
        counted_qty REAL,
        FOREIGN KEY(stocktake_id) REFERENCES stocktakes(id) ON DELETE CASCADE,
        FOREIGN KEY(product_id) REFERENCES products(id),
        UNIQUE(stocktake_id, product_id)
      )`,
    );
    await database.execute(
      'CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode)',
    );
    await database.execute(
      'CREATE INDEX IF NOT EXISTS idx_product_units_product ON product_units(product_id)',
    );
    await database.execute(
      'CREATE INDEX IF NOT EXISTS idx_stocktakes_status ON stocktakes(status)',
    );
    await database.execute(
      'CREATE INDEX IF NOT EXISTS idx_stocktake_items_session ON stocktake_items(stocktake_id)',
    );
    logDiag('db', 'ترحيل v3: الوحدات والباركود والجرد');
    version = 3;
  }

  if (version < 4) {
    // v8.3 (round-12 #4): the weight-sold flag.
    const cols = await database.execute(
      "SELECT COUNT(*) AS cnt FROM pragma_table_info('products') WHERE name = 'sold_by_weight'",
    );
    const hasWeight = (cols.rows?._array?.[0] as {cnt?: number})?.cnt ?? 0;
    if (!hasWeight) {
      await database.execute(
        'ALTER TABLE products ADD COLUMN sold_by_weight INTEGER NOT NULL DEFAULT 0',
      );
    }
    // The regional 250 g unit (وقية) joins every existing install so
    // weight products can price a quarter-kilo out of the box.
    const wakfCount = await database.execute(
      "SELECT COUNT(*) AS cnt FROM units WHERE name = 'وقية'",
    );
    const wakfRow = (wakfCount.rows?._array?.[0] as {cnt?: number})?.cnt ?? 0;
    if (wakfRow === 0) {
      const maxOrder = await database.execute(
        'SELECT MAX(sort_order) AS mx FROM units',
      );
      const mx = (maxOrder.rows?._array?.[0] as {mx?: number | null})?.mx ?? 0;
      await database.execute(
        'INSERT INTO units (name, short_name, sort_order) VALUES (?, ?, ?)',
        ['وقية', 'وقية', Number(mx) + 1],
      );
    }
    logDiag('db', 'ترحيل v4: منتجات الوزن + وحدة الوقية');
    version = 4;
  }

  if (version < 5) {
    // v9.2 (round-15 #3): units.kind — the unit TYPE (piece /
    // weight / volume / length) so weight products offer weight
    // units (وقية، رطل…) and piece products offer packaging units
    // (كرتونة، علبة…).
    const kindCols = await database.execute(
      "SELECT COUNT(*) AS cnt FROM pragma_table_info('units') WHERE name = 'kind'",
    );
    const hasKind = (kindCols.rows?._array?.[0] as {cnt?: number})?.cnt ?? 0;
    if (!hasKind) {
      await database.execute(
        "ALTER TABLE units ADD COLUMN kind TEXT NOT NULL DEFAULT 'piece'",
      );
    }
    // Classify every EXISTING unit by its name (old installs).
    const kindByName: Record<string, string> = {
      كيلوغرام: 'weight',
      كيلو: 'weight',
      غرام: 'weight',
      وقية: 'weight',
      'نصف كيلو': 'weight',
      رطل: 'weight',
      أونصة: 'weight',
      لتر: 'volume',
      مليلتر: 'volume',
      جالون: 'volume',
      متر: 'length',
      سنتيمتر: 'length',
    };
    for (const [name, kind] of Object.entries(kindByName)) {
      await database.execute('UPDATE units SET kind = ? WHERE name = ?', [
        kind,
        name,
      ]);
    }
    // Top up the FULL standard catalog (names that don't exist yet
    // are inserted with their kind; existing ones keep their id).
    for (const unit of STANDARD_UNITS_V5) {
      const existing = await database.execute(
        'SELECT id FROM units WHERE name = ? COLLATE NOCASE',
        [unit.name],
      );
      const hit = existing.rows?._array?.[0] as {id?: number} | undefined;
      if (hit?.id == null) {
        await database.execute(
          'INSERT INTO units (name, short_name, sort_order, kind) VALUES (?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM units), ?)',
          [unit.name, unit.short, unit.kind],
        );
      }
    }
    logDiag('db', 'ترحيل v5: أنواع الوحدات + كتالوج الوحدات الكامل');
    version = 5;
  }

  if (version < 6) {
    // v11 (SILA §7): debt queue + customers cache. Fresh DDL above
    // already covers new installs; this heals older ones.
    await database.execute(
      `CREATE TABLE IF NOT EXISTS sila_debt_queue (
        local_id INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT NOT NULL UNIQUE,
        customer_id TEXT,
        customer_name TEXT,
        customer_phone_last4 TEXT,
        customer_card TEXT,
        offline_qr TEXT,
        amount_minor INTEGER NOT NULL,
        currency TEXT NOT NULL DEFAULT 'ILS',
        pos_invoice_ref TEXT NOT NULL UNIQUE,
        description TEXT,
        scanned_at TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending'
          CHECK (state IN ('pending','syncing','synced','failed')),
        reference_code TEXT,
        transaction_id TEXT,
        outstanding_after INTEGER,
        synced_at TEXT,
        error_code TEXT,
        error_message TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await database.execute(
      `CREATE TABLE IF NOT EXISTS sila_customers (
        customer_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        phone_last4 TEXT,
        id_number TEXT,
        outstanding_minor INTEGER NOT NULL DEFAULT 0,
        last_synced_at TEXT
      )`,
    );
    await database.execute(
      'CREATE INDEX IF NOT EXISTS idx_sila_dq_state ON sila_debt_queue(state, created_at)',
    );
    logDiag('db', 'ترحيل v6: جداول ديون صِلة (الطابور + ذاكرة الزبائن)');
    version = 6;
  }

  if (version < 7) {
    // v14 (round-20 #4): product_embeddings.thumbnail_path — the
    // enrollment PHOTO of each angle was never persisted, so
    // reopening a registered product showed the three angle tiles
    // as empty camera placeholders («لا تظهر صور الأمامية والخلفية
    // والجانبية رغم أن المنتج مسجل»). The thumbnail now lives
    // beside its fingerprint and reloads with the form.
    const embCols = await database.execute(
      "SELECT COUNT(*) AS cnt FROM pragma_table_info('product_embeddings') WHERE name = 'thumbnail_path'",
    );
    const hasThumb = (embCols.rows?._array?.[0] as {cnt?: number})?.cnt ?? 0;
    if (!hasThumb) {
      await database.execute(
        'ALTER TABLE product_embeddings ADD COLUMN thumbnail_path TEXT',
      );
      logDiag('db', 'ترحيل v7: عمود صور بصمات المنتج (thumbnail_path)');
    }
    version = 7;
  }

  if (version < 8) {
    // v15 (round-21 #3 — SILA_POS_DEBT_SEPARATION §3.1/§2.4):
    // origin-split balances per customer so store debts and Sila-app
    // debts never mix again, plus the payments queue table.
    await database.execute(
      `CREATE TABLE IF NOT EXISTS sila_payment_queue (
        local_id INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT NOT NULL UNIQUE,
        customer_id TEXT,
        customer_name TEXT,
        customer_phone_last4 TEXT,
        amount_minor INTEGER NOT NULL,
        payment_method TEXT NOT NULL DEFAULT 'cash',
        pos_receipt_ref TEXT NOT NULL UNIQUE,
        description TEXT,
        paid_at TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending'
          CHECK (state IN ('pending','syncing','synced','failed')),
        reference_code TEXT,
        transaction_id TEXT,
        outstanding_after INTEGER,
        synced_at TEXT,
        error_code TEXT,
        error_message TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await database.execute(
      'CREATE INDEX IF NOT EXISTS idx_sila_pq_state ON sila_payment_queue(state, created_at)',
    );
    // sila_customers split columns (§2.4 FIFO-origin fields).
    const splitCols: [string, string][] = [
      ['pos_outstanding_minor', 'INTEGER NOT NULL DEFAULT 0'],
      ['app_outstanding_minor', 'INTEGER NOT NULL DEFAULT 0'],
      ['other_minor', 'INTEGER NOT NULL DEFAULT 0'],
      ['pos_purchases_minor', 'INTEGER NOT NULL DEFAULT 0'],
      ['app_purchases_minor', 'INTEGER NOT NULL DEFAULT 0'],
      ['last_payment_at', 'TEXT'],
      ['last_payment_amount_minor', 'INTEGER'],
    ];
    for (const [column, ddl] of splitCols) {
      const check = await database.execute(
        "SELECT COUNT(*) AS cnt FROM pragma_table_info('sila_customers') WHERE name = ?",
        [column],
      );
      const has = (check.rows?._array?.[0] as {cnt?: number})?.cnt ?? 0;
      if (!has) {
        await database.execute(
          `ALTER TABLE sila_customers ADD COLUMN ${column} ${ddl}`,
        );
      }
    }
    logDiag(
      'db',
      'ترحيل v8: فصل أصول الديون (متجر/تطبيق) + طابور سدادّات صِلة',
    );
    version = 8;
  }

  if (version < 9) {
    // v16 (round-22 #4): the STORE-LOCAL debt book — accounts for
    // customers recorded by ID number / name / phone with debts and
    // repayments that never leave this device (fresh DDL above
    // covers new installs; this heals older ones).
    await database.execute(
      `CREATE TABLE IF NOT EXISTS local_customers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        id_number TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        phone TEXT,
        notes TEXT,
        sila_customer_id TEXT,
        sila_linked_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await database.execute(
      `CREATE TABLE IF NOT EXISTS local_debts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        local_customer_id INTEGER NOT NULL REFERENCES local_customers(id) ON DELETE CASCADE,
        invoice_ref TEXT NOT NULL UNIQUE,
        amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
        description TEXT,
        migrated INTEGER NOT NULL DEFAULT 0,
        migrated_ref TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await database.execute(
      `CREATE TABLE IF NOT EXISTS local_payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        local_customer_id INTEGER NOT NULL REFERENCES local_customers(id) ON DELETE CASCADE,
        receipt_ref TEXT NOT NULL UNIQUE,
        amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
        method TEXT NOT NULL DEFAULT 'cash'
          CHECK (method IN ('cash','card','other')),
        note TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await database.execute(
      'CREATE INDEX IF NOT EXISTS idx_local_debts_cust ON local_debts(local_customer_id, created_at DESC)',
    );
    await database.execute(
      'CREATE INDEX IF NOT EXISTS idx_local_pays_cust ON local_payments(local_customer_id, created_at DESC)',
    );
    logDiag('db', 'ترحيل v9: دفتر ديون المتجر المحلي (زبائن + ديون + سدادّات)');
    version = 9;
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
      const countResult = await db.execute(
        'SELECT COUNT(*) AS cnt FROM categories',
      );
      const countRow = countResult.rows?._array?.[0] as
        | {cnt?: number}
        | undefined;
      if ((countRow?.cnt ?? 0) === 0) {
        for (const name of DEFAULT_CATEGORIES) {
          await db.execute('INSERT INTO categories (name) VALUES (?)', [name]);
        }
        logDiag('db', `تمت إضافة ${DEFAULT_CATEGORIES.length} فئات افتراضية`);
      }
      // Seed the default unit catalog (قطعة، كرتونة، كيلو…).
      const unitsCount = await db.execute('SELECT COUNT(*) AS cnt FROM units');
      const unitsRow = unitsCount.rows?._array?.[0] as
        | {cnt?: number}
        | undefined;
      if ((unitsRow?.cnt ?? 0) === 0) {
        let order = 0;
        for (const unit of DEFAULT_UNITS) {
          await db.execute(
            'INSERT INTO units (name, short_name, sort_order, kind) VALUES (?, ?, ?, ?)',
            [unit.name, unit.short, order++, unit.kind],
          );
        }
        logDiag('db', `تمت إضافة ${DEFAULT_UNITS.length} وحدات افتراضية`);
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
  await database.execute('DELETE FROM stocktake_items');
  await database.execute('DELETE FROM stocktakes');
  await database.execute('DELETE FROM sale_items');
  await database.execute('DELETE FROM sales');
  await database.execute('DELETE FROM product_embeddings');
  await database.execute('DELETE FROM product_units');
  await database.execute('DELETE FROM products');
  await database.execute('DELETE FROM categories');
  await database.execute('DELETE FROM units');
  await database.execute('DELETE FROM sila_customers');
  await database.execute('DELETE FROM sila_debt_queue');
  await database.execute('DELETE FROM sila_payment_queue');
  await database.execute('DELETE FROM local_payments');
  await database.execute('DELETE FROM local_debts');
  await database.execute('DELETE FROM local_customers');
  await database.execute(
    "DELETE FROM sqlite_sequence WHERE name IN ('categories','units','products','product_embeddings','product_units','sales','sale_items','stocktakes','stocktake_items','sila_debt_queue','sila_payment_queue','local_customers','local_debts','local_payments')",
  );
  logDiag('db', 'تم حذف جميع البيانات بناءً على طلب المستخدم', 'warn');
}

export function toMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
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
    if (candidate.message) {
      return candidate.message;
    }
    if (candidate.code) {
      return `${fallback} (${candidate.code})`;
    }
  }
  if (typeof error === 'string' && error.length > 0) {
    return error;
  }
  return fallback;
}
