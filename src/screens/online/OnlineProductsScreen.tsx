/**
 * OnlineProductsScreen — منتجات متجري أونلاين (v55، الجولة 58).
 * ─────────────────────────────────────────────────────────────────
 * شاشة تركيز التاجر على منتجه المعروض في سيلا ماركت فقط — طلبه
 * بالنص: «يستطيع المستخدم تحديد فقط المنتجات الموجودة لديه للبيع
 * أونلاين علي المتجر دون باقي المنتجات حيث يتم التركيز عليها فقط
 * دون غيرها والتركيز علي تحديثها ومزامنتها».
 *
 *  • قائمة المنتجات المدرجة حصراً (online_listed=1) — بلا غيرها.
 *  • إدراج سريع: منتقي بحث متعدد الانتقاء من المنتجات النشطة غير
 *    المدرجة (لمسة واحدة لكل منتج ثم تأكيد جماعي).
 *  • إلغاء إدراج لمسة واحدة (مع تأكيد) — يختفي من المتجر عند
 *    المزامنة التالية (الخادم يعلّم الغائب «غير متاح»).
 *  • تعديل سريع: يفتح ملف المنتج (السعر/الخصم/المخزون/الصور).
 *  • كل تغيير يطلق مزامنة فورية (notifyCatalogChanged) — المتجر
 *    يتحدث خلال ثوانٍ لا عند الدورة الـ ١٥ دقيقة.
 */
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {
  Alert,
  FlatList,
  Image,
  Modal,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import {AppHeader, Badge, Card, SectionTitle, StatCard} from '../../components/ui';
import {Icon} from '../../components/Icon';
import {ProductRepo} from '../../database/repositories/ProductRepo';
import type {Product} from '../../core/types';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '../../navigation/RootNavigator';
import {formatMoney, relativeTime} from '../../core/format';
import {fonts, makeStyles, spacing, useThemeColors} from '../../core/theme';
import {useCatalogStore} from '../../stores/catalogStore';
import {useToastStore} from '../../stores/toastStore';
import {
  loadOnlineSettings,
  syncProducts,
} from '../../services/online/OnlineStoreService';
import type {OnlineSellingSettings} from '../../core/types';

/** السعر النهائي بعد خصم المنتج (0–95). */
function finalPrice(product: Product): number {
  const pct = Math.max(0, Math.min(95, product.discount_pct ?? 0));
  if (pct <= 0) {
    return product.retail_price;
  }
  return Math.round(product.retail_price * (1 - pct / 100) * 100) / 100;
}

/** يطلق مزامنة فورية للكتالوج — lazy require كنمط InvoiceService. */
function notifyCatalogChangedLazy(): void {
  try {
    const {notifyCatalogChanged} = require('../../services/online/OnlineStoreService') as
      typeof import('../../services/online/OnlineStoreService');
    notifyCatalogChanged();
  } catch {
    // Best effort — الدورة الدورية داخل المحرك شبكة الأمان.
  }
}

export function OnlineProductsScreen() {
  const c = useThemeColors();
  const styles = useStyles();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const toast = useToastStore(state => state.show);
  const refreshCatalog = useCatalogStore(state => state.refresh);

  const [settings, setSettings] = useState<OnlineSellingSettings>(() =>
    loadOnlineSettings(),
  );
  const [listed, setListed] = useState<Product[]>([]);
  const [candidates, setCandidates] = useState<Product[]>([]);
  const [query, setQuery] = useState('');
  const [pickerQuery, setPickerQuery] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [listedRows, allRows] = await Promise.all([
        ProductRepo.list({archival: 'active', onlineListed: true}),
        ProductRepo.list({archival: 'active'}),
      ]);
      setListed(listedRows);
      const listedIds = new Set(listedRows.map(p => p.id));
      setCandidates(allRows.filter(p => !listedIds.has(p.id)));
      setSettings(loadOnlineSettings());
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'تعذر تحميل المنتجات',
        'error',
      );
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const filtered = useMemo(() => {
    const q = query.trim();
    if (q.length === 0) {
      return listed;
    }
    return listed.filter(p => p.name.includes(q));
  }, [listed, query]);

  const pickerFiltered = useMemo(() => {
    const q = pickerQuery.trim();
    if (q.length === 0) {
      return candidates;
    }
    return candidates.filter(p => p.name.includes(q));
  }, [candidates, pickerQuery]);

  /** إدراج مجموعة المنتجات المنتقاة دفعة واحدة. */
  const applyPicked = useCallback(async () => {
    if (picked.size === 0) {
      return;
    }
    let ok = 0;
    for (const id of picked) {
      try {
        const done = await ProductRepo.setOnlineListed(id, true);
        if (done) {
          ok += 1;
        }
      } catch {
        // نكمل الباقي — الفرد الفاشل يبقى غير مدرج.
      }
    }
    setPicked(new Set());
    setPickerOpen(false);
    setPickerQuery('');
    await reload();
    await refreshCatalog();
    notifyCatalogChangedLazy();
    toast(`أُدرج ${ok} منتجاً في متجرك — يجري تحديث المتجر`, 'success');
  }, [picked, refreshCatalog, reload, toast]);

  const unlist = useCallback(
    (product: Product) => {
      Alert.alert(
        'إلغاء الإدراج',
        `سيلغى عرض «${product.name}» على سيلا ماركت عند المزامنة التالية (خلال ثوانٍ). بيانات المنتج محفوظة لديك.`,
        [
          {text: 'تراجع', style: 'cancel'},
          {
            text: 'إلغاء الإدراج',
            style: 'destructive',
            onPress: () => {
              void (async () => {
                try {
                  await ProductRepo.setOnlineListed(product.id, false);
                  await reload();
                  await refreshCatalog();
                  notifyCatalogChangedLazy();
                  toast('أُلغي إدراج المنتج — يختفي من المتجر خلال ثوانٍ', 'info');
                } catch (error) {
                  toast(
                    error instanceof Error ? error.message : 'تعذر إلغاء الإدراج',
                    'error',
                  );
                }
              })();
            },
          },
        ],
      );
    },
    [refreshCatalog, reload, toast],
  );

  const syncNow = useCallback(async () => {
    if (!settings.enabled) {
      toast('فعّل البيع أونلاين أولاً من شاشته في الإعدادات', 'error');
      return;
    }
    setSyncing(true);
    try {
      const saved = await syncProducts();
      await reload();
      toast(`تمت مزامنة ${saved} منتجاً مع المتجر`, 'success');
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'تعذرت المزامنة',
        'error',
      );
    } finally {
      setSyncing(false);
    }
  }, [reload, settings.enabled, toast]);

  const outOfStockCount = listed.filter(p => p.stock_quantity <= 0).length;

  return (
    <View style={styles.root}>
      <AppHeader
        title="منتجات متجري أونلاين"
        subtitle="ما يراه مشترو سيلا ماركت — دون باقي منتجاتك"
      />
      <ScrollView contentContainerStyle={styles.content}>
        {!settings.enabled ? (
          <Card style={styles.offCard}>
            <View style={styles.offRow}>
              <Icon name="alert" size={18} color={c.warning} />
              <Text style={styles.offText}>
                البيع أونلاين معطّل — المنتجات المدرجة لن تُنشر حتى تفعّله
              </Text>
            </View>
          </Card>
        ) : null}

        <View style={styles.statsRow}>
          <View style={styles.statCell}>
            <StatCard
              label="معروض في المتجر"
              value={String(listed.length)}
              tone="accent"
              icon="store"
            />
          </View>
          <View style={styles.statCell}>
            <StatCard
              label="نفد مخزونها"
              value={String(outOfStockCount)}
              tone={outOfStockCount > 0 ? 'danger' : 'success'}
              icon="packageMinus"
            />
          </View>
        </View>

        <Card style={{gap: spacing.sm}}>
          <View style={styles.syncRow}>
            <Icon name="refresh" size={13} color={c.textDim} />
            <Text style={styles.dim}>
              آخر مزامنة:{' '}
              {settings.lastProductsSyncAt != null
                ? relativeTime(new Date(settings.lastProductsSyncAt).toISOString())
                : 'لم تتم بعد'}
            </Text>
            <View style={{flex: 1}} />
            <TouchableOpacity
              style={[styles.syncBtn, {backgroundColor: c.accent}]}
              onPress={() => void syncNow()}
              disabled={syncing}>
              <Icon name="refresh" size={13} color="#FFFFFF" />
              <Text style={styles.syncBtnText}>
                {syncing ? 'جارٍ المزامنة…' : 'مزامنة الآن'}
              </Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.hint}>
            كل تعديل هنا أو كل عملية بيع (نقطة البيع أو طلب متجر) يُحدّث المتجر
            فوراً تلقائياً — الزر للطوارئ فقط.
          </Text>
        </Card>

        <SectionTitle
          title={`المعروض أونلاين (${listed.length})`}
          hint="هذه فقط تظهر للمشترين — تعديلها وإبقاؤها حديثة هو تركيزك"
        />
        <TextInput
          style={styles.search}
          value={query}
          onChangeText={setQuery}
          placeholder="ابحث في معروضاتك…"
          placeholderTextColor={c.textDim}
        />
        {loading ? (
          <Text style={styles.dim}>جارٍ التحميل…</Text>
        ) : filtered.length === 0 ? (
          <Card style={styles.emptyCard}>
            <Text style={styles.emptyTitle}>
              {listed.length === 0
                ? 'لا منتجات مدرجة بعد'
                : 'لا نتائج لهذا البحث'}
            </Text>
            <Text style={styles.dim}>
              {listed.length === 0
                ? 'اضغط «إدراج منتجات» بالأسفل واختر ما يظهر في متجرك'
                : 'جرّب كلمة أخرى'}
            </Text>
          </Card>
        ) : (
          filtered.map(product => {
            const discounted = (product.discount_pct ?? 0) > 0;
            const untracked = product.stock_untracked === 1;
            const out = product.stock_quantity <= 0 && !untracked;
            return (
              <Card key={product.id} style={styles.productCard}>
                <View style={styles.productRow}>
                  {product.image_uri ? (
                    <Image
                      source={{uri: `file://${product.image_uri}`}}
                      style={styles.thumb}
                    />
                  ) : (
                    <View style={[styles.thumb, styles.thumbFallback]}>
                      <Icon name="box" size={18} color={c.accent} />
                    </View>
                  )}
                  <View style={{flex: 1, gap: 3, alignItems: 'flex-start'}}>
                    <Text style={styles.productName} numberOfLines={1}>
                      {product.name}
                    </Text>
                    <View style={styles.priceRow}>
                      {discounted ? (
                        <>
                          <Text
                            style={[
                              styles.priceOld,
                              {textDecorationLine: 'line-through'},
                            ]}>
                            {formatMoney(product.retail_price)}
                          </Text>
                          <Text style={styles.priceNew}>
                            {formatMoney(finalPrice(product))}
                          </Text>
                          <Badge label={`خصم ${Math.round(product.discount_pct ?? 0)}%`} tone="danger" />
                        </>
                      ) : (
                        <Text style={styles.priceNew}>
                          {formatMoney(product.retail_price)}
                        </Text>
                      )}
                    </View>
                    <Badge
                      label={
                        untracked
                          ? 'بلا تتبع مخزون'
                          : out
                            ? 'نفد — غير قابل للطلب'
                            : `مخزون ${product.stock_quantity}`
                      }
                      tone={untracked ? 'info' : out ? 'danger' : 'success'}
                    />
                  </View>
                  <TouchableOpacity
                    style={[styles.iconBtn, {backgroundColor: c.surfaceHi}]}
                    onPress={() =>
                      navigation.navigate('ProductForm', {
                        productId: product.id,
                      })
                    }>
                    <Icon name="edit" size={15} color={c.accent} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.iconBtn, styles.unlistBtn]}
                    onPress={() => unlist(product)}>
                    <Icon name="x" size={15} color={c.danger} />
                  </TouchableOpacity>
                </View>
              </Card>
            );
          })
        )}

        <TouchableOpacity
          style={[styles.addBtn, {borderColor: c.accent}]}
          onPress={() => {
            setPicked(new Set());
            setPickerQuery('');
            setPickerOpen(true);
          }}>
          <Icon name="plus" size={16} color={c.accent} />
          <Text style={styles.addBtnText}>إدراج منتجات في المتجر</Text>
        </TouchableOpacity>
        {candidates.length === 0 && !loading ? (
          <Text style={styles.hint}>
            كل منتجاتك النشطة مدرجة بالفعل — أضف منتجات جديدة من المخزون لتدرجها.
          </Text>
        ) : null}
      </ScrollView>

      {/* ── منتقي الإدراج: بحث + انتقاء متعدد ── */}
      <Modal
        visible={pickerOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setPickerOpen(false)}>
        <View style={styles.pickerWrap}>
          <Card style={styles.pickerCard}>
            <View style={styles.pickerHead}>
              <Text style={styles.pickerTitle}>إدراج في المتجر</Text>
              <TouchableOpacity onPress={() => setPickerOpen(false)}>
                <Icon name="x" size={20} color={c.textDim} />
              </TouchableOpacity>
            </View>
            <TextInput
              style={styles.search}
              value={pickerQuery}
              onChangeText={setPickerQuery}
              placeholder="ابحث في منتجاتك غير المدرجة…"
              placeholderTextColor={c.textDim}
            />
            <FlatList
              data={pickerFiltered}
              keyExtractor={p => String(p.id)}
              style={styles.pickerList}
              ListEmptyComponent={
                <Text style={styles.dim}>
                  {candidates.length === 0
                    ? 'لا توجد منتجات نشطة غير مدرجة'
                    : 'لا نتائج لهذا البحث'}
                </Text>
              }
              renderItem={({item}) => {
                const on = picked.has(item.id);
                return (
                  <TouchableOpacity
                    style={[
                      styles.pickRow,
                      {backgroundColor: on ? c.accentSoft : c.surface},
                    ]}
                    onPress={() => {
                      setPicked(prev => {
                        const next = new Set(prev);
                        if (next.has(item.id)) {
                          next.delete(item.id);
                        } else {
                          next.add(item.id);
                        }
                        return next;
                      });
                    }}>
                    <View
                      style={[
                        styles.checkBox,
                        {
                          borderColor: on ? c.accent : c.border,
                          backgroundColor: on ? c.accent : 'transparent',
                        },
                      ]}>
                      {on ? (
                        <Icon name="check" size={13} color="#FFFFFF" strokeWidth={3} />
                      ) : null}
                    </View>
                    <View style={{flex: 1, alignItems: 'flex-start'}}>
                      <Text style={styles.productName} numberOfLines={1}>
                        {item.name}
                      </Text>
                      <Text style={styles.dim}>
                        {formatMoney(item.retail_price)}
                        {item.stock_untracked !== 1
                          ? ` · مخزون ${item.stock_quantity}`
                          : ''}
                      </Text>
                    </View>
                  </TouchableOpacity>
                );
              }}
            />
            <TouchableOpacity
              style={[
                styles.confirmBtn,
                {backgroundColor: picked.size > 0 ? c.success : c.surfaceHi},
              ]}
              onPress={() => void applyPicked()}
              disabled={picked.size === 0}>
              <Text
                style={[
                  styles.confirmText,
                  {color: picked.size > 0 ? '#FFFFFF' : c.textDim},
                ]}>
                {picked.size > 0
                  ? `إدراج ${picked.size} منتجاً في المتجر`
                  : 'انتقِ منتجات أولاً'}
              </Text>
            </TouchableOpacity>
          </Card>
        </View>
      </Modal>
    </View>
  );
}

