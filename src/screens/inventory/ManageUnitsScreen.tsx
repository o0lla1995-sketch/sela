/**
 * ManageUnitsScreen — إدارة الوحدات.
 * ─────────────────────────────────────────────────────────────────
 * User-defined sellable units (قطعة، كرتونة، كيلو…) exactly like
 * global POS systems. Units are referenced by products through
 * product_units with conversion factors; a unit in use cannot be
 * deleted so historical sales stay readable.
 *
 * v9.2 (round-15 #3): every unit now carries a TYPE — وزن / قطعة /
 * حجم / طول — shown as a colored badge on every row. The add form
 * picks the type with chips, and the list is grouped by type so the
 * merchant sees at a glance which units suit weight products (وقية،
 * رطل…) and which suit piece products (كرتونة، علبة…).
 */
import React, {useCallback, useEffect, useMemo, useState} from 'react';
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
import {UNIT_KIND_LABELS} from '../../core/config';
import {
  fonts,
  makeStyles,
  radius,
  spacing,
  typography,
  useThemeColors,
} from '../../core/theme';
import type {Unit, UnitKind} from '../../core/types';

const UNIT_KINDS: UnitKind[] = ['piece', 'weight', 'volume', 'length'];

/** Kind chip colors + icons (visual distinction at a glance). */
function kindVisual(c: {info: string; warning: string; accent: string; success: string}) {
  return {
    piece: {color: c.info, icon: 'box' as const},
    weight: {color: c.warning, icon: 'scale' as const},
    volume: {color: c.accent, icon: 'basket' as const},
    length: {color: c.success, icon: 'edit' as const},
  };
}

