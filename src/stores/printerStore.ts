/**
 * Printer store — connection status, discovered devices and scan
 * lifecycle, with auto-reconnect to the last used printer.
 */
import {create} from 'zustand';
import {
  ThermalPrinterService,
  PrinterEvents,
} from '../services/printer/ThermalPrinterService';
import {useSettingsStore} from './settingsStore';
import {logDiag} from '../core/diagnostics';
import type {PrinterDevice} from '../core/types';

export type PrinterStatus = 'disconnected' | 'connecting' | 'connected';

interface PrinterState {
  status: PrinterStatus;
  deviceName: string | null;
  deviceAddress: string | null;
  bonded: PrinterDevice[];
  discovered: PrinterDevice[];
  scanning: boolean;
  lastError: string | null;

  refreshBonded: () => Promise<void>;
  startScan: () => Promise<void>;
  connect: (device: PrinterDevice) => Promise<void>;
  connectSaved: () => Promise<boolean>;
  disconnect: () => Promise<void>;
  checkConnection: () => Promise<void>;
}

let subscribed = false;

function ensureSubscriptions(): void {
  if (subscribed) return;
  subscribed = true;

  PrinterEvents.onDeviceFound(device => {
    usePrinterStore.setState(state => {
      const known = state.discovered.some(
        entry => entry.address === device.address,
      );
      if (known) return state;
      return {discovered: [device, ...state.discovered]};
    });
  });

  PrinterEvents.onDiscoveryFinished(() => {
    usePrinterStore.setState({scanning: false});
  });

  PrinterEvents.onConnectionChanged(connected => {
    if (!connected) {
      usePrinterStore.setState({
        status: 'disconnected',
        deviceName: null,
        deviceAddress: null,
      });
    }
  });

  PrinterEvents.onError(message => {
    usePrinterStore.setState({lastError: message});
    logDiag('printer', message, 'warn');
  });
}

export const usePrinterStore = create<PrinterState>((set, get) => ({
  status: 'disconnected',
  deviceName: null,
  deviceAddress: null,
  bonded: [],
  discovered: [],
  scanning: false,
  lastError: null,

  refreshBonded: async () => {
    try {
      const bonded = await ThermalPrinterService.getBondedDevices();
      set({bonded, lastError: null});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({lastError: message});
    }
  },

  startScan: async () => {
    ensureSubscriptions();
    try {
      set({discovered: [], scanning: true});
      const started = await ThermalPrinterService.startDiscovery();
      if (!started) {
        set({
          scanning: false,
          lastError: 'تعذر بدء البحث — تأكد أن البلوتوث مفعّل',
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({scanning: false, lastError: message});
    }
  },

  connect: async device => {
    ensureSubscriptions();
    set({status: 'connecting', lastError: null});
    try {
      await ThermalPrinterService.connect(device.address);
      set({
        status: 'connected',
        deviceName: device.name,
        deviceAddress: device.address,
      });
      useSettingsStore.getState().update({
        printerAddress: device.address,
        printerName: device.name,
      });
      logDiag(
        'printer',
        `تم الاتصال بالطابعة ${device.name} (${device.address})`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({status: 'disconnected', lastError: message});
      throw error;
    }
  },

  connectSaved: async () => {
    const settings = useSettingsStore.getState().settings;
    if (!settings.printerAddress) return false;
    return get()
      .connect({
        name: settings.printerName ?? 'الطابعة المحفوظة',
        address: settings.printerAddress,
        bondState: 12,
      })
      .then(() => true)
      .catch(() => false);
  },

  disconnect: async () => {
    await ThermalPrinterService.disconnect();
    set({status: 'disconnected', deviceName: null, deviceAddress: null});
  },

  checkConnection: async () => {
    const connected = await ThermalPrinterService.isConnected();
    if (connected) {
      const address = await ThermalPrinterService.getConnectedAddress();
      set({status: 'connected', deviceAddress: address});
    } else {
      set({status: 'disconnected', deviceName: null, deviceAddress: null});
    }
  },
}));
