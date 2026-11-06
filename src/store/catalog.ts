/**
 * store/catalog.ts — v2.0: الكتالوج + السلة + ذاكرة الصور.
 * ─────────────────────────────────────────────────────────────────
 *  • الكتالوج يُجلب من نقطة البيع ويُخزَّن محلياً (kv) — فالبيع
 *    يستمر حتى بانقطاع الاتصال بأسعار وتسعير مطابقين لمعادلة
 *    الخادم حرفياً (نفس خصم المنتج، نفس أسعار الوحدات والمتغيرات).
 *  • السلة تدعم الوحدات والمتغيرات (لون×مقاس/حجم) والوزن — إصلاح
 *    «خطأ منتج متغيرات» الذي كان يمنع بيع الملابس والأحذية.
 *  • صور المنتجات تُجلب كسولاً (productImage) وتُخزَّن في الذاكرة
 *    + على القرص — لا تُطلب مرتين أبداً.
 */
import {create} from 'zustand';
import {CashierApi} from '../api/client';
import type {CatalogProduct, CatalogVariant} from '../api/types';
import {
  cacheCatalog,
  loadCachedCatalog,
  pendingStockAdjustments,
  type PendingStockAdjustment,
} from './offline';
import {LanBridge, localDb} from '../native';

interface CatalogState {
  products: CatalogProduct[];
  loading: boolean;
  lastFetchAt: number;
  fromCache: boolean;
  /** يبدأ من النسخة المخزنة (فوري) ثم يجلب تحديثاً إن توفر الاتصال. */
  hydrate: () => Promise<void>;
  refresh: () => Promise<void>;
}

/**
 * v2.1 — تطبيع بطاقة المنتج قبل دخولها الواجهة: يضمن أن units و
 * variants مصفوفتان دائماً وأن كل الحقول من الأنواع الصحيحة، مهما
 * أرسل الخادم أو أخفى التخزين المؤقت — فلا ينهار أي رسم أبداً
 * («Cannot read property of undefined») حتى مع بيانات قديمة/شاذة.
 */
function normalizeProducts(list: unknown): CatalogProduct[] {
  if (!Array.isArray(list)) {
    return [];
  }
  return list.map(item => {
    const raw = (item ?? {}) as Record<string, unknown>;
    return {
      id: Number(raw.id ?? 0),
      name: String(raw.name ?? ''),
      categoryId:
        raw.categoryId == null ? null : Number(raw.categoryId),
      categoryName: String(raw.categoryName ?? ''),
      retailPrice: Number(raw.retailPrice ?? 0) || 0,
      wholesalePrice: Number(raw.wholesalePrice ?? 0) || 0,
      costPrice: Number(raw.costPrice ?? 0) || 0,
      discountPct: Number(raw.discountPct ?? 0) || 0,
      stockQty: Number(raw.stockQty ?? 0) || 0,
      stockUntracked: Boolean(raw.stockUntracked),
      byWeight: Boolean(raw.byWeight),
      barcode: raw.barcode == null ? null : String(raw.barcode),
      hasVariants: Boolean(raw.hasVariants),
      hasImage: Boolean(raw.hasImage),
      units: Array.isArray(raw.units)
        ? raw.units
            .filter(u => u != null)
            .map(u => ({
              id: Number(u.id ?? 0),
              name: String(u.name ?? ''),
              short: String(u.short ?? ''),
              conversion: Number(u.conversion ?? 1) || 1,
              retailPrice:
                u.retailPrice == null ? null : Number(u.retailPrice),
              barcode: u.barcode == null ? null : String(u.barcode),
            }))
        : [],
      variants: Array.isArray(raw.variants)
        ? raw.variants
            .filter(v => v != null)
            .map(v => ({
              id: Number(v.id ?? 0),
              kind: v.kind === 'size' ? ('size' as const) : ('variant' as const),
              color: String(v.color ?? ''),
              size: String(v.size ?? ''),
              retailPrice:
                v.retailPrice == null ? null : Number(v.retailPrice),
              costPrice:
                v.costPrice == null ? null : Number(v.costPrice),
              stockQty: Number(v.stockQty ?? 0) || 0,
            }))
        : [],
    };
  });
}

