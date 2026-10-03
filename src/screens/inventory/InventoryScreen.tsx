/**
 * InventoryScreen — المخزون (v3).
 * ─────────────────────────────────────────────────────────────────
 * Redesigned breathing room: taller category chips with product
 * counts, roomier rows with stock + unit badges, quick access to
 * stocktake (الجرد) and category management.
 */
import React, {useCallback, useMemo, useState} from 'react';
import {
  Image,
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
import {BASE_UNIT_NAME} from '../../core/config';
import {
  fonts,
  makeStyles,
  radius,
  spacing,
  typography,
  useThemeColors,
} from '../../core/theme';
import {formatMoney} from '../../core/format';
import {stockStateOf, type Product} from '../../core/types';

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

  useFocusEffect(
    useCallback(() => {
      void refresh();
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
}) {
  const c = useThemeColors();
  const styles = useStyles();
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();

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
        <SearchBar
          value={search}
          onChangeText={setSearch}
          placeholder="ابحث بالاسم أو الباركود…"
        />

        {/* ── Category chips — compact, horizontally scrollable ── */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{
            gap: 6,
            paddingVertical: 2,
          }}>
          <FilterChip
            label="الكل"
            count={countFor('all')}
            active={filter === 'all'}
            onPress={() => setFilter('all')}
          />
          {categories.map(category => (
            <FilterChip
              key={category.id}
              label={category.name}
              count={countFor(category.id)}
              active={filter === category.id}
              onPress={() => setFilter(category.id)}
            />
          ))}
        </ScrollView>

        {products.length === 0 ? (
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
          <ScrollView
            contentContainerStyle={{
              gap: spacing.sm,
              paddingBottom: spacing.xxl,
            }}
            showsVerticalScrollIndicator={false}>
            {products.map(product => {
              const state = stockStateOf(product, defaultThreshold);
              return (
                <TouchableOpacity
                  key={product.id}
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
                      مفرق {formatMoney(product.retail_price)} · جملة{' '}
                      {formatMoney(product.wholesale_price)}
                    </Text>
                    <View style={styles.tagRow}>
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
                          : `${product.stock_quantity} ${BASE_UNIT_NAME}`}
                      </Text>
                    </View>
                    <Icon name="chevronLeft" size={16} color={c.textFaint} />
                  </View>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
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
      gap: spacing.md,
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
