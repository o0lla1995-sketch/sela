/**
 * Sales repository — the checkout transaction itself.
 * The sale, its items and all stock decrements run inside ONE SQLite
 * transaction so a crash can never leave half-written accounting data.
 */
import {getDb, toMessage} from '../connection';
import {localNow} from '../../core/format';
import type {
  CartLine,
  PricingMode,
  SaleItemRecord,
  SaleRecord,
  SaleWithItems,
} from '../../core/types';

export interface CreateSaleInput {
  invoiceNumber: string;
  lines: CartLine[];
  /** Absolute discount in ₪ applied to the whole invoice. */
  discount: number;
  paymentType: PricingMode;
}

function rowToSale(row: Record<string, unknown>): SaleRecord {
  return {
    id: Number(row.id),
    invoice_number: String(row.invoice_number ?? ''),
    total_amount: Number(row.total_amount ?? 0),
    total_cost: Number(row.total_cost ?? 0),
    total_profit: Number(row.total_profit ?? 0),
    discount: Number(row.discount ?? 0),
    payment_type: String(row.payment_type ?? 'RETAIL') as PricingMode,
    created_at: String(row.created_at ?? ''),
  };
}

function rowToItem(row: Record<string, unknown>): SaleItemRecord {
  return {
    id: Number(row.id),
    sale_id: Number(row.sale_id),
    product_id: Number(row.product_id),
    quantity: Number(row.quantity ?? 0),
    unit_price: Number(row.unit_price ?? 0),
    cost_price: Number(row.cost_price ?? 0),
    total_line_price: Number(row.total_line_price ?? 0),
    unit_name: row.unit_name == null ? null : String(row.unit_name),
    base_quantity: row.base_quantity == null ? null : Number(row.base_quantity),
  };
}

export const SaleRepo = {
  /**
   * Creates the invoice. Throws with an Arabic message when stock is
   * insufficient — the caller shows a toast and keeps the cart intact.
   */
  async createSale(input: CreateSaleInput): Promise<SaleWithItems> {
    if (input.lines.length === 0) {
      throw new Error('السلة فارغة');
    }
    const db = getDb();

    const subtotal = input.lines.reduce(
      (sum, line) => sum + line.unitPrice * line.quantity,
      0,
    );
    const discount = Math.min(Math.max(input.discount, 0), subtotal);
    const totalAmount = subtotal - discount;
    const totalCost = input.lines.reduce(
      (sum, line) => sum + line.costPrice * line.quantity,
      0,
    );
    const totalProfit = totalAmount - totalCost;
    const createdAt = localNow();

    let saleId = -1;

    await db.transaction(async tx => {
      const insertSale = await tx.execute(
        `INSERT INTO sales
          (invoice_number, total_amount, total_cost, total_profit, discount, payment_type, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          input.invoiceNumber,
          totalAmount,
          totalCost,
          totalProfit,
          discount,
          input.paymentType,
          createdAt,
        ],
      );
      saleId = insertSale.insertId ?? -1;
      if (saleId < 0) {
        throw new Error('فشل إنشاء الفاتورة');
      }

      for (const line of input.lines) {
        const baseQty = line.quantity * (line.conversion ?? 1);
        await tx.execute(
          `INSERT INTO sale_items
            (sale_id, product_id, quantity, unit_price, cost_price, total_line_price, unit_name, base_quantity)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            saleId,
            line.productId,
            line.quantity,
            line.unitPrice,
            line.costPrice,
            line.unitPrice * line.quantity,
            line.unitName ?? null,
            baseQty,
          ],
        );
        // Oversell guard inside the same transaction (base units).
        const stockUpdate = await tx.execute(
          'UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ? AND stock_quantity >= ?',
          [baseQty, line.productId, baseQty],
        );
        if (stockUpdate.rowsAffected !== 1) {
          throw new Error(
            `الكمية المتوفرة من "${line.name}" غير كافية (${baseQty} قطعة مطلوبة)`,
          );
        }
      }
    });

    const saleResult = await db.execute('SELECT * FROM sales WHERE id = ?', [
      saleId,
    ]);
    const saleRow = saleResult.rows?._array?.[0];
    const itemsResult = await db.execute(
      'SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id ASC',
      [saleId],
    );
    const itemRows = itemsResult.rows?._array ?? [];

    return {
      sale: rowToSale(saleRow ?? {}),
      items: itemRows.map(rowToItem),
    };
  },

  async listRecent(limit = 20): Promise<SaleRecord[]> {
    const result = await getDb().execute(
      'SELECT * FROM sales ORDER BY id DESC LIMIT ?',
      [Math.min(Math.max(limit, 1), 200)],
    );
    const rows = result.rows?._array ?? [];
    return rows.map(rowToSale);
  },

  async getItemsForSale(saleId: number): Promise<SaleItemRecord[]> {
    const result = await getDb().execute(
      'SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id ASC',
      [saleId],
    );
    const rows = result.rows?._array ?? [];
    return rows.map(rowToItem);
  },

  async countAll(): Promise<number> {
    const result = await getDb().execute('SELECT COUNT(*) AS cnt FROM sales');
    const row = result.rows?._array?.[0] as {cnt?: number} | undefined;
    return Number(row?.cnt ?? 0);
  },

  safeMessage(error: unknown): string {
    return toMessage(error);
  },
};
