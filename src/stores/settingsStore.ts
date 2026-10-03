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
  DEFAULT_LOW_STOCK_THRESHOLD,
} from '../core/config';
import type {PricingMode} from '../core/types';

export interface AppSettings {
  storeName: string;
  storePhone: string;
  footerMessage: string;
  defaultPricingMode: PricingMode;
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
  systemNotificationsEnabled: boolean;
}

const DEFAULTS: AppSettings = {
  storeName: 'متجر سيلا',
  storePhone: '',
  footerMessage: 'شكراً لتعاملكم معنا — لا يوجد إرجاع أو استبدال بعد الفاتورة',
  defaultPricingMode: 'RETAIL',
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
