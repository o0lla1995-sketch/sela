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
 */
import {DeviceEventEmitter, EmitterSubscription} from 'react-native';
import {SelaScannerNative} from '../../native/nativeBridge';

/** Native event streamed for every read during a continuous session. */
const BARCODE_READ_EVENT = 'selaScanBarcode';

/** Opens the native BARCODE engine → code string, or null if closed. */
export async function scanBarcode(): Promise<string | null> {
  if (SelaScannerNative == null) {
    throw new Error('وحدة الماسح غير متوفرة في هذا الإصدار من التطبيق');
  }
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

/** Opens the native PHOTO engine → image path, or null if closed. */
export async function capturePhoto(): Promise<string | null> {
  if (SelaScannerNative == null) {
    throw new Error('وحدة الماسح غير متوفرة في هذا الإصدار من التطبيق');
  }
  const result = await SelaScannerNative.openScanner('photo');
  if (result.cancelled || result.path == null) {
    return null;
  }
  return result.path;
}