const useStyles = makeStyles(c =>
  StyleSheet.create({
    root: {flex: 1, backgroundColor: c.bg},
    content: {
      padding: spacing.lg,
      gap: spacing.md,
      paddingBottom: 48,
    },
    offCard: {borderRightWidth: 4, borderRightColor: c.warning},
    offRow: {flexDirection: 'row', gap: 8, alignItems: 'center'},
    offText: {
      flex: 1,
      fontFamily: fonts.regular,
      fontSize: 12.5,
      color: c.text,
      lineHeight: 19,
    },
    statsRow: {flexDirection: 'row', gap: spacing.md},
    statCell: {flex: 1},
    syncRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    syncBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 7,
    },
    syncBtnText: {
      fontFamily: fonts.bold,
      fontSize: 12,
      color: '#FFFFFF',
    },
    dim: {fontFamily: fonts.regular, fontSize: 12, color: c.textDim},
    hint: {
      fontFamily: fonts.regular,
      fontSize: 11.5,
      color: c.textFaint,
      lineHeight: 18,
    },
    search: {
      backgroundColor: c.surfaceAlt,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 12,
      paddingHorizontal: 12,
      paddingVertical: 9,
      fontFamily: fonts.regular,
      fontSize: 13,
      color: c.text,
    },
    emptyCard: {alignItems: 'center', gap: 6, paddingVertical: 18},
    emptyTitle: {
      fontFamily: fonts.bold,
      fontSize: 14,
      color: c.text,
    },
    productCard: {paddingVertical: 10, paddingHorizontal: 12},
    productRow: {flexDirection: 'row', alignItems: 'center', gap: 10},
    thumb: {
      width: 44,
      height: 44,
      borderRadius: 10,
      backgroundColor: c.surfaceHi,
    },
    thumbFallback: {
      alignItems: 'center',
      justifyContent: 'center',
    },
    productName: {
      fontFamily: fonts.bold,
      fontSize: 13.5,
      color: c.text,
    },
    priceRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    priceOld: {
      fontFamily: fonts.regular,
      fontSize: 11,
      color: c.textDim,
    },
    priceNew: {
      fontFamily: fonts.black,
      fontSize: 13,
      color: c.accent,
    },
    iconBtn: {
      width: 38,
      height: 38,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
    },
    unlistBtn: {backgroundColor: c.dangerSoft},
    addBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      borderWidth: 1.5,
      borderRadius: 14,
      paddingVertical: 13,
      borderStyle: 'dashed',
    },
    addBtnText: {
      fontFamily: fonts.bold,
      fontSize: 13.5,
      color: c.accent,
    },
    pickerWrap: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.55)',
      justifyContent: 'flex-end',
    },
    pickerCard: {
      borderTopRightRadius: 22,
      borderTopLeftRadius: 22,
      maxHeight: '82%',
      paddingBottom: 6,
    },
    pickerHead: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: spacing.sm,
    },
    pickerTitle: {
      fontFamily: fonts.black,
      fontSize: 15,
      color: c.text,
    },
    pickerList: {maxHeight: 320, marginVertical: spacing.sm},
    pickRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.border,
      paddingHorizontal: 12,
      paddingVertical: 10,
      marginBottom: 6,
    },
    checkBox: {
      width: 22,
      height: 22,
      borderRadius: 7,
      borderWidth: 2,
      alignItems: 'center',
      justifyContent: 'center',
    },
    confirmBtn: {
      borderRadius: 14,
      paddingVertical: 13,
      alignItems: 'center',
    },
    confirmText: {
      fontFamily: fonts.black,
      fontSize: 13.5,
    },
  }),
);
