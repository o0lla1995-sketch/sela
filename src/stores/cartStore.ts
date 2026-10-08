/**
 * Cart store — the live checkout state.
 * ─────────────────────────────────────────────────────────────────
 * Lines keep a price snapshot (retail + wholesale + cost) so the
 * مفرق/جملة switch re-prices instantly without a DB round-trip.
 * Each line also carries its sellable unit (قطعة / كرتونة / كيلو…)
 * with the conversion factor — stock is always tracked in BASE
 * units while the merchant sells in whatever unit they choose.
 * A draft is persisted to MMKV so an accidental app kill never
 * loses an in-progress sale.
 */
import {create} from 'zustand';
import {getJson, setJson, KEYS, storage} from '../storage/storage';
import {
  BASE_UNIT_NAME,
  QTY_EPSILON,
  WEIGHT_QTY_DECIMALS,
  WEIGHT_UNIT_NAME,
} from '../core/config';
import type {
  CartLine,
  PricingMode,
  Product,
  ProductUnit,
  ProductVariant,
} from '../core/types';

/** v35 (الجولة 43): المخزون البلا تتبع — سقف وهمي كبير كي لا
 *  يُحجب البيع أبداً (مطعم/كافيتريا: الطبق خدمة لا مخزون). */
export const UNTRACKED_STOCK = 999999;

/** v9.2 (round-15 #4): compact quantity for stock messages — trims
 *  float noise (12.500 → 12.5) so "المتاح 12.5 كغ" reads naturally. */
function formatQtyForMessage(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  return String(rounded);
}

/** Price of one chosen unit under a pricing mode. */
export function unitPriceFor(
  product: Product,
  unit: ProductUnit | null,
  mode: PricingMode,
): number {
  if (unit == null) {
    return mode === 'WHOLESALE'
      ? product.wholesale_price
      : product.retail_price;
  }
  const override =
    mode === 'WHOLESALE' ? unit.wholesale_price : unit.retail_price;
  if (override != null && override > 0) {
    return override;
  }
  const base =
    mode === 'WHOLESALE' ? product.wholesale_price : product.retail_price;
  return base * unit.conversion;
}

function lineKey(
  productId: number,
  unitId: number | null,
  variantId?: number | null,
): string {
  return `${productId}:${unitId ?? 0}:${variantId ?? 0}`;
}

/** v35 (الجولة 43): وحدة عرض السطر — وحدة الأساس بلغة المجال
 *  (شريط/علبة للصيدلية، حصة/صحن للمطعم) مكان «قطعة» العامة. */
function baseUnitLabelOfProduct(product: Product): string {
  if (product.sold_by_weight === 1) {
    return WEIGHT_UNIT_NAME;
  }
  return product.base_unit_name ?? BASE_UNIT_NAME;
}

function toLine(
  product: Product,
  mode: PricingMode,
  unit: ProductUnit | null,
): CartLine {
  const weighted = product.sold_by_weight === 1;
  const untracked = product.stock_untracked === 1;
  return {
    key: lineKey(product.id, unit?.unit_id ?? null),
    productId: product.id,
    name: product.name,
    unitPrice: unitPriceFor(product, unit, mode),
    costPrice: unit ? product.cost_price * unit.conversion : product.cost_price,
    retailPrice: unit
      ? unit.retail_price ?? product.retail_price * unit.conversion
      : product.retail_price,
    wholesalePrice: unit
      ? unit.wholesale_price ?? product.wholesale_price * unit.conversion
      : product.wholesale_price,
    quantity: 1,
    availableStock: untracked ? UNTRACKED_STOCK : product.stock_quantity,
    unitId: unit?.unit_id ?? null,
    unitName:
      unit?.unitName ?? baseUnitLabelOfProduct(product),
    conversion: unit?.conversion ?? 1,
    /** v8.3: weight-sold lines accept fractional quantities (kg). */
    byWeight: weighted,
  };
}

