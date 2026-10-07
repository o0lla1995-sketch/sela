/**
 * StockAlertsScreen — v33 (round-41 #8) صفحة تنبيهات المخزون المخصصة.
 * ─────────────────────────────────────────────────────────────────
 * «عرض الكل» في قسم تنبيهات المخزون بالرئيسية يفتح THESE صفحة —
 * صفحة تنبيهات (لا إشعارات): كل المنتجات في حالة تنبيه (مخزون أو
 * صلاحية) مع فلاتر نوع التنبيه (منتهي الصلاحية / نفد المخزون /
 * قرب انتهاء الصلاحية / مخزون منخفض) وعدّاد لكل حالة، بترتيب
 * الخطورة نفسه الذي تستخدمه الرئيسية (منتهي ← نفد ← قرب انتهاء ←
 * منخفض) — والضغط على أي صف يفتح المنتج للمعالجة مباشرة.
 */
import React, {useEffect, useMemo, useState} from 'react';
import {FlatList, StyleSheet, Text, TouchableOpacity, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import {AppHeader, EmptyState} from '../../components/ui';
import {Icon} from '../../components/Icon';
import {StockAlertsService, type AlertState, type StockAlert} from '../../services/StockAlertsService';
import {useCatalogStore} from '../../stores/catalogStore';
import type {Category} from '../../core/types';
import {
  fonts,
  makeStyles,
  spacing,
  typography,
  useThemeColors,
} from '../../core/theme';
import {formatMoney, formatQty} from '../../core/format';
import {BASE_UNIT_NAME} from '../../core/config';
import {baseUnitLabelOf} from '../../core/types';

/** الفلاتر — نفس ترتيب الخطورة (منتهي ← نفد ← قرب انتهاء ← منخفض). */
type AlertFilter = 'all' | AlertState;

const FILTERS: {key: AlertFilter; label: string}[] = [
  {key: 'all', label: 'الكل'},
  {key: 'expired', label: 'منتهي الصلاحية'},
  {key: 'out', label: 'نفد المخزون'},
  {key: 'expiring', label: 'قرب انتهاء الصلاحية'},
  {key: 'low', label: 'مخزون منخفض'},
];

const STATE_TEXT: Record<AlertState, (a: StockAlert) => string> = {
  expired: a =>
    (a.days ?? 0) === 0
      ? 'تنتهي صلاحيته اليوم'
      : `منتهي الصلاحية منذ ${Math.abs(a.days ?? 0)} يوم`,
  out: () => 'نفد المخزون',
  expiring: a => `قرب انتهاء الصلاحية — باقي ${a.days ?? 0} يوم`,
  low: a =>
    `${formatQty(a.product.stock_quantity)} ${baseUnitLabelOf(
      a.product,
      BASE_UNIT_NAME,
    )} متبقية`,
};

export function StockAlertsScreen() {
  const c = useThemeColors();
  const styles = useStyles();
  const navigation = useNavigation<any>();
  const [filter, setFilter] = useState<AlertFilter>('all');
  // إعادة التقييم عند الدخول (لتزامن القائمة مع الكتالوج) والاستماع
  // لتحديث الكتالوج كي تبقى الأعداد حية.
  const productsVersion = useCatalogStore(s => s.products.length);
  const categories = useCatalogStore(s => s.categories);
  const categoryById = useMemo(() => {
    const map = new Map<number, Category>();
    for (const cat of categories) {
      map.set(cat.id, cat);
    }
    return map;
  }, [categories]);
  useEffect(() => {
    void StockAlertsService.evaluate();
  }, [productsVersion]);

  const allAlerts = useMemo(() => StockAlertsService.activeAlerts(9999), [
    productsVersion,
  ]);

  const counts = useMemo(() => {
    const map: Record<AlertFilter, number> = {
      all: allAlerts.length,
      expired: 0,
      out: 0,
      expiring: 0,
      low: 0,
    };
    for (const alert of allAlerts) {
      map[alert.state] += 1;
    }
    return map;
  }, [allAlerts]);

  const filtered = useMemo(
    () => (filter === 'all' ? allAlerts : allAlerts.filter(a => a.state === filter)),
    [allAlerts, filter],
  );

  const alertTone = (state: AlertState) =>
    state === 'out' || state === 'expired' ? c.danger : c.warning;

  const renderRow = ({item}: {item: StockAlert}) => {
    const tone = alertTone(item.state);
    const category =
      item.product.category_id != null
        ? categoryById.get(item.product.category_id)?.name
        : null;
    return (
      <TouchableOpacity
        style={[styles.alertCard, {borderRightWidth: 4, borderColor: tone}]}
        onPress={() =>
          navigation.navigate('ProductForm', {productId: item.product.id})
        }
        activeOpacity={0.8}>
        <View style={styles.alertIconWrap}>
          <Icon
            name={
              item.state === 'out'
                ? 'packageMinus'
                : item.state === 'expired' || item.state === 'expiring'
                ? 'clock'
                : 'alert'
            }
            size={18}
            color={tone}
          />
        </View>
        <View style={styles.alertTexts}>
          <Text style={styles.alertName} numberOfLines={1}>
            {item.product.name}
          </Text>
          <Text style={styles.alertQty}>{STATE_TEXT[item.state](item)}</Text>
          <Text style={styles.alertMeta} numberOfLines={1}>
            {formatMoney(item.product.retail_price)}
            {category ? ` · ${category}` : ''}
          </Text>
        </View>
        <Icon name="chevronLeft" size={16} color={c.textFaint} />
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.screen}>
      <AppHeader
        title="تنبيهات المخزون"
        subtitle={`${counts.all} منتج بحتاج انتباهاً — مخزون أو صلاحية`}
        showBack
      />
      <View style={styles.chipRow}>
        {FILTERS.map(f => {
          const active = filter === f.key;
          return (
            <TouchableOpacity
              key={f.key}
              style={[
                styles.chip,
                active && {backgroundColor: c.accent, borderColor: c.accent},
                f.key !== 'all' && counts[f.key] === 0 && !active
                  ? {opacity: 0.55}
                  : null,
              ]}
              onPress={() => setFilter(f.key)}
              activeOpacity={0.7}>
              <Text
                style={[
                  styles.chipText,
                  {color: active ? c.onAccent : c.textDim},
                ]}>
                {f.label}
                {f.key !== 'all' ? ` (${counts[f.key]})` : ''}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {filtered.length === 0 ? (
        <View style={styles.emptyWrap}>
          <EmptyState
            icon="checkCircle"
            title={
              filter === 'all' ? 'لا توجد تنبيهات' : 'لا تنبيهات من هذا النوع'
            }
            subtitle={
              filter === 'all'
                ? 'كل المنتجات بمخزون كافٍ وضمن مدة الصلاحية'
                : 'جرّب فلتراً آخر — أو أعد التزويد ليتغير الوضع'
            }
          />
        </View>
      ) : (
        <FlatList
          style={{flex: 1}}
          contentContainerStyle={styles.list}
          data={filtered}
          keyExtractor={item => `${item.product.id}:${item.state}`}
          renderItem={renderRow}
          showsVerticalScrollIndicator={false}
          initialNumToRender={14}
          maxToRenderPerBatch={14}
          windowSize={7}
        />
      )}
    </View>
  );
}

const useStyles = makeStyles(c =>
  StyleSheet.create({
    screen: {flex: 1, backgroundColor: c.bg},
    chipRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.sm,
      paddingBottom: spacing.xs,
    },
    chip: {
      // نفس لغة رقائق الجرد (v8.1): مستطيل صغير ثابت الارتفاع.
      minHeight: 30,
      justifyContent: 'center',
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 5,
    },
    chipText: {
      fontFamily: fonts.bold,
      fontSize: 12,
    },
    list: {
      padding: spacing.lg,
      paddingTop: spacing.sm,
      gap: spacing.sm,
      paddingBottom: spacing.xxl,
    },
    emptyWrap: {flex: 1, justifyContent: 'center', paddingHorizontal: spacing.lg},
    alertCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: 12,
      padding: spacing.sm + 2,
    },
    alertIconWrap: {
      width: 36,
      height: 36,
      borderRadius: 11,
      backgroundColor: c.surfaceAlt,
      alignItems: 'center',
      justifyContent: 'center',
    },
    alertTexts: {flex: 1, gap: 2},
    alertName: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.small + 1,
    },
    alertQty: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.small,
    },
    alertMeta: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
    },
  }),
);
