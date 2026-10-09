/**
 * PosScreen — نقطة البيع (v3).
 * ─────────────────────────────────────────────────────────────────
 * Loyverse-style product grid + camera sheet driven by the merchant's
 * chosen scanner engine (باركود / بصري / كلاهما from Settings) +
 * Square-style persistent cart with a dominant charge button.
 *
 * Cart lines support sellable units: products with unit rows (كرتونة
 * × 24 …) show a unit chip — tap it to switch the line's unit; stock
 * is always reserved in base pieces. Manual selling never depends on
 * the camera being available.
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  Alert,
  BackHandler,
  Dimensions,
  Image,
  Keyboard,
  LayoutAnimation,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  UIManager,
  View,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useNavigation} from '@react-navigation/native';
import {
  AppButton,
  Badge,
  EmptyState,
  MoneyText,
  Segmented,
  Stepper,
} from '../components/ui';
import {Icon} from '../components/Icon';
import {useCartStore, cartTotals, unitPriceFor} from '../stores/cartStore';
import {useCatalogStore} from '../stores/catalogStore';
import {useSettingsStore, type PosProductView} from '../stores/settingsStore';
import {usePrinterStore} from '../stores/printerStore';
import {useToastStore} from '../stores/toastStore';
import {useSilaStore} from '../stores/silaStore';
import {InvoiceService} from '../services/InvoiceService';
import {VoucherService, VoucherRedeemError} from '../services/VoucherService';
import {VouchersRepo} from '../services/sila/VouchersRepo';
import {getJson, setJson, KEYS} from '../storage/storage';
import {ProductRepo} from '../database/repositories/ProductRepo';
import {UnitRepo} from '../database/repositories/UnitRepo';
import {VariantRepo} from '../database/repositories/VariantRepo';
import {SilaRepo} from '../services/sila/SilaRepo';
import {SilaSync} from '../services/sila/SilaSync';
import {parseSilaQr} from '../services/sila/qr';
import {LocalDebtsRepo} from '../database/repositories/LocalDebtsRepo';
import {
  VoucherRedeemSheet,
  type VoucherCartContext,
} from './sila/VoucherRedeemSheet';
import type {LocalCustomerBalance, SilaCustomer} from '../core/types';
import {VisionRecognitionService} from '../services/vision/VisionRecognitionService';
import {
  cameraPermissionMessage,
  closeScannerNow,
  ensureCameraPermission,
  notifyScanResult,
  openAppSettings,
  scanBarcode,
  scanBarcodeContinuous,
  scanBothContinuous,
  scanVisualContinuous,
} from '../services/vision/scanFlow';
import {
  PlatformUtilsNative,
  requirePlatformUtils,
} from '../native/nativeBridge';
import {
  BASE_UNIT_NAME,
  QUICK_WEIGHTS,
  VISION_AMBIGUITY_MARGIN,
  VISION_FAST_PATH_EXTRA,
  VISION_MAX_UNITS_PER_PRODUCT,
  VISION_UNIT_EXTRA_MARGIN,
  VISION_UNIT_IOU,
  WEIGHT_UNIT_NAME,
  type ScannerMode,
} from '../core/config';
import {
  matchWindowProbes,
  selectDetections,
} from '../services/vision/embedding';
import {
  fonts,
  makeStyles,
  radius,
  spacing,
  typography,
  useThemeColors,
} from '../core/theme';
import {formatMoney, formatQty, parseNumber} from '../core/format';
import {baseUnitLabelOf, isWeightProduct, stockStateOf} from '../core/types';
import type {
  CartLine,
  Product,
  ProductUnit,
  ProductVariant,
} from '../core/types';

const GRID_COLUMNS = 3;
const SCREEN_WIDTH = Dimensions.get('window').width;
const GRID_TILE = Math.floor(
  (SCREEN_WIDTH - spacing.lg * 2 - spacing.sm * (GRID_COLUMNS - 1)) /
    GRID_COLUMNS,
);
/** v40 (الجولة 48 #5): عرض بطاقة الأشكال «بطاقات كبيرة» — عمودان
 *  بفجوة واحدة (الشكل المفضل لتصفح الملابس بصرياً). */
const CARD_TILE = Math.floor((SCREEN_WIDTH - spacing.lg * 2 - spacing.sm) / 2);

/** v9.2 (round-15 #4): ONE shared session context for every scan
 *  engine (barcode / visual / combined) — tracks the CONFIRMED add
 *  count, per-product counts for "×2, ×3…" confirmations, the
 *  lookalike candidates for the inline strip, and the weight
 *  products whose pads open when the window closes. */
function makeScanSession() {
  return {
    confirmed: 0,
    counts: new Map<number, number>(),
    ambiguous: [] as {product: Product; score: number}[],
    weightQueue: [] as Product[],
  };
}
type ScanSession = ReturnType<typeof makeScanSession>;

/** v9.2 (round-15 #4): the add-confirmation message — product name +
 *  how many times this session + its price, e.g.
 *  "أُضيف: حليب ١ لتر ×2 · 6.00 ₪". */
function addedMessage(
  session: ScanSession,
  product: Product,
  unitPrice: number,
  prefix = 'أُضيف',
): string {
  const count = session.counts.get(product.id) ?? 1;
  const price = unitPrice > 0 ? ` · ${formatMoney(unitPrice)}` : '';
  return `${prefix}: ${product.name}${count > 1 ? ` ×${count}` : ''}${price}`;
}

/** v9.2 (round-15 #2): the outcome of one barcode read — 'unknown'
 *  is fully SILENT (no banner, no counter, no prompt).
 *  v10 (round-16 #3): 'error' carries the REASON (نفدت الكمية …)
 *  so the LIVE scanner window can show it — a plain RN toast is
 *  invisible under the native window. */
type BarcodeOutcome =
  | {status: 'added'; name: string; product: Product; unitPrice: number}
  | {status: 'queued'; name: string}
  | {status: 'unknown'}
  | {status: 'error'; name?: string; reason?: string};

/** v31 (round-39 #3): topGap — عند تشغيل الشاشة داخل «وضع البيع
 *  السريع» فوق شاشة القفل يتعيّن استبدال حشوة شريط الحالة
 *  (insets.top) بحشوة صغيرة لأن شريط القفل فوقها يغطي الـ inset
 *  أصلاً — تمرير undefined (الوضع الطبيعي كتبويب رئيسي) يبقي
 *  السلوك الأصلي كما هو حرفياً. */
