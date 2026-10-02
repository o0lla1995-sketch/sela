/**
 * InventoryScreen — قائمة المنتجات مع البحث والفلترة حسب الفئة،
 * وإدارة الفئات نفسها.
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  FlatList,
  Image,
  Modal,
  ScrollView,
  Keyboard,
} from 'react-native';
import {
  AppButton,
  Badge,
  EmptyState,
  Screen,
  ScreenHeader,
  useConfirm,
} from '../../components/ui';
import {useCatalogStore} from '../../stores/catalogStore';
import {useNavigation} from '../../core/navigation';
import {ProductRepo} from '../../database/repositories/ProductRepo';
import {CategoryRepo} from '../../database/repositories/CategoryRepo';
import {requirePlatformUtils} from '../../native/nativeBridge';
import {useToastStore} from '../../stores/toastStore';
import {colors, radius, spacing, typography} from '../../core/theme';
import {ANGLE_LABELS} from '../../core/config';
import {formatMoney} from '../../core/format';
import type {Product} from '../../core/types';

export function InventoryScreen() {
  const push = useNavigation(state => state.push);
  const products = useCatalogStore(state => state.products);
  const categories = useCatalogStore(state => state.categories);
  const refresh = useCatalogStore(state => state.refresh);
  const toast = useToastStore(state => state.show);
  const {ask, dialog} = useConfirm();

  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<number | 'all'>('all');
  const [categoryModalVisible, setCategoryModalVisible] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await ProductRepo.list({
        search,
        categoryId: categoryFilter,
      });
      useCatalogStore.setState({products: list});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast(message, 'error');
    }
  }, [search, categoryFilter, toast]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void load();
    }, 220);
    return () => clearTimeout(timer);
  }, [load]);

  const categoryChips = useMemo(
    () => [
      {value: 'all' as const, label: 'الكل'},
      ...categories.map(category => ({
        value: category.id,
        label: category.name,
      })),
    ],
    [categories],
  );

  const deleteProduct = useCallback(
    (product: Product) => {
      ask(
        'حذف المنتج',
        `سيتم حذف "${product.name}" مع بصماته البصرية وصوره نهائياً. هل أنت متأكد؟`,
        async () => {
          try {
            const dir = await imagesDir();
            for (const angle of ANGLE_LABELS) {
              try {
                await requirePlatformUtils().deleteFile(
                  `${dir}/product_${product.id}_${angle}.jpg`,
                );
              } catch {
                // Missing image file is fine.
              }
            }
            await ProductRepo.remove(product.id);
            await refresh();
            toast('تم حذف المنتج', 'success');
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            toast(message, 'error');
          }
        },
        true,
        'حذف نهائي',
      );
    },
    [ask, refresh, toast],
  );

  return (
    <Screen>
      <ScreenHeader
        title="المخزون"
        subtitle={`${products.length} منتج — ${categories.length} فئة`}
        showBack
      />
      <View style={styles.body}>
        <TextInput
          style={styles.searchInput}
          placeholder="ابحث باسم المنتج…"
          placeholderTextColor={colors.textFaint}
          value={search}
          onChangeText={setSearch}
          textAlign="right"
        />

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipsContent}
          style={styles.chipsRow}>
          {categoryChips.map(chip => {
            const active = chip.value === categoryFilter;
            return (
              <TouchableOpacity
                key={String(chip.value)}
                style={[styles.chip, active && styles.chipActive]}
                onPress={() => setCategoryFilter(chip.value)}>
                <Text style={[styles.chipText, active && styles.chipTextActive]}>
                  {chip.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        <FlatList
          data={products}
          keyExtractor={item => String(item.id)}
          contentContainerStyle={styles.listContent}
          keyboardShouldPersistTaps="handled"
          renderItem={({item}) => (
            <ProductRow
              product={item}
              onEdit={() => push('product-form', {productId: item.id})}
              onDelete={() => deleteProduct(item)}
            />
          )}
          ListEmptyComponent={
            <EmptyState
              title="لا توجد منتجات"
              subtitle="أضف أول منتج مع بصمته البصرية الثلاثية لتبدأ البيع الذكي"
              emoji="📦"
            />
          }
        />

        <View style={styles.bottomActions}>
          <AppButton
            title="➕ منتج جديد"
            onPress={() => push('product-form')}
            style={{flex: 1}}
          />
          <AppButton
            title="إدارة الفئات"
            variant="ghost"
            onPress={() => setCategoryModalVisible(true)}
            style={{flex: 1}}
          />
        </View>
      </View>

      <CategoriesModal
        visible={categoryModalVisible}
        onClose={() => setCategoryModalVisible(false)}
      />
      {dialog}
    </Screen>
  );
}

// ────────────────────────────────────────────────────────────────
// Product row
// ────────────────────────────────────────────────────────────────

function ProductRow({
  product,
  onEdit,
  onDelete,
}: {
  product: Product;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [imagePath, setImagePath] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const check = async () => {
      try {
        const dir = await imagesDir();
        const candidate = `${dir}/product_${product.id}_front.jpg`;
        const exists = await requirePlatformUtils().fileExists(candidate);
        if (mounted) setImagePath(exists ? candidate : null);
      } catch {
        if (mounted) setImagePath(null);
      }
    };
    void check();
    return () => {
      mounted = false;
    };
  }, [product.id]);

  const stockTone =
    product.stock_quantity <= 0
      ? 'danger'
      : product.stock_quantity <= 5
      ? 'warning'
      : 'success';

  return (
    <TouchableOpacity style={styles.row} onPress={onEdit} activeOpacity={0.85}>
      <View style={styles.rowImageWrap}>
        {imagePath ? (
          <Image source={{uri: `file://${imagePath}`}} style={styles.rowImage} />
        ) : (
          <Text style={styles.rowImagePlaceholder}>📦</Text>
        )}
      </View>
      <View style={styles.rowInfo}>
        <Text style={styles.rowName} numberOfLines={1}>
          {product.name}
        </Text>
        <View style={styles.rowPrices}>
          <Text style={styles.rowPrice}>
            مفرق: {formatMoney(product.retail_price)}
          </Text>
          <Text style={styles.rowPriceDim}>
            جملة: {formatMoney(product.wholesale_price)}
          </Text>
        </View>
      </View>
      <View style={styles.rowEnd}>
        <Badge label={`متوفر: ${product.stock_quantity}`} tone={stockTone} />
        <TouchableOpacity
          onPress={onDelete}
          hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}>
          <Text style={styles.rowDelete}>حذف</Text>
        </TouchableOpacity>
      </View>
    </TouchableOpacity>
  );
}

// ────────────────────────────────────────────────────────────────
// Categories management modal
// ────────────────────────────────────────────────────────────────

function CategoriesModal({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const categories = useCatalogStore(state => state.categories);
  const products = useCatalogStore(state => state.products);
  const refresh = useCatalogStore(state => state.refresh);
  const toast = useToastStore(state => state.show);

  const [newName, setNewName] = useState('');
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameText, setRenameText] = useState('');
  const nameInputRef = useRef<TextInput>(null);

  const countFor = (id: number) =>
    products.filter(product => product.category_id === id).length;

  const addCategory = async () => {
    const name = newName.trim();
    if (!name) {
      toast('اكتب اسم الفئة أولاً', 'error');
      return;
    }
    try {
      await CategoryRepo.create(name);
      setNewName('');
      Keyboard.dismiss();
      await refresh();
      toast('تمت إضافة الفئة', 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  const applyRename = async () => {
    if (renamingId == null) return;
    const name = renameText.trim();
    if (!name) {
      toast('اسم الفئة فارغ', 'error');
      return;
    }
    try {
      await CategoryRepo.rename(renamingId, name);
      setRenamingId(null);
      setRenameText('');
      await refresh();
      toast('تم تحديث اسم الفئة', 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  const removeCategory = async (id: number, name: string) => {
    try {
      await CategoryRepo.remove(id);
      await refresh();
      toast(`تم حذف فئة "${name}"`, 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalRoot}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>إدارة الفئات</Text>
          <TouchableOpacity onPress={onPressClose(onClose)}>
            <Text style={styles.modalClose}>إغلاق</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.modalAddRow}>
          <TextInput
            ref={nameInputRef}
            style={styles.modalInput}
            placeholder="اسم الفئة الجديدة…"
            placeholderTextColor={colors.textFaint}
            value={newName}
            onChangeText={setNewName}
            textAlign="right"
          />
          <AppButton title="إضافة" small onPress={addCategory} />
        </View>

        <FlatList
          data={categories}
          keyExtractor={item => String(item.id)}
          contentContainerStyle={styles.modalList}
          renderItem={({item}) => (
            <View style={styles.modalRow}>
              {renamingId === item.id ? (
                <>
                  <TextInput
                    style={[styles.modalInput, {flex: 1}]}
                    value={renameText}
                    onChangeText={setRenameText}
                    textAlign="right"
                    autoFocus
                  />
                  <TouchableOpacity
                    style={styles.modalAction}
                    onPress={applyRename}>
                    <Text style={styles.modalActionSave}>حفظ</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.modalAction}
                    onPress={() => setRenamingId(null)}>
                    <Text style={styles.modalActionCancel}>إلغاء</Text>
                  </TouchableOpacity>
                </>
              ) : (
                <>
                  <View style={{flex: 1}}>
                    <Text style={styles.modalRowName}>{item.name}</Text>
                    <Text style={styles.modalRowCount}>
                      {countFor(item.id)} منتج
                    </Text>
                  </View>
                  <TouchableOpacity
                    style={styles.modalAction}
                    onPress={() => {
                      setRenamingId(item.id);
                      setRenameText(item.name);
                    }}>
                    <Text style={styles.modalActionEdit}>تعديل</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.modalAction}
                    onPress={() => removeCategory(item.id, item.name)}>
                    <Text style={styles.modalActionDelete}>حذف</Text>
                  </TouchableOpacity>
                </>
              )}
            </View>
          )}
          ListEmptyComponent={
            <EmptyState title="لا توجد فئات" emoji="🏷️" />
          }
        />
      </View>
    </Modal>
  );
}

function onPressClose(onClose: () => void) {
  return onClose;
}

// ────────────────────────────────────────────────────────────────

/** Cached app files dir for catalogue images. */
let cachedImagesDir: string | null = null;
export async function imagesDir(): Promise<string> {
  if (cachedImagesDir != null) return cachedImagesDir;
  const base = await requirePlatformUtils().getFilesDir();
  const dir = `${base}/product_images`;
  await requirePlatformUtils().makeDir(dir);
  cachedImagesDir = dir;
  return dir;
}

