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
  Dimensions,
  Image,
  Keyboard,
  KeyboardAvoidingView,
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
import {useNavigation} from '@react-navigation/native';
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
import {findTopMatches} from '../services/vision/embedding';
import {
  cameraPermissionMessage,
  ensureCameraPermission,
  openAppSettings,
  scanBarcodeContinuous,
  scanVisualContinuous,
} from '../services/vision/scanFlow';
import {requirePlatformUtils, SelaScannerNative} from '../native/nativeBridge';
import {
  BASE_UNIT_NAME,
  DEFAULT_RECOGNITION_COOLDOWN_MS,
  QUICK_WEIGHTS,
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

export function PosScreen() {
  const c = useThemeColors();
  const styles = useStyles();
  const navigation = useNavigation<any>();
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
  const [discountText, setDiscountText] = useState('');
  // v8: the scanner is a NATIVE full-screen activity — no in-RN
  // camera state left. scanBusy guards the launch, enginePicker is
  // the "which engine?" sheet (scannerMode = both).
  const [scanBusy, setScanBusy] = useState(false);
  const [enginePickerOpen, setEnginePickerOpen] = useState(false);
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
  /** Weight products recognized DURING a scan session — they wait
   *  here and their weight pads open one by one when the scanner
   *  closes (the Loyverse scale-item pattern). */
  const [pendingWeight, setPendingWeight] = useState<Product[]>([]);

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

  /** v8.3: confirm the weight pad → fractional kg line in the cart. */
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
        setWeightProduct(null);
      } else if (result.reason) {
        toast(result.reason, 'error');
      }
    },
    [addWeighted, beep, toast],
  );

  /** v8.2 CONTINUOUS visual session: the native engine AUTO-captures
   *  (no shutter press per product — round-11 #2), every photo
   *  streams back here and each confident match jumps into the cart
   *  BY ITSELF. The merchant waves product after product in front of
   *  the camera and watches the session counter; a deliberate manual
   *  shutter press adds instantly (bypasses the same-product window).
   *  The old post-scan result sheet is GONE — a Modal opened right
   *  after the native scanner window closed was what blacked the
   *  screen on this device; the flow now stays 100% inside the
   *  native window until the merchant closes it. */
  const runVisionScan = useCallback(async () => {
    if (scanBusy) {
      return;
    }
    const permission = await ensureCameraPermission();
    if (permission !== 'granted') {
      // v8.3 (round-12 #1): a one-tap escape into the system
      // settings when the permission is permanently denied — the
      // system no longer shows the ask dialog in that state.
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
    try {
      await VisionRecognitionService.loadModel();
    } catch {
      // embedPhoto below will surface a readable error instead.
    }
    setScanBusy(true);
    let added = 0;
    const addErrors: string[] = [];
    const lastAddAt = new Map<number, number>();
    let processing = false;
    try {
      await scanVisualContinuous((photoPath, auto) => {
        if (processing) {
          // One recognition at a time — the native loop's own cadence
          // leaves plenty of slack between photos.
          return;
        }
        processing = true;
        void (async () => {
          try {
            const vector = await VisionRecognitionService.embedPhoto(photoPath);
            const live = useCatalogStore.getState().embeddingsIndex;
            if (live == null || live.ids.length === 0) {
              return;
            }
            const best = findTopMatches(
              vector,
              live.flat,
              live.ids,
              live.dim,
              1,
            )[0];
            const product =
              best == null
                ? undefined
                : useCatalogStore
                    .getState()
                    .products.find(entry => entry.id === best.productId);
            const threshold =
              useSettingsStore.getState().settings.matchThreshold;
            if (best == null || product == null || best.score < threshold) {
              SelaScannerNative?.reportVisualResult('miss', '', 0);
              return;
            }
            const now = Date.now();
            const last = lastAddAt.get(product.id);
            if (
              auto &&
              last != null &&
              now - last < DEFAULT_RECOGNITION_COOLDOWN_MS
            ) {
              // Same product still in front of the lens — acknowledge
              // without adding (manual shutter bypasses this).
              SelaScannerNative?.reportVisualResult(
                'dup',
                product.name,
                best.score,
              );
              return;
            }
            // v8.3 (round-12 #4): weight products can't auto-add a
            // whole kilo — queue the weight pad; it opens the moment
            // the scanner window closes.
            if (isWeightProduct(product)) {
              setPendingWeight(prev =>
                prev.some(entry => entry.id === product.id)
                  ? prev
                  : [...prev, product],
              );
              added++;
              lastAddAt.set(product.id, now);
              beep();
              SelaScannerNative?.reportVisualResult(
                'added',
                `${product.name} — حدّد الوزن بعد الإغلاق`,
                best.score,
              );
              return;
            }
            const result = addProduct(
              product,
              useCartStore.getState().pricingMode,
              null,
            );
            if (result.added) {
              added++;
              lastAddAt.set(product.id, now);
              beep();
              SelaScannerNative?.reportVisualResult(
                'added',
                product.name,
                best.score,
              );
            } else {
              SelaScannerNative?.reportVisualResult('miss', '', 0);
              if (result.reason != null && !addErrors.includes(result.reason)) {
                addErrors.push(result.reason);
              }
            }
          } catch {
            SelaScannerNative?.reportVisualResult('miss', '', 0);
          } finally {
            processing = false;
          }
        })();
      });
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'فشل المسح البصري',
        'error',
      );
    } finally {
      setScanBusy(false);
      if (added > 0) {
        toast(
          `انتهت الجلسة — ${added} ${
            added === 1 ? 'منتج' : 'منتجات'
          } جاهزة في السلة`,
          'success',
        );
      }
      if (addErrors.length > 0) {
        toast(addErrors[0], 'error');
      }
    }
  }, [scanBusy, addProduct, beep, toast]);

  /**
   * Barcode read → exact product lookup → cart or create prompt.
   * v8.1: `interactive: false` (continuous session) collects unknown
   * codes instead of showing an Alert — an RN Alert would be INVISIBLE
   * behind the fullscreen native scanner and would break the session.
   */
  const handleBarcode = useCallback(
    async (
      code: string,
      interactive: boolean = true,
      unknownCollector?: (code: string) => void,
    ): Promise<void> => {
      try {
        // 1. Base product barcode.
        const product = await ProductRepo.findByBarcode(code);
        if (product != null) {
          // v8.3 (round-12 #4): weight products open the weight pad
          // (during a continuous session they queue for it instead —
          // no invented whole-kilo adds).
          if (isWeightProduct(product)) {
            if (interactive) {
              openWeightPad(product);
            } else {
              setPendingWeight(prev =>
                prev.some(entry => entry.id === product.id)
                  ? prev
                  : [...prev, product],
              );
            }
            beep();
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
          return;
        }
        // 2. Unit-level barcode (a whole كرتونة).
        const unitHit = await UnitRepo.findByBarcode(code);
        if (unitHit != null) {
          const unitProduct = await ProductRepo.getById(unitHit.productId);
          if (unitProduct != null) {
            const result = addProduct(
              unitProduct,
              useCartStore.getState().pricingMode,
              unitHit.productUnit,
            );
            if (result.added) {
              beep();
              toast(
                `أُضيفت وحدة ${unitHit.productUnit.unitName} من ${unitProduct.name}`,
                'success',
              );
            } else if (result.reason) {
              toast(result.reason, 'error');
            }
            return;
          }
        }
        // 3. Unknown → offer creating the product with this barcode.
        if (!interactive && unknownCollector != null) {
          unknownCollector(code);
          return;
        }
        Alert.alert(
          'باركود غير معروف',
          `لا يوجد منتج مسجل بالباركود ${code}. هل تريد إضافة منتج جديد بهذا الباركود؟`,
          [
            {text: 'إلغاء', style: 'cancel'},
            {
              text: 'إضافة منتج',
              onPress: () =>
                navigation.navigate('ProductForm', {barcode: code}),
            },
          ],
        );
      } catch (error) {
        toast(
          error instanceof Error ? error.message : 'فشل البحث عن الباركود',
          'error',
        );
      }
    },
    [addProduct, beep, toast, navigation, openWeightPad],
  );

  /**
   * v8.1 CONTINUOUS multi-scan barcode session: the native engine
   * never auto-closes; every deduped read streams in and is added
   * immediately. The merchant scans item after item without ever
   * leaving the camera, then presses إغلاق to finish.
   */
  const runBarcodeScan = useCallback(async () => {
    if (scanBusy) {
      return;
    }
    setScanBusy(true);
    const unknown: string[] = [];
    let reads = 0;
    try {
      await scanBarcodeContinuous(code => {
        reads++;
        void handleBarcode(code, false, unknownCode => {
          if (!unknown.includes(unknownCode)) {
            unknown.push(unknownCode);
          }
        });
      });
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'فشل مسح الباركود',
        'error',
      );
    } finally {
      setScanBusy(false);
      if (reads > 0) {
        toast(`انتهت جلسة المسح — ${reads} قراءة أُضيفت للسلة`, 'success');
      }
      if (unknown.length > 0) {
        const sample = unknown.slice(0, 3).join('، ');
        const shown =
          unknown.length === 1
            ? sample
            : `${sample} (${unknown.length} أكواد غير مسجلة)`;
        Alert.alert(
          'باركود غير مسجل',
          `لا يوجد منتج مسجل بالباركود ${shown}. هل تريد إضافة منتج جديد بأول باركود؟`,
          [
            {text: 'إلغاء', style: 'cancel'},
            {
              text: 'إضافة منتج',
              onPress: () =>
                navigation.navigate('ProductForm', {
                  barcode: unknown[0],
                }),
            },
          ],
        );
      }
    }
  }, [scanBusy, handleBarcode, toast, navigation]);

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
   *  barcode/visual modes open their engine directly; 'both' shows
   *  a small picker sheet. Each engine is fully independent. */
  const openScanner = useCallback(() => {
    if (scannerMode === 'barcode') {
      void runBarcodeScan();
    } else if (scannerMode === 'visual') {
      void runVisionScan();
    } else {
      setEnginePickerOpen(true);
    }
  }, [scannerMode, runBarcodeScan, runVisionScan]);

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
              <SearchInput value={search} onChange={setSearch} />
            </View>
          </View>
        </View>

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

        {/* ── Cart panel ───────────────────────────────────── */}
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
      </View>

      {/* ── v8 engine picker (only in "both" mode) ───────────
          The camera itself now runs in a NATIVE full-screen
          activity — it always fills the screen correctly and can
          never show a black frame or overlap POS chrome. This tiny
          sheet just picks WHICH independent engine to launch. */}
      <Modal
        visible={enginePickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setEnginePickerOpen(false)}>
        <TouchableOpacity
          style={styles.engineSheetOverlay}
          activeOpacity={1}
          onPress={() => setEnginePickerOpen(false)}>
          <View style={styles.engineSheet}>
            <Text style={styles.engineSheetTitle}>اختر طريقة المسح</Text>
            <TouchableOpacity
              style={styles.engineRow}
              onPress={() => {
                setEnginePickerOpen(false);
                void runBarcodeScan();
              }}
              activeOpacity={0.8}>
              <View style={styles.engineIconWrap}>
                <Icon name="barcode" size={22} color={c.accent} />
              </View>
              <View style={{flex: 1}}>
                <Text style={styles.engineRowTitle}>مسح الباركود</Text>
                <Text style={styles.engineRowMeta}>
                  جلسة متعددة — امسح عدة منتجات وكل قراءة تُضاف للسلة فوراً
                </Text>
              </View>
              <Icon name="chevronLeft" size={18} color={c.textFaint} />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.engineRow}
              onPress={() => {
                setEnginePickerOpen(false);
                void runVisionScan();
              }}
              activeOpacity={0.8}>
              <View style={styles.engineIconWrap}>
                <Icon name="camera" size={22} color={c.accent} />
              </View>
              <View style={{flex: 1}}>
                <Text style={styles.engineRowTitle}>المسح البصري</Text>
                <Text style={styles.engineRowMeta}>
                  جلسة متواصلة — يُضاف المنتج للسلة تلقائياً عند التعرف عليه
                </Text>
              </View>
              <Icon name="chevronLeft" size={18} color={c.textFaint} />
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

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
          sold. Prices are per kilo; the merchant types the weight
          (decimal) or taps a quick chip (وقية 250غ / نصف كغ / كيلو…)
          and the live total = kg × kilo price. Sub-units from the
          product's unit rows (وقية = 0.25 كغ…) add by their unit. */}
      <WeightSheet
        product={weightProduct}
        unitRows={weightUnitRows}
        pricingMode={pricingMode}
        onClose={() => {
          setWeightProduct(null);
          setWeightUnitRows(null);
        }}
        onConfirm={confirmWeight}
      />
    </View>
  );
}

