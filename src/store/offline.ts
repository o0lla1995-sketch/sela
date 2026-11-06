/**
 * store/offline.ts — v2.0: قلب «العمل دون اتصال» (أهم طلبات التاجر).
 * ─────────────────────────────────────────────────────────────────
 * القاعدة المحلية SQLite (عبر LanBridge) تحمل:
 *  • invoices — أرشيف فواتير هذا الكاشير (محلية + مزامنة) بتقاريره.
 *  • invoice_items — أصناف كل فاتورة (للإرجاع والإحصاءات دون اتصال).
 *  • outbox — طابور العمليات بانتظار المزامنة (بيع/مرتجع).
 *  • kv — كتالوج المخزون المؤقت + زبائن الدفتر + مؤشرات المزامنة.
 *
 * مبادئ السلامة (لا تعارض بين حسابات الكاشيرين — أبداً):
 *  ① رقم الفاتورة الحقيقي تمنحه نقطة البيع وحدها لحظة المزامنة؛
 *     المحلية تُعرض برقم مؤقت «م-رقم» + شارة «بانتظار المزامنة».
 *  ② كل عملية تحمل clientRef فريداً من هذا الجهاز — إعادة إرسال
 *     الدفعة تعيد النتيجة الأصلية نفسها (duplicate) بلا ازدواج.
 *  ③ الدفعات تُعالج بالتسلسل: بيعٌ أُجري دون اتصال ثم مرتجعه
 *     يُحل عبر saleClientRef بعد أن سبقته فاتورته في نفس الدفعة.
 */
import {localDb, type DbRow} from '../native';
import type {
  CatalogProduct,
  LocalCustomer,
} from '../api/types';

export type OpKind = 'sale' | 'return';

export interface OutboxOp {
  opId: string;
  kind: OpKind;
  payload: Record<string, unknown>;
  createdAt: string;
  attempts: number;
  lastError: string | null;
}

export interface LocalInvoice {
  ref: string;
  kind: OpKind;
  /** الرقم المعروض: مؤقت «م-N» قبل المزامنة أو الحقيقي بعدها. */
  displayNumber: string;
  /** رقم الخادم الحقيقي بعد المزامنة (null ما دالت بانتظارها). */
  syncedNumber: string | null;
  status: 'pending' | 'synced' | 'rejected';
  /** بيع: cash|debt · مرتجع: refund|exchange */
  payKind: string;
  /** v3.4 (الجولة 77 — كاشير #3): طريقة الدفع الفعلية (بنك/محفظة
   *  أو نقدي) — تُخزن مع الفاتورة المحلية وتُعرض شارةً في أرشيف
   *  الكاشير، فتطابق الفواتير نقطة البيع تماماً. */
  payMethod: string;
  total: number;
  discount: number;
  customerName: string | null;
  /** v3.5 (الجولة 91 — كاشير #2): معرّف زبون الدفتر لبيعة الدين
   *  المحلية — به يُبنى «دفتر الدين المعلق» لحظة البيع دون
   *  اتصال، ويُصالَح تلقائياً مع أرصدة الخادم بعد المزامنة. */
  customerId: number | null;
  createdAt: string;
  syncedAt: string | null;
  rejectReason: string | null;
  /** v3.1: للمرتجعات — مرجع فاتورة البيع المصدر (ربط دقيق). */
  sourceRef: string | null;
}

