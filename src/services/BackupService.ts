/**
 * BackupService — full JSON backup & restore (v6).
 * ─────────────────────────────────────────────────────────────────
 * One file carries EVERYTHING needed to move the shop to a new device
 * or recover after a reinstall:
 *
 *   - categories + units          (with their original ids)
 *   - products                    (prices, stock, thresholds, barcode)
 *   - product_units               (sellable units + conversion + prices)
 *   - product_embeddings          (the vision fingerprints)
 *   - sales + sale_items          (full history with item lines)
 *   - stocktakes + items          (inventory count sessions)
 *   - settings                    (store info, scanner, receipts…)
 *
 * Export writes a pretty JSON into Downloads/SmartVisionPOS via the
 * native MediaStore exporter. Import opens the system file picker
 * (SAF), reads the same format and restores in ONE SQLite
 * transaction — either the whole backup lands or nothing changes.
 *
 * Format: { "app": "sela", "backupVersion": 2, ... }
 *
 * v8.3 (round-12 #3): the backup now EMBEDS the product images as
 * base64 ("images") — v1 carried only file PATHS, so a restore on a
 * new device or after a reinstall brought products back with dead
 * image references and no picture. Restore writes fresh image files
 * and repoints every product's image_uri at them. Also carries
 * sold_by_weight (weight-sold products).
 */
import {getDb, toMessage} from '../database/connection';
import {requirePlatformUtils} from '../native/nativeBridge';
import {getSettings, useSettingsStore} from '../stores/settingsStore';
import {
  APP_VERSION,
  APP_BUILD_CODE,
  EMBEDDING_MODEL_VERSION,
} from '../core/config';
import {InvoiceService} from './InvoiceService';
import {logDiag} from '../core/diagnostics';
import type {AppSettings} from '../stores/settingsStore';

const BACKUP_VERSION = 2;
const JSON_MIME = 'application/json';

export interface BackupSummary {
  categories: number;
  units: number;
  products: number;
  productUnits: number;
  embeddings: number;
  sales: number;
  createdAt: string;
}

interface BackupFile {
  app: string;
  backupVersion: number;
  createdAt: string;
  appVersion: string;
  /** v10 (round-16 #4): the embedding-model generation the
   *  fingerprints were built with — a mismatched generation is
   *  SKIPPED on restore (vectors from another model live in a
   *  different space and would poison matching). */
  embeddingModelVersion?: number;
  categories: {id: number; name: string}[];
  units: {
    id: number;
    name: string;
    short_name: string;
    sort_order: number;
    /** v9.2 (round-15 #3): the unit type (old backups: undefined). */
    kind?: string;
  }[];
  products: {
    id: number;
    name: string;
    cost_price: number;
    retail_price: number;
    wholesale_price: number;
    stock_quantity: number;
    category_id: number | null;
    image_uri: string | null;
    low_stock_threshold: number | null;
    barcode: string | null;
    sold_by_weight?: number;
    created_at: string;
  }[];
  product_units: {
    product_id: number;
    unit_id: number;
    conversion: number;
    barcode: string | null;
    retail_price: number | null;
    wholesale_price: number | null;
  }[];
  embeddings: {
    product_id: number;
    angle_label: string;
    embedding_data: string;
  }[];
  sales: {
    id: number;
    invoice_number: string;
    total_amount: number;
    total_cost: number;
    total_profit: number;
    discount: number;
    payment_type: string | null;
    created_at: string;
  }[];
  sale_items: {
    sale_id: number;
    product_id: number;
    quantity: number;
    unit_price: number;
    cost_price: number;
    total_line_price: number;
  }[];
  stocktakes: {
    id: number;
    started_at: string;
    completed_at: string | null;
    status: string;
    note: string | null;
  }[];
  stocktake_items: {
    stocktake_id: number;
    product_id: number;
    system_qty: number;
    counted_qty: number | null;
  }[];
  /** v11 (SILA): the debt queue — restoring must bring debts back
   *  (they sync by idempotency_key, safe by design §6.2). */
  sila_debts?: {
    idempotency_key: string;
    customer_id: string | null;
    customer_name: string | null;
    customer_phone_last4: string | null;
    customer_card: string | null;
    offline_qr: string | null;
    amount_minor: number;
    currency: string;
    pos_invoice_ref: string;
    description: string | null;
    scanned_at: string;
    state: 'pending' | 'syncing' | 'synced' | 'failed';
    reference_code: string | null;
    transaction_id: string | null;
    outstanding_after: number | null;
    synced_at: string | null;
    error_code: string | null;
    error_message: string | null;
    retry_count: number;
    created_at: string;
  }[];
  /** v11 (SILA): cached customers balances. */
  sila_customers?: {
    customer_id: string;
    name: string;
    phone_last4: string | null;
    id_number: string | null;
    outstanding_minor: number;
    last_synced_at: string | null;
  }[];
  /** v8.3: embedded product image files (base64 JPEG) — keyed by
   *  `name`, referenced by the products' original image paths. */
  images?: {name: string; data: string}[];
  settings: Partial<AppSettings>;
}