export function ManageUnitsScreen() {
  const c = useThemeColors();
  const styles = useStyles();
  const toast = useToastStore(state => state.show);
  const visuals = kindVisual(c);

  const [units, setUnits] = useState<Unit[]>([]);
  const [search, setSearch] = useState('');
  const [newName, setNewName] = useState('');
  const [newShort, setNewShort] = useState('');
  const [newKind, setNewKind] = useState<UnitKind>('piece');
  const [busy, setBusy] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Unit | null>(null);
  const [renameName, setRenameName] = useState('');
  const [renameShort, setRenameShort] = useState('');
  const [renameKind, setRenameKind] = useState<UnitKind>('piece');

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
      await UnitRepo.create(name, newShort, newKind);
      setNewName('');
      setNewShort('');
      await load();
      toast(
        `تمت إضافة وحدة ${UNIT_KIND_LABELS[newKind]}: ${name}`,
        'success',
      );
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'فشل إضافة الوحدة',
        'error',
      );
    } finally {
      setBusy(false);
    }
  }, [newName, newShort, newKind, load, toast]);

  const deleteUnit = useCallback(
    (unit: Unit) => {
      Alert.alert(
        'حذف الوحدة',
        `سيُحذف «${unit.name}» (${UNIT_KIND_LABELS[unit.kind]}) من قائمة الوحدات. لا يمكن حذف وحدة مستخدمة في منتجات.`,
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

  /** v9.2: rows grouped by type — the "distinguish weight vs piece"
   *  ask, visible right in the list. */
  const grouped = useMemo(() => {
    const map = new Map<UnitKind, Unit[]>();
    for (const kind of UNIT_KINDS) {
      map.set(kind, []);
    }
    for (const unit of filtered) {
      map.get(unit.kind)?.push(unit);
    }
    return UNIT_KINDS.map(kind => ({
      kind,
      rows: map.get(kind) ?? [],
    })).filter(group => group.rows.length > 0);
  }, [filtered]);

  const renderKindChips = (
    value: UnitKind,
    onPick: (kind: UnitKind) => void,
  ) => (
    <View style={styles.kindChipsRow}>
      {UNIT_KINDS.map(kind => {
        const active = value === kind;
        const tint = visuals[kind].color;
        return (
          <TouchableOpacity
            key={kind}
            style={[
              styles.kindChip,
              active ? {backgroundColor: tint, borderColor: tint} : null,
            ]}
            onPress={() => onPick(kind)}
            activeOpacity={0.8}>
            <Icon
              name={visuals[kind].icon}
              size={14}
              color={active ? '#FFFFFF' : tint}
            />
            <Text
              style={[styles.kindChipText, {color: active ? '#FFFFFF' : tint}]}>
              {UNIT_KIND_LABELS[kind]}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );

  return (
    <View style={styles.screen}>
      <AppHeader
        title="إدارة الوحدات"
        subtitle={`${units.length} وحدة — بالوزن والقطعة والحجم والطول`}
        showBack
      />

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled">
        <Card style={styles.card}>
          <Field
            label="وحدة جديدة (مثال: كرتونة، وقية، طبق)"
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
          <View style={styles.kindFieldWrap}>
            <Text style={styles.kindFieldLabel}>نوع الوحدة:</Text>
            {renderKindChips(newKind, setNewKind)}
          </View>
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
            <View style={styles.kindFieldWrap}>
              <Text style={styles.kindFieldLabel}>نوع الوحدة:</Text>
              {renderKindChips(renameKind, setRenameKind)}
            </View>
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
                    await UnitRepo.rename(
                      renameTarget.id,
                      name,
                      renameShort,
                      renameKind,
                    );
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
                ? 'الوحدات بأنواعها: وزن للمنتجات الموزونة، وقطعة للتعبئة (كرتونة، علبة…) مع تحويل الكميات تلقائياً'
                : 'جرّب كلمة بحث مختلفة'
            }
          />
        ) : (
          grouped.map(group => {
            const visual = visuals[group.kind];
            return (
              <View key={group.kind} style={styles.groupWrap}>
                <View style={styles.groupHeader}>
                  <Icon name={visual.icon} size={14} color={visual.color} />
                  <Text style={[styles.groupTitle, {color: visual.color}]}>
                    وحدات {UNIT_KIND_LABELS[group.kind]}
                  </Text>
                  <Text style={styles.groupCount}>{group.rows.length}</Text>
                </View>
                {group.rows.map(unit => (
                  <View key={unit.id} style={styles.row}>
                    <View
                      style={[styles.rowIcon, {backgroundColor: visual.color}]}>
                      <Icon
                        name={visual.icon}
                        size={18}
                        color="#FFFFFF"
                      />
                    </View>
                    <View style={{flex: 1}}>
                      <Text style={styles.rowName}>{unit.name}</Text>
                      <Text style={styles.rowMeta}>
                        {UNIT_KIND_LABELS[unit.kind]} · اختصار:{' '}
                        {unit.short_name}
                      </Text>
                    </View>
                    <TouchableOpacity
                      style={styles.rowAction}
                      onPress={() => {
                        setRenameTarget(unit);
                        setRenameName(unit.name);
                        setRenameShort(unit.short_name);
                        setRenameKind(unit.kind);
                      }}>
                      <Icon name="edit" size={17} color={c.info} />
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.rowAction}
                      onPress={() => deleteUnit(unit)}>
                      <Icon name="trash" size={17} color={c.danger} />
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            );
          })
        )}

        <Text style={styles.hint}>
          وحدات «الوزن» تناسب المنتجات الموزونة (وقية = 0.25 كغ)، ووحدات «القطعة»
          تناسب التعبئة (كرتونة = 24 قطعة) — الكميات تُحفظ دائماً بوحدة الأساس
          في قاعدة البيانات، والنوع يحدد أي وحدات تظهر لكل منتج في شاشة البيع.
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
    kindFieldWrap: {gap: spacing.xs + 2},
    kindFieldLabel: {
      color: c.textFaint,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    kindChipsRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.sm,
    },
    kindChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      borderWidth: 1.5,
      borderColor: c.border,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs + 2,
      backgroundColor: c.surfaceAlt,
    },
    kindChipText: {
      fontFamily: fonts.bold,
      fontSize: typography.caption,
    },
    groupWrap: {gap: spacing.sm},
    groupHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      marginTop: spacing.xs,
    },
    groupTitle: {
      fontFamily: fonts.black,
      fontSize: typography.caption,
      flex: 1,
    },
    groupCount: {
      color: c.textFaint,
      fontFamily: fonts.bold,
      fontSize: typography.small,
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
