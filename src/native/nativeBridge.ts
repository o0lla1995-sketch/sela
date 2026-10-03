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
    | 'image';
  /** Text payload for op:'text' / op:'rawBase64'. */
  value?: string;
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
  /** Double-size flags for op:'size'. */
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
  exportFile(
    fileName: string,
    mimeType: string,
    content: string,
  ): Promise<string>;
  getFilesDir(): Promise<string>;
  makeDir(path: string): Promise<boolean>;
  fileExists(path: string): Promise<boolean>;
  copyFile(sourcePath: string, destinationPath: string): Promise<string>;
  deleteFile(path: string): Promise<boolean>;
}

interface ImageDecoderNative {
  /** Photo → base64 RGB bytes (center-cropped square, size×size). */
  decodeRgb(path: string, size: number): Promise<string>;
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
