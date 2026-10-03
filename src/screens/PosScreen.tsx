/**
 * PosScreen — نقطة البيع (design.md §9.2).
 * Loyverse-style product grid + expandable camera scanning sheet +
 * Square-style persistent cart with a dominant charge button.
 * Manual selling never depends on the camera being available.
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  Dimensions,
  Image,
  Keyboard,
  LayoutAnimation,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  Vibration,
  View,
} from 'react-native';
import {useFocusEffect} from '@react-navigation/native';
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
import {useCartStore, cartTotals} from '../stores/cartStore';
import {useCatalogStore} from '../stores/catalogStore';
import {useSettingsStore} from '../stores/settingsStore';
import {usePrinterStore} from '../stores/printerStore';
import {useToastStore} from '../stores/toastStore';
import {InvoiceService} from '../services/InvoiceService';
import {requirePlatformUtils} from '../native/nativeBridge';
import {colors, fonts, radius, spacing, typography} from '../core/theme';
import {formatMoney, parseNumber} from '../core/format';
import {stockStateOf} from '../core/types';
import type {Product} from '../core/types';

const GRID_COLUMNS = 3;
const SCREEN_WIDTH = Dimensions.get('window').width;
const GRID_TILE = Math.floor((SCREEN_WIDTH - spacing.lg * 2 - spacing.sm * (GRID_COLUMNS - 1)) / GRID_COLUMNS);

export function PosScreen() {
  const cameraRef = useRef<ScannerCameraHandle>(null);

  const lines = useCartStore(state => state.lines);
  const pricingMode = useCartStore(state => state.pricingMode);
  const discount = useCartStore(state => state.discount);
  const addProduct = useCartStore(state => state.addProduct);
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
  const [autoScan, setAutoScan] = useState(true);
  const [busy, setBusy] = useState(false);
  const [lastRecognized, setLastRecognized] = useState<{name: string; score: number} | null>(null);

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
    (product: Product, source: 'vision' | 'manual') => {
      const result = addProduct(product, pricingMode);
      if (result.added) {
        beep();
        if (source === 'vision') {
          Vibration.vibrate(40);
        }
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
      const result = addProduct(product, useCartStore.getState().pricingMode);
      if (result.added) {
        Vibration.vibrate(40);
        beep();
      } else if (result.reason) {
        toast(result.reason, 'error');
      }
    },
    [addProduct, beep, toast],
  );

  const filteredProducts = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) {
      return products;
    }
    return products.filter(product => product.name.toLowerCase().includes(query));
  }, [search, products]);

  const priceOf = useCallback(
    (product: Product) =>
      pricingMode === 'WHOLESALE' ? product.wholesale_price : product.retail_price,
    [pricingMode],
  );

  const completeSale = useCallback(
    async (withPrint: boolean) => {
      if (lines.length === 0) {
        toast('السلة فارغة — أضف منتجات أولاً', 'error');
        return;
      }
      if (withPrint && printerStatus !== 'connected') {
        toast('لا توجد طابعة متصلة — أكمل البيع بدون طباعة أو أوصل الطابعة أولاً', 'error');
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
        void refreshCatalog();
        toast(`تم إتمام البيع بنجاح ${withPrint ? 'وإرساله للطابعة' : ''}`, 'success');
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

  const toggleCamera = useCallback(() => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setCameraOpen(value => !value);
  }, []);

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
              style={[styles.scanButton, cameraOpen && styles.scanButtonActive]}
              onPress={toggleCamera}
              activeOpacity={0.8}>
              <Icon
                name={cameraOpen ? 'x' : 'scan'}
                size={19}
                color={cameraOpen ? colors.danger : colors.onAccent}
              />
              <Text
                style={[
                  styles.scanButtonText,
                  cameraOpen ? {color: colors.danger} : null,
                ]}>
                {cameraOpen ? 'إغلاق' : 'مسح'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* ── Camera sheet ─────────────────────────────────── */}
        {cameraOpen ? (
          <ErrorBoundary inline label="الكاميرا">
            <View style={styles.cameraSheet}>
              <ScannerCamera
                ref={cameraRef}
                mode="scan"
                autoScan={autoScan && tabFocused}
                onMatch={handleMatch}
              />
              <View style={styles.cameraToolbar} pointerEvents="box-none">
                <TouchableOpacity
                  style={styles.autoScanChip}
                  onPress={() => setAutoScan(value => !value)}
                  activeOpacity={0.8}>
                  <Icon
                    name={autoScan ? 'flash' : 'clock'}
                    size={14}
                    color={autoScan ? colors.accent : colors.textDim}
                  />
                  <Text
                    style={[
                      styles.autoScanText,
                      autoScan ? {color: colors.accent} : null,
                    ]}>
                    {autoScan ? 'مسح تلقائي' : 'يدوي'}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.snapNowButton}
                  onPress={() => void cameraRef.current?.scanOnce()}
                  activeOpacity={0.8}>
                  <Icon name="camera" size={16} color={colors.onAccent} />
                  <Text style={styles.snapNowText}>التقط الآن</Text>
                </TouchableOpacity>
              </View>
              {lastRecognized ? (
                <View style={styles.recognizedBanner}>
                  <Icon name="checkCircle" size={16} color={colors.success} />
                  <Text style={styles.recognizedText} numberOfLines={1}>
                    {lastRecognized.name}
                  </Text>
                  <Text style={styles.recognizedScore}>
                    {(lastRecognized.score * 100).toFixed(0)}%
                  </Text>
                </View>
              ) : null}
            </View>
          </ErrorBoundary>
        ) : null}

        {/* ── Products grid ────────────────────────────────── */}
        {products.length === 0 ? (
          <EmptyState
            icon="box"
            title="لا توجد منتجات بعد"
            subtitle="أضف أول منتج مع بصمته البصرية من شاشة المخزون لكي تتمكن من البيع"
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
                const stockState = stockStateOf(product, settings.lowStockDefaultThreshold);
                return (
                  <TouchableOpacity
                    key={product.id}
                    style={styles.tile}
                    onPress={() => tryAdd(product, 'manual')}
                    activeOpacity={0.75}>
                    {product.image_uri ? (
                      <Image source={{uri: `file://${product.image_uri}`}} style={styles.tileImage} />
                    ) : (
                      <View style={[styles.tileImage, styles.tileImageFallback]}>
                        <Icon name="box" size={20} color={colors.accent} />
                      </View>
                    )}
                    <Text style={styles.tileName} numberOfLines={1}>
                      {product.name}
                    </Text>
                    <Text style={styles.tilePrice}>{formatMoney(priceOf(product))}</Text>
                    <View style={styles.tileStockRow}>
                      <View
                        style={[
                          styles.stockDot,
                          stockState === 'out'
                            ? {backgroundColor: colors.danger}
                            : stockState === 'low'
                            ? {backgroundColor: colors.warning}
                            : {backgroundColor: colors.success},
                        ]}
                      />
                      <Text style={styles.tileStock}>
                        {stockState === 'out' ? 'نفد' : `${product.stock_quantity} قطعة`}
                      </Text>
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
              <Icon name="cart" size={18} color={colors.textFaint} />
              <Text style={styles.cartEmptyText}>
                السلة فارغة — المس منتجاً من الشبكة أو امسحه بالكاميرا
                {embeddingsCount === 0 && products.length > 0
                  ? ' (لا توجد بصمات بصرية محفوظة بعد — البيع باللمس متاح)'
                  : ''}
              </Text>
            </View>
          ) : (
            <>
              <View style={styles.cartLinesWrap}>
                <ScrollView showsVerticalScrollIndicator={false}>
                  {lines.map(line => (
                    <View key={line.productId} style={styles.cartLine}>
                      <View style={styles.cartLineInfo}>
                        <Text style={styles.cartLineName} numberOfLines={1}>
                          {line.name}
                        </Text>
                        <Text style={styles.cartLineMeta}>
                          {formatMoney(line.unitPrice)} × {line.quantity} ={' '}
                          {formatMoney(line.unitPrice * line.quantity)}
                        </Text>
                      </View>
                      <Stepper
                        value={line.quantity}
                        onIncrement={() => {
                          const result = increment(line.productId);
                          if (!result.ok && result.reason) {
                            toast(result.reason, 'error');
                          }
                        }}
                        onDecrement={() => {
                          decrement(line.productId);
                        }}
                        decrementDanger
                      />
                      <TouchableOpacity
                        onPress={() => removeLine(line.productId)}
                        style={styles.removeBtn}
                        hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}>
                        <Icon name="trash" size={16} color={colors.danger} />
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
                  placeholderTextColor={colors.textFaint}
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
                  <Text style={[styles.quickChipText, {color: colors.textDim}]}>إلغاء</Text>
                </TouchableOpacity>
              </View>
            </>
          )}

          {/* Totals + checkout */}
          <View style={styles.totalsRow}>
            <View>
              <Text style={styles.totalLabel}>
                الإجمالي · {totals.itemsCount} قطعة
              </Text>
              {totals.safeDiscount > 0 ? (
                <Text style={styles.discountValue}>
                  خصم {formatMoney(totals.safeDiscount)}
                </Text>
              ) : null}
            </View>
            <MoneyText value={totals.total} big />
          </View>

          {lines.length > 0 ? (
            <View style={styles.checkoutRow}>
              <AppButton
                title={printerStatus === 'connected' ? 'بيع وطباعة' : 'بيع وطباعة (بدون طابعة)'}
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
          ) : null}
        </View>
      </View>
    </View>
  );
}

function SearchInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (text: string) => void;
}) {
  return (
    <View style={styles.searchWrap}>
      <Icon name="search" size={17} color={colors.textFaint} />
      <TextInput
        style={styles.searchInput}
        value={value}
        onChangeText={onChange}
        placeholder="ابحث عن منتج…"
        placeholderTextColor={colors.textFaint}
        textAlign="right"
        returnKeyType="search"
      />
      {value.length > 0 ? (
        <TouchableOpacity onPress={() => onChange('')} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
          <Icon name="x" size={15} color={colors.textDim} />
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: colors.bg},
  body: {flex: 1, padding: spacing.lg, gap: spacing.md},

  // Controls
  controlsRow: {gap: spacing.sm},
  searchRow: {flexDirection: 'row', gap: spacing.sm, alignItems: 'center'},
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    height: 46,
  },
  searchInput: {
    flex: 1,
    color: colors.text,
    fontFamily: fonts.medium,
    fontSize: typography.caption,
    paddingVertical: 0,
  },
  scanButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    height: 46,
  },
  scanButtonActive: {
    backgroundColor: colors.dangerSoft,
    borderWidth: 1,
    borderColor: colors.danger,
  },
  scanButtonText: {
    color: colors.onAccent,
    fontFamily: fonts.bold,
    fontSize: typography.caption,
  },

  // Camera sheet
  cameraSheet: {
    height: 300,
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: '#050508',
  },
  cameraToolbar: {
    position: 'absolute',
    top: spacing.sm,
    left: spacing.sm,
    right: spacing.sm,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  autoScanChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.scrim,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
  },
  autoScanText: {
    color: colors.textDim,
    fontFamily: fonts.bold,
    fontSize: typography.small,
  },
  snapNowButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: 8,
  },
  snapNowText: {
    color: colors.onAccent,
    fontFamily: fonts.bold,
    fontSize: typography.small,
  },
  recognizedBanner: {
    position: 'absolute',
    bottom: spacing.sm,
    left: spacing.sm,
    right: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.scrim,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.success,
    paddingHorizontal: spacing.md,
    paddingVertical: 9,
  },
  recognizedText: {
    flex: 1,
    color: colors.success,
    fontFamily: fonts.bold,
    fontSize: typography.caption,
  },
  recognizedScore: {
    color: colors.success,
    fontFamily: fonts.black,
    fontSize: typography.caption,
    fontVariant: ['tabular-nums'],
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
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radius.md,
    padding: spacing.sm,
    gap: 4,
  },
  tileImage: {
    width: GRID_TILE - spacing.sm * 2,
    height: GRID_TILE - spacing.sm * 2 - 44,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceAlt,
  },
  tileImageFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileName: {
    color: colors.text,
    fontFamily: fonts.bold,
    fontSize: typography.small,
    minHeight: 17,
  },
  tilePrice: {
    color: colors.accent,
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
    color: colors.textDim,
    fontFamily: fonts.regular,
    fontSize: typography.micro + 1,
  },

  // Cart panel
  cartPanel: {
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    padding: spacing.md,
    gap: spacing.sm,
    maxHeight: '52%',
  },
  cartEmptyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  cartEmptyText: {
    flex: 1,
    color: colors.textFaint,
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
    gap: spacing.sm,
    paddingVertical: 7,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSoft,
  },
  cartLineInfo: {flex: 1},
  cartLineName: {
    color: colors.text,
    fontFamily: fonts.bold,
    fontSize: typography.caption,
  },
  cartLineMeta: {
    color: colors.textDim,
    fontFamily: fonts.regular,
    fontSize: typography.micro + 1,
    marginTop: 1,
    fontVariant: ['tabular-nums'],
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
    color: colors.textDim,
    fontFamily: fonts.bold,
    fontSize: typography.small,
  },
  discountInput: {
    width: 74,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    color: colors.text,
    textAlign: 'center',
    paddingVertical: 6,
    fontSize: typography.caption,
    fontFamily: fonts.bold,
  },
  quickChip: {
    backgroundColor: colors.accentSoft,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
  },
  quickChipGhost: {backgroundColor: colors.surfaceAlt},
  quickChipText: {
    color: colors.accent,
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
    color: colors.textDim,
    fontFamily: fonts.bold,
    fontSize: typography.small,
  },
  discountValue: {
    color: colors.danger,
    fontFamily: fonts.bold,
    fontSize: typography.small,
    marginTop: 2,
  },
  checkoutRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
});
