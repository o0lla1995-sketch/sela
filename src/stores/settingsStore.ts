/**
 * Settings store — persisted to MMKV as one JSON blob.
 * Every UI screen reads its tunables from here so the shop owner can
 * adjust the system without touching code.
 */
import {create} from 'zustand';
import {getJson, setJson, KEYS} from '../storage/storage';
import {
  DEFAULT_MATCH_THRESHOLD,
  DEFAULT_RECOGNITION_COOLDOWN_MS,
  CODEPAGE_CP1256,
  DEFAULT_EXPIRY_ALERT_DAYS,
  DEFAULT_LOW_STOCK_THRESHOLD,
  type ScannerMode,
} from '../core/config';
import type {PricingMode} from '../core/types';

export interface AppSettings {
  storeName: string;
  storePhone: string;
  storeAddress: string;
  footerMessage: string;
  /** Store logo (local file path) shown in-app and on receipts. */
  storeLogoPath: string | null;
  defaultPricingMode: PricingMode;
  /** Scanner engine: barcode / visual / both (merchant's choice). */
  scannerMode: ScannerMode;
  /** Vision */
  recognitionEnabled: boolean;
  matchThreshold: number;
  recognitionCooldownMs: number;
  soundEnabled: boolean;
  /** Receipt */
  paperWidth: '58' | '80';
  codepage: number;
  showProfitOnReceipt: boolean;
  /** Saved printer */
  printerAddress: string | null;
  printerName: string | null;
  /** Stock alerts */
  stockAlertsEnabled: boolean;
  lowStockDefaultThreshold: number;
  /** v32 (round-40 #3): نافذة التنبيه قبل انتهاء الصلاحية (أيام). */
  expiryAlertDays: number;
  systemNotificationsEnabled: boolean;
}

const DEFAULTS: AppSettings = {
  storeName: 'متجر sela',
  storePhone: '',
  storeAddress: '',
  footerMessage: 'شكراً لتعاملكم معنا — لا يوجد إرجاع أو استبدال بعد الفاتورة',
  storeLogoPath: null,
  defaultPricingMode: 'RETAIL',
  scannerMode: 'both',
  recognitionEnabled: true,
  matchThreshold: DEFAULT_MATCH_THRESHOLD,
  recognitionCooldownMs: DEFAULT_RECOGNITION_COOLDOWN_MS,
  soundEnabled: true,
  paperWidth: '58',
  codepage: CODEPAGE_CP1256,
  showProfitOnReceipt: false,
  printerAddress: null,
  printerName: null,
  stockAlertsEnabled: true,
  lowStockDefaultThreshold: DEFAULT_LOW_STOCK_THRESHOLD,
  expiryAlertDays: DEFAULT_EXPIRY_ALERT_DAYS,
  systemNotificationsEnabled: true,
};

interface SettingsState {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
  reset: () => void;
}

function loadInitial(): AppSettings {
  const stored = getJson<Partial<AppSettings>>(KEYS.settings, {});
  return {...DEFAULTS, ...stored};
}

function persist(settings: AppSettings): void {
  setJson(KEYS.settings, settings);
}

export const useSettingsStore = create<SettingsState>(set => ({
  settings: loadInitial(),
  update: patch =>
    set(state => {
      const next = {...state.settings, ...patch};
      persist(next);
      return {settings: next};
    }),
  reset: () =>
    set(() => {
      persist(DEFAULTS);
      return {settings: {...DEFAULTS}};
    }),
}));

/** Imperative accessor for services outside React. */
export function getSettings(): AppSettings {
  return useSettingsStore.getState().settings;
}
