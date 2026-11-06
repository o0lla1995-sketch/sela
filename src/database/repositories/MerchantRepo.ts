/**
 * MerchantRepo — v78 (الجولة 91 #٢): دفتر حسابات التجار (الموردين).
 * ─────────────────────────────────────────────────────────────────
 * طلب التاجر: «إضافة وتطوير ميزة جديدة في التطبيق خاصة بتسجيل
 * الفواتير والمستحقات الخاصة بالتجار وصفحة لكل تاجر خاصة به
 * وبالتقارير وكل المميزات والخصائص المتوفرة في الأنظمة الاحترافية
 * العالمية بما يتناسب مع تطبيق نقطة البيع».
 *
 * النموذج المحاسبي (ذمم دائنة بمعيار Loyverse/Shopify مبسّطة
 * لPOS محلي):
 *  • فاتورة توريد (invoice) — بضاعة استلمناها من التاجر: الرصيد
 *    الذي علينا له يرتفع بمبلغها (بنودها تُخزن JSON لعرضها في
 *    كشف الحساب وطباعته).
 *  • سداد (payment) — دفعنا له من قناة (درج/بنك/محفظة): الرصيد
 *    ينخفض، ويُسجل سند خزينة مصاحب (cash_ref) كي يوازن الكشفان.
 *  • مرتجع/خصم (return) — أرجعنا له بضاعة أو حصلنا خصماً بلا
 *    حركة خزينة: الرصيد ينخفض.
 *  • تحصيل منه (collection) — أعطانا نقداً/تحويلاً (تسبيق أو
 *    تسوية): الرصيد ينخفض مع سند إيداع في الخزينة.
 *  • دين مستحق مباشر (debt) — v79 (الجولة 92 #٣): التزام مالي
 *    مباشر على حساب التاجر بلا فاتورة توريد (رسوم، نقد اقترضه
 *    التاجر منا، توريد ضاعت فاتورته…) — يرفع المستحق له تماماً
 *    كفاتورة التوريد لكن بلا بنود ولا حركة خزينة.
 *
 *  رصيد التاجر = Σ فواتير + Σ ديون − Σ سداد − Σ مرتجعات − Σ تحصيلات
 *  موجب = علينا له (مستحق) · سالب = له عندنا (دائن لنا) · صفر = مسدد.
 */
import {getDb} from '../connection';
import {localNow, localToday} from '../../core/format';
import {logDiag} from '../../core/diagnostics';

export type MerchantMovementKind =
  | 'invoice'
  | 'payment'
  | 'return'
  | 'collection'
  | 'debt';

export interface Merchant {
  id: number;
  name: string;
  phone: string | null;
  id_number: string | null;
  notes: string | null;
  created_at: string;
}

/** بند فاتورة التوريد — وصف حر أو منتج من الكتالوج. */
export interface MerchantInvoiceItem {
  name: string;
  qty: number;
  price: number;
  total: number;
}

export interface MerchantMovement {
  id: number;
  merchantId: number;
  ref: string;
  kind: MerchantMovementKind;
  amount: number;
  method: string | null;
  note: string | null;
  items: MerchantInvoiceItem[] | null;
  cashRef: string | null;
  createdAt: string;
}

/** صف تاجر في القائمة الرئيسية — رصيده الحالي وتفكيكه. */
export interface MerchantBalance {
  merchant: Merchant;
  /** موجب = علينا له · سالب = له عندنا. */
  balance: number;
  invoiceTotal: number;
  paymentTotal: number;
  returnTotal: number;
  collectionTotal: number;
  /** v79: ديون مستحقة مباشرة بلا فاتورة توريد. */
  debtTotal: number;
  /** آخر حركة (أي نوع) بصيغة ISO أو null. */
  lastAt: string | null;
}

/** صف كشف الحساب — الحركة والرصيد الجاري بعدها. */
export interface MerchantStatementRow {
  movement: MerchantMovement;
  /** الرصيد بعد هذه الحركة (تصاعدياً من الأقدم). */
  runningBalance: number;
}

