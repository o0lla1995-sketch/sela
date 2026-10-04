/**
 * Domain types shared across the whole application.
 */

export type PricingMode = 'RETAIL' | 'WHOLESALE';

export interface Category {
  id: number;
  name: string;
  /** Product count (only populated in management listings). */
  productCount?: number;
}

/** A user-defined sellable unit (قطعة، كرتونة، كيلو…). */
export interface Unit {
  id: number;
  name: string;
  short_name: string;
  sort_order: number;
}

/** A unit attached to a product with its conversion + price overrides. */
export interface ProductUnit {
  id: number;
  product_id: number;
  unit_id: number;
  unitName: string;
  unitShort: string;
  /** Base-unit pieces per 1 of this unit (e.g. 1 كرتونة = 24 قطعة). */
  conversion: number;
  /** Optional per-unit barcode for scanning a whole carton. */
  barcode: string | null;
  /** Price overrides — null means derive from the product base price. */
  retail_price: number | null;
  wholesale_price: number | null;
}

export interface Product {
  id: number;
  name: string;
  cost_price: number;
  retail_price: number;
  wholesale_price: number;
  stock_quantity: number;
  category_id: number | null;
  image_uri: string | null;
  created_at: string;
  /** Per-product low-stock alert override (NULL → global default). */
  low_stock_threshold: number | null;
  /** Product (base-unit) barcode, scanned at the POS. */
  barcode: string | null;
  /** v8.3 (round-12 #4): 1 = sold BY WEIGHT — the base unit is the
   *  kilogram: prices are per-kilo, stock is fractional kg and the
   *  POS opens a weight pad instead of adding whole pieces. */
  sold_by_weight: number;
  /** Unit rows loaded on demand (ProductForm / POS unit picker). */
  units?: ProductUnit[];
}

/** v8.3: is this product sold by weight (kilo-based)? */
export function isWeightProduct(
  product: Pick<Product, 'sold_by_weight'>,
): boolean {
  return product.sold_by_weight === 1;
}

/** v8.3: the base-unit label for a product ('كغ' for weight products,
 *  the global BASE_UNIT_NAME otherwise). */
export function baseUnitLabelOf(
  product: Pick<Product, 'sold_by_weight'>,
  baseName: string,
): string {
  return isWeightProduct(product) ? 'كغ' : baseName;
}

/** Stock state derived from quantity vs threshold. */
export type StockState = 'out' | 'low' | 'ok';

export type AngleLabel = 'front' | 'back' | 'side';

export interface ProductEmbedding {
  id: number;
  product_id: number;
  embedding_data: string;
  angle_label: AngleLabel | string | null;
}

/** Parsed embedding row with the vector decoded from JSON. */
export interface DecodedEmbedding {
  productId: number;
  angle: AngleLabel | string;
  vector: Float32Array;
}

/** Compact in-memory index handed to the vision worklet. */
export interface EmbeddingsIndex {
  /** Product id for every row-block inside `flat`. */
  ids: number[];
  /** All embedding vectors concatenated (row-major). */
  flat: Float32Array;
  /** Dimension of a single embedding vector. */
  dim: number;
}

export interface CartLine {
  /** Stable key: productId + unitId ('' for base unit). */
  key: string;
  productId: number;
  name: string;
  /** Unit price used for this sale (depends on pricing mode + unit). */
  unitPrice: number;
  /** Cost price snapshot at add-time (for profit accounting). */
  costPrice: number;
  /** Retail & wholesale prices snapshot so mode switching can re-price. */
  retailPrice: number;
  wholesalePrice: number;
  /** Quantity in the chosen unit (not base pieces). */
  quantity: number;
  /** Stock snapshot shown in the stepper to block overselling. */
  availableStock: number;
  /** Chosen unit id — null/0 = base unit (قطعة). */
  unitId: number | null;
  /** Display name of the chosen unit. */
  unitName: string;
  /** Base pieces per 1 unit (1 for the base unit). */
  conversion: number;
  /** v8.3: true for weight-sold products — quantity is fractional kg. */
  byWeight?: boolean;
}

