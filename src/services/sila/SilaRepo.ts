/**
 * sila/SilaRepo — local persistence for the SILA debt queue and the
 * customers balance cache (SILA_POS_API §7).
 * ─────────────────────────────────────────────────────────────────
 * Rules enforced here (§7 "قواعد صارمة"):
 *  - the debt row is created AT SALE TIME with ONE idempotency_key
 *    that never changes — retries replay the same key;
 *  - pos_invoice_ref is UNIQUE — one invoice = one debt;
 *  - failed rows keep their error code for the merchant screen.
 */
import {getDb, toMessage} from '../../database/connection';
import {logDiag} from '../../core/diagnostics';
import type {SilaDebtRow, SilaCustomer} from '../../core/types';

function rowToDebt(row: Record<string, unknown>): SilaDebtRow {
  return {
    local_id: Number(row.local_id ?? 0),
    idempotency_key: String(row.idempotency_key ?? ''),
    customer_id: (row.customer_id as string) ?? null,
    customer_name: (row.customer_name as string) ?? null,
    customer_phone_last4: (row.customer_phone_last4 as string) ?? null,
    customer_card: (row.customer_card as string) ?? null,
    offline_qr: (row.offline_qr as string) ?? null,
    amount_minor: Number(row.amount_minor ?? 0),
    currency: String(row.currency ?? 'ILS'),
    pos_invoice_ref: String(row.pos_invoice_ref ?? ''),
    description: (row.description as string) ?? null,
    scanned_at: String(row.scanned_at ?? ''),
    state: (row.state as SilaDebtRow['state']) ?? 'pending',
    reference_code: (row.reference_code as string) ?? null,
    transaction_id: (row.transaction_id as string) ?? null,
    outstanding_after:
      row.outstanding_after == null ? null : Number(row.outstanding_after),
    synced_at: (row.synced_at as string) ?? null,
    error_code: (row.error_code as string) ?? null,
    error_message: (row.error_message as string) ?? null,
    retry_count: Number(row.retry_count ?? 0),
    created_at: String(row.created_at ?? ''),
  };
}

export interface EnqueueDebtInput {
  idempotencyKey: string;
  customerId: string | null;
  customerName: string | null;
  customerPhoneLast4: string | null;
  customerCard: string | null;
  offlineQr: string | null;
  amountMinor: number;
  posInvoiceRef: string;
  description: string;
  scannedAt: string;
}

