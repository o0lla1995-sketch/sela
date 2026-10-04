/**
 * Units repository — user-defined sellable units (قطعة، كرتونة، كيلو…)
 * plus per-product unit rows with conversion factors and price overrides.
 */
import {getDb, toMessage} from '../connection';
import type {ProductUnit, Unit} from '../../core/types';

function rowToUnit(row: Record<string, unknown>): Unit {
  return {
    id: Number(row.id),
    name: String(row.name ?? ''),
    short_name: String(row.short_name ?? ''),
    sort_order: Number(row.sort_order ?? 0),
  };
}

function rowToProductUnit(row: Record<string, unknown>): ProductUnit {
  return {
    id: Number(row.id),
    product_id: Number(row.product_id),
    unit_id: Number(row.unit_id),
    unitName: String(row.unit_name ?? ''),
    unitShort: String(row.unit_short ?? ''),
    conversion: Number(row.conversion ?? 1),
    barcode: row.barcode == null ? null : String(row.barcode),
    retail_price: row.retail_price == null ? null : Number(row.retail_price),
    wholesale_price:
      row.wholesale_price == null ? null : Number(row.wholesale_price),
  };
}

export const UnitRepo = {
  async list(): Promise<Unit[]> {
    const result = await getDb().execute(
      'SELECT * FROM units ORDER BY sort_order ASC, id ASC',
    );
    return (result.rows?._array ?? []).map(rowToUnit);
  },

  async create(name: string, short: string): Promise<number> {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error('اسم الوحدة مطلوب');
    }
    const existing = await getDb().execute(
      'SELECT id FROM units WHERE name = ? COLLATE NOCASE',
      [trimmed],
    );
    const hit = existing.rows?._array?.[0] as {id?: number} | undefined;
    if (hit?.id != null) {
      throw new Error('توجد وحدة بنفس الاسم مسبقاً');
    }
    const orderResult = await getDb().execute(
      'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM units',
    );
    const next = Number(
      (orderResult.rows?._array?.[0] as {next?: number})?.next ?? 1,
    );
    const result = await getDb().execute(
      'INSERT INTO units (name, short_name, sort_order) VALUES (?, ?, ?)',
      [trimmed, short.trim() || trimmed, next],
    );
    return result.insertId ?? -1;
  },

  /**
   * v9.1 (round-14 #4): find a unit by exact name or create it —
   * used by the one-tap weight-package chips (وقية / نصف كغ…) so a
   * merchant never has to leave the product form to add a package
   * unit that doesn't exist yet.
   */
  async getOrCreate(name: string, short?: string): Promise<number> {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error('اسم الوحدة مطلوب');
    }
    const existing = await getDb().execute(
      'SELECT id FROM units WHERE name = ? COLLATE NOCASE',
      [trimmed],
    );
    const hit = existing.rows?._array?.[0] as {id?: number} | undefined;
    if (hit?.id != null) {
      return hit.id;
    }
    const orderResult = await getDb().execute(
      'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM units',
    );
    const next = Number(
      (orderResult.rows?._array?.[0] as {next?: number})?.next ?? 1,
    );
    const result = await getDb().execute(
      'INSERT INTO units (name, short_name, sort_order) VALUES (?, ?, ?)',
      [trimmed, (short ?? trimmed).trim() || trimmed, next],
    );
    return result.insertId ?? -1;
  },

  async rename(id: number, name: string, short: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error('اسم الوحدة مطلوب');
    }
    await getDb().execute(
      'UPDATE units SET name = ?, short_name = ? WHERE id = ?',
      [trimmed, short.trim() || trimmed, id],
    );
  },

  async remove(id: number): Promise<void> {
    const usage = await getDb().execute(
      'SELECT COUNT(*) AS cnt FROM product_units WHERE unit_id = ?',
      [id],
    );
    const count = Number((usage.rows?._array?.[0] as {cnt?: number})?.cnt ?? 0);
    if (count > 0) {
      throw new Error(
        `الوحدة مستخدمة في ${count} منتج — احذفها من المنتجات أولاً`,
      );
    }
    await getDb().execute('DELETE FROM units WHERE id = ?', [id]);
  },

  // ── Per-product unit rows ─────────────────────────────────────

  async listForProduct(productId: number): Promise<ProductUnit[]> {
    const result = await getDb().execute(
      `SELECT pu.*, u.name AS unit_name, u.short_name AS unit_short
       FROM product_units pu
       JOIN units u ON u.id = pu.unit_id
       WHERE pu.product_id = ?
       ORDER BY u.sort_order ASC`,
      [productId],
    );
    return (result.rows?._array ?? []).map(rowToProductUnit);
  },

  async findByBarcode(
    code: string,
  ): Promise<{productId: number; productUnit: ProductUnit} | null> {
    const clean = code.trim();
    if (!clean) {
      return null;
    }
    const result = await getDb().execute(
      `SELECT pu.*, u.name AS unit_name, u.short_name AS unit_short
       FROM product_units pu
       JOIN units u ON u.id = pu.unit_id
       WHERE pu.barcode = ?
       LIMIT 1`,
      [clean],
    );
    const row = result.rows?._array?.[0];
    return row
      ? {
          productId: Number(row.product_id),
          productUnit: rowToProductUnit(row),
        }
      : null;
  },

  /** Replaces the unit rows of a product inside an open transaction body.
   *  v9.1 (round-14 #4): conversions are FRACTIONAL-ALLOWING — a
   *  weight sub-unit like وقية = 0.25 (كغ) is the whole point. The
   *  old Math.max(1, …) clamp silently rewrote 0.25 → 1, which made
   *  every weight package deduct a FULL kilo — this was the
   *  "weight units are unsuitable" bug. */
  async replaceForProduct(
    productId: number,
    rows: {
      unit_id: number;
      conversion: number;
      barcode?: string | null;
      retail_price?: number | null;
      wholesale_price?: number | null;
    }[],
  ): Promise<void> {
    const db = getDb();
    await db.execute('DELETE FROM product_units WHERE product_id = ?', [
      productId,
    ]);
    for (const row of rows) {
      const conversion = Number(row.conversion);
      if (!Number.isFinite(conversion) || conversion <= 0) {
        throw new Error('معامل التحويل غير صالح');
      }
      const rounded = Math.round(conversion * 1000) / 1000;
      await db.execute(
        `INSERT OR REPLACE INTO product_units
          (product_id, unit_id, conversion, barcode, retail_price, wholesale_price)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          productId,
          row.unit_id,
          rounded,
          row.barcode?.trim() ? row.barcode.trim() : null,
          row.retail_price != null && row.retail_price > 0
            ? row.retail_price
            : null,
          row.wholesale_price != null && row.wholesale_price > 0
            ? row.wholesale_price
            : null,
        ],
      );
    }
  },
};

export {toMessage};
