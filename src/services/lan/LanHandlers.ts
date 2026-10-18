/**
 * LanHandlers — v59 (الجولة 63): بروتوكول «سيلّا كاشير» على الشبكة
 * المحلية.
 * ─────────────────────────────────────────────────────────────────
 * طبقة نقية (بلا أي اعتماد منصة) تخدم طلبات تطبيق الكاشير:
 *
 *   GET  /api/ping                        نبض الخادم + اسم المتجر
 *   POST /api/auth/login                  دخول (اسم مستخدم + كلمة مرور)
 *                                        → ok/pending/denied/inactive
 *                                        v59: + صلاحيات الكاشير
 *   POST /api/auth/logout                 خروج (إبطال رمز الجلسة)
 *   GET  /api/catalog                     منتجات المخزون بالوحدات والأسعار
 *                                        v59: + المتغيرات (لون×مقاس/حجم)
 *                                            + علم وجود صورة المنتج
 *   GET  /api/products?barcode=           بحث بالباركود (منتج واحد)
 *   GET  /api/product-image?id=           v59: صورة المنتج base64
 *   GET  /api/customers                   زبائن دفتر المتجر (للدين)
 *   POST /api/sale                        بيع نقدي أو دين دفتر باسم الكاشير
 *                                        v59: + متغيرات الأسطر، + clientRef
 *                                            (ميزة الخدمة للعمل دون اتصال)
 *                                        v60: + print (طباعة الفاتورة من
 *                                            طابعة نقطة البيع إن طلبه الكاشير)
 *   GET  /api/invoices?since=             فواتير الكاشير نفسه (+ زيادة cursor)
 *   GET  /api/invoice?id=                 تفاصيل فاتورة + القابل للإرجاع
 *   GET  /api/invoice-by-number?number=   v60: فاتورة الكاشير برقمها
 *                                        (باركود الإيصال CODE128 يفتحها)
 *   GET  /api/printer-status              v60: حالة طابعة نقطة البيع
 *                                        (متصل/غير متصل + اسم الجهاز)
 *   POST /api/return                      إرجاع/استبدال من فواتير الكاشير
 *                                        v59: + clientRef + متغيرات البدائل
 *                                        v60: + print (طباعة من طابعة POS)
 *   GET  /api/stats                       إحصاءات الكاشير (اليوم/الإجمالي)
 *   POST /api/sync/push                   v59: دفعة عمليات أُجريت دون اتصال —
 *                                        تُعالج بالتسلسل مع استجابة لكل عملية
 *
 * قواعد الأمان:
 *  ① الأسعار تُحسم من قاعدة نقطة البيع دائماً — تطبيق الكاشير يرسل
 *     المنتج والوحدة والكمية فقط، لا سعراً واحداً يُصدَّق.
 *  ② الخصم مقيد بسقف الكاشير (max_discount_pct من المدير).
 *  ③ كل عملية (بيع/إرجاع/استبدال) تمر من InvoiceService نفسه الذي
 *     تستعمله نقطة البيع — نفس المعاملات الذرية، نفس الخزينة
 *     المشتقة، نفس الدفاتر؛ فالتزامن كامل وتفصيلي وبلا مسار موازٍ.
 *  ④ الإرجاع من فواتير الكاشير نفسه فقط (cashier_id = حسابه).
 *  ⑤ خمس محاولات دخول فاشلة تُقفل المحاولة دقيقة كاملة.
 *  ⑥ v59 صلاحيات المدير: بيع الدين مقفول (can_debt=0)؟ الخادم يرفض
 *     عملية الدين؛ المرتجعات مقفولة (can_return=0)؟ يرفض الإرجاع
 *     والاستبدال كليهما — لا اعتماد على إخفاء الزر في التطبيق وحده.
 *
 * v59 — مزامنة العمل دون اتصال (أهم طلبات التاجر):
 *  • كل عملية من الكاشير تحمل clientRef فريداً يولّده جهازه
 *    (deviceId + وقت + عشوائية) — البادرة الحقيقية للفهارس الفريدة
 *    الجزئية على sales.client_ref / sale_returns.client_ref.
 *  • عند المزامنة يفحص الخادم clientRef أولاً: موجود = العملية سبق
 *    أن سُجلت (شبكة انقطعت بعد التسجيل) فيعيد نتيجتها الأصلية كما
 *    هي — لا ازدواج مهما تكررت المحاولة.
 *  • أرقام الفواتير الحقيقية تُمنح من نقطة البيع وحدها (INV-/INV-L/
 *    RET-) — الكاشير لا يختار رقماً قطعاً؛ فلا تعارض بين حسابات
 *    الكاشيرين إطلاقاً لأن كل رقم يصدر من متسلسلة نقطة البيع نفسها
 *    لحظة القبول، وتاريخ العملية الفعلي (created_at العميل) يُحفظ
 *    لتصح التقارير على زمن البيع لا زمن المزامنة.
 */
import {CashiersRepo} from '../../database/repositories/CashiersRepo';
import {LocalDebtsRepo} from '../../database/repositories/LocalDebtsRepo';
import {SaleRepo} from '../../database/repositories/SaleRepo';
import {InvoiceService} from '../InvoiceService';
import {getSettings} from '../../stores/settingsStore';
import {getDb} from '../../database/connection';
import {PlatformUtilsNative} from '../../native/nativeBridge';
import {APP_VERSION} from '../../core/config';
import {localNow} from '../../core/format';
import type {
  CartLine,
  ExchangeLineInput,
  ReturnLineInput,
} from '../../core/types';

/** الطلب كما يصل من الغلاف الأصلي (Kotlin على أندرويد / Rust على
 *  سطح المكتب) — كلا الغلافين يصدّر نفس الشكل الحرفي. */
export interface LanRequestShape {
  id: string;
  method: string;
  path: string;
  query: Record<string, string>;
  body: string;
  /** قيمة ترويسة Authorization كما وصلت (Bearer …) أو null. */
  auth: string | null;
  ip: string | null;
}

export interface LanResponseShape {
  status: number;
  body: string;
}

interface Authed {
  cashierId: number;
  cashierName: string;
  maxDiscountPct: number;
  /** v59: صلاحية البيع بالدين. */
  canDebt: boolean;
  /** v59: صلاحية المرتجعات والاستبدال. */
  canReturn: boolean;
  deviceId: number;
}

// ── v59: أحداث الخادم الحية (إشعارات المدير) ──────────────────────
export type LanEvent =
  | {
      kind: 'device_pending';
      cashierName: string;
      deviceLabel: string;
      ip: string | null;
    }
  | {
      kind: 'login';
      cashierName: string;
      deviceLabel: string;
    }
  | {
      kind: 'sale';
      cashierName: string;
      invoiceNumber: string;
      total: number;
      itemCount: number;
      debt: boolean;
      /** العملية وصلت من طابور المزامنة (أُجريت دون اتصال). */
      offline: boolean;
    }
  | {
      kind: 'return';
      cashierName: string;
      returnNumber: string;
      refundMinor: number;
      exchangeMinor: number;
      isExchange: boolean;
    };

