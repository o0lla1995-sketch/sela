/**
 * InventoryScreen — المخزون (v3).
 * ─────────────────────────────────────────────────────────────────
 * Redesigned breathing room: taller category chips with product
 * counts, roomier rows with stock + unit badges, quick access to
 * stocktake (الجرد) and category management.
 */
import React, {useCallback, useMemo, useState} from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {AppButton, AppHeader, EmptyState, SearchBar} from '../../components/ui';
import {Icon} from '../../components/Icon';
import {useCatalogStore} from '../../stores/catalogStore';
import {useSettingsStore} from '../../stores/settingsStore';
import {useToastStore} from '../../stores/toastStore';
import {BASE_UNIT_NAME} from '../../core/config';
import {
  fonts,
  makeStyles,
  radius,
  spacing,
  typography,
  useThemeColors,
} from '../../core/theme';
import {formatMoney, formatQty} from '../../core/format';
import {
  baseUnitLabelOf,
  isWeightProduct,
  stockStateOf,
  type Product,
} from '../../core/types';
import {ProductRepo} from '../../database/repositories/ProductRepo';
import {
  cameraPermissionMessage,
  ensureCameraPermission,
  scanBarcode,
} from '../../services/vision/scanFlow';

type CategoryFilter = number | 'all';

export function InventoryScreen() {
  const products = useCatalogStore(state => state.products);
  const categories = useCatalogStore(state => state.categories);
  const loading = useCatalogStore(state => state.loading);
  const refresh = useCatalogStore(state => state.refresh);
  const settings = useSettingsStore(state => state.settings);

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<CategoryFilter>('all');
  // v8.2 (round-11 #4): the big top quick-action buttons are GONE —
  // الجرد / التصنيفات / الوحدات now live in a compact overflow menu
  // behind the ⋮ header button, so the product list starts right
  // under the search.
  const [menuOpen, setMenuOpen] = useState(false);
  // v23 (round-29 #1): the archived view — products with sales/
  //  stocktake history that were «deleted» live here, restorable
  //  with one tap. Loaded on focus (cheap indexed query).
  const [showArchived, setShowArchived] = useState(false);
  const [archivedProducts, setArchivedProducts] = useState<Product[]>([]);

  useFocusEffect(
    useCallback(() => {
      void refresh();
      void ProductRepo.list({archival: 'archived'}).then(rows => {
        setArchivedProducts(rows);
      });
    }, [refresh]),
  );

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return products.filter(product => {
      if (filter !== 'all' && product.category_id !== filter) {
        return false;
      }
      if (
        query &&
        !product.name.toLowerCase().includes(query) &&
        !(product.barcode ?? '').includes(query)
      ) {
        return false;
      }
      return true;
    });
  }, [products, search, filter]);

  /** Products per category for the chip counts. */
  const countFor = useCallback(
    (categoryId: number | 'all') =>
      categoryId === 'all'
        ? products.length
        : products.filter(product => product.category_id === categoryId).length,
    [products],
  );

  const lowCount = useMemo(
    () =>
      products.filter(
        product =>
          stockStateOf(product, settings.lowStockDefaultThreshold) !== 'ok',
      ).length,
    [products, settings.lowStockDefaultThreshold],
  );

  return (
    <InventoryLayout
      products={filtered}
      allProducts={products}
      categories={categories}
      loading={loading}
      search={search}
      setSearch={setSearch}
      filter={filter}
      setFilter={setFilter}
      countFor={countFor}
      lowCount={lowCount}
      defaultThreshold={settings.lowStockDefaultThreshold}
      onRefresh={refresh}
      menuOpen={menuOpen}
      setMenuOpen={setMenuOpen}
      showArchived={showArchived}
      setShowArchived={setShowArchived}
      archivedProducts={archivedProducts}
    />
  );
}

