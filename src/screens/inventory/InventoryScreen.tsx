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
import {QuickProductSheet} from '../../components/QuickProductSheet';
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
import {formatMoney, formatQty, formatDateTime} from '../../core/format';
import {
  baseUnitLabelOf,
  daysUntilExpiry,
  expiryStateOf,
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
import {requirePlatformUtils} from '../../native/nativeBridge';

type CategoryFilter = number | 'all';

/** v68 (الجولة 80 #١): السعر النهائي بعد خصم المنتج (0–95) —
 * نفس معادلة سطح المكتب حرفياً لقيمة البضاعة بالبيع. */
function finalPriceOf(product: Product): number {
  const pct = Math.max(0, Math.min(95, product.discount_pct ?? 0));
  if (pct <= 0) {
    return product.retail_price;
  }
  return Math.round(product.retail_price * (1 - pct / 100) * 100) / 100;
}

export function InventoryScreen() {
  const products = useCatalogStore(state => state.products);
  const categories = useCatalogStore(state => state.categories);
  const loading = useCatalogStore(state => state.loading);
  const refresh = useCatalogStore(state => state.refresh);
  const settings = useSettingsStore(state => state.settings);
  // v58 (الجولة 62): الإضافة السريعة لمود «نقطة البيع».
  const [quickAddOpen, setQuickAddOpen] = useState(false);

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
  // v32 (round-40 #3): شريحة «الصلاحية» — منتجات قاربت صلاحيتها على
  // الانتهاء أو انتهت فعلاً (نافذة التنبيه من الإعدادات).
  const [showExpiring, setShowExpiring] = useState(false);

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
          // v38 (الجولة 46 #4): بلا تتبع ليس حالة تنبيه — الكمية مرجعية.
          stockStateOf(product, settings.lowStockDefaultThreshold) === 'low' ||
          stockStateOf(product, settings.lowStockDefaultThreshold) === 'out',
      ).length,
    [products, settings.lowStockDefaultThreshold],
  );

  /** v32: المنتجات قريبة الانتهاء أو المنتهية (لشريحة الصلاحية). */
  const expiringProducts = useMemo(
    () =>
      products
        .filter(
          product =>
            expiryStateOf(product.expiry_date, settings.expiryAlertDays) !==
            'ok',
        )
        .sort(
          (a, b) =>
            daysUntilExpiry(a.expiry_date!) - daysUntilExpiry(b.expiry_date!),
        ),
    [products, settings.expiryAlertDays],
  );

  /* ── v68 (الجولة 80 #١): قيمة البضاعة في المخزون — نفس معادلة
     سطح المكتب: تكلفة×كمية لكل منتج متتبع الكمية. منتجات «الكمية
     المفتوحة» (stock_untracked=1) لا كمية معروفة لها فلا تُحتسب
     قيمتها — تُعد وتُعرض منفصلة كي يعرف التاجر بدقة ما الذي
     يشمله الرقم. المتغيرات محسوبة تلقائياً: stock_quantity يساوي
     دائماً مجموع مخزون متغيراتها. ── */
  const stockValue = useMemo(() => {
    let costValue = 0;
    let retailValue = 0;
    let trackedCount = 0;
    let untrackedCount = 0;
    let outCount = 0;
    for (const product of products) {
      if (product.stock_untracked === 1) {
        untrackedCount += 1;
        continue;
      }
      trackedCount += 1;
      const qty = Math.max(0, product.stock_quantity ?? 0);
      if (qty <= 0) {
        outCount += 1;
      }
      costValue += product.cost_price * qty;
      retailValue += finalPriceOf(product) * qty;
    }
    return {
      costValue: Math.round(costValue * 100) / 100,
      retailValue: Math.round(retailValue * 100) / 100,
      margin: Math.round((retailValue - costValue) * 100) / 100,
      trackedCount,
      untrackedCount,
      outCount,
    };
  }, [products]);

  return (
    <>
    <InventoryLayout
      products={filtered}
      allProducts={products}
      quickAddVisible={settings.storeMode === 'pos'}
      onQuickAdd={() => setQuickAddOpen(true)}
      categories={categories}
      loading={loading}
      search={search}
      setSearch={setSearch}
      filter={filter}
      setFilter={setFilter}
      countFor={countFor}
      lowCount={lowCount}
      expiringCount={expiringProducts.length}
      showExpiring={showExpiring}
      setShowExpiring={setShowExpiring}
      expiringProducts={expiringProducts}
      stockValue={stockValue}
      defaultThreshold={settings.lowStockDefaultThreshold}
      expiryAlertDays={settings.expiryAlertDays}
      onRefresh={refresh}
      menuOpen={menuOpen}
      setMenuOpen={setMenuOpen}
      showArchived={showArchived}
      setShowArchived={setShowArchived}
      archivedProducts={archivedProducts}
    />

    {/* v58 (الجولة 62): نافذة الإضافة السريعة لمود نقطة البيع —
        تُعرض من المكوّن الأصلي فتصلها حالة الفتح مباشرة. */}
    <QuickProductSheet
      visible={quickAddOpen}
      onClose={() => setQuickAddOpen(false)}
    />
    </>
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
  expiringCount,
  showExpiring,
  setShowExpiring,
  expiringProducts,
  expiryAlertDays,
  stockValue,
  quickAddVisible,
  onQuickAdd,
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
  /** v32 (round-40 #3): شريحة الصلاحية وقائمتها. */
  expiringCount: number;
  /** v58 (الجولة 62): مود نقطة البيع — إظهار زر الإضافة السريعة. */
  quickAddVisible: boolean;
  onQuickAdd: () => void;
  showExpiring: boolean;
  setShowExpiring: (value: boolean) => void;
  expiringProducts: Product[];
  expiryAlertDays: number;
  /** v68 (الجولة 80 #١): قيمة البضاعة في المخزون للعرض بالبطاقة. */
  stockValue: {
    costValue: number;
    retailValue: number;
    margin: number;
    trackedCount: number;
    untrackedCount: number;
    outCount: number;
  };
}) {
  const c = useThemeColors();
  const styles = useStyles();
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const toast = useToastStore(state => state.show);
  // v68 (الجولة 80 #٢): اسم المتجر لترويسة تقرير PDF.
  const settings = useSettingsStore(state => state.settings);

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

  /* ── v68 (الجولة 80 #٢): تقرير PDF للمخزون بالتفصيل — طلب التاجر
     نصاً «إضافة زر في صفحة المخزون يمكن من خلاله طباعة تقرير pdf
     بكافة المنتجات بالمخزون بالتفصيل وبشكل مرتب ومفصل». يبني
     الجدول من القائمة النشطة (الفلاتر الحالية تُذكر في الترويسة)
     مجمّعاً بالتصنيفات مع مجاميع كل تصنيف وصف الإجمالي الكبير —
     نفس بنية سطح المكتب (InventoryReportPdf v76) على محرك Kotlin
     المجرب (PdfDocument A4 + Tajawal + RTL). ── */
  const [pdfBusy, setPdfBusy] = useState(false);
  const exportInventoryPdf = useCallback(async () => {
    if (pdfBusy || products.length === 0) {
      return;
    }
    setPdfBusy(true);
    try {
      const activeFilters: string[] = [];
      if (filter !== 'all') {
        const cat = categories.find(c => c.id === filter);
        if (cat != null) {
          activeFilters.push(`تصنيف: ${cat.name}`);
        }
      }
      if (showExpiring) {
        activeFilters.push('الصلاحية القريبة/المنتهية');
      }
      if (showArchived) {
        activeFilters.push('المؤرشفة');
      }
      if (search.trim()) {
        activeFilters.push(`بحث: «${search.trim()}»`);
      }
      const filtersLabel =
        activeFilters.length > 0
          ? activeFilters.join(' · ')
          : 'كل المنتجات النشطة';

      // الصفوف بالترتيب نفسه الذي تراه العين — مجمعة بالتصنيف.
      const catNameById = new Map(categories.map(c => [c.id, c.name] as const));
      const stateLabel: Record<string, string> = {
        out: 'نفد',
        low: 'منخفض',
        ok: 'جيد',
        untracked: 'مفتوح',
      };
      interface GroupAcc {
        name: string;
        rows: Product[];
      }
      const groupMap = new Map<string, GroupAcc>();
      let grandCost = 0;
      let grandValue = 0;
      for (const product of products) {
        const groupName =
          product.category_id != null
            ? catNameById.get(product.category_id) ?? 'بلا تصنيف'
            : 'بلا تصنيف';
        let acc = groupMap.get(groupName);
        if (acc == null) {
          acc = {name: groupName, rows: []};
          groupMap.set(groupName, acc);
        }
        acc.rows.push(product);
        if (product.stock_untracked !== 1) {
          const qty = Math.max(0, product.stock_quantity ?? 0);
          grandCost += product.cost_price * qty;
          grandValue += finalPriceOf(product) * qty;
        }
      }
      const groups = [...groupMap.values()]
        .sort((a, b) => a.name.localeCompare(b.name, 'ar'))
        .map(acc => {
          let groupCost = 0;
          let groupValue = 0;
          const rows = acc.rows.map(product => {
            const untracked = product.stock_untracked === 1;
            const state = stockStateOf(product, defaultThreshold);
            if (!untracked) {
              const qty = Math.max(0, product.stock_quantity ?? 0);
              groupCost += product.cost_price * qty;
              groupValue += finalPriceOf(product) * qty;
            }
            return {
              name: product.name,
              barcode: (product.barcode ?? '').trim() || '—',
              cost: product.cost_price.toFixed(2),
              qty: untracked
                ? 'كمية مفتوحة'
                : `${formatQty(product.stock_quantity)} ${baseUnitLabelOf(product, BASE_UNIT_NAME)}`,
              state: stateLabel[state],
              stateKind: state,
              value: untracked
                ? '—'
                : formatMoney(
                    product.cost_price * Math.max(0, product.stock_quantity ?? 0),
                  ),
            };
          });
          return {
            name: acc.name,
            count: String(acc.rows.length),
            cost: formatMoney(groupCost),
            value: formatMoney(groupValue),
            rows,
          };
        });

      const payload = {
        storeName: settings.storeName || 'متجر سيلا',
        filtersLabel,
        generatedAt: formatDateTime(new Date().toISOString()),
        summary: [
          {label: 'قيمة بالتكلفة', value: formatMoney(stockValue.costValue)},
          {label: 'قيمة بالبيع', value: formatMoney(stockValue.retailValue)},
          {label: 'هامش متوقع', value: formatMoney(stockValue.margin)},
          {label: 'منتجات متتبعة', value: String(stockValue.trackedCount)},
          {
            label: 'كمية مفتوحة (بلا تتبع)',
            value: String(stockValue.untrackedCount),
          },
        ],
        groups,
        totalRow: {
          tracked: `${stockValue.trackedCount} متتبع`,
          cost: formatMoney(grandCost),
          value: formatMoney(grandValue),
        },
      };
      const platform = requirePlatformUtils();
      const stamp = new Date().toISOString().slice(0, 10);
      const path = await platform.createInventoryReportPdf(
        `sela-inventory-${stamp}.pdf`,
        JSON.stringify(payload),
      );
      toast(
        `تم حفظ تقرير المخزون (${products.length} منتجاً) في: ${path}`,
        'success',
        6000,
      );
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'فشل بناء تقرير المخزون PDF',
        'error',
        5000,
      );
    } finally {
      setPdfBusy(false);
    }
  }, [
    pdfBusy,
    products,
    filter,
    categories,
    showExpiring,
    showArchived,
    search,
    defaultThreshold,
    stockValue,
    settings.storeName,
    toast,
  ]);

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
            {/* v58 (الجولة 62): مود نقطة البيع — إضافة سريعة
                (اسم + سعر + حبة/علبة/غرام) بلا أي تفاصيل. */}
            {quickAddVisible ? (
              <AppButton
                small
                title="سريع"
                icon="plus"
                variant="success"
                onPress={onQuickAdd}
              />
            ) : null}
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
            {/* v68 (الجولة 80 #٢): تقرير PDF للمخزون بالتفصيل —
                مجمّع بالتصنيفات مع مجاميع كل تصنيف وصف الإجمالي. */}
            <MenuItem
              icon="printer"
              label={pdfBusy ? 'جارٍ بناء تقرير المخزون…' : 'تقرير PDF للمخزون'}
              hint="كل المنتجات بالتفصيل مجمّعة بالتصنيفات"
              onPress={() => {
                setMenuOpen(false);
                void exportInventoryPdf();
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

        {/* ── v68 (الجولة 80 #١): شريط قيمة البضاعة في المخزون —
            نفس بطاقة سطح المكتب: تكلفة×كمية لكل متتبع + قيمتها
            بالبيع وهامشها، والكمية المفتوحة تُعد منفصلة كي يعرف
            التاجر بدقة ما الذي يشمله الرقم. ── */}
        <View style={styles.valueStrip}>
          <View style={styles.valueHero}>
            <Text style={styles.valueLabel}>قيمة البضاعة (تكلفة)</Text>
            <Text style={[styles.valueAmount, {color: c.accent}]}>
              {formatMoney(stockValue.costValue)}
            </Text>
            <Text style={styles.valueMeta}>
              قيمة بيعها {formatMoney(stockValue.retailValue)} · هامش{' '}
              {formatMoney(stockValue.margin)}
            </Text>
            <Text style={styles.valueMeta}>
              متتبع {stockValue.trackedCount}
              {stockValue.untrackedCount > 0
                ? ` · ${stockValue.untrackedCount} كمية مفتوحة بلا قيمة محسوبة`
                : stockValue.outCount > 0
                ? ` · ${stockValue.outCount} نافد`
                : ''}
            </Text>
          </View>
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
            active={filter === 'all' && !showArchived && !showExpiring}
            onPress={() => {
              setShowArchived(false);
              setShowExpiring(false);
              setFilter('all');
            }}
          />
          {categories.map(category => (
            <FilterChip
              key={category.id}
              label={category.name}
              count={countFor(category.id)}
              active={filter === category.id && !showArchived && !showExpiring}
              onPress={() => {
                setShowArchived(false);
                setShowExpiring(false);
                setFilter(category.id);
              }}
            />
          ))}
          {archivedProducts.length > 0 ? (
            <FilterChip
              label="المؤرشفة"
              count={archivedProducts.length}
              active={showArchived}
              onPress={() => {
                setShowExpiring(false);
                setShowArchived(!showArchived);
              }}
            />
          ) : null}
          {/* v32 (round-40 #3): شريحة الصلاحية — قرب الانتهاء/منتهي. */}
          {expiringCount > 0 ? (
            <FilterChip
              label="الصلاحية"
              count={expiringCount}
              active={showExpiring}
              onPress={() => {
                setShowArchived(false);
                setShowExpiring(!showExpiring);
              }}
            />
          ) : null}
        </ScrollView>

        {showExpiring ? (
          /* v32 (round-40 #3): قائمة الصلاحية — الأقرب انتهاءً أولاً. */
          expiringProducts.length === 0 ? (
            <EmptyState
              icon="clock"
              title="لا منتجات قرب انتهاء الصلاحية"
              subtitle="حدّد تاريخ انتهاء للمنتجات ذات الصلاحية لتظهر هنا قبل انتهائها"
            />
          ) : (
            <FlatList
              style={{flex: 1}}
              data={expiringProducts}
              keyExtractor={item => String(item.id)}
              renderItem={({item: product}) => {
                const days = daysUntilExpiry(product.expiry_date!);
                const expired = days < 0;
                return (
                  <TouchableOpacity
                    style={[
                      styles.row,
                      {borderColor: expired ? c.danger : c.warning},
                    ]}
                    activeOpacity={0.75}
                    onPress={() =>
                      navigation.navigate('ProductForm', {
                        productId: product.id,
                      })
                    }>
                    <View style={[styles.thumb, styles.thumbFallback]}>
                      <Icon
                        name="clock"
                        size={18}
                        color={expired ? c.danger : c.warning}
                      />
                    </View>
                    <View style={{flex: 1}}>
                      <Text style={styles.name} numberOfLines={1}>
                        {product.name}
                      </Text>
                      <Text
                        style={[
                          styles.meta,
                          {color: expired ? c.danger : c.warning},
                        ]}
                        numberOfLines={1}>
                        {expired
                          ? days === 0
                            ? 'تنتهي صلاحيته اليوم'
                            : `منتهي الصلاحية منذ ${Math.abs(days)} يوم`
                          : `باقي ${days} يوم على انتهاء الصلاحية`}
                        {' — '}
                        {product.expiry_date!.slice(8, 10)}/
                        {product.expiry_date!.slice(5, 7)}/
                        {product.expiry_date!.slice(0, 4)}
                      </Text>
                    </View>
                    <View style={styles.rowEnd}>
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
          )
        ) : showArchived ? (
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
                      {(product.discount_pct ?? 0) > 0 ? (
                        <Text
                          style={{
                            textDecorationLine: 'line-through',
                            color: c.textFaint,
                            fontSize: 11,
                          }}>
                          {formatMoney(product.retail_price)}
                        </Text>
                      ) : (
                        formatMoney(product.retail_price)
                      )}
                      {(product.discount_pct ?? 0) > 0 ? (
                        <Text style={{color: c.danger, fontWeight: '900'}}>
                          {' '}
                          {formatMoney(
                            Math.round(
                              product.retail_price *
                                (1 - (product.discount_pct ?? 0) / 100) *
                                100,
                            ) / 100,
                          )}{' '}
                          (−{Math.round(product.discount_pct ?? 0)}%)
                        </Text>
                      ) : null}{' '}
                      · جملة {formatMoney(product.wholesale_price)}
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
                      {/* v32: وسم حالة الصلاحية على الصف. */}
                      {(() => {
                        const expiry = expiryStateOf(
                          product.expiry_date,
                          expiryAlertDays,
                        );
                        if (expiry === 'ok') {
                          return null;
                        }
                        return (
                          <View
                            style={[
                              styles.miniTag,
                              expiry === 'expired'
                                ? {backgroundColor: c.dangerSoft}
                                : {backgroundColor: c.warningSoft},
                            ]}>
                            <Text
                              style={[
                                styles.miniTagText,
                                {
                                  color:
                                    expiry === 'expired' ? c.danger : c.warning,
                                },
                              ]}>
                              {expiry === 'expired' ? 'منتهي' : 'قرب الانتهاء'}
                            </Text>
                          </View>
                        );
                      })()}
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
                              : state === 'untracked'
                              ? c.surfaceHi
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
                                : state === 'untracked'
                                ? c.textDim
                                : c.success,
                          },
                        ]}>
                        {state === 'out'
                          ? 'نفد'
                          : // v38 (الجولة 46 #4): بلا تتبع ليست «نفداً» —
                            // الكمية مرجعية لا تُخصم بالبيع أبداً.
                            state === 'untracked'
                          ? 'بلا تتبع'
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
  icon: 'clipboard' | 'shapes' | 'scale' | 'printer';
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
    // ── v68 (الجولة 80 #١): بطاقة قيمة البضاعة في المخزون ──
    valueStrip: {
      backgroundColor: c.surface,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.lg,
      borderStartWidth: 3,
      borderStartColor: c.accent,
    },
    valueHero: {gap: 3},
    valueLabel: {
      fontSize: typography.small,
      color: c.textDim,
      fontWeight: '600',
    },
    valueAmount: {
      fontSize: typography.heading,
      fontWeight: '800',
      fontVariant: ['tabular-nums'],
    },
    valueMeta: {
      fontSize: typography.small,
      color: c.textDim,
      lineHeight: 18,
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
