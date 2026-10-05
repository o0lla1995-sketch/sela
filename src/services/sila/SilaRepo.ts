/**
 * sila/SilaRepo — local persistence for the SILA debt queue, the
 *  v15 repayments queue and the customers balance cache
 *  (SILA_POS_API §7 + SILA_POS_DEBT_SEPARATION §3.1).
 * ─────────────────────────────────────────────────────────────────
 * Rules enforced here (§7 «قواعد صارمة"):
 *  - the debt row is created AT SALE TIME with ONE idempotency_key
 *    that never changes — retries replay the same key;
 *  - pos_invoice_ref is UNIQUE — one invoice = one debt;
 *  - v15: the SAME discipline for repayments — one row per receipt
 *    (pos_receipt_ref UNIQUE + one idempotency_key forever);
 *  - failed rows keep their error code for the merchant screen.
 */
import {getDb, toMessage} from '../../database/connection';
import {logDiag} from '../../core/diagnostics';
import {localToday} from '../../core/format';
import {
  getNumber,
  setNumber,
  getString,
  setString,
  KEYS,
} from '../../storage/storage';
import type {SilaDebtRow, SilaCustomer, SilaPaymentRow} from '../../core/types';

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
    credit_covered_minor: Number(row.credit_covered_minor ?? 0),
    synced_at: (row.synced_at as string) ?? null,
    error_code: (row.error_code as string) ?? null,
    error_message: (row.error_message as string) ?? null,
    retry_count: Number(row.retry_count ?? 0),
    created_at: String(row.created_at ?? ''),
  };
}

function rowToCustomer(row: Record<string, unknown>): SilaCustomer {
  return {
    customer_id: String(row.customer_id ?? ''),
    name: String(row.name ?? ''),
    phone_last4: (row.phone_last4 as string) ?? null,
    id_number: (row.id_number as string) ?? null,
    credit_minor: Number(row.credit_minor ?? 0),
    outstanding_minor: Number(row.outstanding_minor ?? 0),
    pos_outstanding_minor: Number(row.pos_outstanding_minor ?? 0),
    app_outstanding_minor: Number(row.app_outstanding_minor ?? 0),
    other_minor: Number(row.other_minor ?? 0),
    pos_purchases_minor: Number(row.pos_purchases_minor ?? 0),
    app_purchases_minor: Number(row.app_purchases_minor ?? 0),
    last_payment_at: (row.last_payment_at as string) ?? null,
    last_payment_amount_minor:
      row.last_payment_amount_minor == null
        ? null
        : Number(row.last_payment_amount_minor),
    last_synced_at: (row.last_synced_at as string) ?? null,
  };
}

