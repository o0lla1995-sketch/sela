/**
 * InventoryScreen — المخزون (design.md §9.3).
 * Search + category chips + product rows with live stock badges.
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
import {AppButton, AppHeader, EmptyState, SearchBar} from '../../components/ui';
import {Icon} from '../../components/Icon';
import {useCatalogStore} from '../../stores/catalogStore';
import {useSettingsStore} from '../../stores/settingsStore';
import {colors, fonts, radius, spacing, typography} from '../../core/theme';
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
      if (query && !product.name.toLowerCase().includes(query)) {
        return false;
      }
      return true;
    });
  }, [products, search, filter]);

  const stockBadge = useCallback(
    (product: Product) => {
      const state = stockStateOf(product, settings.lowStockDefaultThreshold);
      if (state === 'out') {
        return {label: 'نفد', tone: 'danger' as const};
      }
      if (state === 'low') {
        return {label: `${product.stock_quantity} منخفض`, tone: 'warning' as const};
      }
      return {label: `${product.stock_quantity}`, tone: 'success' as const};
    },
    [settings.lowStockDefaultThreshold],
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
      badge={stockBadge}
      onRefresh={refresh}
    />
  );
}


function InventoryLayout({
  products,
  allProducts,
  categories,
  loading,
  search,
  setSearch,
  filter,
  setFilter,
  badge,
  onRefresh,
}: {
  products: Product[];
  allProducts: Product[];
  categories: {id: number; name: string}[];
  loading: boolean;
  search: string;
  setSearch: (value: string) => void;
  filter: CategoryFilter;
  setFilter: (value: CategoryFilter) => void;
  badge: (product: Product) => {label: string; tone: 'danger' | 'warning' | 'success'};
  onRefresh: () => Promise<void>;
}) {
  const navigation = useNavigation<any>();
  const lowCount = allProducts.filter(
    product => stockStateOf(product, 5) !== 'ok',
  ).length;

  return (
    <View style={styles.screen}>
      <AppHeader
        title="المخزون"
        subtitle={`${allProducts.length} منتج`}
        showBack={false}
        right={
          <AppButton
            small
            title="منتج جديد"
            icon="plus"
            onPress={() => navigation.navigate('ProductForm', {})}
          />
        }
      />

      <View style={styles.body}>
        <SearchBar
          value={search}
          onChangeText={setSearch}
          placeholder="ابحث بالاسم…"
        />

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{gap: spacing.sm, paddingVertical: 2}}>
          <FilterChip
            label="الكل"
            active={filter === 'all'}
            onPress={() => setFilter('all')}
          />
          {categories.map(category => (
            <FilterChip
              key={category.id}
              label={category.name}
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
                ? 'أضف أول منتج مع التقاط بصمته البصرية من ثلاث زوايا'
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
            contentContainerStyle={{gap: spacing.sm, paddingBottom: spacing.xxl}}
            showsVerticalScrollIndicator={false}>
            {products.map(product => {
              const stock = badge(product);
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
                      <Icon name="box" size={20} color={colors.accent} />
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
                  </View>
                  <View style={styles.rowEnd}>
                    <View
                      style={[
                        styles.stockBadge,
                        stock.tone === 'danger'
                          ? {backgroundColor: colors.dangerSoft}
                          : stock.tone === 'warning'
                          ? {backgroundColor: colors.warningSoft}
                          : {backgroundColor: colors.successSoft},
                      ]}>
                      <Text
                        style={[
                          styles.stockText,
                          stock.tone === 'danger'
                            ? {color: colors.danger}
                            : stock.tone === 'warning'
                            ? {color: colors.warning}
                            : {color: colors.success},
                        ]}>
                        {stock.label}
                      </Text>
                    </View>
                    <Icon name="chevronLeft" size={16} color={colors.textFaint} />
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

function FilterChip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.chip, active && styles.chipActive]}
      onPress={onPress}
      activeOpacity={0.8}>
      <Text style={[styles.chipText, active && styles.chipTextActive]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: colors.bg},
  body: {
    flex: 1,
    padding: spacing.lg,
    gap: spacing.md,
  },
  chip: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: 8,
  },
  chipActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  chipText: {
    color: colors.textDim,
    fontFamily: fonts.bold,
    fontSize: typography.small,
  },
  chipTextActive: {color: colors.onAccent},
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  thumb: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: colors.surfaceAlt,
  },
  thumbFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: {
    color: colors.text,
    fontFamily: fonts.bold,
    fontSize: typography.caption,
  },
  meta: {
    color: colors.textDim,
    fontFamily: fonts.regular,
    fontSize: typography.micro + 1,
    marginTop: 2,
    fontVariant: ['tabular-nums'],
  },
  rowEnd: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  stockBadge: {
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  stockText: {
    fontFamily: fonts.bold,
    fontSize: typography.micro,
    fontVariant: ['tabular-nums'],
  },
});
