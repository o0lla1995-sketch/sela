/**
 * PosScreen — نقطة البيع والكاميرا.
 * Split layout: live camera on top, cart below. The camera
 * auto-adds recognized products; every action has a manual fallback.
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
  Keyboard,
} from 'react-native';
import {Vibration} from 'react-native';
import {CameraPanel, type CameraPanelHandle} from '../components/CameraPanel';
import {
  AppButton,
  Card,
  EmptyState,
  MoneyText,
  Screen,
  ScreenHeader,
  Segmented,
  Badge,
} from '../components/ui';
import {useCartStore, cartTotals} from '../stores/cartStore';
import {useCatalogStore} from '../stores/catalogStore';
import {useSettingsStore} from '../stores/settingsStore';
import {usePrinterStore} from '../stores/printerStore';
import {useToastStore} from '../stores/toastStore';
import {InvoiceService} from '../services/InvoiceService';
import {requirePlatformUtils} from '../native/nativeBridge';
import {colors, radius, spacing, typography} from '../core/theme';
import {formatMoney, parseNumber} from '../core/format';
import type {Product} from '../core/types';

export function PosScreen() {
  const cameraRef = useRef<CameraPanelHandle>(null);

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

  const settings = useSettingsStore(state => state.settings);
  const printerStatus = usePrinterStore(state => state.status);

  const toast = useToastStore(state => state.show);

  const [search, setSearch] = useState('');
  const [discountText, setDiscountText] = useState('');
  const [lastRecognized, setLastRecognized] = useState<{
    name: string;
    score: number;
  } | null>(null);
  const [liveScore, setLiveScore] = useState(0);
  const [busy, setBusy] = useState(false);

  const totals = useMemo(() => cartTotals(lines, discount), [lines, discount]);

  const beep = useCallback(async () => {
    if (!settings.soundEnabled) return;
    try {
      await requirePlatformUtils().beep(0);
    } catch {
      // Sound is a nicety — silent failure is fine.
    }
  }, [settings.soundEnabled]);

  const tryAdd = useCallback(
    (product: Product, source: 'vision' | 'manual') => {
      const result = addProduct(product, pricingMode);
      if (result.added) {
        if (source === 'vision') {
          Vibration.vibrate(40);
        }
        void beep();
        if (source === 'vision') {
          setLastRecognized({
            name: product.name,
            score: 0.82,
          });
        }
      } else if (result.reason) {
        toast(result.reason, 'error');
      }
    },
    [addProduct, pricingMode, beep, toast],
  );

  const handleMatch = useCallback(
    (productId: number, score: number) => {
      const product = useCatalogStore.getState().products.find(
        entry => entry.id === productId,
      );
      if (!product) return;
      setLastRecognized({name: product.name, score});
      const result = addProduct(product, useCartStore.getState().pricingMode);
      if (result.added) {
        Vibration.vibrate(40);
        void beep();
      } else if (result.reason) {
        toast(result.reason, 'error');
      }
    },
    [addProduct, beep, toast],
  );

  const handleScore = useCallback((score: number) => {
    setLiveScore(score);
  }, []);

  // Keep discount text input in sync with the store.
  useEffect(() => {
    if (discount === 0) setDiscountText('');
  }, [discount]);

  const searchResults = useMemo(() => {
    const query = search.trim();
    if (!query) return [];
    const lower = query.toLowerCase();
    return products
      .filter(product => product.name.toLowerCase().includes(lower))
      .slice(0, 6);
  }, [search, products]);

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
          onPrintError: message => toast(`البيع تم حفظه لكن الطباعة فشلت: ${message}`, 'error'),
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

  return (
    <Screen>
      <ScreenHeader
        title="نقطة البيع"
        subtitle={settings.storeName}
      />
      <View style={styles.body}>
        {/* ── Camera zone ─────────────────────────────────────── */}
        <View style={styles.cameraZone}>
          <CameraPanel
            ref={cameraRef}
            mode="matching"
            enabled={settings.recognitionEnabled}
            onMatch={handleMatch}
            onScore={handleScore}
          />
          <View style={styles.cameraTopRow}>
            <View style={styles.scoreChip}>
              <Text style={styles.scoreText}>
                تشابه: {(liveScore * 100).toFixed(0)}%
              </Text>
            </View>
            <TouchableOpacity
              style={styles.snapButton}
              onPress={() => cameraRef.current?.forceScan()}>
              <Text style={styles.snapText}>مسح فوري</Text>
            </TouchableOpacity>
          </View>
          {lastRecognized ? (
            <View style={styles.recognizedBanner}>
              <Text style={styles.recognizedText}>
                ✓ {lastRecognized.name}
              </Text>
              <Text style={styles.recognizedScore}>
                {(lastRecognized.score * 100).toFixed(0)}%
              </Text>
            </View>
          ) : null}
        </View>

        {/* ── Pricing mode + search ───────────────────────────── */}
        <View style={styles.controlsRow}>
          <Segmented
            value={pricingMode}
            onChange={setPricingMode}
            options={[
              {value: 'RETAIL', label: 'مفرق'},
              {value: 'WHOLESALE', label: 'جملة'},
            ]}
          />
          <View style={styles.searchWrap}>
            <TextInput
              style={styles.searchInput}
              placeholder="إضافة يدوية — ابحث عن منتج…"
              placeholderTextColor={colors.textFaint}
              value={search}
              onChangeText={setSearch}
              textAlign="right"
            />
          </View>
        </View>

        {searchResults.length > 0 ? (
          <View style={styles.searchResults}>
            {searchResults.map(product => (
              <TouchableOpacity
                key={product.id}
                style={styles.searchResultItem}
                onPress={() => {
                  tryAdd(product, 'manual');
                  setSearch('');
                }}>
                <Text style={styles.searchResultName}>{product.name}</Text>
                <Text style={styles.searchResultPrice}>
                  {formatMoney(
                    pricingMode === 'WHOLESALE'
                      ? product.wholesale_price
                      : product.retail_price,
                  )}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        ) : null}

        {/* ── Cart ────────────────────────────────────────────── */}
        <ScrollView style={styles.cartScroll} contentContainerStyle={styles.cartContent}>
          {lines.length === 0 ? (
            <EmptyState
              title="السلة فارغة"
              subtitle={
                settings.recognitionEnabled
                  ? 'وجّه الكاميرا نحو المنتج داخل الإطار أو ابحث يدوياً'
                  : 'التعرف التلقائي موقوف — ابحث عن المنتج يدوياً'
              }
              emoji="🛒"
            />
          ) : (
            lines.map(line => (
              <View key={line.productId} style={styles.cartLine}>
                <View style={styles.cartLineInfo}>
                  <Text style={styles.cartLineName} numberOfLines={1}>
                    {line.name}
                  </Text>
                  <Text style={styles.cartLinePrice}>
                    {formatMoney(line.unitPrice)} × {line.quantity}
                  </Text>
                </View>
                <View style={styles.qtyControls}>
                  <TouchableOpacity
                    style={styles.qtyButton}
                    onPress={() => {
                      const result = increment(line.productId);
                      if (!result.ok && result.reason) toast(result.reason, 'error');
                    }}>
                    <Text style={styles.qtyButtonText}>+</Text>
                  </TouchableOpacity>
                  <Text style={styles.qtyValue}>{line.quantity}</Text>
                  <TouchableOpacity
                    style={[styles.qtyButton, styles.qtyButtonMinus]}
                    onPress={() => decrement(line.productId)}>
                    <Text style={styles.qtyButtonText}>−</Text>
                  </TouchableOpacity>
                </View>
                <View style={styles.cartLineEnd}>
                  <MoneyText value={line.unitPrice * line.quantity} />
                  <TouchableOpacity
                    onPress={() => removeLine(line.productId)}
                    hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                    <Text style={styles.removeText}>حذف</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ))
          )}
        </ScrollView>

        {/* ── Totals + checkout ───────────────────────────────── */}
        <Card style={styles.totalsCard}>
          <View style={styles.discountRow}>
            <Text style={styles.discountLabel}>خصم الفاتورة (₪):</Text>
            <TextInput
              style={styles.discountInput}
              value={discountText}
              onChangeText={text => {
                setDiscountText(text);
                const value = parseNumber(text);
                setDiscount(Number.isNaN(value) ? 0 : Math.max(0, value));
              }}
              keyboardType="numeric"
              placeholder="0.00"
              placeholderTextColor={colors.textFaint}
            />
            <TouchableOpacity
              style={styles.quickDiscount}
              onPress={() => {
                const pct = 0.1;
                const next = totals.subtotal * pct;
                setDiscount(next);
                setDiscountText(next.toFixed(2));
              }}>
              <Text style={styles.quickDiscountText}>10%</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.quickDiscount}
              onPress={() => {
                setDiscount(0);
                setDiscountText('');
              }}>
              <Text style={styles.quickDiscountText}>إلغاء</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.totalsRow}>
            <Text style={styles.totalsLabel}>المجموع الفرعي</Text>
            <MoneyText value={totals.subtotal} />
          </View>
          {totals.safeDiscount > 0 ? (
            <View style={styles.totalsRow}>
              <Text style={styles.totalsLabel}>الخصم</Text>
              <MoneyText value={-totals.safeDiscount} color={colors.danger} />
            </View>
          ) : null}
          <View style={styles.totalsRow}>
            <Text style={[styles.totalsLabel, styles.totalLabel]}>الإجمالي</Text>
            <MoneyText value={totals.total} big />
          </View>
          {lines.length > 0 ? (
            <View style={styles.totalsRow}>
              <Text style={styles.profitLabel}>صافي الربح (للمسؤول)</Text>
              <Text
                style={[
                  styles.profitValue,
                  {color: totals.profit >= 0 ? colors.success : colors.danger},
                ]}>
                {formatMoney(totals.profit)}
              </Text>
            </View>
          ) : null}

          <View style={styles.checkoutButtons}>
            <AppButton
              title={`إتمام البيع والطباعة ${printerStatus === 'connected' ? '' : '(الطابعة غير متصلة)'}`}
              onPress={() => completeSale(true)}
              loading={busy}
              disabled={lines.length === 0}
              style={{flex: 1}}
            />
          </View>
          <AppButton
            title="إتمام البيع بدون طباعة"
            variant="ghost"
            onPress={() => completeSale(false)}
            loading={busy}
            disabled={lines.length === 0}
          />
          <View style={styles.paymentTypeBadge}>
            <Badge
              label={pricingMode === 'WHOLESALE' ? 'بيع بالجملة' : 'بيع بالمفرق'}
              tone={pricingMode === 'WHOLESALE' ? 'accent' : 'success'}
            />
            <Text style={styles.itemsCount}>
              {totals.itemsCount} قطعة في السلة
            </Text>
          </View>
        </Card>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: {flex: 1, padding: spacing.md, gap: spacing.md},
  cameraZone: {flex: 1, minHeight: 220, borderRadius: radius.lg, overflow: 'hidden'},
  cameraTopRow: {
    position: 'absolute',
    top: spacing.sm,
    left: spacing.sm,
    right: spacing.sm,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  scoreChip: {
    backgroundColor: 'rgba(17,17,17,0.8)',
    borderRadius: radius.xl,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  scoreText: {color: colors.info, fontSize: typography.small, fontWeight: '700'},
  snapButton: {
    backgroundColor: colors.accent,
    borderRadius: radius.xl,
    paddingHorizontal: spacing.lg,
    paddingVertical: 6,
  },
  snapText: {color: '#FFFFFF', fontSize: typography.small, fontWeight: '800'},
  recognizedBanner: {
    position: 'absolute',
    bottom: spacing.sm,
    left: spacing.sm,
    right: spacing.sm,
    backgroundColor: 'rgba(17,17,17,0.88)',
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.success,
  },
  recognizedText: {color: colors.success, fontWeight: '800', fontSize: typography.caption},
  recognizedScore: {color: colors.success, fontWeight: '800', fontSize: typography.caption},
  controlsRow: {gap: spacing.sm},
  searchWrap: {flexDirection: 'row'},
  searchInput: {
    flex: 1,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    color: colors.text,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    fontSize: typography.caption,
  },
  searchResults: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  searchResultItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  searchResultName: {color: colors.text, fontWeight: '700', fontSize: typography.caption},
  searchResultPrice: {color: colors.accent, fontWeight: '800', fontSize: typography.caption},
  cartScroll: {flex: 1},
  cartContent: {gap: spacing.sm, paddingBottom: spacing.sm},
  cartLine: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
    gap: spacing.sm,
  },
  cartLineInfo: {flex: 1},
  cartLineName: {color: colors.text, fontWeight: '800', fontSize: typography.caption},
  cartLinePrice: {color: colors.textDim, fontSize: typography.small, marginTop: 2},
  qtyControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  qtyButton: {
    width: 34,
    height: 34,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qtyButtonMinus: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
  },
  qtyButtonText: {color: '#FFFFFF', fontSize: 20, fontWeight: '800', lineHeight: 24},
  qtyValue: {color: colors.text, fontSize: typography.body, fontWeight: '800', minWidth: 28, textAlign: 'center'},
  cartLineEnd: {alignItems: 'flex-end', gap: 2},
  removeText: {color: colors.danger, fontSize: typography.small, fontWeight: '700'},
  totalsCard: {gap: 8},
  discountRow: {flexDirection: 'row', alignItems: 'center', gap: spacing.sm},
  discountLabel: {color: colors.textDim, fontSize: typography.small, flex: 1},
  discountInput: {
    width: 90,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    color: colors.text,
    textAlign: 'center',
    paddingVertical: 6,
    fontSize: typography.caption,
    fontWeight: '700',
  },
  quickDiscount: {
    backgroundColor: colors.accentSoft,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  quickDiscountText: {color: colors.accent, fontWeight: '800', fontSize: typography.small},
  totalsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  totalsLabel: {color: colors.textDim, fontSize: typography.caption, fontWeight: '700'},
  totalLabel: {color: colors.text, fontSize: typography.body, fontWeight: '800'},
  profitLabel: {color: colors.textFaint, fontSize: typography.small},
  profitValue: {fontWeight: '800', fontSize: typography.caption, fontVariant: ['tabular-nums']},
  checkoutButtons: {marginTop: spacing.sm},
  paymentTypeBadge: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 4,
  },
  itemsCount: {color: colors.textDim, fontSize: typography.small},
});
