/**
 * Cart store — the live checkout state.
 * ─────────────────────────────────────────────────────────────────
 * Lines keep a price snapshot (retail + wholesale + cost) so the
 * مفرق/جملة switch re-prices instantly without a DB round-trip.
 * A draft is persisted to MMKV so an accidental app kill never loses
 * an in-progress sale.
 */
import {create} from 'zustand';
import {getJson, setJson, KEYS, storage} from '../storage/storage';
import type {CartLine, PricingMode, Product} from '../core/types';

interface CartState {
  lines: CartLine[];
  pricingMode: PricingMode;
  discount: number;
  addProduct: (product: Product, mode: PricingMode) => {added: boolean; reason?: string};
  increment: (productId: number) => {ok: boolean; reason?: string};
  decrement: (productId: number) => void;
  removeLine: (productId: number) => void;
  setQuantity: (productId: number, quantity: number) => {ok: boolean; reason?: string};
  setDiscount: (discount: number) => void;
  setPricingMode: (mode: PricingMode) => void;
  clear: () => void;
  clearDiscount: () => void;
}

function priceFor(product: Product, mode: PricingMode): number {
  return mode === 'WHOLESALE' ? product.wholesale_price : product.retail_price;
}

function toLine(product: Product, mode: PricingMode): CartLine {
  return {
    productId: product.id,
    name: product.name,
    unitPrice: priceFor(product, mode),
    costPrice: product.cost_price,
    retailPrice: product.retail_price,
    wholesalePrice: product.wholesale_price,
    quantity: 1,
    availableStock: product.stock_quantity,
  };
}

interface DraftSnapshot {
  lines: CartLine[];
  pricingMode: PricingMode;
  discount: number;
}

function loadDraft(): DraftSnapshot {
  const draft = getJson<DraftSnapshot | null>(KEYS.cartDraft, null);
  if (draft && Array.isArray(draft.lines)) {
    return {
      lines: draft.lines,
      pricingMode: draft.pricingMode === 'WHOLESALE' ? 'WHOLESALE' : 'RETAIL',
      discount: Number(draft.discount) || 0,
    };
  }
  return {lines: [], pricingMode: 'RETAIL', discount: 0};
}

function saveDraft(lines: CartLine[], pricingMode: PricingMode, discount: number): void {
  setJson(KEYS.cartDraft, {lines, pricingMode, discount} satisfies DraftSnapshot);
}

export const useCartStore = create<CartState>((set, get) => ({
  ...loadDraft(),

  addProduct: (product, mode) => {
    const state = get();
    const existing = state.lines.find(line => line.productId === product.id);
    if (existing) {
      if (existing.quantity >= product.stock_quantity) {
        return {added: false, reason: `الكمية المتاحة من ${product.name} هي ${product.stock_quantity} فقط`};
      }
      const lines = state.lines.map(line =>
        line.productId === product.id
          ? {
              ...line,
              quantity: line.quantity + 1,
              availableStock: product.stock_quantity,
            }
          : line,
      );
      set({lines});
      saveDraft(lines, state.pricingMode, state.discount);
      return {added: true};
    }
    if (product.stock_quantity <= 0) {
      return {added: false, reason: `${product.name} غير متوفر في المخزون`};
    }
    const lines = [...state.lines, toLine(product, mode)];
    set({lines});
    saveDraft(lines, state.pricingMode, state.discount);
    return {added: true};
  },

  increment: productId => {
    const state = get();
    const line = state.lines.find(entry => entry.productId === productId);
    if (!line) return {ok: false, reason: 'المنتج غير موجود في السلة'};
    if (line.quantity >= line.availableStock) {
      return {ok: false, reason: `الكمية المتاحة هي ${line.availableStock} فقط`};
    }
    const lines = state.lines.map(entry =>
      entry.productId === productId
        ? {...entry, quantity: entry.quantity + 1}
        : entry,
    );
    set({lines});
    saveDraft(lines, state.pricingMode, state.discount);
    return {ok: true};
  },

  decrement: productId => {
    const state = get();
    const lines = state.lines
      .map(entry =>
        entry.productId === productId
          ? {...entry, quantity: entry.quantity - 1}
          : entry,
      )
      .filter(entry => entry.quantity > 0);
    set({lines});
    saveDraft(lines, state.pricingMode, state.discount);
  },

  removeLine: productId => {
    const state = get();
    const lines = state.lines.filter(entry => entry.productId !== productId);
    set({lines});
    saveDraft(lines, state.pricingMode, state.discount);
  },

  setQuantity: (productId, quantity) => {
    const state = get();
    if (quantity <= 0) {
      get().removeLine(productId);
      return {ok: true};
    }
    const line = state.lines.find(entry => entry.productId === productId);
    if (!line) return {ok: false, reason: 'المنتج غير موجود في السلة'};
    if (quantity > line.availableStock) {
      return {ok: false, reason: `الكمية المتاحة هي ${line.availableStock} فقط`};
    }
    const lines = state.lines.map(entry =>
      entry.productId === productId ? {...entry, quantity} : entry,
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
    // Re-price every line from its stored snapshots.
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
  const subtotal = lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);
  const totalCost = lines.reduce((sum, line) => sum + line.costPrice * line.quantity, 0);
  const safeDiscount = Math.min(Math.max(discount, 0), subtotal);
  const total = subtotal - safeDiscount;
  return {
    subtotal,
    totalCost,
    safeDiscount,
    total,
    profit: total - totalCost,
    itemsCount: lines.reduce((sum, line) => sum + line.quantity, 0),
  };
}
