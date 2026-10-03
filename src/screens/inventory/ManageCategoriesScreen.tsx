/**
 * ManageCategoriesScreen — إدارة التصنيفات.
 * ─────────────────────────────────────────────────────────────────
 * User-defined categories like global POS systems: add, rename and
 * delete with live product counts. Deleting a category keeps its
 * products (they become uncategorized).
 */
import React, {useCallback, useEffect, useState} from 'react';
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {useFocusEffect} from '@react-navigation/native';
import {
  AppButton,
  AppHeader,
  Card,
  EmptyState,
  Field,
  SearchBar,
} from '../../components/ui';
import {Icon} from '../../components/Icon';
import {CategoryRepo} from '../../database/repositories/CategoryRepo';
import {useCatalogStore} from '../../stores/catalogStore';
import {useToastStore} from '../../stores/toastStore';
import {
  fonts,
  makeStyles,
  radius,
  spacing,
  typography,
  useThemeColors,
} from '../../core/theme';
import type {Category} from '../../core/types';

export function ManageCategoriesScreen() {
  const c = useThemeColors();
  const styles = useStyles();
  const toast = useToastStore(state => state.show);
  const refreshCatalog = useCatalogStore(state => state.refresh);

  const [categories, setCategories] = useState<
    (Category & {productCount?: number})[]
  >([]);
  const [search, setSearch] = useState('');
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await CategoryRepo.listWithCounts();
      setCategories(list);
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'فشل تحميل التصنيفات',
        'error',
      );
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const addCategory = useCallback(async () => {
    const name = newName.trim();
    if (!name) {
      toast('اكتب اسم التصنيف أولاً', 'error');
      return;
    }
    setBusy(true);
    try {
      await CategoryRepo.create(name);
      setNewName('');
      await load();
      await refreshCatalog();
      toast('تمت إضافة التصنيف', 'success');
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'فشل إضافة التصنيف',
        'error',
      );
    } finally {
      setBusy(false);
    }
  }, [newName, load, refreshCatalog, toast]);

  const [renameTarget, setRenameTarget] = useState<Category | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const deleteCategory = useCallback(
    (category: Category & {productCount?: number}) => {
      Alert.alert(
        'حذف التصنيف',
        `سيُحذف تصنيف «${category.name}». المنتجات المرتبطة به (${
          category.productCount ?? 0
        }) ستبقى وتصبح بدون تصنيف.`,
        [
          {text: 'إلغاء', style: 'cancel'},
          {
            text: 'حذف',
            style: 'destructive',
            onPress: async () => {
              try {
                await CategoryRepo.remove(category.id);
                await load();
                await refreshCatalog();
                toast('تم حذف التصنيف', 'success');
              } catch (error) {
                toast(
                  error instanceof Error ? error.message : 'فشل الحذف',
                  'error',
                );
              }
            },
          },
        ],
      );
    },
    [load, refreshCatalog, toast],
  );

  const filtered = categories.filter(cat =>
    cat.name.toLowerCase().includes(search.trim().toLowerCase()),
  );

  return (
    <View style={styles.screen}>
      <AppHeader
        title="إدارة التصنيفات"
        subtitle={`${categories.length} تصنيف`}
        showBack
      />

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled">
        <Card style={styles.addCard}>
          <Field
            label="تصنيف جديد"
            value={newName}
            onChangeText={setNewName}
            placeholder="مثال: مشروبات غازية"
          />
          <AppButton
            title="إضافة التصنيف"
            icon="plus"
            onPress={addCategory}
            loading={busy}
          />
        </Card>

        {renameTarget != null ? (
          <Card style={styles.addCard}>
            <Field
              label={`تعديل «${renameTarget.name}»`}
              value={renameValue}
              onChangeText={setRenameValue}
              placeholder="الاسم الجديد"
            />
            <View style={styles.rowButtons}>
              <AppButton
                title="حفظ"
                icon="check"
                small
                style={{flex: 1}}
                onPress={async () => {
                  const name = renameValue.trim();
                  if (!name) {
                    toast('اكتب الاسم الجديد', 'error');
                    return;
                  }
                  try {
                    await CategoryRepo.rename(renameTarget.id, name);
                    setRenameTarget(null);
                    setRenameValue('');
                    await load();
                    await refreshCatalog();
                    toast('تم تحديث التصنيف', 'success');
                  } catch (error) {
                    toast(
                      error instanceof Error ? error.message : 'فشل التعديل',
                      'error',
                    );
                  }
                }}
              />
              <AppButton
                title="إلغاء"
                variant="secondary"
                small
                style={{flex: 1}}
                onPress={() => {
                  setRenameTarget(null);
                  setRenameValue('');
                }}
              />
            </View>
          </Card>
        ) : null}

        <SearchBar
          value={search}
          onChangeText={setSearch}
          placeholder="ابحث في التصنيفات…"
        />

        {filtered.length === 0 ? (
          <EmptyState
            icon="shapes"
            title={categories.length === 0 ? 'لا توجد تصنيفات' : 'لا نتائج'}
            subtitle={
              categories.length === 0
                ? 'أضف أول تصنيف من الأعلى لتنظيم منتجاتك مثل الأنظمة العالمية'
                : 'جرّب كلمة بحث مختلفة'
            }
          />
        ) : (
          filtered.map(category => (
            <View key={category.id} style={styles.row}>
              <View style={[styles.rowIcon, {backgroundColor: c.accentSoft}]}>
                <Icon name="shapes" size={18} color={c.accent} />
              </View>
              <View style={{flex: 1}}>
                <Text style={styles.rowName}>{category.name}</Text>
                <Text style={styles.rowMeta}>
                  {category.productCount ?? 0} منتج
                </Text>
              </View>
              <TouchableOpacity
                style={styles.rowAction}
                onPress={() => {
                  setRenameTarget(category);
                  setRenameValue(category.name);
                }}>
                <Icon name="edit" size={17} color={c.info} />
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.rowAction}
                onPress={() => deleteCategory(category)}>
                <Icon name="trash" size={17} color={c.danger} />
              </TouchableOpacity>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const useStyles = makeStyles(c =>
  StyleSheet.create({
    screen: {flex: 1, backgroundColor: c.bg},
    content: {
      padding: spacing.lg,
      gap: spacing.md,
      paddingBottom: spacing.xxl,
    },
    addCard: {gap: spacing.md},
    rowButtons: {flexDirection: 'row', gap: spacing.sm},
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
    rowIcon: {
      width: 40,
      height: 40,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
    },
    rowName: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.caption,
    },
    rowMeta: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      marginTop: 1,
    },
    rowAction: {
      width: 38,
      height: 38,
      borderRadius: 12,
      backgroundColor: c.surfaceAlt,
      alignItems: 'center',
      justifyContent: 'center',
    },
  }),
);