export const useCatalogStore = create<CatalogState>((set, get) => ({
  products: [],
  loading: false,
  lastFetchAt: 0,
  fromCache: false,

  async hydrate() {
    if (get().lastFetchAt > 0) {
      return;
    }
    const cached = normalizeProducts(await loadCachedCatalog());
    if (cached.length > 0) {
      set({products: cached, fromCache: true, lastFetchAt: -1});
    }
    // v3.2: تسويات العمليات المعلّقة فوق مخزون الكاش (دون اتصال).
    await refreshPendingStockAdjustments();
    await get().refresh();
  },

  async refresh() {
    if (get().loading) {
      return;
    }
    set({loading: true});
    try {
      const payload = await CashierApi.catalog();
      const products = normalizeProducts(payload?.products ?? []);
      set({products, lastFetchAt: Date.now(), fromCache: false});
      await cacheCatalog(products);
    } catch {
      // فشل الجلب — النسخة المخزنة (إن وجدت) تبقى شغالة.
      if (get().lastFetchAt === 0) {
        const cached = normalizeProducts(await loadCachedCatalog());
        if (cached.length > 0) {
          set({products: cached, fromCache: true, lastFetchAt: -1});
        }
      }
    } finally {
      set({loading: false});
    }
  },
}));

// ── ذاكرة الصور (الذاكرة + القرص) ────────────────────────────────
const memoryImages = new Map<number, string>();

/** حفظ صورة على القرص (filesDir/imgcache) — أفضل جهد. */
async function persistImage(productId: number, base64: string): Promise<void> {
  try {
    await localRun(
      'INSERT OR REPLACE INTO image_cache (product_id, base64, saved_at) VALUES (?, ?, ?)',
      [productId, base64, Date.now()],
    );
  } catch {
    // الأقراص لا تعطل البيع أبداً.
  }
}

// جدول ذاكرة الصور داخل القاعدة المحلية (يُنشأ كسولاً).
let imageTableReady = false;
async function ensureImageTable(): Promise<void> {
  if (imageTableReady) {
    return;
  }
  await localDb.run(
    `CREATE TABLE IF NOT EXISTS image_cache (
      product_id INTEGER PRIMARY KEY,
      base64 TEXT NOT NULL,
      saved_at INTEGER NOT NULL
    )`,
    [],
  );
  imageTableReady = true;
}

async function localRun(sql: string, params: unknown[]): Promise<void> {
  await ensureImageTable();
  await localDb.run(sql, params);
}

async function localSelect(
  sql: string,
  params: unknown[],
): Promise<Record<string, string | number | null>[]> {
  await ensureImageTable();
  return localDb.select(sql, params);
}

export const imageStore = {
  /** جلب صورة منتج: الذاكرة ← القرص ← الخادم (مرة واحدة فقط). */
  async get(productId: number): Promise<string | null> {
    const hit = memoryImages.get(productId);
    if (hit != null) {
      return hit;
    }
    try {
      const rows = await localSelect(
        'SELECT base64 FROM image_cache WHERE product_id = ?',
        [productId],
      );
      if (rows.length > 0 && rows[0].base64) {
        const base64 = String(rows[0].base64);
        memoryImages.set(productId, base64);
        return base64;
      }
    } catch {
      // تجاهل — نحاول الخادم.
    }
    try {
      const payload = await CashierApi.productImage(productId);
      if (payload?.image) {
        memoryImages.set(productId, payload.image);
        await persistImage(productId, payload.image);
        return payload.image;
      }
    } catch {
      return null;
    }
    return null;
  },
};

