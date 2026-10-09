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
import type {StoreMode} from '../core/storeModes';

/** v40 (الجولة 48 #5): شكل عرض المنتجات داخل نقطة البيع — الافتراض
 *  الشبكة الحالية (طلب التاجر: «اجعل الشكل الافتراضي هو الحالي»).
 *  grid: البلاطات المربعة الحالية بالصور.
 *  list: صفوف مضغوطة (مصغّر + اسم + سعر + مخزون) — أكثر أصناف في
 *  الشاشة للمخازن الكبيرة.
 *  cards: بطاقات كبيرة بصور كبيرة (اثنتان في الصف) — للملابس
 *  والبصريين حيث الصورة تبيع. */
export type PosProductView = 'grid' | 'list' | 'cards';

export interface AppSettings {
  storeName: string;
  storePhone: string;
  storeAddress: string;
  footerMessage: string;
  /** Store logo (local file path) shown in-app and on receipts. */
  storeLogoPath: string | null;
  defaultPricingMode: PricingMode;
  /** Scanner engine: barcode / visual / both (merchant's choice).
   *  v37 (الجولة 45 #2ب): الافتراض «باركود» فقط (طلب التاجر
   *  نصاً) — كان «both». */
  scannerMode: ScannerMode;
  /** v37 (الجولة 45 #2ب): هل عدّل التاجر طريقة المسح بنفسه؟
   *  يُستعمل لترحيل الافتراض القديم «both» إلى «barcode» مرة
   *  واحدة بلا طغيان على اختيار التاجر الصريح. */
  scannerModeTouched: boolean;
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
  /** v33 (round-41 #4): نمط المتجر — بقالة افتراضياً؛ يغيّر الأصناف
   *  المقترحة ووحدات الإدخال وسلوك صفحة المنتج حسب المجال
   *  (كافيتريا/ملابس/صيدلية/فواكه/مطعم). */
  storeMode: StoreMode;
  /** v32 (round-40 #3): نافذة التنبيه قبل انتهاء الصلاحية (أيام). */
  expiryAlertDays: number;
  systemNotificationsEnabled: boolean;
  /** v40 (الجولة 48 #5): شكل عرض المنتجات في نقطة البيع — الشبكة
   *  الحالية هي الافتراض. */
  posProductView: PosProductView;
}

const DEFAULTS: AppSettings = {
  storeName: 'متجر sela',
  storePhone: '',
  storeAddress: '',
  footerMessage: 'شكراً لتعاملكم معنا — لا يوجد إرجاع أو استبدال بعد الفاتورة',
  storeLogoPath: null,
  defaultPricingMode: 'RETAIL',
  // v37 (الجولة 45 #2ب): طريقة المسح الافتراضية أثناء البيع =
  //  الباركود فقط (طلب التاجر نصاً) — كانت «both».
  scannerMode: 'barcode',
  scannerModeTouched: false,
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
  storeMode: 'grocery',
  expiryAlertDays: DEFAULT_EXPIRY_ALERT_DAYS,
  systemNotificationsEnabled: true,
  posProductView: 'grid',
};

interface SettingsState {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
  reset: () => void;
}

function loadInitial(): AppSettings {
  const stored = getJson<Partial<AppSettings>>(KEYS.settings, {});
  const merged = {...DEFAULTS, ...stored};
  // v37 (الجولة 45 #2ب): الترحيل الأحادي — «both» المخزنة كانت
  //  مجرد افتراض قديم لا اختيار التاجر: إن لم يلمس التاجر
  //  الإعداد بنفسه (لا علم scannerModeTouched) يُرحَّل إلى
  //  «باركود فقط». أي اختيار صريح بعد اليوم يُحترم حرفياً ولا
  //  يُلمس مرة أخرى.
  if (!merged.scannerModeTouched && merged.scannerMode === 'both') {
    merged.scannerMode = 'barcode';
  }
  return merged;
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