/**
 * v8.3: the weight pad itself — a bottom sheet with a big decimal
 * input, the regional quick-weight chips, the product's sellable
 * sub-units (وقية…) and a live price preview.
 */
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

  return (
    <Modal
      visible
      transparent
      animationType="slide"
      onRequestClose={onClose}>
      <View style={styles.unitModalOverlay}>
        <TouchableOpacity style={{flex: 1}} activeOpacity={1} onPress={onClose} />
        <KeyboardAvoidingView behavior="padding" style={{width: '100%'}}>
          <View style={styles.unitModalSheet}>
            <View style={styles.unitModalHandle} />
            <View style={styles.weightHeaderRow}>
              <View style={{flex: 1}}>
                <Text style={styles.unitModalTitle} numberOfLines={1}>
                  {product.name}
                </Text>
                <Text style={styles.weightKiloPrice}>
                  سعر الكيلو ({pricingMode === 'WHOLESALE' ? 'جملة' : 'مفرق'}):{' '}
                  {formatMoney(kiloPrice)}
                </Text>
              </View>
              <View style={styles.weightStockChip}>
                <Text style={styles.weightStockText}>
                  {formatQty(product.stock_quantity)} {WEIGHT_UNIT_NAME} متوفر
                </Text>
              </View>
            </View>

            {/* The weight input — big, decimal, auto-focused. */}
            <View style={styles.weightInputRow}>
              <TextInput
                style={styles.weightInput}
                value={weightText}
                onChangeText={setWeightText}
                keyboardType="decimal-pad"
                placeholder="0.000"
                placeholderTextColor={c.textFaint}
                autoFocus
                selectTextOnFocus
              />
              <Text style={styles.weightInputUnit}>{WEIGHT_UNIT_NAME}</Text>
            </View>
            {total > 0 ? (
              <Text style={styles.weightLiveTotal}>
                {formatQty(validWeight)} {WEIGHT_UNIT_NAME} ×{' '}
                {formatMoney(kiloPrice)} = {formatMoney(total)}
              </Text>
            ) : null}

            {/* Regional quick weights — وقية / نصف كغ / كيلو… */}
            <Text style={styles.weightQuickLabel}>أوزان سريعة:</Text>
            <View style={styles.weightQuickRow}>
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

            {/* The product's own sellable sub-units (وقية = 0.25 كغ). */}
            {unitRows != null && unitRows.length > 0 ? (
              <>
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
              </>
            ) : null}

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
                style={{flex: 1.6}}
              />
            </View>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

// ────────────────────────────────────────────────────────────────
// Sub-components
// ────────────────────────────────────────────────────────────────

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
}: {
  value: string;
  onChange: (text: string) => void;
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
    // v8 engine picker sheet
    engineSheetOverlay: {
      flex: 1,
      backgroundColor: c.overlay,
      justifyContent: 'flex-end',
    },
    engineSheet: {
      backgroundColor: c.surface,
      borderTopLeftRadius: radius.lg + 4,
      borderTopRightRadius: radius.lg + 4,
      padding: spacing.lg,
      gap: spacing.sm,
      paddingBottom: spacing.xl,
    },
    engineSheetTitle: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.body,
      textAlign: 'center',
      marginBottom: spacing.xs,
    },
    engineRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: c.surfaceAlt,
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: radius.md,
      padding: spacing.md,
    },
    engineIconWrap: {
      width: 44,
      height: 44,
      borderRadius: radius.md,
      backgroundColor: c.accentSofter,
      alignItems: 'center',
      justifyContent: 'center',
    },
    engineRowTitle: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.caption,
    },
    engineRowMeta: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      marginTop: 2,
    },

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

    // ── v8.3 (round-12 #4): weight pad ──────────────────────────
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
    weightHeaderRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    weightKiloPrice: {
      color: c.accent,
      fontFamily: fonts.bold,
      fontSize: typography.caption,
      textAlign: 'center',
    },
    weightStockChip: {
      backgroundColor: c.surfaceHi,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.sm + 2,
      paddingVertical: 4,
    },
    weightStockText: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.micro + 0.5,
      fontVariant: ['tabular-nums'],
    },
    weightInputRow: {
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
    weightInput: {
      flex: 1,
      color: c.text,
      fontFamily: fonts.black,
      fontSize: 30,
      textAlign: 'center',
      paddingVertical: spacing.sm,
      fontVariant: ['tabular-nums'],
    },
    weightInputUnit: {
      color: c.accent,
      fontFamily: fonts.bold,
      fontSize: typography.body,
    },
    weightLiveTotal: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.caption,
      textAlign: 'center',
      fontVariant: ['tabular-nums'],
    },
    weightQuickLabel: {
      color: c.textFaint,
      fontFamily: fonts.bold,
      fontSize: typography.micro + 1,
      marginTop: spacing.xs,
    },
    weightQuickRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.sm,
    },
    weightQuickChip: {
      alignItems: 'center',
      backgroundColor: c.surfaceAlt,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs + 2,
      minWidth: 76,
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
      marginTop: spacing.xs,
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