// ── التسعير (نفس معادلة الخادم حرفياً) ───────────────────────────
export function linePrice(
  product: CatalogProduct,
  unitId: number | null,
): number {
  const unit =
    unitId != null ? product.units.find(u => u.id === unitId) : undefined;
  const raw = unit
    ? unit.retailPrice ?? product.retailPrice * unit.conversion
    : product.retailPrice;
  const pct = Math.max(0, Math.min(95, product.discountPct || 0));
  return pct > 0 ? Math.round(raw * (1 - pct / 100) * 100) / 100 : raw;
}

// ── تسويات المخزون المعلّقة (v3.2 — العمل دون اتصال) ────────────
// عمليات بِيعت/رُجعت محلياً ولم تصل نقطة البيع بعد: تُطبّق فوق
// مخزون آخر مزامنة ناجحة فيعرض التطبيق المتاح الحقيقي ويحرس
// البيع ضده. بعد المزامنة تُصفّر تلقائياً (الخادم شملها).
let pendingAdj: PendingStockAdjustment[] = [];
const pendingAdjByProduct = new Map<number, PendingStockAdjustment[]>();
const pendingAdjByVariant = new Map<number, number>();

/** إعادة تحميل التسويات المعلّقة — تُستدعى بعد كل عملية محلية
 *  وبعد كل دورة مزامنة وبعد الإقلاع. */
export async function refreshPendingStockAdjustments(): Promise<void> {
  try {
    pendingAdj = await pendingStockAdjustments();
  } catch {
    pendingAdj = [];
  }
  pendingAdjByProduct.clear();
  pendingAdjByVariant.clear();
  for (const adj of pendingAdj) {
    const list = pendingAdjByProduct.get(adj.productId) ?? [];
    list.push(adj);
    pendingAdjByProduct.set(adj.productId, list);
    if (adj.variantId != null) {
      pendingAdjByVariant.set(
        adj.variantId,
        (pendingAdjByVariant.get(adj.variantId) ?? 0) + adj.deltaBase,
      );
    }
  }
}

/** تسوية الأساس لمنتج (كل متغيراته مضمنة داخل مخزون المنتج). */
function productBaseAdjustment(productId: number): number {
  let delta = 0;
  for (const adj of pendingAdjByProduct.get(productId) ?? []) {
    delta += adj.deltaBase;
  }
  return delta;
}

/** تسوية متغير بعينه (لون × مقاس). */
function variantAdjustment(variantId: number): number {
  return pendingAdjByVariant.get(variantId) ?? 0;
}

/**
 * v3.2 — المخزون الفعلي فوق قاعدة معطاة (دالة خالصة قابلة
 * للاختبار): مخزون آخر مزامنة + تسويات العمليات المعلّقة، بال
 * وحدة السطر أو رصيد المتغير — نفس معادلة availableStock لكن
 * بتسويات صريحة بدل المفهرسة الداخلية.
 */
export function stockWithAdjustments(
  product: CatalogProduct,
  adjustments: PendingStockAdjustment[],
  unitId: number | null,
  variantId: number | null,
): number {
  if (product.stockUntracked) {
    return 999999;
  }
  let baseAdj = 0;
  let varAdj = 0;
  for (const adj of adjustments) {
    if (adj.productId === product.id) {
      baseAdj += adj.deltaBase;
      if (variantId != null && adj.variantId === variantId) {
        varAdj += adj.deltaBase;
      }
    }
  }
  if (variantId != null) {
    const variant = product.variants.find(v => v.id === variantId);
    if (variant != null) {
      if (variant.kind === 'size') {
        return Math.max(0, product.stockQty + baseAdj);
      }
      return Math.max(0, variant.stockQty + varAdj);
    }
  }
  const effectiveBase = product.stockQty + baseAdj;
  if (unitId != null) {
    const unit = product.units.find(u => u.id === unitId);
    if (unit != null && unit.conversion > 0) {
      return Math.max(0, effectiveBase / unit.conversion);
    }
  }
  return Math.max(0, effectiveBase);
}

