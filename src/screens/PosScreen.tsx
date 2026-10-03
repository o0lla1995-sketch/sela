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
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  Vibration,
  View,
} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import {
  AppButton,
  AppHeader,
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
import {scanBarcode, capturePhoto} from '../services/vision/scanFlow';
import {requirePlatformUtils} from '../native/nativeBridge';
import {BASE_UNIT_NAME, type ScannerMode} from '../core/config';
import {
  fonts,
  makeStyles,
  radius,
  spacing,
  typography,
  useThemeColors,
} from '../core/theme';
import {formatMoney, parseNumber} from '../core/format';
import {stockStateOf} from '../core/types';
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

  const lines = useCartStore(state => state.lines);
  const pricingMode = useCartStore(state => state.pricingMode);
  const discount = useCartStore(state => state.discount);
  const addProduct = useCartStore(state => state.addProduct);
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
  // the "which engine?" sheet (scannerMode = both), and visionResult
  // is the photo → top-matches result sheet.
  const [scanBusy, setScanBusy] = useState(false);
  const [enginePickerOpen, setEnginePickerOpen] = useState(false);
  const [visionResult, setVisionResult] = useState<{
    photoPath: string;
    matches: {product: Product; score: number}[];
    autoAdded: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [unitPickerLine, setUnitPickerLine] = useState<CartLine | null>(null);
  const [unitPickerRows, setUnitPickerRows] = useState<ProductUnit[] | null>(
    null,
  );

  const scannerMode: ScannerMode = settings.scannerMode;
  const barcodeActive = scannerMode === 'barcode' || scannerMode === 'both';
  const visualActive = scannerMode === 'visual' || scannerMode === 'both';

  const totals = useMemo(() => cartTotals(lines, discount), [lines, discount]);

  useEffect(() => {
    if (discount === 0) {
      setDiscountText('');
    }
  }, [discount]);

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

  const tryAdd = useCallback(
    (product: Product, unit?: ProductUnit | null) => {
      const result = addProduct(product, pricingMode, unit ?? null);
      if (result.added) {
        beep();
      } else if (result.reason) {
        toast(result.reason, 'error');
      }
    },
    [addProduct, pricingMode, beep, toast],
  );

  /** v8: photo engine → embed → top matches → auto-add or sheet. */
  const runVisionScan = useCallback(async () => {
    if (scanBusy) {
      return;
    }
    setScanBusy(true);
    try {
      const photoPath = await capturePhoto();
      if (photoPath == null) {
        return; // Merchant closed the native scanner.
      }
      await VisionRecognitionService.loadModel();
      const vector = await VisionRecognitionService.embedPhoto(photoPath);
      const index = useCatalogStore.getState().embeddingsIndex;
      if (index == null || index.ids.length === 0) {
        toast(
          'لا توجد بصمات بصرية محفوظة — سجّل صور المنتجات من شاشة المنتج أولاً',
          'error',
        );
        return;
      }
      const top = findTopMatches(vector, index.flat, index.ids, index.dim, 5);
      const products = useCatalogStore.getState().products;
      const matches = top
        .map(match => ({
          product: products.find(p => p.id === match.productId),
          score: match.score,
        }))
        .filter(
          (match): match is {product: Product; score: number} =>
            match.product != null,
        );
      if (matches.length === 0) {
        toast('لم يتم التعرف على المنتج — جرّب زاوية أو إضاءة أفضل', 'error');
        return;
      }
      const threshold = settings.matchThreshold;
      const best = matches[0];
      if (best.score >= threshold) {
        // Confident match → straight into the cart, like a barcode.
        const result = addProduct(
          best.product,
          useCartStore.getState().pricingMode,
          null,
        );
        if (result.added) {
          Vibration.vibrate(40);
          beep();
        } else if (result.reason) {
          toast(result.reason, 'error');
        }
        setVisionResult({photoPath, matches, autoAdded: true});
      } else {
        // Below threshold → merchant picks from the top matches.
        setVisionResult({photoPath, matches, autoAdded: false});
      }
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'فشل المسح البصري',
        'error',
      );
    } finally {
      setScanBusy(false);
    }
  }, [scanBusy, addProduct, beep, toast, settings.matchThreshold]);

  /** Barcode read → exact product lookup → cart or create prompt. */
  const handleBarcode = useCallback(
    async (code: string) => {
      try {
        // 1. Base product barcode.
        const product = await ProductRepo.findByBarcode(code);
        if (product != null) {
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
    [addProduct, beep, toast, navigation],
  );

  /** v8: barcode engine → the proven lookup chain. */
  const runBarcodeScan = useCallback(async () => {
    if (scanBusy) {
      return;
    }
    setScanBusy(true);
    try {
      const code = await scanBarcode();
      if (code != null) {
        await handleBarcode(code);
      }
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'فشل مسح الباركود',
        'error',
      );
    } finally {
      setScanBusy(false);
    }
  }, [scanBusy, handleBarcode, toast]);

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
        setVisionResult(null);
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

  return (
    <View style={styles.screen}>
      <AppHeader
        title="نقطة البيع"
        subtitle={settings.storeName}
        showBack={false}
        right={
          <Badge
            label={pricingMode === 'WHOLESALE' ? 'جملة' : 'مفرق'}
            tone={pricingMode === 'WHOLESALE' ? 'accent' : 'success'}
          />
        }
      />

      <View style={styles.body}>
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
            <View style={{flex: 1}}>
              <SearchInput value={search} onChange={setSearch} />
            </View>
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
          </View>
        </View>

        {/* ── Products grid ────────────────────────────────── */}
        {products.length === 0 ? (
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
                    <Text style={styles.tileName} numberOfLines={1}>
                      {product.name}
                    </Text>
                    <Text style={styles.tilePrice}>
                      {formatMoney(priceOf(product))}
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
                          : `${product.stock_quantity} ${BASE_UNIT_NAME}`}
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
        )}

        {/* ── Cart panel ───────────────────────────────────── */}
        <View style={styles.cartPanel}>
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
              {/* Compact header: title + live count + EMPTY button
                  (round-8: "لا يوجد زر إلغاء أو تفريغ السلة"). */}
              <View style={styles.cartHeaderRow}>
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
              <View style={styles.cartLinesWrap}>
                <ScrollView showsVerticalScrollIndicator={false}>
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
                            {formatMoney(line.unitPrice)} × {line.quantity} ={' '}
                            {formatMoney(line.unitPrice * line.quantity)}
                          </Text>
                          <TouchableOpacity
                            style={styles.unitChip}
                            onPress={() => openUnitPicker(line)}
                            activeOpacity={0.8}>
                            <Icon name="scale" size={10} color={c.accent} />
                            <Text style={styles.unitChipText} numberOfLines={1}>
                              {line.unitName}
                              {line.conversion > 1
                                ? ` (${line.conversion})`
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
                    الإجمالي · {totals.itemsCount} وحدة ({totals.baseItemsCount}{' '}
                    {BASE_UNIT_NAME})
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
                  سريع ودقيق — يُغلق تلقائياً عند قراءة الملصق
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
                  صوّر المنتج بالكاميرا ويتم التعرف عليه فوراً
                </Text>
              </View>
              <Icon name="chevronLeft" size={18} color={c.textFaint} />
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* ── v8 vision result sheet ────────────────────────────
          Photo captured by the native engine → embedding → top
          matches. Confident match = already added (green banner);
          otherwise the merchant taps the right product. */}
      <Modal
        visible={visionResult != null}
        transparent
        animationType="slide"
        onRequestClose={() => setVisionResult(null)}>
        <View style={styles.visionSheetOverlay}>
          <TouchableOpacity
            style={{flex: 1}}
            activeOpacity={1}
            onPress={() => setVisionResult(null)}
          />
          {visionResult != null ? (
            <View style={styles.visionSheet}>
              <View style={styles.visionSheetHandle} />
              <Text style={styles.visionSheetTitle}>نتيجة المسح البصري</Text>
              <Image
                source={{uri: `file://${visionResult.photoPath}`}}
                style={styles.visionPhoto}
                resizeMode="cover"
              />
              {visionResult.autoAdded ? (
                <View style={styles.visionAddedBanner}>
                  <Icon name="checkCircle" size={15} color={c.success} />
                  <Text style={styles.visionAddedText} numberOfLines={1}>
                    أُضيف للسلة: {visionResult.matches[0]?.product.name}
                  </Text>
                  <Text style={styles.visionAddedScore}>
                    {((visionResult.matches[0]?.score ?? 0) * 100).toFixed(0)}%
                  </Text>
                </View>
              ) : (
                <Text style={styles.visionPickHint}>
                  التطابق غير مؤكد — اختر المنتج الصحيح:
                </Text>
              )}
              <ScrollView
                style={{maxHeight: 200}}
                showsVerticalScrollIndicator={false}>
                {(visionResult.autoAdded
                  ? visionResult.matches.slice(1)
                  : visionResult.matches
                ).map(match => (
                  <VisionMatchRow
                    key={match.product.id}
                    product={match.product}
                    score={match.score}
                    onPress={() => {
                      tryAdd(match.product);
                      setVisionResult(null);
                    }}
                  />
                ))}
                {visionResult.autoAdded && visionResult.matches.length <= 1 ? (
                  <Text style={styles.visionNoMore}>لا توجد مطابقات أخرى</Text>
                ) : null}
              </ScrollView>
              <View style={styles.visionSheetActions}>
                <AppButton
                  small
                  style={{flex: 1}}
                  title="مسح أخرى"
                  icon="camera"
                  onPress={() => {
                    setVisionResult(null);
                    void runVisionScan();
                  }}
                />
                <AppButton
                  small
                  style={{flex: 1}}
                  variant="secondary"
                  title="إغلاق"
                  onPress={() => setVisionResult(null)}
                />
              </View>
            </View>
          ) : null}
        </View>
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
    </View>
  );
}

// ────────────────────────────────────────────────────────────────
// Sub-components
// ────────────────────────────────────────────────────────────────

function VisionMatchRow({
  product,
  score,
  onPress,
}: {
  product: Product;
  score: number;
  onPress: () => void;
}) {
  const c = useThemeColors();
  const styles = useStyles();
  return (
    <TouchableOpacity
      style={styles.visionMatchRow}
      onPress={onPress}
      activeOpacity={0.8}>
      {product.image_uri ? (
        <Image
          source={{uri: `file://${product.image_uri}`}}
          style={styles.visionMatchThumb}
        />
      ) : (
        <View
          style={[
            styles.visionMatchThumb,
            {
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: c.surfaceAlt,
            },
          ]}>
          <Icon name="box" size={18} color={c.textDim} />
        </View>
      )}
      <View style={{flex: 1}}>
        <Text style={styles.visionMatchName} numberOfLines={1}>
          {product.name}
        </Text>
        <Text style={styles.visionMatchMeta} numberOfLines={1}>
          {formatMoney(product.retail_price)} · المتوفر {product.stock_quantity}{' '}
          {BASE_UNIT_NAME}
        </Text>
      </View>
      <View style={styles.visionScoreChip}>
        <Text style={styles.visionScoreText}>{(score * 100).toFixed(0)}%</Text>
      </View>
    </TouchableOpacity>
  );
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

    // v8 vision result sheet
    visionSheetOverlay: {
      flex: 1,
      backgroundColor: c.overlay,
      justifyContent: 'flex-end',
    },
    visionSheet: {
      backgroundColor: c.surface,
      borderTopLeftRadius: radius.lg + 4,
      borderTopRightRadius: radius.lg + 4,
      padding: spacing.lg,
      gap: spacing.sm,
      paddingBottom: spacing.xl,
    },
    visionSheetHandle: {
      alignSelf: 'center',
      width: 44,
      height: 4,
      borderRadius: 2,
      backgroundColor: c.border,
      marginBottom: 2,
    },
    visionSheetTitle: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.body,
      textAlign: 'center',
    },
    visionPhoto: {
      width: '100%',
      height: 130,
      borderRadius: radius.md,
      backgroundColor: c.surfaceAlt,
    },
    visionAddedBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      backgroundColor: c.successSoft,
      borderRadius: radius.sm,
      paddingHorizontal: spacing.sm,
      paddingVertical: 7,
    },
    visionAddedText: {
      flex: 1,
      color: c.success,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    visionAddedScore: {
      color: c.success,
      fontFamily: fonts.black,
      fontSize: typography.small,
      fontVariant: ['tabular-nums'],
    },
    visionPickHint: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.small,
    },
    visionMatchRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingVertical: 7,
      borderBottomWidth: 1,
      borderBottomColor: c.borderSoft,
    },
    visionMatchThumb: {
      width: 40,
      height: 40,
      borderRadius: radius.sm,
      backgroundColor: c.surfaceAlt,
    },
    visionMatchName: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.caption,
    },
    visionMatchMeta: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      marginTop: 1,
    },
    visionScoreChip: {
      backgroundColor: c.accentSofter,
      borderRadius: radius.pill,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    visionScoreText: {
      color: c.accent,
      fontFamily: fonts.black,
      fontSize: typography.micro + 1,
      fontVariant: ['tabular-nums'],
    },
    visionNoMore: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      textAlign: 'center',
      paddingVertical: spacing.md,
    },
    visionSheetActions: {
      flexDirection: 'row',
      gap: spacing.sm,
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
    // smaller quick-action chips — nothing overflows the panel.)
    cartPanel: {
      backgroundColor: c.surface,
      borderTopWidth: 1,
      borderTopColor: c.border,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: c.borderSoft,
      padding: spacing.sm,
      gap: spacing.xs,
      maxHeight: '42%',
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
      maxHeight: 132,
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
