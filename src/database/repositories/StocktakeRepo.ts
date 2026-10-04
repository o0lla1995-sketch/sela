/**
 * Stocktake repository — جلسات الجرد.
 * ─────────────────────────────────────────────────────────────────
 * A stocktake session snapshots every product's system quantity at
 * start; the merchant then enters counted quantities physically.
 * Completing a session (optionally) reconciles stock to the counted
 * values inside one transaction and stamps the full audit report.
 */
import {getDb} from '../connection';
import {localNow} from '../../core/format';
import type {
  Stocktake,
  StocktakeItem,
  StocktakeSummary,
} from '../../core/types';

function rowToStocktake(row: Record<string, unknown>): Stocktake {
  return {
    id: Number(row.id),
    started_at: String(row.started_at ?? ''),
    completed_at: row.completed_at == null ? null : String(row.completed_at),
    status: row.status === 'completed' ? 'completed' : 'open',
    note: row.note == null ? null : String(row.note),
  };
}

function rowToItem(row: Record<string, unknown>): StocktakeItem {
  return {
    id: Number(row.id),
    stocktake_id: Number(row.stocktake_id),
    product_id: Number(row.product_id),
    productName: String(row.product_name ?? ''),
    categoryId: row.category_id == null ? null : Number(row.category_id),
    system_qty: Number(row.system_qty ?? 0),
    counted_qty: row.counted_qty == null ? null : Number(row.counted_qty),
    unitHint: row.unit_hint == null ? null : String(row.unit_hint),
    soldByWeight: Number(row.sold_by_weight ?? 0) === 1 ? 1 : 0,
  };
}

/**
 * Carton-style hint for PIECE products: "كرتونة × 24".
 * v8.3: WEIGHT products show their biggest sub-kilo unit instead —
 * "1 وقية = 0.25 كغ" (conversion < 1, printf keeps the fraction that
 * CAST AS INTEGER used to truncate to 0).
 */
const UNIT_HINT_SQL = `(
  SELECT '1 ' || u.name || ' = ' || printf('%.3g', pu.conversion) ||
    (CASE WHEN p.sold_by_weight = 1 THEN ' كغ' ELSE ' قطعة' END)
  FROM product_units pu JOIN units u ON u.id = pu.unit_id
  WHERE pu.product_id = p.id
    AND (
      (p.sold_by_weight = 1 AND pu.conversion > 0 AND pu.conversion < 1)
      OR (COALESCE(p.sold_by_weight, 0) = 0 AND pu.conversion > 1)
    )
  ORDER BY pu.conversion DESC LIMIT 1
) AS unit_hint`;