/** سعر متغير — نفس toVariantLine/toSizedLine في نقطة البيع. */
export function variantPrice(
  product: CatalogProduct,
  variant: CatalogVariant,
): number {
  const isSize = variant.kind === 'size';
  const raw = isSize
    ? variant.retailPrice ?? product.retailPrice
    : product.retailPrice;
  const pct = Math.max(0, Math.min(95, product.discountPct || 0));
  return pct > 0 ? Math.round(raw * (1 - pct / 100) * 100) / 100 : raw;
}

/** وصف المتغير للعرض («أسود · L» أو الحجم). */
export function variantLabel(variant: CatalogVariant): string {
  return variant.kind === 'size'
    ? variant.size
    : variant.color
    ? `${variant.color} · ${variant.size}`
    : variant.size;
}

/** المخزون المتاح لسطر (وحدة/متغير/أساس) — لعرض النفاد فقط.
 *  v3.2: يشمل تسويات العمليات المعلّقة (بيع دون اتصال يخصم
 *  محلياً ومرتجعه يرجع محلياً) فوق مخزون آخر مزامنة. */
export function availableStock(
  product: CatalogProduct,
  unitId: number | null,
  variantId: number | null,
): number {
  return stockWithAdjustments(product, pendingAdj, unitId, variantId);
}

/**
 * v3.5 (الجولة 91 — كاشير #2) — «الخصم اللحظي» المرئي: الرقم
 * المعروض على البلاطة/الصف/البطاقة هو مخزون آخر مزامنة + المعلّق
 * المحلي (بيع دون اتصال يحرّك الرقم فوراً في كل العروض — طلب
 * التاجر نصاً: «يحدث خصم لحظي من المخزون»). بلا تتبع → لا رقم.
 */
export function displayBaseStock(product: CatalogProduct): number {
  return Math.max(0, product.stockQty + productBaseAdjustment(product.id));
}

/**
 * v3.5: رصيد متغير (لون×مقاس) كما يُعرض على رقائق المقاسات —
 * يشمل معلّق هذا الجهاز فلا يُباع ما نُفد محلياً، ويتعادل مع
 * الخادم بعد المزامنة تلقائياً.
 */
export function displayVariantStock(
  product: CatalogProduct,
  variantId: number,
): number {
  const variant = product.variants.find(v => v.id === variantId);
  if (variant == null) {
    return 0;
  }
  // الأحجام (مطعم) تُباع من مخزون المنتج نفسه — نفس قاعدة السلة.
  if (variant.kind === 'size') {
    return displayBaseStock(product);
  }
  return Math.max(0, variant.stockQty + variantAdjustment(variant.id));
}

// ── السلة ────────────────────────────────────────────────────────
export interface CartLine {
  key: string;
  product: CatalogProduct;
  unitId: number | null;
  unitName: string;
  conversion: number;
  variantId: number | null;
  variantLabel: string | null;
  unitPrice: number;
  quantity: number;
  byWeight: boolean;
}

interface CartState {
  lines: CartLine[];
  discount: number;
  add: (
    product: CatalogProduct,
    unitId: number | null,
    quantity: number,
    variantId?: number | null,
  ) => CartOpResult;
  setQuantity: (key: string, quantity: number) => CartOpResult;
  removeLine: (key: string) => void;
  setDiscount: (value: number) => void;
  clear: () => void;
  subtotal: () => number;
  total: () => number;
  count: () => number;
}

/** v3.0: نتيجة عملية سلة مقيدة بالمخزون — نفس انضباط نقطة البيع. */
export interface CartOpResult {
  ok: boolean;
  reason?: string;
}