let eventSink: ((event: LanEvent) => void) | null = null;

/** تسجيل مستقبل الأحداث — تستدعيه LanServerService في كل منصة
 *  (إشعار نظام أندرويد / نافذة عائمة على سطح المكتب). */
export function setLanEventSink(
  sink: ((event: LanEvent) => void) | null,
): void {
  eventSink = sink;
}

/** v60: مزوّد حالة الطابعة — تستدعيه LanServerService في كل منصة
 *  (متجر الطابعة على أندرويد / خدمة الطابعة على سطح المكتب).
 *  يغذي /api/printer-status وقرار الطباعة عند البيع/الإرجاع. */
let printerStatusProvider:
  | (() => Promise<{connected: boolean; name: string | null}>)
  | null = null;

export function setPrinterStatusProvider(
  provider: (() => Promise<{connected: boolean; name: string | null}>) | null,
): void {
  printerStatusProvider = provider;
}

/** هل الطابعة متصلة الآن؟ — أفضل جهد؛ الفشل = غير متصلة. */
async function printerConnected(): Promise<boolean> {
  try {
    const status =
      printerStatusProvider != null ? await printerStatusProvider() : null;
    return status?.connected === true;
  } catch {
    return false;
  }
}

function emitLanEvent(event: LanEvent): void {
  try {
    eventSink?.(event);
  } catch {
    // حدث فاشل لا يوقف الطلب أبداً.
  }
}

// ── دفتر محاولات الدخول الفاشلة (خمس ثم قفل دقيقة) ────────────────
const loginFailures = new Map<string, {count: number; until: number}>();

function noteLoginFailure(username: string): void {
  const key = username.trim().toLowerCase();
  const entry = loginFailures.get(key);
  const now = Date.now();
  if (entry && now < entry.until) {
    entry.count += 1;
    return;
  }
  loginFailures.set(key, {count: 1, until: now + 60_000});
}

function loginLockedRemaining(username: string): number {
  const entry = loginFailures.get(username.trim().toLowerCase());
  if (!entry) {
    return 0;
  }
  if (entry.count >= 5) {
    const remain = Math.ceil((entry.until - Date.now()) / 1000);
    return remain > 0 ? remain : 0;
  }
  return 0;
}

function clearLoginFailures(username: string): void {
  loginFailures.delete(username.trim().toLowerCase());
}

// ── أدوات استجابة ─────────────────────────────────────────────────
function json(status: number, payload: unknown): LanResponseShape {
  return {status, body: JSON.stringify(payload)};
}

function ok(payload: unknown): LanResponseShape {
  return json(200, payload);
}

function fail(status: number, error: string, extra?: object): LanResponseShape {
  return json(status, {ok: false, error, ...extra});
}

