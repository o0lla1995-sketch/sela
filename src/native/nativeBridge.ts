/**
 * Typed access to the hand-written Kotlin native modules.
 * Both modules live in `VisionPosPackage` and are exposed through the
 * legacy NativeModules interop layer (New Architecture compatible).
 */
import {NativeModules} from 'react-native';

export interface EscPosOp {
  op:
    | 'init'
    | 'codepage'
    | 'align'
    | 'bold'
    | 'size'
    | 'text'
    | 'feed'
    | 'cut'
    | 'rawBase64'
    | 'image'
    | 'barcode';
  /** Text payload for op:'text' / op:'rawBase64'. */
  value?: string;
  /** Barcode system for op:'barcode' (v9.1 label printing). */
  system?: 'EAN13' | 'CODE128';
  /** Image file path for op:'image'. */
  path?: string;
  /** Max raster width in dots for op:'image' (58mm=384, 80mm=576). */
  maxWidth?: number;
  /** Center the raster for op:'image'. */
  center?: boolean;
  /** Code page number for op:'codepage'. */
  page?: number;
  /** 0=left 1=center 2=right for op:'align'. */
  align?: number;
  /** Bold flag for op:'bold'. */
  on?: boolean;
  /** Double-size flags for op:'size'; barcode height in dots for
   *  op:'barcode' (v9.1). */
  width?: number;
  height?: number;
  /** Feed line count for op:'feed'. */
  lines?: number;
}

interface ThermalPrinterNative {
  isBluetoothEnabled(): Promise<boolean>;
  requestEnableBluetooth(): Promise<boolean>;
  getBondedDevices(): Promise<
    {name: string; address: string; bondState: number}[]
  >;
  startDiscovery(): Promise<boolean>;
  stopDiscovery(): Promise<boolean>;
  connect(address: string): Promise<boolean>;
  disconnect(): Promise<boolean>;
  isConnected(): Promise<boolean>;
  getConnectedAddress(): Promise<string | null>;
  printJob(commands: EscPosOp[]): Promise<boolean>;
}

interface PlatformUtilsNative {
  beep(kind: number): Promise<boolean>;
  getApiLevel(): Promise<number>;
  /** Stable per-device id (ANDROID_ID) for license binding. */
  getDeviceId(): Promise<string>;
  /** Monotonic ms since boot — immune to clock changes. */
  getUptimeMs(): Promise<number>;
  /** Primary ABI ("arm64-v8a" / "armeabi-v7a"). */
  getAbi(): Promise<string>;
  exportFile(
    fileName: string,
    mimeType: string,
    content: string,
  ): Promise<string>;
  /** Opens the system file picker and returns the picked file's text. */
  pickAndReadFile(mimeTypes: string[]): Promise<string>;
  getFilesDir(): Promise<string>;
  makeDir(path: string): Promise<boolean>;
  fileExists(path: string): Promise<boolean>;
  copyFile(sourcePath: string, destinationPath: string): Promise<string>;
  deleteFile(path: string): Promise<boolean>;
  /** v8.3: app-internal file → base64 (backup image embedding).
   *  Rejects when the path is outside filesDir or the file is gone. */
  readFileBase64(path: string): Promise<string>;
  /** v8.3: base64 → fresh file inside filesDir/<subDir> → new path. */
  writeFileBase64(
    subDir: string,
    name: string,
    base64: string,
  ): Promise<string>;
}

/**
 * v8/v9 scanner gateway — the camera preview lives in a NATIVE
 * full-screen Activity (ScannerActivity), completely outside the RN
 * view tree. This is the module that opens it and resolves with the
 * result. Two FULLY INDEPENDENT engines:
 *   'barcode' → Preview + ML Kit frame analysis → { code }
 *   'photo'   → Preview + ImageCapture (shutter) → { path }
 * v8.1 adds openScannerContinuous(): a barcode session that never
 * auto-closes — every deduped read streams to JS as a
 * "selaScanBarcode" event; the promise resolves {cancelled:true}
 * when the merchant closes the scanner.
 *
 * v9 (round-13): the visual engine deliberately has NO continuous
 * variant — the v8.2–v8.3 auto-capture/photo-stream machinery
 * hard-crashed the merchant's device on every open. The visual flow
 * is ONE deliberate photo per window, exactly as in v8.1.0 (the
 * contract this device ran crash-free).
 */
