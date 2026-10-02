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

/** How often frames are actually processed (ms) — protects low-end CPUs. */
export const FRAME_PROCESS_INTERVAL_MS = 500;

/** Embedding JSON serialization precision (float decimals). */
export const EMBEDDING_DECIMALS = 6;

/** Enrollment angles (3 vectors per product, per spec). */
export const ANGLE_LABELS = ['front', 'back', 'side'] as const;

export const ANGLE_LABELS_AR: Record<string, string> = {
  front: 'أمامية',
  back: 'خلفية',
  side: 'جانبية',
};

/** Max age of a captured embedding before it is considered stale (ms). */
export const CAPTURE_FRESHNESS_MS = 4000;

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
export const DB_NAME = 'vision_pos.db';

/** App display name used on receipts & About page. */
export const APP_NAME = 'Smart Vision POS';