/** تقريب كمية للعرض في رسائل المخزون (12.500 → 12.5). */
function qtyForMessage(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

export const useCartStore = create<CartState>((set, get) => ({
  lines: [],
  discount: 0,

  add(product, unitId, quantity, variantId = null) {
    // v3.0 — نفس قواعد نقطة البيع: منتج نفد لا يدخل السلة أبداً
    // (المحكوم بلا تتبع مخزون يُباع دائماً). الجديد يُجمع مع ما في
    // السلة من نفس الخط قبل الفحص — فلا يُباع ما نفد مهما تكرر.
    const guard = stockGuard(get().lines, product, unitId, variantId, quantity);
    if (guard != null) {
      return guard;
    }
    const key = `${product.id}-${unitId ?? ''}-v${variantId ?? ''}`;
    const unit =
      unitId != null ? product.units.find(u => u.id === unitId) : undefined;
    const variant =
      variantId != null
        ? product.variants.find(v => v.id === variantId)
        : undefined;
    const existing = get().lines.find(line => line.key === key);
    if (existing) {
      set({
        lines: get().lines.map(line =>
          line.key === key
            ? {...line, quantity: line.quantity + quantity}
            : line,
        ),
      });
      return {ok: true};
    }
    const price = variant ? variantPrice(product, variant) : linePrice(product, unitId);
    set({
      lines: [
        ...get().lines,
        {
          key,
          product,
          unitId,
          unitName: variant ? 'قطعة' : unit ? unit.name : 'حبة',
          conversion: variant ? 1 : unit ? unit.conversion : 1,
          variantId,
          variantLabel: variant ? variantLabelOf(variant) : null,
          unitPrice: price,
          quantity,
          byWeight: product.byWeight && !unit && !variant,
        },
      ],
    });
    return {ok: true};
  },

  setQuantity(key, quantity) {
    const line = get().lines.find(item => item.key === key);
    if (line == null) {
      return {ok: false};
    }
    if (quantity <= 0) {
      set({lines: get().lines.filter(item => item.key !== key)});
      return {ok: true};
    }
    // v3.0: التخفيض مسموح دائماً؛ الزيادة تُفحص مقابل المخزون.
    if (quantity > line.quantity) {
      const guard = stockGuard(
        get().lines,
        line.product,
        line.unitId,
        line.variantId,
        quantity - line.quantity,
      );
      if (guard != null) {
        return guard;
      }
    }
    set({
      lines: get().lines.map(item =>
        item.key === key ? {...item, quantity} : item,
      ),
    });
    return {ok: true};
  },

  removeLine(key) {
    set({lines: get().lines.filter(line => line.key !== key)});
  },

  setDiscount(value) {
    set({discount: Math.max(0, value)});
  },

  clear() {
    set({lines: [], discount: 0});
  },

  subtotal() {
    return get().lines.reduce(
      (sum, line) => sum + line.unitPrice * line.quantity,
      0,
    );
  },

  total() {
    const subtotal = get().subtotal();
    return Math.max(0, subtotal - get().discount);
  },

  count() {
    return get().lines.length;
  },
}));

function variantLabelOf(variant: CatalogVariant): string {
  return variantLabel(variant);
}

/**
 * v3.0 — حارس المخزون لكل مسارات السلة (إضافة/زيادة):
 *  • متغير (لون×مقاس/حجم): مجموع كميات نفس المتغير في السلة +
 *    الجديد لا يتجاوز رصيد المتغير.
 *  • وحدة (علبة/شريط) أو وزن (كغ): مجموع الوحدات الأساسية في
 *    السلة + الجديد (معامل التحويل) لا يتجاوز رصيد المنتج.
 * يعيد نتيجة فشل مع سبب عربي واضح، أو null عند السماح.
 */
function stockGuard(
  lines: CartLine[],
  product: CatalogProduct,
  unitId: number | null,
  variantId: number | null,
  quantity: number,
): CartOpResult | null {
  if (product.stockUntracked) {
    return null;
  }
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return {ok: false, reason: 'كمية غير صالحة'};
  }
  if (variantId != null) {
    const variant = product.variants.find(v => v.id === variantId);
    if (variant == null) {
      return {ok: false, reason: 'متغير غير متاح'};
    }
    // الأحجام (مطعم/كافيتريا) تُباع من مخزون المنتج نفسه — نفس
    // قاعدة نقطة البيع (addSizedLine)؛ ملابس لون×مقاس بمخزون
    // المتغير الخاص به.
    if (variant.kind === 'size') {
      const alreadyBase = lines
        .filter(
          line =>
            line.product.id === product.id && line.variantId == null,
        )
        .reduce((sum, line) => sum + line.quantity * line.conversion, 0);
      // v3.2: مخزون آخر مزامنة + المعلّق المحلي.
      const stock = Math.max(
        0,
        product.stockQty + productBaseAdjustment(product.id),
      );
      if (alreadyBase + quantity > stock + 0.0001) {
        const leftBase = Math.max(0, stock - alreadyBase);
        if (leftBase <= 0.0001) {
          return {
            ok: false,
            reason: `نفد «${product.name}» من المخزون`,
          };
        }
        return {
          ok: false,
          reason: `المتاح من ${product.name} ${qtyForMessage(leftBase)} حبة فقط`,
        };
      }
      return null;
    }
    const already = lines
      .filter(
        line =>
          line.product.id === product.id && line.variantId === variantId,
      )
      .reduce((sum, line) => sum + line.quantity, 0);
    // v3.2: رصيد المتغير + معلّقه المحلي.
    const variantStock = variant.stockQty + variantAdjustment(variant.id);
    if (already + quantity > variantStock + 0.0001) {
      const left = Math.max(0, variantStock - already);
      if (left <= 0.0001) {
        return {
          ok: false,
          reason: `نفد «${product.name}» (${variantLabel(variant)}) من المخزون`,
        };
      }
      return {
        ok: false,
        reason: `المتاح من ${product.name} (${variantLabel(variant)}) ${qtyForMessage(left)} فقط`,
      };
    }
    return null;
  }
  const unit =
    unitId != null ? product.units.find(u => u.id === unitId) : undefined;
  const conversion = unit ? unit.conversion : 1;
  // مجموع الوحدات الأساسية للمنتج في السلة (خطوط بلا متغير).
  const alreadyBase = lines
    .filter(line => line.product.id === product.id && line.variantId == null)
    .reduce((sum, line) => sum + line.quantity * line.conversion, 0);
  // v3.2: مخزون آخر مزامنة + المعلّق المحلي.
  const stock = Math.max(
    0,
    product.stockQty + productBaseAdjustment(product.id),
  );
  if (alreadyBase + conversion * quantity > stock + 0.0001) {
    const leftBase = Math.max(0, stock - alreadyBase);
    if (leftBase <= 0.0001) {
      return {
        ok: false,
        reason: `نفد «${product.name}» من المخزون — لا يُباع حتى يعود للمخزون`,
      };
    }
    const leftInUnit = conversion > 0 ? leftBase / conversion : leftBase;
    return {
      ok: false,
      reason: `المتاح من ${product.name} ${qtyForMessage(leftInUnit)} ${unit ? unit.name : product.byWeight ? 'كغ' : 'حبة'} فقط`,
    };
  }
  return null;
}

/** هل المنتج قابل للبيع الآن (غير نافد كلياً)؟ — لتعتيم البلاطة.
 *  الأحجام تُباع من مخزون المنتج؛ ملابس من رصيد متغيراتها. */
export function sellableNow(product: CatalogProduct): boolean {
  if (product.stockUntracked) {
    return true;
  }
  // v3.2: كل الأرصدة تشمل المعلّق المحلي (بيع دون اتصال يُرى فوراً).
  const base = product.stockQty + productBaseAdjustment(product.id);
  if (product.hasVariants) {
    if (base > 0) {
      return true;
    }
    return product.variants.some(
      v => v.stockQty + variantAdjustment(v.id) > 0,
    );
  }
  return base > 0;
}

/** تفريغ أي مرجع قديم عند تسجيل الخروج. */
export function resetImageMemory(): void {
  memoryImages.clear();
}

export {LanBridge};