export function PosScreen({
  topGap,
}: {
  topGap?: number;
} = {}) {
  const c = useThemeColors();
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();

  const lines = useCartStore(state => state.lines);
  const pricingMode = useCartStore(state => state.pricingMode);
  const discount = useCartStore(state => state.discount);
  const addProduct = useCartStore(state => state.addProduct);
  const addWeighted = useCartStore(state => state.addWeighted);
  const addVariantLine = useCartStore(state => state.addVariantLine);
  const addBundleLine = useCartStore(state => state.addBundleLine);
  const addSizedLine = useCartStore(state => state.addSizedLine);
  const setLineUnit = useCartStore(state => state.setLineUnit);
  const increment = useCartStore(state => state.increment);
  const decrement = useCartStore(state => state.decrement);
  const removeLine = useCartStore(state => state.removeLine);
  const setDiscount = useCartStore(state => state.setDiscount);
  const setPricingMode = useCartStore(state => state.setPricingMode);
  const clear = useCartStore(state => state.clear);

  const products = useCatalogStore(state => state.products);
  const refreshCatalog = useCatalogStore(state => state.refresh);
  const embeddingsCount = useCatalogStore(state => state.embeddingsCount);

  const settings = useSettingsStore(state => state.settings);
  const updateSettings = useSettingsStore(state => state.update);
  const printerStatus = usePrinterStore(state => state.status);
  const toast = useToastStore(state => state.show);
  // v11 (SILA): pairing drives the debt button's readiness + the
  // pending-debts badge right on the checkout row.
  const silaPaired = useSilaStore(state => state.pairing != null);
  const silaPending = useSilaStore(state => state.pending);
  // v21 (round-27 #6): the cart's قسيمة button appears ONLY when the
  // merchant has an ACTIVE campaign in this store (his own switch on
  // the القسائم tab) — not merely when the device is paired.
  const silaActiveCampaigns = useSilaStore(state => state.activeCampaigns);

  const [search, setSearch] = useState('');
  /** v9 (round-13 #3): true while the search box holds KEYBOARD
   *  focus — the cart folds to a one-line summary strip so the
   *  product grid keeps the whole remaining height and the merchant
   *  can actually SEE and tap the results above the keyboard. */
  const [searchFocused, setSearchFocused] = useState(false);
  const [discountText, setDiscountText] = useState('');
  // v8: the scanner is a NATIVE full-screen activity — no in-RN
  // camera state left. scanBusy guards the launch. In 'both' mode
  // (v9.2) ONE combined window opens with in-camera engine switching.
  const [scanBusy, setScanBusy] = useState(false);
  // v40 (الجولة 48 #5): شكل عرض المنتجات في نقطة البيع — لوحة
  // الخيارات مفتوحة أم لا (INLINE بجانب صف جملة/مفرق — لا Modal
  // أبداً، درس هذا الروم)؛ الشكل نفسه محفوظ في الإعدادات
  //  والافتراض الشبكة الحالية.
  const [viewPickerOpen, setViewPickerOpen] = useState(false);
  const posView: PosProductView = settings.posProductView ?? 'grid';
  // v8.2 (round-11 #3): cart expand toggle — the cart grows to fill
  // the whole screen (grid folds away) so the merchant can review a
  // long sale comfortably, then shrinks back to keep selling.
  const [cartExpanded, setCartExpanded] = useState(false);
  // v42 (الجولة 50 #5): تصغير السلة — زر مخصص بجانب زر التكبير
  //  يطوي السلة كاملة إلى شريط سطر واحد (نفس شريط نظرة البحث)
  //  فيتحرر عرض الشبكة كله للتصفح؛ لمسة على الشريط تعيدها،
  //  وأي إضافة سطر جديد تعيدها تلقائياً كي يرى التاجر ما أُضيف.
  const [cartMinimized, setCartMinimized] = useState(false);
  // v42 (الجولة 50 #5): إعادة فتح السلة تلقائياً عند إضافة سطر
  //  جديد وهي مطوية — التاجر يرى فوراً أن المنتج أُضيف فعلاً.
  const prevLinesCountRef = useRef(0);
  useEffect(() => {
    if (lines.length > prevLinesCountRef.current) {
      setCartMinimized(false);
    }
    prevLinesCountRef.current = lines.length;
  }, [lines.length]);
  const [busy, setBusy] = useState(false);
  const [unitPickerLine, setUnitPickerLine] = useState<CartLine | null>(null);
  const [unitPickerRows, setUnitPickerRows] = useState<ProductUnit[] | null>(
    null,
  );
  // v8.3 (round-12 #4): the WEIGHT pad — a weight-sold product can
  // never be added as "one piece": tapping it (or scanning it) opens
  // this sheet so the merchant types/weighs the kg amount.
  const [weightProduct, setWeightProduct] = useState<Product | null>(null);
  /** v35 (الجولة 43): نافذة البيع الموحدة — لكل منتج نافذة بمحتوى
   *  مودّه قبل السلة (طلب التاجر):
   *  • clothing: موديل ملابس — لون + مقاس مفرقاً، أو ربطة بالجملة
   *    (قطعة من كل مقاس باللون، عددها وسعرها يُحسبان تلقائياً).
   *  • sizes: مطعم/كافيتريا بأحجام — حجم بسعره + كمية.
   *  • unit: صيدلية — وحدة البيع (شريط/علبة) + كمية.
   *  INLINE overlay — نفس درس روم الجهاز (لا Modal أبداً). */
  const [saleSheet, setSaleSheet] = useState<{
    kind: 'clothing' | 'sizes' | 'unit';
    product: Product;
  } | null>(null);
  /** موديلات انتظرت الماسح (باركود منتج بمتغيرات) — تفتح نوافذها
   *  واحدة تلو الأخرى حين يُغلق الماسح. */
  const [pendingSheets, setPendingSheets] = useState<Product[]>([]);
  const [weightUnitRows, setWeightUnitRows] = useState<ProductUnit[] | null>(
    null,
  );
  /** Weight products recognized DURING a continuous scan session
   *  — they wait here and their weight pads open one by one when the
   *  scanner closes (the Loyverse scale-item pattern). */
  const [pendingWeight, setPendingWeight] = useState<Product[]>([]);
  /** v43 (الجولة 51 #5): مرايا النافذتين المفتوحتين — سباق ازدواج
   *  الالتقاط/القراءة (ضغطة مصرّاعين متتابعتين أو قراءة باركود
   *  مكررة قبل أن يهبط closeScannerNow) كانت تُدخل المنتج نفسه في
   *  الطابور مرة ثانية بعد أن فُتحت نافذته، فتفتح نافذة البيع
   *  مرتين (بلاغ التاجر). المرآة تُقرأ لحظة الإدراج فتُقصّ التكرار
   *  حتى والنافذة مفتوحة — الفحص القديم كان يرى الطابور فقط وقد
   *  فرغته النافذة. */
  const saleSheetRef = useRef<{
    kind: 'clothing' | 'sizes' | 'unit';
    product: Product;
  } | null>(null);
  const weightProductRef = useRef<Product | null>(null);
  useEffect(() => {
    saleSheetRef.current = saleSheet;
  }, [saleSheet]);
  useEffect(() => {
    weightProductRef.current = weightProduct;
  }, [weightProduct]);
  /** v43: إدراج نافذة بيع في الطابور — مضاد للتكرار ضد الطابور
   *  والنافذة المفتوحة الآن معاً. */
  const queueSaleSheet = useCallback((product: Product) => {
    setPendingSheets(prev => {
      if (prev.some(p => p.id === product.id)) {
        return prev;
      }
      if (
        saleSheetRef.current != null &&
        saleSheetRef.current.product.id === product.id
      ) {
        return prev;
      }
      return [...prev, product];
    });
  }, []);
  /** v43: إدراج لوحة وزن في الطابور — نفس الحماية. */
  const queueWeightPad = useCallback((product: Product) => {
    setPendingWeight(prev => {
      if (prev.some(entry => entry.id === product.id)) {
        return prev;
      }
      if (
        weightProductRef.current != null &&
        weightProductRef.current.id === product.id
      ) {
        return prev;
      }
      return [...prev, product];
    });
  }, []);
  /** v9 (round-13 #1): the visual-scan candidate strip — an INLINE
   *  row (a regular View, NOT a Modal: this ROM renders RN Modals
   *  black right after the native scanner window closes, the exact
   *  v8.1.0 black-screen bug). Confident matches add straight to
   *  the cart and leave the next candidates here for one-tap
   *  corrections; a below-threshold shot shows the top candidates
   *  for the merchant to pick. */
  const [visionMatches, setVisionMatches] = useState<
    {product: Product; score: number}[] | null
  >(null);
  /** v11 (SILA §9.2): the debt confirmation sheet — populated after a
   *  successful customer-QR scan; confirming creates the sale + the
   *  debt_queue row atomically. null = sheet closed. */
  const [debtConfirm, setDebtConfirm] = useState<{
    customerId: string | null;
    customerName: string;
    customerPhoneLast4: string | null;
    customerCard: string | null;
    offlineQr: string | null;
    amountMinor: number;
    amountSource: 'card' | 'offline' | 'picker' | 'local';
    /** v16 (round-22 #4): the LOCAL debt-book account when the sale
     *  is charged on the store's own customer (دفتر المتجر). */
    localCustomerId?: number;
    /** v17 (round-23 #3): the customer's PREPAID credit in صِلة
     *  (cached from the server feed) — when > 0 the store knows the
     *  invoice is covered by that much (the server consumes the
     *  credit on upload; the books mark the covered part PAID). */
    creditMinor?: number;
  } | null>(null);
  /** v11: true while the customer-QR camera window is open. */
  const [debtBusy, setDebtBusy] = useState(false);
  /** v15 (round-21 #5): the debt chooser — scan the customer's QR or
   *  pick a known صِلة customer straight from the cached list. */
  const [debtChooser, setDebtChooser] = useState(false);
  // v20: the voucher redemption sheet — «صرف قسيمة صلة» from the
  // checkout row (cart-tied: the goods become the INV-V sale).
  const [voucherSheet, setVoucherSheet] = useState(false);
  /** v22 (round-28 #1): voucher redemptions the server ACCEPTED but
   *  whose cart was SMALLER than the voucher — the handover is
   *  blocked until the cashier tops the cart up (to the voucher
   *  value at least) and completes from the banner.
   *  v43 (الجولة 51 #3): bookingError — حين فشل إنشاء فاتورة البضاعة
   *  محلياً بعد نجاح الصرف (نفس اللافتة، والسبب معروض)، واللافتة
   *  الآن تُستعاد من قاعدة البيانات عند فتح الشاشة (لا تضيع بإعادة
   *  تشغيل التطبيق) ما لم يُلغها التاجر صراحة. */
  const [pendingVouchers, setPendingVouchers] = useState<
    {
      localId: number;
      valueMinor: number;
      campaignName: string;
      shortfallMinor: number;
      receiptRef: string;
      bookingError?: string;
    }[]
  >([]);
  const [voucherBusy, setVoucherBusy] = useState(false);
  const [customerPicker, setCustomerPicker] = useState(false);
  const [pickerCustomers, setPickerCustomers] = useState<SilaCustomer[]>([]);
  const [pickerQuery, setPickerQuery] = useState('');
  /** v16 (round-22 #4): the LOCAL debt-book picker — customers of
   *  this store (دفتر المتجر), searched live, charged directly. */
  const [localPicker, setLocalPicker] = useState(false);
  const [localCustomers, setLocalCustomers] = useState<LocalCustomerBalance[]>(
    [],
  );
  const [localQuery, setLocalQuery] = useState('');

  const scannerMode: ScannerMode = settings.scannerMode;
  const barcodeActive = scannerMode === 'barcode' || scannerMode === 'both';
  const visualActive = scannerMode === 'visual' || scannerMode === 'both';

  const totals = useMemo(() => cartTotals(lines, discount), [lines, discount]);

  useEffect(() => {
    if (discount === 0) {
      setDiscountText('');
    }
  }, [discount]);

  // v21 (round-27 #6): the قسيمة button's visibility depends on the
  // ACTIVE-campaign count, which changes on the صِلة screen (enable/
  // disable) and after every settlement sync — refresh on every
  // focus + on every pairing change.
  useEffect(() => {
    void useSilaStore.getState().refreshActiveCampaigns();
  }, [silaPaired]);
  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', () => {
      void useSilaStore.getState().refreshActiveCampaigns();
    });
    return unsubscribe;
  }, [navigation]);

  /** v43 (الجولة 51 #3): استرجاع لافتات الإتمام من قاعدة البيانات —
   *  كل عملية صرف قسيمة ناجحة على الخادم ومقيّدة بسلة بلا فاتورة
   *  بضاعة بعد (قسيمة «أكمل السلة» أو فشل إنشاء الفاتورة) تظهر
   *  لافتتها هنا عند فتح الشاشة وعند كل عودة إليها. قبل v43 كانت
   *  اللافتات في الذاكرة فقط: إغلاق التطبيق يفقدها إلى الأبد،
   *  وفشل الفاتورة الصامت يجعل القيمة تدخل ديون الحملات ولا تدخل
   *  مبيعات اليوم أبداً (بلاغ التاجر). ما ألغاه التاجر صراحة يُحترم
   *  (مجموعة MMKV) — والمطالبة تبقى في دفتر الحملات كما وُعد.
   *  لا تُسترجع إلا القسائم الشرائية (المصنّف الموحّد). */
  const recoverPendingVouchers = useCallback(async () => {
    try {
      const rows = await VouchersRepo.incompleteCartRedemptions();
      if (rows.length === 0) {
        return;
      }
      const dismissed = new Set<number>(
        getJson<number[]>(KEYS.voucherHandoverDismissed, []),
      );
      const recovered = rows
        .filter(row => !dismissed.has(row.local_id))
        .map(row => ({
          localId: row.local_id,
          valueMinor: row.value_minor,
          campaignName: row.campaign_name ?? 'حملة صِلة',
          shortfallMinor: 0,
          receiptRef: row.pos_receipt_ref ?? '',
        }));
      if (recovered.length === 0) {
        return;
      }
      setPendingVouchers(previous => {
        const merged = [...previous];
        for (const item of recovered) {
          if (!merged.some(entry => entry.localId === item.localId)) {
            merged.push(item);
          }
        }
        return merged;
      });
    } catch {
      // قاعدة بيانات فتية قبل أول ترحيل — بلا لافتات.
    }
  }, []);

  useEffect(() => {
    void recoverPendingVouchers();
  }, [recoverPendingVouchers]);

  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', () => {
      void recoverPendingVouchers();
    });
    return unsubscribe;
  }, [navigation, recoverPendingVouchers]);

  /** v22 (round-28 #1): completes a blocked (needs-top-up) voucher
   *  redemption — the server already redeemed it, the cashier has
   *  now topped the cart up: create the INV-V goods sale from the
   *  CURRENT cart, print, clear and drop the banner. The service
   *  re-verifies the cart ≥ voucher rule before booking. */
  const completePendingVoucher = useCallback(
    async (info: {
      localId: number;
      valueMinor: number;
      campaignName: string;
    }) => {
      if (busy || debtBusy || voucherBusy) {
        return;
      }
      const totalMinor = Math.round(totals.total * 100);
      if (lines.length === 0 || totalMinor < info.valueMinor) {
        toast(
          `أضف بضاعة بفارق ${((info.valueMinor - totalMinor) / 100).toFixed(
            2,
          )} ₪ على الأقل — السلة يجب ألا تقل عن قيمة القسيمة`,
          'error',
          4500,
        );
        return;
      }
      setVoucherBusy(true);
      try {
        await VoucherService.completeCartRedemption(
          info.localId,
          {lines, discount, pricingMode},
          printerStatus === 'connected',
          {
            storeName: settings.storeName,
            storePhone: settings.storePhone,
            footerMessage: settings.footerMessage,
            storeLogoPath: settings.storeLogoPath,
            paperWidth: settings.paperWidth,
            codepage: settings.codepage,
            showProfit: settings.showProfitOnReceipt,
          },
          message => toast(`اكتمل الصرف لكن الطباعة فشلت: ${message}`, 'error'),
        );
        setPendingVouchers(previous =>
          previous.filter(item => item.localId !== info.localId),
        );
        clear();
        setDiscountText('');
        void refreshCatalog();
        void useSilaStore.getState().refreshActiveCampaigns();
        toast(
          `اكتمل صرف قسيمة «${info.campaignName}» وسُلّمت البضاعة`,
          'success',
        );
      } catch (error) {
        if (error instanceof VoucherRedeemError) {
          toast(error.message, 'error', 4500);
        } else {
          toast(
            error instanceof Error ? error.message : 'تعذر إتمام الصرف',
            'error',
          );
        }
      } finally {
        setVoucherBusy(false);
      }
    },
    [
      busy,
      debtBusy,
      voucherBusy,
      totals,
      lines,
      discount,
      pricingMode,
      printerStatus,
      settings,
      clear,
      refreshCatalog,
      toast,
    ],
  );

  /** v22 (round-28 #1): drop a blocked redemption's banner — the
   *  claim stays recorded in دفتر الحملات (the server redeemed the
   *  voucher); the merchant completes the handover manually.
   *  v43 (الجولة 51 #3): الإلغاء يُحفظ في MMKV — لافتة الاسترجاع
   *  عند فتح الشاشة لا تُعيدها (قرار التاجر يُحترم)، والمطالبة
   *  تبقى في دفتر الحملات كما أخبره التنبيه. */
  const dismissPendingVoucher = useCallback((localId: number) => {
    Alert.alert(
      'إلغاء إتمام القسيمة',
      'القسيمة مصروفة على خادم صلة ومطالبتك على المؤسسة محفوظة في دفتر الحملات، لكن لن تُسجّل فاتورة بضاعة لها. هل أنت متأكد؟',
      [
        {text: 'تراجع', style: 'cancel'},
        {
          text: 'إلغاء الإتمام',
          style: 'destructive',
          onPress: () => {
            setPendingVouchers(previous =>
              previous.filter(item => item.localId !== localId),
            );
            try {
              const dismissed = getJson<number[]>(
                KEYS.voucherHandoverDismissed,
                [],
              );
              if (!dismissed.includes(localId)) {
                setJson(KEYS.voucherHandoverDismissed, [
                  ...dismissed,
                  localId,
                ]);
              }
            } catch {
              // الحفظ استطلاعي — الإلغاء يعمل لهذه الجلسة على الأقل.
            }
          },
        },
      ],
    );
  }, []);

  // v8.2: a sale that empties the cart also folds the expanded view
  // back down — the grid must return for the next customer.
  useEffect(() => {
    if (cartExpanded && lines.length === 0) {
      setCartExpanded(false);
    }
  }, [lines.length, cartExpanded]);

  const beep = useCallback(() => {
    if (!settings.soundEnabled) {
      return;
    }
    try {
      void requirePlatformUtils().beep(0);
    } catch {
      // Sound is a nicety.
    }
  }, [settings.soundEnabled]);

  /** v8.3: opens the weight pad for a product (loads its sellable
   *  sub-units — وقية و غيرها — for the quick-add rows). */
  const openWeightPad = useCallback((product: Product) => {
    setWeightProduct(product);
    setWeightUnitRows(null);
    UnitRepo.listForProduct(product.id)
      .then(rows => setWeightUnitRows(rows))
      .catch(() => setWeightUnitRows([]));
  }, []);

  const tryAdd = useCallback(
    (product: Product, unit?: ProductUnit | null, quantity?: number) => {
      // v8.3 (round-12 #4): weight-sold products NEVER add as whole
      // pieces — the weight pad opens instead (type kg or tap وقية /
      // نصف كغ quick chips; price = kg × kilo price).
      if (isWeightProduct(product)) {
        openWeightPad(product);
        return;
      }
      // v38 (الجولة 46 #5): الكمية المختارة في نافذة البيع تمر الآن
      //  فعلاً إلى السلة — كانت تُعرض فوق الزر ثم تُتجاهل.
      const result = addProduct(
        product,
        pricingMode,
        unit ?? null,
        quantity ?? 1,
      );
      if (result.added) {
        beep();
      } else if (result.reason) {
        toast(result.reason, 'error');
      }
    },
    [addProduct, pricingMode, beep, toast, openWeightPad],
  );

  /** v35 (الجولة 43): توجيه المنتج لنافذة البيع المناسبة لموده —
   *  ملابس بمتغيرات (لون × مقاس) أو صنف بأحجام أو صيدلية بوحداتها،
   *  وما عداهم يُضاف مباشرة (الأسرع للمجالات البسيطة). */
  const openSaleSheet = useCallback(
    (product: Product) => {
      if (isWeightProduct(product)) {
        openWeightPad(product);
        return;
      }
      const variants = product.variants ?? [];
      const hasClothing = variants.some(v => v.kind === 'variant');
      const hasSizes = variants.some(v => v.kind === 'size');
      if (hasClothing) {
        setSaleSheet({kind: 'clothing', product});
        return;
      }
      if (hasSizes) {
        setSaleSheet({kind: 'sizes', product});
        return;
      }
      if (settings.storeMode === 'pharmacy') {
        setSaleSheet({kind: 'unit', product});
        return;
      }
      tryAdd(product);
    },
    [openWeightPad, settings.storeMode, tryAdd],
  );

  // v35: نافذة الماسح المؤجلة — تفتح حين لا يكون هناك نافذة مفتوحة.
  useEffect(() => {
    if (saleSheet == null && pendingSheets.length > 0) {
      const [next, ...rest] = pendingSheets;
      setPendingSheets(rest);
      openSaleSheet(next);
    }
  }, [saleSheet, pendingSheets, openSaleSheet]);

  // v8.3: queued weight pads — one scanner session can recognize
  // several weight products; each gets its pad in turn when the
  // native window closes.
  // v39 (الجولة 47): مع الإغلاق الفوري عند التعرف على منتج وزن،
  //  اللوحة تفتح فوق شاشة البيع مباشرة لحظة إغلاق نافذة الماسح.
  useEffect(() => {
    if (weightProduct == null && pendingWeight.length > 0) {
      const [next, ...rest] = pendingWeight;
      setPendingWeight(rest);
      openWeightPad(next);
    }
  }, [weightProduct, pendingWeight, openWeightPad]);

  /** v8.3: confirm the weight pad → fractional kg line in the cart.
   *  v9.2 (round-15 #4): a CONFIRMATION toast spells out exactly
   *  what landed in the cart — weight × kilo price = total — so the
   *  merchant never doubts a weight sale again. */
  const confirmWeight = useCallback(
    (product: Product, kg: number, unit: ProductUnit | null) => {
      const result = addWeighted(
        product,
        useCartStore.getState().pricingMode,
        kg,
        unit,
      );
      if (result.added) {
        beep();
        const unitPrice =
          unit != null
            ? unitPriceFor(product, unit, useCartStore.getState().pricingMode)
            : product.retail_price;
        const effectiveMode = useCartStore.getState().pricingMode;
        const basePrice =
          effectiveMode === 'WHOLESALE'
            ? product.wholesale_price
            : product.retail_price;
        toast(
          unit != null
            ? `أُضيفت وحدة ${unit.unitName} من ${product.name} — ${formatQty(
                kg * unit.conversion,
              )} ${WEIGHT_UNIT_NAME} = ${formatMoney(unitPrice)}`
            : `أُضيف ${formatQty(kg)} ${WEIGHT_UNIT_NAME} من ${
                product.name
              } — ${formatQty(kg)} × ${formatMoney(basePrice)} = ${formatMoney(
                kg * basePrice,
              )}`,
          'success',
        );
        setWeightProduct(null);
      } else if (result.reason) {
        toast(result.reason, 'error');
      }
    },
    [addWeighted, beep, toast],
  );

  /** v9.2 (round-15 #1): the weight pad now uses a BUILT-IN numeric
   *  keypad — no system keyboard is ever summoned, so there is
   *  nothing to dismiss and no KeyboardAvoidingView to get stuck:
   *  closing (hardware back / dim / إلغاء) simply unmounts the
   *  sheet and the POS keeps its exact shape, every time. */
  const closeWeightSheet = useCallback(() => {
    setWeightProduct(null);
    setWeightUnitRows(null);
  }, []);

  /** v9.2: shared camera-permission guard for every engine entry. */
  const guardCameraPermission = useCallback(async (): Promise<boolean> => {
    const permission = await ensureCameraPermission();
    if (permission !== 'granted') {
      Alert.alert('إذن الكاميرا مطلوب', cameraPermissionMessage(permission), [
        {text: 'إغلاق', style: 'cancel'},
        {
          text: 'فتح الإعدادات',
          onPress: () => {
            void openAppSettings();
          },
        },
      ]);
      return false;
    }
    return true;
  }, []);

  /**
   * v10 (round-16 #3 + #4): the CASCADE photo-recognition pipeline
   * shared by the visual and combined sessions.
   * ─────────────────────────────────────────────────────────────────
   * STEP 1 — fast path: ONE whole-frame probe against the new
   * EfficientNet-B0 model. A single product roughly filling the
   * frame (the everyday case) resolves after ONE inference — faster
   * than the old four-crop ensemble while running a far stronger
   * model (lookalike products separate cleanly).
   *
   * STEP 2 — multi-product: a center window + a 3×3 grid of local
   * windows each read ONE item; greedy selection with per-window
   * lookalike margins, same-product unit counting (two bottles of
   * the same soda side by side = ×2) and near-miss candidates for
   * the strip. EVERY product found is added to the cart in one shot.
   *
   * STOCK (round-16 #3): exhausted products never silently queue or
   * add — a clear نفدت الكمية banner names the product inside the
   * scan window, for piece AND weight products alike.
   */
  const processVisionPhoto = useCallback(
    async (photoPath: string, session: ScanSession) => {
      try {
        await VisionRecognitionService.loadModel();
        const index = useCatalogStore.getState().embeddingsIndex;
        if (index == null || index.ids.length === 0) {
          await notifyScanResult(
            false,
            'لا توجد بصمات بصرية بعد — سجّل صور المنتجات من شاشة المنتج',
          );
          return;
        }
        const threshold = useSettingsStore.getState().settings.matchThreshold;
        const allProducts = useCatalogStore.getState().products;

        /** Base units of a product already reserved by the cart. */
        const inCartBase = (productId: number): number =>
          useCartStore
            .getState()
            .lines.filter(line => line.productId === productId)
            .reduce((sum, line) => sum + line.quantity * line.conversion, 0);

        /**
         * Adds one CONFIRMED detection (or queues its weight pad),
         * respecting stock. Returns the confirmation message part or
         * the failure part for the summary banner.
         */
        const deliver = (
          product: Product,
          units: number,
        ): {part: string; ok: boolean; added: number} => {
          const mode = useCartStore.getState().pricingMode;
          if (isWeightProduct(product)) {
            const remaining = product.stock_quantity - inCartBase(product.id);
            if (remaining <= 0) {
              return {
                part: `نفدت كمية ${product.name}`,
                ok: false,
                added: 0,
              };
            }
            session.confirmed += 1;
            session.counts.set(
              product.id,
              (session.counts.get(product.id) ?? 0) + 1,
            );
            if (!session.weightQueue.some(entry => entry.id === product.id)) {
              session.weightQueue.push(product);
            }
            // v39 (الجولة 47 #7): منتج وزن (فواكه/خضار) — سعره لا
            //  يُعرف إلا بإدخال وزنه من نافذة البيع؛ فور التعرف عليه
            //  بصرياً تُغلق نافذة الماسح وتفتح لوحة وزنه فوقها مباشرة
            //  (طلب التاجر حرفياً: «فور التقاطه والتعرف عليه أن يفتح
            //  نافذة البيع الخاصة به»). الكشف عن باقي الأصناف في
            //  الصورة نفسها يكتمل أولاً ثم تُغلق النافذة.
            // v43 (الجولة 51 #5): الإدراج عبر الدالة المدمجة — يفحص
            //  الطابور والنافذة المفتوحة معاً فيقتل التكرار.
            queueWeightPad(product);
            void closeScannerNow();
            return {
              part: `${product.name} — أدخل وزنه الآن`,
              ok: true,
              added: 1,
            };
          }
          // v40 (الجولة 48 #1): منتج متعدد الخصائص (ملابس/أحذية بلون
          //  ومقاس، أو أحجام مطعم بسعر لكل حجم) — البصمة للمنتج
          //  ككل لا للمتغير بعينه، فالبيع بالقطعة المباشر لا معنى
          //  له (أي لون؟ أي حجم؟ بأي سعر؟). فور التعرف يُغلق الماسح
          //  وتفتح نافذة البيع الخاصة به فوق شاشة نقطة البيع ليختار
          //  الكاشير اللون والمقاس أو الحجم ثم تُضاف السلة بشكل
          //  طبيعي — نفس مسار الباركود العام تماماً.
          if (
            (product.variants ?? []).some(
              v => v.kind === 'variant' || v.kind === 'size',
            )
          ) {
            // منتج متتبع ولا متغير منه متوفر = نفد كله؛ بلا تتبع
            // (مطعم/كافيتريا غالباً) تفتح النافذة دائماً.
            const variantsHaveStock =
              product.stock_untracked === 1 ||
              (product.variants ?? []).some(v => v.stock_quantity > 0);
            if (!variantsHaveStock) {
              return {
                part: `نفدت كمية ${product.name}`,
                ok: false,
                added: 0,
              };
            }
            session.confirmed += 1;
            session.counts.set(
              product.id,
              (session.counts.get(product.id) ?? 0) + 1,
            );
            queueSaleSheet(product);
            void closeScannerNow();
            return {
              part: `${product.name} — اختر الخصائص الآن`,
              ok: true,
              added: 1,
            };
          }
          let added = 0;
          let blockedReason: string | null = null;
          for (let i = 0; i < units; i += 1) {
            const result = addProduct(product, mode, null);
            if (result.added) {
              added += 1;
            } else {
              blockedReason = result.reason ?? `نفدت كمية ${product.name}`;
              break;
            }
          }
          if (added > 0) {
            session.confirmed += added;
            session.counts.set(
              product.id,
              (session.counts.get(product.id) ?? 0) + added,
            );
          }
          const price =
            mode === 'WHOLESALE'
              ? product.wholesale_price
              : product.retail_price;
          const part =
            added > 0
              ? `${product.name}${added > 1 ? ` ×${added}` : ''}${
                  price > 0 && added > 0
                    ? ` · ${formatMoney(price * added)}`
                    : ''
                }${added < units ? ` — ${blockedReason}` : ''}`
              : blockedReason ?? `نفدت كمية ${product.name}`;
          return {part, ok: added > 0, added};
        };

        // ── STEP 1: whole-frame fit probe (the fast single path). ──
        const fitVector = await VisionRecognitionService.embedFitProbe(
          photoPath,
        );
        const fitHits = matchWindowProbes(
          [{spec: {cx: 0.5, cy: 0.5, w: 1}, vector: fitVector}],
          index.flat,
          index.ids,
          index.dim,
        );
        const fit = fitHits[0] ?? null;
        const fitAmbiguous =
          fit != null &&
          fit.runnerUpId != null &&
          fit.score - fit.runnerUpScore < VISION_AMBIGUITY_MARGIN;
        if (
          fit != null &&
          fit.score >= threshold + VISION_FAST_PATH_EXTRA &&
          !fitAmbiguous
        ) {
          const product = allProducts.find(p => p.id === fit.productId);
          if (product != null) {
            const outcome = deliver(product, 1);
            if (outcome.ok) {
              beep();
              await notifyScanResult(true, `أُضيف: ${outcome.part}`);
            } else {
              await notifyScanResult(false, outcome.part);
            }
            return;
          }
        }

        // ── STEP 2: the multi-product window pass. ──
        const probes = await VisionRecognitionService.embedWindowProbes(
          photoPath,
        );
        const hits = matchWindowProbes(
          probes,
          index.flat,
          index.ids,
          index.dim,
        );
        const selection = selectDetections(hits, {
          threshold,
          margin: VISION_AMBIGUITY_MARGIN,
          unitIou: VISION_UNIT_IOU,
          unitExtra: VISION_UNIT_EXTRA_MARGIN,
          maxUnits: VISION_MAX_UNITS_PER_PRODUCT,
        });

        // Fallback: the windows missed but the whole frame was a
        // clean single match → classic single add.
        if (
          selection.detections.length === 0 &&
          fit != null &&
          fit.score >= threshold &&
          !fitAmbiguous
        ) {
          const product = allProducts.find(p => p.id === fit.productId);
          if (product != null) {
            const outcome = deliver(product, 1);
            if (outcome.ok) {
              beep();
              await notifyScanResult(true, `أُضيف: ${outcome.part}`);
            } else {
              await notifyScanResult(false, outcome.part);
            }
            return;
          }
        }

        if (selection.detections.length === 0) {
          // Nothing confident — keep the near-miss candidates for
          // the strip that appears when the window closes.
          await notifyScanResult(
            fitAmbiguous,
            fitAmbiguous
              ? 'منتجان متشابهان — سيظهران عند الإغلاق لتختار الصحيح'
              : 'لم يتم التعرف — اقترب أكثر واملأ الإطار بالمنتج ثم أعد التصوير',
          );
          for (const candidate of selection.ambiguous.slice(0, 3)) {
            const product = allProducts.find(p => p.id === candidate.productId);
            if (
              product != null &&
              !session.ambiguous.some(entry => entry.product.id === product.id)
            ) {
              session.ambiguous.push({product, score: candidate.score});
            }
          }
          if (fit != null && fit.score < threshold - 0.05) {
            const product = allProducts.find(p => p.id === fit.productId);
            if (
              product != null &&
              !session.ambiguous.some(entry => entry.product.id === product.id)
            ) {
              session.ambiguous.push({product, score: fit.score});
            }
          }
          return;
        }

        // ── Deliver EVERY detected product in one summary banner. ──
        const okParts: string[] = [];
        const failParts: string[] = [];
        for (const detection of selection.detections) {
          const product = allProducts.find(p => p.id === detection.productId);
          if (product == null) {
            continue;
          }
          const outcome = deliver(product, detection.units);
          if (outcome.ok) {
            okParts.push(outcome.part);
          } else {
            failParts.push(outcome.part);
          }
        }
        if (okParts.length > 0) {
          beep();
        }
        const summary =
          (okParts.length > 1
            ? `أُضيف ${okParts.length} منتجات: ${okParts.join(' + ')}`
            : `أُضيف: ${okParts.join('')}`) +
          (failParts.length > 0 ? ` · ${failParts.join(' · ')}` : '');
        await notifyScanResult(okParts.length > 0, summary || 'لم يتم التعرف');
      } catch (error) {
        await notifyScanResult(
          false,
          error instanceof Error
            ? `فشل تحليل الصورة: ${error.message}`
            : 'فشل تحليل الصورة — أعد التصوير',
        );
      } finally {
        // The window pass cached a decode of this photo — free it,
        // then delete the scan file itself (thumbnails/fingerprints
        // are already stored).
        void VisionRecognitionService.releaseDecodeCache();
        if (PlatformUtilsNative != null) {
          void PlatformUtilsNative.deleteFile(photoPath).catch(() => {});
        }
      }
    },
    // v43 (الجولة 51 #5): مساعدات الإدراج المضادة للتكرار دخلت
    //  التبعيات (ثابتة المستقر بذاتها).
    [addProduct, beep, queueSaleSheet, queueWeightPad],
  );

  /** v9.2: the post-close settle step shared by the visual and
   *  combined sessions — queued weight pads open one by one, the
   *  summary confirms the session's confirmed count, and lookalike
   *  candidates land in the inline strip for one-tap correction. */
  const settleScanSession = useCallback(
    (session: ScanSession, engineLabel: string) => {
      if (session.weightQueue.length > 0) {
        setPendingWeight(prev => {
          const merged = [...prev];
          for (const product of session.weightQueue) {
            if (!merged.some(entry => entry.id === product.id)) {
              // v43 (الجولة 51 #5): الدمج يفحص اللوحة المفتوحة الآن
              //  أيضاً — آخر صورة في الطابور قد تكون تكراراً لمنتج
              //  فُتحت لوحته للتو.
              if (
                weightProductRef.current == null ||
                weightProductRef.current.id !== product.id
              ) {
                merged.push(product);
              }
            }
          }
          return merged;
        });
      }
      if (session.confirmed > 0) {
        toast(
          `اكتملت جلسة ${engineLabel} — أُضيف ${session.confirmed} منتج للسلة`,
          'success',
        );
      }
      if (session.ambiguous.length > 0) {
        const sorted = [...session.ambiguous].sort((a, b) => b.score - a.score);
        setVisionMatches(sorted.slice(0, 4));
      }
    },
    [toast],
  );

  /**
   * v9.1 (round-14 #2) VISUAL SCAN — the CONTINUOUS multi-shot
   * session (the recognition itself lives in processVisionPhoto):
   * the native camera window STAYS OPEN — the merchant photographs
   * product after product, one deliberate shutter press each (the
   * exact v8.1.0 capture pipeline — no auto-capture loop, which is
   * what crashed v8.2/v8.3). Confident matches go straight into
   * the cart with the live in-window confirmation; weight products
   * queue their pads; ambiguous shots collect candidates for the
   * inline strip that appears the moment the merchant closes it.
   */
  const runVisionScan = useCallback(async () => {
    if (scanBusy) {
      return;
    }
    if (!(await guardCameraPermission())) {
      return;
    }
    const index = useCatalogStore.getState().embeddingsIndex;
    if (index == null || index.ids.length === 0) {
      toast(
        'لا توجد بصمات بصرية محفوظة — سجّل صور المنتجات من شاشة المنتج أولاً',
        'error',
      );
      return;
    }
    setScanBusy(true);
    setVisionMatches(null);
    const session = makeScanSession();
    /** Serializes photo processing — the shutter can fire faster
     *  than the 4-crop ensemble completes on slow devices. */
    const queue: string[] = [];
    let processing = false;
    const drain = async () => {
      if (processing) {
        return;
      }
      processing = true;
      try {
        while (queue.length > 0) {
          const next = queue.shift();
          if (next != null) {
            await processVisionPhoto(next, session);
          }
        }
      } finally {
        processing = false;
      }
    };
    // The LAST photo may still be mid-recognition when the merchant
    // closes the scanner — the settle step awaits this so its result
    // is never lost.
    let drainPromise: Promise<void> = Promise.resolve();

    try {
      await scanVisualContinuous(path => {
        queue.push(path);
        drainPromise = drain();
      });
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'فشل المسح البصري',
        'error',
      );
    } finally {
      // The scanner window has closed — let the LAST in-flight photo
      // finish before settling (its result must count too).
      try {
        await drainPromise;
      } catch {
        // A failed last photo must never break the settle step.
      }
      setScanBusy(false);
      settleScanSession(session, 'المسح البصري');
    }
  }, [
    scanBusy,
    toast,
    processVisionPhoto,
    settleScanSession,
    guardCameraPermission,
  ]);

  /** v9: adds a candidate from the inline strip (weight products
   *  open the pad instead). v35: منتجات المتغيرات تفتح نافذتها. */
  const pickVisionMatch = useCallback(
    (product: Product) => {
      setVisionMatches(null);
      if (isWeightProduct(product)) {
        beep();
        openWeightPad(product);
        return;
      }
      if ((product.variants ?? []).some(v => v.kind === 'variant')) {
        beep();
        setSaleSheet({kind: 'clothing', product});
        return;
      }
      const result = addProduct(
        product,
        useCartStore.getState().pricingMode,
        null,
      );
      if (result.added) {
        beep();
      } else if (result.reason) {
        toast(result.reason, 'error');
      }
    },
    [addProduct, beep, toast, openWeightPad],
  );

  /**
   * Barcode read → exact product lookup → cart add.
   * v8.3 (round-12 #4): weight products queue their weight pad for
   *  when the scanner closes — no invented whole-kilo adds.
   * v9.2 (round-15 #2): an UNREGISTERED barcode is now completely
   *  SILENT — no "غير مسجل" banner, no end-of-session prompt, no
   *  counter bump. The merchant asked for exactly that: scan, and
   *  only registered products respond.
   */
  const handleBarcode = useCallback(
    async (code: string): Promise<BarcodeOutcome | void> => {
      try {
        // 1. Base product barcode.
        // v41 (الجولة 49 #4): جذر «الماسح لا يفتح نافذة البيع» —
        //  findByBarcode يعيد صف المنتج الخام من قاعدة البيانات بلا
        //  مصفوفة المتغيرات (variants)، فكان فحص الخصائص تحته يسقط
        //  دائماً ويُضاف منتج الملابس/الأحجام للسلة مباشرة بوحدة
        //  الأساس. الحل: إن كان العلم has_variants مرفوعاً نحمّل
        //  صفوف متغيراته الحية ونلصقها به قبل أي قرار — فيعمل مسار
        //  «أغلق الماسح وافتح نافذة البيع» الموجود أصلاً كما صُمم.
        const found = await ProductRepo.findByBarcode(code);
        const product =
          found != null &&
          found.has_variants === 1 &&
          (found.variants ?? []).length === 0
            ? {
                ...found,
                variants: await VariantRepo.listByProduct(found.id),
              }
            : found;
        if (product != null) {
          if (isWeightProduct(product)) {
            // v10 (round-16 #3): an exhausted WEIGHT product must not
            // queue its pad silently — say نفدت الكمية in the window.
            const inCart = useCartStore
              .getState()
              .lines.filter(line => line.productId === product.id)
              .reduce((sum, line) => sum + line.quantity * line.conversion, 0);
            if (product.stock_quantity - inCart <= 0) {
              return {
                status: 'error',
                name: product.name,
                reason: `نفدت الكمية — ${product.name}`,
              };
            }
            // v43 (الجولة 51 #5): الإدراج عبر الدالة المدمجة — يفحص
            //  الطابور والنافذة المفتوحة معاً فيقتل التكرار.
            queueWeightPad(product);
            beep();
            // v39 (الجولة 47 #2+#7): منتج وزن — سعره لا يعرفه إلا
            //  لوحة الوزن (الوزن يُدخل يدوياً والباركود لا يستطيع
            //  تسعيره) — نافذة الماسح تُغلق فور التعرف فتفتح لوحة
            //  الوزن فوقها مباشرة بدل انتظار إغلاق التاجر للماسح.
            await closeScannerNow();
            return {status: 'queued', name: product.name};
          }
          const mode = useCartStore.getState().pricingMode;
          // v35 (الجولة 43): منتج بمتغيرات (ملابس) — نافذة اللون
          //  والمقاس تنتظر إغلاق الماسح ثم تفتح (المسار المباشر
          //  يبيع كل مقاس كيف؟).
          //  v39 (الجولة 47 #2): تفتح فوراً — الماسح يُغلق نفسه لحظة
          //  التعرف على منتج متعدد الخصائص (ملابس/أحذية) فيختار
          //  الكاشير اللون والمقاس ويضاف للسلة في الحال (طلب التاجر
          //  نصاً: «يجب أن يفتح مباشرة الخصائص للمنتج»).
          //  v40 (الجولة 48 #1): منتج الأحجام (مطعم/كافيتريا — كل
          //  حجم بسعره) نفس المسار تماماً — الباركود العام لا يسعّر
          //  الحجم، فمسحه يغلق الماسح ويفتح نافذة اختيار الحجم فوراً
          //  (طلب التاجر: «أو الحجم في المنتجات التي لها أحجام»).
          if (
            (product.variants ?? []).some(
              v => v.kind === 'variant' || v.kind === 'size',
            )
          ) {
            queueSaleSheet(product);
            beep();
            await closeScannerNow();
            return {status: 'queued', name: product.name};
          }
          const result = addProduct(product, mode, null);
          if (result.added) {
            beep();
            return {
              status: 'added',
              name: product.name,
              product,
              unitPrice:
                mode === 'WHOLESALE'
                  ? product.wholesale_price
                  : product.retail_price,
            };
          }
          // v10 (round-16 #3): the reason (نفدت الكمية …) travels to
          // the in-window banner — the RN toast is hidden behind the
          // native scanner window.
          return {
            status: 'error',
            name: product.name,
            reason: result.reason,
          };
        }
        // 2. Unit-level barcode (a whole كرتونة).
        const unitHit = await UnitRepo.findByBarcode(code);
        if (unitHit != null) {
          const unitProduct = await ProductRepo.getById(unitHit.productId);
          if (unitProduct != null) {
            const mode = useCartStore.getState().pricingMode;
            const result = addProduct(unitProduct, mode, unitHit.productUnit);
            if (result.added) {
              beep();
              return {
                status: 'added',
                name: `${unitProduct.name} (${unitHit.productUnit.unitName})`,
                product: unitProduct,
                unitPrice: unitPriceFor(unitProduct, unitHit.productUnit, mode),
              };
            }
            return {
              status: 'error',
              name: unitProduct.name,
              reason: result.reason,
            };
          }
        }
        // 3. Unknown → SILENT (round-15 #2): no message, no counter.
        return {status: 'unknown'};
      } catch (error) {
        return {
          status: 'error',
          reason:
            error instanceof Error ? error.message : 'فشل البحث عن الباركود',
        };
      }
    },
    // v43 (الجولة 51 #5): مساعدات الإدراج المضادة للتكرار — نفس
    //  حماية البصري لمسار الباركود (قراءة مكررة قبل هبوط الإغلاق).
    [addProduct, beep, queueSaleSheet, queueWeightPad],
  );

  /**
   * v8.1 CONTINUOUS multi-scan barcode session: the native engine
   * never auto-closes; every deduped read streams in and is added
   * immediately. The merchant scans item after item without ever
   * leaving the camera, then presses إغلاق to finish.
   * v9.1 (round-14 #1): the counter counts ONLY confirmed,
   * REGISTERED products.
   * v9.2 (round-15 #2 + #4): unknown barcodes are fully SILENT, and
   * every confirmed add gets the rich in-window confirmation
   * (name + ×N + price).
   */
  const runBarcodeScan = useCallback(async () => {
    if (scanBusy) {
      return;
    }
    if (!(await guardCameraPermission())) {
      return;
    }
    setScanBusy(true);
    const session = makeScanSession();
    // Serializes DB lookups: reads can stream in faster than the
    // lookups resolve; each is still processed exactly once.
    const queue: string[] = [];
    let processing = false;
    // The LAST read may still be mid-lookup when the merchant closes
    // the scanner — the settle step awaits this so it counts too.
    let drainPromise: Promise<void> = Promise.resolve();
    const drain = async () => {
      if (processing) {
        return;
      }
      processing = true;
      try {
        while (queue.length > 0) {
          const code = queue.shift();
          if (code == null) {
            continue;
          }
          const outcome = await handleBarcode(code);
          if (outcome == null) {
            continue;
          }
          if (outcome.status === 'added') {
            session.confirmed++;
            session.counts.set(
              outcome.product.id,
              (session.counts.get(outcome.product.id) ?? 0) + 1,
            );
            await notifyScanResult(
              true,
              addedMessage(session, outcome.product, outcome.unitPrice),
            );
          } else if (outcome.status === 'queued') {
            session.confirmed++;
            await notifyScanResult(
              true,
              `منتج وزن — نافذة الوزن فُتحت له: ${outcome.name}`,
            );
          } else if (outcome.status === 'error' && outcome.reason != null) {
            // v10 (round-16 #3): stock-out / lookup failures show IN
            // the scanner window (the RN toast is behind it).
            await notifyScanResult(false, outcome.reason);
          }
          // v9.2 (round-15 #2): 'unknown' stays SILENT — the read is
          // simply not confirmed. No banner, no counter, no prompts.
        }
      } finally {
        processing = false;
      }
    };
    try {
      await scanBarcodeContinuous(code => {
        queue.push(code);
        drainPromise = drain();
      });
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'فشل مسح الباركود',
        'error',
      );
    } finally {
      // Let the LAST in-flight lookup finish before the summary.
      try {
        await drainPromise;
      } catch {
        // Never break the settle step on a failed lookup.
      }
      setScanBusy(false);
      // The summary counts CONFIRMED adds only.
      if (session.confirmed > 0) {
        toast(
          `اكتملت جلسة الباركود — أُضيف ${session.confirmed} منتج للسلة`,
          'success',
        );
      }
    }
  }, [scanBusy, handleBarcode, toast, guardCameraPermission]);

  /**
   * v9.2 (round-15 #5) COMBINED session — "both" mode is now ONE
   * native window with BOTH engines: it starts on the BARCODE
   * engine and a big switcher INSIDE the camera window flips to the
   * VISUAL engine (and back) without ever closing the camera. The
   * merchant scans barcodes, photographs a homemade item without a
   * code, then scans again — one session, zero round-trips, exactly
   * the easy switching the merchant asked for.
   * Both engines stream live into this one handler: every barcode
   * read is looked up and added, every shutter press runs the
   * 4-crop recognition, and the shared confirmed counter + banner
   * respond to both.
   */
  const runCombinedScan = useCallback(async () => {
    if (scanBusy) {
      return;
    }
    if (!(await guardCameraPermission())) {
      return;
    }
    const index = useCatalogStore.getState().embeddingsIndex;
    if (index == null || index.ids.length === 0) {
      toast(
        'لا توجد بصمات بصرية محفوظة — الباركود سيعمل فوراً، وللبصري سجّل صور المنتجات من شاشة المنتج',
        'info',
        4000,
      );
    }
    setScanBusy(true);
    setVisionMatches(null);
    const session = makeScanSession();
    // Two INDEPENDENT queues — barcode lookups are quick DB reads
    // while photo recognition is the heavy 4-crop ensemble; neither
    // ever blocks the other, whichever engine is active.
    const codes: string[] = [];
    let processingCode = false;
    let codeDrain: Promise<void> = Promise.resolve();
    const drainCodes = async () => {
      if (processingCode) {
        return;
      }
      processingCode = true;
      try {
        while (codes.length > 0) {
          const code = codes.shift();
          if (code == null) {
            continue;
          }
          const outcome = await handleBarcode(code);
          if (outcome == null) {
            continue;
          }
          if (outcome.status === 'added') {
            session.confirmed++;
            session.counts.set(
              outcome.product.id,
              (session.counts.get(outcome.product.id) ?? 0) + 1,
            );
            await notifyScanResult(
              true,
              addedMessage(session, outcome.product, outcome.unitPrice),
            );
          } else if (outcome.status === 'queued') {
            session.confirmed++;
            await notifyScanResult(
              true,
              `منتج وزن — نافذة الوزن فُتحت له: ${outcome.name}`,
            );
          } else if (outcome.status === 'error' && outcome.reason != null) {
            // v10 (round-16 #3): stock-out / lookup failures show IN
            // the scanner window (the RN toast is behind it).
            await notifyScanResult(false, outcome.reason);
          }
          // Unknown → SILENT (round-15 #2).
        }
      } finally {
        processingCode = false;
      }
    };
    const photos: string[] = [];
    let processingPhoto = false;
    let photoDrain: Promise<void> = Promise.resolve();
    const drainPhotos = async () => {
      if (processingPhoto) {
        return;
      }
      processingPhoto = true;
      try {
        while (photos.length > 0) {
          const next = photos.shift();
          if (next != null) {
            await processVisionPhoto(next, session);
          }
        }
      } finally {
        processingPhoto = false;
      }
    };
    try {
      await scanBothContinuous(
        code => {
          codes.push(code);
          codeDrain = drainCodes();
        },
        path => {
          photos.push(path);
          photoDrain = drainPhotos();
        },
      );
    } catch (error) {
      toast(error instanceof Error ? error.message : 'فشل جلسة المسح', 'error');
    } finally {
      // Let the LAST in-flight barcode lookup AND photo finish before
      // settling (both results must count).
      await Promise.allSettled([codeDrain, photoDrain]);
      setScanBusy(false);
      settleScanSession(session, 'المسح');
    }
  }, [
    scanBusy,
    toast,
    handleBarcode,
    processVisionPhoto,
    settleScanSession,
    guardCameraPermission,
  ]);

  const filteredProducts = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) {
      return products;
    }
    return products.filter(
      product =>
        product.name.toLowerCase().includes(query) ||
        (product.barcode ?? '').includes(query),
    );
  }, [search, products]);

  /** v35 (الجولة 43): شبكة البيع — الموديل منتج واحد بمتغيراته
   *  (ملابس لون×مقاس / أحجام)؛ التجان يفتح نافذة البيع بمحتوى
   *  مودّه. تجميع style_group القديم حُذف — الترحيل v20 دمج
   *  ربطات v34 في موديلات واحدة. */
  const displayItems = useMemo(() => {
    return filteredProducts;
  }, [filteredProducts]);

  const priceOf = useCallback(
    (product: Product) =>
      pricingMode === 'WHOLESALE'
        ? product.wholesale_price
        : product.retail_price,
    [pricingMode],
  );

  /** Opens the unit picker sheet for a cart line. */
  const openUnitPicker = useCallback(async (line: CartLine) => {
    setUnitPickerLine(line);
    setUnitPickerRows(null);
    try {
      const rows = await UnitRepo.listForProduct(line.productId);
      setUnitPickerRows(rows);
    } catch {
      setUnitPickerRows([]);
    }
  }, []);

  const pickUnit = useCallback(
    (unit: ProductUnit | null) => {
      if (unitPickerLine == null) {
        return;
      }
      const product = products.find(
        entry => entry.id === unitPickerLine.productId,
      );
      if (product == null) {
        return;
      }
      const result = setLineUnit(product, unit);
      if (!result.ok && result.reason) {
        toast(result.reason, 'error');
      } else if (unit != null) {
        beep();
      }
      setUnitPickerLine(null);
      setUnitPickerRows(null);
    },
    [unitPickerLine, products, setLineUnit, beep, toast],
  );

  const completeSale = useCallback(
    async (withPrint: boolean) => {
      if (lines.length === 0) {
        toast('السلة فارغة — أضف منتجات أولاً', 'error');
        return;
      }
      if (withPrint && printerStatus !== 'connected') {
        // v11 (round-17): the dual-mode sell button only passes true
        // when the printer is live — kept as a safety net for any
        // other caller: print silently skipped, sale still proceeds.
        withPrint = false;
      }
      setBusy(true);
      Keyboard.dismiss();
      try {
        await InvoiceService.completeSale({
          lines,
          discount,
          paymentType: pricingMode,
          print: withPrint,
          receiptSettings: {
            storeName: settings.storeName,
            storePhone: settings.storePhone,
            footerMessage: settings.footerMessage,
            storeLogoPath: settings.storeLogoPath,
            paperWidth: settings.paperWidth,
            codepage: settings.codepage,
            showProfit: settings.showProfitOnReceipt,
          },
          onPrintError: message =>
            toast(`تم حفظ البيع لكن الطباعة فشلت: ${message}`, 'error'),
          productNames: new Map(lines.map(line => [line.productId, line.name])),
        });
        clear();
        setDiscountText('');
        void refreshCatalog();
        toast(
          `تم إتمام البيع بنجاح ${withPrint ? 'وإرساله للطابعة' : ''}`,
          'success',
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        toast(message, 'error');
      } finally {
        setBusy(false);
      }
    },
    [
      lines,
      discount,
      pricingMode,
      printerStatus,
      settings,
      clear,
      refreshCatalog,
      toast,
    ],
  );

  /** v11 (SILA §9.2): بيع بالدين — v15 (round-21 #5) opens a
   *  CHOOSER first: scan the customer's SILA QR (identity card or
   *  signed offline code) OR pick a known صِلة customer from the
   *  cached list and charge the debt directly on them. */
  const startDebtSale = useCallback(() => {
    if (lines.length === 0) {
      toast('السلة فارغة — أضف منتجات أولاً', 'error');
      return;
    }
    if (busy || debtBusy) {
      return;
    }
    // v16 (round-22 #4): the chooser opens even WITHOUT صِلة pairing —
    // the LOCAL debt book (دفتر المتجر) is standalone. The صِلة
    // paths inside keep their pairing guards + guidance.
    setDebtChooser(true);
  }, [lines.length, busy, debtBusy, toast]);

  /** v16 (round-22 #4): the cross-system dedupe guard — a scanned
   *  صِلة QR whose cid is LINKED to a local account means this
   *  person already has debts in the store's own book; the sale is
   *  redirected to the LOCAL book so the same person never carries
   *  parallel truths on both sides. Returns true when redirected.
   *  (Defined before scanDebtQr — it's in that callback's deps.) */
  const redirectLinkedLocalCustomer = useCallback(
    async (cid: string | null, name: string): Promise<boolean> => {
      if (cid == null) {
        return false;
      }
      try {
        const linked = await LocalDebtsRepo.bySilaCustomerId(cid);
        if (linked == null) {
          return false;
        }
        Alert.alert(
          'هذا الزبون له حساب في دفتر المتجر',
          `«${linked.name}» مرتبط بهذا حساب صِلة. لتجنب احتساب الدين مرتين، سيُسجَّل الدين على حسابه المحلي في دفتر المتجر بدلاً من رفعه إلى صِلة.`,
          [
            {
              text: 'تسجيل محلي',
              style: 'default',
              onPress: () =>
                setDebtConfirm({
                  customerId: null,
                  customerName: linked.name,
                  customerPhoneLast4: linked.phone
                    ? linked.phone.replace(/\D/g, '').slice(-4)
                    : null,
                  customerCard: null,
                  offlineQr: null,
                  amountMinor: Math.round(totals.total * 100),
                  amountSource: 'local',
                  localCustomerId: linked.id,
                }),
            },
            {
              text: 'إلغاء العملية',
              style: 'cancel',
              onPress: () => undefined,
            },
          ],
        );
        return true;
      } catch {
        return false;
      }
    },
    [totals.total],
  );

  /** v15 (round-21 #5): the SCAN path — the QR flow exactly as
   *  before, now entered from the chooser sheet. */
  const scanDebtQr = useCallback(async () => {
    if (lines.length === 0) {
      toast('السلة فارغة — أضف منتجات أولاً', 'error');
      return;
    }
    if (busy || debtBusy) {
      return;
    }
    if (!silaPaired) {
      Alert.alert(
        'البيع بالدين عبر صِلة',
        'لتفعيل البيع بالدين، اربط حساب التاجر في تطبيق صِلة أولاً — العملية تستغرق أقل من دقيقة.',
        [
          {text: 'لاحقاً', style: 'cancel'},
          {
            text: 'ربط الآن',
            onPress: () => navigation.navigate('Sila' as never),
          },
        ],
      );
      return;
    }
    setDebtBusy(true);
    try {
      const code = await scanBarcode();
      if (code == null) {
        // Merchant closed the scanner — nothing happened.
        return;
      }
      const {payload, expired} = parseSilaQr(code);
      if (payload.kind === 'card') {
        if (!payload.cid || !payload.name) {
          toast(
            'بطاقة غير مكتملة — اطلب من الزبون فتح «بطاقتي» من جديد',
            'error',
          );
          return;
        }
        if (expired) {
          toast(
            'انتهت صلاحية بطاقة الزبون — اطلب منه فتح «بطاقتي» من جديد',
            'error',
          );
          return;
        }
        // v16 (round-22 #4): a cid LINKED to a local account → the
        // debt belongs in the store's own book (dedupe guard).
        if (await redirectLinkedLocalCustomer(payload.cid, payload.name)) {
          return;
        }
        // v17 (round-23 #3): the customer's prepaid credit from the
        // cached server feed — decides how much of this invoice is
        // actually PAID (مسددة) before the confirm sheet opens.
        const cardCredit = await SilaRepo.findCustomer(payload.cid);
        setDebtConfirm({
          customerId: payload.cid,
          customerName: payload.name,
          customerPhoneLast4: payload.phone
            ? payload.phone.replace(/\D/g, '').slice(-4)
            : null,
          customerCard: payload.raw,
          offlineQr: null,
          amountMinor: Math.round(totals.total * 100),
          amountSource: 'card',
          creditMinor: cardCredit?.credit_minor ?? 0,
        });
      } else if (payload.kind === 'offline') {
        if (expired) {
          toast('انتهت صلاحية رمز الزبون — اطلب منه توليد رمز جديد', 'error');
          return;
        }
        if (payload.amountMinor <= 0) {
          toast('الرمز لا يحمل مبلغاً صالحاً — اطلب رمزاً جديداً', 'error');
          return;
        }
        // v16 (round-22 #4): same dedupe guard for offline codes.
        if (await redirectLinkedLocalCustomer(payload.cid, 'زبون صِلة')) {
          return;
        }
        // Offline codes carry cid + amount only — the display name
        // comes from the local customers cache when known.
        const cached = payload.cid
          ? await SilaRepo.findCustomer(payload.cid)
          : null;
        setDebtConfirm({
          customerId: payload.cid || null,
          customerName: cached?.name ?? 'زبون صِلة (رمز موقّع)',
          customerPhoneLast4: cached?.phone_last4 ?? null,
          customerCard: null,
          offlineQr: payload.raw,
          amountMinor: payload.amountMinor,
          amountSource: 'offline',
          creditMinor: cached?.credit_minor ?? 0,
        });
      } else if (payload.kind === 'online') {
        Alert.alert(
          'رمز جلسة أونلاين',
          'هذا الرمز يعمل فقط مع اتصال بالإنترنت — اطلب من الزبون بطاقته («بطاقتي») أو رمز «دون اتصال» بمبلغ الفاتورة.',
          [{text: 'حسناً'}],
        );
      } else if (payload.kind === 'pair') {
        toast('هذا رمز ربط تاجر — يُستخدم من إعدادات صِلة وليس للبيع', 'info');
      } else {
        toast('رمز غير معروف — تأكد أنه رمز تطبيق صِلة', 'error');
      }
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'فشل مسح رمز الزبون',
        'error',
      );
    } finally {
      setDebtBusy(false);
    }
  }, [
    lines.length,
    busy,
    debtBusy,
    silaPaired,
    totals.total,
    redirectLinkedLocalCustomer,
    toast,
    navigation,
  ]);

  /** v15 (round-21 #5): the PICK path — cached صِلة customers with a
   *  live search box. Selecting one opens the SAME confirmation
   *  sheet, with the debt amount = the invoice total (no signed QR
   *  involved; the upload identifies the customer by cid §2.2).
   *  v16 (round-22 #1): when the cache is empty but the device is
   *  paired, one balances refresh is attempted FIRST (empty ≠ no
   *  customers — it may just mean no successful pull yet), then the
   *  list is reloaded before showing the empty toast. */
  const openCustomerPicker = useCallback(async () => {
    setDebtChooser(false);
    try {
      let list = await SilaRepo.listCustomers();
      if (list.length === 0 && silaPaired) {
        await SilaSync.refreshBalances();
        list = await SilaRepo.listCustomers();
      }
      if (list.length === 0) {
        toast(
          'لا يوجد زبائن صِلة محفوظون بعد — أمسح رمز الزبون أو زامن صِلة أولاً',
          'info',
          4500,
        );
        return;
      }
      setPickerQuery('');
      setPickerCustomers(list);
      setCustomerPicker(true);
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'تعذر تحميل زبائن صِلة',
        'error',
      );
    }
  }, [toast, silaPaired]);

  const pickDebtCustomer = useCallback(
    (customer: SilaCustomer) => {
      setCustomerPicker(false);
      setDebtConfirm({
        customerId: customer.customer_id,
        customerName: customer.name,
        customerPhoneLast4: customer.phone_last4,
        customerCard: null,
        offlineQr: null,
        amountMinor: Math.round(totals.total * 100),
        amountSource: 'picker',
        // v17 (round-23 #3): the picked customer's prepaid credit —
        // the picker row already shows it, the confirm sheet now
        // acts on it.
        creditMinor: customer.credit_minor ?? 0,
      });
    },
    [totals.total],
  );

  /** v16 (round-22 #4): the LOCAL debt-book picker — customers of
   *  THIS store (دفتر المتجر) with live search; picking one charges
   *  the sale directly on their local account (INV-L series, never
   *  uploaded to صِلة). */
  const openLocalPicker = useCallback(async () => {
    setDebtChooser(false);
    try {
      const list = await LocalDebtsRepo.listWithBalances();
      if (list.length === 0) {
        Alert.alert(
          'دفتر المتجر فارغ',
          'أنشئ أولاً حساب دين لزبون متجرك (رقم هوية + اسم + جوال) من شاشة «دفتر ديون المتجر»',
          [
            {text: 'لاحقاً', style: 'cancel'},
            {
              text: 'فتح الدفتر',
              onPress: () => navigation.navigate('LocalDebts' as never),
            },
          ],
        );
        return;
      }
      setLocalQuery('');
      setLocalCustomers(list);
      setLocalPicker(true);
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'تعذر تحميل دفتر المتجر',
        'error',
      );
    }
  }, [toast, navigation]);

  const pickLocalCustomer = useCallback(
    (entry: LocalCustomerBalance) => {
      setLocalPicker(false);
      setDebtConfirm({
        customerId: null,
        customerName: entry.customer.name,
        customerPhoneLast4: entry.customer.phone
          ? entry.customer.phone.replace(/\D/g, '').slice(-4)
          : null,
        customerCard: null,
        offlineQr: null,
        amountMinor: Math.round(totals.total * 100),
        amountSource: 'local',
        localCustomerId: entry.customer.id,
      });
    },
    [totals.total],
  );

  /** v14 (round-20 #2): synchronous double-tap guard — a second
   *  tap in the SAME frame as the first (before `busy` re-renders)
   *  must not open a second atomic transaction. */
  const debtCommittingRef = useRef(false);

  /** v17 (round-23 #3): how much of a صِلة debt the customer's
   *  PREPAID credit covers — min(invoice amount, cached credit).
   *  Only صِلة sources carry credit; the local book has none. */
  const debtCreditCovered = useCallback(
    (confirm: {
      amountSource: 'card' | 'offline' | 'picker' | 'local';
      amountMinor: number;
      creditMinor?: number;
    }): number => {
      if (confirm.amountSource === 'local') {
        return 0;
      }
      const credit = Math.max(0, confirm.creditMinor ?? 0);
      return Math.min(Math.max(0, confirm.amountMinor), credit);
    },
    [],
  );

  /** v15 (round-21 #6): a signed offline QR whose amount differs
   *  from the invoice total (either way — less OR more) makes the
   *  debt UNCONFIRMABLE. Card/picker sources carry the invoice
   *  total by construction, so only the offline path can trip. */
  const debtAmountMismatch =
    debtConfirm != null &&
    debtConfirm.amountSource === 'offline' &&
    Math.abs(debtConfirm.amountMinor - Math.round(totals.total * 100)) > 0;

  /** v11 (SILA §9.2): the confirm step — ONE atomic transaction (v14
   *  round-20 #2): invoice + items + stock decrements + the debt
   *  queue row commit together or not at all. A failure leaves
   *  NOTHING recorded and the cart intact for a clean retry. */
  const confirmDebtSale = useCallback(async () => {
    if (debtConfirm == null) {
      return;
    }
    if (lines.length === 0) {
      setDebtConfirm(null);
      return;
    }
    if (debtCommittingRef.current) {
      return;
    }
    // v15 (round-21 #6): the QR amount must EQUAL the invoice total.
    if (
      debtConfirm.amountSource === 'offline' &&
      Math.abs(debtConfirm.amountMinor - Math.round(totals.total * 100)) > 0
    ) {
      toast(
        `مبلغ الرمز ${formatMoney(
          debtConfirm.amountMinor / 100,
        )} يختلف عن قيمة الفاتورة ${formatMoney(
          totals.total,
        )} — لا يُسجَّل الدين`,
        'error',
        5000,
      );
      return;
    }
    debtCommittingRef.current = true;
    setBusy(true);
    Keyboard.dismiss();
    try {
      await InvoiceService.completeSale({
        lines,
        discount,
        paymentType: pricingMode,
        print: printerStatus === 'connected',
        receiptSettings: {
          storeName: settings.storeName,
          storePhone: settings.storePhone,
          footerMessage: settings.footerMessage,
          storeLogoPath: settings.storeLogoPath,
          paperWidth: settings.paperWidth,
          codepage: settings.codepage,
          showProfit: settings.showProfitOnReceipt,
        },
        onPrintError: message =>
          toast(`تم تسجيل الدين لكن الطباعة فشلت: ${message}`, 'error'),
        productNames: new Map(lines.map(line => [line.productId, line.name])),
        // v16 (round-22 #4): a LOCAL debt-book sale charges the
        // store's own account (INV-L series, never uploaded) — the
        // صِلة queue path stays untouched for صِلة sources.
        ...(debtConfirm.amountSource === 'local'
          ? {
              localDebt: {
                localCustomerId: debtConfirm.localCustomerId ?? -1,
                customerName: debtConfirm.customerName,
                customerPhoneLast4: debtConfirm.customerPhoneLast4,
              },
            }
          : {
              debt: {
                customerId: debtConfirm.customerId,
                customerName: debtConfirm.customerName,
                customerPhoneLast4: debtConfirm.customerPhoneLast4,
                customerCard: debtConfirm.customerCard,
                offlineQr: debtConfirm.offlineQr,
                amountMinor: debtConfirm.amountMinor,
                // v17 (round-23 #3): the prepaid-credit part — the
                // FULL amount still uploads (the server consumes the
                // credit itself), but the store's books count the
                // covered part as PAID, not debt.
                creditCoveredMinor: debtCreditCovered(debtConfirm),
              },
            }),
      });
      clear();
      setDiscountText('');
      // v17 (round-23 #3): keep the covered/remainder numbers for the
      // final toast BEFORE clearing the sheet state.
      const saleCovered = debtCreditCovered(debtConfirm);
      const saleTotal = debtConfirm.amountMinor;
      const saleName = debtConfirm.customerName;
      const saleSource = debtConfirm.amountSource;
      const saleCid = debtConfirm.customerId;
      setDebtConfirm(null);
      void refreshCatalog();
      void useSilaStore.getState().refreshCounts();
      // Opportunistic sync — quietly drains the queue when online
      // (صِلة sales only; local-book sales never upload).
      if (saleSource !== 'local') {
        void SilaSync.syncNow();
        // The cached credit drops by the covered part immediately —
        // the NEXT sale of this customer sees the reduced balance
        // (the server's exact figure lands with the next refresh).
        if (saleCovered > 0 && saleCid != null) {
          void SilaRepo.consumeCachedCredit(saleCid, saleCovered);
        }
      }
      toast(
        saleSource === 'local'
          ? `تم تسجيل الدين على ${saleName} في دفتر المتجر`
          : saleCovered >= saleTotal && saleTotal > 0
          ? `فاتورة ${saleName} مسددة بالكامل من الرصيد المسبق (${formatMoney(
              saleTotal / 100,
            )})`
          : saleCovered > 0
          ? `دين ${saleName}: غطّى الرصيد المسبق ${formatMoney(
              saleCovered / 100,
            )} والباقي ${formatMoney((saleTotal - saleCovered) / 100)} دين`
          : `تم تسجيل الدين على ${saleName} — سيُزامن مع صِلة تلقائياً`,
        'success',
        saleCovered > 0 ? 5000 : undefined,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // v14 (round-20 #2): the whole debt sale is ONE atomic
      // transaction now — reaching this catch means NOTHING was
      // recorded: no invoice, no stock deduction, no debt row. The
      // cart stays exactly as it was for the merchant to retry.
      toast(
        `فشل إتمام عملية الدين: ${message} — لم يُسجَّل البيع ولم يُخصم من المخزون`,
        'error',
      );
    } finally {
      debtCommittingRef.current = false;
      setBusy(false);
    }
  }, [
    debtConfirm,
    lines,
    discount,
    pricingMode,
    printerStatus,
    settings,
    totals.total,
    clear,
    refreshCatalog,
    toast,
  ]);

  /** v8: scan entry — dispatches to the right NATIVE engine.
   *  barcode/visual modes open their engine directly; v9.2 (round-15
   *  #5) 'both' opens ONE combined window whose in-camera switcher
   * flips between باركود and بصري while the camera keeps running —
   * the separate picker sheet is gone. */
  const openScanner = useCallback(() => {
    // v40 (الجولة 48 #5): فتح الماسح يطوي لوحة الأشكال — لا تعيق
    //  نافذة البيع المفتوحة فوق الشاشة.
    setViewPickerOpen(false);
    if (scannerMode === 'barcode') {
      void runBarcodeScan();
    } else if (scannerMode === 'visual') {
      void runVisionScan();
    } else {
      void runCombinedScan();
    }
  }, [scannerMode, runBarcodeScan, runVisionScan, runCombinedScan]);

  /** Round-8: explicit EMPTY-CART action with a confirm step. */
  const confirmClearCart = useCallback(() => {
    if (lines.length === 0) {
      return;
    }
    Alert.alert(
      'تفريغ سلة البيع',
      `سيتم إلغاء ${totals.itemsCount} قطعة من السلة — لا يتم أي بيع ولا يُخصم شيء من المخزون.`,
      [
        {text: 'تراجع', style: 'cancel'},
        {
          text: 'تفريغ السلة',
          style: 'destructive',
          onPress: () => {
            clear();
            setDiscountText('');
            toast('تم تفريغ السلة', 'info');
          },
        },
      ],
    );
  }, [clear, lines.length, toast, totals.itemsCount]);

  const scannerLabel =
    scannerMode === 'barcode'
      ? 'باركود'
      : scannerMode === 'visual'
      ? 'بصري'
      : 'مسح';

  /** v8.2 (round-11 #3): grow the cart to the whole screen / fold it
   *  back — smooth LayoutAnimation keeps the transition classy. */
  const toggleCartExpanded = useCallback(() => {
    try {
      if (UIManager.setLayoutAnimationEnabledExperimental != null) {
        UIManager.setLayoutAnimationEnabledExperimental(true);
      }
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    } catch {
      // Cosmetic only — never block the toggle.
    }
    setCartExpanded(value => !value);
  }, []);

  /** v42 (الجولة 50 #5): تصغير السلة — زر مستقل بجانب زر التكبير
   *  يطوي اللوحة كاملة إلى شريط السطر الواحد (نفس حركة البحث)
   *  فيتحرر الشبكة كلها للتصفح؛ اللمس على الشريط أو إضافة سطر
   *  جديد يعيدانها. بنفس أنيميشن التكبير كي تظل الحركة أنيقة. */
  const minimizeCart = useCallback(() => {
    try {
      if (UIManager.setLayoutAnimationEnabledExperimental != null) {
        UIManager.setLayoutAnimationEnabledExperimental(true);
      }
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    } catch {
      // Cosmetic only — never block the fold.
    }
    setCartExpanded(false);
    setCartMinimized(true);
  }, []);

  return (
    <View style={styles.screen}>
      {/* v8.2 (round-11 #3): NO top header — every millimeter of the
          screen works for the product grid and the cart. The pricing
          mode is already visible in the Segmented control. */}
      <View
        style={[
          styles.body,
          // v31 (round-39 #3): فوق شاشة القفل يستبدل الـ inset
          // بحشوة صغيرة (شريط وضع البيع يغطي شريط الحالة)، وإلا
          // فالحشوة الأصلية تماماً.
          {paddingTop: topGap ?? insets.top + spacing.sm},
        ]}>
        {/* ── Pricing mode + view shape + search + scan ────── */}
        <View style={styles.controlsRow}>
          {/* v42 (الجولة 50 #1): الصف مضغوط بطلب التاجر — مبدّل
              جملة/مفرق بالقياس المضغوط (dense) قابل للانكماش
              (flexShrink) حتى لا يدفع زر الشكل خارج الشاشة مهما
              كان حجم خط الجهاز، وزر الشكل أيقونة فقط دون نص
              (مربع ٤٠×٤٠ بخلفية برتقالية هادئة) — لا نص يلتهم
              عرض الصف ولا انزلاق نحو الزاوية اليسرى. */}
          <View style={styles.modeRow}>
            <View style={styles.modeSegWrap}>
              <Segmented
                value={pricingMode}
                onChange={setPricingMode}
                options={[
                  {value: 'RETAIL', label: 'مفرق'},
                  {value: 'WHOLESALE', label: 'جملة'},
                ]}
                dense
              />
            </View>
            {/* v40 (الجولة 48 #5): زر شكل عرض المنتجات بجانب
                جملة/مفرق — يفتح لوحة INLINE صغيرة (لا Modal — درس
                الروم) لاختيار شكل المنتجات في نقطة البيع؛ الشكل
                الافتراضي هو الحالي (الشبكة) ويُحفظ الاختيار في
                الإعدادات. v42 (الجولة 50 #1): أيقونة فقط دون نص —
                مربع ثابت الحجم لا ينكمش ولا يُدف خارج الشاشة،
                والأيقونة نفسها تعكس الشكل الحالي. */}
            <TouchableOpacity
              style={[
                styles.viewShapeBtn,
                viewPickerOpen || posView !== 'grid'
                  ? {borderColor: c.accent}
                  : null,
              ]}
              onPress={() => setViewPickerOpen(v => !v)}
              activeOpacity={0.75}
              hitSlop={{top: 6, bottom: 6, left: 4, right: 4}}
              accessibilityLabel="تغيير شكل عرض المنتجات">
              <Icon
                name={
                  posView === 'list'
                    ? 'layoutList'
                    : posView === 'cards'
                    ? 'layoutCards'
                    : 'layoutGrid'
                }
                size={20}
                color={viewPickerOpen || posView !== 'grid' ? c.accent : c.text}
              />
            </TouchableOpacity>
          </View>
          <View style={styles.searchRow}>
            {/* v8.1: scan button FIRST in the RTL row → it sits on the
                RIGHT edge of the screen and the search fills the LEFT. */}
            <TouchableOpacity
              style={styles.scanButton}
              onPress={openScanner}
              activeOpacity={0.8}>
              <Icon
                name={scannerMode === 'barcode' ? 'barcode' : 'scan'}
                size={19}
                color={c.onAccent}
              />
              <Text style={styles.scanButtonText}>{scannerLabel}</Text>
            </TouchableOpacity>
            <View style={{flex: 1}}>
              <SearchInput
                value={search}
                onChange={setSearch}
                onFocus={() => {
                  setSearchFocused(true);
                  // v9: searching from inside the expanded cart folds
                  // it back — results must be visible for search to
                  // mean anything.
                  setCartExpanded(false);
                  // v40 (الجولة 48 #5): البحث يطوي لوحة الأشكال —
                  //  النتائج أهم.
                  setViewPickerOpen(false);
                }}
                onBlur={() => setSearchFocused(false)}
              />
            </View>
          </View>
        </View>

        {/* ═══ v40 (الجولة 48 #5): لوحة أشكال عرض المنتجات — INLINE
            في مجرى الشاشة تحت صف جملة/مفرق مباشرة (نمط شريط المرشحين
            البصريين؛ لا Modal أبداً — درس هذا الروم). ثلاثة أشكال
            بأيقونات ووصف قصير؛ الاختيار يُطبَّق فوراً ويُحفظ في
            الإعدادات، والشبكة الحالية هي الافتراض وعلامتها ظاهرة،
            وزر الشكل نفسه يغلق اللوحة. ═══ */}
        {viewPickerOpen ? (
          <View style={styles.viewPickerPanel}>
            <View style={styles.viewPickerHead}>
              <Text style={styles.viewPickerTitle}>
                شكل المنتجات في نقطة البيع
              </Text>
              <TouchableOpacity
                onPress={() => setViewPickerOpen(false)}
                hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                <Icon name="x" size={14} color={c.textDim} />
              </TouchableOpacity>
            </View>
            {(
              [
                {
                  key: 'grid' as PosProductView,
                  icon: 'layoutGrid' as const,
                  label: 'شبكة مربعات',
                  hint: 'الشكل الحالي — بلاطات بصور (الافتراضي)',
                },
                {
                  key: 'list' as PosProductView,
                  icon: 'layoutList' as const,
                  label: 'قائمة مضغوطة',
                  hint: 'صفوف صغيرة — أكبر عدد أصناف في الشاشة',
                },
                {
                  key: 'cards' as PosProductView,
                  icon: 'layoutCards' as const,
                  label: 'بطاقات كبيرة',
                  hint: 'صورتان عريضتان في الصف — للملابس والبصريات',
                },
              ]
            ).map(option => {
              const active = posView === option.key;
              return (
                <TouchableOpacity
                  key={option.key}
                  style={[
                    styles.viewPickerRow,
                    active ? {backgroundColor: c.accentSoft} : null,
                  ]}
                  onPress={() => {
                    updateSettings({posProductView: option.key});
                    setViewPickerOpen(false);
                  }}
                  activeOpacity={0.75}>
                  <View
                    style={[
                      styles.viewPickerIcon,
                      active ? {borderColor: c.accent} : null,
                    ]}>
                    <Icon
                      name={option.icon}
                      size={19}
                      color={active ? c.accent : c.textDim}
                    />
                  </View>
                  <View style={{flex: 1}}>
                    <Text
                      style={[
                        styles.viewPickerLabel,
                        active ? {color: c.accent} : null,
                      ]}>
                      {option.label}
                      {option.key === 'grid' ? ' · الافتراضي' : ''}
                    </Text>
                    <Text style={styles.viewPickerHint}>{option.hint}</Text>
                  </View>
                  {active ? (
                    <Icon name="check" size={16} color={c.accent} />
                  ) : null}
                </TouchableOpacity>
              );
            })}
          </View>
        ) : null}

        {/* ── v9 (round-13 #1): visual-scan candidate strip ─────
            INLINE (never a Modal — this ROM blacks RN Modals after
            the native scanner closes). Confident picks already added
            the product; the runner-ups stay one tap away. */}
        {visionMatches != null && visionMatches.length > 0 ? (
          <View style={styles.visionStrip}>
            <View style={styles.visionStripHeader}>
              <Icon name="scan" size={13} color={c.accent} />
              <Text style={styles.visionStripTitle} numberOfLines={1}>
                مرشحون من آخر مسحة — اضغط لإضافة
              </Text>
              <TouchableOpacity
                onPress={() => setVisionMatches(null)}
                hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                <Icon name="x" size={14} color={c.textDim} />
              </TouchableOpacity>
            </View>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.visionStripRow}>
              {visionMatches.map(match => (
                <TouchableOpacity
                  key={`${match.product.id}-${match.score}`}
                  style={styles.visionChip}
                  onPress={() => pickVisionMatch(match.product)}
                  activeOpacity={0.8}>
                  <Text style={styles.visionChipName} numberOfLines={1}>
                    {match.product.name}
                  </Text>
                  <Text style={styles.visionChipMeta} numberOfLines={1}>
                    {formatMoney(priceOf(match.product))}
                    {isWeightProduct(match.product) ? '/كغ' : ''} ·{' '}
                    {Math.round(match.score * 100)}%
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        ) : null}

        {/* ── Products grid (hidden while the cart is expanded —
            round-11 #3: the expanded cart IS the workspace) ── */}
        {!cartExpanded &&
          (products.length === 0 ? (
            <EmptyState
              icon="box"
              title="لا توجد منتجات بعد"
              subtitle="أضف أول منتج مع بصمته البصرية أو باركوده من شاشة المخزون"
            />
          ) : (
            <ScrollView
              style={{flex: 1}}
              contentContainerStyle={
                posView === 'list'
                  ? styles.listCol
                  : posView === 'cards'
                  ? styles.cardsGrid
                  : styles.grid
              }
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled">
              {displayItems.length === 0 ? (
                <View style={{paddingTop: spacing.xl}}>
                  <EmptyState
                    icon="search"
                    title="لا نتائج"
                    subtitle={`لا منتج يطابق «${search}»`}
                  />
                </View>
              ) : (
                displayItems.map(product => {
                  /* v35 (الجولة 43): كل منتج تجان واحد — اللمسة تفتح
                   * نافذة البيع المناسبة لموده (ملابس/أحجام/وحدات)
                   * أو تضيف مباشرة للمجالات البسيطة.
                   * v40 (الجولة 48 #5): الشكل قابل للتبديل من زر بجانب
                   * جملة/مفرق — شبكة (الافتراضي الحالي) / قائمة مضغوطة /
                   * بطاقات كبيرة؛ كل القيم المشتركة تُحسب مرة واحدة
                   * وتشترك الأشكال الثلاثة فيها. */
                  const stockState = stockStateOf(
                    product,
                    settings.lowStockDefaultThreshold,
                  );
                  const weighted = isWeightProduct(product);
                  const untracked = product.stock_untracked === 1;
                  const clothingVariants = (product.variants ?? []).filter(
                    v => v.kind === 'variant',
                  );
                  const sizeVariants = (product.variants ?? []).filter(
                    v => v.kind === 'size',
                  );
                  const variantCount = clothingVariants.length;
                  const priceLabel = `${
                    sizeVariants.length > 0
                      ? `${formatMoney(
                          Math.min(
                            ...sizeVariants.map(
                              v => v.retail_price ?? product.retail_price,
                            ),
                          ),
                        )}+`
                      : formatMoney(priceOf(product))
                  }${weighted ? '/كغ' : ''}`;
                  const stockLabel = untracked
                    ? 'يُباع دائماً'
                    : stockState === 'out'
                    ? 'نفد'
                    : `${formatQty(product.stock_quantity)} ${
                        weighted
                          ? WEIGHT_UNIT_NAME
                          : product.base_unit_name ?? BASE_UNIT_NAME
                      }`;
                  const stockColor =
                    stockState === 'out'
                      ? c.danger
                      : stockState === 'low'
                      ? c.warning
                      : c.success;

                  /* ── v40: قائمة مضغوطة — صف عريض بمصغّر صغير؛ أكبر
                   *  كثافة أصناف للمخازن الكبيرة، وكل المعلومات في
                   *  سطرين (الاسم + السعر/المخزون). ── */
                  if (posView === 'list') {
                    return (
                      <TouchableOpacity
                        key={product.id}
                        style={[
                          styles.listRow,
                          stockState === 'out' && !untracked
                            ? {opacity: 0.55}
                            : null,
                        ]}
                        onPress={() => openSaleSheet(product)}
                        activeOpacity={0.75}>
                        {product.image_uri ? (
                          <Image
                            source={{uri: `file://${product.image_uri}`}}
                            style={styles.listThumb}
                          />
                        ) : (
                          <View
                            style={[
                              styles.listThumb,
                              styles.tileImageFallback,
                            ]}>
                            <Icon name="box" size={16} color={c.accent} />
                          </View>
                        )}
                        <View style={{flex: 1, gap: 2}}>
                          <Text style={styles.listName} numberOfLines={1}>
                            {product.name}
                            {variantCount > 0
                              ? ` · ${new Set(
                                  clothingVariants.map(v => v.color),
                                ).size} لون × ${new Set(
                                  clothingVariants.map(v => v.size),
                                ).size} مقاس`
                              : sizeVariants.length > 0
                              ? ` · ${sizeVariants.length} أحجام`
                              : ''}
                          </Text>
                          <View style={styles.listMetaRow}>
                            <Text style={styles.listPrice}>{priceLabel}</Text>
                            {untracked ? (
                              <Text style={styles.tileStock}>{stockLabel}</Text>
                            ) : (
                              <>
                                <View
                                  style={[
                                    styles.stockDot,
                                    {backgroundColor: stockColor},
                                  ]}
                                />
                                <Text style={styles.tileStock}>
                                  {stockLabel}
                                </Text>
                              </>
                            )}
                            {product.barcode ? (
                              <Icon
                                name="barcode"
                                size={11}
                                color={c.textFaint}
                              />
                            ) : null}
                          </View>
                        </View>
                        {weighted ? (
                          <View style={styles.weightBadge}>
                            <Icon name="scale" size={9} color={c.onAccent} />
                          </View>
                        ) : null}
                      </TouchableOpacity>
                    );
                  }

                  /* ── v40: بطاقات كبيرة — اثنتان في الصف بصور عريضة؛
                   *  للملابس والأحذية والبصريات حيث الصورة تبيع. ── */
                  if (posView === 'cards') {
                    return (
                      <TouchableOpacity
                        key={product.id}
                        style={styles.cardTile}
                        onPress={() => openSaleSheet(product)}
                        activeOpacity={0.75}>
                        {product.image_uri ? (
                          <Image
                            source={{uri: `file://${product.image_uri}`}}
                            style={styles.cardImage}
                          />
                        ) : (
                          <View
                            style={[
                              styles.cardImage,
                              styles.tileImageFallback,
                            ]}>
                            <Icon name="box" size={34} color={c.accent} />
                          </View>
                        )}
                        {weighted ? (
                          <View style={styles.weightBadge}>
                            <Icon name="scale" size={9} color={c.onAccent} />
                          </View>
                        ) : null}
                        {variantCount > 0 ? (
                          <View style={styles.styleSizesBadge}>
                            <Text style={styles.styleSizesBadgeText}>
                              {new Set(clothingVariants.map(v => v.color)).size}{' '}
                              لون ·{' '}
                              {new Set(clothingVariants.map(v => v.size)).size}{' '}
                              مقاس
                            </Text>
                          </View>
                        ) : sizeVariants.length > 0 ? (
                          <View style={styles.styleSizesBadge}>
                            <Text style={styles.styleSizesBadgeText}>
                              {sizeVariants.length} أحجام
                            </Text>
                          </View>
                        ) : null}
                        <Text style={styles.cardName} numberOfLines={1}>
                          {product.name}
                        </Text>
                        <Text style={styles.cardPrice}>{priceLabel}</Text>
                        <View style={styles.tileStockRow}>
                          {untracked ? (
                            <Text style={styles.tileStock}>{stockLabel}</Text>
                          ) : (
                            <>
                              <View
                                style={[
                                  styles.stockDot,
                                  {backgroundColor: stockColor},
                                ]}
                              />
                              <Text style={styles.tileStock}>
                                {stockLabel}
                              </Text>
                            </>
                          )}
                          {product.barcode ? (
                            <Icon
                              name="barcode"
                              size={11}
                              color={c.textFaint}
                            />
                          ) : null}
                        </View>
                      </TouchableOpacity>
                    );
                  }

                  /* ── الافتراضي: الشبكة الحالية كما هي تماماً. ── */
                  return (
                    <TouchableOpacity
                      key={product.id}
                      style={styles.tile}
                      onPress={() => openSaleSheet(product)}
                      activeOpacity={0.75}>
                      {product.image_uri ? (
                        <Image
                          source={{uri: `file://${product.image_uri}`}}
                          style={styles.tileImage}
                        />
                      ) : (
                        <View
                          style={[styles.tileImage, styles.tileImageFallback]}>
                          <Icon name="box" size={20} color={c.accent} />
                        </View>
                      )}
                      {weighted ? (
                        <View style={styles.weightBadge}>
                          <Icon name="scale" size={9} color={c.onAccent} />
                        </View>
                      ) : null}
                      {variantCount > 0 ? (
                        <View style={styles.styleSizesBadge}>
                          <Text style={styles.styleSizesBadgeText}>
                            {new Set(
                              clothingVariants.map(v => v.color),
                            ).size}{' '}
                            لون ·{' '}
                            {new Set(clothingVariants.map(v => v.size)).size} مقاس
                          </Text>
                        </View>
                      ) : sizeVariants.length > 0 ? (
                        <View style={styles.styleSizesBadge}>
                          <Text style={styles.styleSizesBadgeText}>
                            {sizeVariants.length} أحجام
                          </Text>
                        </View>
                      ) : null}
                      <Text style={styles.tileName} numberOfLines={1}>
                        {product.name}
                      </Text>
                      <Text style={styles.tilePrice}>{priceLabel}</Text>
                      <View style={styles.tileStockRow}>
                        {untracked ? (
                          <Text style={styles.tileStock}>{stockLabel}</Text>
                        ) : (
                          <>
                            <View
                              style={[
                                styles.stockDot,
                                {backgroundColor: stockColor},
                              ]}
                            />
                            <Text style={styles.tileStock}>{stockLabel}</Text>
                          </>
                        )}
                        {product.barcode ? (
                          <Icon name="barcode" size={11} color={c.textFaint} />
                        ) : null}
                      </View>
                    </TouchableOpacity>
                  );
                })
              )}
            </ScrollView>
          ))}

        {/* ── Cart panel ─────────────────────────────────────
            v9 (round-13 #3): while the search box holds keyboard
            focus the cart folds to a ONE-LINE summary strip (or
            vanishes when empty) — with adjustResize + a 50% cart
            the products used to get squeezed to nothing behind the
            keyboard, making search useless. Tapping the strip
            dismisses the keyboard and the full cart returns.
            v42 (الجولة 50 #5): نفس الشريط يخدم تصغير السلة —
            زر التصغير بجانب زر التكبير يطوي السلة كلها إليه،
            ولمسته تعيدها كاملة (مع إسدال لوحة المفاتيح إن
            كانت مفتوحة). */}
        {(searchFocused || cartMinimized) && !cartExpanded ? (
          lines.length === 0 ? null : (
            <TouchableOpacity
              style={styles.cartPeekRow}
              activeOpacity={0.8}
              onPress={() => {
                Keyboard.dismiss();
                // v42 (الجولة 50 #5): إعادة فتح السلة المطوية.
                setCartMinimized(false);
              }}>
              <Icon name="cart" size={15} color={c.accent} />
              <Text style={styles.cartPeekText} numberOfLines={1}>
                السلة: {formatQty(totals.itemsCount, 2)} وحدة ·{' '}
                {formatMoney(totals.total)}
              </Text>
              <Text style={styles.cartPeekHint}>إظهار السلة</Text>
            </TouchableOpacity>
          )
        ) : (
          <View
            style={cartExpanded ? styles.cartPanelExpanded : styles.cartPanel}>
            {lines.length === 0 ? (
              // v17 (round-23 #4): tappable with a SPOKEN hint — the
              // empty-cart strip NEVER opens the product scanner by
              // itself; a press just reminds the merchant where the
              // products come from (grid tap / the scan button up
              // top — his explicit choice, never an auto-launch).
              <TouchableOpacity
                style={styles.cartEmptyRow}
                activeOpacity={0.75}
                onPress={() =>
                  toast(
                    'السلة فارغة — المس منتجاً من الشبكة بالأعلى، أو استخدم زر المسح بجانب البحث',
                    'info',
                    3500,
                  )
                }>
                <Icon name="cart" size={18} color={c.textFaint} />
                <Text style={styles.cartEmptyText}>
                  السلة فارغة — المس منتجاً من الشبكة أو امسحه
                  {barcodeActive ? ' بالباركود' : ''}
                  {barcodeActive && visualActive ? ' أو ' : ''}
                  {visualActive ? 'بالكاميرا' : ''}
                  {embeddingsCount === 0 &&
                  products.length > 0 &&
                  !barcodeActive
                    ? ' (لا توجد بصمات بصرية محفوظة بعد — البيع باللمس متاح)'
                    : ''}
                </Text>
              </TouchableOpacity>
            ) : (
              <>
                {/* Compact header: cart size buttons + title + live
                  count + EMPTY button (round-8). v8.2 (round-11 #3):
                  تكبير grows the cart to the full screen. v42
                  (الجولة 50 #5): زران أيقونيان متجاوران بجانب
                  بعضهما — التكبير (سهم لأعلى، وعند التوسيع يعود
                  لأسفل لاستعادة الشكل العادي) والتصغير (شريط
                  أفقي يطوي السلة كلها إلى شريط سطر واحد) — طلب
                  التاجر الصريح: زر تصغير بجانب زر التكبير. */}
                <View style={styles.cartHeaderRow}>
                  <View style={styles.cartSizeBtns}>
                    <TouchableOpacity
                      style={[
                        styles.cartSizeBtn,
                        cartExpanded ? {borderColor: c.accent} : null,
                      ]}
                      onPress={toggleCartExpanded}
                      activeOpacity={0.75}
                      hitSlop={{top: 6, bottom: 6, left: 4, right: 4}}
                      accessibilityLabel={
                        cartExpanded
                          ? 'استعادة حجم السلة'
                          : 'تكبير السلة لملء الشاشة'
                      }>
                      <View
                        style={{
                          transform: [
                            {rotate: cartExpanded ? '0deg' : '180deg'},
                          ],
                        }}>
                        <Icon
                          name="chevronDown"
                          size={15}
                          color={cartExpanded ? c.accent : c.textDim}
                        />
                      </View>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.cartSizeBtn}
                      onPress={minimizeCart}
                      activeOpacity={0.75}
                      hitSlop={{top: 6, bottom: 6, left: 4, right: 4}}
                      accessibilityLabel="تصغير السلة إلى شريط">
                      <Icon name="minus" size={15} color={c.textDim} />
                    </TouchableOpacity>
                  </View>
                  <View style={styles.cartHeaderTitle}>
                    <Icon name="cart" size={14} color={c.accent} />
                    <Text style={styles.cartHeaderText}>سلة البيع</Text>
                    <Badge label={String(totals.itemsCount)} tone="neutral" />
                  </View>
                  <TouchableOpacity
                    style={styles.clearCartBtn}
                    onPress={confirmClearCart}
                    hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
                    activeOpacity={0.75}>
                    <Icon name="trash" size={14} color={c.danger} />
                    <Text style={styles.clearCartText}>تفريغ</Text>
                  </TouchableOpacity>
                </View>
                <View
                  style={
                    cartExpanded
                      ? styles.cartLinesWrapExpanded
                      : styles.cartLinesWrap
                  }>
                  <ScrollView
                    style={{flex: 1}}
                    showsVerticalScrollIndicator={false}>
                    {lines.map(line => (
                      <View key={line.key} style={styles.cartLine}>
                        <View style={styles.cartLineInfo}>
                          <Text style={styles.cartLineName} numberOfLines={1}>
                            {line.name}
                          </Text>
                          {/* Round-9: ONE meta row — price×qty and the unit
                            chip inline together, so each line is two
                            rows tall max and nothing overflows.
                            v35 (الجولة 43): سطر المتغير يحمل وصفه
                            (لون · مقاس / حجم / ربطة) بدل مبدّل الوحدة. */}
                          <View style={styles.cartLineMetaRow}>
                            <Text style={styles.cartLineMeta} numberOfLines={1}>
                              {formatMoney(line.unitPrice)} ×{' '}
                              {formatQty(line.quantity)} ={' '}
                              {formatMoney(line.unitPrice * line.quantity)}
                            </Text>
                            {line.variantLabel != null ? (
                              <View style={styles.variantLabelChip}>
                                <Icon name="tag" size={10} color={c.accent} />
                                <Text
                                  style={styles.variantLabelChipText}
                                  numberOfLines={1}>
                                  {line.variantLabel}
                                </Text>
                              </View>
                            ) : (
                              <TouchableOpacity
                                style={styles.unitChip}
                                onPress={() => openUnitPicker(line)}
                                activeOpacity={0.8}>
                                <Icon name="scale" size={10} color={c.accent} />
                                <Text
                                  style={styles.unitChipText}
                                  numberOfLines={1}>
                                  {line.unitName}
                                  {line.conversion !== 1
                                    ? ` (${formatQty(line.conversion)})`
                                    : ''}
                                </Text>
                                <Icon
                                  name="chevronDown"
                                  size={10}
                                  color={c.accent}
                                />
                              </TouchableOpacity>
                            )}
                          </View>
                        </View>
                        <Stepper
                          compact
                          value={line.quantity}
                          onIncrement={() => {
                            const result = increment(line.key);
                            if (!result.ok && result.reason) {
                              toast(result.reason, 'error');
                            }
                          }}
                          onDecrement={() => {
                            decrement(line.key);
                          }}
                          decrementDanger
                        />
                        <TouchableOpacity
                          onPress={() => removeLine(line.key)}
                          style={styles.removeBtn}
                          hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                          <Icon name="trash" size={13} color={c.danger} />
                        </TouchableOpacity>
                      </View>
                    ))}
                  </ScrollView>
                </View>

                {/* Discount row */}
                <View style={styles.discountRow}>
                  <Text style={styles.discountLabel}>خصم (₪)</Text>
                  <TextInput
                    style={styles.discountInput}
                    value={discountText}
                    onChangeText={text => {
                      setDiscountText(text);
                      const value = parseNumber(text);
                      setDiscount(Number.isNaN(value) ? 0 : Math.max(0, value));
                    }}
                    keyboardType="numeric"
                    placeholder="0"
                    placeholderTextColor={c.textFaint}
                  />
                  <TouchableOpacity
                    style={styles.quickChip}
                    onPress={() => {
                      const next = totals.subtotal * 0.05;
                      setDiscount(next);
                      setDiscountText(next.toFixed(2));
                    }}>
                    <Text style={styles.quickChipText}>5%</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.quickChip}
                    onPress={() => {
                      const next = totals.subtotal * 0.1;
                      setDiscount(next);
                      setDiscountText(next.toFixed(2));
                    }}>
                    <Text style={styles.quickChipText}>10%</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.quickChip, styles.quickChipGhost]}
                    onPress={() => {
                      setDiscount(0);
                      setDiscountText('');
                    }}>
                    <Text style={[styles.quickChipText, {color: c.textDim}]}>
                      إلغاء
                    </Text>
                  </TouchableOpacity>
                </View>

                {/* Totals + checkout */}
                <View style={styles.totalsRow}>
                  <View>
                    <Text style={styles.totalLabel}>
                      الإجمالي · {formatQty(totals.itemsCount, 2)} وحدة (
                      {formatQty(totals.baseItemsCount, 2)}{' '}
                      {lines.some(line => line.byWeight)
                        ? lines.some(line => !line.byWeight)
                          ? 'وحدة أساس'
                          : WEIGHT_UNIT_NAME
                        : BASE_UNIT_NAME}
                      )
                    </Text>
                    {totals.safeDiscount > 0 ? (
                      <Text style={styles.discountValue}>
                        خصم {formatMoney(totals.safeDiscount)}
                      </Text>
                    ) : null}
                  </View>
                  <MoneyText value={totals.total} big />
                </View>

                {/* v22 (round-28 #1): blocked voucher handovers — the
                    server redeemed the voucher but the cart was
                    smaller than its value; no goods until the cart is
                    topped up and completed here. */}
                {pendingVouchers.map(pending => {
                  const totalMinor = Math.round(totals.total * 100);
                  const remaining = Math.max(
                    0,
                    pending.valueMinor - totalMinor,
                  );
                  const ready = lines.length > 0 && remaining === 0;
                  // v43 (الجولة 51 #3): لافتة فشل حجز الفاتورة — نفس
                  //  مكان لافتة «أكمل السلة» لكن السبب واضح: القسيمة
                  //  مصروفة والفاتورة لم تُنشأ (نفاد كمية مثلاً)؛
                  //  عالج السبب ثم اضغط إتمام الصرف.
                  const bookingBlocked = pending.bookingError != null;
                  return (
                    <View
                      key={pending.localId}
                      style={styles.pendingVoucherBox}>
                      <View style={styles.pendingVoucherHead}>
                        <Icon
                          name="ticket"
                          size={15}
                          color={bookingBlocked ? c.danger : c.warning}
                        />
                        <Text
                          style={[
                            styles.pendingVoucherTitle,
                            bookingBlocked ? {color: c.danger} : null,
                          ]}
                          numberOfLines={1}>
                          {bookingBlocked
                            ? `قسيمة «${pending.campaignName}» بلا فاتورة بضاعة`
                            : `قسيمة «${pending.campaignName}» بانتظار إكمال السلة`}
                        </Text>
                        <TouchableOpacity
                          onPress={() => dismissPendingVoucher(pending.localId)}
                          hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                          <Icon name="x" size={14} color={c.textFaint} />
                        </TouchableOpacity>
                      </View>
                      <Text style={styles.pendingVoucherMeta}>
                        قيمة القسيمة {formatMoney(pending.valueMinor / 100)} ·
                        السلة الآن {formatMoney(totals.total)} · الإيصال{' '}
                        {pending.receiptRef}
                      </Text>
                      {bookingBlocked ? (
                        <>
                          <Text
                            style={[
                              styles.pendingVoucherHint,
                              {color: c.danger},
                            ]}>
                            فشل إنشاء فاتورة البضاعة: {pending.bookingError}
                          </Text>
                          <Text style={styles.pendingVoucherHint}>
                            عالج السبب أعلاه (مثلاً حدّث كمية المخزون) ثم
                            اضغط إتمام الصرف — القسيمة مصروفة ومطالبتك
                            على المؤسسة محفوظة، والبضاعة لم تُسلّم بعد
                          </Text>
                        </>
                      ) : (
                        <Text
                          style={[
                            styles.pendingVoucherHint,
                            ready ? {color: c.success} : null,
                          ]}>
                          {ready
                            ? 'السلة غطّت قيمة القسيمة — اضغط إتمام الصرف لتسليم البضاعة'
                            : `أضف بضاعة بفارق ${formatMoney(
                                remaining / 100,
                              )} على الأقل حتى تكتمل السلة`}
                        </Text>
                      )}
                      <View style={styles.pendingVoucherActions}>
                        <AppButton
                          title="إتمام الصرف وتسليم البضاعة"
                          small
                          variant={ready ? 'primary' : 'secondary'}
                          disabled={!ready || busy || debtBusy || voucherBusy}
                          loading={voucherBusy}
                          onPress={() => void completePendingVoucher(pending)}
                          style={{flex: 1}}
                        />
                      </View>
                    </View>
                  );
                })}

                <View style={styles.checkoutRow}>
                  {/* v11 (round-17 #1): ONE dual-mode sell button — the
                    printer icon appears ONLY when a printer is live,
                    and then the sale prints automatically; with no
                    printer it is a plain fast sale. */}
                  <AppButton
                    title="بيع"
                    icon={printerStatus === 'connected' ? 'printer' : 'check'}
                    onPress={() => completeSale(printerStatus === 'connected')}
                    loading={busy}
                    style={{flex: 1.5}}
                  />
                  {/* v21 (round-27 #6) → v24 (round-31 #4/#5): صرف
                    قسيمة صِلة — cart-tied PURCHASE-coupon redemption.
                    Shown ONLY when the device is paired AND at least
                    one PURCHASE-COUPON campaign (kind='voucher') is
                    ACTIVE in this store — parcel campaigns never
                    show it (they redeem from the القسائم tab's parcel
                    button only; a parcel code scanned here is
                    rejected by the service with a clear error). */}
                  {silaPaired && silaActiveCampaigns > 0 ? (
                    <TouchableOpacity
                      style={[styles.debtBtn, styles.voucherBtn]}
                      onPress={() => {
                        if (lines.length === 0) {
                          toast(
                            'أضف بضاعة المستحق إلى السلة أولاً — ثم اصرف القسيمة',
                            'info',
                          );
                          return;
                        }
                        if (busy || debtBusy) {
                          return;
                        }
                        setVoucherSheet(true);
                      }}
                      disabled={busy || debtBusy}
                      activeOpacity={0.8}>
                      <Icon name="ticket" size={16} color={c.info} />
                      <Text style={[styles.debtBtnText, {color: c.info}]}>
                        قسيمة
                      </Text>
                    </TouchableOpacity>
                  ) : null}
                  {/* v11 (round-17 #2): البيع بالدين — v16 (round-22 #4)
                    opens the chooser: صِلة QR / صِلة customers / the
                    STORE-LOCAL debt book (works without صِلة). The
                    pending badge shows unsynced صِلة debts at a
                    glance. */}
                  <TouchableOpacity
                    style={[
                      styles.debtBtn,
                      silaPaired && styles.debtBtnPaired,
                      (busy || debtBusy) && {opacity: 0.5},
                    ]}
                    onPress={() => void startDebtSale()}
                    disabled={busy || debtBusy}
                    activeOpacity={0.8}>
                    <Icon
                      name={silaPaired ? 'qrFrame' : 'book'}
                      size={16}
                      color={silaPaired ? c.accent : c.warning}
                    />
                    <Text
                      style={[
                        styles.debtBtnText,
                        {color: silaPaired ? c.accent : c.warning},
                      ]}>
                      دين
                    </Text>
                    {silaPaired && silaPending > 0 ? (
                      <View style={styles.debtBadge}>
                        <Text style={styles.debtBadgeText}>
                          {silaPending > 99 ? '+99' : silaPending}
                        </Text>
                      </View>
                    ) : null}
                  </TouchableOpacity>
                </View>
              </>
            )}
          </View>
        )}
      </View>

      {/* ── Unit picker sheet ──────────────────────────────── */}
      <Modal
        visible={unitPickerLine != null}
        transparent
        animationType="slide"
        onRequestClose={() => {
          setUnitPickerLine(null);
          setUnitPickerRows(null);
        }}>
        <View style={styles.unitModalOverlay}>
          <TouchableOpacity
            style={{flex: 1}}
            activeOpacity={1}
            onPress={() => {
              setUnitPickerLine(null);
              setUnitPickerRows(null);
            }}
          />
          <View style={styles.unitModalSheet}>
            <View style={styles.unitModalHandle} />
            <Text style={styles.unitModalTitle}>
              وحدة البيع — {unitPickerLine?.name}
            </Text>
            {unitPickerRows == null ? (
              <Text style={styles.unitModalMuted}>جارٍ تحميل الوحدات…</Text>
            ) : (
              <>
                <UnitOption
                  label={`${
                    products.find(p => p.id === unitPickerLine?.productId)
                      ?.base_unit_name ?? BASE_UNIT_NAME
                  } (الأساس)`}
                  meta={`سعر الوحدة: ${
                    unitPickerLine
                      ? formatMoney(
                          pricingMode === 'WHOLESALE'
                            ? products.find(
                                p => p.id === unitPickerLine.productId,
                              )?.wholesale_price ?? 0
                            : products.find(
                                p => p.id === unitPickerLine.productId,
                              )?.retail_price ?? 0,
                        )
                      : ''
                  }`}
                  active={unitPickerLine?.unitId == null}
                  onPress={() => pickUnit(null)}
                />
                {unitPickerRows.map(row => {
                  const product = products.find(
                    p => p.id === unitPickerLine?.productId,
                  );
                  const price = product
                    ? unitPriceFor(product, row, pricingMode)
                    : 0;
                  return (
                    <UnitOption
                      key={row.id}
                      label={row.unitName}
                      meta={`1 ${row.unitName} = ${
                        row.conversion
                      } ${BASE_UNIT_NAME} · ${formatMoney(price)}`}
                      active={unitPickerLine?.unitId === row.unit_id}
                      onPress={() => pickUnit(row)}
                    />
                  );
                })}
                {unitPickerRows.length === 0 ? (
                  <Text style={styles.unitModalMuted}>
                    لا وحدات أخرى — هذا المنتج يُباع بوحدته الأساس فقط.
                  </Text>
                ) : null}
                <Text style={styles.unitModalHint}>
                  الكميات تُخصم من المخزون بالقطعة تلقائياً — بيع كرتونة واحدة
                  يخصم عدد قطعها.
                </Text>
              </>
            )}
          </View>
        </View>
      </Modal>

      {/* ── v8.3 (round-12 #4): WEIGHT pad — how weight products are
          sold. Prices are per kilo; the merchant enters the weight on
          the BUILT-IN numeric keypad or taps a quick chip (وقية 250غ
          / نصف كغ / كيلو…) and the live total = kg × kilo price.
          Sub-units from the product's unit rows (وقية = 0.25 كغ…)
          add by their unit.
          v9.2 (round-15 #1): the keypad is IN-APP — the SYSTEM
          keyboard is never summoned for weight entry, so the sheet
          can never be pushed up / cut off / left hanging: it sits
          compact and fixed at the bottom, and closing it (back /
          dim / إلغاء) always restores the POS exactly. */}
      <WeightSheet
        product={weightProduct}
        unitRows={weightUnitRows}
        pricingMode={pricingMode}
        onClose={closeWeightSheet}
        onConfirm={confirmWeight}
      />

      {/* ── v35 (الجولة 43): نافذة البيع الموحدة — لكل منتج نافذة
          بمحتوى مودّه قبل السلة (طلب التاجر): ملابس (لون + مقاس
          مفرقاً / ربطة بالجملة)، مطعم (حجم بسعره)، صيدلية (شريط/
          علبة + كمية). INLINE absolute overlay — نفس درس روم الجهاز
          (لا Modal أبداً). ── */}
      <SaleSheetView
        sheet={saleSheet}
        pricingMode={pricingMode}
        onClose={() => setSaleSheet(null)}
        onAddVariant={(product, variant, qty) => {
          const result = addVariantLine(
            product,
            useCartStore.getState().pricingMode,
            variant,
            qty,
          );
          if (result.added) {
            beep();
            setSaleSheet(null);
          } else if (result.reason) {
            toast(result.reason, 'error');
          }
        }}
        onAddBundle={(product, color, bundles) => {
          const result = addBundleLine(product, color, bundles);
          if (result.added) {
            beep();
            setSaleSheet(null);
          } else if (result.reason) {
            toast(result.reason, 'error');
          }
        }}
        onAddSized={(product, sizeVariant, qty) => {
          const result = addSizedLine(product, sizeVariant, qty);
          if (result.added) {
            beep();
            setSaleSheet(null);
          } else if (result.reason) {
            toast(result.reason, 'error');
          }
        }}
        onAddUnit={(product, unit, qty) => {
          // v38 (الجولة 46 #5): الكمية من عدّاد نافذة البيع — كانت
          //  تضيف قطعة واحدة فقط مهما ضُبط العدّاد.
          tryAdd(product, unit, qty);
          setSaleSheet(null);
        }}
      />

      {/* ── v20: صرف قسيمة صلة — the shared redemption sheet. INLINE
          absolute overlay (the ROM Modal lesson). Cart-tied: the
          goods become the INV-V sale once the server says ok. ── */}
      <VoucherRedeemSheet
        visible={voucherSheet}
        mode="cart"
        onClose={() => setVoucherSheet(false)}
        cart={
          lines.length > 0
            ? ({
                lines,
                discount,
                pricingMode,
                total: totals.total,
                itemsCount: totals.itemsCount,
              } as VoucherCartContext)
            : null
        }
        receiptSettings={{
          storeName: settings.storeName,
          storePhone: settings.storePhone,
          footerMessage: settings.footerMessage,
          storeLogoPath: settings.storeLogoPath,
          paperWidth: settings.paperWidth,
          codepage: settings.codepage,
          showProfit: settings.showProfitOnReceipt,
        }}
        printerConnected={printerStatus === 'connected'}
        onRedeemed={() => {
          // The INV-V sale is booked — the cart is fulfilled. The
          // campaign books may have changed (a first redemption
          // activates its campaign) — refresh the counter.
          clear();
          setDiscountText('');
          void refreshCatalog();
          void useSilaStore.getState().refreshActiveCampaigns();
        }}
        onNeedsTopUp={info => {
          // v22 (round-28 #1): voucher > cart — keep the cart, show
          // the banner, complete after the cashier tops the cart up.
          setPendingVouchers(previous =>
            previous.some(item => item.localId === info.localId)
              ? previous
              : [...previous, info],
          );
        }}
      />

      {/* ── v15 (round-21 #5): debt chooser — scan the QR or pick a
          known صِلة customer. INLINE absolute overlay (ROM lesson). */}
      {debtChooser ? (
        <View style={styles.debtOverlay}>
          <TouchableOpacity
            style={styles.debtOverlayDim}
            activeOpacity={1}
            onPress={() => setDebtChooser(false)}
          />
          <BackHandlerCloser
            active={debtChooser}
            onClose={() => setDebtChooser(false)}
          />
          <View style={styles.debtModalSheet}>
            <View style={styles.unitModalHandle} />
            <Text style={styles.debtModalTitle}>بيع بالدين</Text>
            {/* v33 (round-41 #2): خيارا صِلة يظهران فقط عند الربط الفعلي —
                بلا ربط لا يظهران إطلاقاً في النافذة (طلب التاجر الصريح)،
                ويتقدّم «زبون من دفتر المتجر» وحده بلا تشويش. */}
            {silaPaired ? (
              <>
                <Text style={styles.chooserHint}>
                  اختر كيفية تحديد الزبون المدين
                </Text>
                <TouchableOpacity
                  style={styles.chooserBtn}
                  onPress={() => {
                    setDebtChooser(false);
                    void scanDebtQr();
                  }}
                  activeOpacity={0.85}>
                  <View style={styles.chooserIcon}>
                    <Icon name="qrFrame" size={22} color={c.accent} />
                  </View>
                  <View style={{flex: 1}}>
                    <Text style={styles.chooserTitle}>مسح رمز الزبون</Text>
                    <Text style={styles.chooserText}>
                      بطاقة الزبون من تطبيق صِلة أو رمز موقّع بمبلغ الفاتورة
                    </Text>
                  </View>
                  <Icon name="chevronLeft" size={16} color={c.textFaint} />
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.chooserBtn}
                  onPress={() => {
                    setDebtChooser(false);
                    void openCustomerPicker();
                  }}
                  activeOpacity={0.85}>
                  <View style={styles.chooserIcon}>
                    <Icon name="list" size={22} color={c.accent} />
                  </View>
                  <View style={{flex: 1}}>
                    <Text style={styles.chooserTitle}>اختيار من الزبائن</Text>
                    <Text style={styles.chooserText}>
                      زبائن صِلة المعروفون لدى متجرك — دين مباشر بقيمة الفاتورة
                    </Text>
                  </View>
                  <Icon name="chevronLeft" size={16} color={c.textFaint} />
                </TouchableOpacity>
              </>
            ) : (
              <Text style={styles.chooserHint}>
                دفتر المتجر يعمل دون صِلة — اربط حساب التاجر من شاشة صِلة
                لتسجيل ديون صِلة مباشرة
              </Text>
            )}
            {/* v16 (round-22 #4): the STORE-LOCAL debt book — customers
                of this store only (ID number + name + phone), charged
                locally, never uploaded to صِلة. */}
            <TouchableOpacity
              style={[styles.chooserBtn, {borderColor: c.accentSoft}]}
              onPress={() => void openLocalPicker()}
              activeOpacity={0.85}>
              <View style={styles.chooserIcon}>
                <Icon name="book" size={22} color={c.accent} />
              </View>
              <View style={{flex: 1}}>
                <Text style={styles.chooserTitle}>زبون من دفتر المتجر</Text>
                <Text style={styles.chooserText}>
                  حساب دين محلي (رقم هوية) — يُسجّل الدين في دفترك ولا يُرفع
                  لصِلة
                </Text>
              </View>
              <Icon name="chevronLeft" size={16} color={c.textFaint} />
            </TouchableOpacity>
          </View>
        </View>
      ) : null}

      {/* ── v15 (round-21 #5): the customers picker — live search over
          the cached صِلة customers with their current balance. ──── */}
      {customerPicker ? (
        <View style={styles.debtOverlay}>
          <TouchableOpacity
            style={styles.debtOverlayDim}
            activeOpacity={1}
            onPress={() => setCustomerPicker(false)}
          />
          <BackHandlerCloser
            active={customerPicker}
            onClose={() => setCustomerPicker(false)}
          />
          <View style={styles.pickerSheet}>
            <View style={styles.unitModalHandle} />
            <Text style={styles.debtModalTitle}>اختيار الزبون المدين</Text>
            <TextInput
              style={styles.pickerSearch}
              value={pickerQuery}
              onChangeText={setPickerQuery}
              placeholder="ابحث بالاسم أو الهاتف…"
              placeholderTextColor={c.textFaint}
            />
            <ScrollView
              style={styles.pickerList}
              contentContainerStyle={styles.pickerListContent}
              keyboardShouldPersistTaps="handled">
              {pickerCustomers
                .filter(customer => {
                  const q = pickerQuery.trim();
                  if (q.length === 0) {
                    return true;
                  }
                  return (
                    customer.name.includes(q) ||
                    (customer.phone_last4 ?? '').includes(q)
                  );
                })
                .map(customer => (
                  <TouchableOpacity
                    key={customer.customer_id}
                    style={styles.pickerRow}
                    onPress={() => pickDebtCustomer(customer)}
                    activeOpacity={0.85}>
                    <View style={styles.pickerAvatar}>
                      <Text style={styles.pickerInitial}>
                        {customer.name.trim().charAt(0) || 'ز'}
                      </Text>
                    </View>
                    <View style={{flex: 1}}>
                      <Text style={styles.pickerName} numberOfLines={1}>
                        {customer.name}
                      </Text>
                      <Text style={styles.pickerMeta}>
                        {customer.phone_last4
                          ? `هاتف: ****${customer.phone_last4}`
                          : 'زبون صِلة'}
                        {customer.outstanding_minor > 0
                          ? ` · دين قائم ${(
                              customer.outstanding_minor / 100
                            ).toFixed(2)} ₪`
                          : ' · بلا دين'}
                        {customer.credit_minor > 0
                          ? ` · رصيد مسبق ${(
                              customer.credit_minor / 100
                            ).toFixed(2)} ₪`
                          : ''}
                      </Text>
                    </View>
                    <Icon name="chevronLeft" size={16} color={c.textFaint} />
                  </TouchableOpacity>
                ))}
            </ScrollView>
            <AppButton
              title="إلغاء"
              variant="secondary"
              onPress={() => setCustomerPicker(false)}
            />
          </View>
        </View>
      ) : null}

      {/* ── v16 (round-22 #4): the LOCAL debt-book picker — store\n          customers by ID number, live search, direct charge. ── */}
      {localPicker ? (
        <View style={styles.debtOverlay}>
          <TouchableOpacity
            style={styles.debtOverlayDim}
            activeOpacity={1}
            onPress={() => setLocalPicker(false)}
          />
          <BackHandlerCloser
            active={localPicker}
            onClose={() => setLocalPicker(false)}
          />
          <View style={styles.pickerSheet}>
            <View style={styles.unitModalHandle} />
            <Text style={styles.debtModalTitle}>زبائن دفتر المتجر</Text>
            <TextInput
              style={styles.pickerSearch}
              value={localQuery}
              onChangeText={setLocalQuery}
              placeholder="ابحث بالاسم أو الهوية أو الجوال…"
              placeholderTextColor={c.textFaint}
            />
            <ScrollView
              style={styles.pickerList}
              contentContainerStyle={styles.pickerListContent}
              keyboardShouldPersistTaps="handled">
              {localCustomers
                .filter(entry => {
                  const q = localQuery.trim();
                  if (q.length === 0) {
                    return true;
                  }
                  return (
                    entry.customer.name.includes(q) ||
                    entry.customer.id_number.includes(q) ||
                    (entry.customer.phone ?? '').includes(q)
                  );
                })
                .map(entry => (
                  <TouchableOpacity
                    key={entry.customer.id}
                    style={styles.pickerRow}
                    onPress={() => pickLocalCustomer(entry)}
                    activeOpacity={0.85}>
                    <View style={styles.pickerAvatar}>
                      <Text style={styles.pickerInitial}>
                        {entry.customer.name.trim().charAt(0) || 'ز'}
                      </Text>
                    </View>
                    <View style={{flex: 1}}>
                      <Text style={styles.pickerName} numberOfLines={1}>
                        {entry.customer.name}
                      </Text>
                      <Text style={styles.pickerMeta}>
                        هوية {entry.customer.id_number}
                        {entry.outstandingMinor > 0
                          ? ` · دين قائم ${formatMoney(
                              entry.outstandingMinor / 100,
                            )}`
                          : ' · بلا دين'}
                      </Text>
                    </View>
                    <Icon name="chevronLeft" size={16} color={c.textFaint} />
                  </TouchableOpacity>
                ))}
            </ScrollView>
            <AppButton
              title="إلغاء"
              variant="secondary"
              onPress={() => setLocalPicker(false)}
            />
          </View>
        </View>
      ) : null}

      {/* ── v11 (SILA §9.2): debt confirmation sheet — the customer
          QR was scanned and parsed offline; one look (name / amount /
          mode) and one tap commits the sale + debt queue row.
          INLINE absolute overlay (NEVER a Modal — this sheet opens
          right after the native scanner closes and this ROM renders
          RN Modals black after native activity transitions, the
          exact pattern WeightSheet/visionStrip already avoid). */}
      {debtConfirm != null ? (
        <View style={styles.debtOverlay}>
          <TouchableOpacity
            style={styles.debtOverlayDim}
            activeOpacity={1}
            onPress={() => setDebtConfirm(null)}
          />
          <BackHandlerCloser
            active={debtConfirm != null}
            onClose={() => setDebtConfirm(null)}
          />
          <View style={styles.debtModalSheet}>
            <View style={styles.unitModalHandle} />
            <Text style={styles.debtModalTitle}>
              {debtConfirm?.amountSource === 'local'
                ? 'بيع بالدين — دفتر المتجر'
                : 'بيع بالدين — صِلة'}
            </Text>

            {/* Customer block */}
            <View style={styles.debtCustomerCard}>
              <View style={styles.debtCustomerIcon}>
                <Icon
                  name={
                    debtConfirm?.amountSource === 'local' ? 'book' : 'qrFrame'
                  }
                  size={22}
                  color={c.accent}
                />
              </View>
              <View style={{flex: 1}}>
                <Text style={styles.debtCustomerName} numberOfLines={1}>
                  {debtConfirm?.customerName ?? ''}
                </Text>
                <Text style={styles.debtCustomerMeta}>
                  {debtConfirm?.customerPhoneLast4
                    ? `هاتف: ****${debtConfirm.customerPhoneLast4}`
                    : debtConfirm?.amountSource === 'offline'
                    ? 'رمز موقّع من الزبون — المبلغ من الرمز'
                    : debtConfirm?.amountSource === 'picker'
                    ? 'زبون مختار من قائمة صِلة — المبلغ من الفاتورة'
                    : debtConfirm?.amountSource === 'local'
                    ? 'حساب دفتر المتجر — يُسجّل محلياً ولا يُرفع لصِلة'
                    : 'بطاقة زبون صِلة — المبلغ من الفاتورة'}
                </Text>
              </View>
            </View>

            {/* Amount */}
            <View style={styles.debtAmountRow}>
              <Text style={styles.debtAmountLabel}>قيمة الفاتورة</Text>
              <MoneyText value={(debtConfirm?.amountMinor ?? 0) / 100} big />
            </View>

            {/* v17 (round-23 #3): prepaid-credit split — the store
                RECOGNIZES the deduction: covered part = مسددة from
                the customer's existing balance, only the remainder
                is real debt. The sheet spells it out before the
                merchant confirms. */}
            {(() => {
              const confirm = debtConfirm;
              if (confirm == null || confirm.amountSource === 'local') {
                return null;
              }
              const covered = debtCreditCovered(confirm);
              if (covered <= 0) {
                // Still worth telling the merchant there is no
                // prepaid balance to absorb this invoice.
                return null;
              }
              const net = Math.max(0, confirm.amountMinor - covered);
              return (
                <View style={styles.debtCreditBox}>
                  <View style={styles.debtCreditRow}>
                    <Icon name="wallet" size={15} color={c.success} />
                    <Text style={[styles.debtCreditText, {color: c.success}]}>
                      رصيد مسبق في صِلة:{' '}
                      {formatMoney((confirm.creditMinor ?? 0) / 100)}
                    </Text>
                  </View>
                  <View style={styles.debtCreditRow}>
                    <Icon name="check" size={14} color={c.success} />
                    <Text style={styles.debtCreditText}>
                      مسدَّد من الرصيد: {formatMoney(covered / 100)}
                    </Text>
                  </View>
                  <View style={styles.debtCreditRow}>
                    <Icon
                      name="book"
                      size={14}
                      color={net > 0 ? c.warning : c.success}
                    />
                    <Text
                      style={[
                        styles.debtCreditText,
                        {color: net > 0 ? c.warning : c.success},
                      ]}>
                      {net > 0
                        ? `دين فعلي بعد التغطية: ${formatMoney(net / 100)}`
                        : 'الفاتورة مسددة بالكامل من الرصيد المسبق'}
                    </Text>
                  </View>
                  <Text style={styles.debtCreditNote}>
                    يُخصم الرصيد المسبق تلقائياً عند رفع الفاتورة لصِلة —
                    والمتجر يعامل الجزء المغطى كسداد في حساباته.
                  </Text>
                </View>
              );
            })()}

            {/* v15 (round-21 #6): an offline signed code whose amount
                ≠ the invoice total BLOCKS the debt — the merchant must
                ask for a QR matching the invoice (or adjust the cart).
                The old behaviour only warned and recorded the QR's
                amount, silently corrupting the debt statistics. */}
            {debtAmountMismatch ? (
              <View style={styles.debtWarnBox}>
                <Icon name="alert" size={15} color={c.danger} />
                <Text style={styles.debtWarnText}>
                  مبلغ الرمز (
                  {formatMoney((debtConfirm?.amountMinor ?? 0) / 100)}) يختلف عن
                  قيمة فاتورة البيع ({formatMoney(totals.total)}) — لا يمكن
                  تسجيل الدين. اطلب من الزبون رمزاً بمبلغ الفاتورة نفسه أو عدّل
                  السلة.
                </Text>
              </View>
            ) : null}

            {/* Printer hint */}
            <View style={styles.debtHintRow}>
              <Icon
                name={printerStatus === 'connected' ? 'printer' : 'clock'}
                size={14}
                color={c.textDim}
              />
              <Text style={styles.debtHintText}>
                {printerStatus === 'connected'
                  ? 'سيُطبع إيصال الدين تلقائياً بعد التأكيد'
                  : 'لا توجد طابعة متصلة — سيُحفظ الدين بدون طباعة'}
              </Text>
            </View>
            <View style={styles.debtHintRow}>
              <Icon name="refresh" size={14} color={c.textDim} />
              <Text style={styles.debtHintText}>
                {debtConfirm?.amountSource === 'local'
                  ? 'يُسجَّل في دفتر المتجر محلياً — دون رفع إلى صِلة'
                  : 'يُسجَّل الدين الآن محلياً ويُزامن مع صِلة تلقائياً عند توفر الإنترنت'}
              </Text>
            </View>

            {/* Actions — v15: تأكيد الدين is DISABLED while the
                signed QR amount ≠ the invoice total (round-21 #6). */}
            <View style={styles.debtActions}>
              <AppButton
                title="إلغاء"
                variant="secondary"
                onPress={() => setDebtConfirm(null)}
                style={{flex: 1}}
              />
              <AppButton
                title="تأكيد الدين"
                variant="success"
                icon="check"
                onPress={() => void confirmDebtSale()}
                loading={busy}
                disabled={debtAmountMismatch}
                style={{flex: 1.6}}
              />
            </View>
          </View>
        </View>
      ) : null}
    </View>
  );
}