/** إجماليات التقارير. */
export interface MerchantTotals {
  count: number;
  /** Σ أرصدة التجار الموجبة — إجمالي ما علينا للتجار الآن. */
  owedNow: number;
  /** Σ أرصدة سالبة (مطلق القيمة) — ما للتجار عندنا. */
  creditNow: number;
  purchasesInRange: number;
  paymentsInRange: number;
  returnsInRange: number;
  collectionsInRange: number;
  /** v79: ديون مباشرة مسجلة خلال الفترة. */
  debtsInRange: number;
  topOwed: {merchant: Merchant; balance: number}[];
}

function rowToMerchant(row: Record<string, unknown>): Merchant {
  return {
    id: Number(row.id ?? 0),
    name: String(row.name ?? ''),
    phone: row.phone == null ? null : String(row.phone),
    id_number: row.id_number == null ? null : String(row.id_number),
    notes: row.notes == null ? null : String(row.notes),
    created_at: String(row.created_at ?? ''),
  };
}

function parseItems(raw: unknown): MerchantInvoiceItem[] | null {
  if (raw == null) {
    return null;
  }
  try {
    const parsed = JSON.parse(String(raw)) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }
    return parsed
      .map(item => {
        const row = (item ?? {}) as Record<string, unknown>;
        return {
          name: String(row.name ?? ''),
          qty: Number(row.qty ?? 0),
          price: Number(row.price ?? 0),
          total: Number(row.total ?? 0),
        };
      })
      .filter(item => item.name.length > 0);
  } catch {
    return null;
  }
}

function rowToMovement(row: Record<string, unknown>): MerchantMovement {
  const kind = String(row.kind ?? 'invoice');
  return {
    id: Number(row.id ?? 0),
    merchantId: Number(row.merchant_id ?? 0),
    ref: String(row.ref ?? ''),
    kind: (['invoice', 'payment', 'return', 'collection', 'debt'].includes(
      kind,
    )
      ? kind
      : 'invoice') as MerchantMovementKind,
    amount: Number(row.amount ?? 0),
    method: row.method == null ? null : String(row.method),
    note: row.note == null ? null : String(row.note),
    items: parseItems(row.items_json),
    cashRef: row.cash_ref == null ? null : String(row.cash_ref),
    createdAt: String(row.created_at ?? ''),
  };
}

/** بادئة المرجع المعروض لكل نوع حركة. */
const KIND_PREFIX: Record<MerchantMovementKind, string> = {
  invoice: 'توريد',
  payment: 'سداد',
  return: 'مرتجع',
  collection: 'تحصيل',
  debt: 'دين',
};

/** المرجع التالي للنوع — تسلسل يومي متزايد يُحسب من قيد القاعدة
 *  (روابط العرض فقط؛ المفتاس الحقيقي هو id). */
async function nextRef(kind: MerchantMovementKind): Promise<string> {
  const result = await getDb().execute(
    'SELECT COUNT(*) AS c FROM merchant_movements WHERE kind = ?',
    [kind],
  );
  const count = Number((result.rows?.[0] as {c?: number})?.c ?? 0);
  const compact = localToday().replace(/-/g, '');
  return `${KIND_PREFIX[kind]}-${compact}-${String(count + 1).padStart(4, '0')}`;
}

