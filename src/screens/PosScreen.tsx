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
import React, {useCallback, useEffect, useMemo, useState} from 'react';
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
import {useSettingsStore} from '../stores/settingsStore';
import {usePrinterStore} from '../stores/printerStore';
import {useToastStore} from '../stores/toastStore';
import {InvoiceService} from '../services/InvoiceService';
import {ProductRepo} from '../database/repositories/ProductRepo';
import {UnitRepo} from '../database/repositories/UnitRepo';
import {VisionRecognitionService} from '../services/vision/VisionRecognitionService';
import {
  cameraPermissionMessage,
  ensureCameraPermission,
  notifyScanResult,
  openAppSettings,
  scanBarcodeContinuous,
  scanBothContinuous,
  scanVisualContinuous,
} from '../services/vision/scanFlow';
import {PlatformUtilsNative, requirePlatformUtils} from '../native/nativeBridge';
import {
  BASE_UNIT_NAME,
  QUICK_WEIGHTS,
  VISION_AMBIGUITY_MARGIN,
  WEIGHT_UNIT_NAME,
  type ScannerMode,
} from '../core/config';
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
import type {CartLine, Product, ProductUnit} from '../core/types';

const GRID_COLUMNS = 3;
const SCREEN_WIDTH = Dimensions.get('window').width;
const GRID_TILE = Math.floor(
  (SCREEN_WIDTH - spacing.lg * 2 - spacing.sm * (GRID_COLUMNS - 1)) /
    GRID_COLUMNS,
);

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
 *  is fully SILENT (no banner, no counter, no prompt). */
type BarcodeOutcome =
  | {status: 'added'; name: string; product: Product; unitPrice: number}
  | {status: 'queued'; name: string}
  | {status: 'unknown'}
  | {status: 'error'; name?: string};