/** Keypad key descriptor (built-in weight keypad). */
const KEYPAD_KEYS: string[][] = [
  ['7', '8', '9'],
  ['4', '5', '6'],
  ['1', '2', '3'],
  ['.', '0', '⌫'],
];

/** v9.2 (round-15 #1): the weight pad itself — a compact bottom
 *  sheet with a BUILT-IN decimal keypad (the professional-POS
 *  pattern — Loyverse/Square weight dialogs), the regional
 *  quick-weight chips, the product's sellable sub-units (وقية…)
 *  and a live price preview.
 *  There is NO TextInput and NO KeyboardAvoidingView anywhere in
 *  this sheet: the system keyboard is never opened, so the three
 *  round-14/15 complaints (huge sheet, top cut off by the keyboard,
 *  sheet stuck at the top after closing the keyboard) are all
 *  structurally impossible now. */
function WeightSheet({
  product,
  unitRows,
  pricingMode,
  onClose,
  onConfirm,
}: {
  product: Product | null;
  unitRows: ProductUnit[] | null;
  pricingMode: 'RETAIL' | 'WHOLESALE';
  onClose: () => void;
  onConfirm: (product: Product, kg: number, unit: ProductUnit | null) => void;
}) {
  const c = useThemeColors();
  const styles = useStyles();
  const [weightText, setWeightText] = useState('');

  useEffect(() => {
    setWeightText('');
  }, [product?.id]);

  if (product == null) {
    return null;
  }
  const kiloPrice =
    pricingMode === 'WHOLESALE'
      ? product.wholesale_price
      : product.retail_price;
  const weight = parseNumber(weightText);
  const validWeight =
    !Number.isNaN(weight) && weight > 0 ? Math.round(weight * 1000) / 1000 : 0;
  const total = validWeight > 0 ? validWeight * kiloPrice : 0;

  const confirm = () => {
    if (validWeight <= 0) {
      return;
    }
    onConfirm(product, validWeight, null);
    setWeightText('');
  };

  /** One keypad press — digit / decimal point / backspace. */
  const pressKey = (key: string) => {
    setWeightText(prev => {
      if (key === '⌫') {
        return prev.length <= 1 ? '' : prev.slice(0, -1);
      }
      if (key === '.') {
        if (prev.includes('.')) {
          return prev;
        }
        return prev === '' ? '0.' : `${prev}.`;
      }
      // A digit — cap at 6 significant chars (up to 999.999 كغ).
      if (prev.replace('.', '').length >= 6) {
        return prev;
      }
      if (prev === '0') {
        return key;
      }
      return prev + key;
    });
  };

  return (
    // v9 (round-13): INLINE absolute overlay — NOT a Modal. The
    // weight pad opens right after a scan (recognized weight
    // product), and this ROM renders RN Modals black after native
    // activity transitions. An in-tree overlay is structurally
    // immune to that bug.
    <View style={styles.inlineOverlay}>
      <TouchableOpacity
        style={styles.inlineOverlayDim}
        activeOpacity={1}
        onPress={onClose}
      />
      <BackHandlerCloser active={product != null} onClose={onClose} />
      <View style={styles.weightSheet}>
        <View style={styles.unitModalHandle} />
        {/* Compact header: name + kilo price + stock chip (always
            visible — outside the scroll). */}
        <View style={styles.weightHeaderRow}>
          <View style={{flex: 1}}>
            <Text style={styles.weightSheetTitle} numberOfLines={1}>
              {product.name}
            </Text>
            <Text style={styles.weightKiloPrice} numberOfLines={1}>
              سعر الكيلو ({pricingMode === 'WHOLESALE' ? 'جملة' : 'مفرق'}):{' '}
              {formatMoney(kiloPrice)} · المتاح{' '}
              {formatQty(product.stock_quantity)} {WEIGHT_UNIT_NAME}
            </Text>
          </View>
          <TouchableOpacity
            style={styles.weightClearChip}
            onPress={() => setWeightText('')}
            activeOpacity={0.75}>
            <Text style={styles.weightClearText}>مسح</Text>
          </TouchableOpacity>
        </View>

        {/* The scrollable middle — the sheet NEVER outgrows the
            screen: on small devices the middle scrolls while the
            header and the action buttons stay pinned. */}
        <ScrollView
          style={styles.weightScroll}
          contentContainerStyle={styles.weightScrollContent}
          showsVerticalScrollIndicator={false}>
          {/* The weight display — driven by the keypad below. */}
          <View style={styles.weightDisplayRow}>
            <Text
              style={[
                styles.weightDisplay,
                weightText === '' ? {color: c.textFaint} : null,
              ]}>
              {weightText === '' ? '0' : weightText}
            </Text>
            <Text style={styles.weightDisplayUnit}>{WEIGHT_UNIT_NAME}</Text>
            {total > 0 ? (
              <Text style={styles.weightDisplayTotal} numberOfLines={1}>
                = {formatMoney(total)}
              </Text>
            ) : null}
          </View>

          {/* Keypad + quick actions side by side — compact, fixed.
              v17 (round-23 #7): the SIDE PANEL now shows THE
              PRODUCT'S OWN units (الوحدات المضافة للمنتج) whenever it
              has any — each chip is the unit's name, its weight and
              its price, one tap adds it. The generic quick weights
              (وقية/نصف/كيلو) only appear when the product has NO
              units of its own, so nothing generic ever overrides
              what the merchant actually configured. */}
          <View style={styles.weightPadRow}>
            <View style={styles.keypad}>
              {KEYPAD_KEYS.map((row, rowIndex) => (
                <View key={rowIndex} style={styles.keypadRow}>
                  {row.map(key => (
                    <TouchableOpacity
                      key={key}
                      style={[
                        styles.keypadKey,
                        key === '⌫' ? styles.keypadKeyDanger : null,
                      ]}
                      onPress={() => pressKey(key)}
                      activeOpacity={0.65}>
                      <Text style={styles.keypadKeyText}>{key}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              ))}
            </View>
            <View style={styles.weightQuickColumn}>
              {unitRows != null && unitRows.length > 0 ? (
                <>
                  <Text style={styles.weightQuickLabel}>وحدات المنتج</Text>
                  {unitRows.map(row => {
                    const price = unitPriceFor(product, row, pricingMode);
                    return (
                      <TouchableOpacity
                        key={row.id}
                        style={styles.weightQuickChip}
                        onPress={() => {
                          onConfirm(product, 1, row);
                          setWeightText('');
                        }}
                        activeOpacity={0.75}>
                        <Text style={styles.weightQuickValue} numberOfLines={1}>
                          {row.unitName}
                        </Text>
                        <Text style={styles.weightQuickName} numberOfLines={1}>
                          {formatQty(row.conversion)} {WEIGHT_UNIT_NAME} ·{' '}
                          {formatMoney(price)}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </>
              ) : (
                <>
                  <Text style={styles.weightQuickLabel}>أوزان سريعة</Text>
                  {QUICK_WEIGHTS.map(entry => (
                    <TouchableOpacity
                      key={entry.kg}
                      style={styles.weightQuickChip}
                      onPress={() => {
                        onConfirm(product, entry.kg, null);
                        setWeightText('');
                      }}
                      activeOpacity={0.75}>
                      <Text style={styles.weightQuickValue}>
                        {formatQty(entry.kg)}
                      </Text>
                      <Text style={styles.weightQuickName}>{entry.label}</Text>
                    </TouchableOpacity>
                  ))}
                </>
              )}
            </View>
          </View>
        </ScrollView>

        <View style={styles.weightActionRow}>
          <AppButton
            title="إلغاء"
            variant="secondary"
            onPress={onClose}
            style={{flex: 1}}
          />
          <AppButton
            title={`أضف للسلة${total > 0 ? ` · ${formatMoney(total)}` : ''}`}
            icon="check"
            onPress={confirm}
            disabled={validWeight <= 0}
            style={{flex: 1.8}}
          />
        </View>
      </View>
    </View>
  );
}

/**
 * SaleSheetView — v35 (الجولة 43): نافذة البيع الموحدة لكل مود.
 * ─────────────────────────────────────────────────────────────────
 * طلب التاجر: «في نقطة البيع يجب أن يباع كل منتج بشكل مناسب في
 * إدخال خيارات البيع في نافذة البيع قبل الوضع بالسلة ويكون لكل
 * منتج حسب المود والاحتياج نافذة مناسبة للبيع تسهل عملية البيع
 * بالاختبارات المناسبة وبشكل احترافي».
 *
 * • clothing (ملابس — Shopify Variants):
 *   مفرق: لون → مقاس (المتاح منه فقط) → كمية → إضافة.
 *   جملة: لون → عدد الربط (الربطة = قطعة من كل مقاس، سعرها سعر
 *   القطعة بالجملة × عدد المقاسات) — يظهر عند تفعيل وضع الجملة
 *   في نافذة الموديل نفسها (حرف طلب التاجر).
 * • sizes (مطعم/كافيتريا): شريحة لكل حجم بسعره → كمية → إضافة.
 * • unit (صيدلية): الشريط افتراضياً والعلبة وحدات أكبر → كمية.
 *
 * INLINE absolute overlay — نفس درس روم الجهاز (لا Modal أبداً).
 */
function SaleSheetView({
  sheet,
  pricingMode,
  onClose,
  onAddVariant,
  onAddBundle,
  onAddSized,
  onAddUnit,
}: {
  sheet: {kind: 'clothing' | 'sizes' | 'unit'; product: Product} | null;
  pricingMode: 'RETAIL' | 'WHOLESALE';
  onClose: () => void;
  onAddVariant: (
    product: Product,
    variant: ProductVariant,
    qty: number,
  ) => void;
  onAddBundle: (product: Product, color: string, bundles: number) => void;
  onAddSized: (
    product: Product,
    sizeVariant: ProductVariant,
    qty: number,
  ) => void;
  onAddUnit: (
    product: Product,
    unit: ProductUnit | null,
    /** v38 (الجولة 46 #5): الكمية المختارة من عدّاد النافذة. */
    qty: number,
  ) => void;
}) {
  const c = useThemeColors();
  const styles = useStyles();
  const product = sheet?.product ?? null;

  // حالة الملابس: اللون ثم المقاس ثم الكمية، ووضع الجملة بالربطة.
  const [color, setColor] = useState<string | null>(null);
  const [size, setSize] = useState<string | null>(null);
  const [qty, setQty] = useState(1);
  const [wholesaleMode, setWholesaleMode] = useState(false);
  const [bundles, setBundles] = useState(1);
  // حالة الأحجام/الوحدات: الحجم/الوحدة المختارة.
  const [pickedSizeId, setPickedSizeId] = useState<number | null>(null);
  const [pickedUnitId, setPickedUnitId] = useState<number | null>(null);
  const [unitRows, setUnitRows] = useState<ProductUnit[] | null>(null);

  // صفحة جديدة — تصفير الاختيارات.
  useEffect(() => {
    setColor(null);
    setSize(null);
    setQty(1);
    setWholesaleMode(false);
    setBundles(1);
    setPickedSizeId(null);
    setPickedUnitId(null);
    setUnitRows(null);
  }, [product?.id, sheet?.kind]);

  // وحدات الصيدلية تُحمّل عند فتح النافذة.
  useEffect(() => {
    if (sheet?.kind !== 'unit' || product == null) {
      return;
    }
    let alive = true;
    UnitRepo.listForProduct(product.id)
      .then(rows => {
        if (alive) {
          setUnitRows(rows);
        }
      })
      .catch(() => {
        if (alive) {
          setUnitRows([]);
        }
      });
    return () => {
      alive = false;
    };
  }, [sheet?.kind, product?.id, product]);

  if (product == null || sheet == null) {
    return null;
  }

  const clothingVariants = (product.variants ?? []).filter(
    v => v.kind === 'variant',
  );
  const sizeVariants = (product.variants ?? []).filter(
    v => v.kind === 'size',
  );
  const colors = [...new Set(clothingVariants.map(v => v.color))];
  const activeColor = color ?? colors[0] ?? null;
  const colorVariants = clothingVariants.filter(v => v.color === activeColor);
  const sizesOfColor = colorVariants.map(v => v.size);
  const activeVariant =
    colorVariants.find(v => v.size === size) ??
    colorVariants.find(v => v.stock_quantity > 0) ??
    null;
  const untracked = product.stock_untracked === 1;

  // v37 (الجولة 45 #2أ+2ج): القيم الحية للتذييل المثبّت — كانت
  //  داخل IIFE في نهاية كل فرع داخل التمرير؛ الآن محسوبة مرة
  //  واحدة في نطاق المكون لأن التذييل يحتاجها خارج ScrollView.
  const pickedSizeVariant =
    sizeVariants.find(v => v.id === pickedSizeId) ?? null;
  const pickedUnitRow =
    (unitRows ?? []).find(row => row.unit_id === pickedUnitId) ?? null;
  const pickedSizePrice =
    pickedSizeVariant?.retail_price ?? product.retail_price;
  const pickedUnitPrice = unitPriceFor(product, pickedUnitRow, pricingMode);

  // ── أسعار الملابس ──
  const perPieceRetail = product.retail_price;
  const perPieceWholesale =
    product.wholesale_price > 0 ? product.wholesale_price : product.retail_price;
  const sizesCount =
    product.sizes_count ?? (new Set(colorVariants.map(v => v.size)).size || 1);
  const bundlePrice = Math.round(perPieceWholesale * sizesCount * 100) / 100;
  const minStockOfColor =
    colorVariants.length > 0
      ? Math.min(...colorVariants.map(v => v.stock_quantity))
      : 0;

  return (
    <View style={styles.inlineOverlay}>
      <TouchableOpacity
        style={styles.inlineOverlayDim}
        activeOpacity={1}
        onPress={onClose}
      />
      <BackHandlerCloser active={sheet != null} onClose={onClose} />
      <View style={styles.variantSheet}>
        <View style={styles.unitModalHandle} />
        <View style={styles.variantSheetHeader}>
          <View style={{flex: 1}}>
            <Text style={styles.variantSheetTitle} numberOfLines={1}>
              {product.name}
            </Text>
            <Text style={styles.variantSheetMeta} numberOfLines={1}>
              {sheet.kind === 'clothing'
                ? `${colors.length} لون · ${sizesOfColor.length} مقاس · القطعة ${formatMoney(
                    perPieceRetail,
                  )} مفرق`
                : sheet.kind === 'sizes'
                ? `${sizeVariants.length} أحجام — اختر الحجم وسعره`
                : `يُباع افتراضياً بال${
                    product.base_unit_name ?? 'قطعة'
                  } · ${formatMoney(
                    pricingMode === 'WHOLESALE'
                      ? product.wholesale_price
                      : product.retail_price,
                  )}`}
            </Text>
          </View>
          <TouchableOpacity
            style={styles.variantCloseChip}
            onPress={onClose}
            activeOpacity={0.75}>
            <Icon name="x" size={16} color={c.textDim} />
          </TouchableOpacity>
        </View>

        <ScrollView
          style={styles.variantScroll}
          contentContainerStyle={styles.variantList}
          showsVerticalScrollIndicator={false}>
          {/* ════ ملابس ════ */}
          {sheet.kind === 'clothing' ? (
            <>
              {/* مبدّل مفرق / جملة (بالربطة) — داخل نافذة الموديل
               *  نفسها كما طلب التاجر حرفياً. */}
              <View style={styles.sheetSegmentRow}>
                <TouchableOpacity
                  style={[
                    styles.sheetSegment,
                    !wholesaleMode ? styles.sheetSegmentActive : null,
                  ]}
                  onPress={() => setWholesaleMode(false)}
                  activeOpacity={0.8}>
                  <Text
                    style={[
                      styles.sheetSegmentText,
                      !wholesaleMode ? {color: c.onAccent} : null,
                    ]}>
                    مفرق — بالقطعة
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.sheetSegment,
                    wholesaleMode ? styles.sheetSegmentActive : null,
                  ]}
                  onPress={() => setWholesaleMode(true)}
                  activeOpacity={0.8}>
                  <Text
                    style={[
                      styles.sheetSegmentText,
                      wholesaleMode ? {color: c.onAccent} : null,
                    ]}>
                    جملة — بالربطة
                  </Text>
                </TouchableOpacity>
              </View>

              {/* الألوان */}
              <Text style={styles.sheetPickLabel}>اللون</Text>
              <View style={styles.sheetChipsRow}>
                {colors.map(entry => (
                  <TouchableOpacity
                    key={`sc-${entry}`}
                    style={[
                      styles.sheetChip,
                      activeColor === entry ? styles.sheetChipActive : null,
                    ]}
                    onPress={() => {
                      setColor(entry);
                      setSize(null);
                    }}
                    activeOpacity={0.75}>
                    <Text
                      style={[
                        styles.sheetChipText,
                        activeColor === entry ? {color: c.onAccent} : null,
                      ]}>
                      {entry}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              {!wholesaleMode ? (
                /* مفرق: مقاسات اللون بمخزون كل مقاس */
                <>
                  <Text style={styles.sheetPickLabel}>
                    المقاس{activeColor ? ` — لون ${activeColor}` : ''}
                  </Text>
                  <View style={styles.sheetChipsRow}>
                    {colorVariants.map(variant => {
                      const out = variant.stock_quantity <= 0 && !untracked;
                      return (
                        <TouchableOpacity
                          key={`sv-${variant.id}`}
                          style={[
                            styles.sheetChip,
                            size === variant.size ? styles.sheetChipActive : null,
                            out ? styles.sheetChipOut : null,
                          ]}
                          disabled={out}
                          onPress={() => setSize(variant.size)}
                          activeOpacity={0.75}>
                          <Text
                            style={[
                              styles.sheetChipText,
                              size === variant.size ? {color: c.onAccent} : null,
                              out ? {color: c.textFaint} : null,
                            ]}>
                            {variant.size}
                            {!untracked
                              ? ` · ${formatQty(variant.stock_quantity)}`
                              : ''}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                  <View style={styles.sheetQtyRow}>
                    <Text style={styles.sheetPickLabel}>الكمية</Text>
                    <Stepper
                      compact
                      value={qty}
                      onIncrement={() =>
                        setQty(prev =>
                          Math.min(
                            999,
                            prev + 1,
                          ),
                        )
                      }
                      onDecrement={() => setQty(prev => Math.max(1, prev - 1))}
                    />
                  </View>
                  {/* v37 (الجولة 45 #2أ+2ج): المجموع وزر التأكيد
                      انتقلا للتذييل المثبّت أسفل النافذة — لا يمكن
                      أن يختفا تحت التمرير أبداً. */}
                </>
              ) : (
                /* جملة: ربطة = قطعة من كل مقاس باللون المختار */
                <>
                  <View style={styles.bundleInfoCard}>
                    <Icon name="box" size={16} color={c.accent} />
                    <View style={{flex: 1}}>
                      <Text style={styles.bundleInfoTitle}>
                        ربطة واحدة = {sizesCount} مقاسات × قطعة
                      </Text>
                      <Text style={styles.bundleInfoMeta}>
                        سعر الربطة {formatMoney(bundlePrice)} ({formatMoney(
                          perPieceWholesale,
                        )} × {sizesCount}) · المتاح{' '}
                        {formatQty(minStockOfColor)} ربطة من هذا اللون
                      </Text>
                    </View>
                  </View>
                  <View style={styles.sheetQtyRow}>
                    <Text style={styles.sheetPickLabel}>عدد الربط</Text>
                    <Stepper
                      compact
                      value={bundles}
                      onIncrement={() =>
                        setBundles(prev =>
                          Math.min(999, Math.min(minStockOfColor, prev + 1)),
                        )
                      }
                      onDecrement={() =>
                        setBundles(prev => Math.max(1, prev - 1))
                      }
                    />
                  </View>
                  {/* v37: المجموع وزر الربطة — للتذييل المثبّت. */}
                </>
              )}
            </>
          ) : null}

          {/* ════ أحجام مطعم/كافيتريا ════ */}
          {sheet.kind === 'sizes' ? (
            <>
              <Text style={styles.sheetPickLabel}>اختر الحجم</Text>
              <View style={styles.sheetChipsColumn}>
                {sizeVariants.map(variant => {
                  const price = variant.retail_price ?? product.retail_price;
                  const active = pickedSizeId === variant.id;
                  return (
                    <TouchableOpacity
                      key={`sz-${variant.id}`}
                      style={[
                        styles.sizeOptionRow,
                        active ? styles.sizeOptionRowActive : null,
                      ]}
                      onPress={() => setPickedSizeId(variant.id)}
                      activeOpacity={0.8}>
                      <View style={styles.variantSizeChip}>
                        <Text style={styles.sizeOptionName}>{variant.size}</Text>
                      </View>
                      <View style={{flex: 1}} />
                      <Text style={styles.sizeOptionPrice}>
                        {formatMoney(price)}
                      </Text>
                      <Icon
                        name={active ? 'check' : 'chevronLeft'}
                        size={16}
                        color={active ? c.accent : c.textFaint}
                      />
                    </TouchableOpacity>
                  );
                })}
              </View>
              <View style={styles.sheetQtyRow}>
                <Text style={styles.sheetPickLabel}>الكمية</Text>
                <Stepper
                  compact
                  value={qty}
                  onIncrement={() => setQty(prev => Math.min(999, prev + 1))}
                  onDecrement={() => setQty(prev => Math.max(1, prev - 1))}
                />
              </View>
              {/* v37: مجموع الحجم وزرّه — للتذييل المثبّت. */}
            </>
          ) : null}

          {/* ════ صيدلية — وحدات البيع ════ */}
          {sheet.kind === 'unit' ? (
            <>
              <Text style={styles.sheetPickLabel}>وحدة البيع</Text>
              <View style={styles.sheetChipsColumn}>
                <TouchableOpacity
                  style={[
                    styles.sizeOptionRow,
                    pickedUnitId == null ? styles.sizeOptionRowActive : null,
                  ]}
                  onPress={() => setPickedUnitId(null)}
                  activeOpacity={0.8}>
                  <View style={styles.variantSizeChip}>
                    <Text style={styles.sizeOptionName}>
                      {product.base_unit_name ?? 'قطعة'}
                    </Text>
                  </View>
                  <View style={{flex: 1}} />
                  <Text style={styles.sizeOptionPrice}>
                    {formatMoney(
                      pricingMode === 'WHOLESALE'
                        ? product.wholesale_price
                        : product.retail_price,
                    )}
                  </Text>
                  <Icon
                    name={pickedUnitId == null ? 'check' : 'chevronLeft'}
                    size={16}
                    color={pickedUnitId == null ? c.accent : c.textFaint}
                  />
                </TouchableOpacity>
                {(unitRows ?? []).map(row => {
                  const active = pickedUnitId === row.unit_id;
                  const price = unitPriceFor(product, row, pricingMode);
                  return (
                    <TouchableOpacity
                      key={`su-${row.unit_id}`}
                      style={[
                        styles.sizeOptionRow,
                        active ? styles.sizeOptionRowActive : null,
                      ]}
                      onPress={() => setPickedUnitId(row.unit_id)}
                      activeOpacity={0.8}>
                      <View style={styles.variantSizeChip}>
                        <Text style={styles.sizeOptionName}>
                          {row.unitName}
                        </Text>
                      </View>
                      <View style={{flex: 1}}>
                        <Text style={styles.sizeOptionMeta}>
                          1 {row.unitName} = {formatQty(row.conversion)}{' '}
                          {product.base_unit_name ?? 'قطعة'}
                        </Text>
                      </View>
                      <Text style={styles.sizeOptionPrice}>
                        {formatMoney(price)}
                      </Text>
                      <Icon
                        name={active ? 'check' : 'chevronLeft'}
                        size={16}
                        color={active ? c.accent : c.textFaint}
                      />
                    </TouchableOpacity>
                  );
                })}
                {unitRows == null ? (
                  <Text style={styles.sheetTotalText}>جارٍ تحميل الوحدات…</Text>
                ) : null}
              </View>
              <View style={styles.sheetQtyRow}>
                <Text style={styles.sheetPickLabel}>الكمية</Text>
                <Stepper
                  compact
                  value={qty}
                  onIncrement={() => setQty(prev => Math.min(999, prev + 1))}
                  onDecrement={() => setQty(prev => Math.max(1, prev - 1))}
                />
              </View>
              {/* v37: مجموع الوحدة وزرّها — للتذييل المثبّت. */}
            </>
          ) : null}

        </ScrollView>

        {/* ═══ v37 (الجولة 45 #2أ+2ج): التذييل المثبّت ═══
            إصلاح جذر «نافذة البيع تظهر الترويسة فقط والباقي
            فارغ/مقتطع» + «زر التأكيد مختفٍ أسفل الشاشة»:
            • التمرير الأوسط صار بنمط ورقة الوزن المُثبتة
              (flexShrink بدل flex:1 داخل أب maxHeight) — نفس
              النمط الذي اشتغل بلا أخطاء على جهاز التاجر منذ
              عدة جولات؛ flex:1 داخل أب maxHeight-only كان ينهار
              على بعض الأجهزة فيرسم الترويسة وحدها.
            • المجموع + زر التأكيد + الحاشية في تذييل مثبّت
              تحت التمرير — لا يمكن أن يخرج عن الشاشة مهما طال
              المحتوى (ملابس بكثير من الألوان/المقاسات). */}
        <View style={styles.sheetFooter}>
          {sheet.kind === 'clothing' && !wholesaleMode ? (
            <>
              <Text style={styles.sheetTotalText}>
                {activeVariant != null
                  ? `${qty} × ${formatMoney(perPieceRetail)} = ${formatMoney(
                      qty * perPieceRetail,
                    )}`
                  : 'اختر المقاس'}
              </Text>
              <AppButton
                title={`إضافة للسلة${
                  activeVariant != null
                    ? ` · ${formatMoney(qty * perPieceRetail)}`
                    : ''
                }`}
                icon="plus"
                disabled={activeVariant == null}
                onPress={() => {
                  if (activeVariant != null) {
                    onAddVariant(product, activeVariant, qty);
                  }
                }}
              />
            </>
          ) : sheet.kind === 'clothing' && wholesaleMode ? (
            <>
              <Text style={styles.sheetTotalText}>
                {bundles} ربطة × {formatMoney(bundlePrice)} ={' '}
                {formatMoney(bundles * bundlePrice)} ({bundles * sizesCount}{' '}
                قطعة)
              </Text>
              <AppButton
                title={`إضافة للسلة · ${formatMoney(bundles * bundlePrice)}`}
                icon="plus"
                disabled={minStockOfColor <= 0}
                onPress={() => {
                  if (activeColor != null) {
                    onAddBundle(product, activeColor, bundles);
                  }
                }}
              />
            </>
          ) : sheet.kind === 'sizes' ? (
            <>
              <Text style={styles.sheetTotalText}>
                {pickedSizeVariant != null
                  ? `${qty} × ${pickedSizeVariant.size} × ${formatMoney(
                      pickedSizePrice,
                    )} = ${formatMoney(qty * pickedSizePrice)}`
                  : 'اختر الحجم أولاً'}
              </Text>
              <AppButton
                title={`إضافة للسلة${
                  pickedSizeVariant != null
                    ? ` · ${formatMoney(qty * pickedSizePrice)}`
                    : ''
                }`}
                icon="plus"
                disabled={pickedSizeVariant == null}
                onPress={() => {
                  if (pickedSizeVariant != null) {
                    onAddSized(product, pickedSizeVariant, qty);
                  }
                }}
              />
            </>
          ) : sheet.kind === 'unit' ? (
            <>
              <Text style={styles.sheetTotalText}>
                {qty} × {formatMoney(pickedUnitPrice)} ={' '}
                {formatMoney(qty * pickedUnitPrice)}
              </Text>
              <AppButton
                title={`إضافة للسلة · ${formatMoney(qty * pickedUnitPrice)}`}
                icon="plus"
                onPress={() => onAddUnit(product, pickedUnitRow, qty)}
              />
            </>
          ) : null}
          <Text style={styles.variantFootnote}>
            {sheet.kind === 'clothing'
              ? 'بيع بالقطعة: اختر اللون والمقاس — وبالجملة: الربطة تخصم قطعة من كل مقاس باللون المختار.'
              : sheet.kind === 'sizes'
              ? 'كل حجم بسعره — يظهر في السلة والفاتورة باسمه.'
              : 'الوحدة الأساس افتراضية — العلبة والوحدات الأكبر بأسعارها المشتقة.'}
          </Text>
        </View>
      </View>
    </View>
  );
}

// ────────────────────────────────────────────────────────────────
// Sub-components
// ────────────────────────────────────────────────────────────────

/** v9.1: hardware-back closer for INLINE overlays (they have no
 *  onRequestClose of their own — Modal-only API). */
function BackHandlerCloser({
  active,
  onClose,
}: {
  active: boolean;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!active) {
      return;
    }
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [active, onClose]);
  return null;
}

function UnitOption({
  label,
  meta,
  active,
  onPress,
}: {
  label: string;
  meta: string;
  active: boolean;
  onPress: () => void;
}) {
  const c = useThemeColors();
  const styles = useStyles();
  return (
    <TouchableOpacity
      style={[
        styles.unitOption,
        active
          ? {borderColor: c.accent, backgroundColor: c.accentSofter}
          : null,
      ]}
      onPress={onPress}
      activeOpacity={0.8}>
      <View style={{flex: 1}}>
        <Text style={styles.unitOptionLabel}>{label}</Text>
        <Text style={styles.unitOptionMeta}>{meta}</Text>
      </View>
      {active ? <Icon name="checkCircle" size={20} color={c.accent} /> : null}
    </TouchableOpacity>
  );
}

function SearchInput({
  value,
  onChange,
  onFocus,
  onBlur,
}: {
  value: string;
  onChange: (text: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
}) {
  const c = useThemeColors();
  const styles = useStyles();
  return (
    <View style={styles.searchWrap}>
      <Icon name="search" size={17} color={c.textFaint} />
      <TextInput
        style={styles.searchInput}
        value={value}
        onChangeText={onChange}
        onFocus={onFocus}
        onBlur={onBlur}
        placeholder="ابحث عن منتج أو باركود…"
        placeholderTextColor={c.textFaint}
        textAlign="right"
        returnKeyType="search"
      />
      {value.length > 0 ? (
        <TouchableOpacity
          onPress={() => onChange('')}
          hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
          <Icon name="x" size={15} color={c.textDim} />
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const useStyles = makeStyles(c =>
  StyleSheet.create({
    screen: {flex: 1, backgroundColor: c.bg},
    body: {flex: 1, padding: spacing.lg, gap: spacing.md},

    // Controls
    controlsRow: {gap: spacing.sm},
    // v40 (الجولة 48 #5): صف جملة/مفرق + زر شكل العرض بجانبه.
    // v42 (الجولة 50 #1): الصف مضغوط — فجوة أصغر والمبدّل قابل
    //  للانكماش كي يتسع الزر دائماً.
    modeRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    // v42 (الجولة 50 #1): غلاف المبدّل — flexShrink كي ينكمش مبدّل
    //  جملة/مفرق (مع اقتطاع نصه) بدل دفع زر الشكل خارج الشاشة
    //  على الأجهزة الضيقة أو ذات الخط الكبير.
    modeSegWrap: {
      flexShrink: 1,
      minWidth: 0,
    },
    // v42 (الجولة 50 #1): زر الشكل أيقونة فقط — مربع ثابت ٤٠×٤٠
    //  بخلفية برتقالية هادئة وإطار يضيء عند التفعيل/الاختيار؛
    //  لا نص يلتهم العرض ولا انكماش.
    viewShapeBtn: {
      width: 40,
      height: 40,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1.5,
      borderColor: c.border,
      borderRadius: radius.md,
      backgroundColor: c.accentSoft,
    },
    // v40: لوحة اختيار الشكل — INLINE في مجرى الشاشة.
    viewPickerPanel: {
      backgroundColor: c.surfaceHi,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.lg,
      padding: spacing.sm,
      gap: 4,
    },
    viewPickerHead: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 4,
      paddingBottom: 2,
    },
    viewPickerTitle: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.caption + 0.5,
    },
    viewPickerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      borderRadius: radius.md,
      paddingVertical: 7,
      paddingHorizontal: 6,
    },
    viewPickerIcon: {
      width: 40,
      height: 40,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.surface,
    },
    viewPickerLabel: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.caption + 0.5,
    },
    viewPickerHint: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.small - 0.5,
      marginTop: 1,
    },
    searchRow: {flexDirection: 'row', gap: spacing.sm, alignItems: 'center'},
    searchWrap: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      height: 46,
    },
    searchInput: {
      flex: 1,
      color: c.text,
      fontFamily: fonts.medium,
      fontSize: typography.caption,
      paddingVertical: 0,
    },
    scanButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      backgroundColor: c.accent,
      borderRadius: radius.md,
      paddingHorizontal: spacing.lg,
      height: 46,
    },
    scanButtonActive: {
      backgroundColor: c.dangerSoft,
      borderWidth: 1,
      borderColor: c.danger,
    },
    scanButtonText: {
      color: c.onAccent,
      fontFamily: fonts.bold,
      fontSize: typography.caption,
    },

    // Full-screen scanner overlay (v7 — three-zone layout)
    // v9 (round-13): INLINE overlay — the Modal-free replacement for
    // every scan-adjacent sheet (engine picker + weight pad). This
    // ROM renders RN Modals black right after the native scanner
    // window closes; an in-tree absolute overlay cannot do that.
    inlineOverlay: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      justifyContent: 'flex-end',
      zIndex: 40,
      elevation: 40,
    },
    inlineOverlayDim: {
      flex: 1,
      backgroundColor: c.overlay,
    },
    // v9 engine switcher sheet — REMOVED in v9.2 (round-15 #5):
    // 'both' mode is now ONE combined native window with an
    // in-camera engine switcher; no JS-side picker is needed.

    // Grid
    grid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.sm,
      paddingBottom: spacing.sm,
    },
    // v40 (الجولة 48 #5): شكل القائمة المضغوطة — عمود من صفوف عريضة.
    listCol: {
      gap: 6,
      paddingBottom: spacing.sm,
    },
    listRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: radius.md,
      padding: 7,
    },
    listThumb: {
      width: 46,
      height: 46,
      borderRadius: radius.sm,
      backgroundColor: c.surfaceAlt,
    },
    listName: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    listMetaRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    listPrice: {
      color: c.accent,
      fontFamily: fonts.black,
      fontSize: typography.small,
      fontVariant: ['tabular-nums'],
    },
    // v40: شكل البطاقات الكبيرة — عمودان بصور عريضة.
    cardsGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.sm,
      paddingBottom: spacing.sm,
    },
    cardTile: {
      width: CARD_TILE,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: radius.md,
      padding: spacing.sm,
      gap: 4,
    },
    cardImage: {
      width: CARD_TILE - spacing.sm * 2,
      height: Math.floor((CARD_TILE - spacing.sm * 2) * 0.92),
      borderRadius: radius.md,
      backgroundColor: c.surfaceAlt,
    },
    cardName: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.body - 1,
      minHeight: 20,
    },
    cardPrice: {
      color: c.accent,
      fontFamily: fonts.black,
      fontSize: typography.body,
      fontVariant: ['tabular-nums'],
    },
    tile: {
      width: GRID_TILE,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: radius.md,
      padding: spacing.sm,
      gap: 3,
    },
    /** v39 (الجولة 47): تكبير صورة المنتج قليلاً — المساحة المحجوزة
     *  للنصوص (الاسم + السعر + المخزون) ضُغطت من 62 إلى 54 والحشو
     *  الداخلي قلّ قليلاً فكسبت الصورة ~9 بكسل إضافية بارتفاع أوضح
     *  للصورة دون تغيير عدد الأعمدة (طلب التاجر: «كبّر حجم الصورة
     *  الخاصة بالمنتجات في السلة قليلاً»). */
    tileImage: {
      width: GRID_TILE - spacing.sm * 2,
      height: GRID_TILE - spacing.sm * 2 - 54,
      borderRadius: radius.sm,
      backgroundColor: c.surfaceAlt,
    },
    tileImageFallback: {
      alignItems: 'center',
      justifyContent: 'center',
    },
    tileName: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.small,
      minHeight: 17,
    },
    tilePrice: {
      color: c.accent,
      fontFamily: fonts.black,
      fontSize: typography.small + 1,
      fontVariant: ['tabular-nums'],
    },
    tileStockRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
    },
    stockDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
    },
    tileStock: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      flex: 1,
    },

    // Cart panel (v9 compact — round-9: "حجم السلة مناسب ولكن
    // النصوص والعناصر والأزرار كبيرة جداً لدرجة أنها تخرج منها":
    // tighter rows, compact 26px steppers, inline unit chips and
    // smaller quick-action chips — nothing overflows the panel.
    // v8.1: the lines wrap is the ONLY flexible child (flexShrink)
    // inside the capped panel — with many products it shrinks
    // and scrolls INTERNALLY instead of pushing the discount row /
    // totals / بيع buttons out of the frame under the bottom tab bar
    // (round-10 #3).
    // v8.2 (round-11 #3): maxHeight 42% → 50% and the lines wrap
    // keeps a minHeight of TWO full rows — with many products the
    // merchant ALWAYS sees at least two lines; the تكبير button
    // then grows the cart to the whole screen (grid folds away).
    cartPanel: {
      backgroundColor: c.surface,
      borderTopWidth: 1,
      borderTopColor: c.border,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: c.borderSoft,
      padding: spacing.sm,
      gap: spacing.xs,
      maxHeight: '50%',
    },
    /** v8.2: the EXPANDED cart — fills the body (grid hidden). */
    cartPanelExpanded: {
      backgroundColor: c.surface,
      borderTopWidth: 1,
      borderTopColor: c.border,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: c.borderSoft,
      padding: spacing.sm,
      gap: spacing.xs,
      flex: 1,
    },
    cartHeaderRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingBottom: 2,
      borderBottomWidth: 1,
      borderBottomColor: c.borderSoft,
    },
    cartHeaderTitle: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
    },
    cartHeaderText: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    clearCartBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      backgroundColor: c.dangerSoft,
      borderWidth: 1,
      borderColor: c.danger,
      borderRadius: radius.sm,
      paddingHorizontal: spacing.sm,
      paddingVertical: 3,
    },
    clearCartText: {
      color: c.danger,
      fontFamily: fonts.bold,
      fontSize: typography.micro,
    },
    cartEmptyRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingVertical: spacing.xs,
    },
    cartEmptyText: {
      flex: 1,
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      lineHeight: 18,
    },
    /** v9 (round-13 #3): the one-line cart summary shown while the
     *  search box holds keyboard focus — tap it to drop the keyboard
     *  and bring the full cart back. */
    cartPeekRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm + 1,
    },
    cartPeekText: {
      flex: 1,
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.small,
      fontVariant: ['tabular-nums'],
    },
    cartPeekHint: {
      color: c.accent,
      fontFamily: fonts.bold,
      fontSize: typography.micro,
    },
    /** v9 (round-13 #1): the INLINE visual-scan candidate strip. */
    visionStrip: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: radius.md,
      paddingHorizontal: spacing.sm + 2,
      paddingVertical: spacing.xs + 1,
      gap: spacing.xs,
    },
    visionStripHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    visionStripTitle: {
      flex: 1,
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.micro + 0.5,
    },
    visionStripRow: {
      gap: spacing.sm,
      paddingVertical: 2,
    },
    visionChip: {
      backgroundColor: c.surfaceAlt,
      borderWidth: 1,
      borderColor: c.accentSoft,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs + 1,
      minWidth: 96,
    },
    visionChipName: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    visionChipMeta: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 0.5,
      marginTop: 1,
      fontVariant: ['tabular-nums'],
    },
    cartLinesWrap: {
      // v8.2: minHeight = TWO full cart rows (~2 × 42dp) — the
      // merchant always sees at least two products no matter how
      // full the panel gets; above that the list scrolls internally.
      flexShrink: 1,
      minHeight: 88,
      overflow: 'hidden',
    },
    /** v8.2: expanded cart — the list takes ALL the freed space. */
    cartLinesWrapExpanded: {
      flex: 1,
      minHeight: 88,
      overflow: 'hidden',
    },
    /** v42 (الجولة 50 #5): زرا حجم السلة — أيقونيان فقط (تكبير
     *  وتصغير) متجاوران في كبسولة واحدة بجانب عنوان السلة؛
     *  التصغير يطوي اللوحة إلى شريط السطر الواحد. */
    cartSizeBtns: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      backgroundColor: c.accentSofter,
      borderRadius: radius.sm,
      padding: 3,
    },
    cartSizeBtn: {
      width: 30,
      height: 26,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.sm - 2,
      borderWidth: 1,
      borderColor: c.borderSoft,
      backgroundColor: c.surface,
    },
    cartLine: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm - 2,
      paddingVertical: 3.5,
      borderBottomWidth: 1,
      borderBottomColor: c.borderSoft,
    },
    cartLineInfo: {flex: 1},
    cartLineName: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    cartLineMetaRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      marginTop: 1.5,
    },
    cartLineMeta: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 0.5,
      flexShrink: 1,
      fontVariant: ['tabular-nums'],
    },
    unitChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 3,
      backgroundColor: c.accentSofter,
      borderRadius: radius.pill,
      paddingHorizontal: 7,
      paddingVertical: 1.5,
    },
    unitChipText: {
      color: c.accent,
      fontFamily: fonts.bold,
      fontSize: typography.micro - 0.5,
    },
    removeBtn: {
      width: 26,
      height: 26,
      alignItems: 'center',
      justifyContent: 'center',
    },
    discountRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm - 2,
    },
    discountLabel: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    discountInput: {
      width: 62,
      backgroundColor: c.surfaceAlt,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.sm,
      color: c.text,
      textAlign: 'center',
      paddingVertical: 4,
      fontSize: typography.small,
      fontFamily: fonts.bold,
    },
    quickChip: {
      backgroundColor: c.accentSoft,
      borderRadius: radius.sm,
      paddingHorizontal: spacing.sm + 2,
      paddingVertical: 4,
    },
    quickChipGhost: {backgroundColor: c.surfaceAlt},
    quickChipText: {
      color: c.accent,
      fontFamily: fonts.bold,
      fontSize: typography.micro + 1,
    },
    totalsRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingTop: 2,
    },
    totalLabel: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.small,
      flexShrink: 1,
    },
    discountValue: {
      color: c.danger,
      fontFamily: fonts.bold,
      fontSize: typography.small,
      marginTop: 2,
    },
    // v22 (round-28 #1): the blocked voucher handover banner — a
    // voucher the server redeemed whose cart was smaller than its
    // value; the handover waits here until the cart is topped up.
    pendingVoucherBox: {
      backgroundColor: 'rgba(245,158,11,0.10)',
      borderWidth: 1,
      borderColor: 'rgba(245,158,11,0.45)',
      borderRadius: radius.sm,
      padding: spacing.sm,
      gap: 6,
    },
    pendingVoucherHead: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    pendingVoucherTitle: {
      flex: 1,
      color: '#FCD34D',
      fontFamily: fonts.bold,
      fontSize: typography.micro + 1,
    },
    pendingVoucherMeta: {
      color: '#C9C9D4',
      fontFamily: fonts.regular,
      fontSize: typography.micro,
    },
    pendingVoucherHint: {
      color: '#FDBA74',
      fontFamily: fonts.bold,
      fontSize: typography.micro,
      lineHeight: 15,
    },
    pendingVoucherActions: {
      flexDirection: 'row',
    },
    checkoutRow: {
      flexDirection: 'row',
      gap: spacing.sm,
    },
    // v11 (SILA): the compact debt chip — icon-first so the checkout
    // row stays light (round-17: "استخدم معه رموز").
    // v12 (round-18 #2): overflow visible — Android Views clip at
    // their bounds by default, which was cutting the pending-count
    // notification badge at the corner. The badge must render fully.
    debtBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      minHeight: 50,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      backgroundColor: c.surfaceHi,
      borderWidth: 1,
      borderColor: c.border,
      overflow: 'visible',
      zIndex: 10,
      elevation: 0,
    },
    /** v20: the قسيمة chip — the voucher twin of the debt chip. */
    voucherBtn: {
      borderColor: c.infoSoft,
    },
    debtBtnPaired: {
      backgroundColor: c.accentSofter,
      borderColor: c.accent,
    },
    debtBtnText: {
      fontFamily: fonts.bold,
      fontSize: typography.body,
    },
    debtBadge: {
      position: 'absolute',
      top: -6,
      end: -4,
      minWidth: 18,
      height: 18,
      borderRadius: 9,
      backgroundColor: c.danger,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 4,
      // A crisp outline so the badge reads clearly against any
      // neighbouring element it overlaps (round-18 #2).
      borderWidth: 1.5,
      borderColor: c.surfaceHi,
      zIndex: 11,
    },
    debtBadgeText: {
      color: '#fff',
      fontFamily: fonts.bold,
      fontSize: 10,
      lineHeight: 13,
      fontVariant: ['tabular-nums'],
    },
    // v11 (SILA): debt confirmation sheet — INLINE absolute overlay
    // (post-scanner sheets must not be RN Modals on this ROM).
    debtOverlay: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      justifyContent: 'flex-end',
      zIndex: 60,
      elevation: 60,
    },
    debtOverlayDim: {
      flex: 1,
      backgroundColor: c.overlay,
    },
    debtModalSheet: {
      backgroundColor: c.surface,
      borderTopLeftRadius: radius.lg + 4,
      borderTopRightRadius: radius.lg + 4,
      padding: spacing.lg,
      gap: spacing.sm,
      paddingBottom: spacing.xxl,
    },
    debtModalTitle: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: typography.heading,
      textAlign: 'center',
      marginBottom: spacing.xs,
    },
    debtCustomerCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: c.accentSofter,
      borderRadius: radius.md,
      padding: spacing.md,
      borderWidth: 1,
      borderColor: c.border,
    },
    debtCustomerIcon: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: c.surface,
      alignItems: 'center',
      justifyContent: 'center',
    },
    debtCustomerName: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.body,
    },
    debtCustomerMeta: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      marginTop: 2,
    },
    debtAmountRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
    },
    debtAmountLabel: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.body,
    },
    debtWarnBox: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.sm,
      backgroundColor: c.dangerSoft,
      borderRadius: radius.sm,
      padding: spacing.md,
    },
    debtWarnText: {
      flex: 1,
      color: c.danger,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      lineHeight: 19,
    },
    // v17 (round-23 #3): the prepaid-credit split box.
    debtCreditBox: {
      backgroundColor: c.successSoft,
      borderWidth: 1,
      borderColor: c.success,
      borderRadius: radius.sm,
      padding: spacing.md,
      gap: 6,
    },
    debtCreditRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    debtCreditText: {
      flex: 1,
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    debtCreditNote: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      lineHeight: 16,
      marginTop: 2,
    },
    debtHintRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: spacing.xs,
    },
    debtHintText: {
      flex: 1,
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      lineHeight: 18,
    },
    debtActions: {
      flexDirection: 'row',
      gap: spacing.sm,
      marginTop: spacing.sm,
    },

    // Unit picker modal
    unitModalOverlay: {
      flex: 1,
      backgroundColor: c.overlay,
      justifyContent: 'flex-end',
    },
    unitModalSheet: {
      backgroundColor: c.surface,
      borderTopLeftRadius: radius.lg + 4,
      borderTopRightRadius: radius.lg + 4,
      padding: spacing.lg,
      gap: spacing.sm,
      paddingBottom: spacing.xxl,
    },
    unitModalHandle: {
      alignSelf: 'center',
      width: 44,
      height: 4,
      borderRadius: 2,
      backgroundColor: c.border,
      marginBottom: spacing.xs,
    },
    unitModalTitle: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: typography.heading,
      textAlign: 'center',
      marginBottom: spacing.sm,
    },
    unitModalMuted: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.caption,
      textAlign: 'center',
    },
    unitModalHint: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      textAlign: 'center',
      lineHeight: 18,
      marginTop: spacing.sm,
    },

    // ── v34 (الجولة 42 #3): تجان الموديل المجمّع + نافذة المقاس ──
    tileStyleGroup: {
      borderWidth: 1,
      borderColor: c.accentSoft,
    },
    styleSizesBadge: {
      position: 'absolute',
      top: spacing.xs + 2,
      left: spacing.xs + 2,
      backgroundColor: c.accent,
      borderRadius: 9,
      paddingHorizontal: 7,
      height: 18,
      alignItems: 'center',
      justifyContent: 'center',
    },
    styleSizesBadgeText: {
      color: c.onAccent,
      fontFamily: fonts.bold,
      fontSize: 10,
    },
    variantSheet: {
      backgroundColor: c.bg,
      borderTopLeftRadius: radius.lg + 4,
      borderTopRightRadius: radius.lg + 4,
      padding: spacing.lg,
      gap: spacing.sm,
      // v37 (الجولة 45 #2أ): 72% → 78% — مساحة أرحب للمحتوى مع
      //  التذييل المثبّت (المجموع + زر التأكيد + الحاشية).
      maxHeight: '78%',
    },
    variantSheetHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    variantSheetTitle: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: typography.heading,
    },
    variantSheetMeta: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      marginTop: 2,
    },
    variantCloseChip: {
      width: 34,
      height: 34,
      borderRadius: 17,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    variantList: {
      gap: 8,
      // v37: كان paddingBottom ضخماً ليغطي الأزرار التي كانت
      //  داخل التمرير — انتقلت للتذييل المثبّت فاستُبدل بحشوة
      //  صغيرة أنيقة.
      paddingBottom: spacing.sm,
    },
    /** v37 (الجولة 45 #2أ): التمرير الأوسط بنمط ورقة الوزن
     *  المُثبتة — flexShrink بدل flex:1. flex:1 داخل أب
     *  maxHeight-only كان يرسم الترويسة وحدها على بعض الأجهزة
     *  (شكوى: «تظهر الترويسة فقط والباقي فارغ/مقتطع»). */
    variantScroll: {
      flexShrink: 1,
    },
    /** v37 (الجولة 45 #2ج): التذييل المثبّت — المجموع + زر
     *  التأكيد + الحاشية تحت خط فاصل؛ لا يتحرك مع التمرير
     *  ولا يمكن أن يخرج عن الشاشة مهما طال المحتوى. */
    sheetFooter: {
      borderTopWidth: 1,
      borderTopColor: c.borderSoft,
      paddingTop: spacing.sm,
      gap: spacing.xs,
    },
    /** v35 (الجولة 43): نافذة البيع الموحدة — مقاطع مفرق/جملة
     *  وشرائح اللون والمقاس والحجم والوحدة وبطاقة الربطة. */
    sheetSegmentRow: {
      flexDirection: 'row',
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.md,
      padding: 3,
      gap: 3,
    },
    sheetSegment: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 9,
      borderRadius: radius.sm,
    },
    sheetSegmentActive: {
      backgroundColor: c.accent,
    },
    sheetSegmentText: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    sheetPickLabel: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.small,
      marginTop: 4,
    },
    sheetChipsRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 7,
    },
    sheetChipsColumn: {
      gap: 7,
    },
    sheetChip: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.sm,
      backgroundColor: c.surface,
      paddingVertical: 8,
      paddingHorizontal: 13,
      minWidth: 52,
      alignItems: 'center',
    },
    sheetChipActive: {
      backgroundColor: c.accent,
      borderColor: c.accent,
    },
    sheetChipOut: {
      opacity: 0.45,
    },
    sheetChipText: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    sheetQtyRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 4,
    },
    sheetTotalText: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.body,
      textAlign: 'left',
    },
    bundleInfoCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: radius.md,
      padding: spacing.md,
      backgroundColor: c.surface,
    },
    bundleInfoTitle: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.body,
    },
    bundleInfoMeta: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      marginTop: 2,
      lineHeight: 17,
    },
    sizeOptionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      paddingVertical: 11,
      paddingHorizontal: spacing.md,
      backgroundColor: c.surface,
    },
    sizeOptionRowActive: {
      borderColor: c.accent,
      borderWidth: 1.5,
    },
    sizeOptionName: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.body,
    },
    sizeOptionMeta: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
    },
    sizeOptionPrice: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: typography.body,
    },
    variantLabelChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      borderWidth: 1,
      borderColor: c.accent,
      borderRadius: radius.sm,
      backgroundColor: c.surface,
      paddingVertical: 3,
      paddingHorizontal: 7,
      maxWidth: 130,
    },
    variantLabelChipText: {
      color: c.accent,
      fontFamily: fonts.bold,
      fontSize: typography.micro + 1,
    },
    variantRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      padding: spacing.sm + 2,
    },
    variantRowOut: {
      opacity: 0.55,
    },
    variantSizeChip: {
      minWidth: 48,
      height: 34,
      borderRadius: radius.sm,
      backgroundColor: c.accentSofter,
      borderWidth: 1,
      borderColor: c.accentSoft,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 8,
    },
    variantSizeText: {
      color: c.accent,
      fontFamily: fonts.black,
      fontSize: typography.body,
    },
    variantRowName: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    variantRowMeta: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      marginTop: 1,
    },
    variantRowPrice: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: typography.body,
      fontVariant: ['tabular-nums'],
    },
    variantFootnote: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      textAlign: 'center',
      lineHeight: 16,
      marginTop: spacing.xs,
    },

    // ── v9.2 (round-15 #1): weight pad — BUILT-IN keypad ────────
    // No TextInput → no system keyboard → no KeyboardAvoidingView:
    // the sheet is compact, bottom-pinned and can never get stuck.
    weightBadge: {
      position: 'absolute',
      top: spacing.xs + 2,
      left: spacing.xs + 2,
      width: 20,
      height: 20,
      borderRadius: 10,
      backgroundColor: c.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    weightSheet: {
      backgroundColor: c.surface,
      borderTopLeftRadius: radius.lg + 4,
      borderTopRightRadius: radius.lg + 4,
      padding: spacing.lg,
      paddingBottom: spacing.lg + 4,
      gap: spacing.sm,
      maxHeight: '84%',
    },
    weightScroll: {
      flexShrink: 1,
    },
    weightScrollContent: {
      gap: spacing.sm,
    },
    weightSheetTitle: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: typography.body + 1,
      textAlign: 'right',
    },
    weightHeaderRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    weightKiloPrice: {
      color: c.accent,
      fontFamily: fonts.bold,
      fontSize: typography.caption - 0.5,
      textAlign: 'right',
      marginTop: 1,
    },
    weightClearChip: {
      backgroundColor: c.surfaceAlt,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs + 1,
    },
    weightClearText: {
      color: c.danger,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    weightDisplayRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      backgroundColor: c.surfaceAlt,
      borderWidth: 1.5,
      borderColor: c.accent,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs + 2,
    },
    weightDisplay: {
      flex: 1,
      color: c.text,
      fontFamily: fonts.black,
      fontSize: 30,
      textAlign: 'center',
      fontVariant: ['tabular-nums'],
    },
    weightDisplayUnit: {
      color: c.accent,
      fontFamily: fonts.bold,
      fontSize: typography.body,
    },
    weightDisplayTotal: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: typography.body,
      fontVariant: ['tabular-nums'],
    },
    weightPadRow: {
      flexDirection: 'row',
      gap: spacing.sm,
    },
    keypad: {
      flex: 2.1,
      gap: spacing.xs + 2,
    },
    keypadRow: {
      flexDirection: 'row',
      gap: spacing.xs + 2,
    },
    keypadKey: {
      flex: 1,
      height: 52,
      borderRadius: radius.md,
      backgroundColor: c.surfaceAlt,
      borderWidth: 1,
      borderColor: c.borderSoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    keypadKeyDanger: {
      borderColor: c.danger,
    },
    keypadKeyText: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: 22,
      fontVariant: ['tabular-nums'],
    },
    weightQuickColumn: {
      flex: 1,
      gap: spacing.xs + 2,
    },
    weightQuickChip: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.surfaceAlt,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      paddingHorizontal: spacing.xs,
      minHeight: 34,
    },
    weightQuickValue: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: typography.caption,
      maxWidth: 96,
      fontVariant: ['tabular-nums'],
    },
    weightQuickName: {
      color: c.textFaint,
      fontFamily: fonts.bold,
      fontSize: typography.micro,
      marginTop: 1,
    },
    weightQuickLabel: {
      color: c.textFaint,
      fontFamily: fonts.bold,
      fontSize: typography.micro + 1,
    },

    weightActionRow: {
      flexDirection: 'row',
      gap: spacing.sm,
    },
    unitOption: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: c.surfaceAlt,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      padding: spacing.md,
    },
    unitOptionLabel: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.caption,
    },
    unitOptionMeta: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      marginTop: 1,
    },
    // v15 (round-21 #5): debt chooser + customers picker sheets.
    chooserHint: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      textAlign: 'center',
      marginBottom: spacing.xs,
    },
    chooserBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: c.surfaceHi,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.borderSoft,
      padding: spacing.md,
    },
    chooserIcon: {
      width: 46,
      height: 46,
      borderRadius: 14,
      backgroundColor: c.accentSofter,
      alignItems: 'center',
      justifyContent: 'center',
    },
    chooserTitle: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.body,
    },
    chooserText: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      lineHeight: 17,
      marginTop: 1,
    },
    pickerSheet: {
      backgroundColor: c.surface,
      borderTopLeftRadius: radius.lg + 4,
      borderTopRightRadius: radius.lg + 4,
      padding: spacing.lg,
      gap: spacing.sm,
      paddingBottom: spacing.lg,
      maxHeight: '82%',
    },
    pickerSearch: {
      backgroundColor: c.surfaceHi,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.body,
      textAlign: 'right',
      paddingVertical: spacing.sm + 2,
      paddingHorizontal: spacing.md,
    },
    pickerList: {
      flexGrow: 0,
    },
    pickerListContent: {
      gap: spacing.xs,
      paddingBottom: spacing.sm,
    },
    pickerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: c.surfaceHi,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.borderSoft,
      padding: spacing.sm + 2,
    },
    pickerAvatar: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: c.accentSofter,
      alignItems: 'center',
      justifyContent: 'center',
    },
    pickerInitial: {
      color: c.accent,
      fontFamily: fonts.black,
      fontSize: typography.body,
    },
    pickerName: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.caption + 1,
    },
    pickerMeta: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      marginTop: 1,
    },
  }),
);
