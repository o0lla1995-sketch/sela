/**
 * ManageUnitsScreen — إدارة الوحدات.
 * ─────────────────────────────────────────────────────────────────
 * User-defined sellable units (قطعة، كرتونة، كيلو…) exactly like
 * global POS systems. Units are referenced by products through
 * product_units with conversion factors; a unit in use cannot be
 * deleted so historical sales stay readable.
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
import {UnitRepo} from '../../database/repositories/UnitRepo';
import {useToastStore} from '../../stores/toastStore';
import {
  fonts,
  makeStyles,
  radius,
  spacing,
  typography,
  useThemeColors,
} from '../../core/theme';
import type {Unit} from '../../core/types';

export function ManageUnitsScreen() {
  const c = useThemeColors();
  const styles = useStyles();
  const toast = useToastStore(state => state.show);

  const [units, setUnits] = useState<Unit[]>([]);
  const [search, setSearch] = useState('');
  const [newName, setNewName] = useState('');
  const [newShort, setNewShort] = useState('');
  const [busy, setBusy] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Unit | null>(null);
  const [renameName, setRenameName] = useState('');
  const [renameShort, setRenameShort] = useState('');

  const load = useCallback(async () => {
    try {
      setUnits(await UnitRepo.list());
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'فشل تحميل الوحدات',
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

  const addUnit = useCallback(async () => {
    const name = newName.trim();
    if (!name) {
      toast('اكتب اسم الوحدة أولاً', 'error');
      return;
    }
    setBusy(true);
    try {
      await UnitRepo.create(name, newShort);
      setNewName('');
      setNewShort('');
      await load();
      toast('تمت إضافة الوحدة', 'success');
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'فشل إضافة الوحدة',
        'error',
      );
    } finally {
      setBusy(false);
    }
  }, [newName, newShort, load, toast]);

  const deleteUnit = useCallback(
    (unit: Unit) => {
      Alert.alert(
        'حذف الوحدة',
        `سيُحذف «${unit.name}» من قائمة الوحدات. لا يمكن حذف وحدة مستخدمة في منتجات.`,
        [
          {text: 'إلغاء', style: 'cancel'},
          {
            text: 'حذف',
            style: 'destructive',
            onPress: async () => {
              try {
                await UnitRepo.remove(unit.id);
                await load();
                toast('تم حذف الوحدة', 'success');
              } catch (error) {
                toast(
                  error instanceof Error ? error.message : 'فشل الحذف',
                  'error',
                  4000,
                );
              }
            },
          },
        ],
      );
    },
    [load, toast],
  );

  const filtered = units.filter(unit =>
    unit.name.toLowerCase().includes(search.trim().toLowerCase()),
  );

  return (
    <View style={styles.screen}>
      <AppHeader
        title="إدارة الوحدات"
        subtitle={`${units.length} وحدة`}
        showBack
      />

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled">
        <Card style={styles.card}>
          <Field
            label="وحدة جديدة (مثال: كرتونة، طبق، كيلو)"
            value={newName}
            onChangeText={setNewName}
            placeholder="اسم الوحدة"
          />
          <Field
            label="الاختصار (اختياري)"
            value={newShort}
            onChangeText={setNewShort}
            placeholder="كرت"
          />
          <AppButton
            title="إضافة الوحدة"
            icon="plus"
            onPress={addUnit}
            loading={busy}
          />
        </Card>

        {renameTarget != null ? (
          <Card style={styles.card}>
            <Field
              label={`تعديل «${renameTarget.name}»`}
              value={renameName}
              onChangeText={setRenameName}
              placeholder="الاسم الجديد"
            />
            <Field
              label="الاختصار"
              value={renameShort}
              onChangeText={setRenameShort}
              placeholder={renameTarget.short_name}
            />
            <View style={styles.rowButtons}>
              <AppButton
                title="حفظ"
                icon="check"
                small
                style={{flex: 1}}
                onPress={async () => {
                  const name = renameName.trim();
                  if (!name) {
                    toast('اكتب الاسم الجديد', 'error');
                    return;
                  }
                  try {
                    await UnitRepo.rename(renameTarget.id, name, renameShort);
                    setRenameTarget(null);
                    await load();
                    toast('تم تحديث الوحدة', 'success');
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
                onPress={() => setRenameTarget(null)}
              />
            </View>
          </Card>
        ) : null}

        <SearchBar
          value={search}
          onChangeText={setSearch}
          placeholder="ابحث في الوحدات…"
        />

        {filtered.length === 0 ? (
          <EmptyState
            icon="scale"
            title={units.length === 0 ? 'لا توجد وحدات' : 'لا نتائج'}
            subtitle={
              units.length === 0
                ? 'الوحدات تتيح البيع بالكرتونة أو الكيلو مع تحويل الكميات تلقائياً'
                : 'جرّب كلمة بحث مختلفة'
            }
          />
        ) : (
          filtered.map(unit => (
            <View key={unit.id} style={styles.row}>
              <View style={[styles.rowIcon, {backgroundColor: c.infoSoft}]}>
                <Icon name="scale" size={18} color={c.info} />
              </View>
              <View style={{flex: 1}}>
                <Text style={styles.rowName}>{unit.name}</Text>
                <Text style={styles.rowMeta}>اختصار: {unit.short_name}</Text>
              </View>
              <TouchableOpacity
                style={styles.rowAction}
                onPress={() => {
                  setRenameTarget(unit);
                  setRenameName(unit.name);
                  setRenameShort(unit.short_name);
                }}>
                <Icon name="edit" size={17} color={c.info} />
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.rowAction}
                onPress={() => deleteUnit(unit)}>
                <Icon name="trash" size={17} color={c.danger} />
              </TouchableOpacity>
            </View>
          ))
        )}

        <Text style={styles.hint}>
          تستخدم الوحدات عند إضافة منتج (مثال: كرتونة = 24 قطعة) وتظهر في شاشة
          البيع لتسهيل الجملة — تبقى الكميات محفوظة بالقطعة في قاعدة البيانات.
        </Text>
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
    card: {gap: spacing.md},
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
    hint: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      lineHeight: 19,
      textAlign: 'center',
      marginTop: spacing.sm,
    },
  }),
);