export interface SaleRecord {
  id: number;
  invoice_number: string;
  total_amount: number;
  total_cost: number;
  total_profit: number;
  discount: number;
  payment_type: PricingMode;
  created_at: string;
}

export interface SaleItemRecord {
  id: number;
  sale_id: number;
  product_id: number;
  quantity: number;
  unit_price: number;
  cost_price: number;
  total_line_price: number;
  /** Unit display name at sale time (e.g. كرتونة). */
  unit_name: string | null;
  /** Base pieces actually deducted from stock. */
  base_quantity: number | null;
}

export interface SaleWithItems {
  sale: SaleRecord;
  items: SaleItemRecord[];
}

// ────────────────────────────────────────────────────────────────
// Stocktake (الجرد)
// ────────────────────────────────────────────────────────────────

export interface Stocktake {
  id: number;
  started_at: string;
  completed_at: string | null;
  status: 'open' | 'completed';
  note: string | null;
}

export interface StocktakeItem {
  id: number;
  stocktake_id: number;
  product_id: number;
  productName: string;
  categoryId: number | null;
  system_qty: number;
  counted_qty: number | null;
  unitHint: string | null;
  /** v8.3: 1 = weight product — the count input allows decimals (kg). */
  soldByWeight: number;
}

export interface StocktakeSummary {
  totalItems: number;
  countedItems: number;
  matchedItems: number;
  shortageItems: number;
  surplusItems: number;
  totalSystem: number;
  totalCounted: number;
}

export type ReportRangeKey =
  | 'today'
  | 'yesterday'
  | 'last7'
  | 'thisMonth'
  | 'custom';

export interface DateRange {
  /** Inclusive, 'YYYY-MM-DD'. */
  from: string;
  /** Inclusive, 'YYYY-MM-DD'. */
  to: string;
}

export interface ReportSummary {
  revenue: number;
  cogs: number;
  netProfit: number;
  invoicesCount: number;
  itemsCount: number;
  discountTotal: number;
  avgInvoice: number;
}

export interface TopProduct {
  productId: number;
  name: string;
  quantity: number;
  revenue: number;
  profit: number;
}

export interface DailyPoint {
  day: string; // 'YYYY-MM-DD'
  label: string; // short day name
  revenue: number;
  profit: number;
}

export interface HourlyPoint {
  hour: number;
  revenue: number;
  orders: number;
}

/** Printer device as reported by the native Bluetooth stack. */
export interface PrinterDevice {
  name: string;
  address: string;
  bondState: number;
}

/** Full vision model metadata surfaced in diagnostics. */
export interface VisionModelInfo {
  loaded: boolean;
  inputSize: number;
  channelsLast: boolean;
  embeddingDim: number;
  inputName: string;
  outputName: string;
  loadError: string | null;
}

// ────────────────────────────────────────────────────────────────
// Notifications (in-app center + Android local notifications)
// ────────────────────────────────────────────────────────────────

export type NotificationKind =
  | 'out_of_stock'
  | 'low_stock'
  | 'info'
  | 'printer'
  | 'sale'
  | 'stocktake';

export interface AppNotification {
  /** Stable id (timestamp-based). */
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  /** 'YYYY-MM-DD HH:MM:SS' local. */
  createdAt: string;
  read: boolean;
  /** Optional product reference for deep-navigation. */
  productId?: number;
}

/** Derives the stock state for a product given the global default threshold. */
export function stockStateOf(
  product: Pick<Product, 'stock_quantity' | 'low_stock_threshold'>,
  defaultThreshold: number,
): StockState {
  if (product.stock_quantity <= 0) return 'out';
  const threshold = product.low_stock_threshold ?? defaultThreshold;
  return product.stock_quantity <= threshold ? 'low' : 'ok';
}
