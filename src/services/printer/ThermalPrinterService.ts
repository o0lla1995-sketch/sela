/**
 * ThermalPrinterService
 * ─────────────────────────────────────────────────────────────────
 * High-level printing API on top of the native Bluetooth module:
 * permission orchestration, discovery events, connection state and
 * receipt job execution with Arabic error messages.
 */
import {Platform, PermissionsAndroid} from 'react-native';
import {DeviceEventEmitter} from 'react-native';
import {
  requireThermalPrinter,
  type EscPosOp,
} from '../../native/nativeBridge';
import {logDiag} from '../../core/diagnostics';
import {nativeErrorMessage} from '../../database/connection';
import type {PrinterDevice} from '../../core/types';

let deviceFoundSub: {remove: () => void} | null = null;
let discoveryFinishedSub: {remove: () => void} | null = null;
let connectionChangedSub: {remove: () => void} | null = null;
let errorSub: {remove: () => void} | null = null;

export const PrinterEvents = {
  /** Subscribe to live discovery results; returns an unsubscribe fn. */
  onDeviceFound(handler: (device: PrinterDevice) => void): () => void {
    const sub = DeviceEventEmitter.addListener('onDeviceFound', payload => {
      if (payload && typeof payload.address === 'string') {
        handler({
          name: String(payload.name ?? 'جهاز'),
          address: payload.address,
          bondState: Number(payload.bondState ?? 0),
        });
      }
    });
    return () => sub.remove();
  },

  onDiscoveryFinished(handler: () => void): () => void {
    const sub = DeviceEventEmitter.addListener('onDiscoveryFinished', () => handler());
    return () => sub.remove();
  },

  onConnectionChanged(
    handler: (connected: boolean, address?: string) => void,
  ): () => void {
    const sub = DeviceEventEmitter.addListener('onConnectionChanged', payload => {
      handler(Boolean(payload?.connected), payload?.address);
    });
    return () => sub.remove();
  },

  onError(handler: (message: string) => void): () => void {
    const sub = DeviceEventEmitter.addListener('onPrinterError', payload => {
      handler(String(payload?.message ?? 'خطأ غير معروف في الطابعة'));
    });
    return () => sub.remove();
  },

  dispose(): void {
    deviceFoundSub?.remove();
    discoveryFinishedSub?.remove();
    connectionChangedSub?.remove();
    errorSub?.remove();
    deviceFoundSub = null;
    discoveryFinishedSub = null;
    connectionChangedSub = null;
    errorSub = null;
  },
};

/** Requests every Bluetooth permission this app needs for the API level. */
export async function ensureBluetoothPermissions(): Promise<boolean> {
  try {
    if (Platform.OS !== 'android') return true;
    const sdk = Platform.Version;
    if (sdk >= 31) {
      const granted = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      ]);
      return (
        granted['android.permission.BLUETOOTH_CONNECT'] ===
          PermissionsAndroid.RESULTS.GRANTED &&
        granted['android.permission.BLUETOOTH_SCAN'] === PermissionsAndroid.RESULTS.GRANTED
      );
    }
    // Android 5–11: location is required for discovery.
    const location = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
    );
    return location === PermissionsAndroid.RESULTS.GRANTED;
  } catch (error) {
    logDiag(
      'printer',
      `فشل طلب أذونات البلوتوث: ${nativeErrorMessage(error, 'خطأ')}`,
      'warn',
    );
    return false;
  }
}

export const ThermalPrinterService = {
  async isBluetoothEnabled(): Promise<boolean> {
    try {
      return await requireThermalPrinter().isBluetoothEnabled();
    } catch (error) {
      logDiag('printer', nativeErrorMessage(error, 'تعذر فحص البلوتوث'), 'warn');
      return false;
    }
  },

  async requestEnableBluetooth(): Promise<boolean> {
    try {
      return await requireThermalPrinter().requestEnableBluetooth();
    } catch (error) {
      logDiag('printer', nativeErrorMessage(error, 'تعذر تفعيل البلوتوث'), 'warn');
      return false;
    }
  },

  async getBondedDevices(): Promise<PrinterDevice[]> {
    try {
      return await requireThermalPrinter().getBondedDevices();
    } catch (error) {
      throw new Error(nativeErrorMessage(error, 'تعذر جلب الأجهزة المقترنة'));
    }
  },

  async startDiscovery(): Promise<boolean> {
    try {
      return await requireThermalPrinter().startDiscovery();
    } catch (error) {
      throw new Error(nativeErrorMessage(error, 'تعذر بدء البحث عن الأجهزة'));
    }
  },

  async stopDiscovery(): Promise<boolean> {
    try {
      return await requireThermalPrinter().stopDiscovery();
    } catch (error) {
      return false;
    }
  },

  async connect(address: string): Promise<boolean> {
    try {
      return await requireThermalPrinter().connect(address);
    } catch (error) {
      throw new Error(nativeErrorMessage(error, 'تعذر الاتصال بالطابعة'));
    }
  },

  async disconnect(): Promise<boolean> {
    try {
      return await requireThermalPrinter().disconnect();
    } catch (error) {
      return false;
    }
  },

  async isConnected(): Promise<boolean> {
    try {
      return await requireThermalPrinter().isConnected();
    } catch {
      return false;
    }
  },

  async getConnectedAddress(): Promise<string | null> {
    try {
      return await requireThermalPrinter().getConnectedAddress();
    } catch {
      return null;
    }
  },

  /** Sends a built ESC/POS job to the connected printer. */
  async printJob(ops: EscPosOp[]): Promise<void> {
    try {
      await requireThermalPrinter().printJob(ops);
      logDiag('printer', 'تمت الطباعة بنجاح');
    } catch (error) {
      const message = nativeErrorMessage(error, 'فشل الطباعة');
      logDiag('printer', message, 'error');
      throw new Error(message);
    }
  },
};
