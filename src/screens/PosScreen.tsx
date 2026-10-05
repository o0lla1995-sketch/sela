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
import {useSettingsStore} from '../stores/settingsStore';
import {usePrinterStore} from '../stores/printerStore';
import {useToastStore} from '../stores/toastStore';
import {useSilaStore} from '../stores/silaStore';
import {InvoiceService} from '../services/InvoiceService';
import {ProductRepo} from '../database/repositories/ProductRepo';
import {UnitRepo} from '../database/repositories/UnitRepo';
import {SilaRepo} from '../services/sila/SilaRepo';
import {SilaSync} from '../services/sila/SilaSync';
import {parseSilaQr} from '../services/sila/qr';
import {VisionRecognitionService} from '../services/vision/VisionRecognitionService';
import {
  cameraPermissionMessage,
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
 *  is fully SILENT (no banner, no counter, no prompt).
 *  v10 (round-16 #3): 'error' carries the REASON (نفدت الكمية …)
 *  so the LIVE scanner window can show it — a plain RN toast is
 *  invisible under the native window. */
type BarcodeOutcome =
  | {status: 'added'; name: string; product: Product; unitPrice: number}
  | {status: 'queued'; name: string}
  | {status: 'unknown'}
  | {status: 'error'; name?: string; reason?: string};

export function PosScreen() {
  const c = useThemeColors();
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();

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
  // v11 (SILA): pairing drives the debt button's readiness + the
  // pending-debts badge right on the checkout row.
  const silaPaired = useSilaStore(state => state.pairing != null);
  const silaPending = useSilaStore(state => state.pending);

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
    amountSource: 'card' | 'offline';
  } | null>(null);
  /** v11: true while the customer-QR camera window is open. */
  const [debtBusy, setDebtBusy] = useState(false);

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
            return {
              part: `${product.name} — وزنه عند الإغلاق`,
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
   *  open the pad instead). */
  const pickVisionMatch = useCallback(
    (product: Product) => {
      setVisionMatches(null);
      if (isWeightProduct(product)) {
        beep();
        openWeightPad(product);
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
        const product = await ProductRepo.findByBarcode(code);
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
    [addProduct, beep],
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
              `منتج وزن — أدخل وزنه عند الإغلاق: ${outcome.name}`,
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

  /** v11 (SILA §9.2): بيع بالدين — opens the camera, scans the
   *  customer's SILA QR (identity card or signed offline code),
   *  parses it OFFLINE and shows the confirmation sheet. The sale
   *  itself is only committed when the merchant confirms. */
  const startDebtSale = useCallback(async () => {
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
    toast,
    navigation,
  ]);

  /** v11 (SILA §9.2): the confirm step — one atomic action: the
   *  sale is created, the debt row enters the queue with ONE
   *  idempotency key, and the debt receipt prints automatically
   *  when a printer is live. */
  const confirmDebtSale = useCallback(async () => {
    if (debtConfirm == null) {
      return;
    }
    if (lines.length === 0) {
      setDebtConfirm(null);
      return;
    }
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
        debt: {
          customerId: debtConfirm.customerId,
          customerName: debtConfirm.customerName,
          customerPhoneLast4: debtConfirm.customerPhoneLast4,
          customerCard: debtConfirm.customerCard,
          offlineQr: debtConfirm.offlineQr,
          amountMinor: debtConfirm.amountMinor,
        },
      });
      clear();
      setDiscountText('');
      setDebtConfirm(null);
      void refreshCatalog();
      void useSilaStore.getState().refreshCounts();
      // Opportunistic sync — quietly drains the queue when online.
      void SilaSync.syncNow();
      toast(
        `تم تسجيل الدين على ${debtConfirm.customerName} — سيُزامن مع صِلة تلقائياً`,
        'success',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast(message, 'error');
    } finally {
      setBusy(false);
    }
  }, [
    debtConfirm,
    lines,
    discount,
    pricingMode,
    printerStatus,
    settings,
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
                          <Icon name="scale" size={9} color={c.onAccent} />
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
                            : `${formatQty(
                                product.stock_quantity,
                              )} ${baseUnitLabelOf(product, BASE_UNIT_NAME)}`}
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
                  {embeddingsCount === 0 &&
                  products.length > 0 &&
                  !barcodeActive
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
                  {/* v11 (round-17 #2): البيع بالدين عبر صِلة — opens the
                    camera to scan the customer's QR. A compact icon
                    chip keeps the checkout row light; the pending
                    badge shows unsynced debts at a glance. */}
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
                      name={silaPaired ? 'qrFrame' : 'lock'}
                      size={16}
                      color={silaPaired ? c.accent : c.textDim}
                    />
                    <Text
                      style={[
                        styles.debtBtnText,
                        {color: silaPaired ? c.accent : c.textDim},
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

      {/* ── v11 (SILA §9.2): debt confirmation sheet — the customer
          QR was scanned and parsed offline; one look (name / amount /
          mode) and one tap commits the sale + debt queue row. */}
      <Modal
        visible={debtConfirm != null}
        transparent
        animationType="slide"
        onRequestClose={() => setDebtConfirm(null)}>
        <View style={styles.debtModalOverlay}>
          <TouchableOpacity
            style={{flex: 1}}
            activeOpacity={1}
            onPress={() => setDebtConfirm(null)}
          />
          <View style={styles.debtModalSheet}>
            <View style={styles.unitModalHandle} />
            <Text style={styles.debtModalTitle}>بيع بالدين — صِلة</Text>

            {/* Customer block */}
            <View style={styles.debtCustomerCard}>
              <View style={styles.debtCustomerIcon}>
                <Icon name="qrFrame" size={22} color={c.accent} />
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
                    : 'بطاقة زبون صِلة — المبلغ من الفاتورة'}
                </Text>
              </View>
            </View>

            {/* Amount */}
            <View style={styles.debtAmountRow}>
              <Text style={styles.debtAmountLabel}>قيمة الدين</Text>
              <MoneyText value={(debtConfirm?.amountMinor ?? 0) / 100} big />
            </View>

            {/* Amount mismatch warning (offline signed code ≠ cart) */}
            {debtConfirm?.amountSource === 'offline' &&
            Math.abs(debtConfirm.amountMinor - Math.round(totals.total * 100)) >
              0 ? (
              <View style={styles.debtWarnBox}>
                <Icon name="alert" size={15} color={c.danger} />
                <Text style={styles.debtWarnText}>
                  مبلغ الرمز ({formatMoney(debtConfirm.amountMinor / 100)})
                  يختلف عن فاتورة السلة ({formatMoney(totals.total)}) — الدين
                  يُسجَّل بمبلغ الرمز الموقّع من الزبون.
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
                يُسجَّل الدين الآن محلياً ويُزامن مع صِلة تلقائياً عند توفر
                الإنترنت
              </Text>
            </View>

            {/* Actions */}
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
                style={{flex: 1.6}}
              />
            </View>
          </View>
        </View>
      </Modal>
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
    // v11 (SILA): the compact debt chip — icon-first so the checkout
    // row stays light (round-17: "استخدم معه رموز").
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
    },
    debtBadgeText: {
      color: '#fff',
      fontFamily: fonts.bold,
      fontSize: 10,
      lineHeight: 13,
    },
    // v11 (SILA): debt confirmation sheet.
    debtModalOverlay: {
      flex: 1,
      backgroundColor: c.overlay,
      justifyContent: 'flex-end',
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