interface SelaScannerNativeModule {
  /** Opens the native scanner; resolves {code} / {path} / {cancelled}. */
  openScanner(mode: 'barcode' | 'photo'): Promise<{
    cancelled?: boolean;
    code?: string;
    path?: string;
  }>;
  /** v8.1: opens the continuous multi-scan barcode session. */
  openScannerContinuous(): Promise<{
    cancelled?: boolean;
    code?: string;
    path?: string;
  }>;
  /** v9.1 (round-14 #2): opens the continuous multi-shot VISUAL
   *  session — every deliberate shutter press streams a "selaScanPhoto"
   *  event with the saved photo path; resolves {cancelled:true} when
   *  the merchant closes the scanner. */
  openScannerPhotoMulti(): Promise<{
    cancelled?: boolean;
    code?: string;
    path?: string;
  }>;
  /** v9.2 (round-15 #5): opens the COMBINED session — ONE native
   *  window with BOTH engines and an in-camera switcher (باركود ⇄
   *  بصري) that flips the active engine WITHOUT closing the camera.
   * Barcode reads stream as "selaScanBarcode" events, shutter
   * presses stream "selaScanPhoto" events; resolves {cancelled:true}
   * when the merchant closes the scanner. */
  openScannerBoth(): Promise<{
    cancelled?: boolean;
    code?: string;
    path?: string;
  }>;
  /** v9.1 (round-14 #1): streams the JS-confirmed outcome of a read
   *  back into the live scanner window — ok=true shows the green
   *  "✓ added" banner + bumps the CONFIRMED counter; ok=false shows
   *  the red informational banner (غير مسجل / لم يتم التعرف). */
  notifyScanResult(ok: boolean, message: string): Promise<boolean>;
  /** Headless camera self-test → every step's outcome. */
  runDiagnostics(): Promise<{
    permissionGranted: boolean;
    providerOk?: boolean;
    providerError?: string;
    cameraCount?: number;
    hasBackCamera?: boolean;
    torchSupported?: boolean;
    previewBindOk?: boolean;
    bindError?: string;
    result: 'ok' | 'bind-failed' | 'provider-failed';
  }>;
}

interface ImageDecoderNative {
  /** Photo → base64 RGB bytes (center-cropped square, size×size). */
  decodeRgb(path: string, size: number): Promise<string>;
  /** v9.1 (round-14 #2): ensemble decode — zoom (deeper center crop,
   *  (0,1]), fit (whole frame scaled to the square) and flip
   *  (horizontal mirror, enrollment augmentation). */
  decodeRgbEx(
    path: string,
    size: number,
    zoom: number,
    fit: boolean,
    flip: boolean,
  ): Promise<string>;
  /** v10 (round-16 #4): multi-product WINDOW probe — a square window
   *  of side min(w,h)*w centered at fractional (cx,cy), cropped from
   *  a cached decode of the same path (cheap for 10+ windows). */
  decodeRgbWindow(
    path: string,
    size: number,
    cx: number,
    cy: number,
    w: number,
  ): Promise<string>;
  /** v10: frees the cached window-probe bitmap after the pass. */
  releaseDecodeCache(): Promise<void>;
  /** Downscaled JPEG copy for thumbnails → new absolute path. */
  saveScaled(path: string, maxDim: number, quality: number): Promise<string>;
}

interface SelaNotificationsNative {
  areNotificationsEnabled(): Promise<boolean>;
  requestPermission(): Promise<boolean>;
  show(id: number, title: string, body: string, kind: string): Promise<boolean>;
  cancelAll(): Promise<boolean>;
}

interface SelaImagePickerNative {
  /** Opens the system image picker; resolves the saved local path. */
  pickStoreLogo(maxDim: number): Promise<string>;
}

type MaybeModule<T> = T | undefined;

export const ThermalPrinterNative: MaybeModule<ThermalPrinterNative> =
  NativeModules.ThermalPrinter as MaybeModule<ThermalPrinterNative>;

export const PlatformUtilsNative: MaybeModule<PlatformUtilsNative> =
  NativeModules.PlatformUtils as MaybeModule<PlatformUtilsNative>;

export const ImageDecoderNative: MaybeModule<ImageDecoderNative> =
  NativeModules.ImageDecoder as MaybeModule<ImageDecoderNative>;

export const SelaNotificationsNative: MaybeModule<SelaNotificationsNative> =
  NativeModules.SelaNotifications as MaybeModule<SelaNotificationsNative>;

export const SelaImagePickerNative: MaybeModule<SelaImagePickerNative> =
  NativeModules.SelaImagePicker as MaybeModule<SelaImagePickerNative>;

export const SelaScannerNative: MaybeModule<SelaScannerNativeModule> =
  NativeModules.SelaScanner as MaybeModule<SelaScannerNativeModule>;

/** Opens the native BARCODE scanner — throws if unavailable. */
export function requireBarcodeScanner(): SelaScannerNativeModule {
  if (SelaScannerNative == null) {
    throw new Error('وحدة الماسح غير متوفرة في هذا الإصدار من التطبيق');
  }
  return SelaScannerNative;
}

export function requireThermalPrinter(): ThermalPrinterNative {
  if (ThermalPrinterNative == null) {
    throw new Error(
      'وحدة الطباعة الناتيف غير متوفرة في هذا الإصدار من التطبيق',
    );
  }
  return ThermalPrinterNative;
}

export function requirePlatformUtils(): PlatformUtilsNative {
  if (PlatformUtilsNative == null) {
    throw new Error('وحدة أدوات النظام غير متوفرة في هذا الإصدار من التطبيق');
  }
  return PlatformUtilsNative;
}