function InventoryLayout({
  products,
  allProducts,
  categories,
  loading: _loading,
  search,
  setSearch,
  filter,
  setFilter,
  countFor,
  lowCount,
  defaultThreshold,
  onRefresh: _onRefresh,
  menuOpen,
  setMenuOpen,
  showArchived,
  setShowArchived,
  archivedProducts,
}: {
  products: Product[];
  allProducts: Product[];
  categories: {id: number; name: string}[];
  loading: boolean;
  search: string;
  setSearch: (value: string) => void;
  filter: CategoryFilter;
  setFilter: (value: CategoryFilter) => void;
  countFor: (categoryId: number | 'all') => number;
  lowCount: number;
  defaultThreshold: number;
  onRefresh: () => Promise<void>;
  menuOpen: boolean;
  setMenuOpen: (value: boolean) => void;
  showArchived: boolean;
  setShowArchived: (value: boolean) => void;
  archivedProducts: Product[];
}) {
  const c = useThemeColors();
  const styles = useStyles();
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const toast = useToastStore(state => state.show);

  // v28 (round-36 #2): barcode SEARCH beside the text search — one
  // native scan fills the search box with the code; a UNIQUE exact
  // barcode match opens the product straight away (what scanning a
  // specific item is for), otherwise the list simply filters.
  const [scanBusy, setScanBusy] = useState(false);
  const scanForProduct = useCallback(async () => {
    if (scanBusy) {
      return;
    }
    const permission = await ensureCameraPermission();
    if (permission !== 'granted') {
      Alert.alert('إذن الكاميرا مطلوب', cameraPermissionMessage(permission), [
        {text: 'إغلاق', style: 'cancel'},
        {
          text: 'فتح الإعدادات',
          onPress: () => {
            void Linking.openSettings();
          },
        },
      ]);
      return;
    }
    setScanBusy(true);
    try {
      const code = await scanBarcode();
      if (code == null) {
        return; // scanner closed without a read.
      }
      setSearch(code);
      const exact = allProducts.filter(product => product.barcode === code);
      if (exact.length === 1) {
        navigation.navigate('ProductForm', {productId: exact[0].id});
      } else if (exact.length === 0) {
        toast(
          `لا يوجد منتج بهذا الباركود (${code}) — تحقق من الكود أو أضفه لمنتج`,
          'info',
          4500,
        );
      }
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'فشل مسح الباركود',
        'error',
      );
    } finally {
      setScanBusy(false);
    }
  }, [scanBusy, allProducts, navigation, toast, setSearch]);

  // v29 (round-37 #2): صفر مستمعات Keyboard — شرائح التصنيفات
  // تبقى دائماً في مكانها. طيّها لحظة فتح اللوحة (v8.3) كان يحرّك
  // قسم المنتجات كاملاً للأعلى أثناء استقرار الـ IME — وهذا بعينه
  // ما جعل روم الجهاز يستسلم ويغلق اللوحة فوراً («تغلق مباشرة
  // بسبب تحرك قسم المنتجات للاعلي»). الآن لا يتغير شيء في الشجرة
  // لحظة الفتح: النظام يقلّص نافذة الشاشة (adjustResize) والقائمة
  // الافتراضية تتصاغر معها بهدوء — ولوحة المفاتيح تبقى مفتوحة.

  return (
    <View style={styles.screen}>
      <AppHeader
        title="المخزون"
        subtitle={`${allProducts.length} منتج${
          lowCount > 0 ? ` · ${lowCount} يحتاج انتباهاً` : ''
        }`}
        showBack={false}
        right={
          <View style={styles.headerActions}>
            <AppButton
              small
              title="منتج"
              icon="plus"
              onPress={() => navigation.navigate('ProductForm', {})}
            />
            {/* v8.2: ⋮ — الجرد / التصنيفات / الوحدات live here now
                (round-11 #4: the top quick-action buttons were
                removed; the list starts right under the search). */}
            <TouchableOpacity
              style={styles.menuBtn}
              onPress={() => setMenuOpen(true)}
              activeOpacity={0.75}
              hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
              <Icon name="moreVertical" size={18} color={c.text} />
            </TouchableOpacity>
          </View>
        }
      />

      {/* v8.2 overflow menu — tap anywhere to dismiss. */}
      {menuOpen ? (
        <TouchableOpacity
          style={styles.menuBackdrop}
          activeOpacity={1}
          onPress={() => setMenuOpen(false)}>
          <View style={[styles.menuSheet, {marginTop: insets.top + 62}]}>
            <MenuItem
              icon="clipboard"
              label="الجرد"
              hint="جلسة جرد كاملة للمخزون"
              onPress={() => {
                setMenuOpen(false);
                navigation.navigate('Stocktake' as never);
              }}
            />
            <MenuItem
              icon="shapes"
              label="التصنيفات"
              hint="إدارة تصنيفات المنتجات"
              onPress={() => {
                setMenuOpen(false);
                navigation.navigate('ManageCategories' as never);
              }}
            />
            <MenuItem
              icon="scale"
              label="الوحدات"
              hint="كرتونة، كيس، كيلوغرام…"
              onPress={() => {
                setMenuOpen(false);
                navigation.navigate('ManageUnits' as never);
              }}
            />
          </View>
        </TouchableOpacity>
      ) : null}

      <View style={styles.body}>
        {/* v28 (round-36 #2): the search row — text search + the
            icon-only barcode scanner button (same pattern as the
            invoices center). */}
        <View style={styles.searchRow}>
          <View style={{flex: 1}}>
            <SearchBar
              value={search}
              onChangeText={setSearch}
              placeholder="ابحث بالاسم أو الباركود…"
            />
          </View>
          <TouchableOpacity
            style={styles.scanBtn}
            onPress={() => void scanForProduct()}
            disabled={scanBusy}
            activeOpacity={0.7}
            hitSlop={{top: 6, bottom: 6, left: 6, right: 6}}>
            {scanBusy ? (
              <ActivityIndicator size="small" color={c.accent} />
            ) : (
              <Icon name="barcode" size={22} color={c.accent} />
            )}
          </TouchableOpacity>
        </View>

        {/* ── Category chips — compact, horizontally scrollable.
            v29 (round-37 #2): ALWAYS rendered — the keyboard-reactive
            folding (v8.3) moved the products section up the moment
            the keyboard opened, which is exactly what flash-closed
            the IME on this ROM. The chips now stay put; only the OS
            resize (adjustResize) shrinks the virtualized list.
            v23 (round-29 #1): «المؤرشفة» chip at the end — products
            deleted WITH history (kept for reports/returns). ── */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{
            gap: 6,
            paddingVertical: 2,
          }}
          style={styles.chipsRow}>
          <FilterChip
            label="الكل"
            count={countFor('all')}
            active={filter === 'all' && !showArchived}
            onPress={() => {
              setShowArchived(false);
              setFilter('all');
            }}
          />
          {categories.map(category => (
            <FilterChip
              key={category.id}
              label={category.name}
              count={countFor(category.id)}
              active={filter === category.id && !showArchived}
              onPress={() => {
                setShowArchived(false);
                setFilter(category.id);
              }}
            />
          ))}
          {archivedProducts.length > 0 ? (
            <FilterChip
              label="المؤرشفة"
              count={archivedProducts.length}
              active={showArchived}
              onPress={() => setShowArchived(!showArchived)}
            />
          ) : null}
        </ScrollView>

        {showArchived ? (
          archivedProducts.length === 0 ? (
            <EmptyState
              icon="archive"
              title="لا منتجات مؤرشفة"
              subtitle="المنتجات المحذوفة ذات سجل مبيعات أو جرد تُؤرشف هنا بدل حذفها نهائياً"
            />
          ) : (
            /* v28 (round-36 #2): FlatList — virtualized, so a keyboard
             * resize re-lays-out only the visible window of rows
             * instead of the ENTIRE archived catalog. */
            <FlatList
              style={{flex: 1}}
              data={archivedProducts}
              keyExtractor={item => String(item.id)}
              renderItem={({item: product}) => (
                <TouchableOpacity
                  style={[styles.row, {borderColor: c.warning}]}
                  activeOpacity={0.75}
                  onPress={() =>
                    navigation.navigate('ProductForm', {
                      productId: product.id,
                    })
                  }>
                  <View style={[styles.thumb, styles.thumbFallback]}>
                    <Icon name="archive" size={18} color={c.warning} />
                  </View>
                  <View style={{flex: 1}}>
                    <Text style={styles.name} numberOfLines={1}>
                      {product.name}
                    </Text>
                    <Text style={styles.meta} numberOfLines={1}>
                      مؤرشف — سجله محفوظ للفواتير والتقارير والمرتجعات
                    </Text>
                  </View>
                  <View style={styles.rowEnd}>
                    <Icon name="chevronLeft" size={16} color={c.textFaint} />
                  </View>
                </TouchableOpacity>
              )}
              contentContainerStyle={{
                gap: spacing.sm,
                paddingBottom: spacing.xxl,
              }}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              initialNumToRender={14}
              maxToRenderPerBatch={14}
              windowSize={7}
            />
          )
        ) : products.length === 0 ? (
          <EmptyState
            icon="box"
            title={allProducts.length === 0 ? 'المخزون فارغ' : 'لا نتائج'}
            subtitle={
              allProducts.length === 0
                ? 'أضف أول منتج مع بصمته البصرية أو باركوده'
                : 'جرّب كلمة بحث مختلفة أو تصنيفاً آخر'
            }
            action={
              allProducts.length === 0 ? (
                <AppButton
                  small
                  title="إضافة منتج"
                  icon="plus"
                  onPress={() => navigation.navigate('ProductForm', {})}
                />
              ) : undefined
            }
          />
        ) : (
          /* v28 (round-36 #2): FlatList instead of the giant plain
           * ScrollView. THE keyboard fix: with the whole catalog in
           * one non-virtualized ScrollView, opening the keyboard
           * (adjustResize) re-laid-out THOUSANDS of product views on
           * the main thread while the IME show sequence was still
           * settling — Android gave up and flash-closed the keyboard
           * («تفتح لوحة المفاتيح وتغلق بسبب ارتفاع المنتجات»).
           * Virtualization keeps only the visible window mounted, the
           * resize pass stays tiny and the keyboard stays open. */
          <FlatList
            style={{flex: 1}}
            data={products}
            keyExtractor={item => String(item.id)}
            renderItem={({item: product}) => {
              const state = stockStateOf(product, defaultThreshold);
              const weighted = isWeightProduct(product);
              return (
                <TouchableOpacity
                  style={styles.row}
                  activeOpacity={0.75}
                  onPress={() =>
                    navigation.navigate('ProductForm', {productId: product.id})
                  }>
                  {product.image_uri ? (
                    <Image
                      source={{uri: `file://${product.image_uri}`}}
                      style={styles.thumb}
                    />
                  ) : (
                    <View style={[styles.thumb, styles.thumbFallback]}>
                      <Icon name="box" size={20} color={c.accent} />
                    </View>
                  )}
                  <View style={{flex: 1}}>
                    <Text style={styles.name} numberOfLines={1}>
                      {product.name}
                    </Text>
                    <Text style={styles.meta} numberOfLines={1}>
                      {weighted ? 'كيلو' : 'مفرق'}{' '}
                      {formatMoney(product.retail_price)} · جملة{' '}
                      {formatMoney(product.wholesale_price)}
                    </Text>
                    <View style={styles.tagRow}>
                      {weighted ? (
                        <View style={styles.miniTag}>
                          <Icon name="scale" size={10} color={c.textFaint} />
                        </View>
                      ) : null}
                      {product.barcode ? (
                        <View style={styles.miniTag}>
                          <Icon name="barcode" size={10} color={c.textFaint} />
                        </View>
                      ) : null}
                      {state === 'low' ? (
                        <View style={styles.miniTag}>
                          <Text style={styles.miniTagText}>حد منخفض</Text>
                        </View>
                      ) : null}
                    </View>
                  </View>
                  <View style={styles.rowEnd}>
                    <View
                      style={[
                        styles.stockBadge,
                        {
                          backgroundColor:
                            state === 'out'
                              ? c.dangerSoft
                              : state === 'low'
                              ? c.warningSoft
                              : c.successSoft,
                        },
                      ]}>
                      <Text
                        style={[
                          styles.stockText,
                          {
                            color:
                              state === 'out'
                                ? c.danger
                                : state === 'low'
                                ? c.warning
                                : c.success,
                          },
                        ]}>
                        {state === 'out'
                          ? 'نفد'
                          : `${formatQty(
                              product.stock_quantity,
                            )} ${baseUnitLabelOf(product, BASE_UNIT_NAME)}`}
                      </Text>
                    </View>
                    <Icon name="chevronLeft" size={16} color={c.textFaint} />
                  </View>
                </TouchableOpacity>
              );
            }}
            contentContainerStyle={{
              gap: spacing.sm,
              paddingBottom: spacing.xxl,
            }}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            initialNumToRender={14}
            maxToRenderPerBatch={14}
            windowSize={7}
          />
        )}
      </View>
    </View>
  );
}

