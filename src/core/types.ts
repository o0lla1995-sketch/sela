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

/** v9.2 (round-15 #3): a unit's TYPE — units are categorized so
 *  weight products get weight units (كيلو، وقية، رطل…) and piece
 *  products get packaging units (كرتونة، علبة…): the merchant sees
 *  exactly the units that suit how the product is sold. */
export type UnitKind = 'piece' | 'weight' | 'volume' | 'length';

/** A user-defined sellable unit (قطعة، كرتونة، كيلو…). */
export interface Unit {
  id: number;
  name: string;
  short_name: string;
  sort_order: number;
  /** v9.2: the unit type — defaults to 'piece' on old rows. */
  kind: UnitKind;
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
  /** v23 (round-29 #1): 1 = ARCHIVED — hidden from POS/inventory/
   *  alerts but kept for invoice history, reports and returns. */
  is_archived: number;
  /** v32 (round-40 #3): تاريخ انتهاء الصلاحية 'YYYY-MM-DD' (اختياري)
   *  — يُغذّي تحذيرات «قرب الانتهاء/منتهي» في تنبيهات المخزون
   *  والإشعارات. */
  expiry_date: string | null;
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

/** v32 (round-40 #3): حالة الصلاحية — منتهي / قرب الانتهاء / سليم. */
export type ExpiryState = 'expired' | 'expiring' | 'ok';

/** v32: كم يوماً بقي حتى تاريخ الانتهاء؟ (سالب = انتهى منذ N يوماً) */
export function daysUntilExpiry(expiryDate: string): number {
  const target = new Date(`${expiryDate}T00:00:00`);
  if (Number.isNaN(target.getTime())) {
    return Number.POSITIVE_INFINITY;
  }
  const today = new Date();
  const start = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  );
  return Math.round((target.getTime() - start.getTime()) / 86_400_000);
}

