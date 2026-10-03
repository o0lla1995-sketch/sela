/**
 * Products repository — search, filtering, CRUD and stock movement.
 */
import {getDb, toMessage} from '../connection';
import {localNow} from '../../core/format';
import type {Product} from '../../core/types';

function rowToProduct(row: Record<string, unknown>): Product {
  return {
    id: Number(row.id),
    name: String(row.name ?? ''),
    cost_price: Number(row.cost_price ?? 0),
    retail_price: Number(row.retail_price ?? 0),
    wholesale_price: Number(row.wholesale_price ?? 0),
    stock_quantity: Number(row.stock_quantity ?? 0),
    category_id: row.category_id == null ? null : Number(row.category_id),
    image_uri: row.image_uri == null ? null : String(row.image_uri),
    low_stock_threshold: row.low_stock_threshold == null ? null : Number(row.low_stock_threshold),
    created_at: String(row.created_at ?? ''),
  };
}

export interface ProductInput {
  name: string;
  cost_price: number;
  retail_price: number;
  wholesale_price: number;
  stock_quantity: number;
  category_id: number | null;
  image_uri: string | null;
  low_stock_threshold?: number | null;
}

export const ProductRepo = {
  async list(options?: {search?: string; categoryId?: number | 'all'}): Promise<Product[]> {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    const search = options?.search?.trim();
    if (search) {
      conditions.push('p.name LIKE ?');
      params.push(`%${search}%`);
    }
    if (options?.categoryId != null && options.categoryId !== 'all') {
      conditions.push('p.category_id = ?');
      params.push(options.categoryId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT p.* FROM products p ${where} ORDER BY p.name ASC LIMIT 500`;
    const result = await getDb().execute(sql, params);
    const rows = result.rows?._array ?? [];
    return rows.map(rowToProduct);
  },

  async getById(id: number): Promise<Product | null> {
    const result = await getDb().execute('SELECT * FROM products WHERE id = ?', [id]);
    const row = result.rows?._array?.[0];
    return row ? rowToProduct(row) : null;
  },

  async countAll(): Promise<number> {
    const result = await getDb().execute('SELECT COUNT(*) AS cnt FROM products');
    const row = result.rows?._array?.[0] as {cnt?: number} | undefined;
    return Number(row?.cnt ?? 0);
  },

  async create(input: ProductInput): Promise<number> {
    const name = input.name.trim();
    if (!name) throw new Error('اسم المنتج مطلوب');
    if (input.retail_price < 0 || input.wholesale_price < 0 || input.cost_price < 0) {
      throw new Error('الأسعار لا يمكن أن تكون سالبة');
    }
    if (input.stock_quantity < 0) {
      throw new Error('الكمية لا يمكن أن تكون سالبة');
    }
    const result = await getDb().execute(
      `INSERT INTO products
        (name, cost_price, retail_price, wholesale_price, stock_quantity, category_id, image_uri, low_stock_threshold, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name,
        input.cost_price,
        input.retail_price,
        input.wholesale_price,
        Math.trunc(input.stock_quantity),
        input.category_id,
        input.image_uri,
        input.low_stock_threshold ?? null,
        localNow(),
      ],
    );
    return result.insertId ?? -1;
  },

  async update(id: number, input: ProductInput): Promise<void> {
    const name = input.name.trim();
    if (!name) throw new Error('اسم المنتج مطلوب');
    if (input.retail_price < 0 || input.wholesale_price < 0 || input.cost_price < 0) {
      throw new Error('الأسعار لا يمكن أن تكون سالبة');
    }
    if (input.stock_quantity < 0) {
      throw new Error('الكمية لا يمكن أن تكون سالبة');
    }
    await getDb().execute(
      `UPDATE products SET
        name = ?, cost_price = ?, retail_price = ?, wholesale_price = ?,
        stock_quantity = ?, category_id = ?, image_uri = ?, low_stock_threshold = ?
       WHERE id = ?`,
      [
        name,
        input.cost_price,
        input.retail_price,
        input.wholesale_price,
        Math.trunc(input.stock_quantity),
        input.category_id,
        input.image_uri,
        input.low_stock_threshold ?? null,
        id,
      ],
    );
  },

  async remove(id: number): Promise<void> {
    await getDb().execute('DELETE FROM products WHERE id = ?', [id]);
  },

  /** Atomically decrements stock; throws a friendly error on oversell. */
  async decrementStock(id: number, quantity: number): Promise<void> {
    const result = await getDb().execute(
      'UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ? AND stock_quantity >= ?',
      [quantity, id, quantity],
    );
    if (result.rowsAffected !== 1) {
      throw new Error(`الكمية المتوفرة من المنتج غير كافية (المطلوب: ${quantity})`);
    }
  },

  safeMessage(error: unknown): string {
    return toMessage(error);
  },
};
