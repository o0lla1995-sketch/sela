/**
 * scanFlow — v8 unified entry points for the NATIVE scanner engines.
 * ─────────────────────────────────────────────────────────────────
 * The camera now lives in ScannerActivity (its own native window).
 * These helpers wrap the promise API with the app's error contract:
 * they resolve `null` when the merchant closes the scanner, and
 * reject with a readable Arabic message when the engine itself
 * failed (so callers can toast the real reason).
 *
 * v8.1 adds scanBarcodeContinuous(): a multi-scan session that never
 * auto-closes — each deduped read is delivered live to `onCode`, and
 * the promise resolves (null) when the merchant closes the scanner.
 *
 * v8.2 (round-11):
 *  • ensureCameraPermission() — the app now ASKS for the camera at
 *    runtime BEFORE the native window opens (round-11 #1: nothing
 *    ever requested it, so first launch died with "إذن الكاميرا
 *    غير ممنوح"). The native activity re-asks as a safety net.
 *  • scanVisualContinuous() — the visual engine's multi-scan session:
 *    the native window AUTO-captures (no shutter press per product),
 *    every photo streams to `onPhoto`, and recognized products jump
 *    into the cart by themselves (round-11 #2).
 */
import {
  DeviceEventEmitter,
  EmitterSubscription,
  Linking,
  PermissionsAndroid,
} from 'react-native';
import {SelaScannerNative} from '../../native/nativeBridge';

/** Native event streamed for every read during a continuous session. */
const BARCODE_READ_EVENT = 'selaScanBarcode';
/** Native event streamed for every photo in a continuous VISUAL session. */
const VISUAL_PHOTO_EVENT = 'selaScanVisual';

export type CameraPermissionResult = 'granted' | 'denied' | 'never_ask_again';

/**
 * v8.2: runtime CAMERA permission — called before ANY scanner window
 * opens, so the very first launch shows the system dialog instead of
 * an instant "permission not granted" failure.
 */
export async function ensureCameraPermission(): Promise<CameraPermissionResult> {
  try {
    const already = await PermissionsAndroid.check(
      PermissionsAndroid.PERMISSIONS.CAMERA,
    );
    if (already) {
      return 'granted';
    }
    const result = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.CAMERA,
      {
        title: 'إذن الكاميرا',
        message:
          'يحتاج سيلا إلى الكاميرا لمسح المنتجات — المسح البصري والباركود يعملان بها فقط',
        buttonPositive: 'سماح',
        buttonNegative: 'لاحقاً',
      },
    );
    return result as CameraPermissionResult;
  } catch {
    return 'denied';
  }
}

/** Readable Arabic message for a refused camera permission. */
export function cameraPermissionMessage(
  result: CameraPermissionResult,
): string {
  return result === 'never_ask_again'
    ? 'إذن الكاميرا مرفوض نهائياً — فعّله من: الإعدادات ← التطبيقات ← سيلا ← الأذونات'
    : 'لا يمكن فتح الماسح بدون إذن الكاميرا — امنح الإذن وحاول مجدداً';
}

/**
 * v8.3: opens the app's system settings page — when the camera
 * permission is permanently denied the system no longer shows the
 * ask-dialog, so the merchant's only way forward is the settings
 * toggle. Exposed for the permission Alert button in PosScreen.
 */
export async function openAppSettings(): Promise<void> {
  try {
    await Linking.openSettings();
  } catch {
    // Some ROMs without a settings activity — the manual path in the
    // message still works.
  }
}

/** Throws a readable Arabic error when the camera is not permitted. */
async function requireCameraPermission(): Promise<void> {
  const result = await ensureCameraPermission();
  if (result !== 'granted') {
    throw new Error(cameraPermissionMessage(result));
  }
}

/** Opens the native BARCODE engine → code string, or null if closed. */
export async function scanBarcode(): Promise<string | null> {
  if (SelaScannerNative == null) {
    throw new Error('وحدة الماسح غير متوفرة في هذا الإصدار من التطبيق');
  }
  await requireCameraPermission();
  const result = await SelaScannerNative.openScanner('barcode');
  if (result.cancelled || result.code == null) {
    return null;
  }
  return result.code;
}

/**
 * v8.1 continuous multi-scan session (barcode engine). Every deduped
 * read fires `onCode` immediately; resolves when the scanner closes.
 */
export async function scanBarcodeContinuous(
  onCode: (code: string) => void,
): Promise<void> {
  if (SelaScannerNative == null) {
    throw new Error('وحدة الماسح غير متوفرة في هذا الإصدار من التطبيق');
  }
  await requireCameraPermission();
  const listener: EmitterSubscription = DeviceEventEmitter.addListener(
    BARCODE_READ_EVENT,
    event => {
      const code = event?.code;
      if (typeof code === 'string' && code.length > 0) {
        onCode(code);
      }
    },
  );
  try {
    await SelaScannerNative.openScannerContinuous();
  } finally {
    listener.remove();
  }
}

/** Opens the native PHOTO engine (single shot) → image path, or null. */
export async function capturePhoto(): Promise<string | null> {
  if (SelaScannerNative == null) {
    throw new Error('وحدة الماسح غير متوفرة في هذا الإصدار من التطبيق');
  }
  await requireCameraPermission();
  const result = await SelaScannerNative.openScanner('photo');
  if (result.cancelled || result.path == null) {
    return null;
  }
  return result.path;
}

/**
 * v8.2 continuous VISUAL multi-scan session (photo engine). The
 * native window auto-captures on a calm cadence — no shutter press
 * per product — and every photo fires `onPhoto(path, auto)` live;
 * resolves when the merchant closes the scanner. Recognition and
 * cart-adding happen in the `onPhoto` handler; the outcome is
 * reported back via SelaScannerNative.reportVisualResult so the
 * scanner window itself celebrates each add.
 */
export async function scanVisualContinuous(
  onPhoto: (path: string, auto: boolean) => void,
): Promise<void> {
  if (SelaScannerNative == null) {
    throw new Error('وحدة الماسح غير متوفرة في هذا الإصدار من التطبيق');
  }
  await requireCameraPermission();
  const listener: EmitterSubscription = DeviceEventEmitter.addListener(
    VISUAL_PHOTO_EVENT,
    event => {
      const path = event?.path;
      if (typeof path === 'string' && path.length > 0) {
        onPhoto(path, event?.auto !== false);
      }
    },
  );
  try {
    await SelaScannerNative.openScannerVisualContinuous();
  } finally {
    listener.remove();
  }
}
