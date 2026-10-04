/**
 * scanFlow — v8/v9 unified entry points for the NATIVE scanner engines.
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
 * v9 (round-13): scanVisualContinuous() is REMOVED. The v8.2–v8.3
 * continuous VISUAL machinery (auto-capture loop + photo streaming
 * + in-window feedback) is exactly what hard-crashed the merchant's
 * device on every scanner open — while v8.1.0, the same native
 * activity WITHOUT it, worked perfectly. The visual flow is once
 * again ONE deliberate photo per window (capturePhoto), and the JS
 * side re-opens the window for the next product. The runtime camera
 * permission helpers added in v8.2 are KEPT (the dialog appeared and
 * granted correctly on the device).
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

/** Opens the native PHOTO engine (single shot) → image path, or null.
 *  v9: THE visual-scan primitive — one deliberate photo per window,
 *  exactly the v8.1.0 contract the merchant's device ran crash-free.
 *  The caller re-opens it for the next product. */
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