export const SilaRepo = {
  /** Creates the queue row at sale time (§7 rule 1). */
  async enqueue(input: EnqueueDebtInput): Promise<SilaDebtRow> {
    const db = getDb();
    await db.execute(
      `INSERT INTO sila_debt_queue (
        idempotency_key, customer_id, customer_name, customer_phone_last4,
        customer_card, offline_qr, amount_minor, currency, pos_invoice_ref,
        description, scanned_at, state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ILS', ?, ?, ?, 'pending')`,
      [
        input.idempotencyKey,
        input.customerId,
        input.customerName,
        input.customerPhoneLast4,
        input.customerCard,
        input.offlineQr,
        input.amountMinor,
        input.posInvoiceRef,
        input.description,
        input.scannedAt,
      ],
    );
    const row = await db.execute(
      'SELECT * FROM sila_debt_queue WHERE idempotency_key = ?',
      [input.idempotencyKey],
    );
    logDiag(
      'sila',
      `أُضيف دين للطابور: ${input.posInvoiceRef} — ${
        input.customerName ?? 'زبون'
      }`,
    );
    return rowToDebt(row.rows?._array?.[0] ?? {});
  },

  /** Oldest-first pending batch (≤ 100, §6.2). */
  async pendingBatch(limit = 100): Promise<SilaDebtRow[]> {
    const result = await getDb().execute(
      `SELECT * FROM sila_debt_queue WHERE state = 'pending'
       ORDER BY created_at ASC, local_id ASC LIMIT ?`,
      [limit],
    );
    return (result.rows?._array ?? []).map(row =>
      rowToDebt(row as Record<string, unknown>),
    );
  },

  async markSyncing(localIds: number[]): Promise<void> {
    if (localIds.length === 0) {
      return;
    }
    const db = getDb();
    for (const id of localIds) {
      await db.execute(
        "UPDATE sila_debt_queue SET state = 'syncing' WHERE local_id = ?",
        [id],
      );
    }
  },

  async markSynced(
    localId: number,
    patch: {
      referenceCode: string;
      transactionId: string;
      outstandingAfter: number;
    },
  ): Promise<void> {
    await getDb().execute(
      `UPDATE sila_debt_queue
       SET state = 'synced', reference_code = ?, transaction_id = ?,
           outstanding_after = ?, synced_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           error_code = NULL, error_message = NULL
       WHERE local_id = ?`,
      [
        patch.referenceCode,
        patch.transactionId,
        patch.outstandingAfter,
        localId,
      ],
    );
  },

  async markFailed(
    localId: number,
    code: string,
    message: string,
  ): Promise<void> {
    await getDb().execute(
      `UPDATE sila_debt_queue
       SET state = 'failed', error_code = ?, error_message = ?
       WHERE local_id = ?`,
      [code, message, localId],
    );
  },

  /** Transient failure — back to pending with the retry count. */
  async markRetry(localId: number): Promise<void> {
    await getDb().execute(
      `UPDATE sila_debt_queue
       SET state = 'pending', retry_count = retry_count + 1
       WHERE local_id = ?`,
      [localId],
    );
  },

  /** §8: rows stuck in 'syncing' (crash mid-batch) return to pending. */
  async recoverStuck(minutes = 10): Promise<number> {
    const db = getDb();
    const result = await db.execute(
      `SELECT local_id FROM sila_debt_queue WHERE state = 'syncing'
         AND datetime(created_at, '+' || ? || ' minutes') < datetime('now')`,
      [minutes],
    );
    const ids = (result.rows?._array ?? []).map(row =>
      Number((row as {local_id?: number}).local_id ?? 0),
    );
    for (const id of ids) {
      await db.execute(
        "UPDATE sila_debt_queue SET state = 'pending' WHERE local_id = ?",
        [id],
      );
    }
    return ids.length;
  },

  /** Manually requeue a failed row (merchant fixed the cause). */
  async requeue(localId: number): Promise<void> {
    await getDb().execute(
      `UPDATE sila_debt_queue
       SET state = 'pending', error_code = NULL, error_message = NULL,
           retry_count = 0
       WHERE local_id = ?`,
      [localId],
    );
  },

  async counts(): Promise<{
    pending: number;
    failed: number;
    synced: number;
  }> {
    try {
      const result = await getDb().execute(
        `SELECT
           SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN state = 'synced' THEN 1 ELSE 0 END) AS synced
         FROM sila_debt_queue`,
      );
      const row = (result.rows?._array?.[0] ?? {}) as {
        pending?: number | null;
        failed?: number | null;
        synced?: number | null;
      };
      return {
        pending: row.pending ?? 0,
        failed: row.failed ?? 0,
        synced: row.synced ?? 0,
      };
    } catch (error) {
      logDiag('sila', `تعذر عدّ طابور الديون: ${toMessage(error)}`, 'warn');
      return {pending: 0, failed: 0, synced: 0};
    }
  },

  /** Recent rows for the merchant's debt panel (newest first). */
  async recent(limit = 60): Promise<SilaDebtRow[]> {
    const result = await getDb().execute(
      `SELECT * FROM sila_debt_queue
       ORDER BY CASE state WHEN 'failed' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
                local_id DESC
       LIMIT ?`,
      [limit],
    );
    return (result.rows?._array ?? []).map(row =>
      rowToDebt(row as Record<string, unknown>),
    );
  },

  async byInvoiceRef(invoiceRef: string): Promise<SilaDebtRow | null> {
    const result = await getDb().execute(
      'SELECT * FROM sila_debt_queue WHERE pos_invoice_ref = ? LIMIT 1',
      [invoiceRef],
    );
    const row = result.rows?._array?.[0];
    return row ? rowToDebt(row as Record<string, unknown>) : null;
  },

  // ── customers cache (§7) ───────────────────────────────────────

  async upsertCustomers(
    rows: {
      customerId: string;
      name: string;
      phoneLast4: string | null;
      outstandingMinor: number;
    }[],
    syncedAt: string,
  ): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    const db = getDb();
    for (const row of rows) {
      await db.execute(
        `INSERT INTO sila_customers (customer_id, name, phone_last4, outstanding_minor, last_synced_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(customer_id) DO UPDATE SET
           name = excluded.name,
           phone_last4 = excluded.phone_last4,
           outstanding_minor = excluded.outstanding_minor,
           last_synced_at = excluded.last_synced_at`,
        [
          row.customerId,
          row.name,
          row.phoneLast4,
          row.outstandingMinor,
          syncedAt,
        ],
      );
    }
  },

  async listCustomers(): Promise<SilaCustomer[]> {
    const result = await getDb().execute(
      `SELECT * FROM sila_customers
       ORDER BY outstanding_minor DESC, name COLLATE NOCASE ASC`,
    );
    return (result.rows?._array ?? []).map(row => {
      const r = row as Record<string, unknown>;
      return {
        customer_id: String(r.customer_id ?? ''),
        name: String(r.name ?? ''),
        phone_last4: (r.phone_last4 as string) ?? null,
        id_number: (r.id_number as string) ?? null,
        outstanding_minor: Number(r.outstanding_minor ?? 0),
        last_synced_at: (r.last_synced_at as string) ?? null,
      };
    });
  },

  /** Cached customer by SILA cid — offline QR codes carry no name. */
  async findCustomer(customerId: string): Promise<SilaCustomer | null> {
    if (!customerId) {
      return null;
    }
    const result = await getDb().execute(
      'SELECT * FROM sila_customers WHERE customer_id = ? LIMIT 1',
      [customerId],
    );
    const row = result.rows?._array?.[0];
    if (row == null) {
      return null;
    }
    const r = row as Record<string, unknown>;
    return {
      customer_id: String(r.customer_id ?? ''),
      name: String(r.name ?? ''),
      phone_last4: (r.phone_last4 as string) ?? null,
      id_number: (r.id_number as string) ?? null,
      outstanding_minor: Number(r.outstanding_minor ?? 0),
      last_synced_at: (r.last_synced_at as string) ?? null,
    };
  },
};
