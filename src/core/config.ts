/**
 * Global tunables for the vision pipeline and the POS behaviour.
 */

/** Required input resolution of the bundled MobileNetV3-Small embedder. */
export const MODEL_INPUT_SIZE = 224;

/**
 * Pixel normalization used for BOTH enrollment and recognition, so any
 * fixed monotone transform stays consistent and matching accuracy is
 * unaffected. MediaPipe float32 models expect [-1, 1]:
 * value = (pixel - 127.5) / 127.5
 */
export const NORM_MEAN = 127.5;
export const NORM_STD = 127.5;

/** Default cosine similarity threshold (spec: 82%). */
export const DEFAULT_MATCH_THRESHOLD = 0.82;

/** Minimum time between two auto-adds of the SAME product (ms). */
export const DEFAULT_RECOGNITION_COOLDOWN_MS = 1500;

/** Pause between auto-scan cycles in the POS camera sheet (ms). */
export const AUTO_SCAN_INTERVAL_MS = 650;

/** Embedding JSON serialization precision (float decimals). */
export const EMBEDDING_DECIMALS = 6;

/** Enrollment angles (3 vectors per product, per spec). */
export const ANGLE_LABELS = ['front', 'back', 'side'] as const;

export const ANGLE_LABELS_AR: Record<string, string> = {
  front: 'أمامية',
  back: 'خلفية',
  side: 'جانبية',
};

/** Default low-stock alert threshold when a product has no override. */
export const DEFAULT_LOW_STOCK_THRESHOLD = 5;

/** Receipt paper widths in characters (default font). */
export const RECEIPT_WIDTH_58 = 32;
export const RECEIPT_WIDTH_80 = 48;

/** Default ESC/POS codepage: 47 = Windows-1256 Arabic. */
export const CODEPAGE_CP1256 = 47;
export const CODEPAGE_CP864 = 45;
export const CODEPAGE_ASCII = 0;

/** Currency suffix used across the app. */
export const CURRENCY = '₪';

/** SQLite file name. */
export const DB_NAME = 'sela.db';

/** Schema version — bump + add a migration branch when changing DDL. */
export const DB_SCHEMA_VERSION = 2;

/** App display name used on receipts & About page. */
export const APP_NAME = 'سيلا';
export const APP_NAME_EN = 'Sela';

/** App version shown in Settings → About. */
export const APP_VERSION = '2.0.0';