const styles = StyleSheet.create({
  body: {flex: 1, padding: spacing.md, gap: spacing.sm},
  searchInput: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    color: colors.text,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    fontSize: typography.caption,
  },
  chipsRow: {flexGrow: 0},
  chipsContent: {paddingVertical: 2, gap: 8},
  chip: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.xl,
    paddingHorizontal: spacing.lg,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipActive: {backgroundColor: colors.accentSoft, borderColor: colors.accent},
  chipText: {color: colors.textDim, fontSize: typography.caption, fontWeight: '700'},
  chipTextActive: {color: colors.accent},
  listContent: {gap: spacing.sm, paddingBottom: spacing.sm},
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.md,
  },
  rowImageWrap: {
    width: 52,
    height: 52,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  rowImage: {width: 52, height: 52},
  rowImagePlaceholder: {fontSize: 24},
  rowInfo: {flex: 1, gap: 4},
  rowName: {color: colors.text, fontWeight: '800', fontSize: typography.caption},
  rowPrices: {flexDirection: 'row', gap: spacing.md},
  rowPrice: {color: colors.accent, fontSize: typography.small, fontWeight: '700'},
  rowPriceDim: {color: colors.textDim, fontSize: typography.small},
  rowEnd: {alignItems: 'flex-end', gap: 8},
  rowDelete: {color: colors.danger, fontSize: typography.small, fontWeight: '700'},
  bottomActions: {flexDirection: 'row', gap: spacing.md, paddingTop: spacing.sm},
  modalRoot: {flex: 1, backgroundColor: colors.bg, paddingTop: spacing.xl},
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  modalTitle: {color: colors.text, fontSize: typography.heading, fontWeight: '900'},
  modalClose: {color: colors.accent, fontWeight: '800', fontSize: typography.body},
  modalAddRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.md,
  },
  modalInput: {
    flex: 1,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    color: colors.text,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    fontSize: typography.caption,
  },
  modalList: {paddingHorizontal: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xxl},
  modalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  modalRowName: {color: colors.text, fontWeight: '800', fontSize: typography.caption},
  modalRowCount: {color: colors.textDim, fontSize: typography.small, marginTop: 2},
  modalAction: {paddingHorizontal: 6},
  modalActionEdit: {color: colors.info, fontWeight: '700', fontSize: typography.small},
  modalActionDelete: {color: colors.danger, fontWeight: '700', fontSize: typography.small},
  modalActionSave: {color: colors.success, fontWeight: '700', fontSize: typography.small},
  modalActionCancel: {color: colors.textDim, fontWeight: '700', fontSize: typography.small},
});