export const MerchantRepo = {
  // ── سجل التجار ─────────────────────────────────────────────────

  async createMerchant(input: {
    name: string;
    phone?: string | null;
    idNumber?: string | null;
    notes?: string | null;
  }): Promise<Merchant> {
    const name = input.name.trim();
    if (name.length === 0) {
      throw new Error('اسم التاجر مطلوب');
    }
    const result = await getDb().execute(
      `INSERT INTO merchants (name, phone, id_number, notes)
       VALUES (?, ?, ?, ?)`,
      [
        name,
        input.phone?.trim() || null,
        input.idNumber?.trim() || null,
        input.notes?.trim() || null,
      ],
    );
    const created = await this.byId(Number(result.insertId ?? -1));
    if (created == null) {
      throw new Error('تعذر إنشاء حساب التاجر');
    }
    logDiag('merchants', `أُنشئ حساب تاجر: ${created.name}`);
    return created;
  },

  async updateMerchant(
    id: number,
    patch: {
      name?: string;
      phone?: string | null;
      idNumber?: string | null;
      notes?: string | null;
    },
  ): Promise<void> {
    const sets: string[] = [];
    const args: (string | number | null)[] = [];
    if (patch.name != null) {
      const name = patch.name.trim();
      if (name.length === 0) {
        throw new Error('اسم التاجر مطلوب');
      }
      sets.push('name = ?');
      args.push(name);
    }
    if (patch.phone !== undefined) {
      sets.push('phone = ?');
      args.push(patch.phone?.trim() || null);
    }
    if (patch.idNumber !== undefined) {
      sets.push('id_number = ?');
      args.push(patch.idNumber?.trim() || null);
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
      `UPDATE merchants SET ${sets.join(', ')} WHERE id = ?`,
      args,
    );
  },

  /** حذف تاجر بلا حركات فقط — سجل الحركات المالي أثر لا يُمحّ
   *  (نفس انضباط الخزينة؛ التاجر صاحب تاريخ يُحذف حركاته أولاً
   *  من كشفه إن أراد التاجر تصفيره). */
  async deleteMerchant(id: number): Promise<void> {
    const used = await getDb().execute(
      'SELECT COUNT(*) AS c FROM merchant_movements WHERE merchant_id = ?',
      [id],
    );
    const count = Number((used.rows?.[0] as {c?: number})?.c ?? 0);
    if (count > 0) {
      throw new Error(
        `لا يمكن حذف التاجر — لديه ${count} حركة في كشف الحساب (فواتير توريد/سدادات). احذف حركاته أولاً من كشفه`,
      );
    }
    await getDb().execute('DELETE FROM merchants WHERE id = ?', [id]);
  },

  async byId(id: number): Promise<Merchant | null> {
    try {
      const result = await getDb().execute(
        'SELECT * FROM merchants WHERE id = ? LIMIT 1',
        [id],
      );
      const row = result.rows?.[0];
      return row ? rowToMerchant(row as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  },

  /** قائمة التجار بأرصدتهم الحية — الترتيب: الأكثر استحقاقاً أولاً. */
  async listWithBalances(
    query?: string,
  ): Promise<MerchantBalance[]> {
    const db = getDb();
    const merchants = await db.execute('SELECT * FROM merchants ORDER BY name ASC');
    const rows = (merchants.rows ?? []) as unknown as Record<string, unknown>[];
    if (rows.length === 0) {
      return [];
    }
    const sums = await db.execute(
      `SELECT merchant_id,
              SUM(CASE WHEN kind = 'invoice' THEN amount ELSE 0 END) AS invoices,
              SUM(CASE WHEN kind = 'payment' THEN amount ELSE 0 END) AS payments,
              SUM(CASE WHEN kind = 'return' THEN amount ELSE 0 END) AS returns,
              SUM(CASE WHEN kind = 'collection' THEN amount ELSE 0 END) AS collections,
              SUM(CASE WHEN kind = 'debt' THEN amount ELSE 0 END) AS debts,
              MAX(created_at) AS last_at
       FROM merchant_movements GROUP BY merchant_id`,
    );
    const sumByMerchant = new Map<number, Record<string, unknown>>();
    for (const row of (sums.rows ?? []) as unknown as Record<string, unknown>[]) {
      sumByMerchant.set(Number(row.merchant_id), row);
    }
    const q = (query ?? '').trim().toLowerCase();
    const result: MerchantBalance[] = [];
    for (const row of rows) {
      const merchant = rowToMerchant(row);
      if (q.length > 0) {
        const hay = [
          merchant.name,
          merchant.phone ?? '',
          merchant.id_number ?? '',
          merchant.notes ?? '',
        ]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) {
          continue;
        }
      }
      const sums = sumByMerchant.get(merchant.id);
      const invoiceTotal = Number(sums?.invoices ?? 0);
      const paymentTotal = Number(sums?.payments ?? 0);
      const returnTotal = Number(sums?.returns ?? 0);
      const collectionTotal = Number(sums?.collections ?? 0);
      const debtTotal = Number(sums?.debts ?? 0);
      result.push({
        merchant,
        balance:
          invoiceTotal +
          debtTotal -
          paymentTotal -
          returnTotal -
          collectionTotal,
        invoiceTotal,
        paymentTotal,
        returnTotal,
        collectionTotal,
        debtTotal,
        lastAt: sums?.last_at == null ? null : String(sums.last_at),
      });
    }
    // الأكثر استحقاقاً (علينا له) أولاً ثم الأكثر نشاطاً.
    result.sort((a, b) => b.balance - a.balance || a.merchant.name.localeCompare(b.merchant.name, 'ar'));
    return result;
  },

  // ── الحركات ────────────────────────────────────────────────────

  /** فاتورة توريد جديدة — الرصيد يرتفع بمبلغها. */
  async addInvoice(input: {
    merchantId: number;
    items: MerchantInvoiceItem[];
    note?: string | null;
    createdAt?: string;
  }): Promise<MerchantMovement> {
    const items = input.items
      .map(item => ({
        name: item.name.trim(),
        qty: Number(item.qty),
        price: Number(item.price),
        total: Math.round(Number(item.qty) * Number(item.price) * 100) / 100,
      }))
      .filter(item => item.name.length > 0 && item.qty > 0);
    if (items.length === 0) {
      throw new Error('أضف بنداً واحداً على الأقل لفاتورة التوريد');
    }
    const total =
      Math.round(items.reduce((sum, item) => sum + item.total, 0) * 100) /
      100;
    if (total <= 0) {
      throw new Error('إجمالي الفاتورة يجب أن يكون أكبر من صفر');
    }
    const ref = await nextRef('invoice');
    const result = await getDb().execute(
      `INSERT INTO merchant_movements
        (merchant_id, ref, kind, amount, note, items_json, created_at)
       VALUES (?, ?, 'invoice', ?, ?, ?, ?)`,
      [
        input.merchantId,
        ref,
        total,
        input.note?.trim() || null,
        JSON.stringify(items),
        // v79 (الجولة 92 #٣): الجذر الحقيقي لخطأ «تعذر حفظ الفاتورة —
        // NOT NULL constraint failed: merchant_movements.created_at»:
        // تمرير NULL صريحاً يتجاوز DEFAULT العمود (القيمة الافتراضية
        // تُطبّق فقط عند غياب العمود أصلاً) — نفس الإصلاح في الإدراجات
        // الأربعة كلها. الطابع الزمني المحلي يطابق صيغة datetime('now').
        input.createdAt ?? localNow(),
      ],
    );
    logDiag(
      'merchants',
      `فاتورة توريد ${ref} بمبلغ ${total.toFixed(2)} ₪`,
    );
    return (await this.movementById(Number(result.insertId ?? -1)))!;
  },

  /** سداد له من قناة — الرصيد ينخفض؛ cashRef يربط سند الخزينة. */
  async addPayment(input: {
    merchantId: number;
    amount: number;
    method?: string | null;
    note?: string | null;
    cashRef?: string | null;
    createdAt?: string;
  }): Promise<MerchantMovement> {
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('مبلغ السداد يجب أن يكون أكبر من صفر');
    }
    const ref = await nextRef('payment');
    const result = await getDb().execute(
      `INSERT INTO merchant_movements
        (merchant_id, ref, kind, amount, method, note, cash_ref, created_at)
       VALUES (?, ?, 'payment', ?, ?, ?, ?, ?)`,
      [
        input.merchantId,
        ref,
        Math.round(amount * 100) / 100,
        input.method ?? 'cash',
        input.note?.trim() || null,
        input.cashRef ?? null,
        input.createdAt ?? localNow(),
      ],
    );
    logDiag('merchants', `سداد ${ref} بمبلغ ${amount.toFixed(2)} ₪`);
    return (await this.movementById(Number(result.insertId ?? -1)))!;
  },

  /** مرتجع بضاعة له أو خصم — يخفض الرصيد بلا حركة خزينة. */
  async addReturn(input: {
    merchantId: number;
    amount: number;
    note?: string | null;
    createdAt?: string;
  }): Promise<MerchantMovement> {
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('قيمة المرتجع/الخصم يجب أن تكون أكبر من صفر');
    }
    const ref = await nextRef('return');
    const result = await getDb().execute(
      `INSERT INTO merchant_movements
        (merchant_id, ref, kind, amount, note, created_at)
       VALUES (?, ?, 'return', ?, ?, ?)`,
      [
        input.merchantId,
        ref,
        Math.round(amount * 100) / 100,
        input.note?.trim() || null,
        input.createdAt ?? localNow(),
      ],
    );
    return (await this.movementById(Number(result.insertId ?? -1)))!;
  },

  /** v79 (الجولة 92 #٣): دين مستحق مباشر بلا فاتورة توريد — يرفع
   *  المستحق للتاجر (رسوم/نقد/التزام اتفقنا عليه بلا بضاعة موثقة)
   *  ولا يمس الخزينة إطلاقاً؛ يُسدّد لاحقاً كأي سداد عادي. */
  async addDirectDebt(input: {
    merchantId: number;
    amount: number;
    note?: string | null;
    createdAt?: string;
  }): Promise<MerchantMovement> {
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('مبلغ الدين المستحق يجب أن يكون أكبر من صفر');
    }
    const ref = await nextRef('debt');
    const result = await getDb().execute(
      `INSERT INTO merchant_movements
        (merchant_id, ref, kind, amount, note, created_at)
       VALUES (?, ?, 'debt', ?, ?, ?)`,
      [
        input.merchantId,
        ref,
        Math.round(amount * 100) / 100,
        input.note?.trim() || null,
        input.createdAt ?? localNow(),
      ],
    );
    logDiag(
      'merchants',
      `دين مستحق مباشر ${ref} بمبلغ ${amount.toFixed(2)} ₪`,
    );
    return (await this.movementById(Number(result.insertId ?? -1)))!;
  },

  /** تحصيل منه (نقداً/تحويلاً إلينا) — يخفض الرصيد مع سند إيداع. */
  async addCollection(input: {
    merchantId: number;
    amount: number;
    method?: string | null;
    note?: string | null;
    cashRef?: string | null;
    createdAt?: string;
  }): Promise<MerchantMovement> {
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('مبلغ التحصيل يجب أن يكون أكبر من صفر');
    }
    const ref = await nextRef('collection');
    const result = await getDb().execute(
      `INSERT INTO merchant_movements
        (merchant_id, ref, kind, amount, method, note, cash_ref, created_at)
       VALUES (?, ?, 'collection', ?, ?, ?, ?, ?)`,
      [
        input.merchantId,
        ref,
        Math.round(amount * 100) / 100,
        input.method ?? 'cash',
        input.note?.trim() || null,
        input.cashRef ?? null,
        input.createdAt ?? localNow(),
      ],
    );
    return (await this.movementById(Number(result.insertId ?? -1)))!;
  },

  async movementById(id: number): Promise<MerchantMovement | null> {
    const result = await getDb().execute(
      'SELECT * FROM merchant_movements WHERE id = ? LIMIT 1',
      [id],
    );
    const row = result.rows?.[0];
    return row ? rowToMovement(row as Record<string, unknown>) : null;
  },

  /** كشف حساب التاجر — الأحدث أولاً مع الرصيد الجاري بعد كل حركة. */
  async statement(
    merchantId: number,
    limit = 500,
  ): Promise<MerchantStatementRow[]> {
    const result = await getDb().execute(
      `SELECT * FROM merchant_movements WHERE merchant_id = ?
       ORDER BY created_at ASC, id ASC`,
      [merchantId],
    );
    const rows = (result.rows ?? []) as unknown as Record<string, unknown>[];
    let running = 0;
    const asc: MerchantStatementRow[] = [];
    for (const row of rows) {
      const movement = rowToMovement(row);
      // v79: الدين المباشر كفاتورة التوريد — يرفع الرصيد الجاري.
      running +=
        movement.kind === 'invoice' || movement.kind === 'debt'
          ? movement.amount
          : -movement.amount;
      asc.push({movement, runningBalance: Math.round(running * 100) / 100});
    }
    return asc.slice(-limit).reverse();
  },

  /** رصيد تاجر واحد الآن — null إن لم يوجد. */
  async balanceNow(merchantId: number): Promise<number | null> {
    const result = await getDb().execute(
      `SELECT SUM(CASE WHEN kind IN ('invoice', 'debt') THEN amount ELSE -amount END) AS bal
       FROM merchant_movements WHERE merchant_id = ?`,
      [merchantId],
    );
    const row = result.rows?.[0] as {bal?: number | null} | undefined;
    if (row == null) {
      return null;
    }
    return Math.round(Number(row.bal ?? 0) * 100) / 100;
  },

  // ── التقارير ───────────────────────────────────────────────────

  /** إجماليات التجار (الرصيد الآن + حركة فترة اختيارية). */
  async totals(from?: string, to?: string): Promise<MerchantTotals> {
    const db = getDb();
    const list = await this.listWithBalances();
    let owedNow = 0;
    let creditNow = 0;
    const owed: {merchant: Merchant; balance: number}[] = [];
    for (const entry of list) {
      if (entry.balance > 0.005) {
        owedNow += entry.balance;
        owed.push({merchant: entry.merchant, balance: entry.balance});
      } else if (entry.balance < -0.005) {
        creditNow += Math.abs(entry.balance);
      }
    }
    owed.sort((a, b) => b.balance - a.balance);

    let purchasesInRange = 0;
    let paymentsInRange = 0;
    let returnsInRange = 0;
    let collectionsInRange = 0;
    let debtsInRange = 0;
    if (from != null && to != null) {
      const inRange = await db.execute(
        `SELECT kind, SUM(amount) AS s FROM merchant_movements
         WHERE created_at >= ? AND created_at <= ? || ' 23:59:59'
         GROUP BY kind`,
        [from, to],
      );
      for (const row of (inRange.rows ??
        []) as unknown as Record<string, unknown>[]) {
        const sum = Number(row.s ?? 0);
        switch (String(row.kind)) {
          case 'invoice':
            purchasesInRange = sum;
            break;
          case 'payment':
            paymentsInRange = sum;
            break;
          case 'return':
            returnsInRange = sum;
            break;
          case 'collection':
            collectionsInRange = sum;
            break;
          case 'debt':
            debtsInRange = sum;
            break;
        }
      }
    }
    return {
      count: list.length,
      owedNow: Math.round(owedNow * 100) / 100,
      creditNow: Math.round(creditNow * 100) / 100,
      purchasesInRange: Math.round(purchasesInRange * 100) / 100,
      paymentsInRange: Math.round(paymentsInRange * 100) / 100,
      returnsInRange: Math.round(returnsInRange * 100) / 100,
      collectionsInRange: Math.round(collectionsInRange * 100) / 100,
      debtsInRange: Math.round(debtsInRange * 100) / 100,
      topOwed: owed.slice(0, 5),
    };
  },
};