function parseBody(raw: string): Record<string, unknown> {
  if (!raw || raw.trim().length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function bearerToken(req: LanRequestShape): string | null {
  const header = req.auth ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

async function authenticate(req: LanRequestShape): Promise<Authed | null> {
  const token = bearerToken(req);
  if (!token) {
    return null;
  }
  const session = await CashiersRepo.byToken(token);
  if (!session) {
    return null;
  }
  await CashiersRepo.touchDevice(session.device.id);
  await CashiersRepo.touchCashier(session.cashier.id);
  return {
    cashierId: session.cashier.id,
    cashierName: session.cashier.display_name,
    maxDiscountPct: session.cashier.max_discount_pct,
    canDebt: session.cashier.can_debt === 1,
    canReturn: session.cashier.can_return === 1,
    deviceId: session.device.id,
  };
}

// ── أنواع DTO لتطبيق الكاشير ──────────────────────────────────────
export interface CashierCatalogUnit {
  id: number;
  name: string;
  short: string;
  conversion: number;
  retailPrice: number | null;
  barcode: string | null;
}

/** v59: متغيرات المنتج (ملابس لون×مقاس / أحجام بسعر). */
export interface CashierCatalogVariant {
  id: number;
  kind: 'variant' | 'size';
  color: string;
  size: string;
  retailPrice: number | null;
  costPrice: number | null;
  stockQty: number;
}

export interface CashierCatalogProduct {
  id: number;
  name: string;
  categoryId: number | null;
  categoryName: string;
  retailPrice: number;
  wholesalePrice: number;
  costPrice: number;
  discountPct: number;
  stockQty: number;
  stockUntracked: boolean;
  byWeight: boolean;
  barcode: string | null;
  hasVariants: boolean;
  /** v59: هل للمنتج صورة قابلة للجلب عبر /api/product-image. */
  hasImage: boolean;
  units: CashierCatalogUnit[];
  /** v59: متغيراته (فارغة إن لم يكن منتج متغيرات). */
  variants: CashierCatalogVariant[];
}

const CATALOG_LIMIT = 2000;

async function loadCatalog(
  where: string,
  params: (string | number | null)[],
): Promise<CashierCatalogProduct[]> {
  const db = getDb();
  const products = await db.execute(
    `SELECT p.*, c.name AS category_name
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.is_archived = 0 ${where}
     ORDER BY p.category_id, p.name
     LIMIT ${CATALOG_LIMIT}`,
    params,
  );
  const rows = (products.rows ?? []) as unknown as Record<string, unknown>[];
  if (rows.length === 0) {
    return [];
  }
  const units = await db.execute(
    `SELECT pu.product_id, pu.unit_id, pu.conversion, pu.retail_price,
            pu.barcode, u.name AS unit_name, u.short_name
     FROM product_units pu
     JOIN units u ON u.id = pu.unit_id`,
  );
  const unitRows = (units.rows ?? []) as unknown as Record<string, unknown>[];
  const unitsByProduct = new Map<number, CashierCatalogUnit[]>();
  for (const row of unitRows) {
    const pid = Number(row.product_id);
    const entry: CashierCatalogUnit = {
      id: Number(row.unit_id),
      name: String(row.unit_name ?? ''),
      short: String(row.short_name ?? ''),
      conversion: Number(row.conversion ?? 1),
      retailPrice:
        row.retail_price != null && Number(row.retail_price) > 0
          ? Number(row.retail_price)
          : null,
      barcode: row.barcode ? String(row.barcode) : null,
    };
    const list = unitsByProduct.get(pid);
    if (list) {
      list.push(entry);
    } else {
      unitsByProduct.set(pid, [entry]);
    }
  }
  // v59: متغيرات المنتجات (لون×مقاس للملابس، أحجام بسعر للمطاعم).
  const variants = await db.execute(
    `SELECT id, product_id, kind, color, size, stock_quantity,
            retail_price, cost_price
     FROM product_variants
     ORDER BY product_id, id`,
  );
  const variantRows = (variants.rows ?? []) as unknown as Record<
    string,
    unknown
  >[];
  const variantsByProduct = new Map<number, CashierCatalogVariant[]>();
  for (const row of variantRows) {
    const pid = Number(row.product_id);
    const entry: CashierCatalogVariant = {
      id: Number(row.id),
      kind: String(row.kind ?? 'variant') === 'size' ? 'size' : 'variant',
      color: String(row.color ?? ''),
      size: String(row.size ?? ''),
      retailPrice:
        row.retail_price != null && Number(row.retail_price) > 0
          ? Number(row.retail_price)
          : null,
      costPrice:
        row.cost_price != null && Number(row.cost_price) > 0
          ? Number(row.cost_price)
          : null,
      stockQty: Number(row.stock_quantity ?? 0),
    };
    const list = variantsByProduct.get(pid);
    if (list) {
      list.push(entry);
    } else {
      variantsByProduct.set(pid, [entry]);
    }
  }
  return rows.map(row => ({
    id: Number(row.id),
    name: String(row.name ?? ''),
    categoryId: row.category_id == null ? null : Number(row.category_id),
    categoryName: row.category_name
      ? String(row.category_name)
      : 'بدون تصنيف',
    retailPrice: Number(row.retail_price ?? 0),
    wholesalePrice: Number(row.wholesale_price ?? 0),
    costPrice: Number(row.cost_price ?? 0),
    discountPct: Number(row.discount_pct ?? 0),
    stockQty: Number(row.stock_quantity ?? 0),
    stockUntracked: Number(row.stock_untracked ?? 0) === 1,
    byWeight: Number(row.sold_by_weight ?? 0) === 1,
    barcode: row.barcode ? String(row.barcode) : null,
    hasVariants: Number(row.has_variants ?? 0) === 1,
    hasImage: Boolean(row.image_uri && String(row.image_uri).length > 0),
    units: unitsByProduct.get(Number(row.id)) ?? [],
    variants: variantsByProduct.get(Number(row.id)) ?? [],
  }));
}

function catalogToCartLine(
  product: CashierCatalogProduct,
  unitId: number | null,
  quantity: number,
  variantId?: number | null,
): CartLine {
  // ── v59: سطر متغير (ملابس لون×مقاس أو حجم بسعر) — نفس معادلة
  //    toVariantLine/toSizedLine في نقطة البيع حرفياً (خصم المنتج
  //    مطبق، مخزون المتغير للملابس، سعر الحجم لأحجام المطاعم).
  if (variantId != null) {
    const variant = product.variants.find(v => v.id === variantId);
    if (variant == null) {
      throw new Error('متغير غير متاح لهذا المنتج');
    }
    const isSize = variant.kind === 'size';
    const rawPrice = isSize
      ? variant.retailPrice ?? product.retailPrice
      : product.retailPrice;
    const pct = Math.max(0, Math.min(95, product.discountPct || 0));
    const unitPrice =
      pct > 0
        ? Math.round(rawPrice * (1 - pct / 100) * 100) / 100
        : rawPrice;
    const label = isSize
      ? variant.size
      : variant.color
      ? `${variant.color} · ${variant.size}`
      : variant.size;
    return {
      key: `${product.id}--v${variant.id}`,
      productId: product.id,
      name: product.name,
      unitPrice,
      costPrice: variant.costPrice ?? product.costPrice,
      retailPrice: rawPrice,
      wholesalePrice: rawPrice,
      quantity,
      availableStock: product.stockUntracked
        ? 999999
        : isSize
        ? product.stockQty
        : variant.stockQty,
      unitId: null,
      unitName: 'قطعة',
      conversion: 1,
      variantId: variant.id,
      variantLabel: label,
      discountPct: product.discountPct,
    };
  }
  const unit =
    unitId != null ? product.units.find(u => u.id === unitId) : undefined;
  const conversion = unit ? unit.conversion : 1;
  const basePrice = product.retailPrice;
  // ① سعر الوحدة: تجاوز الوحدة إن وُجد وإلا سعر الأساس × التحويل.
  const rawUnitPrice = unit
    ? unit.retailPrice ?? basePrice * unit.conversion
    : basePrice;
  // ② خصم المنتج (نفس معادلة نقطة البيع حرفياً).
  const safePct = Math.max(0, Math.min(95, product.discountPct || 0));
  const unitPrice =
    safePct > 0
      ? Math.round(rawUnitPrice * (1 - safePct / 100) * 100) / 100
      : rawUnitPrice;
  const unitCost = product.costPrice * conversion;
  const availableStock = product.stockUntracked
    ? 999999
    : Math.max(0, product.stockQty / (conversion || 1));
  return {
    key: `${product.id}-${unit ? unit.id : ''}`,
    productId: product.id,
    name: product.name,
    unitPrice,
    costPrice: unitCost,
    retailPrice: product.retailPrice,
    wholesalePrice: product.wholesalePrice,
    quantity,
    availableStock,
    unitId: unit ? unit.id : null,
    unitName: unit ? unit.name : 'قطعة',
    conversion,
    byWeight: product.byWeight && !unit,
    discountPct: product.discountPct,
  };
}

function receiptSettings() {
  const s = getSettings();
  return {
    storeName: s.storeName,
    storePhone: s.storePhone,
    footerMessage: s.footerMessage,
    storeLogoPath: s.storeLogoPath,
    paperWidth: s.paperWidth,
    codepage: s.codepage,
    showProfit: s.showProfitOnReceipt,
  };
}

function todayKey(): string {
  return localNow().slice(0, 10);
}

// ── v59: فحص/ختم مرجع العميل (ميزة العمل دون اتصال) ───────────────
interface ClientRefHit {
  saleId: number;
  number: string;
  total: number;
  discount: number;
  itemCount: number;
  createdAt: string;
}

/** سبق أن سُجلت هذه العملية؟ أعِد نتيجتها الأصلية — لا ازدواج
 *  مهما أعاد الكاشير المحاولة (شبكة انقطعت بعد التسجيل). */
async function saleByClientRef(
  clientRef: string,
): Promise<ClientRefHit | null> {
  if (!clientRef) {
    return null;
  }
  const db = getDb();
  const result = await db.execute(
    `SELECT s.id, s.invoice_number, s.total_amount, s.discount, s.created_at,
            (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) AS item_count
     FROM sales s WHERE s.client_ref = ?`,
    [clientRef],
  );
  const rows = (result.rows ?? []) as unknown as Record<string, unknown>[];
  if (rows.length === 0) {
    return null;
  }
  const row = rows[0];
  return {
    saleId: Number(row.id),
    number: String(row.invoice_number ?? ''),
    total: Number(row.total_amount ?? 0),
    discount: Number(row.discount ?? 0),
    itemCount: Number(row.item_count ?? 0),
    createdAt: String(row.created_at ?? ''),
  };
}

async function returnByClientRef(
  clientRef: string,
): Promise<{
  id: number;
  number: string;
  refundMinor: number;
  exchangeMinor: number;
  isExchange: number;
} | null> {
  if (!clientRef) {
    return null;
  }
  const db = getDb();
  const result = await db.execute(
    'SELECT id, return_number, refund_minor, exchange_minor, is_exchange FROM sale_returns WHERE client_ref = ?',
    [clientRef],
  );
  const rows = (result.rows ?? []) as unknown as Record<string, unknown>[];
  if (rows.length === 0) {
    return null;
  }
  const row = rows[0];
  return {
    id: Number(row.id),
    number: String(row.return_number ?? ''),
    refundMinor: Number(row.refund_minor ?? 0),
    exchangeMinor: Number(row.exchange_minor ?? 0),
    isExchange: Number(row.is_exchange ?? 0),
  };
}

/** ختم الفاتورة بمرجع العميل وزمن البيع الفعلي (فور نجاح المعاملة)
 *  — التقرير يبقى على زمن البيع لا زمن المزامنة. */
async function stampSale(
  saleId: number,
  clientRef: string | null,
  createdAt: string | null,
): Promise<void> {
  if (!clientRef && !createdAt) {
    return;
  }
  const db = getDb();
  if (clientRef && createdAt) {
    await db.execute(
      'UPDATE sales SET client_ref = ?, created_at = ? WHERE id = ?',
      [clientRef, createdAt, saleId],
    );
  } else if (clientRef) {
    await db.execute(
      'UPDATE sales SET client_ref = ? WHERE id = ?',
      [clientRef, saleId],
    );
  } else if (createdAt) {
    await db.execute(
      'UPDATE sales SET created_at = ? WHERE id = ?',
      [createdAt, saleId],
    );
  }
}

async function stampReturn(
  returnNumber: string,
  clientRef: string | null,
  createdAt: string | null,
): Promise<void> {
  if (!clientRef && !createdAt) {
    return;
  }
  const db = getDb();
  if (clientRef) {
    await db.execute(
      'UPDATE sale_returns SET client_ref = ? WHERE return_number = ?',
      [clientRef, returnNumber],
    );
  }
  if (createdAt) {
    await db.execute(
      'UPDATE sales SET created_at = ? WHERE invoice_number = ?',
      [createdAt, returnNumber],
    );
    await db.execute(
      'UPDATE sale_returns SET created_at = ? WHERE return_number = ?',
      [createdAt, returnNumber],
    );
  }
}

/** شكل الفاتورة كما يعيده الخادم لتطبيق الكاشير. */
function invoicePayload(hit: {
  saleId: number;
  number: string;
  total: number;
  discount: number;
  itemCount: number;
  createdAt: string;
}) {
  return {
    id: hit.saleId,
    number: hit.number,
    total: hit.total,
    discount: hit.discount,
    itemCount: hit.itemCount,
    createdAt: hit.createdAt,
  };
}

// ── المُوجِّه الرئيسي ──────────────────────────────────────────────
export async function handleLanRequest(
  req: LanRequestShape,
): Promise<LanResponseShape> {
  try {
    const path = (req.path ?? '').split('?')[0];
    const method = (req.method ?? 'GET').toUpperCase();

    if (path === '/api/ping' && method === 'GET') {
      return ok({
        ok: true,
        app: 'sela-pos',
        proto: 2,
        version: APP_VERSION,
        store: getSettings().storeName,
      });
    }

    if (path === '/api/auth/login' && method === 'POST') {
      return await handleLogin(req);
    }

    const authed = await authenticate(req);
    if (!authed) {
      return fail(401, 'غير مصرح — سجّل الدخول من جديد');
    }

    if (path === '/api/auth/logout' && method === 'POST') {
      await CashiersRepo.clearToken(authed.deviceId);
      return ok({ok: true});
    }

    if (path === '/api/catalog' && method === 'GET') {
      const products = await loadCatalog('', []);
      return ok({ok: true, products});
    }

    if (path === '/api/products' && method === 'GET') {
      const barcode = (req.query.barcode ?? '').trim();
      if (!barcode) {
        return fail(400, 'باركود مطلوب');
      }
      let products = await loadCatalog('AND p.barcode = ?', [barcode]);
      if (products.length === 0) {
        const unitHit = await getDb().execute(
          `SELECT pu.product_id FROM product_units pu
           WHERE pu.barcode = ? LIMIT 1`,
          [barcode],
        );
        const hitRows = (unitHit.rows ?? []) as unknown as Record<
          string,
          unknown
        >[];
        if (hitRows.length > 0) {
          products = await loadCatalog('AND p.id = ?', [
            Number(hitRows[0].product_id),
          ]);
        }
      }
      if (products.length === 0) {
        return fail(404, 'لا يوجد منتج بهذا الباركود');
      }
      return ok({ok: true, product: products[0]});
    }

    // v59: صورة المنتج (JPEG مصغّرة base64) — يطلبها تطبيق الكاشير
    // بسلاسة للبطاقات المرئية فقط ويخزنها مؤقتاً على جهازه.
    if (path === '/api/product-image' && method === 'GET') {
      const id = Number(req.query.id ?? 0);
      if (!id) {
        return fail(400, 'رقم المنتج مطلوب');
      }
      const result = await getDb().execute(
        'SELECT image_uri FROM products WHERE id = ?',
        [id],
      );
      const rows = (result.rows ?? []) as unknown as Record<string, unknown>[];
      const uri = rows.length > 0 ? String(rows[0].image_uri ?? '') : '';
      if (!uri || PlatformUtilsNative == null) {
        return fail(404, 'لا صورة لهذا المنتج');
      }
      try {
        const base64 = await PlatformUtilsNative.readFileBase64(uri);
        return json(200, {ok: true, id, image: base64});
      } catch {
        return fail(404, 'تعذر تحميل صورة المنتج');
      }
    }

    if (path === '/api/customers' && method === 'GET') {
      const balances = await LocalDebtsRepo.listWithBalances();
      return ok({
        ok: true,
        customers: balances.map(b => ({
          id: b.customer.id,
          name: b.customer.name,
          idNumber: b.customer.id_number,
          phone: b.customer.phone,
          outstandingMinor: b.outstandingMinor,
        })),
      });
    }

    if (path === '/api/sale' && method === 'POST') {
      return await handleSale(req, authed, false);
    }

    if (path === '/api/invoices' && method === 'GET') {
      return await handleInvoiceList(req, authed);
    }

    if (path === '/api/invoice' && method === 'GET') {
      return await handleInvoiceDetail(req, authed);
    }

    // v60: البحث عن فاتورة الكاشير برقمها (باركود الإيصال CODE128
    // يحمل الرقم) — على فواتير حسابه هو فقط (نفس قاعدة الإرجاع).
    if (path === '/api/invoice-by-number' && method === 'GET') {
      const number = (req.query.number ?? '').trim();
      if (!number) {
        return fail(400, 'رقم الفاتورة مطلوب');
      }
      const db = getDb();
      let result = await db.execute(
        `SELECT s.*, (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) AS item_count
         FROM sales s
         WHERE s.cashier_id = ? AND s.invoice_number = ?
         LIMIT 1`,
        [authed.cashierId, number],
      );
      let rows = (result.rows ?? []) as unknown as Record<string, unknown>[];
      if (rows.length === 0) {
        // تطابق لاحقة الرقم — بعض الباركودات تُقرأ بجزء من الرقم.
        result = await db.execute(
          `SELECT s.*, (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) AS item_count
           FROM sales s
           WHERE s.cashier_id = ? AND s.invoice_number LIKE ?
           ORDER BY s.id DESC LIMIT 1`,
          [authed.cashierId, `%${number}`],
        );
        rows = (result.rows ?? []) as unknown as Record<string, unknown>[];
      }
      if (rows.length === 0) {
        // 200 مع null — الكاشير يميّز «ليست لي» عن خطأ الشبكة.
        return ok({ok: true, invoice: null});
      }
      const row = rows[0];
      return ok({
        ok: true,
        invoice: {
          id: Number(row.id),
          number: String(row.invoice_number ?? ''),
          total: Number(row.total_amount ?? 0),
          discount: Number(row.discount ?? 0),
          isReturn: String(row.invoice_number ?? '').startsWith('RET-'),
          returnedMinor: Number(row.returned_minor ?? 0),
          paymentType: String(row.payment_type ?? 'RETAIL'),
          itemCount: Number(row.item_count ?? 0),
          createdAt: String(row.created_at ?? ''),
          clientRef: row.client_ref ? String(row.client_ref) : null,
        },
      });
    }

    // v60: حالة طابعة نقطة البيع — يعرضها تطبيق الكاشير في إعدادات
    // الطباعة ويفعّل طباعة فواتيره منها.
    if (path === '/api/printer-status' && method === 'GET') {
      try {
        const status =
          printerStatusProvider != null
            ? await printerStatusProvider()
            : {connected: false, name: null};
        return ok({ok: true, ...status});
      } catch {
        return ok({ok: true, connected: false, name: null});
      }
    }

    if (path === '/api/return' && method === 'POST') {
      return await handleReturn(req, authed, false);
    }

    if (path === '/api/stats' && method === 'GET') {
      return await handleStats(authed);
    }

    if (path === '/api/sync/push' && method === 'POST') {
      return await handleSyncPush(req, authed);
    }

    return fail(404, 'مسار غير معروف');
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'خطأ غير متوقع في الخادم';
    return fail(400, message);
  }
}

// ── الدخول وموافقة المدير على الجهاز ──────────────────────���────
async function handleLogin(req: LanRequestShape): Promise<LanResponseShape> {
  const body = parseBody(req.body);
  const username = String(body.username ?? '').trim();
  const password = String(body.password ?? '');
  const deviceId = String(body.deviceId ?? '').trim();
  const deviceLabel = String(body.deviceLabel ?? 'جهاز كاشير').slice(0, 60);
  if (!username || !password || !deviceId) {
    return fail(400, 'اسم المستخدم وكلمة المرور ومعرّف الجهاز مطلوبة');
  }
  const locked = loginLockedRemaining(username);
  if (locked > 0) {
    return fail(429, 'محاولات كثيرة — انتظر دقيقة ثم أعد المحاولة', {
      retryAfterSec: locked,
    });
  }
  const cashier = await CashiersRepo.authenticate(username, password);
  if (!cashier) {
    noteLoginFailure(username);
    return fail(401, 'اسم المستخدم أو كلمة المرور غير صحيحة');
  }
  clearLoginFailures(username);
  if (cashier.is_active !== 1) {
    return json(200, {ok: true, status: 'inactive'});
  }
  const device = await CashiersRepo.findOrCreateDevice(
    cashier.id,
    deviceId,
    deviceLabel,
    req.ip,
  );
  if (device.status === 'denied') {
    return json(200, {ok: true, status: 'denied'});
  }
  if (device.status === 'pending') {
    // بانتظار المدير — تطبيق الكاشير يستقصي الدخول كل بضع ثوانٍ.
    emitLanEvent({
      kind: 'device_pending',
      cashierName: cashier.display_name,
      deviceLabel: device.device_label || deviceLabel,
      ip: req.ip,
    });
    return json(200, {ok: true, status: 'pending'});
  }
  // معتمد — رمز جديد إن كان القديم أُبطل (خروج/تغيير كلمة مرور).
  if (!device.token) {
    await CashiersRepo.approveDevice(device.id);
    const refreshed = await CashiersRepo.findOrCreateDevice(
      cashier.id,
      deviceId,
      deviceLabel,
      req.ip,
    );
    emitLanEvent({
      kind: 'login',
      cashierName: cashier.display_name,
      deviceLabel: device.device_label || deviceLabel,
    });
    return json(200, {
      ok: true,
      status: 'ok',
      token: refreshed.token,
      cashier: {id: cashier.id, name: cashier.display_name},
      store: {name: getSettings().storeName},
      perms: {
        maxDiscountPct: cashier.max_discount_pct,
        canDebt: cashier.can_debt === 1,
        canReturn: cashier.can_return === 1,
      },
    });
  }
  await CashiersRepo.touchDevice(device.id);
  await CashiersRepo.touchCashier(cashier.id);
  emitLanEvent({
    kind: 'login',
    cashierName: cashier.display_name,
    deviceLabel: device.device_label || deviceLabel,
  });
  return json(200, {
    ok: true,
    status: 'ok',
    token: device.token,
    cashier: {id: cashier.id, name: cashier.display_name},
    store: {name: getSettings().storeName},
    perms: {
      maxDiscountPct: cashier.max_discount_pct,
      canDebt: cashier.can_debt === 1,
      canReturn: cashier.can_return === 1,
    },
  });
}

// ── البيع ─────────────────────────────────────────────────────────
async function handleSale(
  req: LanRequestShape,
  authed: Authed,
  fromSync: boolean,
): Promise<LanResponseShape> {
  const body = parseBody(req.body);
  const rawLines = Array.isArray(body.lines) ? body.lines : [];
  if (rawLines.length === 0) {
    return fail(400, 'السلة فارغة');
  }
  const paymentType = body.paymentType === 'debt' ? 'debt' : 'cash';
  const clientRef = body.clientRef ? String(body.clientRef).slice(0, 80) : '';
  const clientCreatedAt = body.createdAt
    ? String(body.createdAt).slice(0, 19)
    : '';

  // ميزة الخدمة: العملية سُجلت سابقاً (إعادة محاولة مزامنة)؟
  if (clientRef) {
    const hit = await saleByClientRef(clientRef);
    if (hit) {
      return ok({ok: true, duplicate: true, invoice: invoicePayload(hit)});
    }
  }

  if (paymentType === 'debt' && !authed.canDebt) {
    return fail(403, 'بيع الدين مقفول لحسابك — راجع المسؤول');
  }

  const catalog = await loadCatalog('', []);
  const byId = new Map(catalog.map(p => [p.id, p]));

  const lines: CartLine[] = [];
  for (const raw of rawLines) {
    const line = raw as Record<string, unknown>;
    const productId = Number(line.productId ?? 0);
    const quantity = Number(line.quantity ?? 0);
    const unitId =
      line.unitId == null || line.unitId === '' ? null : Number(line.unitId);
    const variantId =
      line.variantId == null || line.variantId === ''
        ? null
        : Number(line.variantId);
    const product = byId.get(productId);
    if (!product) {
      return fail(400, 'منتج غير موجود في المخزون');
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return fail(400, `كمية غير صالحة لـ «${product.name}»`);
    }
    if (product.hasVariants && variantId == null) {
      return fail(
        400,
        `«${product.name}» يحتاج اختيار اللون/المقاس (أو الحجم) أولاً`,
      );
    }
    if (!product.hasVariants && variantId != null) {
      return fail(400, `«${product.name}» ليس منتج متغيرات`);
    }
    if (variantId != null && !product.variants.some(v => v.id === variantId)) {
      return fail(400, `متغير غير متاح لـ «${product.name}»`);
    }
    if (unitId != null && !product.units.some(u => u.id === unitId)) {
      return fail(400, `وحدة غير متاحة لـ «${product.name}»`);
    }
    lines.push(catalogToCartLine(product, unitId, quantity, variantId));
  }

  const subtotal = lines.reduce(
    (sum, line) => sum + line.unitPrice * line.quantity,
    0,
  );
  // سقف الخصم: نسبة الكاشير من مجموع الفاتورة — لا أكثر أبداً.
  const maxDiscount = (subtotal * authed.maxDiscountPct) / 100;
  const requested = Math.max(0, Number(body.discount ?? 0) || 0);
  const discount = Math.min(requested, maxDiscount);

  try {
    let localDebt:
      | {localCustomerId: number; customerName: string}
      | undefined;
    if (paymentType === 'debt') {
      const customerId = Number(body.localCustomerId ?? 0);
      const balances = await LocalDebtsRepo.listWithBalances();
      const found = balances.find(b => b.customer.id === customerId);
      if (!found) {
        return fail(400, 'اختر زبوناً من دفتر المتجر للبيع بالدين');
      }
      localDebt = {
        localCustomerId: found.customer.id,
        customerName: found.customer.name,
      };
    }
    // v60: طباعة الفاتورة من طابعة نقطة البيع إن طلبها الكاشير
    // وكانت الطابعة متصلة فعلاً (خيار «الطباعة» في إعدادات كاشيره).
    const wantPrint = body.print === true;
    const print = wantPrint && (await printerConnected());
    const sale = await InvoiceService.completeSale({
      lines,
      discount,
      paymentType: 'RETAIL',
      print,
      receiptSettings: receiptSettings(),
      cashierId: authed.cashierId,
      localDebt: localDebt
        ? {
            localCustomerId: localDebt.localCustomerId,
            customerName: localDebt.customerName,
            customerPhoneLast4: null,
          }
        : undefined,
    });
    // ختم مرجع العميل وزمن البيع الفعلي (للتقارير والميزة).
    await stampSale(sale.sale.id, clientRef || null, clientCreatedAt || null);
    emitLanEvent({
      kind: 'sale',
      cashierName: authed.cashierName,
      invoiceNumber: sale.sale.invoice_number,
      total: sale.sale.total_amount,
      itemCount: lines.length,
      debt: paymentType === 'debt',
      offline: fromSync,
    });
    return ok({
      ok: true,
      printed: print,
      invoice: {
        id: sale.sale.id,
        number: sale.sale.invoice_number,
        total: sale.sale.total_amount,
        discount: sale.sale.discount,
        itemCount: lines.length,
        // زمن البيع الفعلي (وقت العملية عند الكاشير إن وصل).
        createdAt: clientCreatedAt || sale.sale.created_at,
      },
    });
  } catch (error) {
    // فهرس client_ref الفريد قد يضرب لو سبقت عملية مطابقة في سباق
    // نظري — استرجع الأصلية وأعدها كأي إعادة محاولة ناجحة.
    if (clientRef) {
      const hit = await saleByClientRef(clientRef);
      if (hit) {
        return ok({
          ok: true,
          duplicate: true,
          invoice: invoicePayload(hit),
        });
      }
    }
    const message =
      error instanceof Error ? error.message : 'فشل إتمام البيع';
    return fail(400, message);
  }
}

// ── فواتير الكاشير ────────────────────────────────────────────────
async function handleInvoiceList(
  req: LanRequestShape,
  authed: Authed,
): Promise<LanResponseShape> {
  const limit = Math.min(200, Math.max(5, Number(req.query.limit ?? 30) || 30));
  const since = Number(req.query.since ?? 0) || 0;
  const db = getDb();
  const result = await db.execute(
    `SELECT s.*, (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) AS item_count
     FROM sales s
     WHERE s.cashier_id = ? ${since > 0 ? 'AND s.id > ?' : ''}
     ORDER BY s.id DESC
     LIMIT ?`,
    since > 0 ? [authed.cashierId, since, limit] : [authed.cashierId, limit],
  );
  const rows = (result.rows ?? []) as unknown as Record<string, unknown>[];
  const invoices = rows.map(row => ({
    id: Number(row.id),
    number: String(row.invoice_number ?? ''),
    total: Number(row.total_amount ?? 0),
    discount: Number(row.discount ?? 0),
    isReturn: String(row.invoice_number ?? '').startsWith('RET-'),
    returnedMinor: Number(row.returned_minor ?? 0),
    paymentType: String(row.payment_type ?? 'RETAIL'),
    itemCount: Number(row.item_count ?? 0),
    createdAt: String(row.created_at ?? ''),
    clientRef: row.client_ref ? String(row.client_ref) : null,
  }));
  return ok({ok: true, invoices});
}

async function handleInvoiceDetail(
  req: LanRequestShape,
  authed: Authed,
): Promise<LanResponseShape> {
  const saleId = Number(req.query.id ?? 0);
  if (!saleId) {
    return fail(400, 'رقم الفاتورة مطلوب');
  }
  const sale = await SaleRepo.getById(saleId);
  if (!sale) {
    return fail(404, 'الفاتورة غير موجودة');
  }
  const owner = await dbCashierIdForSale(saleId);
  if (owner !== authed.cashierId) {
    return fail(403, 'هذه الفاتورة ليست من فواتيرك');
  }
  try {
    const prep = await InvoiceService.prepareReturn(saleId);
    return ok({
      ok: true,
      sale: {
        id: sale.id,
        number: sale.invoice_number,
        total: sale.total_amount,
        discount: sale.discount,
        createdAt: sale.created_at,
        returnedMinor: sale.returned_minor,
        isReturn: sale.invoice_number.startsWith('RET-'),
      },
      book: prep.book,
      debtState: prep.debtState.kind,
      returnsSoFar: prep.returnsSoFar.length,
      lines: prep.lines.map(l => ({
        saleItemId: l.item.id,
        productId: l.item.product_id,
        productName: l.productName,
        quantity: l.item.quantity,
        unitName: l.item.unit_name,
        unitPrice: l.item.unit_price,
        total: l.item.total_line_price,
        remaining: l.remaining,
        variantId: l.item.variant_id ?? null,
        variantLabel:
          l.item.variant_label != null && String(l.item.variant_label).length > 0
            ? String(l.item.variant_label)
            : null,
      })),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'تعذر تحضير الفاتورة';
    return fail(400, message);
  }
}

async function dbCashierIdForSale(saleId: number): Promise<number | null> {
  const result = await getDb().execute(
    'SELECT cashier_id FROM sales WHERE id = ?',
    [saleId],
  );
  const rows = (result.rows ?? []) as unknown as Record<string, unknown>[];
  if (rows.length === 0) {
    return null;
  }
  const value = rows[0].cashier_id;
  return value == null ? null : Number(value);
}

// ── الإرجاع والاستبدال ────────────────────────────────────────────
async function handleReturn(
  req: LanRequestShape,
  authed: Authed,
  fromSync: boolean,
): Promise<LanResponseShape> {
  const body = parseBody(req.body);
  // v59: مرتجع فاتورة أُجريت دون اتصال ولم تُزامَن بعد — يصل بمرجعها
  // (clientRef) بدل رقمها؛ الخادم يحلها إلى فاتورتها الحقيقية (سبق
  // أن زامنها نفس الدفعة بالتسلسل) أو يرفضها إن رُفض أصلها.
  let saleId = Number(body.saleId ?? 0);
  const saleClientRef = body.saleClientRef
    ? String(body.saleClientRef).slice(0, 80)
    : '';
  if (!saleId && saleClientRef) {
    const original = await saleByClientRef(saleClientRef);
    if (!original) {
      return fail(404, 'الفاتورة الأصلية غير مسجلة بعد — أعد المزامنة أولاً');
    }
    saleId = original.saleId;
  }
  if (!saleId) {
    return fail(400, 'رقم الفاتورة مطلوب');
  }
  if (!authed.canReturn) {
    return fail(403, 'المرتجعات والاستبدال مقفولة لحسابك — راجع المسؤول');
  }
  const clientRef = body.clientRef ? String(body.clientRef).slice(0, 80) : '';
  const clientCreatedAt = body.createdAt
    ? String(body.createdAt).slice(0, 19)
    : '';
  if (clientRef) {
    const hit = await returnByClientRef(clientRef);
    if (hit) {
      return ok({ok: true, duplicate: true, return: hit});
    }
  }
  const owner = await dbCashierIdForSale(saleId);
  if (owner !== authed.cashierId) {
    return fail(403, 'هذه الفاتورة ليست من فواتيرك');
  }
  const rawLines = Array.isArray(body.lines) ? body.lines : [];
  const rawExchange = Array.isArray(body.exchange) ? body.exchange : [];
  if (rawLines.length === 0 && rawExchange.length === 0) {
    return fail(400, 'حدد أصنافاً للإرجاع');
  }
  let prep: Awaited<ReturnType<typeof InvoiceService.prepareReturn>>;
  try {
    prep = await InvoiceService.prepareReturn(saleId);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'تعذر تحضير الإرجاع';
    return fail(400, message);
  }

  const lines: ReturnLineInput[] = [];
  for (const raw of rawLines) {
    const line = raw as Record<string, unknown>;
    const saleItemId = Number(line.saleItemId ?? 0);
    const quantity = Number(line.quantity ?? 0);
    const known = prep.lines.find(l => l.item.id === saleItemId);
    if (!known) {
      return fail(400, 'صنف غير موجود في الفاتورة');
    }
    if (quantity <= 0 || quantity > known.remaining + 0.0001) {
      return fail(
        400,
        `الكمية المطلوب إرجاعها من «${known.productName}» أكبر من المتبقي`,
      );
    }
    lines.push({
      saleItemId,
      productId: known.item.product_id,
      productName: known.productName,
      quantity,
      unitName: known.item.unit_name,
      basePerUnit:
        known.item.quantity > 0
          ? (known.item.base_quantity ?? 0) / known.item.quantity
          : 1,
      unitPrice: known.item.unit_price,
      costPrice: known.item.cost_price,
      variantId: known.item.variant_id ?? null,
      variantColor: known.item.variant_color ?? null,
      variantLabel: known.item.variant_label ?? null,
    });
  }

  // بدائل الاستبدال — تُسعَّر من قاعدة نقطة البيع مثل البيع تماماً
  // (v59: تشمل منتجات المتغيرات — يستبدل الكاشير ملابس بمقاس آخر).
  const exchange: ExchangeLineInput[] = [];
  if (rawExchange.length > 0) {
    const catalog = await loadCatalog('', []);
    const byId = new Map(catalog.map(p => [p.id, p]));
    for (const raw of rawExchange) {
      const line = raw as Record<string, unknown>;
      const productId = Number(line.productId ?? 0);
      const quantity = Number(line.quantity ?? 0);
      const unitId =
        line.unitId == null || line.unitId === '' ? null : Number(line.unitId);
      const variantId =
        line.variantId == null || line.variantId === ''
          ? null
          : Number(line.variantId);
      const product = byId.get(productId);
      if (!product) {
        return fail(400, 'منتج الاستبدال غير موجود');
      }
      if (!Number.isFinite(quantity) || quantity <= 0) {
        return fail(400, `كمية استبدال غير صالحة لـ «${product.name}»`);
      }
      if (product.hasVariants && variantId == null) {
        return fail(
          400,
          `«${product.name}» يحتاج اختيار اللون/المقاس أولاً`,
        );
      }
      if (!product.hasVariants && variantId != null) {
        return fail(400, `«${product.name}» ليس منتج متغيرات`);
      }
      if (variantId != null && !product.variants.some(v => v.id === variantId)) {
        return fail(400, `متغير غير متاح لـ «${product.name}»`);
      }
      const cartLine = catalogToCartLine(product, unitId, quantity, variantId);
      exchange.push({
        productId,
        productName: product.name,
        quantity,
        unitName: cartLine.unitName,
        basePerUnit: cartLine.conversion,
        unitPrice: cartLine.unitPrice,
        costPrice: cartLine.costPrice,
        variantId: cartLine.variantId ?? null,
        variantColor: null,
        variantLabel: cartLine.variantLabel ?? null,
      });
    }
  }

  const refundMethod = body.refundMethod === 'none' ? 'none' : 'cash';
  // v60: طباعة إيصال المرتجع من طابعة نقطة البيع إن طُلبت ومتصلة.
  const print = body.print === true && (await printerConnected());
  try {
    const record = await InvoiceService.createReturn({
      saleId,
      lines,
      // الاستبدال يسوّى بالفرق — نفس قاعدة نقطة البيع (none).
      refundMethod: exchange.length > 0 ? 'none' : refundMethod,
      note: body.note ? String(body.note).slice(0, 200) : null,
      print,
      receiptSettings: receiptSettings(),
      cashierId: authed.cashierId,
      exchange: exchange.length > 0 ? exchange : undefined,
    });
    await stampReturn(
      record.return_number,
      clientRef || null,
      clientCreatedAt || null,
    );
    emitLanEvent({
      kind: 'return',
      cashierName: authed.cashierName,
      returnNumber: record.return_number,
      refundMinor: record.refund_minor,
      exchangeMinor: record.exchange_minor,
      isExchange: record.is_exchange === 1,
    });
    return ok({
      ok: true,
      printed: print,
      return: {
        id: record.id,
        number: record.return_number,
        refundMinor: record.refund_minor,
        exchangeMinor: record.exchange_minor,
        isExchange: record.is_exchange,
      },
    });
  } catch (error) {
    if (clientRef) {
      const hit = await returnByClientRef(clientRef);
      if (hit) {
        return ok({ok: true, duplicate: true, return: hit});
      }
    }
    const message =
      error instanceof Error ? error.message : 'فشل تسجيل الإرجاع';
    return fail(400, message);
  }
}

// ── إحصاءات الكاشير ───────────────────────────────────────────────
async function handleStats(authed: Authed): Promise<LanResponseShape> {
  const stats = await CashiersRepo.statsFor(authed.cashierId);
  const db = getDb();
  const today = todayKey();

  const todayRow = await db.execute(
    `SELECT COUNT(*) AS cnt, COALESCE(SUM(total_amount), 0) AS total
     FROM sales
     WHERE cashier_id = ? AND invoice_number NOT LIKE 'RET-%'
       AND substr(created_at, 1, 10) = ?`,
    [authed.cashierId, today],
  );
  const todayReturnsRow = await db.execute(
    `SELECT COUNT(*) AS cnt, COALESCE(SUM(total_amount), 0) AS total
     FROM sales
     WHERE cashier_id = ? AND invoice_number LIKE 'RET-%'
       AND substr(created_at, 1, 10) = ?`,
    [authed.cashierId, today],
  );
  const top = await db.execute(
    `SELECT si.product_id, MAX(COALESCE(p.name, si.unit_name, '#')) AS name,
            SUM(si.quantity) AS qty, SUM(si.total_line_price) AS total
     FROM sale_items si
     JOIN sales s ON s.id = si.sale_id
     LEFT JOIN products p ON p.id = si.product_id
     WHERE s.cashier_id = ? AND s.invoice_number NOT LIKE 'RET-%'
     GROUP BY si.product_id
     ORDER BY total DESC
     LIMIT 8`,
    [authed.cashierId],
  );
  const daily = await db.execute(
    `SELECT substr(created_at, 1, 10) AS day,
            COUNT(*) AS cnt,
            SUM(CASE WHEN invoice_number NOT LIKE 'RET-%' THEN total_amount ELSE 0 END) AS sales_total,
            SUM(CASE WHEN invoice_number LIKE 'RET-%' THEN total_amount ELSE 0 END) AS returns_total
     FROM sales
     WHERE cashier_id = ?
     GROUP BY day
     ORDER BY day DESC
     LIMIT 14`,
    [authed.cashierId],
  );
  const t =
    ((todayRow.rows ?? []) as unknown as Record<string, unknown>[])[0] ?? {};
  const tr =
    ((todayReturnsRow.rows ?? []) as unknown as Record<string, unknown>[])[0] ??
    {};
  return ok({
    ok: true,
    cashier: {id: authed.cashierId, name: authed.cashierName},
    perms: {
      maxDiscountPct: authed.maxDiscountPct,
      canDebt: authed.canDebt,
      canReturn: authed.canReturn,
    },
    today: {
      salesCount: Number(t.cnt ?? 0),
      salesTotal: Number(t.total ?? 0),
      returnsCount: Number(tr.cnt ?? 0),
      returnsTotal: Number(tr.total ?? 0),
      net: Number(t.total ?? 0) + Number(tr.total ?? 0),
    },
    allTime: {
      salesCount: stats.salesCount,
      salesTotal: stats.salesTotal,
      returnsCount: stats.returnsCount,
      returnsTotal: stats.returnsTotal,
      net: stats.netTotal,
    },
    topProducts: ((top.rows ?? []) as unknown as Record<string, unknown>[]).map(
      row => ({
        productId: Number(row.product_id ?? 0),
        name: String(row.name ?? ''),
        qty: Number(row.qty ?? 0),
        total: Number(row.total ?? 0),
      }),
    ),
    daily: ((daily.rows ?? []) as unknown as Record<string, unknown>[]).map(
      row => ({
        day: String(row.day ?? ''),
        count: Number(row.cnt ?? 0),
        salesTotal: Number(row.sales_total ?? 0),
        returnsTotal: Number(row.returns_total ?? 0),
      }),
    ),
  });
}

// ── v59: مزامنة العمليات التي أُجريت دون اتصال ────────────────────
/** دفعة عمليات: كل عنصر {opId, kind: 'sale'|'return', ref, payload}.
 *  تُعالج بالتسلسل؛ استجابة مستقلة لكل عملية (نجاح برقم الفاتورة
 *  الحقيقي / خطأ بسبب واضح) — فلا تفقد الدفعة كلها بسبب عملية
 *  واحدة مرفوضة، والتطبيق يعلّم كل عملية بحالتها.
 *
 *  clientRef يمنع الازدواج: إعادة إرسال دفعة انقطعت في منتصفها
 *  تعيد نتائج العمليات الناجحة السابقة كما هي (duplicate=true).
 */
async function handleSyncPush(
  req: LanRequestShape,
  authed: Authed,
): Promise<LanResponseShape> {
  const body = parseBody(req.body);
  const rawOps = Array.isArray(body.ops) ? body.ops : [];
  if (rawOps.length === 0) {
    return fail(400, 'لا عمليات للمزامنة');
  }
  if (rawOps.length > 50) {
    return fail(400, 'الحد الأقصى 50 عملية في الدفعة');
  }
  const results: unknown[] = [];
  for (const raw of rawOps) {
    const op = raw as Record<string, unknown>;
    const opId = String(op.opId ?? '');
    const kind = String(op.kind ?? '');
    if (!opId || (kind !== 'sale' && kind !== 'return')) {
      results.push({opId, ok: false, error: 'عملية غير معروفة'});
      continue;
    }
    const opReq: LanRequestShape = {
      ...req,
      body: JSON.stringify(op.payload ?? {}),
    };
    const response =
      kind === 'sale'
        ? await handleSale(opReq, authed, true)
        : await handleReturn(opReq, authed, true);
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(response.body) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
    results.push({
      opId,
      ok: response.status === 200,
      status: response.status,
      ...(parsed.invoice != null ? {invoice: parsed.invoice} : {}),
      ...(parsed.return != null ? {return: parsed.return} : {}),
      ...(parsed.duplicate != null ? {duplicate: parsed.duplicate} : {}),
      ...(response.status !== 200
        ? {error: String(parsed.error ?? 'فشلت العملية')}
        : {}),
    });
  }
  return ok({ok: true, results});
}
