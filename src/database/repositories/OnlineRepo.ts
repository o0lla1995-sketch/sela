/**
 * OnlineRepo — v48 (الجولة 56): المرآة المحلية لطلبات البيع أونلاين.
 * ─────────────────────────────────────────────────────────────────
 * الطلبات تُولد على الخادم (تطبيق المتجر) وتتزامن إلى هنا بالاستطلاع.
 * الخادم هو مصدر الحقيقة للحالة؛ «الإرسال» يربط الطلب بفاتورة INV-O
 * داخل نفس معاملة البيع (SaleRepo)، و«التسليم» يرحّل المبلغ من الدين
 * الأونلاين المؤقت إلى الخزينة بسند COLL.
 *
 * الدفاتر الثلاثة تبقى معزولة تماماً: صلة (INV-D) · المتجر (INV-L) ·
 * الأونلاين (INV-O) — لا يمس أحدها الآخر أبداً.
 */
import {getDb, toMessage} from '../connection';
import {logDiag} from '../../core/diagnostics';
import {localNow} from '../../core/format';
import type {OnlineOrder, OnlineOrderItem, OnlineOrderStatus} from '../../core/types';

function rowToOrder(row: Record<string, unknown>): OnlineOrder {
  return {
    server_id: Number(row.server_id ?? 0),
    order_number: String(row.order_number ?? ''),
    status: String(row.status ?? 'new') as OnlineOrderStatus,
    customer_name: String(row.customer_name ?? ''),
    customer_phone: String(row.customer_phone ?? ''),
    customer_id_number: String(row.customer_id_number ?? ''),
    region_name: (row.region_name as string) ?? null,
    address: (row.address as string) ?? null,
    note: (row.note as string) ?? null,
    delivery_fee_minor: Number(row.delivery_fee_minor ?? 0),
    items_total_minor: Number(row.items_total_minor ?? 0),
    total_minor: Number(row.total_minor ?? 0),
    returned_minor: Number(row.returned_minor ?? 0),
    invoice_ref: (row.invoice_ref as string) ?? null,
    sale_id: row.sale_id == null ? null : Number(row.sale_id),
    reject_reason: (row.reject_reason as string) ?? null,
    cancel_reason: (row.cancel_reason as string) ?? null,
    revision: Number(row.revision ?? 1),
    server_created_at: Number(row.server_created_at ?? 0),
    server_updated_at: Number(row.server_updated_at ?? 0),
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
  };
}

function rowToItem(row: Record<string, unknown>): OnlineOrderItem {
  return {
    id: Number(row.id ?? 0),
    order_id: Number(row.server_order_id ?? 0),
    product_id: row.product_id == null ? null : Number(row.product_id),
    product_ref: String(row.product_ref ?? ''),
    product_name: String(row.product_name ?? ''),
    variant: (row.variant as string) ?? null,
    unit_price_minor: Number(row.unit_price_minor ?? 0),
    quantity: Number(row.quantity ?? 0),
    line_total_minor: Number(row.line_total_minor ?? 0),
  };
}

/** شكل الطلب كما يصل من استطلاع الخادم. */
export interface ServerOrderPayload {
  id: number;
  order_number: string;
  status: OnlineOrderStatus;
  region_name?: string | null;
  address?: string | null;
  note?: string | null;
  delivery_fee_minor?: number;
  items_total_minor?: number;
  total_minor?: number;
  returned_minor?: number;
  invoice_ref?: string | null;
  reject_reason?: string | null;
  cancel_reason?: string | null;
  revision?: number;
  created_at?: number;
  updated_at?: number;
  items?: {
    product_id?: number | null;
    product_ref?: string;
    product_name?: string;
    variant?: string | null;
    unit_price_minor?: number;
    quantity?: number;
    line_total_minor?: number;
  }[];
  customer?: {name?: string; phone?: string; idNumber?: string} | null;
}