/** v8.3: a fresh weight line with an arbitrary (fractional) kg qty. */
function toWeightLine(
  product: Product,
  mode: PricingMode,
  unit: ProductUnit | null,
  quantity: number,
): CartLine {
  const line = toLine(product, mode, unit);
  return {
    ...line,
    quantity:
      Math.round(quantity * 10 ** WEIGHT_QTY_DECIMALS) /
      10 ** WEIGHT_QTY_DECIMALS,
  };
}

/** v35 (الجولة 43): سطر متغير ملابس — لون × مقاس محدد بسعر القطعة
 *  (مفرق أو جملة حسب وضع التسعير)؛ حرس المخزون على صف المتغير
 *  نفسه لا على مجموع الموديل. */
function toVariantLine(
  product: Product,
  mode: PricingMode,
  variant: ProductVariant,
  quantity: number,
): CartLine {
  const price =
    mode === 'WHOLESALE' ? product.wholesale_price : product.retail_price;
  const label = variant.color
    ? `${variant.color} · ${variant.size}`
    : variant.size;
  return {
    key: lineKey(product.id, null, variant.id),
    productId: product.id,
    name: product.name,
    unitPrice: price,
    costPrice: variant.cost_price ?? product.cost_price,
    // سعر المتغير ثابت — لا يُعاد تسعيره بتبديل وضع الجملة.
    retailPrice: price,
    wholesalePrice: price,
    quantity,
    availableStock:
      product.stock_untracked === 1
        ? UNTRACKED_STOCK
        : variant.stock_quantity,
    unitId: null,
    unitName: baseUnitLabelOfProduct(product),
    conversion: 1,
    variantId: variant.id,
    variantLabel: label,
  };
}

/** v35: سطر ربطة الجملة — قطعة من كل مقاس باللون المختار؛ السعر
 *  = سعر القطعة بالجملة × عدد المقاسات، والحد الأدنى لمخزون
 *  مقاسات اللون هو المتاح من الربط. */
function toBundleLine(
  product: Product,
  color: string,
  bundles: number,
): CartLine {
  const sizesCount =
    product.sizes_count ??
    new Set(
      (product.variants ?? [])
        .filter(v => v.kind === 'variant' && v.color === color)
        .map(v => v.size),
    ).size;
  const perPiece =
    product.wholesale_price > 0
      ? product.wholesale_price
      : product.retail_price;
  const bundlePrice = Math.round(perPiece * sizesCount * 100) / 100;
  return {
    key: lineKey(product.id, -1),
    productId: product.id,
    name: product.name,
    unitPrice: bundlePrice,
    costPrice: product.cost_price * sizesCount,
    retailPrice: bundlePrice,
    wholesalePrice: bundlePrice,
    quantity: bundles,
    availableStock: UNTRACKED_STOCK, // يُضبط أدناه من مقاسات اللون
    unitId: null,
    unitName: 'ربطة',
    conversion: sizesCount,
    variantId: null,
    variantLabel: `${color} (ربطة ${sizesCount} مقاسات)`,
    bundleColor: color,
  };
}

/** v35: سطر حجم (مطعم/كافيتريا) — سعر الحجم الخاص به وتكلفته،
 *  والمخزون على مستوى المنتج إن كان مُتبعاً. */
function toSizedLine(
  product: Product,
  sizeVariant: ProductVariant,
  quantity: number,
): CartLine {
  const price = sizeVariant.retail_price ?? product.retail_price;
  return {
    key: lineKey(product.id, null, sizeVariant.id),
    productId: product.id,
    name: product.name,
    unitPrice: price,
    costPrice: sizeVariant.cost_price ?? product.cost_price,
    retailPrice: price,
    wholesalePrice: price,
    quantity,
    availableStock:
      product.stock_untracked === 1
        ? UNTRACKED_STOCK
        : product.stock_quantity,
    unitId: null,
    unitName: baseUnitLabelOfProduct(product),
    conversion: 1,
    variantId: sizeVariant.id,
    variantLabel: sizeVariant.size,
  };
}