export interface LocalInvoiceItem {
  id: number;
  invoiceRef: string;
  productId: number;
  name: string;
  variantId: number | null;
  variantLabel: string | null;
  unitName: string | null;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

/** v3.2 (الجولة 74 #6): تسوية مخزون معلّقة (بالوحدات الأساس) —
 *  عمليات بيعت/رُجعت محلياً ولم تصل نقطة البيع بعد. المتاح للعرض
 *  = مخزون آخر مزامنة ناجحة + هذه التسويات؛ وبعد المزامنة يتعادل
 *  تلقائياً (العملية تخرج من المعلّق ومخزون الخادم الجديد يشملها). */
export interface PendingStockAdjustment {
  productId: number;
  variantId: number | null;
  /** سالب للبيع، موجب لمرتجع — بالوحدات الأساس. */
  deltaBase: number;
}

let initialized = false;

/** إنشاء المخطط (idempotent) — يُستدعى مرة عند الإقلاع. */
export async function initOfflineStore(): Promise<void> {
  if (initialized) {
    return;
  }
  await localDb.run(`CREATE TABLE IF NOT EXISTS invoices (
    ref TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    display_number TEXT NOT NULL,
    synced_number TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    pay_kind TEXT NOT NULL,
    payment_method TEXT,
    total REAL NOT NULL,
    discount REAL NOT NULL DEFAULT 0,
    customer_name TEXT,
    created_at TEXT NOT NULL,
    synced_at TEXT,
    reject_reason TEXT,
    source_ref TEXT
  )`);
  // v3.1: ترحيل التثبيتات القديمة — عمود ربط المرتجع بفاتورته
  // المصدر (ALTER TABLE ADD COLUMN آمن ومسكوك، والعمود موجود
  // أصلاً في إنشاءات القواعد الجديدة).
  try {
    await localDb.run('ALTER TABLE invoices ADD COLUMN source_ref TEXT');
  } catch {
    // العمود موجود مسبقاً — لا شيء لنفعله.
  }
  // v3.4 (الجولة 77): عمود طريقة الدفع (بنك/محفظة) — ALTER آمن
  // ومسكوك مثل source_ref تماماً.
  try {
    await localDb.run('ALTER TABLE invoices ADD COLUMN payment_method TEXT');
  } catch {
    // العمود موجود مسبقاً.
  }
  // v3.5 (الجولة 91 — كاشير #2): معرّف زبون الدفتر — لدفتر الدين
  // المحلي المعلق (بيع دين دون اتصال يظهر رصيده فوراً).
  try {
    await localDb.run('ALTER TABLE invoices ADD COLUMN customer_id INTEGER');
  } catch {
    // العمود موجود مسبقاً.
  }
  await localDb.run(`CREATE TABLE IF NOT EXISTS invoice_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_ref TEXT NOT NULL,
    product_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    variant_label TEXT,
    unit_name TEXT,
    quantity REAL NOT NULL,
    unit_price REAL NOT NULL,
    line_total REAL NOT NULL,
    variant_id INTEGER,
    conversion REAL NOT NULL DEFAULT 1
  )`);
  // v3.2: ترحيل التثبيتات القديمة — عمودا ربط المخزون المعلّق:
  // معرّف المتغير ومعامل التحويل للوحدة الأساس (مسكوكان وآمنان).
  try {
    await localDb.run('ALTER TABLE invoice_items ADD COLUMN variant_id INTEGER');
  } catch {
    // موجود مسبقاً.
  }
  try {
    await localDb.run(
      'ALTER TABLE invoice_items ADD COLUMN conversion REAL NOT NULL DEFAULT 1',
    );
  } catch {
    // موجود مسبقاً.
  }
  await localDb.run(`CREATE INDEX IF NOT EXISTS idx_items_invoice
    ON invoice_items(invoice_ref)`);
  await localDb.run(`CREATE TABLE IF NOT EXISTS outbox (
    op_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
  )`);
  await localDb.run(`CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);
  initialized = true;
}

// ── KV بسيط ──────────────────────────────────────────────────────
export async function kvGet(key: string): Promise<string | null> {
  const rows = await localDb.select('SELECT value FROM kv WHERE key = ?', [
    key,
  ]);
  return rows.length > 0 ? String(rows[0].value) : null;
}

export async function kvSet(key: string, value: string): Promise<void> {
  await localDb.run(
    `INSERT INTO kv (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value],
  );
}

// ── الكتالوج المؤقت (للتسعير دون اتصال) ──────────────────────────
const CATALOG_KEY = 'catalog_cache_v2';
const CUSTOMERS_KEY = 'customers_cache_v2';

export async function cacheCatalog(products: CatalogProduct[]): Promise<void> {
  await kvSet(CATALOG_KEY, JSON.stringify({at: Date.now(), products}));
}

export async function loadCachedCatalog(): Promise<CatalogProduct[]> {
  const raw = await kvGet(CATALOG_KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as {products: CatalogProduct[]};
    return Array.isArray(parsed.products) ? parsed.products : [];
  } catch {
    return [];
  }
}

export async function cacheCustomers(
  customers: LocalCustomer[],
): Promise<void> {
  await kvSet(CUSTOMERS_KEY, JSON.stringify(customers));
}

export async function loadCachedCustomers(): Promise<LocalCustomer[]> {
  const raw = await kvGet(CUSTOMERS_KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as LocalCustomer[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ── الأرقام المؤقتة المحلية ──────────────────────────────────────
/** الرقم المؤقت اليومي «م-12» — لا يُستخدم في أي حساب عند الخادم. */
export async function nextLocalNumber(): Promise<string> {
  const today = localDayKey();
  const rows = await localDb.select(
    `SELECT COUNT(*) AS c FROM invoices
     WHERE created_at LIKE ? AND kind = 'sale'`,
    [`${today}%`],
  );
  const count = rows.length > 0 ? Number(rows[0].c ?? 0) : 0;
  return `م-${count + 1}`;
}

function localDayKey(): string {
  const now = new Date();
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// ── تسجيل عمليات محلية (بيع أو مرتجع) + إدراجها في الطابور ──────
export interface DraftLine {
  productId: number;
  name: string;
  variantId: number | null;
  variantLabel: string | null;
  unitId: number | null;
  unitName: string | null;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  /** v3.2: معامل التحويل للوحدة الأساس (لحساب المخزون المعلّق
   *  بدقة أثناء العمل دون اتصال) — الافتراض 1 (قطعة). */
  conversion?: number;
}

/**
 * حفظ عملية محلياً داخل معاملة واحدة:
 *  ① صف الفاتورة في الأرشيف برقم مؤقت.
 *  ② أصنافها.
 *  ③ العملية في طابور المزامنة (payload كامل كما يرسله الخادم).
 */
export async function recordLocalOp(input: {
  ref: string;
  kind: OpKind;
  displayNumber: string;
  payKind: string;
  /** v3.4: طريقة الدفع الفعلية (بنك/محفظة/نقدي) للفواتير المحلية. */
  payMethod?: string | null;
  total: number;
  discount: number;
  /** v3.5: اسم الزبون الحقيقي (لا «زبون الدفتر») — يظهر في
   *  الأرشيف ويُسافر مع الحمولة ليشفي الخادم الربط بالاسم. */
  customerName: string | null;
  /** v3.5: معرّف زبون الدفتر — لدفتر الدين المحلي المعلق. */
  customerId?: number | null;
  createdAt: string;
  lines: DraftLine[];
  payload: Record<string, unknown>;
  /** v3.1: للمرتجعات — فاتورة البيع المصدر (ربط المتبقي بدقة). */
  sourceRef?: string | null;
}): Promise<void> {
  await initOfflineStore();
  await localDb.tx([
    {
      /* v3.4.1 (الجولة 78): إصلاح جوهري — كانت VALUES تحمل 15 قيمة
       * لـ14 عموداً (علامة ? زائدة قبل NULL, NULL) فيرفض SQLite
       * العملية كلها برسالة SQLITE_ERROR عند البيع دون اتصال مع
       * اختيار طريقة الدفع. المحاذاة الآن حرفية:
       *   ref, kind, display_number ← ؟؟؟
       *   synced_number ← NULL · status ← 'pending'
       *   pay_kind, payment_method, total, discount,
       *   customer_name, customer_id, created_at ← ؟؟؟؟؟؟؟
       *   synced_at, reject_reason ← NULL, NULL · source_ref ← ؟ */
      sql: `INSERT INTO invoices
        (ref, kind, display_number, synced_number, status, pay_kind,
         payment_method, total,
         discount, customer_name, customer_id, created_at,
         synced_at, reject_reason, source_ref)
       VALUES (?, ?, ?, NULL, 'pending', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
      params: [
        input.ref,
        input.kind,
        input.displayNumber,
        input.payKind,
        input.payMethod ?? null,
        input.total,
        input.discount,
        input.customerName,
        input.customerId ?? null,
        input.createdAt,
        input.sourceRef ?? null,
      ],
    },
    ...input.lines.map(line => ({
      sql: `INSERT INTO invoice_items
        (invoice_ref, product_id, name, variant_label, unit_name,
         quantity, unit_price, line_total, variant_id, conversion)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        input.ref,
        line.productId,
        line.name,
        line.variantLabel,
        line.unitName,
        line.quantity,
        line.unitPrice,
        line.lineTotal,
        line.variantId ?? null,
        line.conversion ?? 1,
      ],
    })),
    {
      sql: `INSERT INTO outbox (op_id, kind, payload, created_at, attempts, last_error)
       VALUES (?, ?, ?, ?, 0, NULL)`,
      params: [
        input.ref,
        input.kind,
        JSON.stringify(input.payload),
        input.createdAt,
      ],
    },
  ]);
}

// ── قراءة الطابور والأرشيف ───────────────────────────────────────
export async function pendingOps(limit = 30): Promise<OutboxOp[]> {
  await initOfflineStore();
  const rows = await localDb.select(
    `SELECT op_id, kind, payload, created_at, attempts, last_error
     FROM outbox ORDER BY rowid ASC LIMIT ?`,
    [limit],
  );
  return rows.map(rowToOp);
}

/**
 * v3.2 (الجولة 74 #6) — تسويات المخزون المعلّقة بالوحدات الأساس.
 *
 * مبدأ «آخر مزامنة ناجحة» (طلب التاجر نصاً): دون اتصال، يعمل
 * التطبيق على مخزون آخر مزامنة، والعمليات المحلية تُخصم/تُرجع
 * محلياً فوقه — بلا أي مساس بمخزون نقطة البيع الرئيسية (لا يتغير
 * هناك شيء إلا لحظة المزامنة داخل معاملاتها المحروسة). الصيغة:
 *
 *   المتاح المعروض = مخزون آخر مزامنة + Σ(معلّق)
 *
 * وبعد المزامنة يتعادل الطرفان تلقائياً: العملية تغادر المعلّق
 * ومخزون الخادم المسحوب يشملها أصلاً — لا ازدواج خصم أبداً.
 */
export async function pendingStockAdjustments(): Promise<
  PendingStockAdjustment[]
> {
  await initOfflineStore();
  const rows = await localDb.select(
    `SELECT ii.product_id AS product_id,
            ii.variant_id AS variant_id,
            CASE WHEN i.kind = 'return' THEN 1 ELSE -1 END AS sign,
            SUM(ii.quantity * COALESCE(ii.conversion, 1)) AS delta
     FROM invoice_items ii
     JOIN invoices i ON i.ref = ii.invoice_ref
     WHERE i.status = 'pending'
     GROUP BY ii.product_id, ii.variant_id`,
  );
  const merged = new Map<string, PendingStockAdjustment>();
  for (const row of rows) {
    const productId = Number(row.product_id ?? 0);
    const variantId =
      row.variant_id == null ? null : Number(row.variant_id);
    const deltaBase = Number(row.delta ?? 0) * (Number(row.sign) === 1 ? 1 : -1);
    const key = `${productId}:${variantId ?? '-'}`;
    const existing = merged.get(key);
    if (existing != null) {
      existing.deltaBase += deltaBase;
    } else {
      merged.set(key, {productId, variantId, deltaBase});
    }
  }
  return [...merged.values()];
}

// ── v3.5 (الجولة 91 — كاشير #2): دفتر الدين المعلق ────────────────
/**
 * «التسجيل اللحظي للدين» دون اتصال (طلب التاجر نصاً): كل بيعة دين
 * تُسجَّل محلياً باسم زبونها ومعرّفه لحظة إتمامها — لا انتظار
 * المزامنة. هذا الدفتر المعلق يجيب: «كم زاد دين كل زبون من
 * عمليات هذا الجهاز التي لم تصل نقطة البيع بعد؟»
 *
 * المعادلة (لكل زبون):
 *   دين معلّق = Σ(مبيعات دين معلقة) − Σ(مرتجعات معلقة مصدرها
 *               فاتورة دين لنفس الزبون)
 *
 * لأن إرجاع أصناف من فاتورة دين يخفض الدين عند نقطة البيع
 * (دفترها يعدّل الرصيد عكسياً) — فالمرتجع المعلق يخفض المعلق
 * المحلي بنفس المنطق.
 *
 * وبعد المزامنة يتعادل الدفتر تلقائياً: العملية تغادر «pending»
 * فتخرج من هذا الحساب، ورصيد الخادم المسحوب (customers) يشملها
 * — القيم الحقيقية تحلّ محل التقدير المحلي بلا أي ازدواج. ومع
 * تعدد الكاشيرات يحسب كل جهاز معلّقه وحده فوق رصيد آخر مزامنة
 * (الذي يشمل عمليات الأجهزة الأخرى المتزامنة) — فلا يفلت دين
 * ولا يُحسب مرتين.
 */
export async function pendingDebtByCustomer(): Promise<Map<number, number>> {
  await initOfflineStore();
  const result = new Map<number, number>();
  // ① مبيعات الدين المعلقة — تجمع لكل زبون.
  const salesRows = await localDb.select(
    `SELECT customer_id AS cid, SUM(total) AS total
     FROM invoices
     WHERE kind = 'sale' AND pay_kind = 'debt'
       AND status = 'pending' AND customer_id IS NOT NULL
     GROUP BY customer_id`,
  );
  for (const row of salesRows) {
    const cid = Number(row.cid ?? 0);
    if (cid > 0) {
      result.set(cid, Number(row.total ?? 0));
    }
  }
  // ② مرتجعات معلقة مصدرها فاتورة دين — تخفض دين صاحبها.
  const returnRows = await localDb.select(
    `SELECT s.customer_id AS cid, SUM(r.total) AS total
     FROM invoices r
     JOIN invoices s ON s.ref = r.source_ref
     WHERE r.kind = 'return' AND r.status = 'pending'
       AND s.pay_kind = 'debt' AND s.customer_id IS NOT NULL
     GROUP BY s.customer_id`,
  );
  for (const row of returnRows) {
    const cid = Number(row.cid ?? 0);
    if (cid > 0) {
      result.set(cid, (result.get(cid) ?? 0) - Number(row.total ?? 0));
    }
  }
  // لا نُبقي أصفاراً — الرصيد الحقيقي يأتي من الخادم.
  for (const [cid, total] of [...result.entries()]) {
    if (Math.abs(total) < 0.0001) {
      result.delete(cid);
    }
  }
  return result;
}

function rowToOp(row: DbRow): OutboxOp {
  return {
    opId: String(row.op_id),
    kind: String(row.kind) === 'return' ? 'return' : 'sale',
    payload: safeParse(String(row.payload ?? '{}')),
    createdAt: String(row.created_at ?? ''),
    attempts: Number(row.attempts ?? 0),
    lastError: row.last_error == null ? null : String(row.last_error),
  };
}

function safeParse(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export async function pendingCount(): Promise<number> {
  await initOfflineStore();
  const rows = await localDb.select('SELECT COUNT(*) AS c FROM outbox');
  return rows.length > 0 ? Number(rows[0].c ?? 0) : 0;
}

/** إزالة عملية من الطابور + ترقية أرشيفها بعد نجاح المزامنة. */
export async function markOpSynced(
  opId: string,
  syncedNumber: string,
  syncedAt: string,
): Promise<void> {
  await localDb.tx([
    {sql: 'DELETE FROM outbox WHERE op_id = ?', params: [opId]},
    {
      sql: `UPDATE invoices
       SET status = 'synced', synced_number = ?, synced_at = ?, reject_reason = NULL
       WHERE ref = ?`,
      params: [syncedNumber, syncedAt, opId],
    },
  ]);
}

/** عملية رفضها الخادم نهائياً — تبقى في الأرشيف بسببها الواضح. */
export async function markOpRejected(
  opId: string,
  reason: string,
): Promise<void> {
  await localDb.tx([
    {sql: 'DELETE FROM outbox WHERE op_id = ?', params: [opId]},
    {
      sql: `UPDATE invoices
       SET status = 'rejected', reject_reason = ?, synced_at = ?
       WHERE ref = ?`,
      params: [reason, new Date().toISOString().slice(0, 19), opId],
    },
  ]);
}

/** عدد محاولات فاشلة مؤقتة (شبكة) — لعدم إغراق الخادم. */
export async function bumpOpAttempts(opId: string, error: string): Promise<void> {
  await localDb.run(
    'UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE op_id = ?',
    [error, opId],
  );
}

// ── الأرشيف (فواتير الكاشير كلها) ────────────────────────────────
export async function listInvoices(limit = 100): Promise<LocalInvoice[]> {
  await initOfflineStore();
  const rows = await localDb.select(
    `SELECT ref, kind, display_number, synced_number, status, pay_kind,
            payment_method, total, discount, customer_name, customer_id,
            created_at, synced_at, reject_reason, source_ref
     FROM invoices ORDER BY created_at DESC, ref DESC LIMIT ?`,
    [limit],
  );
  return rows.map(rowToInvoice);
}

function rowToInvoice(row: DbRow): LocalInvoice {
  return {
    ref: String(row.ref),
    kind: String(row.kind) === 'return' ? 'return' : 'sale',
    displayNumber: String(row.display_number),
    syncedNumber: row.synced_number == null ? null : String(row.synced_number),
    status: (['pending', 'synced', 'rejected'].includes(String(row.status))
      ? String(row.status)
      : 'pending') as LocalInvoice['status'],
    payKind: String(row.pay_kind ?? 'cash'),
    payMethod: String(row.payment_method ?? 'cash') || 'cash',
    total: Number(row.total ?? 0),
    discount: Number(row.discount ?? 0),
    customerName: row.customer_name == null ? null : String(row.customer_name),
    customerId: row.customer_id == null ? null : Number(row.customer_id),
    createdAt: String(row.created_at ?? ''),
    syncedAt: row.synced_at == null ? null : String(row.synced_at),
    rejectReason: row.reject_reason == null ? null : String(row.reject_reason),
    sourceRef: row.source_ref == null ? null : String(row.source_ref),
  };
}

export async function invoiceItems(ref: string): Promise<LocalInvoiceItem[]> {
  await initOfflineStore();
  const rows = await localDb.select(
    `SELECT id, invoice_ref, product_id, name, variant_label, unit_name,
            quantity, unit_price, line_total, variant_id, conversion
     FROM invoice_items WHERE invoice_ref = ? ORDER BY id ASC`,
    [ref],
  );
  return rows.map(row => ({
    id: Number(row.id),
    invoiceRef: String(row.invoice_ref),
    productId: Number(row.product_id),
    name: String(row.name),
    variantId: row.variant_id == null ? null : Number(row.variant_id),
    variantLabel: row.variant_label == null ? null : String(row.variant_label),
    unitName: row.unit_name == null ? null : String(row.unit_name),
    quantity: Number(row.quantity ?? 0),
    unitPrice: Number(row.unit_price ?? 0),
    lineTotal: Number(row.line_total ?? 0),
  }));
}

/**
 * v3.1 (الجولة 65) — إجمالي الكميات المُرجعة من فاتورة بيع محددة.
 *
 * الجذر القديم (منع الإرجاع بلا سبب ظاهر): كان الاستعلام يعدّ كل
 * مرتجع لأي فاتورة أخرى يشترك معها في رقم المنتج نفسه — فبعد
 * إرجاع منتج من فاتورة (أ) كان «المتبقي» في فاتورة (ب) ينقص
 * أيضاً، حتى لو كانت فاتورة مختلفة تماماً. والأسوأ: حين يكون
 * للخادم متبقٍ رسمي (يشمل المرتجعات المتزامنة) كان يُخصم منه
 * المرتجع نفسه مرة ثانية → المتبقي صفر → «لا يسمح بالإرجاع».
 *
 * الربط الآن بعمود source_ref (فاتورة المصدر) — والتطابق
 * الدقيق للصنف: product_id + variant_label + unit_name معاً.
 *
 * onlyPending: عند وجود لقطة رسمية للخادم (serverDetail) تكون
 * المرتجعات المتزامنة محسوبة داخلها أصلاً — فلا نعدّ سوى
 * المرتجعات المحلية التي لم تصل الخادم بعد. بلا لقطة خادم
 * نعدّ كل مرتجعات هذه الفاتورة (متزامنة ومعلقة) فوق الكمية
 * الأصلية المحلية.
 */
export async function returnedQtyForLine(
  invoiceRef: string,
  productId: number,
  variantLabel: string | null,
  unitName: string | null,
  onlyPending = false,
): Promise<number> {
  await initOfflineStore();
  const statusFilter = onlyPending
    ? "AND i.status = 'pending'"
    : "AND i.status != 'rejected'";
  const rows = await localDb.select(
    `SELECT ii.quantity AS q
     FROM invoice_items ii
     JOIN invoices i ON i.ref = ii.invoice_ref
     WHERE i.kind = 'return' ${statusFilter}
       AND i.source_ref = ?
       AND ii.product_id = ?
       AND (
         (? IS NULL AND ii.variant_label IS NULL) OR ii.variant_label = ?
       )
       AND (
         (? IS NULL AND ii.unit_name IS NULL) OR ii.unit_name = ?
       )`,
    [invoiceRef, productId, variantLabel, variantLabel, unitName, unitName],
  );
  // تقريب صارم: نعيد ما سُجَّل فعلاً — دقة الرفض النهائية عند
  // الخادم وقت المزامنة (prepareReturn يقيد المتبقي الحقيقي).
  let total = 0;
  for (const row of rows) {
    total += Number(row.q ?? 0);
  }
  return total;
}

// ── دمج سحب فواتير الخادم في الأرشيف ─────────────────────────────
/**
 * بعد سحب فواتيري من الخادم (since cursor): الصفوف التي تحمل
 * clientRef تطابق عملياتي المزامنة (نحدّث رقمها الحقيقي)؛ البقية
 * فواتير أُجريت من أجهزة أخرى لحسابي فتُدرج كصفوف synced جديدة.
 */
export async function mergeServerInvoices(
  serverInvoices: {
    id: number;
    number: string;
    total: number;
    discount: number;
    isReturn: boolean;
    itemCount: number;
    createdAt: string;
    clientRef?: string | null;
    /** v3.4: طريقة الدفع الفعلية (بنك/محفظة أو نقدي). */
    paymentMethod?: string | null;
  }[],
): Promise<number> {
  await initOfflineStore();
  let merged = 0;
  for (const invoice of serverInvoices) {
    if (invoice.clientRef) {
      const existing = await localDb.select(
        'SELECT ref, status FROM invoices WHERE ref = ?',
        [invoice.clientRef],
      );
      if (existing.length > 0) {
        await localDb.run(
          `UPDATE invoices SET status = 'synced', synced_number = ?,
             synced_at = ?, display_number = ? WHERE ref = ?`,
          [
            invoice.number,
            new Date().toISOString().slice(0, 19),
            invoice.number,
            invoice.clientRef,
          ],
        );
        continue;
      }
    }
    // فاتورة من جهاز آخر لنفس الحساب — تُدرج كما هي.
    // v3.4: طريقة الدفع الفعلية من الخادم (كانت «نقدي» مثبتة
    // خطأً لكل فواتير الأجهزة الأخرى).
    await localDb.run(
      `INSERT OR IGNORE INTO invoices
        (ref, kind, display_number, synced_number, status, pay_kind,
         payment_method, total,
         discount, customer_name, created_at, synced_at, reject_reason)
       VALUES (?, ?, ?, ?, 'synced', ?, ?, ?, ?, NULL, ?, ?, NULL)`,
      [
        invoice.clientRef ?? `srv-${invoice.id}`,
        invoice.isReturn ? 'return' : 'sale',
        invoice.number,
        invoice.number,
        'cash',
        invoice.paymentMethod ?? 'cash',
        invoice.total,
        invoice.discount,
        invoice.createdAt,
        new Date().toISOString().slice(0, 19),
      ],
    );
    merged += 1;
  }
  return merged;
}

/** مؤشر أكبر معرف خادم سُحب — للسحب التزايدي التالي. */
export async function getPullCursor(): Promise<number> {
  const raw = await kvGet('pull_cursor');
  return raw ? Number(raw) || 0 : 0;
}

export async function setPullCursor(value: number): Promise<void> {
  await kvSet('pull_cursor', String(value));
}

/** آخر مزامنة كاملة ناجحة (للعرض في الواجهة). */
export async function getLastSyncAt(): Promise<string | null> {
  return kvGet('last_sync_at');
}

export async function setLastSyncAt(value: string): Promise<void> {
  await kvSet('last_sync_at', value);
}

// ── إحصاءات محلية بالكامل (تعمل دون اتصال) ───────────────────────
export interface LocalStats {
  todaySales: number;
  todaySalesCount: number;
  todayReturns: number;
  todayReturnsCount: number;
  net: number;
  pendingCount: number;
  daily: {day: string; salesTotal: number; returnsTotal: number; count: number}[];
  topProducts: {productId: number; name: string; qty: number; total: number}[];
}

export async function computeLocalStats(): Promise<LocalStats> {
  await initOfflineStore();
  const today = localDayKey();

  const totals = await localDb.select(
    `SELECT kind,
            COUNT(*) AS cnt,
            SUM(total) AS total
     FROM invoices
     WHERE status != 'rejected' AND substr(created_at, 1, 10) = ?
     GROUP BY kind`,
    [today],
  );
  let todaySales = 0;
  let todaySalesCount = 0;
  let todayReturns = 0;
  let todayReturnsCount = 0;
  for (const row of totals) {
    if (String(row.kind) === 'return') {
      todayReturnsCount = Number(row.cnt ?? 0);
      todayReturns = Number(row.total ?? 0);
    } else {
      todaySalesCount = Number(row.cnt ?? 0);
      todaySales = Number(row.total ?? 0);
    }
  }

  const dailyRows = await localDb.select(
    `SELECT substr(created_at, 1, 10) AS day,
            COUNT(*) AS cnt,
            SUM(CASE WHEN kind = 'sale' THEN total ELSE 0 END) AS sales_total,
            SUM(CASE WHEN kind = 'return' THEN total ELSE 0 END) AS returns_total
     FROM invoices
     WHERE status != 'rejected'
     GROUP BY day ORDER BY day DESC LIMIT 14`,
  );
  const topRows = await localDb.select(
    `SELECT ii.product_id, ii.name,
            SUM(ii.quantity) AS qty,
            SUM(ii.line_total) AS total
     FROM invoice_items ii
     JOIN invoices i ON i.ref = ii.invoice_ref
     WHERE i.kind = 'sale' AND i.status != 'rejected'
     GROUP BY ii.product_id
     ORDER BY total DESC LIMIT 8`,
  );

  return {
    todaySales,
    todaySalesCount,
    todayReturns,
    todayReturnsCount,
    net: todaySales + todayReturns,
    pendingCount: await pendingCount(),
    daily: dailyRows.map(row => ({
      day: String(row.day ?? ''),
      count: Number(row.cnt ?? 0),
      salesTotal: Number(row.sales_total ?? 0),
      returnsTotal: Number(row.returns_total ?? 0),
    })),
    topProducts: topRows.map(row => ({
      productId: Number(row.product_id ?? 0),
      name: String(row.name ?? ''),
      qty: Number(row.qty ?? 0),
      total: Number(row.total ?? 0),
    })),
  };
}
