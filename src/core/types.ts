/**
 * Domain types shared across the whole application.
 */

export type PricingMode = 'RETAIL' | 'WHOLESALE';

export interface Category {
  id: number;
  name: string;
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
}

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
  productId: number;
  name: string;
  /** Unit price used for this sale (depends on pricing mode). */
  unitPrice: number;
  /** Cost price snapshot at add-time (for profit accounting). */
  costPrice: number;
  /** Retail & wholesale prices snapshot so mode switching can re-price. */
  retailPrice: number;
  wholesalePrice: number;
  quantity: number;
  /** Stock snapshot shown in the stepper to block overselling. */
  availableStock: number;
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
}

export interface SaleWithItems {
  sale: SaleRecord;
  items: SaleItemRecord[];
}

export type ReportRangeKey = 'today' | 'yesterday' | 'last7' | 'thisMonth' | 'custom';

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
