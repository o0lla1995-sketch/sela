/**
 * LocalDebtsRepo — the STORE-LOCAL debt book (round-22 #4).
 * ─────────────────────────────────────────────────────────────────
 * Customer accounts that live ONLY in this store's books: ID
 * number + name + phone, their debts (INV-L-…) and repayments
 * (RCP-L-…). Nothing here is ever uploaded to صِلة — until the
 * merchant explicitly migrates a linked customer's outstanding
 * debts (each takes a FRESH INV-D number through the same
 * collision-proof reservation as new debt sales, then uploads
 * through the normal صِلة queue).
 *
 * Cross-system dedupe is by ID NUMBER:
 *  - local_customers.id_number is UNIQUE (SQLite enforces it),
 *  - creating an account whose ID number already sits in the صِلة
 *    cache (sila_customers.id_number) is refused with guidance —
 *    the same person must not exist on both sides,
 *  - scanning a صِلة QR whose cid matches a LINKED local account
 *    redirects the debt to the LOCAL book (the store keeps a
 *    single truth per person).
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
import type {
  LocalCustomer,
  LocalCustomerBalance,
  LocalDebt,
  LocalPayment,
} from '../../core/types';

function rowToCustomer(row: Record<string, unknown>): LocalCustomer {
  return {
    id: Number(row.id ?? 0),
    id_number: String(row.id_number ?? ''),
    name: String(row.name ?? ''),
    phone: (row.phone as string) ?? null,
    notes: (row.notes as string) ?? null,
    sila_customer_id: (row.sila_customer_id as string) ?? null,
    sila_linked_at: (row.sila_linked_at as string) ?? null,
    created_at: String(row.created_at ?? ''),
  };
}

function rowToDebt(row: Record<string, unknown>): LocalDebt {
  return {
    id: Number(row.id ?? 0),
    local_customer_id: Number(row.local_customer_id ?? 0),
    invoice_ref: String(row.invoice_ref ?? ''),
    amount_minor: Number(row.amount_minor ?? 0),
    description: (row.description as string) ?? null,
    migrated: Number(row.migrated ?? 0),
    migrated_ref: (row.migrated_ref as string) ?? null,
    created_at: String(row.created_at ?? ''),
  };
}

function rowToPayment(row: Record<string, unknown>): LocalPayment {
  return {
    id: Number(row.id ?? 0),
    local_customer_id: Number(row.local_customer_id ?? 0),
    receipt_ref: String(row.receipt_ref ?? ''),
    amount_minor: Number(row.amount_minor ?? 0),
    method: (row.method as LocalPayment['method']) ?? 'cash',
    note: (row.note as string) ?? null,
    created_at: String(row.created_at ?? ''),
  };
}

/** INV-L-YYYYMMDD-NNNN — DB-aware, never-backwards (the local twin
 *  of the debt-queue numbering discipline; a separate series so a
 *  future صِلة migration can always take fresh INV-D numbers). */
async function maxLocalDebtSequence(): Promise<number> {
  let max = 0;
  try {
    const result = await getDb().execute(
      "SELECT invoice_ref FROM local_debts WHERE invoice_ref LIKE 'INV-L-%'",
    );
    for (const row of result.rows?._array ?? []) {
      const match = /^INV-L-\d{8}-(\d+)$/.exec(String(row.invoice_ref ?? ''));
      if (match) {
        max = Math.max(max, parseInt(match[1], 10));
      }
    }
  } catch {
    // Fresh installs — MMKV counter alone.
  }
  try {
    const sales = await getDb().execute(
      "SELECT invoice_number FROM sales WHERE invoice_number LIKE 'INV-L-%'",
    );
    for (const row of sales.rows?._array ?? []) {
      const match = /^INV-L-\d{8}-(\d+)$/.exec(String(row.invoice_number ?? ''));
      if (match) {
        max = Math.max(max, parseInt(match[1], 10));
      }
    }
  } catch {
    // Best effort.
  }
  return max;
}