/** v8.2 overflow-menu row (round-11 #4: the three big quick-action
 *  buttons were removed from the body — their destinations live
 *  here now, one compact tap away in the header). */
function MenuItem({
  icon,
  label,
  hint,
  onPress,
}: {
  icon: 'clipboard' | 'shapes' | 'scale';
  label: string;
  hint: string;
  onPress: () => void;
}) {
  const c = useThemeColors();
  const styles = useStyles();
  return (
    <TouchableOpacity
      style={styles.menuItem}
      onPress={onPress}
      activeOpacity={0.75}>
      <View style={[styles.menuIcon, {backgroundColor: c.accentSoft}]}>
        <Icon name={icon} size={18} color={c.accent} />
      </View>
      <View style={{flex: 1}}>
        <Text style={styles.menuLabel}>{label}</Text>
        <Text style={styles.menuHint} numberOfLines={1}>
          {hint}
        </Text>
      </View>
      <Icon name="chevronLeft" size={16} color={c.textFaint} />
    </TouchableOpacity>
  );
}

function FilterChip({
  label,
  count,
  active,
  onPress,
}: {
  label: string;
  count: number;
  active: boolean;
  onPress: () => void;
}) {
  const c = useThemeColors();
  const styles = useStyles();
  return (
    <TouchableOpacity
      style={[
        styles.chip,
        active ? {backgroundColor: c.accent, borderColor: c.accent} : null,
      ]}
      onPress={onPress}
      activeOpacity={0.7}
      hitSlop={{top: 4, bottom: 4, left: 2, right: 2}}>
      <Text style={[styles.chipText, {color: active ? c.onAccent : c.textDim}]}>
        {label}
      </Text>
      <View
        style={[
          styles.chipCount,
          {backgroundColor: active ? 'rgba(255,255,255,0.22)' : c.surfaceHi},
        ]}>
        <Text
          style={[
            styles.chipCountText,
            {color: active ? c.onAccent : c.textFaint},
          ]}>
          {count}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

const useStyles = makeStyles(c =>
  StyleSheet.create({
    screen: {flex: 1, backgroundColor: c.bg},
    body: {
      flex: 1,
      padding: spacing.lg,
      // v8.3 (round-12 #2): sm (8) — the product list starts right
      // under the filter chips (md left a visible dead gap after the
      // quick-action buttons were removed in v8.2).
      gap: spacing.sm,
    },
    // v8.3: the chips strip takes exactly its content height — it
    // can never stretch between the search bar and the product list.
    chipsRow: {
      flexGrow: 0,
    },
    // v28 (round-36 #2): text search + icon-only barcode scanner in
    // one row (same pattern as the invoices center).
    searchRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    scanBtn: {
      width: 46,
      height: 46,
      borderRadius: radius.md,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    // v8.2 (round-11 #4): header overflow menu — replaces the three
    // tall quick-action cards that used to push the list down.
    headerActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
    },
    menuBtn: {
      width: 36,
      height: 36,
      borderRadius: 10,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    menuBackdrop: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(3,3,6,0.5)',
      zIndex: 20,
    },
    menuSheet: {
      position: 'absolute',
      alignSelf: 'flex-start',
      marginHorizontal: spacing.md,
      minWidth: 240,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      padding: spacing.xs,
      gap: 2,
      elevation: 12,
    },
    menuItem: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      borderRadius: radius.sm,
      padding: spacing.md,
    },
    menuIcon: {
      width: 34,
      height: 34,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
    },
    menuLabel: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    menuHint: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro,
      marginTop: 1,
    },
    chip: {
      // v6.1: fixed 30dp height — every category chip is now the exact
      // same size, tap feels instant (activeOpacity 0.7 + hitSlop).
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      height: 30,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 6,
      paddingHorizontal: 9,
    },
    chipText: {
      fontFamily: fonts.bold,
      fontSize: typography.micro + 1,
    },
    chipCount: {
      minWidth: 15,
      minHeight: 15,
      borderRadius: 4,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 3,
    },
    chipCountText: {
      fontFamily: fonts.bold,
      fontSize: typography.micro - 0.5,
      fontVariant: ['tabular-nums'],
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: radius.md,
      padding: spacing.md,
    },
    thumb: {
      width: 52,
      height: 52,
      borderRadius: 13,
      backgroundColor: c.surfaceAlt,
    },
    thumbFallback: {
      alignItems: 'center',
      justifyContent: 'center',
    },
    name: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.caption,
    },
    meta: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      marginTop: 3,
      fontVariant: ['tabular-nums'],
    },
    tagRow: {
      flexDirection: 'row',
      gap: spacing.xs,
      marginTop: 4,
    },
    miniTag: {
      backgroundColor: c.surfaceHi,
      borderRadius: 6,
      paddingHorizontal: 6,
      paddingVertical: 2,
    },
    miniTagText: {
      color: c.textFaint,
      fontFamily: fonts.bold,
      fontSize: typography.micro - 0.5,
    },
    rowEnd: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    stockBadge: {
      borderRadius: radius.pill,
      paddingHorizontal: 12,
      paddingVertical: 5,
    },
    stockText: {
      fontFamily: fonts.bold,
      fontSize: typography.micro + 0.5,
      fontVariant: ['tabular-nums'],
    },
  }),
);