export const StocktakeRepo = {
  async getOpen(): Promise<Stocktake | null> {
    const result = await getDb().execute(
      "SELECT * FROM stocktakes WHERE status = 'open' ORDER BY id DESC LIMIT 1",
    );
    const row = result.rows?._array?.[0];
    return row ? rowToStocktake(row) : null;
  },

  async list(limit = 20): Promise<Stocktake[]> {
    const result = await getDb().execute(
      'SELECT * FROM stocktakes ORDER BY id DESC LIMIT ?',
      [limit],
    );
    return (result.rows?._array ?? []).map(rowToStocktake);
  },

  /** Creates a session and snapshots current stock for every product. */
  async start(): Promise<Stocktake> {
    const db = getDb();
    const open = await this.getOpen();
    if (open != null) {
      return open;
    }
    const created = await db.execute(
      "INSERT INTO stocktakes (started_at, status) VALUES (?, 'open')",
      [localNow()],
    );
    const id = created.insertId ?? -1;
    await db.execute(
      `INSERT INTO stocktake_items (stocktake_id, product_id, system_qty)
       SELECT ?, p.id, p.stock_quantity FROM products p`,
      [id],
    );
    const result = await db.execute('SELECT * FROM stocktakes WHERE id = ?', [
      id,
    ]);
    const row = result.rows?._array?.[0];
    if (!row) {
      throw new Error('تعذر إنشاء جلسة الجرد');
    }
    return rowToStocktake(row);
  },

  async cancel(id: number): Promise<void> {
    const db = getDb();
    await db.execute('DELETE FROM stocktake_items WHERE stocktake_id = ?', [
      id,
    ]);
    await db.execute('DELETE FROM stocktakes WHERE id = ?', [id]);
  },

  async listItems(
    stocktakeId: number,
    options?: {
      search?: string;
      categoryId?: number | 'all';
      onlyPending?: boolean;
    },
  ): Promise<StocktakeItem[]> {
    const conditions = ['si.stocktake_id = ?'];
    const params: (string | number)[] = [stocktakeId];
    const search = options?.search?.trim();
    if (search) {
      conditions.push('p.name LIKE ?');
      params.push(`%${search}%`);
    }
    if (options?.categoryId != null && options?.categoryId !== 'all') {
      conditions.push('p.category_id = ?');
      params.push(options.categoryId);
    }
    if (options?.onlyPending) {
      conditions.push('si.counted_qty IS NULL');
    }
    const result = await getDb().execute(
      `SELECT si.*, p.name AS product_name, p.category_id, p.sold_by_weight, ${UNIT_HINT_SQL}
       FROM stocktake_items si
       JOIN products p ON p.id = si.product_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY p.name ASC`,
      params,
    );
    return (result.rows?._array ?? []).map(rowToItem);
  },

  async setCounted(
    stocktakeId: number,
    productId: number,
    counted: number | null,
  ): Promise<void> {
    await getDb().execute(
      'UPDATE stocktake_items SET counted_qty = ? WHERE stocktake_id = ? AND product_id = ?',
      [counted, stocktakeId, productId],
    );
  },

  async summary(stocktakeId: number): Promise<StocktakeSummary> {
    const result = await getDb().execute(
      `SELECT
         COUNT(*) AS total_items,
         SUM(CASE WHEN counted_qty IS NOT NULL THEN 1 ELSE 0 END) AS counted_items,
         SUM(CASE WHEN counted_qty IS NOT NULL AND counted_qty = system_qty THEN 1 ELSE 0 END) AS matched_items,
         SUM(CASE WHEN counted_qty IS NOT NULL AND counted_qty < system_qty THEN 1 ELSE 0 END) AS shortage_items,
         SUM(CASE WHEN counted_qty IS NOT NULL AND counted_qty > system_qty THEN 1 ELSE 0 END) AS surplus_items,
         COALESCE(SUM(system_qty), 0) AS total_system,
         COALESCE(SUM(counted_qty), 0) AS total_counted
       FROM stocktake_items WHERE stocktake_id = ?`,
      [stocktakeId],
    );
    const row = result.rows?._array?.[0] ?? {};
    return {
      totalItems: Number(row.total_items ?? 0),
      countedItems: Number(row.counted_items ?? 0),
      matchedItems: Number(row.matched_items ?? 0),
      shortageItems: Number(row.shortage_items ?? 0),
      surplusItems: Number(row.surplus_items ?? 0),
      totalSystem: Number(row.total_system ?? 0),
      totalCounted: Number(row.total_counted ?? 0),
    };
  },

  /**
   * Completes the session. When `applyAdjustments` is true, every counted
   * value is written back to products.stock_quantity atomically; items
   * left uncounted keep their system quantity untouched.
   */
  async complete(
    stocktakeId: number,
    applyAdjustments: boolean,
  ): Promise<{adjusted: number}> {
    const db = getDb();
    let adjusted = 0;
    await db.transaction(async tx => {
      if (applyAdjustments) {
        const result = await tx.execute(
          `UPDATE products
           SET stock_quantity = (
             SELECT si.counted_qty FROM stocktake_items si
             WHERE si.stocktake_id = ? AND si.product_id = products.id
               AND si.counted_qty IS NOT NULL
           )
           WHERE id IN (
             SELECT si.product_id FROM stocktake_items si
             WHERE si.stocktake_id = ? AND si.counted_qty IS NOT NULL
           )`,
          [stocktakeId, stocktakeId],
        );
        adjusted = result.rowsAffected ?? 0;
      }
      await tx.execute(
        "UPDATE stocktakes SET status = 'completed', completed_at = ? WHERE id = ?",
        [localNow(), stocktakeId],
      );
    });
    return {adjusted};
  },

  async getById(id: number): Promise<Stocktake | null> {
    const result = await getDb().execute(
      'SELECT * FROM stocktakes WHERE id = ?',
      [id],
    );
    const row = result.rows?._array?.[0];
    return row ? rowToStocktake(row) : null;
  },
};
