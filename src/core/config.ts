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

/**
 * Default cosine similarity threshold.
 * v8.1: 0.82 → 0.78 — 0.82 was too strict for real-world lighting/angle
 * drift at the checkout counter; confident auto-adds rarely fired and
 * the merchant had to pick manually every time. 0.78 + the new
 * Settings slider (50–95%) gives direct control.
 */
export const DEFAULT_MATCH_THRESHOLD = 0.78;

/** Minimum time between two auto-adds of the SAME product (ms). */
export const DEFAULT_RECOGNITION_COOLDOWN_MS = 1500;

/** Scanner engine selected by the merchant from Settings. */
export type ScannerMode = 'barcode' | 'visual' | 'both';

/**
 * Pause between auto-scan cycles in the POS camera sheet (ms).
 * v6: 900 → 2000 ms — on budget hardware a capture + decode +
 * inference cycle takes ~1s, so 900ms meant near back-to-back
 * captures that stress cheap camera HALs. The loop already skips
 * while busy; this keeps the cadence genuinely calm.
 */
export const AUTO_SCAN_INTERVAL_MS = 2000;

/** Hard timeout around every native camera call — a hung camera can
 *  never freeze the scan flow again (v3's fatal freeze). */
export const CAPTURE_TIMEOUT_MS = 7000;

/** Barcode re-scan guard: same code ignored for this long (ms). */
export const BARCODE_DEDUPE_MS = 1600;

/** Default base unit name used when a product has no unit rows. */
export const BASE_UNIT_NAME = 'قطعة';

/** Units seeded on first run (name, short name). */
export const DEFAULT_UNITS: {name: string; short: string}[] = [
  {name: 'قطعة', short: 'ق'},
  {name: 'كرتونة', short: 'كرت'},
  {name: 'علبة', short: 'علب'},
  {name: 'كيس', short: 'كيس'},
  {name: 'كيلوغرام', short: 'كغ'},
  {name: 'غرام', short: 'غ'},
  {name: 'لتر', short: 'ل'},
  {name: 'دزينة', short: 'دز'},
  {name: 'زجاجة', short: 'زج'},
  {name: 'متر', short: 'م'},
];

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
export const DB_SCHEMA_VERSION = 3;

/** App display name (Latin, per merchant request) used everywhere. */
export const APP_NAME = 'sela';
export const APP_NAME_AR = 'سيلا';

/**
 * App version — shown on the Home dashboard badge, Settings → About
 * and in the release APK file name. Keep in sync with
 * android/app/build.gradle versionName/versionCode.
 */
export const APP_VERSION = '8.1.0';
/** Android versionCode (build number) — bump on EVERY release. */
export const APP_BUILD_CODE = 10;
/** Human-readable version with build number, e.g. "6.0.0 (7)". */
export const APP_VERSION_LABEL = `${APP_VERSION} (${APP_BUILD_CODE})`;

// ─────────────────────────────────────────────────────────────
// Subscription / licensing
// ─────────────────────────────────────────────────────────────

/** Default license-server base URL (owner's Coolify deployment).
 *  Merchants can override it in the activation screen if the
 *  management moves the server. */
export const LICENSE_SERVER_URL =
  'http://8jz9a3yyhn3eltmwqgnchn29.130.61.171.201.sslip.io';

/** Ed25519 PUBLIC key (hex) of the license server — licenses are
 *  signed server-side and verified on-device; the private key never
 *  leaves the server. Rotating the pair requires an app update. */
export const LICENSE_PUBLIC_KEY_HEX =
  '6ee513c1b7f0b057d970c6c2f4b33e5d026bc4c798b5a0b8bb72818d3197d103';

/** Offline grace: hours an activated POS keeps working with no
 *  server contact (POS must survive offline trading days). */
export const LICENSE_GRACE_SOFT_HOURS = 72;

/** After this many offline hours the app locks until it reaches
 *  the server once (anti-crack: no eternal offline use). */
export const LICENSE_GRACE_HARD_HOURS = 240;

/** Wall-clock rollback beyond this (ms) counts as a tamper strike. */
export const LICENSE_ROLLBACK_TOLERANCE_MS = 5 * 60 * 1000;

/** Management contact shown on the activation + subscription
 *  screens (server config overrides these when reachable). Any
 *  channel left empty here (or on the server) is hidden in the UI. */
export const LICENSE_CONTACT_FALLBACK = {
  phone: '+972 59 000 0000',
  whatsapp: '+972 59 000 0000',
  telegram: '',
  email: 'abdalasela@gmail.com',
  note: 'لشراء أو تجديد الاشتراك تواصل مع الإدارة عبر أحد قنوات التواصل',
};