function rowToPayment(row: Record<string, unknown>): SilaPaymentRow {
  return {
    local_id: Number(row.local_id ?? 0),
    idempotency_key: String(row.idempotency_key ?? ''),
    customer_id: (row.customer_id as string) ?? null,
    customer_name: (row.customer_name as string) ?? null,
    customer_phone_last4: (row.customer_phone_last4 as string) ?? null,
    amount_minor: Number(row.amount_minor ?? 0),
    payment_method: String(row.payment_method ?? 'cash'),
    pos_receipt_ref: String(row.pos_receipt_ref ?? ''),
    description: (row.description as string) ?? null,
    paid_at: String(row.paid_at ?? ''),
    state: (row.state as SilaPaymentRow['state']) ?? 'pending',
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
  /** v17 (round-23 #3): the part of amountMinor the customer's
   *  prepaid credit is expected to absorb (min(amount, cached
   *  credit)). The FULL amount still uploads — the server consumes
   *  the credit itself — but the store's books already know the
   *  invoice is partially/fully PAID, not pure debt. */
  creditCoveredMinor?: number;
}

export interface EnqueuePaymentInput {
  idempotencyKey: string;
  customerId: string | null;
  customerName: string | null;
  customerPhoneLast4: string | null;
  amountMinor: number;
  paymentMethod: string;
  posReceiptRef: string;
  description: string;
  paidAt: string;
}

export const SilaRepo = {
  /** Creates the queue row at sale time (§7 rule 1). */
  async enqueue(input: EnqueueDebtInput): Promise<SilaDebtRow> {
    const db = getDb();
    await db.execute(
      `INSERT INTO sila_debt_queue (
        idempotency_key, customer_id, customer_name, customer_phone_last4,
        customer_card, offline_qr, amount_minor, currency, pos_invoice_ref,
        description, scanned_at, credit_covered_minor, state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ILS', ?, ?, ?, ?, 'pending')`,
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
        Math.max(0, Math.min(input.creditCoveredMinor ?? 0, input.amountMinor)),
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
      /** v17 (round-23 #3): the server's EXACT credit_consumed_minor
       *  for this debt (when it answers one) — reconciles the local
       *  estimate so the books match صِلة to the agora. */
      creditCovered?: number | null;
    },
  ): Promise<void> {
    await getDb().execute(
      `UPDATE sila_debt_queue
       SET state = 'synced', reference_code = ?, transaction_id = ?,
           outstanding_after = ?,
           credit_covered_minor = COALESCE(?, credit_covered_minor),
           synced_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           error_code = NULL, error_message = NULL
       WHERE local_id = ?`,
      [
        patch.referenceCode,
        patch.transactionId,
        patch.outstandingAfter,
        patch.creditCovered ?? null,
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

  /**
   * v16 (round-22 #1): renumber a debt whose upload collided
   * server-side (DUPLICATE_INVOICE_REF — the server never forgets a
   * pos_invoice_ref, and a fresh install restarts the numbering).
   * The queue row AND the sale row move to the fresh number together
   * so the receipt, the invoices center and the upload all agree.
   */
  async renumberDebtInvoice(
    oldRef: string,
    newRef: string,
  ): Promise<boolean> {
    if (oldRef === newRef || oldRef.length === 0 || newRef.length === 0) {
      return false;
    }
    const db = getDb();
    try {
      await db.transaction(async tx => {
        await tx.execute(
          `UPDATE sila_debt_queue
           SET pos_invoice_ref = ?, state = 'pending', retry_count = 0
           WHERE pos_invoice_ref = ?`,
          [newRef, oldRef],
        );
        await tx.execute(
          'UPDATE sales SET invoice_number = ? WHERE invoice_number = ?',
          [newRef, oldRef],
        );
      });
      logDiag(
        'sila',
        `أُعيد ترقيم الدين ${oldRef} ← ${newRef} (الرقم السابق محجوز في صِلة)`,
      );
      return true;
    } catch (error) {
      logDiag(
        'sila',
        `فشل إعادة ترقيم الدين ${oldRef}: ${toMessage(error)}`,
        'warn',
      );
      return false;
    }
  },

  /**
   * v16 (round-22 #1): the receipts twin of renumberDebtInvoice —
   * a cashier payment whose upload collided (DUPLICATE_RECEIPT_REF
   * after a reinstall restarted RCP numbering) moves to a fresh
   * receipt number and returns to the queue.
   */
  async renumberPaymentReceipt(
    oldRef: string,
    newRef: string,
  ): Promise<boolean> {
    if (oldRef === newRef || oldRef.length === 0 || newRef.length === 0) {
      return false;
    }
    const db = getDb();
    try {
      await db.execute(
        `UPDATE sila_payment_queue
         SET pos_receipt_ref = ?, state = 'pending', retry_count = 0
         WHERE pos_receipt_ref = ?`,
        [newRef, oldRef],
      );
      logDiag(
        'sila',
        `أُعيد ترقيم إيصال السداد ${oldRef} ← ${newRef}`,
      );
      return true;
    } catch (error) {
      logDiag(
        'sila',
        `فشل إعادة ترقيم الإيصال ${oldRef}: ${toMessage(error)}`,
        'warn',
      );
      return false;
    }
  },

  /** All invoice numbers that carry a SILA debt — used to badge the
   *  invoices center rows (one query, no per-row lookups). */
  async allDebtInvoiceRefs(): Promise<Set<string>> {
    try {
      const result = await getDb().execute(
        'SELECT pos_invoice_ref FROM sila_debt_queue',
      );
      const refs = new Set<string>();
      for (const row of result.rows?._array ?? []) {
        const ref = String(
          (row as {pos_invoice_ref?: string}).pos_invoice_ref ?? '',
        );
        if (ref.length > 0) {
          refs.add(ref);
        }
      }
      return refs;
    } catch {
      return new Set();
    }
  },

  /** v12 (round-18 #4): aggregates for the Home debts report —
   *  total outstanding debt (every state: the goods left the store
   *  on credit regardless of sync state), the unsynced portion,
   *  and today's debt so the treasury number can exclude it. */
  async totals(): Promise<{
    allMinor: number;
    allCount: number;
    pendingMinor: number;
    pendingCount: number;
    todayMinor: number;
  }> {
    try {
      const result = await getDb().execute(
        `SELECT
           COALESCE(SUM(amount_minor), 0) AS all_minor,
           COUNT(*) AS all_count,
           COALESCE(SUM(CASE WHEN state IN ('pending','syncing') THEN amount_minor ELSE 0 END), 0) AS pending_minor,
           SUM(CASE WHEN state IN ('pending','syncing') THEN 1 ELSE 0 END) AS pending_count,
           COALESCE(SUM(CASE WHEN date(created_at, 'localtime') = date('now', 'localtime') THEN amount_minor ELSE 0 END), 0) AS today_minor
         FROM sila_debt_queue`,
      );
      const row = (result.rows?._array?.[0] ?? {}) as {
        all_minor?: number | null;
        all_count?: number | null;
        pending_minor?: number | null;
        pending_count?: number | null;
        today_minor?: number | null;
      };
      return {
        allMinor: Number(row.all_minor ?? 0),
        allCount: Number(row.all_count ?? 0),
        pendingMinor: Number(row.pending_minor ?? 0),
        pendingCount: Number(row.pending_count ?? 0),
        todayMinor: Number(row.today_minor ?? 0),
      };
    } catch (error) {
      logDiag('sila', `تعذر جمع ملخص الديون: ${toMessage(error)}`, 'warn');
      return {
        allMinor: 0,
        allCount: 0,
        pendingMinor: 0,
        pendingCount: 0,
        todayMinor: 0,
      };
    }
  },

  /** v12 (round-18 #1): one-time repair — v11 sent explicit nulls in
   *  debt records so the server answered VALIDATION_ERROR and rows
   *  bounced pending↔retry forever. With the null-free builder this
   *  error cannot recur, so any row still sitting in 'failed' with
   *  that code is requeued and will sync on the next cycle. */
  async requeueFailedValidation(): Promise<number> {
    try {
      const result = await getDb().execute(
        `SELECT local_id FROM sila_debt_queue
         WHERE state = 'failed' AND error_code = 'VALIDATION_ERROR'`,
      );
      const ids = (result.rows?._array ?? []).map(row =>
        Number((row as {local_id?: number}).local_id ?? 0),
      );
      for (const id of ids) {
        await getDb().execute(
          `UPDATE sila_debt_queue
           SET state = 'pending', error_code = NULL, error_message = NULL,
               retry_count = 0
           WHERE local_id = ?`,
          [id],
        );
      }
      if (ids.length > 0) {
        logDiag(
          'sila',
          `أُعيدت ${ids.length} دين فاشل (خطأ تحقق قديم) إلى طابور المزامنة`,
        );
      }
      return ids.length;
    } catch {
      return 0;
    }
  },

  /** v15 (round-21 #3): ORIGIN-SPLIT server totals (§2.4/§3.3) —
   *  the store's own outstanding debts (pos), the Sila-app portion
   *  (app, informational only — NOT the store's revenue) and manual
   *  adjustments. What the Home dashboard and reports consume; the
   *  mixed `outstanding_minor` alone is no longer used for store
   *  statistics (that mixing was the «تداخل» complaint). */
  async customersOutstandingTotal(): Promise<{
    totalMinor: number;
    posTotalMinor: number;
    appTotalMinor: number;
    otherTotalMinor: number;
    debtorsCount: number;
    lastSyncedAt: string | null;
  }> {
    try {
      const result = await getDb().execute(
        `SELECT
           COALESCE(SUM(outstanding_minor), 0) AS total_minor,
           COALESCE(SUM(pos_outstanding_minor), 0) AS pos_minor,
           COALESCE(SUM(app_outstanding_minor), 0) AS app_minor,
           COALESCE(SUM(other_minor), 0) AS other_minor,
           COALESCE(SUM(CASE WHEN outstanding_minor > 0 THEN 1 ELSE 0 END), 0) AS debtors,
           MAX(last_synced_at) AS last_sync
         FROM sila_customers`,
      );
      const row = (result.rows?._array?.[0] ?? {}) as {
        total_minor?: number | null;
        pos_minor?: number | null;
        app_minor?: number | null;
        other_minor?: number | null;
        debtors?: number | null;
        last_sync?: string | null;
      };
      return {
        totalMinor: Number(row.total_minor ?? 0),
        posTotalMinor: Number(row.pos_minor ?? 0),
        appTotalMinor: Number(row.app_minor ?? 0),
        otherTotalMinor: Number(row.other_minor ?? 0),
        debtorsCount: Number(row.debtors ?? 0),
        lastSyncedAt: row.last_sync ?? null,
      };
    } catch (error) {
      logDiag('sila', `تعذر جمع أرصدة الزبائن: ${toMessage(error)}`, 'warn');
      return {
        totalMinor: 0,
        posTotalMinor: 0,
        appTotalMinor: 0,
        otherTotalMinor: 0,
        debtorsCount: 0,
        lastSyncedAt: null,
      };
    }
  },

  // ── v15 (round-21 #3): repayments queue (§3.1 sila_payment_uploads) ──

  /** Creates a payment row at collection time — ONE idempotency key
   *  per receipt, forever (§3 golden rule 3). */
  async enqueuePayment(
    input: EnqueuePaymentInput,
  ): Promise<SilaPaymentRow> {
    const db = getDb();
    await db.execute(
      `INSERT INTO sila_payment_queue (
        idempotency_key, customer_id, customer_name, customer_phone_last4,
        amount_minor, payment_method, pos_receipt_ref, description,
        paid_at, state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [
        input.idempotencyKey,
        input.customerId,
        input.customerName,
        input.customerPhoneLast4,
        input.amountMinor,
        input.paymentMethod,
        input.posReceiptRef,
        input.description,
        input.paidAt,
      ],
    );
    const row = await db.execute(
      'SELECT * FROM sila_payment_queue WHERE idempotency_key = ?',
      [input.idempotencyKey],
    );
    logDiag(
      'sila',
      `أُضيف سداد للطابور: ${input.posReceiptRef} — ${
        input.customerName ?? 'زبون'
      }`,
    );
    return rowToPayment(row.rows?._array?.[0] ?? {});
  },

  async pendingPaymentBatch(limit = 100): Promise<SilaPaymentRow[]> {
    const result = await getDb().execute(
      `SELECT * FROM sila_payment_queue WHERE state = 'pending'
       ORDER BY created_at ASC, local_id ASC LIMIT ?`,
      [limit],
    );
    return (result.rows?._array ?? []).map(row =>
      rowToPayment(row as Record<string, unknown>),
    );
  },

  async markPaymentSyncing(localIds: number[]): Promise<void> {
    if (localIds.length === 0) {
      return;
    }
    const db = getDb();
    for (const id of localIds) {
      await db.execute(
        "UPDATE sila_payment_queue SET state = 'syncing' WHERE local_id = ?",
        [id],
      );
    }
  },

  async markPaymentSynced(
    localId: number,
    patch: {
      referenceCode: string;
      transactionId: string;
      outstandingAfter: number;
    },
  ): Promise<void> {
    await getDb().execute(
      `UPDATE sila_payment_queue
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

  async markPaymentFailed(
    localId: number,
    code: string,
    message: string,
  ): Promise<void> {
    await getDb().execute(
      `UPDATE sila_payment_queue
       SET state = 'failed', error_code = ?, error_message = ?
       WHERE local_id = ?`,
      [code, message, localId],
    );
  },

  async markPaymentRetry(localId: number): Promise<void> {
    await getDb().execute(
      `UPDATE sila_payment_queue
       SET state = 'pending', retry_count = retry_count + 1
       WHERE local_id = ?`,
      [localId],
    );
  },

  async requeuePayment(localId: number): Promise<void> {
    await getDb().execute(
      `UPDATE sila_payment_queue
       SET state = 'pending', error_code = NULL, error_message = NULL,
           retry_count = 0
       WHERE local_id = ?`,
      [localId],
    );
  },

  async recoverStuckPayments(minutes = 10): Promise<number> {
    const db = getDb();
    const result = await db.execute(
      `SELECT local_id FROM sila_payment_queue WHERE state = 'syncing'
         AND datetime(created_at, '+' || ? || ' minutes') < datetime('now')`,
      [minutes],
    );
    const ids = (result.rows?._array ?? []).map(row =>
      Number((row as {local_id?: number}).local_id ?? 0),
    );
    for (const id of ids) {
      await db.execute(
        "UPDATE sila_payment_queue SET state = 'pending' WHERE local_id = ?",
        [id],
      );
    }
    return ids.length;
  },

  async paymentCounts(): Promise<{
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
         FROM sila_payment_queue`,
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
      logDiag('sila', `تعذر عدّ طابور السداد: ${toMessage(error)}`, 'warn');
      return {pending: 0, failed: 0, synced: 0};
    }
  },

  async recentPayments(limit = 40): Promise<SilaPaymentRow[]> {
    try {
      const result = await getDb().execute(
        `SELECT * FROM sila_payment_queue
         ORDER BY CASE state WHEN 'failed' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
                  local_id DESC
         LIMIT ?`,
        [limit],
      );
      return (result.rows?._array ?? []).map(row =>
        rowToPayment(row as Record<string, unknown>),
      );
    } catch {
      return []; // table not there yet (pre-v15 install, first run)
    }
  },

  /** RCP-YYYYMMDD-NNNN — DB-aware, never-backwards (mirrors the
   *  invoice reservation discipline: max(MMKV next, highest stored
   *  sequence for today) + 1 — §3.1 pos_receipt_ref فريد). */
  async reserveReceiptRef(): Promise<string> {
    const today = localToday();
    const dayCompact = today.replace(/-/g, '');
    const prefix = `RCP-${dayCompact}-`;
    let dbMax = 0;
    try {
      const result = await getDb().execute(
        'SELECT pos_receipt_ref FROM sila_payment_queue WHERE pos_receipt_ref LIKE ?',
        [`${prefix}%`],
      );
      const re = new RegExp(`^RCP-(\d{8})-(\d+)$`);
      for (const row of result.rows?._array ?? []) {
        const match = re.exec(String(row.pos_receipt_ref ?? ''));
        if (match) {
          dbMax = Math.max(dbMax, parseInt(match[2], 10));
        }
      }
    } catch {
      // Table missing on old installs — MMKV counter alone.
    }
    const lastDay = getString(KEYS.paymentReceiptDay, '');
    const counter = getNumber(KEYS.paymentReceiptCounter, 0);
    const mmkvNext = lastDay === today ? counter + 1 : 1;
    const next = Math.max(mmkvNext, dbMax + 1);
    setNumber(KEYS.paymentReceiptCounter, next);
    setString(KEYS.paymentReceiptDay, today);
    return `${prefix}${String(next).padStart(4, '0')}`;
  },

  /** Repayments RECEIVED at this cashier — all states (the cash
   *  entered the drawer the moment it was collected, regardless of
   *  upload state). Used by the treasury + reports (§3.4: a payment
   * is an asset swap — debt → cash — NEVER revenue). */
  async paymentsTotals(): Promise<{
    allMinor: number;
    allCount: number;
    todayMinor: number;
    syncedMinor: number;
    pendingMinor: number;
  }> {
    try {
      const result = await getDb().execute(
        `SELECT
           COALESCE(SUM(amount_minor), 0) AS all_minor,
           COUNT(*) AS all_count,
           COALESCE(SUM(CASE WHEN date(created_at, 'localtime') = date('now', 'localtime') THEN amount_minor ELSE 0 END), 0) AS today_minor,
           COALESCE(SUM(CASE WHEN state = 'synced' THEN amount_minor ELSE 0 END), 0) AS synced_minor,
           COALESCE(SUM(CASE WHEN state IN ('pending','syncing') THEN amount_minor ELSE 0 END), 0) AS pending_minor
         FROM sila_payment_queue`,
      );
      const row = (result.rows?._array?.[0] ?? {}) as {
        all_minor?: number | null;
        all_count?: number | null;
        today_minor?: number | null;
        synced_minor?: number | null;
        pending_minor?: number | null;
      };
      return {
        allMinor: Number(row.all_minor ?? 0),
        allCount: Number(row.all_count ?? 0),
        todayMinor: Number(row.today_minor ?? 0),
        syncedMinor: Number(row.synced_minor ?? 0),
        pendingMinor: Number(row.pending_minor ?? 0),
      };
    } catch (error) {
      logDiag('sila', `تعذر جمع ملخص السدادّات: ${toMessage(error)}`, 'warn');
      return {
        allMinor: 0,
        allCount: 0,
        todayMinor: 0,
        syncedMinor: 0,
        pendingMinor: 0,
      };
    }
  },

  /** Repayments inside a date range (reports) — [from 00:00, to 23:59]
   *  local time, by created_at. */
  async paymentsInRange(
    from: string,
    to: string,
  ): Promise<{count: number; minor: number}> {
    try {
      const result = await getDb().execute(
        `SELECT COUNT(*) AS cnt, COALESCE(SUM(amount_minor), 0) AS minor
         FROM sila_payment_queue
         WHERE created_at >= ? AND created_at <= ?`,
        [`${from} 00:00:00`, `${to} 23:59:59`],
      );
      const row = (result.rows?._array?.[0] ?? {}) as {
        cnt?: number | null;
        minor?: number | null;
      };
      return {count: Number(row.cnt ?? 0), minor: Number(row.minor ?? 0)};
    } catch {
      return {count: 0, minor: 0};
    }
  },

  // ── customers cache (§7) ───────────────────────────────────────

  /** v15 (§3.2-ب): REPLACE the row per customer — no MERGE, no local
   *  aggregation. Split fields default to 0 when the server hasn't
   *  deployed the 0069 origin split yet (backwards compatible).
   *  v18: `reconcileOffsetMinor` lands ONLY with a row's creation
   *  (first full sight) — the write-once baseline anchor for the
   *  collections reconciliation; existing rows keep theirs. */
  async upsertCustomers(
    rows: {
      customerId: string;
      name: string;
      phoneLast4: string | null;
      outstandingMinor: number;
      /** v17 (round-23 #3): the server-known prepaid credit. Pass
       *  null to PRESERVE the cached value (partial updates after a
       *  debt sync don't carry it). */
      creditMinor?: number | null;
      posOutstandingMinor?: number;
      appOutstandingMinor?: number;
      otherMinor?: number;
      posPurchasesMinor?: number;
      appPurchasesMinor?: number;
      lastPaymentAt?: string | null;
      lastPaymentAmountMinor?: number | null;
      /** v18 (round-24 #1): baseline anchor for NEW rows only. */
      reconcileOffsetMinor?: number;
    }[],
    syncedAt: string,
  ): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    const db = getDb();
    for (const row of rows) {
      // v17 (round-23 #3): creditMinor == null means "this update
      // doesn't know the credit" (a post-debt-sync upsert) — two SQL
      // variants so a NOT NULL column never needs a NULL sentinel:
      // the null variant simply doesn't touch credit_minor.
      const knowsCredit = row.creditMinor != null;
      const sql = knowsCredit
        ? `INSERT INTO sila_customers (
             customer_id, name, phone_last4, outstanding_minor,
             credit_minor,
             pos_outstanding_minor, app_outstanding_minor, other_minor,
             pos_purchases_minor, app_purchases_minor,
             last_payment_at, last_payment_amount_minor,
             reconcile_offset_minor, last_synced_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 0), ?)
           ON CONFLICT(customer_id) DO UPDATE SET
             name = excluded.name,
             phone_last4 = excluded.phone_last4,
             outstanding_minor = excluded.outstanding_minor,
             credit_minor = excluded.credit_minor,
             pos_outstanding_minor = excluded.pos_outstanding_minor,
             app_outstanding_minor = excluded.app_outstanding_minor,
             other_minor = excluded.other_minor,
             pos_purchases_minor = excluded.pos_purchases_minor,
             app_purchases_minor = excluded.app_purchases_minor,
             last_payment_at = excluded.last_payment_at,
             last_payment_amount_minor = excluded.last_payment_amount_minor,
             reconcile_offset_minor = COALESCE(excluded.reconcile_offset_minor, sila_customers.reconcile_offset_minor),
             last_synced_at = excluded.last_synced_at`
        : `INSERT INTO sila_customers (
             customer_id, name, phone_last4, outstanding_minor,
             pos_outstanding_minor, app_outstanding_minor, other_minor,
             pos_purchases_minor, app_purchases_minor,
             last_payment_at, last_payment_amount_minor,
             reconcile_offset_minor, last_synced_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 0), ?)
           ON CONFLICT(customer_id) DO UPDATE SET
             name = excluded.name,
             phone_last4 = excluded.phone_last4,
             outstanding_minor = excluded.outstanding_minor,
             pos_outstanding_minor = excluded.pos_outstanding_minor,
             app_outstanding_minor = excluded.app_outstanding_minor,
             other_minor = excluded.other_minor,
             pos_purchases_minor = excluded.pos_purchases_minor,
             app_purchases_minor = excluded.app_purchases_minor,
             last_payment_at = excluded.last_payment_at,
             last_payment_amount_minor = excluded.last_payment_amount_minor,
             reconcile_offset_minor = COALESCE(excluded.reconcile_offset_minor, sila_customers.reconcile_offset_minor),
             last_synced_at = excluded.last_synced_at`;
      const args = knowsCredit
        ? [
            row.customerId,
            row.name,
            row.phoneLast4,
            row.outstandingMinor,
            Math.max(0, Math.round(row.creditMinor ?? 0)),
            row.posOutstandingMinor ?? 0,
            row.appOutstandingMinor ?? 0,
            row.otherMinor ?? 0,
            row.posPurchasesMinor ?? 0,
            row.appPurchasesMinor ?? 0,
            row.lastPaymentAt ?? null,
            row.lastPaymentAmountMinor ?? null,
            row.reconcileOffsetMinor ?? null,
            syncedAt,
          ]
        : [
            row.customerId,
            row.name,
            row.phoneLast4,
            row.outstandingMinor,
            row.posOutstandingMinor ?? 0,
            row.appOutstandingMinor ?? 0,
            row.otherMinor ?? 0,
            row.posPurchasesMinor ?? 0,
            row.appPurchasesMinor ?? 0,
            row.lastPaymentAt ?? null,
            row.lastPaymentAmountMinor ?? null,
            row.reconcileOffsetMinor ?? null,
            syncedAt,
          ];
      await db.execute(sql, args);
    }
  },

  /** v18 (round-24 #1): the post-debt-sync cache touch — UPDATE ONLY.
   *  The v17 upsert-created rows here, which had two costs: it
   *  zeroed the origin-split columns (pos_outstanding → 0 until the
   *  next full refresh) and it made cache-row existence unusable as
   *  a «seen in a full refresh» marker for the reconciliation
   *  baseline. Updating only name/phone/total balance fixes both;
   *  customers the full feed hasn't delivered yet simply stay
   *  untouched until it does. */
  async touchCustomerAfterSync(
    row: {
      customerId: string;
      name: string;
      phoneLast4: string | null;
      outstandingMinor: number;
    },
    syncedAt: string,
  ): Promise<void> {
    try {
      await getDb().execute(
        `UPDATE sila_customers
           SET name = ?,
               phone_last4 = COALESCE(?, phone_last4),
               outstanding_minor = ?,
               last_synced_at = ?
         WHERE customer_id = ?`,
        [
          row.name,
          row.phoneLast4,
          row.outstandingMinor,
          syncedAt,
          row.customerId,
        ],
      );
    } catch (error) {
      logDiag(
        'sila',
        `تعذر تحديث ذاكرة الزبون بعد المزامنة: ${toMessage(error)}`,
        'warn',
      );
    }
  },

  async listCustomers(): Promise<SilaCustomer[]> {
    try {
      const result = await getDb().execute(
        `SELECT * FROM sila_customers
         ORDER BY outstanding_minor DESC, name COLLATE NOCASE ASC`,
      );
      return (result.rows?._array ?? []).map(row =>
        rowToCustomer(row as Record<string, unknown>),
      );
    } catch {
      return [];
    }
  },

  /** Cached customer by SILA cid — offline QR codes carry no name. */
  async findCustomer(customerId: string): Promise<SilaCustomer | null> {
    if (!customerId) {
      return null;
    }
    try {
      const result = await getDb().execute(
        'SELECT * FROM sila_customers WHERE customer_id = ? LIMIT 1',
        [customerId],
      );
      const row = result.rows?._array?.[0];
      return row
        ? rowToCustomer(row as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  },

  /** v17 (round-23 #3): local-only cache touch after a credit-covered
   *  debt sale — the prepaid balance the cache shows must drop by
   *  the covered part immediately, so the NEXT sale of the same
   *  customer sees the reduced credit (the server's own consumption
   *  arrives with the next balances refresh and corrects any drift). */
  async consumeCachedCredit(
    customerId: string,
    coveredMinor: number,
  ): Promise<void> {
    if (!customerId || coveredMinor <= 0) {
      return;
    }
    try {
      await getDb().execute(
        `UPDATE sila_customers
           SET credit_minor = MAX(0, credit_minor - ?)
         WHERE customer_id = ?`,
        [Math.round(coveredMinor), customerId],
      );
    } catch (error) {
      logDiag(
        'sila',
        `تعذر خصم الرصيد المسبق من الذاكرة: ${toMessage(error)}`,
        'warn',
      );
    }
  },

  /** v17 (round-23 #2): Σ credit_covered_minor of debt rows created in
   *  the range — the money prepaid credit absorbed (treated as
   *  received at sale/migration time in the store's cash math). */
  async creditCoveredInRange(
    from: string,
    to: string,
  ): Promise<number> {
    try {
      const result = await getDb().execute(
        `SELECT COALESCE(SUM(credit_covered_minor), 0) AS minor
         FROM sila_debt_queue
         WHERE created_at >= ? AND created_at <= ?`,
        [`${from} 00:00:00`, `${to} 23:59:59`],
      );
      const row = (result.rows?._array?.[0] ?? {}) as {
        minor?: number | null;
      };
      return Number(row.minor ?? 0);
    } catch {
      return 0;
    }
  },

  // ── v18 (round-24 #1): Sila-app collections reconciliation ────────

  /**
   * THE reconciliation engine (طريقة المخزون مع خطّ أساس).
   * ─────────────────────────────────────────────────────────────────
   * When a customer repays their STORE debt through the Sila app
   * (not at the cashier), the server's pos_outstanding_minor drops
   * and — before v18 — the store's books simply lost the money: the
   * debt vanished with no «مقبوضات مستلمة» record anywhere (the
   * exact complaint «فإن الدين يختفي ولا يسجل سدادات مستلمة من
   * صلة»).
   *
   * The server knows the full stock per customer:
   *   collectedOnStoreDebts = pos_purchases_minor − pos_outstanding_minor
   * (every purchase this store's invoices created, minus what still
   * stands — payments AND prepaid-credit consumption both reduce
   * pos_outstanding by FIFO, migration 0069).
   *
   * The store knows its own share of that stock:
   *   cashier collections      = Σ sila_payment_queue.amount (synced)
   *   prepaid-credit coverage  = Σ sila_debt_queue.credit_covered_minor
   *   already-detected app
   *   collections              = Σ sila_app_collections.amount
   *
   * The GAP — minus the customer's baseline anchor — is money صِلة
   * collected on the store's behalf that no local book has seen:
   *   unrecorded = (stock − localShare) − reconcile_offset_minor
   *
   * The baseline (reconcile_offset_minor, write-once at the FIRST
   * full sight of the customer) keeps a fresh install / new pairing
   * from claiming ANOTHER device's historical collections: for
   * those the gap is frozen as the starting point, and only NEW
   * collections above it are recorded. Upgrades (v17→v18) keep the
   * 0 default — their books DO cover the server history, so the
   * full gap is exactly the «disappeared» money to recover.
   *
   * This method is SELF-HEALING and IDEMPOTENT: no cursors, no
   * time windows (survives offline gaps >10 ledger entries), heals
   * restores, and repopulates ALL historical collections on the
   * first v18 sync because the server stock always knew them.
   *
   * `newCustomerOffsets` collects the baseline anchors for customers
   * the cache has never seen — the caller hands them to
   * upsertCustomers so the anchor lands with the row's creation.
   *
   * Returns the total minor amount newly recorded this pass.
   */
  async reconcileAppCollections(
    rows: {
      customerId: string;
      name: string;
      posPurchasesMinor: number;
      posOutstandingMinor: number;
    }[],
    newCustomerOffsets: Map<string, number>,
  ): Promise<number> {
    if (rows.length === 0) {
      return 0;
    }
    const db = getDb();
    let recordedTotal = 0;
    let recordedCount = 0;
    for (const row of rows) {
      try {
        const collectedOnStoreDebts =
          row.posPurchasesMinor - row.posOutstandingMinor;
        // The store's own share of that stock (see header).
        const aggResult = await db.execute(
          `SELECT
             (SELECT COALESCE(SUM(amount_minor), 0) FROM sila_payment_queue
               WHERE customer_id = ? AND state = 'synced') AS cashier_minor,
             (SELECT COALESCE(SUM(credit_covered_minor), 0) FROM sila_debt_queue
               WHERE customer_id = ?) AS credit_minor,
             (SELECT COALESCE(SUM(amount_minor), 0) FROM sila_app_collections
               WHERE customer_id = ?) AS app_minor`,
          [row.customerId, row.customerId, row.customerId],
        );
        const agg = (aggResult.rows?._array?.[0] ?? {}) as {
          cashier_minor?: number | null;
          credit_minor?: number | null;
          app_minor?: number | null;
        };
        const localShare =
          Number(agg.cashier_minor ?? 0) +
          Number(agg.credit_minor ?? 0) +
          Number(agg.app_minor ?? 0);

        // First full sight of this customer? Freeze the historical
        // gap as the baseline — pre-existing history (another
        // device's era) must never leak in as fresh collections.
        const cacheRow = await db.execute(
          'SELECT reconcile_offset_minor FROM sila_customers WHERE customer_id = ?',
          [row.customerId],
        );
        const cached = cacheRow.rows?._array?.[0] as
          | {reconcile_offset_minor?: number | null}
          | undefined;
        if (cached == null) {
          newCustomerOffsets.set(
            row.customerId,
            Math.max(0, Math.round(collectedOnStoreDebts - localShare)),
          );
          continue; // nothing to record on the very first sight
        }
        const offset = Number(cached.reconcile_offset_minor ?? 0);
        const unrecorded = collectedOnStoreDebts - localShare - offset;
        if (unrecorded <= 0) {
          continue; // books already know everything above the anchor
        }
        await db.execute(
          `INSERT INTO sila_app_collections (
             customer_id, customer_name, amount_minor,
             pos_purchases_minor, pos_outstanding_minor, detected_at
           ) VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
          [
            row.customerId,
            row.name,
            Math.round(unrecorded),
            Math.round(row.posPurchasesMinor),
            Math.round(row.posOutstandingMinor),
          ],
        );
        recordedTotal += Math.round(unrecorded);
        recordedCount += 1;
        logDiag(
          'sila',
          `تحصيل عبر تطبيق صِلة: ${row.name} — ${(unrecorded / 100).toFixed(2)}₪ على ديون المتجر`,
        );
      } catch (error) {
        // One customer's reconciliation failing must never block
        // the rest of the feed — the pass is idempotent, the next
        // cycle retries this customer's gap.
        logDiag(
          'sila',
          `تعذر مطابقة تحصيلات ${row.name}: ${toMessage(error)}`,
          'warn',
        );
      }
    }
    if (recordedCount > 0) {
      logDiag(
        'sila',
        `سُجّل ${recordedCount} تحصيل عبر تطبيق صِلة بإجمالي ${(recordedTotal / 100).toFixed(2)}₪`,
      );
    }
    return recordedTotal;
  },

  /** v18 (round-24 #1): store-wide totals of the Sila-app collections
   *  ledger — the treasury and the Home dashboard read this so money
   *  collected by صِلة on the store's behalf is never invisible. */
  async appCollectionsTotals(): Promise<{
    allMinor: number;
    allCount: number;
    todayMinor: number;
  }> {
    try {
      const result = await getDb().execute(
        `SELECT
           COALESCE(SUM(amount_minor), 0) AS all_minor,
           COUNT(*) AS all_count,
           COALESCE(SUM(CASE WHEN date(detected_at, 'localtime') = date('now', 'localtime') THEN amount_minor ELSE 0 END), 0) AS today_minor
         FROM sila_app_collections`,
      );
      const row = (result.rows?._array?.[0] ?? {}) as {
        all_minor?: number | null;
        all_count?: number | null;
        today_minor?: number | null;
      };
      return {
        allMinor: Number(row.all_minor ?? 0),
        allCount: Number(row.all_count ?? 0),
        todayMinor: Number(row.today_minor ?? 0),
      };
    } catch (error) {
      logDiag(
        'sila',
        `تعذر جمع تحصيلات تطبيق صِلة: ${toMessage(error)}`,
        'warn',
      );
      return {allMinor: 0, allCount: 0, todayMinor: 0};
    }
  },

  /** v18 (round-24 #1): Sila-app collections inside a date range
   *  (reports) — by detected_at, the moment the store learned of
   *  them (the actual payment happened server-side shortly before). */
  async appCollectionsInRange(
    from: string,
    to: string,
  ): Promise<{count: number; minor: number}> {
    try {
      const result = await getDb().execute(
        `SELECT COUNT(*) AS cnt, COALESCE(SUM(amount_minor), 0) AS minor
         FROM sila_app_collections
         WHERE detected_at >= ? AND detected_at <= ?`,
        [`${from} 00:00:00`, `${to} 23:59:59`],
      );
      const row = (result.rows?._array?.[0] ?? {}) as {
        cnt?: number | null;
        minor?: number | null;
      };
      return {count: Number(row.cnt ?? 0), minor: Number(row.minor ?? 0)};
    } catch {
      return {count: 0, minor: 0};
    }
  },

  /** v18 (round-24 #1): recent collection rows for the merchant's
   *  ledger views (newest first). */
  async recentAppCollections(
    limit = 40,
  ): Promise<
    {
      local_id: number;
      customer_id: string;
      customer_name: string | null;
      amount_minor: number;
      detected_at: string;
    }[]
  > {
    try {
      const result = await getDb().execute(
        `SELECT local_id, customer_id, customer_name, amount_minor, detected_at
         FROM sila_app_collections
         ORDER BY local_id DESC
         LIMIT ?`,
        [limit],
      );
      return (result.rows?._array ?? []).map(row => ({
        local_id: Number((row as {local_id?: number}).local_id ?? 0),
        customer_id: String((row as {customer_id?: string}).customer_id ?? ''),
        customer_name: (row as {customer_name?: string}).customer_name ?? null,
        amount_minor: Number((row as {amount_minor?: number}).amount_minor ?? 0),
        detected_at: String((row as {detected_at?: string}).detected_at ?? ''),
      }));
    } catch {
      return [];
    }
  },
};