export function PosScreen() {
  const c = useThemeColors();
  const styles = useStyles();
  const insets = useSafeAreaInsets();

  const lines = useCartStore(state => state.lines);
  const pricingMode = useCartStore(state => state.pricingMode);
  const discount = useCartStore(state => state.discount);
  const addProduct = useCartStore(state => state.addProduct);
  const addWeighted = useCartStore(state => state.addWeighted);
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
  const printerStatus = usePrinterStore(state => state.status);
  const toast = useToastStore(state => state.show);

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
  // v8.2 (round-11 #3): cart expand toggle — the cart grows to fill
  // the whole screen (grid folds away) so the merchant can review a
  // long sale comfortably, then shrinks back to keep selling.
  const [cartExpanded, setCartExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [unitPickerLine, setUnitPickerLine] = useState<CartLine | null>(null);
  const [unitPickerRows, setUnitPickerRows] = useState<ProductUnit[] | null>(
    null,
  );
  // v8.3 (round-12 #4): the WEIGHT pad — a weight-sold product can
  // never be added as "one piece": tapping it (or scanning it) opens
  // this sheet so the merchant types/weighs the kg amount.
  const [weightProduct, setWeightProduct] = useState<Product | null>(null);
  const [weightUnitRows, setWeightUnitRows] = useState<ProductUnit[] | null>(
    null,
  );
  /** Weight products recognized DURING a continuous scan session
   *  — they wait here and their weight pads open one by one when the
   *  scanner closes (the Loyverse scale-item pattern). */
  const [pendingWeight, setPendingWeight] = useState<Product[]>([]);
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

  const scannerMode: ScannerMode = settings.scannerMode;
  const barcodeActive = scannerMode === 'barcode' || scannerMode === 'both';
  const visualActive = scannerMode === 'visual' || scannerMode === 'both';

  const totals = useMemo(() => cartTotals(lines, discount), [lines, discount]);

  useEffect(() => {
    if (discount === 0) {
      setDiscountText('');
    }
  }, [discount]);

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
    (product: Product, unit?: ProductUnit | null) => {
      // v8.3 (round-12 #4): weight-sold products NEVER add as whole
      // pieces — the weight pad opens instead (type kg or tap وقية /
      // نصف كغ quick chips; price = kg × kilo price).
      if (isWeightProduct(product)) {
        openWeightPad(product);
        return;
      }
      const result = addProduct(product, pricingMode, unit ?? null);
      if (result.added) {
        beep();
      } else if (result.reason) {
        toast(result.reason, 'error');
      }
    },
    [addProduct, pricingMode, beep, toast, openWeightPad],
  );

  // v8.3: queued weight pads — one scanner session can recognize
  // several weight products; each gets its pad in turn when the
  // native window closes.
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
            ? unitPriceFor(
                product,
                unit,
                useCartStore.getState().pricingMode,
              )
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
      Alert.alert(
        'إذن الكاميرا مطلوب',
        cameraPermissionMessage(permission),
        [
          {text: 'إغلاق', style: 'cancel'},
          {
            text: 'فتح الإعدادات',
            onPress: () => {
              void openAppSettings();
            },
          },
        ],
      );
      return false;
    }
    return true;
  }, []);

  /**
   * v9.2 (round-15 #4): ONE photo-recognition pipeline shared by the
   * visual and combined sessions. v9.1 quality engine (round-14
   * #2a): each photo runs a FOUR-CROP ENSEMBLE (classic center +
   * 0.78 zoom + 0.56 zoom + whole-frame fit) scored per DISTINCT
   * product across ALL its registered fingerprints (3 angles ×
   * mirrors). The best product auto-adds only when it ALSO beats the
   * runner-up by VISION_AMBIGUITY_MARGIN — two lookalikes scoring
   * 0.84 vs 0.83 is a coin flip the merchant settles with one tap,
   * not a silent wrong add.
   * v9.2 (round-15 #4): every outcome is confirmed LIVE inside the
   * camera window with an actionable message — what was added (name
   * + ×N + price), what to do with a weight product, and HOW to fix
   * a miss (get closer / fill the frame / retake).
   */
  const processVisionPhoto = useCallback(
    async (photoPath: string, session: ScanSession) => {
      try {
        await VisionRecognitionService.loadModel();
        const probes = await VisionRecognitionService.embedPhotoEnsemble(
          photoPath,
        );
        const live = useCatalogStore.getState().embeddingsIndex;
        if (live == null || live.ids.length === 0) {
          await notifyScanResult(
            false,
            'لا توجد بصمات بصرية بعد — سجّل صور المنتجات من شاشة المنتج',
          );
          return;
        }
        const top = VisionRecognitionService.matchMulti(probes, live, 4);
        const allProducts = useCatalogStore.getState().products;
        const matches = top
          .map(match => ({
            product: allProducts.find(entry => entry.id === match.productId),
            score: match.score,
          }))
          .filter(
            (match): match is {product: Product; score: number} =>
              match.product != null,
          );
        if (matches.length === 0) {
          await notifyScanResult(
            false,
            'لم يتم التعرف — اقترب أكثر واملأ الإطار بالمنتج ثم أعد التصوير',
          );
          return;
        }
        const threshold = useSettingsStore.getState().settings.matchThreshold;
        const best = matches[0];
        const runnerUp = matches[1];
        const ambiguousPick =
          runnerUp != null &&
          best.score - runnerUp.score < VISION_AMBIGUITY_MARGIN;
        if (best.score >= threshold && !ambiguousPick) {
          // Confident + unambiguous → straight into the cart.
          if (isWeightProduct(best.product)) {
            session.confirmed++;
            session.counts.set(
              best.product.id,
              (session.counts.get(best.product.id) ?? 0) + 1,
            );
            beep();
            await notifyScanResult(
              true,
              `منتج وزن — أدخل وزنه عند الإغلاق: ${best.product.name}`,
            );
            if (
              !session.weightQueue.some(entry => entry.id === best.product.id)
            ) {
              session.weightQueue.push(best.product);
            }
            return;
          }
          const mode = useCartStore.getState().pricingMode;
          const result = addProduct(best.product, mode, null);
          if (result.added) {
            session.confirmed++;
            session.counts.set(
              best.product.id,
              (session.counts.get(best.product.id) ?? 0) + 1,
            );
            beep();
            await notifyScanResult(
              true,
              addedMessage(
                session,
                best.product,
                mode === 'WHOLESALE'
                  ? best.product.wholesale_price
                  : best.product.retail_price,
              ),
            );
          } else if (result.reason) {
            await notifyScanResult(false, result.reason);
          }
        } else {
          // Low score or a lookalike tie → candidates for later.
          await notifyScanResult(
            ambiguousPick,
            ambiguousPick
              ? 'منتجان متشابهان — سيظهران عند الإغلاق لتختار الصحيح'
              : 'التعرف غير مؤكد — اقترب وتصوّر مرة أخرى، أو اختر المرشحين عند الإغلاق',
          );
          for (const match of matches.slice(0, 3)) {
            if (
              !session.ambiguous.some(
                entry => entry.product.id === match.product.id,
              )
            ) {
              session.ambiguous.push(match);
            }
          }
        }
      } catch (error) {
        await notifyScanResult(
          false,
          error instanceof Error
            ? `فشل تحليل الصورة: ${error.message}`
            : 'فشل تحليل الصورة — أعد التصوير',
        );
      } finally {
        // The full-res scan file has served its purpose — free the
        // space (thumbnails/fingerprints are already stored).
        if (PlatformUtilsNative != null) {
          void PlatformUtilsNative.deleteFile(photoPath).catch(() => {});
        }
      }
    },
    [addProduct, beep],
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
              merged.push(product);
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
        const sorted = [...session.ambiguous].sort(
          (a, b) => b.score - a.score,
        );
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
   *  open the pad instead). */
  const pickVisionMatch = useCallback(
    (product: Product) => {
      setVisionMatches(null);
      if (isWeightProduct(product)) {
        beep();
        openWeightPad(product);
        return;
      }
      const result = addProduct(product, useCartStore.getState().pricingMode, null);
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
        const product = await ProductRepo.findByBarcode(code);
        if (product != null) {
          if (isWeightProduct(product)) {
            setPendingWeight(prev =>
              prev.some(entry => entry.id === product.id)
                ? prev
                : [...prev, product],
            );
            beep();
            return {status: 'queued', name: product.name};
          }
          const mode = useCartStore.getState().pricingMode;
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
          if (result.reason) {
            toast(result.reason, 'error');
          }
          return {status: 'error', name: product.name};
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
                unitPrice: unitPriceFor(
                  unitProduct,
                  unitHit.productUnit,
                  mode,
                ),
              };
            }
            if (result.reason) {
              toast(result.reason, 'error');
            }
            return {status: 'error', name: unitProduct.name};
          }
        }
        // 3. Unknown → SILENT (round-15 #2): no message, no counter.
        return {status: 'unknown'};
      } catch (error) {
        toast(
          error instanceof Error ? error.message : 'فشل البحث عن الباركود',
          'error',
        );
        return {status: 'error'};
      }
    },
    [addProduct, beep, toast],
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
              `منتج وزن — أدخل وزنه عند الإغلاق: ${outcome.name}`,
            );
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
              `منتج وزن — أدخل وزنه عند الإغلاق: ${outcome.name}`,
            );
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
      toast(
        error instanceof Error ? error.message : 'فشل جلسة المسح',
        'error',
      );
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
        toast(
          'لا توجد طابعة متصلة — أكمل البيع بدون طباعة أو أوصل الطابعة أولاً',
          'error',
        );
        return;
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

  /** v8: scan entry — dispatches to the right NATIVE engine.
   *  barcode/visual modes open their engine directly; v9.2 (round-15
   *  #5) 'both' opens ONE combined window whose in-camera switcher
   * flips between باركود and بصري while the camera keeps running —
   * the separate picker sheet is gone. */
  const openScanner = useCallback(() => {
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

  return (
    <View style={styles.screen}>
      {/* v8.2 (round-11 #3): NO top header — every millimeter of the
          screen works for the product grid and the cart. The pricing
          mode is already visible in the Segmented control. */}
      <View style={[styles.body, {paddingTop: insets.top + spacing.sm}]}>
        {/* ── Pricing mode + search + scan ─────────────────── */}
        <View style={styles.controlsRow}>
          <Segmented
            value={pricingMode}
            onChange={setPricingMode}
            options={[
              {value: 'RETAIL', label: 'مفرق'},
              {value: 'WHOLESALE', label: 'جملة'},
            ]}
            compact
          />
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
                }}
                onBlur={() => setSearchFocused(false)}
              />
            </View>
          </View>
        </View>

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
              contentContainerStyle={styles.grid}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled">
              {filteredProducts.length === 0 ? (
                <View style={{paddingTop: spacing.xl}}>
                  <EmptyState
                    icon="search"
                    title="لا نتائج"
                    subtitle={`لا منتج يطابق «${search}»`}
                  />
                </View>
              ) : (
                filteredProducts.map(product => {
                  const stockState = stockStateOf(
                    product,
                    settings.lowStockDefaultThreshold,
                  );
                  const weighted = isWeightProduct(product);
                  return (
                    <TouchableOpacity
                      key={product.id}
                      style={styles.tile}
                      onPress={() => tryAdd(product)}
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
                          <Icon
                            name="scale"
                            size={9}
                            color={c.onAccent}
                          />
                        </View>
                      ) : null}
                      <Text style={styles.tileName} numberOfLines={1}>
                        {product.name}
                      </Text>
                      <Text style={styles.tilePrice}>
                        {formatMoney(priceOf(product))}
                        {weighted ? '/كغ' : ''}
                      </Text>
                      <View style={styles.tileStockRow}>
                        <View
                          style={[
                            styles.stockDot,
                            {
                              backgroundColor:
                                stockState === 'out'
                                  ? c.danger
                                  : stockState === 'low'
                                  ? c.warning
                                  : c.success,
                            },
                          ]}
                        />
                        <Text style={styles.tileStock}>
                          {stockState === 'out'
                            ? 'نفد'
                            : `${formatQty(product.stock_quantity)} ${baseUnitLabelOf(
                                product,
                                BASE_UNIT_NAME,
                              )}`}
                        </Text>
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
            dismisses the keyboard and the full cart returns. */}
        {searchFocused && !cartExpanded ? (
          lines.length === 0 ? null : (
            <TouchableOpacity
              style={styles.cartPeekRow}
              activeOpacity={0.8}
              onPress={() => {
                Keyboard.dismiss();
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
            <View style={styles.cartEmptyRow}>
              <Icon name="cart" size={18} color={c.textFaint} />
              <Text style={styles.cartEmptyText}>
                السلة فارغة — المس منتجاً من الشبكة أو امسحه
                {barcodeActive ? ' بالباركود' : ''}
                {barcodeActive && visualActive ? ' أو ' : ''}
                {visualActive ? 'بالكاميرا' : ''}
                {embeddingsCount === 0 && products.length > 0 && !barcodeActive
                  ? ' (لا توجد بصمات بصرية محفوظة بعد — البيع باللمس متاح)'
                  : ''}
              </Text>
            </View>
          ) : (
            <>
              {/* Compact header: expand toggle + title + live count +
                  EMPTY button (round-8). v8.2 (round-11 #3): تكبير
                  grows the cart to the full screen, تصغير folds it
                  back — reviewing a long sale is now comfortable. */}
              <View style={styles.cartHeaderRow}>
                <TouchableOpacity
                  style={styles.expandBtn}
                  onPress={toggleCartExpanded}
                  activeOpacity={0.75}
                  hitSlop={{top: 6, bottom: 6, left: 6, right: 6}}>
                  <View
                    style={{
                      transform: [{rotate: cartExpanded ? '0deg' : '180deg'}],
                    }}>
                    <Icon name="chevronDown" size={13} color={c.accent} />
                  </View>
                  <Text style={styles.expandBtnText}>
                    {cartExpanded ? 'تصغير' : 'تكبير'}
                  </Text>
                </TouchableOpacity>
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
                            rows tall max and nothing overflows. */}
                        <View style={styles.cartLineMetaRow}>
                          <Text style={styles.cartLineMeta} numberOfLines={1}>
                            {formatMoney(line.unitPrice)} ×{' '}
                            {formatQty(line.quantity)} ={' '}
                            {formatMoney(line.unitPrice * line.quantity)}
                          </Text>
                          <TouchableOpacity
                            style={styles.unitChip}
                            onPress={() => openUnitPicker(line)}
                            activeOpacity={0.8}>
                            <Icon name="scale" size={10} color={c.accent} />
                            <Text style={styles.unitChipText} numberOfLines={1}>
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

              <View style={styles.checkoutRow}>
                <AppButton
                  title={
                    printerStatus === 'connected'
                      ? 'بيع وطباعة'
                      : 'بيع وطباعة (بدون طابعة)'
                  }
                  icon="printer"
                  onPress={() => completeSale(true)}
                  loading={busy}
                  style={{flex: 1.4}}
                />
                <AppButton
                  title="بيع فقط"
                  variant="secondary"
                  icon="check"
                  onPress={() => completeSale(false)}
                  loading={busy}
                  style={{flex: 1}}
                />
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
                  label={`${BASE_UNIT_NAME} (الأساس)`}
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
  onConfirm: (
    product: Product,
    kg: number,
    unit: ProductUnit | null,
  ) => void;
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

          {/* Keypad + quick weights side by side — compact, fixed. */}
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
            {/* Regional quick weights — وقية / نصف كغ / كيلو… */}
            <View style={styles.weightQuickColumn}>
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
            </View>
          </View>

          {/* The product's own sellable sub-units (وقية = 0.25 كغ). */}
          {unitRows != null && unitRows.length > 0 ? (
            <View style={styles.weightUnitsWrap}>
              <Text style={styles.weightQuickLabel}>وحدات المنتج:</Text>
              {unitRows.map(row => {
                const price = unitPriceFor(product, row, pricingMode);
                return (
                  <TouchableOpacity
                    key={row.id}
                    style={styles.weightUnitRow}
                    onPress={() => {
                      onConfirm(product, 1, row);
                      setWeightText('');
                    }}
                    activeOpacity={0.75}>
                    <Text style={styles.weightUnitName}>{row.unitName}</Text>
                    <Text style={styles.weightUnitMeta}>
                      {formatQty(row.conversion)} {WEIGHT_UNIT_NAME} ·{' '}
                      {formatMoney(price)}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          ) : null}
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
    tile: {
      width: GRID_TILE,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: radius.md,
      padding: spacing.sm,
      gap: 4,
    },
    tileImage: {
      width: GRID_TILE - spacing.sm * 2,
      height: GRID_TILE - spacing.sm * 2 - 62,
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
    expandBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      backgroundColor: c.accentSofter,
      borderRadius: radius.sm,
      paddingHorizontal: spacing.sm,
      paddingVertical: 3,
    },
    expandBtnText: {
      color: c.accent,
      fontFamily: fonts.bold,
      fontSize: typography.micro,
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
    checkoutRow: {
      flexDirection: 'row',
      gap: spacing.sm,
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
    weightUnitsWrap: {
      gap: spacing.xs,
    },
    weightUnitRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      backgroundColor: c.surfaceAlt,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm + 2,
      marginBottom: spacing.xs,
    },
    weightUnitName: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.caption,
    },
    weightUnitMeta: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.small,
      fontVariant: ['tabular-nums'],
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
  }),
);