export const LocalDebtsRepo = {
  /** Reserves the next LOCAL debt number: INV-L-YYYYMMDD-NNNN. */
  async reserveLocalDebtRef(): Promise<string> {
    const today = localToday();
    const compact = today.replace(/-/g, '');
    const dbMax = await maxLocalDebtSequence();
    const lastDay = getString(KEYS.localDebtDay, '');
    const counter = getNumber(KEYS.localDebtCounter, 0);
    const mmkvNext = lastDay === today ? counter + 1 : 1;
    const next = Math.max(mmkvNext, dbMax + 1);
    setNumber(KEYS.localDebtCounter, next);
    setString(KEYS.localDebtDay, today);
    return `INV-L-${compact}-${String(next).padStart(4, '0')}`;
  },

  /** Reserves the next LOCAL receipt number: RCP-L-YYYYMMDD-NNNN. */
  async reserveLocalReceiptRef(): Promise<string> {
    const today = localToday();
    const compact = today.replace(/-/g, '');
    let dbMax = 0;
    try {
      const result = await getDb().execute(
        "SELECT receipt_ref FROM local_payments WHERE receipt_ref LIKE 'RCP-L-%'",
      );
      for (const row of result.rows?._array ?? []) {
        const match = /^RCP-L-\d{8}-(\d+)$/.exec(String(row.receipt_ref ?? ''));
        if (match) {
          dbMax = Math.max(dbMax, parseInt(match[1], 10));
        }
      }
    } catch {
      // Fresh installs.
    }
    const lastDay = getString(KEYS.localReceiptDay, '');
    const counter = getNumber(KEYS.localReceiptCounter, 0);
    const mmkvNext = lastDay === today ? counter + 1 : 1;
    const next = Math.max(mmkvNext, dbMax + 1);
    setNumber(KEYS.localReceiptCounter, next);
    setString(KEYS.localReceiptDay, today);
    return `RCP-L-${compact}-${String(next).padStart(4, '0')}`;
  },

  // ── customers ─────────────────────────────────────────────────

  /**
   * Creates a local debt account. Refuses (throws with a spoken
   * Arabic message) when the ID number already exists — locally OR
   * in the صِلة cache — so the same person never lives on both
   * sides («لا يتكرر نفس الزبون في الجانبين من خلال رقم الهوية»).
   */
  async createCustomer(input: {
    idNumber: string;
    name: string;
    phone: string | null;
    notes?: string | null;
  }): Promise<LocalCustomer> {
    const idNumber = input.idNumber.replace(/\s+/g, '');
    if (idNumber.length < 4) {
      throw new Error('رقم الهوية قصير جداً — أدخل 4 أرقام على الأقل');
    }
    const name = input.name.trim();
    if (name.length === 0) {
      throw new Error('اسم الزبون مطلوب');
    }
    // Local uniqueness (SQLite UNIQUE also guards, but with a nicer message).
    const localHit = await this.byIdNumber(idNumber);
    if (localHit != null) {
      throw new Error(
        `رقم الهوية مسجل مسبقاً لـ«${localHit.name}» في دفتر المتجر`,
      );
    }
    // Cross-system: the same ID on a صِلة account means the debts
    // should flow through صِلة (or be linked after creation).
    try {
      const silaHit = await getDb().execute(
        'SELECT name FROM sila_customers WHERE id_number = ? LIMIT 1',
        [idNumber],
      );
      const silaName = (silaHit.rows?._array?.[0] as {name?: string})?.name;
      if (silaName != null) {
        throw new Error(
          `هذا الرقم مسجل في صِلة لـ«${silaName}» — سجّل ديونته عبر صِلة أو اربط الحسابين من ملفه بعد الإنشاء`,
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('صِلة')) {
        throw error;
      }
      // Table missing / fresh install — continue.
    }
    await getDb().execute(
      `INSERT INTO local_customers (id_number, name, phone, notes)
       VALUES (?, ?, ?, ?)`,
      [idNumber, name, input.phone?.trim() || null, input.notes?.trim() || null],
    );
    const created = await this.byIdNumber(idNumber);
    if (created == null) {
      throw new Error('تعذر إنشاء حساب الزبون');
    }
    logDiag(
      'localDebts',
      `أُنشئ حساب دين محلي: ${created.name} (هوية ${idNumber})`,
    );
    return created;
  },

  async updateCustomer(
    id: number,
    patch: {name?: string; phone?: string | null; notes?: string | null},
  ): Promise<void> {
    const sets: string[] = [];
    const args: unknown[] = [];
    if (patch.name != null) {
      sets.push('name = ?');
      args.push(patch.name.trim());
    }
    if (patch.phone !== undefined) {
      sets.push('phone = ?');
      args.push(patch.phone?.trim() || null);
    }
    if (patch.notes !== undefined) {
      sets.push('notes = ?');
      args.push(patch.notes?.trim() || null);
    }
    if (sets.length === 0) {
      return;
    }
    args.push(id);
    await getDb().execute(
      `UPDATE local_customers SET ${sets.join(', ')} WHERE id = ?`,
      args,
    );
  },

  async deleteCustomer(id: number): Promise<void> {
    await getDb().execute('DELETE FROM local_customers WHERE id = ?', [id]);
  },

  async byId(id: number): Promise<LocalCustomer | null> {
    try {
      const result = await getDb().execute(
        'SELECT * FROM local_customers WHERE id = ? LIMIT 1',
        [id],
      );
      const row = result.rows?._array?.[0];
      return row ? rowToCustomer(row as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  },

  async byIdNumber(idNumber: string): Promise<LocalCustomer | null> {
    try {
      const result = await getDb().execute(
        'SELECT * FROM local_customers WHERE id_number = ? LIMIT 1',
        [idNumber],
      );
      const row = result.rows?._array?.[0];
      return row ? rowToCustomer(row as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  },

  /** Local account linked to a صِلة cid (the dedupe guard for QR
   *  sales: a linked person's debts stay in the LOCAL book). */
  async bySilaCustomerId(cid: string): Promise<LocalCustomer | null> {
    if (!cid) {
      return null;
    }
    try {
      const result = await getDb().execute(
        'SELECT * FROM local_customers WHERE sila_customer_id = ? LIMIT 1',
        [cid],
      );
      const row = result.rows?._array?.[0];
      return row ? rowToCustomer(row as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  },

  /** Links (or re-links) a local account to a صِلة cid — after the
   *  merchant scans that person's صِلة QR from their profile. */
  async linkSila(id: number, silaCustomerId: string): Promise<void> {
    await getDb().execute(
      `UPDATE local_customers
       SET sila_customer_id = ?, sila_linked_at = datetime('now')
       WHERE id = ?`,
      [silaCustomerId, id],
    );
    logDiag('localDebts', `رُبط حساب محلي بحساب صِلة (${silaCustomerId})`);
  },

  async unlinkSila(id: number): Promise<void> {
    await getDb().execute(
      'UPDATE local_customers SET sila_customer_id = NULL, sila_linked_at = NULL WHERE id = ?',
      [id],
    );
  },

  /** All accounts with derived balances, most indebted first. */
  async listWithBalances(): Promise<LocalCustomerBalance[]> {
    try {
      const result = await getDb().execute(
        `SELECT lc.*,
           COALESCE((SELECT SUM(amount_minor) FROM local_debts d
                      WHERE d.local_customer_id = lc.id AND d.migrated = 0), 0) AS debt_minor,
           COALESCE((SELECT SUM(amount_minor) FROM local_payments p
                      WHERE p.local_customer_id = lc.id), 0) AS paid_minor,
           COALESCE((SELECT COUNT(*) FROM local_debts d
                      WHERE d.local_customer_id = lc.id AND d.migrated = 0), 0) AS debts_count,
           COALESCE((SELECT MAX(created_at) FROM (
                      SELECT created_at FROM local_debts WHERE local_customer_id = lc.id
                      UNION ALL
                      SELECT created_at FROM local_payments WHERE local_customer_id = lc.id)), NULL) AS last_activity
         FROM local_customers lc
         ORDER BY (debt_minor - paid_minor) DESC, lc.name COLLATE NOCASE ASC`,
      );
      return (result.rows?._array ?? []).map(row => {
        const customer = rowToCustomer(row as Record<string, unknown>);
        const debtTotalMinor = Number(
          (row as {debt_minor?: number}).debt_minor ?? 0,
        );
        const paidTotalMinor = Number(
          (row as {paid_minor?: number}).paid_minor ?? 0,
        );
        return {
          customer,
          debtTotalMinor,
          paidTotalMinor,
          outstandingMinor: debtTotalMinor - paidTotalMinor,
          debtsCount: Number((row as {debts_count?: number}).debts_count ?? 0),
          lastActivityAt:
            ((row as {last_activity?: string | null}).last_activity as string) ??
            null,
        };
      });
    } catch (error) {
      logDiag(
        'localDebts',
        `تعذر تحميل دفتر الديون المحلي: ${toMessage(error)}`,
        'warn',
      );
      return [];
    }
  },

  // ── debts & payments ──────────────────────────────────────────

  /** Records a debt on a local account (INV-L series). */
  async addDebt(input: {
    localCustomerId: number;
    amountMinor: number;
    description: string | null;
  }): Promise<LocalDebt> {
    if (input.amountMinor <= 0) {
      throw new Error('مبلغ الدين غير صالح');
    }
    const invoiceRef = await this.reserveLocalDebtRef();
    await getDb().execute(
      `INSERT INTO local_debts (local_customer_id, invoice_ref, amount_minor, description)
       VALUES (?, ?, ?, ?)`,
      [
        input.localCustomerId,
        invoiceRef,
        Math.round(input.amountMinor),
        input.description,
      ],
    );
    const row = await getDb().execute(
      'SELECT * FROM local_debts WHERE invoice_ref = ?',
      [invoiceRef],
    );
    logDiag('localDebts', `دُوّن دين محلي ${invoiceRef}`);
    return rowToDebt(row.rows?._array?.[0] ?? {});
  },

  /** Records a repayment from a local account (RCP-L series). */
  async addPayment(input: {
    localCustomerId: number;
    amountMinor: number;
    method: LocalPayment['method'];
    note?: string | null;
  }): Promise<LocalPayment> {
    if (input.amountMinor <= 0) {
      throw new Error('مبلغ السداد غير صالح');
    }
    const receiptRef = await this.reserveLocalReceiptRef();
    await getDb().execute(
      `INSERT INTO local_payments (local_customer_id, receipt_ref, amount_minor, method, note)
       VALUES (?, ?, ?, ?, ?)`,
      [
        input.localCustomerId,
        receiptRef,
        Math.round(input.amountMinor),
        input.method,
        input.note?.trim() || null,
      ],
    );
    const row = await getDb().execute(
      'SELECT * FROM local_payments WHERE receipt_ref = ?',
      [receiptRef],
    );
    logDiag('localDebts', `دُوّن سداد محلي ${receiptRef}`);
    return rowToPayment(row.rows?._array?.[0] ?? {});
  },

  async listDebts(customerId: number): Promise<LocalDebt[]> {
    try {
      const result = await getDb().execute(
        'SELECT * FROM local_debts WHERE local_customer_id = ? ORDER BY id DESC',
        [customerId],
      );
      return (result.rows?._array ?? []).map(row =>
        rowToDebt(row as Record<string, unknown>),
      );
    } catch {
      return [];
    }
  },

  async listPayments(customerId: number): Promise<LocalPayment[]> {
    try {
      const result = await getDb().execute(
        'SELECT * FROM local_payments WHERE local_customer_id = ? ORDER BY id DESC',
        [customerId],
      );
      return (result.rows?._array ?? []).map(row =>
        rowToPayment(row as Record<string, unknown>),
      );
    } catch {
      return [];
    }
  },

  // ── totals (dashboard + reports) ──────────────────────────────

  /** Store-wide local book totals. */
  async totals(): Promise<{
    outstandingMinor: number;
    debtsMinor: number;
    paymentsMinor: number;
    customersCount: number;
    debtorsCount: number;
  }> {
    try {
      const result = await getDb().execute(
        `SELECT
           COALESCE((SELECT SUM(amount_minor) FROM local_debts WHERE migrated = 0), 0) AS debts_minor,
           COALESCE((SELECT SUM(amount_minor) FROM local_payments), 0) AS pays_minor,
           (SELECT COUNT(*) FROM local_customers) AS customers,
           (SELECT COUNT(*) FROM (
              SELECT lc.id FROM local_customers lc
              WHERE (COALESCE((SELECT SUM(amount_minor) FROM local_debts d
                                WHERE d.local_customer_id = lc.id AND d.migrated = 0), 0)
                     - COALESCE((SELECT SUM(amount_minor) FROM local_payments p
                                WHERE p.local_customer_id = lc.id), 0)) > 0)) AS debtors`,
      );
      const row = (result.rows?._array?.[0] ?? {}) as {
        debts_minor?: number;
        pays_minor?: number;
        customers?: number;
        debtors?: number;
      };
      const debtsMinor = Number(row.debts_minor ?? 0);
      const paymentsMinor = Number(row.pays_minor ?? 0);
      return {
        debtsMinor,
        paymentsMinor,
        outstandingMinor: debtsMinor - paymentsMinor,
        customersCount: Number(row.customers ?? 0),
        debtorsCount: Number(row.debtors ?? 0),
      };
    } catch (error) {
      logDiag(
        'localDebts',
        `تعذر جمع ملخص الدفتر المحلي: ${toMessage(error)}`,
        'warn',
      );
      return {
        outstandingMinor: 0,
        debtsMinor: 0,
        paymentsMinor: 0,
        customersCount: 0,
        debtorsCount: 0,
      };
    }
  },

  /**
   * The migration path (round-22 #4): re-registers a LINKED
   * customer's outstanding LOCAL debts into the صِلة queue — each
   * takes a FRESH INV-D number (collision-proof) and uploads as a
   * normal debt sale upload. The local rows are marked migrated so
   * they never count twice.
   * Returns the number of debts queued for migration.
   */
  async migrateOutstandingToSila(
    customerId: number,
    reserveDebtRef: () => Promise<string>,
    enqueue: (input: {
      idempotencyKey: string;
      customerId: string;
      customerName: string;
      amountMinor: number;
      posInvoiceRef: string;
      description: string;
    }) => Promise<void>,
  ): Promise<number> {
    const customer = await this.byId(customerId);
    if (customer == null) {
      throw new Error('حساب الزبون غير موجود');
    }
    if (customer.sila_customer_id == null) {
      throw new Error(
        'اربط الحساب بحساب صِلة أولاً (امسح رمز الزبون من ملفه)',
      );
    }
    const debts = await this.listDebts(customerId);
    const outstanding = debts.reduce(
      (sum, debt) => sum + (debt.migrated === 0 ? debt.amount_minor : 0),
      0,
    );
    const paid = (await this.listPayments(customerId)).reduce(
      (sum, payment) => sum + payment.amount_minor,
      0,
    );
    if (outstanding - paid <= 0) {
      return 0;
    }
    // One queue row for the NET outstanding (a single صِلة debt) —
    // simplest correct migration; per-debt granularity stays in the
    // local book for the merchant's own audit.
    const net = Math.round(outstanding - paid);
    const freshRef = await reserveDebtRef();
    await enqueue({
      idempotencyKey: `${freshRef}-${Date.now()}`,
      customerId: customer.sila_customer_id,
      customerName: customer.name,
      amountMinor: net,
      posInvoiceRef: freshRef,
      description: `ترحيل ديون الدفتر المحلي — ${customer.name} (هوية ${customer.id_number})`,
    });
    // Mark every unmigrated debt as migrated under this ref.
    await getDb().execute(
      `UPDATE local_debts
       SET migrated = 1, migrated_ref = ?
       WHERE local_customer_id = ? AND migrated = 0`,
      [freshRef, customerId],
    );
    // And bank the received payments against the migration (a single
    // note row via description — the صِلة side already carries the
    // net figure; local payments stay visible in the local history).
    logDiag(
      'localDebts',
      `رُحّل رصيد ${customer.name} إلى صِلة: ${net} وحدة صغرى عبر ${freshRef}`,
    );
    return 1;
  },
};
