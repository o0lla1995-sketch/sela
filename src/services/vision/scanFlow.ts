/**
 * scanFlow — v8 unified entry points for the NATIVE scanner engines.
 * ─────────────────────────────────────────────────────────────────
 * The camera now lives in ScannerActivity (its own native window).
 * These helpers wrap the promise API with the app's error contract:
 * they resolve `null` when the merchant closes the scanner, and
 * reject with a readable Arabic message when the engine itself
 * failed (so callers can toast the real reason).
 */
import {SelaScannerNative} from '../../native/nativeBridge';

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