interface CartState {
  lines: CartLine[];
  pricingMode: PricingMode;
  discount: number;
  addProduct: (
    product: Product,
    mode: PricingMode,
    unit?: ProductUnit | null,
  ) => {added: boolean; reason?: string};
  /** v8.3 (round-12 #4): add a WEIGHT-sold product with a fractional
   *  quantity (kg or a sub-unit like وقية via `unit`). */
  addWeighted: (
    product: Product,
    mode: PricingMode,
    quantity: number,
    unit?: ProductUnit | null,
  ) => {added: boolean; reason?: string};
  /** v35 (الجولة 43): متغير ملابس مفرق — لون × مقاس بكمية. */
  addVariantLine: (
    product: Product,
    mode: PricingMode,
    variant: ProductVariant,
    quantity: number,
  ) => {added: boolean; reason?: string};
  /** v35: ربطة جملة — عدد ربط بلون محدد (قطعة من كل مقاس). */
  addBundleLine: (
    product: Product,
    color: string,
    bundles: number,
  ) => {added: boolean; reason?: string};
  /** v35: حجم مطعم/كافيتريا بسعره الخاص بكمية. */
  addSizedLine: (
    product: Product,
    sizeVariant: ProductVariant,
    quantity: number,
  ) => {added: boolean; reason?: string};
  setLineUnit: (
    product: Product,
    unit: ProductUnit | null,
  ) => {ok: boolean; reason?: string};
  increment: (key: string) => {ok: boolean; reason?: string};
  decrement: (key: string) => void;
  removeLine: (key: string) => void;
  setQuantity: (
    key: string,
    quantity: number,
  ) => {ok: boolean; reason?: string};
  setDiscount: (discount: number) => void;
  setPricingMode: (mode: PricingMode) => void;
  clear: () => void;
  clearDiscount: () => void;
}

interface DraftSnapshot {
  lines: CartLine[];
  pricingMode: PricingMode;
  discount: number;
}

/** Normalizes draft lines loaded from older versions. */
function normalizeLine(line: CartLine): CartLine {
  return {
    ...line,
    key: line.key ?? lineKey(line.productId, line.unitId ?? null),
    unitId: line.unitId ?? null,
    unitName: line.unitName ?? BASE_UNIT_NAME,
    conversion: line.conversion ?? 1,
    byWeight: line.byWeight ?? false,
  };
}

function loadDraft(): DraftSnapshot {
  const draft = getJson<DraftSnapshot | null>(KEYS.cartDraft, null);
  if (draft && Array.isArray(draft.lines)) {
    return {
      lines: draft.lines.map(normalizeLine),
      pricingMode: draft.pricingMode === 'WHOLESALE' ? 'WHOLESALE' : 'RETAIL',
      discount: Number(draft.discount) || 0,
    };
  }
  return {lines: [], pricingMode: 'RETAIL', discount: 0};
}

function saveDraft(
  lines: CartLine[],
  pricingMode: PricingMode,
  discount: number,
): void {
  setJson(KEYS.cartDraft, {
    lines,
    pricingMode,
    discount,
  } satisfies DraftSnapshot);
}

/** Base pieces already reserved by a line (excluding one line). */
function baseUsed(lines: CartLine[], excludeKey?: string): Map<number, number> {
  const used = new Map<number, number>();
  for (const line of lines) {
    if (line.key === excludeKey) continue;
    used.set(
      line.productId,
      (used.get(line.productId) ?? 0) + line.quantity * line.conversion,
    );
  }
  return used;
}