/** v32: حالة الصلاحية من تاريخ الانتهاء ونافذة التنبيه (بالأيام). */
export function expiryStateOf(
  expiryDate: string | null | undefined,
  alertDays: number,
): ExpiryState {
  if (expiryDate == null || expiryDate.length < 10) {
    return 'ok';
  }
  const days = daysUntilExpiry(expiryDate);
  if (days < 0) {
    return 'expired';
  }
  return days <= alertDays ? 'expiring' : 'ok';
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
  /** v23 (round-29 #2): cumulative value (agora) returned against
   *  THIS invoice — «مرتجع» badge + remaining-value math. */
  returned_minor?: number;
  /** v23 (round-29 #2): set only on RET-… rows — which book the
   *  return reverses ('cash' | 'sila' | 'local'). */
  return_kind?: 'cash' | 'sila' | 'local' | null;
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

// ────────────────────────────────────────────────────────────────
// Returns (المرتجعات) — v23 (round-29 #2)
// ────────────────────────────────────────────────────────────────

/** Which book a return reverses — decides the debt adjustment path. */
export type ReturnBook = 'cash' | 'sila' | 'local';

/** One return receipt (RET-… series) against an original invoice. */
export interface SaleReturnRecord {
  id: number;
  return_number: string;
  sale_id: number;
  invoice_ref: string;
  book: ReturnBook;
  refund_method: 'none' | 'cash';
  /** Value of the returned goods, minor units. */
  refund_minor: number;
  /** The part that reduced a DEBT book (sila queue / local row). */
  debt_adjusted_minor: number;
  note: string | null;
  created_at: string;
}

/** A returned line — snapshot kept even if the product is later
 *  archived (name + prices live on the row itself). */
export interface SaleReturnItem {
  id: number;
  return_id: number;
  /** The ORIGINAL sale_items row this line returns. */
  sale_item_id: number;
  product_id: number;
  product_name: string;
  quantity: number;
  unit_name: string | null;
  base_quantity: number;
  unit_price: number;
  line_total: number;
  cost_price: number;
}

/** A return in progress (the ReturnSheet's payload). */
export interface ReturnLineInput {
  saleItemId: number;
  productId: number;
  productName: string;
  quantity: number;
  unitName: string | null;
  /** Base units per 1 sold unit (conversion at sale time). */
  basePerUnit: number;
  unitPrice: number;
  costPrice: number;
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
  /** v30 (round-38 #2): the product's barcode — scan-to-search in
   *  the counting screen matches it exactly (same contract as the
   *  inventory search). */
  barcode: string | null;
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
  // v15 (round-21 #2): the WHOLE history — restored-backup invoices
  // and old sales are part of the store's accounting too.
  | 'all'
  | 'custom';

export interface DateRange {
  /** Inclusive, 'YYYY-MM-DD'. */
  from: string;
  /** Inclusive, 'YYYY-MM-DD'. */
  to: string;
}

export interface ReportSummary {
  /** NET figures: returned goods (RET rows, negative) net out
   *  automatically — revenue here is sales minus returns. */
  revenue: number;
  cogs: number;
  netProfit: number;
  /** v23: REAL invoices only (return receipts excluded). */
  invoicesCount: number;
  itemsCount: number;
  discountTotal: number;
  avgInvoice: number;
  /** v23 (round-29 #2): the period's returns — count + refunded
   *  value, displayed as their own «المرتجعات» line. */
  returnsCount: number;
  returnsTotal: number;
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
  /** v32 (round-40 #3): صلاحية المنتج — منتهي أو قارب الانتهاء. */
  | 'expiry'
  | 'info'
  | 'printer'
  | 'sale'
  | 'stocktake'
  /** v11: a SILA debt record failed permanently and needs the
   *  merchant's attention (expired code, duplicate invoice…). */
  | 'sila_debt'
  /** v15 (round-21 #3): a repayment upload failed permanently
   *  (NO_DEBT_RELATIONSHIP…). */
  | 'sila_payment'
  /** v18 (round-24 #1): صِلة collected money on the store's behalf
   *  (customer repaid through the Sila app) — the books now show it
   *  as an incoming collection instead of a vanishing debt. */
  | 'sila_collection'
  /** v20: a voucher redemption resolved (completed after a network
   *  cut, or permanently failed) — the cashier must know either way
   *  before handing goods. */
  | 'sila_voucher'
  /** v20: a campaign settlement arrived / a campaign was fully
   *  settled (المؤسسة سدّدت حقك). */
  | 'sila_campaign';

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

// ────────────────────────────────────────────────────────────────
// SILA — الدين الفلسطيني (v11, SILA_POS_API v1.1)
// ────────────────────────────────────────────────────────────────

/** What the scanned customer QR turned out to be (§4-5). */
export type SilaQrKind = 'card' | 'offline' | 'online' | 'pair' | 'unknown';

/** Parsed `sila-card:v1` — identity card, no amount (§5). */
export interface SilaCardPayload {
  kind: 'card';
  cid: string;
  name: string;
  phone: string;
  exp: number;
  /** The complete raw JWS string — replayed to the server verbatim. */
  raw: string;
}

/** Parsed `sila-offline-qr` — customer-signed amount (§3.1). */
export interface SilaOfflinePayload {
  kind: 'offline';
  cid: string;
  amountMinor: number;
  currency: string;
  description: string;
  exp: number;
  raw: string;
}

/** An opaque online-session token — unreadable without the server. */
export interface SilaOnlinePayload {
  kind: 'online';
  raw: string;
}

/** A `sila-pair:XXXX-XXXX` merchant pairing code (§6.1). */
export interface SilaPairPayload {
  kind: 'pair';
  code: string;
  raw: string;
}

export type SilaQrPayload =
  | SilaCardPayload
  | SilaOfflinePayload
  | SilaOnlinePayload
  | SilaPairPayload
  | {kind: 'unknown'; raw: string};

/** Persisted merchant pairing (MMKV — SILA_POS_API §7 pos_settings). */
export interface SilaPairing {
  posToken: string;
  deviceId: string;
  merchantOrgId: string;
  merchantName: string;
  /** ISO date — pos_token lives 180 days (§6.1). */
  tokenExpiresAt: string;
  pairedAt: string;
  apiBaseUrl: string;
}

/** One row of the local debt queue (sila_debt_queue §7). */
export interface SilaDebtRow {
  local_id: number;
  idempotency_key: string;
  customer_id: string | null;
  customer_name: string | null;
  customer_phone_last4: string | null;
  customer_card: string | null;
  offline_qr: string | null;
  amount_minor: number;
  currency: string;
  pos_invoice_ref: string;
  description: string | null;
  scanned_at: string;
  state: 'pending' | 'syncing' | 'synced' | 'failed';
  reference_code: string | null;
  transaction_id: string | null;
  outstanding_after: number | null;
  /** v17 (round-23 #3): how much of this debt the customer's
   *  PREPAID credit absorbed — estimated at sale time from the
   *  cached balance, reconciled to the server's exact
   *  credit_consumed_minor after the row syncs. amount_minor −
   *  credit_covered_minor = the NET new debt this invoice added. */
  credit_covered_minor: number;
  synced_at: string | null;
  error_code: string | null;
  error_message: string | null;
  retry_count: number;
  created_at: string;
}

/** Cached SILA customer balance (sila_customers §7). */
export interface SilaCustomer {
  customer_id: string;
  name: string;
  phone_last4: string | null;
  id_number: string | null;
  /** v17 (round-23 #3): الرصيد المسبق المدفوع مقدماً في صِلة — يغطّي
   *  فواتير الدين تلقائياً (يستهلكه الخادم عند رفع الدين)، فالمتجر
   *  يعرف وقت البيع أن الفاتورة مسددة كلياً أو جزئياً. */
  credit_minor: number;
  /** الرصيد الرسمي الكلي كما يقوله خادم صِلة (POS + تطبيق + تعديلات). */
  outstanding_minor: number;
  /** v15 (§2.4): جزء الرصيد الذي نشأ من فواتير هذا المتجر (FIFO). */
  pos_outstanding_minor: number;
  /** v15: جزء الرصيد الذي نشأ من تطبيق صِلة (FIFO). */
  app_outstanding_minor: number;
  /** v15: تعديلات يدوية/فروقات من لوحة التاجر. */
  other_minor: number;
  pos_purchases_minor: number;
  app_purchases_minor: number;
  last_payment_at: string | null;
  last_payment_amount_minor: number | null;
  last_synced_at: string | null;
}

/** v15 (round-21 #3): a cashier-received repayment queued for upload
 *  to /api/pos/payments — one idempotency key per receipt (§3.1). */
export interface SilaPaymentRow {
  local_id: number;
  idempotency_key: string;
  customer_id: string | null;
  customer_name: string | null;
  customer_phone_last4: string | null;
  amount_minor: number;
  payment_method: string;
  pos_receipt_ref: string;
  description: string | null;
  paid_at: string;
  state: 'pending' | 'syncing' | 'synced' | 'failed';
  /** v23 (round-29 #2): 'repayment' (سداد نقدي فعلي — counts in
   *  collections) vs 'return_reversal' (العملية العكسية لمرتجع
   *  بضاعة على دين مرفوع للخادم — reduces the debt on the صلة
   *  server but NEVER counts as collected cash). */
  kind: 'repayment' | 'return_reversal';
  reference_code: string | null;
  transaction_id: string | null;
  outstanding_after: number | null;
  synced_at: string | null;
  error_code: string | null;
  error_message: string | null;
  retry_count: number;
  created_at: string;
}

/** v16 (round-22 #4): a STORE-LOCAL debt account — a customer of
 *  THIS store recorded with ID number / name / phone, whose debts
 *  live ONLY in the store's books (never uploaded to صِلة unless the
 *  merchant later migrates them). Separate from sila customers by
 *  design; the ID number is the cross-system dedupe key. */
export interface LocalCustomer {
  id: number;
  id_number: string;
  name: string;
  phone: string | null;
  notes: string | null;
  /** صِلة cid once this person is linked to a صِلة account (scan of
   *  their QR) — enables the migration path and the dedupe guard. */
  sila_customer_id: string | null;
  sila_linked_at: string | null;
  created_at: string;
}

/** v16 (round-22 #4): a debt recorded on a local customer (INV-L
 *  series — locally only; migrated rows carry the صِلة reference
 *  they were re-registered under). */
export interface LocalDebt {
  id: number;
  local_customer_id: number;
  invoice_ref: string;
  amount_minor: number;
  description: string | null;
  /** 1 once this debt was re-registered in صِلة via the migration
   *  (ترحيل الديون إلى صِلة). */
  migrated: number;
  migrated_ref: string | null;
  created_at: string;
}

/** v16 (round-22 #4): a repayment received from a local customer
 *  (RCP-L series — reduces the local balance; never uploaded). */
export interface LocalPayment {
  id: number;
  local_customer_id: number;
  receipt_ref: string;
  amount_minor: number;
  method: 'cash' | 'card' | 'other';
  note: string | null;
  created_at: string;
}

/** Derived per-customer balance for the local debt book. */
export interface LocalCustomerBalance {
  customer: LocalCustomer;
  debtTotalMinor: number;
  paidTotalMinor: number;
  outstandingMinor: number;
  debtsCount: number;
  lastActivityAt: string | null;
}

// ────────────────────────────────────────────────────────────────
// v20: القسائم الشرائية للحملات (SILA_POS_VOUCHERS_API v1.0).
// The campaign-as-virtual-customer architecture: every campaign the
// merchant joined is a DEBTOR in the store's books (the institution
// owes the store for every redeemed voucher) — mirrored EXACTLY
// from the server, never computed locally (§2/§5).
// ────────────────────────────────────────────────────────────────

/** One redemption attempt (voucher_redemptions §5) — the row is
 *  created AT REDEEM TIME with ONE idempotency_key that never
 *  changes; retries replay the same key (§5 rule 1: صرف القسيمة
 *  يتطلب اتصالاً حياً — ليس طابور أوفلاين). */
export interface VoucherRedemptionRow {
  local_id: number;
  idempotency_key: string;
  /** The scanned QR payload (SILAV1|…) or the manual 20-char code,
   *  stored verbatim for retries. */
  payload: string;
  campaign_id: string | null;
  campaign_name: string | null;
  /** voucher | parcel (kind from the server answer). */
  campaign_kind: 'voucher' | 'parcel' | null;
  voucher_id: string | null;
  value_minor: number;
  pos_receipt_ref: string | null;
  reference_code: string | null;
  beneficiary_last4: string | null;
  redeemed_at: string;
  state: 'pending' | 'ok' | 'failed';
  /** v20: the cart snapshot (JSON) taken when a cart-tied redemption
   *  started — lets the sync engine finish the INV-V sale if the
   *  app died between the server's ok and the local sale commit. */
  cart_json: string | null;
  /** v20: the created sale row (INV-V) once the redemption is ok —
   *  the invoices center / reprints join through this. */
  sale_id: number | null;
  /** v20: cash the beneficiary paid at the counter when the cart
   *  exceeded the voucher (cart − voucher, ≥ 0) — part of the
   *  treasury's expected cash from day one. */
  counter_extra_minor: number;
  error_code: string | null;
  error_message: string | null;
  retry_count: number;
  synced_at: string | null;
  created_at: string;
}

/** A campaign claim in the store's ledger (campaign_debts §5) —
 *  the institution owes the store redeemed_value − settled. EVERY
 *  figure here is the SERVER's truth (the settlement snapshot of
 *  the redeem answer + the settlements sync loop); the POS never
 *  sums or subtracts on its own (§5 rule 3). */
export interface CampaignDebtRow {
  campaign_id: string;
  campaign_name: string;
  kind: 'voucher' | 'parcel';
  campaign_status: string | null;
  merchant_status: string | null;
  starts_at: string | null;
  ends_at: string | null;
  redeemed_count: number;
  redeemed_value_minor: number;
  settled_minor: number;
  settled_pending_minor: number;
  settled_confirmed_minor: number;
  due_minor: number;
  settlement_state: 'none' | 'partial' | 'full';
  last_redemption_at: string | null;
  last_settlement_at: string | null;
  updated_at: string | null;
  /** v22 (round-28 #4): the campaign lifecycle in this store —
   *  'available' → 'active' → 'completed', one-way only:
   *  no double activation (an active campaign can't be activated
   *  again), no deactivation (the old v13 switch is gone) — an
   *  active campaign can only be marked COMPLETED, and a completed
   *  campaign keeps its data and its standing dues in the books
   *  exactly as they were. The state survives feed re-syncs, Sila
   *  unlink/relink and backup restore untouched. */
  store_state: CampaignStoreState;
}

/** v22 (round-28 #4): the in-store campaign lifecycle states. */
export type CampaignStoreState = 'available' | 'active' | 'completed';

/** v20: one institution settlement mirrored from the server's
 *  settlements[] feed (§4.2) — the period reports read these rows
 *  («تحصيلات الحملات بالفترة»); only status='confirmed' counts as
 *  money actually received (pending = the merchant hasn't confirmed
 *  receipt in the Sila app yet). */
export interface CampaignSettlementRow {
  settlement_id: string;
  campaign_id: string;
  campaign_name: string | null;
  amount_minor: number;
  /** compensation (تعويض) | advance (دفعة مقدمة). */
  kind: string;
  status: 'pending' | 'confirmed' | 'disputed' | 'cancelled';
  method: string | null;
  reference: string | null;
  created_at: string;
}

/** Derives the stock state for a product given the global default threshold. */
export function stockStateOf(
  product: Pick<Product, 'stock_quantity' | 'low_stock_threshold'>,
  defaultThreshold: number,
): StockState {
  if (product.stock_quantity <= 0) {
    return 'out';
  }
  const threshold = product.low_stock_threshold ?? defaultThreshold;
  return product.stock_quantity <= threshold ? 'low' : 'ok';
}

// ────────────────────────────────────────────────────────────────
// v25 (round-32 #3): نظام المصروفات والسحب من الخزينة — the cash
// movements ledger (Loyverse/Square cash-drawer discipline). Every
// shekel that leaves or enters the drawer outside a sale carries a
// numbered reference, a kind, a category and the authorization
// method used at entry time. Rows are IMMUTABLE (audit trail).
// ────────────────────────────────────────────────────────────────

export type CashMovementKind = 'expense' | 'withdrawal' | 'deposit';

/** How the (secured) action was authorized when it was recorded. */
export type CashAuthMethod = 'fingerprint' | 'pin' | 'none';

export interface CashMovementRecord {
  local_id: number;
  /** EXP-000001 | WD-000001 | DEP-000001 — its own daily series. */
  ref: string;
  kind: CashMovementKind;
  category: string;
  note: string | null;
  amount_minor: number;
  auth_method: CashAuthMethod;
  created_at: string;
}

/** Period totals for the statement + the reports section. */
export interface CashMovementTotals {
  expensesMinor: number;
  withdrawalsMinor: number;
  depositsMinor: number;
  expensesCount: number;
  withdrawalsCount: number;
  depositsCount: number;
  /** +deposits − expenses − withdrawals (minor). */
  netMinor: number;
}

/** Category breakdown row for the PDF statement. */
export interface CashCategoryTotal {
  category: string;
  count: number;
  totalMinor: number;
}
