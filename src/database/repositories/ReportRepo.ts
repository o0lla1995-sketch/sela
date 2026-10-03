/**
 * Reports repository — SQL aggregations for the accounting engine.
 * All ranges are [from 00:00:00, to 23:59:59] in LOCAL time because
 * `sales.created_at` is always written as local device time.
 */
import {getDb, toMessage} from '../connection';
import {weekdayLabel} from '../../core/format';
import type {
  DailyPoint,
  DateRange,
  HourlyPoint,
  ReportSummary,
  TopProduct,
} from '../../core/types';

function rangeBounds(range: DateRange): [string, string] {
  return [`${range.from} 00:00:00`, `${range.to} 23:59:59`];
}

export const ReportRepo = {
  async summary(range: DateRange): Promise<ReportSummary> {
    const [start, end] = rangeBounds(range);
    const salesResult = await getDb().execute(
      `SELECT
         COALESCE(SUM(total_amount), 0) AS revenue,
         COALESCE(SUM(total_cost), 0) AS cogs,
         COALESCE(SUM(total_profit), 0) AS profit,
         COALESCE(SUM(discount), 0) AS discount_total,
         COUNT(*) AS invoices
       FROM sales
       WHERE created_at >= ? AND created_at <= ?`,
      [start, end],
    );
    const salesRow =
      (salesResult.rows?._array?.[0] as
        | {
            revenue?: number;
            cogs?: number;
            profit?: number;
            discount_total?: number;
            invoices?: number;
          }
        | undefined) ?? {};

    const itemsResult = await getDb().execute(
      `SELECT COALESCE(SUM(si.quantity), 0) AS items
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       WHERE s.created_at >= ? AND s.created_at <= ?`,
      [start, end],
    );
    const itemsRow = itemsResult.rows?._array?.[0] as
      | {items?: number}
      | undefined;

    const invoices = Number(salesRow.invoices ?? 0);
    const revenue = Number(salesRow.revenue ?? 0);
    return {
      revenue,
      cogs: Number(salesRow.cogs ?? 0),
      netProfit: Number(salesRow.profit ?? 0),
      invoicesCount: invoices,
      itemsCount: Number(itemsRow?.items ?? 0),
      discountTotal: Number(salesRow.discount_total ?? 0),
      avgInvoice: invoices > 0 ? revenue / invoices : 0,
    };
  },

  async topProducts(range: DateRange, limit = 10): Promise<TopProduct[]> {
    const [start, end] = rangeBounds(range);
    const result = await getDb().execute(
      `SELECT
         si.product_id AS product_id,
         COALESCE(p.name, 'منتج محذوف') AS name,
         SUM(si.quantity) AS quantity,
         SUM(si.total_line_price) AS revenue,
         SUM(si.total_line_price - si.cost_price * si.quantity) AS profit
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       LEFT JOIN products p ON p.id = si.product_id
       WHERE s.created_at >= ? AND s.created_at <= ?
       GROUP BY si.product_id, p.name
       ORDER BY revenue DESC
       LIMIT ?`,
      [start, end, Math.min(Math.max(limit, 1), 50)],
    );
    const rows = result.rows?._array ?? [];
    return rows.map(row => ({
      productId: Number(row.product_id),
      name: String(row.name ?? ''),
      quantity: Number(row.quantity ?? 0),
      revenue: Number(row.revenue ?? 0),
      profit: Number(row.profit ?? 0),
    }));
  },

  async dailySeries(range: DateRange): Promise<DailyPoint[]> {
    const [start, end] = rangeBounds(range);
    const result = await getDb().execute(
      `SELECT
         substr(created_at, 1, 10) AS day,
         SUM(total_amount) AS revenue,
         SUM(total_profit) AS profit
       FROM sales
       WHERE created_at >= ? AND created_at <= ?
       GROUP BY day
       ORDER BY day ASC`,
      [start, end],
    );
    const byDay = new Map<string, DailyPoint>();
    for (const row of result.rows?._array ?? []) {
      const day = String(row.day ?? '');
      byDay.set(day, {
        day,
        label: weekdayLabel(day),
        revenue: Number(row.revenue ?? 0),
        profit: Number(row.profit ?? 0),
      });
    }
    // Fill gaps so charts show continuous days.
    const points: DailyPoint[] = [];
    const cursor = new Date(`${range.from}T00:00:00`);
    const last = new Date(`${range.to}T00:00:00`);
    let guard = 0;
    while (cursor.getTime() <= last.getTime() && guard < 120) {
      const day = toLocalDayString(cursor);
      points.push(
        byDay.get(day) ?? {
          day,
          label: weekdayLabel(day),
          revenue: 0,
          profit: 0,
        },
      );
      cursor.setDate(cursor.getDate() + 1);
      guard += 1;
    }
    return points;
  },

  async hourlySeries(range: DateRange): Promise<HourlyPoint[]> {
    const [start, end] = rangeBounds(range);
    const result = await getDb().execute(
      `SELECT
         CAST(substr(created_at, 12, 2) AS INTEGER) AS hour,
         SUM(total_amount) AS revenue,
         COUNT(*) AS orders
       FROM sales
       WHERE created_at >= ? AND created_at <= ?
       GROUP BY hour
       ORDER BY hour ASC`,
      [start, end],
    );
    const byHour = new Map<number, HourlyPoint>();
    for (const row of result.rows?._array ?? []) {
      const hour = Number(row.hour ?? 0);
      byHour.set(hour, {
        hour,
        revenue: Number(row.revenue ?? 0),
        orders: Number(row.orders ?? 0),
      });
    }
    const points: HourlyPoint[] = [];
    for (let hour = 0; hour < 24; hour += 1) {
      points.push(byHour.get(hour) ?? {hour, revenue: 0, orders: 0});
    }
    return points;
  },

  /** Detailed sale rows used by the CSV / XLS exporters. */
  async salesDetail(range: DateRange): Promise<
    {
      invoice: string;
      createdAt: string;
      itemsCount: number;
      quantity: number;
      total: number;
      cost: number;
      profit: number;
      discount: number;
      paymentType: string;
    }[]
  > {
    const [start, end] = rangeBounds(range);
    const result = await getDb().execute(
      `SELECT
         s.invoice_number AS invoice,
         s.created_at AS created_at,
         (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) AS items_count,
         (SELECT COALESCE(SUM(si.quantity), 0) FROM sale_items si WHERE si.sale_id = s.id) AS quantity,
         s.total_amount AS total,
         s.total_cost AS cost,
         s.total_profit AS profit,
         s.discount AS discount,
         s.payment_type AS payment_type
       FROM sales s
       WHERE s.created_at >= ? AND s.created_at <= ?
       ORDER BY s.created_at ASC`,
      [start, end],
    );
    const rows = result.rows?._array ?? [];
    return rows.map(row => ({
      invoice: String(row.invoice ?? ''),
      createdAt: String(row.created_at ?? ''),
      itemsCount: Number(row.items_count ?? 0),
      quantity: Number(row.quantity ?? 0),
      total: Number(row.total ?? 0),
      cost: Number(row.cost ?? 0),
      profit: Number(row.profit ?? 0),
      discount: Number(row.discount ?? 0),
      paymentType:
        String(row.payment_type ?? 'RETAIL') === 'WHOLESALE' ? 'جملة' : 'مفرق',
    }));
  },

  safeMessage(error: unknown): string {
    return toMessage(error);
  },
};

function toLocalDayString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