/** v35 (الجولة 43): القطع المحجوزة لكل متغير (ملابس مفرق). */
function variantUsed(
  lines: CartLine[],
  excludeKey?: string,
): Map<number, number> {
  const used = new Map<number, number>();
  for (const line of lines) {
    if (line.key === excludeKey) continue;
    if (line.variantId == null) continue;
    used.set(
      line.variantId,
      (used.get(line.variantId) ?? 0) + line.quantity * line.conversion,
    );
  }
  return used;
}

/** v35: الربط المحجوزة لكل (منتج : لون) — بيع الجملة بالربطة. */
function bundleUsed(
  lines: CartLine[],
  excludeKey?: string,
): Map<string, number> {
  const used = new Map<string, number>();
  for (const line of lines) {
    if (line.key === excludeKey) continue;
    if (line.bundleColor == null) continue;
    const key = `${line.productId}:${line.bundleColor}`;
    used.set(key, (used.get(key) ?? 0) + line.quantity);
  }
  return used;
}

export const useCartStore = create<CartState>((set, get) => ({
  ...loadDraft(),

  addProduct: (product, mode, unit = null) => {
    const state = get();
    const key = lineKey(product.id, unit?.unit_id ?? null);
    const conversion = unit?.conversion ?? 1;
    const existing = state.lines.find(line => line.key === key);
    const untracked = product.stock_untracked === 1;
    const used = baseUsed(state.lines);
    const alreadyInCart = used.get(product.id) ?? 0;

    // v35 (الجولة 43): المخزون بلا تتبع لا يُحجب أبداً.
    if (
      !untracked &&
      alreadyInCart + conversion > product.stock_quantity
    ) {
      return {
        added: false,
        // v9.2 (round-15 #4): a clearer, actionable stock message —
        // what's left, what's already in the cart, and in what unit.
        reason: `نفدت الكمية — المتاح من ${
          unit != null ? `${product.name} (${unit.unitName})` : product.name
        } هو ${formatQtyForMessage(
          product.stock_quantity - alreadyInCart,
        )} قطعة فقط${alreadyInCart > 0 ? ` (في السلة ${formatQtyForMessage(alreadyInCart)} قطعة)` : ''}`,
      };
    }

    if (existing) {
      const lines = state.lines.map(line =>
        line.key === key
          ? {
              ...line,
              quantity: line.quantity + 1,
              availableStock: untracked
                ? UNTRACKED_STOCK
                : product.stock_quantity,
            }
          : line,
      );
      set({lines});
      saveDraft(lines, state.pricingMode, state.discount);
      return {added: true};
    }
    const lines = [...state.lines, toLine(product, mode, unit)];
    set({lines});
    saveDraft(lines, state.pricingMode, state.discount);
    return {added: true};
  },

  addWeighted: (product, mode, quantity, unit = null) => {
    const state = get();
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return {added: false, reason: 'أدخل وزناً صالحاً أكبر من صفر'};
    }
    const key = lineKey(product.id, unit?.unit_id ?? null);
    const conversion = unit?.conversion ?? 1;
    const existing = state.lines.find(line => line.key === key);
    const used = baseUsed(state.lines);
    const alreadyInCart = used.get(product.id) ?? 0;
    const baseNeeded = quantity * conversion;

    // Floating-point slack: 0.1+0.2 style noise must never block a
    // legitimate sale when the scale shows exactly the remaining kg.
    if (alreadyInCart + baseNeeded > product.stock_quantity + QTY_EPSILON) {
      const available = Math.max(
        0,
        product.stock_quantity - alreadyInCart,
      );
      return {
        added: false,
        // v9.2 (round-15 #4): clearer weight-stock message.
        reason: `نفدت الكمية — المتاح من ${
          unit != null ? `${product.name} (${unit.unitName})` : product.name
        } هو ${formatQtyForMessage(available)} كغ فقط${
          alreadyInCart > 0
            ? ` (في السلة ${formatQtyForMessage(alreadyInCart)} كغ)`
            : ''
        }`,
      };
    }

    if (existing) {
      const lines = state.lines.map(line =>
        line.key === key
          ? {
              ...line,
              quantity: line.quantity + quantity,
              availableStock: product.stock_quantity,
            }
          : line,
      );
      set({lines});
      saveDraft(lines, state.pricingMode, state.discount);
      return {added: true};
    }
    const lines = [
      ...state.lines,
      toWeightLine(product, mode, unit, quantity),
    ];
    set({lines});
    saveDraft(lines, state.pricingMode, state.discount);
    return {added: true};
  },

  // ── v35 (الجولة 43): أسطر المتغيرات — ملابس مفرق / ربطة جملة /
  //    حجم مطعم — الحرس على المتغير أو اللون تحديداً. ────────────
  addVariantLine: (product, mode, variant, quantity) => {
    const state = get();
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return {added: false, reason: 'أدخل كمية صالحة'};
    }
    const key = lineKey(product.id, null, variant.id);
    const existing = state.lines.find(line => line.key === key);
    const usedV = variantUsed(state.lines);
    const alreadyInVariant = usedV.get(variant.id) ?? 0;
    if (
      product.stock_untracked !== 1 &&
      alreadyInVariant + quantity > variant.stock_quantity
    ) {
      return {
        added: false,
        reason: `نفد — المتاح من ${product.name} (${variant.color} · ${variant.size}) ${formatQtyForMessage(
          variant.stock_quantity - alreadyInVariant,
        )} قطعة فقط`,
      };
    }
    if (existing) {
      const lines = state.lines.map(line =>
        line.key === key
          ? {...line, quantity: line.quantity + quantity}
          : line,
      );
      set({lines});
      saveDraft(lines, state.pricingMode, state.discount);
      return {added: true};
    }
    const lines = [
      ...state.lines,
      toVariantLine(product, mode, variant, quantity),
    ];
    set({lines});
    saveDraft(lines, state.pricingMode, state.discount);
    return {added: true};
  },

  addBundleLine: (product, color, bundles) => {
    const state = get();
    if (!Number.isFinite(bundles) || bundles <= 0) {
      return {added: false, reason: 'أدخل عدد ربط صالحاً'};
    }
    const key = lineKey(product.id, -1);
    const existing = state.lines.find(line => line.key === key);
    const colorVariants = (product.variants ?? []).filter(
      v => v.kind === 'variant' && v.color === color,
    );
    if (colorVariants.length === 0) {
      return {added: false, reason: 'لا مقاسات مسجلة لهذا اللون'};
    }
    const minStock = Math.min(
      ...colorVariants.map(v => v.stock_quantity),
    );
    const usedB = bundleUsed(state.lines);
    const alreadyBundles = usedB.get(`${product.id}:${color}`) ?? 0;
    if (alreadyBundles + bundles > minStock) {
      return {
        added: false,
        reason: `الربط المتاحة من لون ${color}: ${formatQtyForMessage(
          Math.max(0, minStock - alreadyBundles),
        )} فقط (أقل مقاس متاح ${formatQtyForMessage(minStock)})`,
      };
    }
    if (existing && existing.bundleColor === color) {
      const lines = state.lines.map(line =>
        line.key === key
          ? {...line, quantity: line.quantity + bundles}
          : line,
      );
      set({lines});
      saveDraft(lines, state.pricingMode, state.discount);
      return {added: true};
    }
    const line = toBundleLine(product, color, bundles);
    const lines = [
      ...state.lines.filter(l => l.key !== key),
      {...line, availableStock: minStock},
    ];
    set({lines});
    saveDraft(lines, state.pricingMode, state.discount);
    return {added: true};
  },

  addSizedLine: (product, sizeVariant, quantity) => {
    const state = get();
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return {added: false, reason: 'أدخل كمية صالحة'};
    }
    const key = lineKey(product.id, null, sizeVariant.id);
    const existing = state.lines.find(line => line.key === key);
    const untracked = product.stock_untracked === 1;
    if (!untracked) {
      const used = baseUsed(state.lines);
      const alreadyInCart = used.get(product.id) ?? 0;
      if (alreadyInCart + quantity > product.stock_quantity) {
        return {
          added: false,
          reason: `المتاح من ${product.name} ${formatQtyForMessage(
            product.stock_quantity - alreadyInCart,
          )} حصة فقط`,
        };
      }
    }
    if (existing) {
      const lines = state.lines.map(line =>
        line.key === key
          ? {...line, quantity: line.quantity + quantity}
          : line,
      );
      set({lines});
      saveDraft(lines, state.pricingMode, state.discount);
      return {added: true};
    }
    const lines = [
      ...state.lines,
      toSizedLine(product, sizeVariant, quantity),
    ];
    set({lines});
    saveDraft(lines, state.pricingMode, state.discount);
    return {added: true};
  },

  setLineUnit: (product, unit) => {
    const state = get();
    const key = lineKey(product.id, unit?.unit_id ?? null);
    const existing = state.lines.find(line => line.key === key);
    const conversion = unit?.conversion ?? 1;
    const used = baseUsed(state.lines);
    const alreadyInCart = used.get(product.id) ?? 0;

    if (existing != null) {
      // Merge: switching to a unit that already exists just keeps it.
      return {ok: true};
    }
    // Replace every line of this product with the new unit line (qty 1).
    const others = state.lines.filter(line => line.productId !== product.id);
    if (
      1 * conversion + alreadyInCart - alreadyInCart >
      product.stock_quantity
    ) {
      return {
        ok: false,
        reason: `الكمية المتاحة هي ${product.stock_quantity} قطعة فقط`,
      };
    }
    if (conversion > product.stock_quantity) {
      return {
        ok: false,
        reason: `واحدة ${
          unit?.unitName ?? ''
        } تحتاج ${conversion} قطعة والمتوفر ${product.stock_quantity}`,
      };
    }
    const lines = [...others, toLine(product, state.pricingMode, unit)];
    set({lines});
    saveDraft(lines, state.pricingMode, state.discount);
    return {ok: true};
  },

  increment: key => {
    const state = get();
    const line = state.lines.find(entry => entry.key === key);
    if (!line) return {ok: false, reason: 'المنتج غير موجود في السلة'};
    // v35 (الجولة 43): حرس المتغير والربطة تحديداً — لا مجموع
    //  الموديل كله (بيع مقاس لا يُحجب بمخزون مقاس آخر).
    if (line.bundleColor != null) {
      const bundlesInCart =
        bundleUsed(state.lines, key).get(`${line.productId}:${line.bundleColor}`) ??
        0;
      if (bundlesInCart + 1 > line.availableStock) {
        return {
          ok: false,
          reason: `الربط المتاحة لهذا اللون ${line.availableStock} فقط`,
        };
      }
    } else if (line.variantId != null) {
      const inVariant =
        variantUsed(state.lines, key).get(line.variantId) ?? 0;
      if (inVariant + line.conversion > line.availableStock) {
        return {
          ok: false,
          reason: `المتاح من هذا المتغير ${line.availableStock} فقط (في السلة: ${inVariant})`,
        };
      }
    } else {
      const used = baseUsed(state.lines, key);
      const alreadyInCart = used.get(line.productId) ?? 0;
      if (alreadyInCart + line.conversion > line.availableStock) {
        return {
          ok: false,
          reason: `الكمية المتاحة هي ${line.availableStock} قطعة فقط (في السلة: ${alreadyInCart})`,
        };
      }
    }
    const lines = state.lines.map(entry =>
      entry.key === key ? {...entry, quantity: entry.quantity + 1} : entry,
    );
    set({lines});
    saveDraft(lines, state.pricingMode, state.discount);
    return {ok: true};
  },

  decrement: key => {
    const state = get();
    const lines = state.lines
      .map(entry =>
        entry.key === key ? {...entry, quantity: entry.quantity - 1} : entry,
      )
      .filter(entry => entry.quantity > 0);
    set({lines});
    saveDraft(lines, state.pricingMode, state.discount);
  },

  removeLine: key => {
    const state = get();
    const lines = state.lines.filter(entry => entry.key !== key);
    set({lines});
    saveDraft(lines, state.pricingMode, state.discount);
  },

  setQuantity: (key, quantity) => {
    const state = get();
    if (quantity <= 0) {
      get().removeLine(key);
      return {ok: true};
    }
    const line = state.lines.find(entry => entry.key === key);
    if (!line) return {ok: false, reason: 'المنتج غير موجود في السلة'};
    // v35 (الجولة 43): حرس المتغير والربطة تحديداً أيضاً هنا.
    if (line.bundleColor != null) {
      const bundlesInCart =
        bundleUsed(state.lines, key).get(`${line.productId}:${line.bundleColor}`) ??
        0;
      if (quantity > line.availableStock) {
        return {
          ok: false,
          reason: `الربط المتاحة لهذا اللون ${line.availableStock} فقط`,
        };
      }
    } else if (line.variantId != null) {
      const inVariant =
        variantUsed(state.lines, key).get(line.variantId) ?? 0;
      if (inVariant - line.quantity + quantity > line.availableStock) {
        return {
          ok: false,
          reason: `المتاح من هذا المتغير ${line.availableStock} فقط`,
        };
      }
    } else {
      const used = baseUsed(state.lines, key);
      const alreadyInCart = used.get(line.productId) ?? 0;
      if (
        alreadyInCart + quantity * line.conversion >
        line.availableStock
      ) {
        return {
          ok: false,
          reason: `الكمية المتاحة هي ${line.availableStock} قطعة فقط (في السلة: ${alreadyInCart})`,
        };
      }
    }
    const lines = state.lines.map(entry =>
      entry.key === key ? {...entry, quantity} : entry,
    );
    set({lines});
    saveDraft(lines, state.pricingMode, state.discount);
    return {ok: true};
  },

  setDiscount: discount => {
    const state = get();
    const safe = Math.max(0, Number.isFinite(discount) ? discount : 0);
    set({discount: safe});
    saveDraft(state.lines, state.pricingMode, safe);
  },

  setPricingMode: mode => {
    const state = get();
    // Re-price every line from its stored unit snapshots.
    const lines = state.lines.map(line => ({
      ...line,
      unitPrice: mode === 'WHOLESALE' ? line.wholesalePrice : line.retailPrice,
    }));
    set({pricingMode: mode, lines});
    saveDraft(lines, mode, state.discount);
  },

  clear: () => {
    set({lines: [], discount: 0});
    saveDraft([], useCartStore.getState().pricingMode, 0);
    try {
      storage.delete(KEYS.cartDraft);
    } catch {
      // Best effort cleanup only.
    }
  },

  clearDiscount: () => {
    const state = get();
    set({discount: 0});
    saveDraft(state.lines, state.pricingMode, 0);
  },
}));

/** Derived totals (pure functions so components stay cheap). */
export function cartTotals(lines: CartLine[], discount: number) {
  const subtotal = lines.reduce(
    (sum, line) => sum + line.unitPrice * line.quantity,
    0,
  );
  const totalCost = lines.reduce(
    (sum, line) => sum + line.costPrice * line.quantity,
    0,
  );
  const safeDiscount = Math.min(Math.max(discount, 0), subtotal);
  const total = subtotal - safeDiscount;
  return {
    subtotal,
    totalCost,
    safeDiscount,
    total,
    profit: total - totalCost,
    itemsCount: lines.reduce((sum, line) => sum + line.quantity, 0),
    baseItemsCount: lines.reduce(
      (sum, line) => sum + line.quantity * line.conversion,
      0,
    ),
  };
}