function rowsOf(result: {
  rows?: {_array?: unknown[]};
}): Record<string, unknown>[] {
  return (result.rows?._array ?? []) as Record<string, unknown>[];
}

function nowLocal(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

export const BackupService = {
  /** Builds the backup JSON document from the live database. */
  async buildBackupJson(): Promise<{json: string; summary: BackupSummary}> {
    const db = getDb();

    const [
      categories,
      units,
      products,
      productUnits,
      embeddings,
      sales,
      saleItems,
      stocktakes,
      stocktakeItems,
      silaDebts,
      silaCustomers,
    ] = await Promise.all([
      db.execute('SELECT id, name FROM categories'),
      db.execute('SELECT id, name, short_name, sort_order, kind FROM units'),
      db.execute(
        'SELECT id, name, cost_price, retail_price, wholesale_price, stock_quantity, category_id, image_uri, low_stock_threshold, barcode, sold_by_weight, created_at FROM products',
      ),
      db.execute(
        'SELECT product_id, unit_id, conversion, barcode, retail_price, wholesale_price FROM product_units',
      ),
      db.execute(
        'SELECT product_id, angle_label, embedding_data FROM product_embeddings',
      ),
      db.execute(
        'SELECT id, invoice_number, total_amount, total_cost, total_profit, discount, payment_type, created_at FROM sales',
      ),
      db.execute(
        'SELECT sale_id, product_id, quantity, unit_price, cost_price, total_line_price FROM sale_items',
      ),
      db.execute(
        'SELECT id, started_at, completed_at, status, note FROM stocktakes',
      ),
      db.execute(
        'SELECT stocktake_id, product_id, system_qty, counted_qty FROM stocktake_items',
      ),
      db.execute(
        `SELECT idempotency_key, customer_id, customer_name, customer_phone_last4,
                customer_card, offline_qr, amount_minor, currency, pos_invoice_ref,
                description, scanned_at, state, reference_code, transaction_id,
                outstanding_after, synced_at, error_code, error_message, retry_count, created_at
         FROM sila_debt_queue`,
      ),
      db.execute(
        `SELECT customer_id, name, phone_last4, id_number, outstanding_minor, last_synced_at
         FROM sila_customers`,
      ),
    ]);

    // v8.3 (round-12 #3): embed every product image as base64 so a
    // restore on ANY device brings the pictures back. Files are read
    // through the guarded native helper; a missing/dead file is
    // silently skipped (its path is simply not in the map, and the
    // restore then clears that product's image).
    const images: {name: string; data: string}[] = [];
    try {
      const platform = requirePlatformUtils();
      const seen = new Set<string>();
      for (const row of rowsOf(products)) {
        const uri = row.image_uri == null ? null : String(row.image_uri);
        if (uri == null || uri.length === 0 || seen.has(uri)) {
          continue;
        }
        seen.add(uri);
        try {
          const base64 = await platform.readFileBase64(uri);
          if (base64.length > 0) {
            const name = `img_${images.length}_${uri
              .split('/')
              .pop()
              ?.replace(/[^A-Za-z0-9._-]/g, '_')}`;
            images.push({name, data: base64});
          }
        } catch {
          // Dead path — nothing to embed.
        }
      }
    } catch {
      // Native helper unavailable (old bridge?) — export paths only.
    }

    const doc: BackupFile = {
      app: 'sela',
      backupVersion: BACKUP_VERSION,
      createdAt: new Date().toISOString(),
      appVersion: `${APP_VERSION} (${APP_BUILD_CODE})`,
      categories: rowsOf(categories).map(row => ({
        id: Number(row.id),
        name: String(row.name ?? ''),
      })),
      units: rowsOf(units).map(row => ({
        id: Number(row.id),
        name: String(row.name ?? ''),
        short_name: String(row.short_name ?? ''),
        sort_order: Number(row.sort_order ?? 0),
        kind: String(row.kind ?? 'piece'),
      })),
      products: rowsOf(products).map(row => ({
        id: Number(row.id),
        name: String(row.name ?? ''),
        cost_price: Number(row.cost_price ?? 0),
        retail_price: Number(row.retail_price ?? 0),
        wholesale_price: Number(row.wholesale_price ?? 0),
        stock_quantity: Number(row.stock_quantity ?? 0),
        category_id: row.category_id == null ? null : Number(row.category_id),
        image_uri: row.image_uri == null ? null : String(row.image_uri),
        low_stock_threshold:
          row.low_stock_threshold == null
            ? null
            : Number(row.low_stock_threshold),
        barcode: row.barcode == null ? null : String(row.barcode),
        sold_by_weight: Number(row.sold_by_weight ?? 0) === 1 ? 1 : 0,
        created_at: String(row.created_at ?? ''),
      })),
      product_units: rowsOf(productUnits).map(row => ({
        product_id: Number(row.product_id),
        unit_id: Number(row.unit_id),
        conversion: Number(row.conversion ?? 1),
        barcode: row.barcode == null ? null : String(row.barcode),
        retail_price:
          row.retail_price == null ? null : Number(row.retail_price),
        wholesale_price:
          row.wholesale_price == null ? null : Number(row.wholesale_price),
      })),
      embeddings: rowsOf(embeddings).map(row => ({
        product_id: Number(row.product_id),
        angle_label: String(row.angle_label ?? 'front'),
        embedding_data: String(row.embedding_data ?? '[]'),
      })),
      sales: rowsOf(sales).map(row => ({
        id: Number(row.id),
        invoice_number: String(row.invoice_number ?? ''),
        total_amount: Number(row.total_amount ?? 0),
        total_cost: Number(row.total_cost ?? 0),
        total_profit: Number(row.total_profit ?? 0),
        discount: Number(row.discount ?? 0),
        payment_type:
          row.payment_type == null ? null : String(row.payment_type),
        created_at: String(row.created_at ?? ''),
      })),
      sale_items: rowsOf(saleItems).map(row => ({
        sale_id: Number(row.sale_id),
        product_id: Number(row.product_id),
        quantity: Number(row.quantity ?? 0),
        unit_price: Number(row.unit_price ?? 0),
        cost_price: Number(row.cost_price ?? 0),
        total_line_price: Number(row.total_line_price ?? 0),
      })),
      stocktakes: rowsOf(stocktakes).map(row => ({
        id: Number(row.id),
        started_at: String(row.started_at ?? ''),
        completed_at:
          row.completed_at == null ? null : String(row.completed_at),
        status: String(row.status ?? 'open'),
        note: row.note == null ? null : String(row.note),
      })),
      stocktake_items: rowsOf(stocktakeItems).map(row => ({
        stocktake_id: Number(row.stocktake_id),
        product_id: Number(row.product_id),
        system_qty: Number(row.system_qty ?? 0),
        counted_qty: row.counted_qty == null ? null : Number(row.counted_qty),
      })),
      sila_debts: rowsOf(silaDebts).map(row => ({
        idempotency_key: String(row.idempotency_key ?? ''),
        customer_id: row.customer_id == null ? null : String(row.customer_id),
        customer_name:
          row.customer_name == null ? null : String(row.customer_name),
        customer_phone_last4:
          row.customer_phone_last4 == null
            ? null
            : String(row.customer_phone_last4),
        customer_card:
          row.customer_card == null ? null : String(row.customer_card),
        offline_qr: row.offline_qr == null ? null : String(row.offline_qr),
        amount_minor: Number(row.amount_minor ?? 0),
        currency: String(row.currency ?? 'ILS'),
        pos_invoice_ref: String(row.pos_invoice_ref ?? ''),
        description: row.description == null ? null : String(row.description),
        scanned_at: String(row.scanned_at ?? ''),
        state: (row.state ?? 'pending') as 'pending',
        reference_code:
          row.reference_code == null ? null : String(row.reference_code),
        transaction_id:
          row.transaction_id == null ? null : String(row.transaction_id),
        outstanding_after:
          row.outstanding_after == null ? null : Number(row.outstanding_after),
        synced_at: row.synced_at == null ? null : String(row.synced_at),
        error_code: row.error_code == null ? null : String(row.error_code),
        error_message:
          row.error_message == null ? null : String(row.error_message),
        retry_count: Number(row.retry_count ?? 0),
        created_at: String(row.created_at ?? ''),
      })),
      sila_customers: rowsOf(silaCustomers).map(row => ({
        customer_id: String(row.customer_id ?? ''),
        name: String(row.name ?? ''),
        phone_last4: row.phone_last4 == null ? null : String(row.phone_last4),
        id_number: row.id_number == null ? null : String(row.id_number),
        outstanding_minor: Number(row.outstanding_minor ?? 0),
        last_synced_at:
          row.last_synced_at == null ? null : String(row.last_synced_at),
      })),
      images,
      settings: getSettings(),
      embeddingModelVersion: EMBEDDING_MODEL_VERSION,
    };

    return {
      json: JSON.stringify(doc, null, 2),
      summary: {
        categories: doc.categories.length,
        units: doc.units.length,
        products: doc.products.length,
        productUnits: doc.product_units.length,
        embeddings: doc.embeddings.length,
        sales: doc.sales.length,
        createdAt: doc.createdAt,
      },
    };
  },

  /** Writes the backup file into Downloads/SmartVisionPOS. */
  async exportBackup(): Promise<{path: string; summary: BackupSummary}> {
    const {json, summary} = await this.buildBackupJson();
    const stamp = new Date().toISOString().slice(0, 10);
    const fileName = `sela_backup_${stamp}.json`;
    const path = await requirePlatformUtils().exportFile(
      fileName,
      JSON_MIME,
      json,
    );
    logDiag(
      'backup',
      `تم إنشاء نسخة احتياطية: ${summary.products} منتج، ${summary.embeddings} بصمة، ${summary.sales} فاتورة`,
    );
    return {path, summary};
  },

  /** Opens the system picker, reads and validates the file (no writes). */
  async pickAndParseBackup(): Promise<BackupFile> {
    const content = await requirePlatformUtils().pickAndReadFile([
      JSON_MIME,
      'application/octet-stream',
      'text/plain',
    ]);
    let doc: BackupFile;
    try {
      doc = JSON.parse(content) as BackupFile;
    } catch {
      throw new Error('الملف المختار ليس ملف نسخة احتياطية صالح من sela');
    }
    if (doc == null || doc.app !== 'sela' || !Array.isArray(doc.products)) {
      throw new Error(
        'صيغة الملف غير صحيحة — اختر ملف نسخة احتياطية أنشأه تطبيق sela',
      );
    }
    if (doc.backupVersion > BACKUP_VERSION) {
      throw new Error(
        'النسخة الاحتياطية أحدث من التطبيق — حدّث التطبيق أولاً ثم استعد',
      );
    }
    return doc;
  },

  /**
   * Restores a parsed backup in ONE transaction — full replace of
   * catalog + history, then applies settings. Either everything lands
   * or nothing changes.
   */
  async restoreBackup(doc: BackupFile): Promise<BackupSummary> {
    const db = getDb();

    // v8.3 (round-12 #3): write every EMBEDDED image into fresh files
    // BEFORE the transaction, then map old path → new path so the
    // restored products point at files that actually exist on THIS
    // device. v1 backups (no images block) keep the original paths —
    // same-device restores still work, and the dead-path cleanup pass
    // (catalogStore) clears the rest.
    const imageNewPath = new Map<string, string>();
    if (Array.isArray(doc.images) && doc.images.length > 0) {
      const nameToNewPath = new Map<string, string>();
      try {
        const platform = requirePlatformUtils();
        for (const image of doc.images) {
          if (!image?.name || !image?.data) {
            continue;
          }
          const newPath = await platform.writeFileBase64(
            'thumbs',
            image.name.endsWith('.jpg') ? image.name : `${image.name}.jpg`,
            image.data,
          );
          nameToNewPath.set(image.name, newPath);
        }
      } catch {
        // Native writer unavailable — fall back to original paths.
      }
      for (const product of doc.products ?? []) {
        const uri = product.image_uri;
        if (uri == null || uri.length === 0) {
          continue;
        }
        // The export stored images keyed by name; find the embedded
        // copy that belonged to this product by matching the original
        // file name inside the embedded name.
        const originalName = uri.split('/').pop() ?? '';
        const match = doc.images.find(
          entry =>
            entry?.name != null &&
            entry.name.includes(originalName.replace(/[^A-Za-z0-9._-]/g, '_')),
        );
        if (match != null) {
          const newPath = nameToNewPath.get(match.name);
          if (newPath != null) {
            imageNewPath.set(uri, newPath);
          }
        }
      }
    }

    // op-sqlite transactions resolve with void — counts are captured
    // through this mutable summary object instead.
    const summary: BackupSummary = {
      categories: 0,
      units: 0,
      products: 0,
      productUnits: 0,
      embeddings: 0,
      sales: 0,
      createdAt: doc.createdAt ?? '',
    };

    await db.transaction(async tx => {
      await tx.execute('DELETE FROM sale_items');
      await tx.execute('DELETE FROM sales');
      await tx.execute('DELETE FROM stocktake_items');
      await tx.execute('DELETE FROM stocktakes');
      await tx.execute('DELETE FROM product_embeddings');
      await tx.execute('DELETE FROM product_units');
      await tx.execute('DELETE FROM products');
      await tx.execute('DELETE FROM units');
      await tx.execute('DELETE FROM categories');
      await tx.execute(
        "DELETE FROM sqlite_sequence WHERE name IN ('categories','units','products','product_units','product_embeddings','sales','sale_items','stocktakes','stocktake_items')",
      );

      // Categories & units — keep maps from backup ids to fresh ids.
      const categoryMap = new Map<number, number>();
      for (const category of doc.categories ?? []) {
        if (!category.name) {
          continue;
        }
        const inserted = await tx.execute(
          'INSERT INTO categories (name) VALUES (?)',
          [category.name],
        );
        categoryMap.set(Number(category.id), Number(inserted.insertId));
      }

      const unitMap = new Map<number, number>();
      for (const unit of doc.units ?? []) {
        if (!unit.name) {
          continue;
        }
        const inserted = await tx.execute(
          'INSERT INTO units (name, short_name, sort_order, kind) VALUES (?, ?, ?, ?)',
          [
            unit.name,
            unit.short_name || unit.name,
            Number(unit.sort_order ?? 0),
            // v9.2: carry the unit type through the restore (old
            // backups default to 'piece').
            unit.kind === 'weight' ||
            unit.kind === 'volume' ||
            unit.kind === 'length'
              ? unit.kind
              : 'piece',
          ],
        );
        unitMap.set(Number(unit.id), Number(inserted.insertId));
      }

      // Products — map backup ids to fresh ids so everything else lines up.
      const productMap = new Map<number, number>();
      for (const product of doc.products ?? []) {
        if (!product.name) {
          continue;
        }
        const restoredImage =
          product.image_uri != null
            ? imageNewPath.get(product.image_uri) ?? product.image_uri
            : null;
        const inserted = await tx.execute(
          `INSERT INTO products
            (name, cost_price, retail_price, wholesale_price, stock_quantity, category_id, image_uri, low_stock_threshold, barcode, sold_by_weight, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            product.name,
            Number(product.cost_price ?? 0),
            Number(product.retail_price ?? 0),
            Number(product.wholesale_price ?? 0),
            Number(product.stock_quantity ?? 0),
            product.category_id != null
              ? categoryMap.get(Number(product.category_id)) ?? null
              : null,
            restoredImage,
            product.low_stock_threshold ?? null,
            product.barcode ?? null,
            product.sold_by_weight === 1 ? 1 : 0,
            product.created_at || nowLocal(),
          ],
        );
        productMap.set(Number(product.id), Number(inserted.insertId));
      }

      // Sellable units per product.
      let productUnits = 0;
      for (const row of doc.product_units ?? []) {
        const newProductId = productMap.get(Number(row.product_id));
        const newUnitId = unitMap.get(Number(row.unit_id));
        if (newProductId == null || newUnitId == null) {
          continue;
        }
        await tx.execute(
          `INSERT INTO product_units
            (product_id, unit_id, conversion, barcode, retail_price, wholesale_price)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            newProductId,
            newUnitId,
            Number(row.conversion ?? 1),
            row.barcode ?? null,
            row.retail_price ?? null,
            row.wholesale_price ?? null,
          ],
        );
        productUnits += 1;
      }

      // Vision fingerprints. v10 (round-16 #4): fingerprints from a
      // DIFFERENT embedding-model generation are skipped — their
      // vectors live in another feature space and matching them
      // against the current model would be garbage. Backups with NO
      // generation marker (pre-v10) were built with the v1 model and
      // are skipped for the same reason.
      let embeddings = 0;
      const fingerprintsCompatible =
        doc.embeddingModelVersion === EMBEDDING_MODEL_VERSION;
      if (fingerprintsCompatible) {
        for (const embedding of doc.embeddings ?? []) {
          const newProductId = productMap.get(Number(embedding.product_id));
          if (newProductId == null || !embedding.embedding_data) {
            continue;
          }
          await tx.execute(
            'INSERT INTO product_embeddings (product_id, embedding_data, angle_label) VALUES (?, ?, ?)',
            [
              newProductId,
              embedding.embedding_data,
              embedding.angle_label || 'front',
            ],
          );
          embeddings += 1;
        }
      } else {
        logDiag(
          'backup',
          `تم تخطي ${
            doc.embeddings?.length ?? 0
          } بصمة — نموذج تعرّف مختلف (أعد تسجيل صور المنتجات)`,
          'warn',
        );
      }

      // Sales history.
      const saleMap = new Map<number, number>();
      let sales = 0;
      for (const sale of doc.sales ?? []) {
        const inserted = await tx.execute(
          `INSERT INTO sales
            (invoice_number, total_amount, total_cost, total_profit, discount, payment_type, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            sale.invoice_number || `R-${Date.now()}-${sales}`,
            Number(sale.total_amount ?? 0),
            Number(sale.total_cost ?? 0),
            Number(sale.total_profit ?? 0),
            Number(sale.discount ?? 0),
            sale.payment_type ?? null,
            sale.created_at || nowLocal(),
          ],
        );
        saleMap.set(Number(sale.id), Number(inserted.insertId));
        sales += 1;
      }

      for (const item of doc.sale_items ?? []) {
        const newSaleId = saleMap.get(Number(item.sale_id));
        const newProductId = productMap.get(Number(item.product_id));
        if (newSaleId == null || newProductId == null) {
          continue;
        }
        await tx.execute(
          `INSERT INTO sale_items
            (sale_id, product_id, quantity, unit_price, cost_price, total_line_price)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            newSaleId,
            newProductId,
            Number(item.quantity ?? 0),
            Number(item.unit_price ?? 0),
            Number(item.cost_price ?? 0),
            Number(item.total_line_price ?? 0),
          ],
        );
      }

      // Stocktake sessions.
      const stocktakeMap = new Map<number, number>();
      for (const stocktake of doc.stocktakes ?? []) {
        const inserted = await tx.execute(
          `INSERT INTO stocktakes
            (started_at, completed_at, status, note)
           VALUES (?, ?, ?, ?)`,
          [
            stocktake.started_at || nowLocal(),
            stocktake.completed_at ?? null,
            stocktake.status || 'open',
            stocktake.note ?? null,
          ],
        );
        stocktakeMap.set(Number(stocktake.id), Number(inserted.insertId));
      }

      for (const item of doc.stocktake_items ?? []) {
        const newStocktakeId = stocktakeMap.get(Number(item.stocktake_id));
        const newProductId = productMap.get(Number(item.product_id));
        if (newStocktakeId == null || newProductId == null) {
          continue;
        }
        await tx.execute(
          `INSERT INTO stocktake_items
            (stocktake_id, product_id, system_qty, counted_qty)
           VALUES (?, ?, ?, ?)`,
          [
            newStocktakeId,
            newProductId,
            Number(item.system_qty ?? 0),
            item.counted_qty ?? null,
          ],
        );
      }

      // v11 (SILA): debts + customers cache. Debt rows key on
      // idempotency_key / pos_invoice_ref (NOT local ids) so they
      // restore verbatim — the server dedupes replays (§6.2) and
      // 'syncing' rows from a crash recover to pending (§8).
      await tx.execute('DELETE FROM sila_debt_queue');
      await tx.execute('DELETE FROM sila_customers');
      await tx.execute(
        "DELETE FROM sqlite_sequence WHERE name IN ('sila_debt_queue')",
      );
      for (const debt of doc.sila_debts ?? []) {
        if (!debt.idempotency_key || !debt.pos_invoice_ref) {
          continue;
        }
        await tx.execute(
          `INSERT INTO sila_debt_queue
            (idempotency_key, customer_id, customer_name, customer_phone_last4,
             customer_card, offline_qr, amount_minor, currency, pos_invoice_ref,
             description, scanned_at, state, reference_code, transaction_id,
             outstanding_after, synced_at, error_code, error_message, retry_count, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            debt.idempotency_key,
            debt.customer_id ?? null,
            debt.customer_name ?? null,
            debt.customer_phone_last4 ?? null,
            debt.customer_card ?? null,
            debt.offline_qr ?? null,
            Number(debt.amount_minor ?? 0),
            debt.currency || 'ILS',
            debt.pos_invoice_ref,
            debt.description ?? null,
            debt.scanned_at || nowLocal(),
            debt.state === 'synced' || debt.state === 'failed'
              ? debt.state
              : 'pending',
            debt.reference_code ?? null,
            debt.transaction_id ?? null,
            debt.outstanding_after ?? null,
            debt.synced_at ?? null,
            debt.error_code ?? null,
            debt.error_message ?? null,
            Number(debt.retry_count ?? 0),
            debt.created_at || nowLocal(),
          ],
        );
      }
      for (const customer of doc.sila_customers ?? []) {
        if (!customer.customer_id || !customer.name) {
          continue;
        }
        await tx.execute(
          `INSERT INTO sila_customers
            (customer_id, name, phone_last4, id_number, outstanding_minor, last_synced_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            customer.customer_id,
            customer.name,
            customer.phone_last4 ?? null,
            customer.id_number ?? null,
            Number(customer.outstanding_minor ?? 0),
            customer.last_synced_at ?? null,
          ],
        );
      }

      // Counters land on the outer summary object (TS-friendly).
      summary.categories = categoryMap.size;
      summary.units = unitMap.size;
      summary.products = productMap.size;
      summary.productUnits = productUnits;
      summary.embeddings = embeddings;
      summary.sales = sales;
    });

    // Settings land outside the DB transaction (MMKV).
    if (doc.settings != null) {
      useSettingsStore.getState().update(doc.settings);
    }

    // v10 (round-16 #1): the restored sales may carry HIGHER invoice
    // numbers than this device's counter — reconcile immediately so
    // the next sale continues after the last restored invoice.
    try {
      await InvoiceService.syncInvoiceCounterFromDb();
    } catch {
      // The DB-aware reservation recovers on the next sale anyway.
    }

    logDiag(
      'backup',
      `تمت الاستعادة: ${summary.products} منتج و${summary.embeddings} بصمة و${summary.sales} فاتورة`,
    );
    return summary;
  },

  /** Summary of a parsed backup (used before the confirm dialog). */
  summarize(doc: BackupFile): BackupSummary {
    return {
      categories: doc.categories?.length ?? 0,
      units: doc.units?.length ?? 0,
      products: doc.products?.length ?? 0,
      productUnits: doc.product_units?.length ?? 0,
      embeddings: doc.embeddings?.length ?? 0,
      sales: doc.sales?.length ?? 0,
      createdAt: doc.createdAt ?? '',
    };
  },

  safeMessage(error: unknown): string {
    return toMessage(error);
  },
};
