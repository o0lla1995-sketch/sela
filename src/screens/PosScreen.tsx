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
  Dimensions,
  Image,
  Keyboard,
  Modal,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  Vibration,
  View,
} from 'react-native';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
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
import {ErrorBoundary} from '../components/ErrorBoundary';
import {
  ScannerCamera,
  type ScannerCameraHandle,
} from '../components/ScannerCamera';
import {useCartStore, cartTotals, unitPriceFor} from '../stores/cartStore';
import {useCatalogStore} from '../stores/catalogStore';
import {useSettingsStore} from '../stores/settingsStore';
import {usePrinterStore} from '../stores/printerStore';
import {useToastStore} from '../stores/toastStore';
import {InvoiceService} from '../services/InvoiceService';
import {ProductRepo} from '../database/repositories/ProductRepo';
import {UnitRepo} from '../database/repositories/UnitRepo';
import {
  requirePlatformUtils,
  PlatformUtilsNative,
} from '../native/nativeBridge';
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
  const cameraRef = useRef<ScannerCameraHandle>(null);
  const insets = useSafeAreaInsets();

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
  const [cameraOpen, setCameraOpen] = useState(false);
  // 32-bit devices run the TFLite inference 10-40x slower — the auto
  // visual loop would saturate the JS thread there. Default to manual
  // capture on them (merchant can still enable it manually).
  const [autoScan, setAutoScan] = useState(true);

  useEffect(() => {
    let mounted = true;
    void PlatformUtilsNative?.getAbi()
      .then(abi => {
        if (
          mounted &&
          typeof abi === 'string' &&
          abi.startsWith('armeabi-v7')
        ) {
          setAutoScan(false);
        }
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, []);
  const [busy, setBusy] = useState(false);
  const [lastRecognized, setLastRecognized] = useState<{
    name: string;
    score: number;
  } | null>(null);
  const [lastBarcode, setLastBarcode] = useState<string | null>(null);
  const [unitPickerLine, setUnitPickerLine] = useState<CartLine | null>(null);
  const [unitPickerRows, setUnitPickerRows] = useState<ProductUnit[] | null>(
    null,
  );

  const scannerMode: ScannerMode = settings.scannerMode;
  const barcodeActive = scannerMode === 'barcode' || scannerMode === 'both';
  const visualActive = scannerMode === 'visual' || scannerMode === 'both';

  const totals = useMemo(() => cartTotals(lines, discount), [lines, discount]);

  // Pause the scanner whenever the tab loses focus (battery + camera).
  const [tabFocused, setTabFocused] = useState(true);
  useFocusEffect(
    useCallback(() => {
      setTabFocused(true);
      return () => setTabFocused(false);
    }, []),
  );

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

  const handleMatch = useCallback(
    (match: {productId: number; score: number}) => {
      const product = useCatalogStore
        .getState()
        .products.find(entry => entry.id === match.productId);
      if (!product) {
        return;
      }
      setLastRecognized({name: product.name, score: match.score});
      const result = addProduct(
        product,
        useCartStore.getState().pricingMode,
        null,
      );
      if (result.added) {
        Vibration.vibrate(40);
        beep();
      } else if (result.reason) {
        toast(result.reason, 'error');
      }
    },
    [addProduct, beep, toast],
  );

  /** Barcode read → exact product lookup → cart or create prompt. */
  const handleBarcode = useCallback(
    async (code: string) => {
      setLastBarcode(code);
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
      if (unitPickerLine == null) return;
      const product = products.find(
        entry => entry.id === unitPickerLine.productId,
      );
      if (product == null) return;
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
        setLastRecognized(null);
        setLastBarcode(null);
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

  const openScanner = useCallback(() => {
    setCameraOpen(true);
  }, []);
  const closeScanner = useCallback(() => {
    setCameraOpen(false);
  }, []);

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
                name={
                  scannerMode === 'barcode' ? 'barcode' : 'scan'
                }
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
              <View style={styles.cartLinesWrap}>
                <ScrollView showsVerticalScrollIndicator={false}>
                  {lines.map(line => (
                    <View key={line.key} style={styles.cartLine}>
                      <View style={styles.cartLineInfo}>
                        <Text style={styles.cartLineName} numberOfLines={1}>
                          {line.name}
                        </Text>
                        <View style={styles.cartLineMetaRow}>
                          <Text style={styles.cartLineMeta}>
                            {formatMoney(line.unitPrice)} × {line.quantity} ={' '}
                            {formatMoney(line.unitPrice * line.quantity)}
                          </Text>
                        </View>
                        {/* Unit chip — opens the unit picker */}
                        <TouchableOpacity
                          style={styles.unitChip}
                          onPress={() => openUnitPicker(line)}
                          activeOpacity={0.8}>
                          <Icon name="scale" size={12} color={c.accent} />
                          <Text style={styles.unitChipText}>
                            {line.unitName}
                            {line.conversion > 1
                              ? ` (${line.conversion} ${BASE_UNIT_NAME})`
                              : ''}
                          </Text>
                          <Icon name="chevronDown" size={12} color={c.accent} />
                        </TouchableOpacity>
                      </View>
                      <Stepper
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
                        hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}>
                        <Icon name="trash" size={16} color={c.danger} />
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

      {/* ── Full-screen scanner overlay ────────────────────────
          v6: the camera lives in its own full-screen modal — opening
          it NEVER squeezes the product grid or pushes the cart and
          checkout buttons off small screens (the v5 inline-sheet
          complaint). The selling layout below never moves. */}
      <Modal
        visible={cameraOpen}
        animationType="slide"
        statusBarTranslucent
        onRequestClose={closeScanner}>
        <StatusBar barStyle="light-content" backgroundColor="#0B0B10" />
        <View style={styles.scannerOverlay}>
          <ErrorBoundary inline label="الكاميرا">
            <View style={{flex: 1}}>
              <ScannerCamera
                ref={cameraRef}
                mode="scan"
                barcodeEnabled={barcodeActive}
                onBarcode={code => {
                  void handleBarcode(code);
                }}
                autoScan={visualActive && autoScan && tabFocused}
                onMatch={handleMatch}
              />
            </View>

            {/* Top chrome: close + engine hint */}
            <View
              style={[styles.scannerTopBar, {top: Math.max(insets.top, spacing.md)}]}>
              <TouchableOpacity
                style={styles.scannerCloseChip}
                onPress={closeScanner}
                activeOpacity={0.8}>
                <Icon name="x" size={18} color="#F4F4F5" />
                <Text style={styles.scannerCloseText}>إغلاق</Text>
              </TouchableOpacity>
              <View style={styles.scannerEngineChip}>
                <Icon
                  name={
                    scannerMode === 'barcode'
                      ? 'barcode'
                      : scannerMode === 'visual'
                      ? 'scan'
                      : 'flash'
                  }
                  size={14}
                  color={c.accent}
                />
                <Text style={styles.scannerEngineText}>{scannerLabel}</Text>
              </View>
            </View>

            {/* Bottom chrome: recognition feedback + cart + actions */}
            <View
              style={[
                styles.scannerBottom,
                {paddingBottom: Math.max(insets.bottom, spacing.md)},
              ]}>
              {lastRecognized ? (
                <View style={styles.scannerBanner}>
                  <Icon name="checkCircle" size={16} color={c.success} />
                  <Text style={styles.scannerBannerText} numberOfLines={1}>
                    {lastRecognized.name}
                  </Text>
                  <Text style={styles.scannerBannerScore}>
                    {(lastRecognized.score * 100).toFixed(0)}%
                  </Text>
                </View>
              ) : lastBarcode != null ? (
                <View style={styles.scannerBanner}>
                  <Icon name="barcode" size={16} color={c.success} />
                  <Text style={styles.scannerBannerText} numberOfLines={1}>
                    {lastBarcode}
                  </Text>
                </View>
              ) : (
                <View style={styles.scannerBannerHint}>
                  <Text style={styles.scannerBannerHintText}>
                    {scannerMode === 'barcode'
                      ? 'وجّه الكاميرا نحو ملصق الباركود'
                      : scannerMode === 'visual'
                      ? 'وجّه الكاميرا نحو المنتج — يُضاف تلقائياً عند التعرّف'
                      : 'باركود أو بصري — كلاهما يعمل معاً'}
                  </Text>
                </View>
              )}

              {/* Live cart summary — the merchant sees the sale grow
                  without leaving the scanner. */}
              <View style={styles.scannerCartRow}>
                <View style={styles.scannerCartInfo}>
                  <Icon name="cart" size={15} color={c.accent} />
                  <Text style={styles.scannerCartText}>
                    {totals.itemsCount} قطعة · {formatMoney(totals.total)}
                  </Text>
                </View>
                <AppButton
                  small
                  title="السلة والدفع"
                  icon="cart"
                  onPress={closeScanner}
                />
              </View>

              <View style={styles.scannerActionsRow}>
                {visualActive ? (
                  <TouchableOpacity
                    style={[styles.autoScanChip, autoScan && styles.autoScanChipOn]}
                    onPress={() => setAutoScan(value => !value)}
                    activeOpacity={0.8}>
                    <Icon
                      name={autoScan ? 'flash' : 'clock'}
                      size={14}
                      color={autoScan ? c.accent : c.textDim}
                    />
                    <Text
                      style={[
                        styles.autoScanText,
                        autoScan ? {color: c.accent} : null,
                      ]}>
                      {autoScan ? 'مسح تلقائي' : 'يدوي'}
                    </Text>
                  </TouchableOpacity>
                ) : (
                  <View />
                )}
                {visualActive ? (
                  <TouchableOpacity
                    style={styles.snapNowButton}
                    onPress={() => void cameraRef.current?.scanOnce()}
                    activeOpacity={0.8}>
                    <Icon name="camera" size={16} color={c.onAccent} />
                    <Text style={styles.snapNowText}>التقط الآن</Text>
                  </TouchableOpacity>
                ) : (
                  <View />
                )}
              </View>
            </View>
          </ErrorBoundary>
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

    // Full-screen scanner overlay (v6)
    scannerOverlay: {
      flex: 1,
      backgroundColor: '#0B0B10',
    },
    scannerTopBar: {
      position: 'absolute',
      left: spacing.md,
      right: spacing.md,
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    scannerCloseChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      backgroundColor: 'rgba(14, 14, 18, 0.84)',
      borderRadius: radius.pill,
      paddingHorizontal: spacing.lg,
      paddingVertical: 9,
    },
    scannerCloseText: {
      color: '#F4F4F5',
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    scannerEngineChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      backgroundColor: 'rgba(14, 14, 18, 0.84)',
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: 7,
    },
    scannerEngineText: {
      color: c.accent,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    scannerBottom: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.xs,
      gap: spacing.sm,
    },
    scannerBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      backgroundColor: 'rgba(14, 14, 18, 0.84)',
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.success,
      paddingHorizontal: spacing.md,
      paddingVertical: 10,
    },
    scannerBannerText: {
      flex: 1,
      color: c.success,
      fontFamily: fonts.bold,
      fontSize: typography.caption,
    },
    scannerBannerScore: {
      color: c.success,
      fontFamily: fonts.black,
      fontSize: typography.caption,
      fontVariant: ['tabular-nums'],
    },
    scannerBannerHint: {
      backgroundColor: 'rgba(14, 14, 18, 0.84)',
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
      paddingHorizontal: spacing.md,
      paddingVertical: 10,
      alignItems: 'center',
    },
    scannerBannerHintText: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.small,
      textAlign: 'center',
    },
    scannerCartRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      backgroundColor: 'rgba(14, 14, 18, 0.84)',
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
      paddingHorizontal: spacing.md,
      paddingVertical: 8,
    },
    scannerCartInfo: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    scannerCartText: {
      color: '#F4F4F5',
      fontFamily: fonts.black,
      fontSize: typography.caption,
      fontVariant: ['tabular-nums'],
    },
    scannerActionsRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      minHeight: 44,
    },
    autoScanChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      backgroundColor: 'rgba(14, 14, 18, 0.84)',
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: c.border,
      paddingHorizontal: spacing.md,
      paddingVertical: 9,
    },
    autoScanChipOn: {
      borderColor: c.accent,
      backgroundColor: 'rgba(249, 115, 22, 0.18)',
    },
    autoScanText: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    snapNowButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      backgroundColor: c.accent,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.lg,
      paddingVertical: 10,
    },
    snapNowText: {
      color: c.onAccent,
      fontFamily: fonts.bold,
      fontSize: typography.small,
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

    // Cart panel
    cartPanel: {
      backgroundColor: c.surface,
      borderTopWidth: 1,
      borderTopColor: c.border,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: c.borderSoft,
      padding: spacing.md,
      gap: spacing.sm,
      maxHeight: '54%',
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
      maxHeight: 158,
    },
    cartLine: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingVertical: 7,
      borderBottomWidth: 1,
      borderBottomColor: c.borderSoft,
    },
    cartLineInfo: {flex: 1},
    cartLineName: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.caption,
    },
    cartLineMetaRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    cartLineMeta: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      marginTop: 1,
      fontVariant: ['tabular-nums'],
    },
    unitChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      backgroundColor: c.accentSofter,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.sm + 2,
      paddingVertical: 3,
      alignSelf: 'flex-start',
      marginTop: 4,
    },
    unitChipText: {
      color: c.accent,
      fontFamily: fonts.bold,
      fontSize: typography.micro,
    },
    removeBtn: {
      width: 34,
      height: 34,
      alignItems: 'center',
      justifyContent: 'center',
    },
    discountRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    discountLabel: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    discountInput: {
      width: 74,
      backgroundColor: c.surfaceAlt,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.sm,
      color: c.text,
      textAlign: 'center',
      paddingVertical: 6,
      fontSize: typography.caption,
      fontFamily: fonts.bold,
    },
    quickChip: {
      backgroundColor: c.accentSoft,
      borderRadius: radius.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: 7,
    },
    quickChipGhost: {backgroundColor: c.surfaceAlt},
    quickChipText: {
      color: c.accent,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    totalsRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingTop: spacing.xs,
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