export const OnlineRepo = {
  /** يدمج طلباً واحداً من الخادم (upsert). قاعدة الذهبية: الخادم مصدر
   *  الحالة — إلا أسطر الربط المحلية (invoice_ref/sale_id) التي خلقتها
   *  معاملة الإرسال هنا: لا تُداس أبداً ببيانات الخادم عنها. */
  async upsertFromServer(payload: ServerOrderPayload): Promise<OnlineOrder> {
    const db = getDb();
    const now = localNow();
    const existing = await this.byNumber(payload.order_number);
    const invoiceRef =
      existing?.invoice_ref ?? payload.invoice_ref ?? null;
    const saleId = existing?.sale_id ?? null;
    await db.execute(
      `INSERT INTO online_orders (
         server_id, order_number, status, customer_name, customer_phone, customer_id_number,
         region_name, address, note, delivery_fee_minor, items_total_minor, total_minor,
         returned_minor, invoice_ref, sale_id, reject_reason, cancel_reason,
         revision, server_created_at, server_updated_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(order_number) DO UPDATE SET
         status = excluded.status,
         customer_name = excluded.customer_name,
         customer_phone = excluded.customer_phone,
         customer_id_number = excluded.customer_id_number,
         region_name = excluded.region_name,
         address = excluded.address,
         note = excluded.note,
         delivery_fee_minor = excluded.delivery_fee_minor,
         items_total_minor = excluded.items_total_minor,
         total_minor = excluded.total_minor,
         returned_minor = CASE
           -- مرتجع سجلناه محلياً ولم يصل بعد من الخادم: خذ الأكبر
           -- (الخادم سيلحق به في الاستطلاع التالي).
           WHEN excluded.returned_minor < online_orders.returned_minor
             AND online_orders.status IN ('sent','delivered')
           THEN online_orders.returned_minor
           ELSE excluded.returned_minor END,
         reject_reason = excluded.reject_reason,
         cancel_reason = excluded.cancel_reason,
         revision = excluded.revision,
         server_updated_at = excluded.server_updated_at,
         updated_at = excluded.updated_at`,
      [
        payload.id,
        payload.order_number,
        payload.status,
        payload.customer?.name ?? '',
        payload.customer?.phone ?? '',
        payload.customer?.idNumber ?? '',
        payload.region_name ?? null,
        payload.address ?? null,
        payload.note ?? null,
        Math.round(payload.delivery_fee_minor ?? 0),
        Math.round(payload.items_total_minor ?? 0),
        Math.round(payload.total_minor ?? 0),
        Math.round(payload.returned_minor ?? 0),
        invoiceRef,
        saleId,
        payload.reject_reason ?? null,
        payload.cancel_reason ?? null,
        payload.revision ?? 1,
        payload.created_at ?? Date.now(),
        payload.updated_at ?? Date.now(),
        existing?.created_at ?? now,
        now,
      ],
    );
    // الأصناف: استبدال كامل (المصدر الخادم).
    if (payload.items != null) {
      await db.execute('DELETE FROM online_order_items WHERE server_order_id = ?', [
        payload.id,
      ]);
      for (const item of payload.items) {
        await db.execute(
          `INSERT OR IGNORE INTO online_order_items
             (server_order_id, product_id, product_ref, product_name, variant,
              unit_price_minor, quantity, line_total_minor)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            payload.id,
            item.product_id ?? null,
            String(item.product_ref ?? ''),
            String(item.product_name ?? ''),
            item.variant ?? null,
            Math.round(item.unit_price_minor ?? 0),
            Number(item.quantity ?? 0),
            Math.round(item.line_total_minor ?? 0),
          ],
        );
      }
    }
    const saved = await this.byNumber(payload.order_number);
    if (saved == null) {
      throw new Error('تعذر حفظ الطلب محلياً');
    }
    return saved;
  },

  async byNumber(orderNumber: string): Promise<OnlineOrder | null> {
    try {
      const result = await getDb().execute(
        'SELECT * FROM online_orders WHERE order_number = ? LIMIT 1',
        [orderNumber],
      );
      const row = result.rows?.[0];
      return row ? rowToOrder(row as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  },

  async byInvoiceRef(invoiceRef: string): Promise<OnlineOrder | null> {
    try {
      const result = await getDb().execute(
        'SELECT * FROM online_orders WHERE invoice_ref = ? LIMIT 1',
        [invoiceRef],
      );
      const row = result.rows?.[0];
      return row ? rowToOrder(row as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  },

  async list(status?: OnlineOrderStatus | 'all'): Promise<OnlineOrder[]> {
    try {
      const where =
        status != null && status !== 'all' ? 'WHERE status = ?' : '';
      const params =
        status != null && status !== 'all' ? [status] : [];
      const result = await getDb().execute(
        `SELECT * FROM online_orders ${where}
         ORDER BY server_updated_at DESC LIMIT 500`,
        params,
      );
      return (result.rows ?? []).map(row =>
        rowToOrder(row as Record<string, unknown>),
      );
    } catch (error) {
      logDiag(
        'online',
        `تعذر تحميل الطلبات الأونلاين: ${toMessage(error)}`,
        'warn',
      );
      return [];
    }
  },

  async itemsFor(serverOrderId: number): Promise<OnlineOrderItem[]> {
    try {
      const result = await getDb().execute(
        'SELECT * FROM online_order_items WHERE server_order_id = ? ORDER BY id ASC',
        [serverOrderId],
      );
      return (result.rows ?? []).map(row =>
        rowToItem(row as Record<string, unknown>),
      );
    } catch {
      return [];
    }
  },

  /** تحديث الحالة محلياً بعد فعل محلي ناجح (لا ينتظر الاستطلاع). */
  async markLocalStatus(
    orderNumber: string,
    status: OnlineOrderStatus,
    extra?: {invoiceRef?: string; saleId?: number},
  ): Promise<void> {
    await getDb().execute(
      `UPDATE online_orders
       SET status = ?,
           invoice_ref = COALESCE(?, invoice_ref),
           sale_id = COALESCE(?, sale_id),
           updated_at = ?
       WHERE order_number = ?`,
      [
        status,
        extra?.invoiceRef ?? null,
        extra?.saleId ?? null,
        localNow(),
        orderNumber,
      ],
    );
  },

  /** إضافة مرتجع محلي (يُعكس على الخادم بفعل return منفصل). */
  async addReturnedMinor(orderNumber: string, addedMinor: number): Promise<void> {
    await getDb().execute(
      `UPDATE online_orders
       SET returned_minor = MIN(items_total_minor, returned_minor + ?),
           updated_at = ?
       WHERE order_number = ?`,
      [Math.max(0, Math.round(addedMinor)), localNow(), orderNumber],
    );
  },

  async newOrdersCount(): Promise<number> {
    try {
      const result = await getDb().execute(
        "SELECT COUNT(*) AS cnt FROM online_orders WHERE status = 'new'",
      );
      return Number(
        (result.rows?.[0] as {cnt?: number})?.cnt ?? 0,
      );
    } catch {
      return 0;
    }
  },

  /** الدين الأونلاين القائم الآن: الطلبات المُرسلة غير المسلّمة بعد،
   *  صافية من مرتجعاتها (المرتجع بعد التسليم استرداد نقدي من
   *  الخزينة بسند RFD — لا يمس هذا الرقم). */
  async outstandingTotals(): Promise<{minor: number; count: number}> {
    try {
      const result = await getDb().execute(
        `SELECT COALESCE(SUM(total_minor - returned_minor), 0) AS minor,
                COUNT(*) AS cnt
         FROM online_orders WHERE status = 'sent'`,
      );
      const row = (result.rows?.[0] ?? {}) as {minor?: number; cnt?: number};
      return {minor: Number(row.minor ?? 0), count: Number(row.cnt ?? 0)};
    } catch {
      return {minor: 0, count: 0};
    }
  },

  /** رصيد البيع بالأونلاين التراكمي (لمعادلة الخزينة): كل طلب
   *  مفوتر (سلسلة INV-O) بعد خصم مرتجعاته — هذا هو «جزء الدين»
   *  الذي لم يدخل الخزينة لحظة البيع، وتُسوّيه سندات COLL لاحقاً. */
  async invoicedNetTotal(): Promise<number> {
    try {
      const result = await getDb().execute(
        `SELECT COALESCE(SUM(total_minor - returned_minor), 0) AS minor
         FROM online_orders
         WHERE status IN ('sent','delivered','returned') AND invoice_ref IS NOT NULL`,
      );
      return Number(
        (result.rows?.[0] as {minor?: number})?.minor ?? 0,
      );
    } catch {
      return 0;
    }
  },
};
