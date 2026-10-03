/**
 * Categories repository — CRUD + safety guard against deleting a
 * category that still has products attached.
 */
import {getDb, toMessage} from '../connection';
import type {Category} from '../../core/types';

function rowToCategory(row: Record<string, unknown>): Category {
  return {
    id: Number(row.id),
    name: String(row.name ?? ''),
  };
}

export const CategoryRepo = {
  async list(): Promise<Category[]> {
    const result = await getDb().execute(
      'SELECT id, name FROM categories ORDER BY name ASC',
    );
    const rows = result.rows?._array ?? [];
    return rows.map(rowToCategory);
  },

  async create(name: string): Promise<number> {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error('اسم الفئة فارغ');
    }
    const exists = await getDb().execute(
      'SELECT COUNT(*) AS cnt FROM categories WHERE lower(name) = lower(?)',
      [trimmed],
    );
    const existsRow = exists.rows?._array?.[0] as {cnt?: number} | undefined;
    if ((existsRow?.cnt ?? 0) > 0) {
      throw new Error('توجد فئة بنفس الاسم مسبقاً');
    }
    const result = await getDb().execute(
      'INSERT INTO categories (name) VALUES (?)',
      [trimmed],
    );
    return result.insertId ?? -1;
  },

  async rename(id: number, name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error('اسم الفئة فارغ');
    }
    await getDb().execute('UPDATE categories SET name = ? WHERE id = ?', [
      trimmed,
      id,
    ]);
  },

  /** Lists categories with the number of products in each. */
  async listWithCounts(): Promise<Category[]> {
    const result = await getDb().execute(
      `SELECT c.id, c.name, COUNT(p.id) AS product_count
       FROM categories c
       LEFT JOIN products p ON p.category_id = c.id
       GROUP BY c.id
       ORDER BY c.name ASC`,
    );
    const rows = result.rows?._array ?? [];
    return rows.map(row => ({
      ...rowToCategory(row),
      productCount: Number(row.product_count ?? 0),
    }));
  },

  /**
   * Deletes a category. Products keep existing but become uncategorized
   * (same behaviour as global POS systems like Loyverse).
   */
  async remove(id: number): Promise<void> {
    await getDb().execute(
      'UPDATE products SET category_id = NULL WHERE category_id = ?',
      [id],
    );
    await getDb().execute('DELETE FROM categories WHERE id = ?', [id]);
  },

  safeMessage(error: unknown): string {
    return toMessage(error);
  },
};
