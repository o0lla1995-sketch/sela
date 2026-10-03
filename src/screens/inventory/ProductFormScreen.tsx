/**
 * ProductFormScreen — إضافة/تعديل منتج (design.md §9.4).
 * Three-angle vision enrollment + pricing + stock + alert threshold.
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {useNavigation, useRoute} from '@react-navigation/native';
import {AppButton, AppHeader, Badge, Field, Segmented} from '../../components/ui';
import {Icon} from '../../components/Icon';
import {ErrorBoundary} from '../../components/ErrorBoundary';
import {
  ScannerCamera,
  type ScannerCameraHandle,
} from '../../components/ScannerCamera';
import {ProductRepo} from '../../database/repositories/ProductRepo';
import {CategoryRepo} from '../../database/repositories/CategoryRepo';
import {EmbeddingRepo} from '../../database/repositories/EmbeddingRepo';
import {useCatalogStore} from '../../stores/catalogStore';
import {useToastStore} from '../../stores/toastStore';
import {VisionRecognitionService} from '../../services/vision/VisionRecognitionService';
import {colors, fonts, radius, spacing, typography} from '../../core/theme';
import {parseNumber} from '../../core/format';
import {ANGLE_LABELS, ANGLE_LABELS_AR, DEFAULT_LOW_STOCK_THRESHOLD} from '../../core/config';
import type {AngleLabel, Category} from '../../core/types';

type AngleState = {
  embedding: Float32Array | null;
  thumbnailPath: string | null;
};

export function ProductFormScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const productId: number | undefined = route.params?.productId;

  const cameraRef = useRef<ScannerCameraHandle>(null);
  const toast = useToastStore(state => state.show);
  const refreshCatalog = useCatalogStore(state => state.refresh);

  const [categories, setCategories] = useState<Category[]>([]);
  const [name, setName] = useState('');
  const [costPrice, setCostPrice] = useState('');
  const [retailPrice, setRetailPrice] = useState('');
  const [wholesalePrice, setWholesalePrice] = useState('');
  const [stock, setStock] = useState('');
  const [threshold, setThreshold] = useState('');
  const [categoryId, setCategoryId] = useState<number | 'none'>('none');
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [angles, setAngles] = useState<Record<AngleLabel, AngleState>>({
    front: {embedding: null, thumbnailPath: null},
    back: {embedding: null, thumbnailPath: null},
    side: {embedding: null, thumbnailPath: null},
  });
  const [cameraOpen, setCameraOpen] = useState(false);
  const [activeAngle, setActiveAngle] = useState<AngleLabel>('front');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(productId != null);

  // Load existing product for editing.
  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        const cats = await CategoryRepo.list();
        if (!mounted) return;
        setCategories(cats);
        if (productId != null) {
          const product = await ProductRepo.getById(productId);
          if (product != null && mounted) {
            setName(product.name);
            setCostPrice(String(product.cost_price));
            setRetailPrice(String(product.retail_price));
            setWholesalePrice(String(product.wholesale_price));
            setStock(String(product.stock_quantity));
            setThreshold(
              product.low_stock_threshold != null
                ? String(product.low_stock_threshold)
                : '',
            );
            setCategoryId(product.category_id ?? 'none');
            setImageUri(product.image_uri);
          }
        }
      } catch (error) {
        toast(
          error instanceof Error ? error.message : 'فشل تحميل بيانات المنتج',
          'error',
        );
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    };
    void load();
    return () => {
      mounted = false;
    };
  }, [productId, toast]);

  const capturedCount = useMemo(
    () =>
      (['front', 'back', 'side'] as AngleLabel[]).filter(
        angle => angles[angle].embedding != null,
      ).length,
    [angles],
  );

  const captureCurrent = useCallback(async () => {
    try {
      const result = await cameraRef.current?.captureAngle(activeAngle);
      if (result == null) {
        return;
      }
      setAngles(prev => ({
        ...prev,
        [activeAngle]: {
          embedding: result.embedding,
          thumbnailPath: result.thumbnailPath,
        },
      }));
      if (result.thumbnailPath != null && imageUri == null) {
        setImageUri(result.thumbnailPath);
      }
      toast(`تم حفظ البصمة ${ANGLE_LABELS_AR[activeAngle]}`, 'success');
      // Auto-advance to the next uncaptured angle.
      const order: AngleLabel[] = ['front', 'back', 'side'];
      const next = order.find(angle => angles[angle]?.embedding == null && angle !== activeAngle);
      if (next != null) {
        setActiveAngle(next);
      }
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'فشل التقاط البصمة',
        'error',
      );
    }
  }, [activeAngle, angles, imageUri, toast]);

  const save = useCallback(async () => {
    const trimmedName = name.trim();
    const cost = parseNumber(costPrice);
    const retail = parseNumber(retailPrice);
    const wholesale = wholesalePrice.trim()
      ? parseNumber(wholesalePrice)
      : retail;
    const stockValue = stock.trim() ? parseNumber(stock) : 0;
    const thresholdValue = threshold.trim() ? parseNumber(threshold) : null;

    if (!trimmedName) {
      toast('اسم المنتج مطلوب', 'error');
      return;
    }
    if (Number.isNaN(cost) || cost < 0) {
      toast('أدخل سعر تكلفة صالحاً', 'error');
      return;
    }
    if (Number.isNaN(retail) || retail <= 0) {
      toast('أدخل سعر مبيع صالحاً', 'error');
      return;
    }
    if (Number.isNaN(wholesale) || wholesale < 0) {
      toast('سعر الجملة غير صالح', 'error');
      return;
    }

    setBusy(true);
    try {
      const input = {
        name: trimmedName,
        cost_price: cost,
        retail_price: retail,
        wholesale_price: wholesale,
        stock_quantity: Number.isNaN(stockValue) ? 0 : Math.trunc(stockValue),
        category_id: categoryId === 'none' ? null : categoryId,
        image_uri: imageUri,
        low_stock_threshold:
          thresholdValue != null && !Number.isNaN(thresholdValue)
            ? Math.trunc(thresholdValue)
            : null,
      };

      let targetId = productId;
      if (productId != null) {
        await ProductRepo.update(productId, input);
      } else {
        targetId = await ProductRepo.create(input);
      }
      if (targetId == null || targetId < 0) {
        throw new Error('فشل حفظ المنتج');
      }

      // Save the captured embeddings (replace per-angle).
      for (const angle of ANGLE_LABELS) {
        const state = angles[angle];
        await EmbeddingRepo.deleteOne(targetId, angle);
        if (state.embedding != null) {
          await EmbeddingRepo.save(targetId, angle, state.embedding);
        }
      }

      await refreshCatalog();
      toast(productId != null ? 'تم تحديث المنتج' : 'تمت إضافة المنتج', 'success');
      navigation.goBack();
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'فشل حفظ المنتج',
        'error',
      );
    } finally {
      setBusy(false);
    }
  }, [
    name,
    costPrice,
    retailPrice,
    wholesalePrice,
    stock,
    threshold,
    categoryId,
    imageUri,
    angles,
    productId,
    refreshCatalog,
    toast,
    navigation,
  ]);

  const removeProduct = useCallback(async () => {
    if (productId == null) {
      return;
    }
    setBusy(true);
    try {
      await ProductRepo.remove(productId);
      await refreshCatalog();
      toast('تم حذف المنتج', 'success');
      navigation.goBack();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'فشل حذف المنتج', 'error');
    } finally {
      setBusy(false);
    }
  }, [productId, refreshCatalog, toast, navigation]);

  if (loading) {
    return (
      <View style={styles.screen}>
        <AppHeader title="تعديل منتج" showBack />
        <View style={styles.center}>
          <Text style={styles.loadingText}>جارٍ التحميل…</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <AppHeader
        title={productId != null ? 'تعديل منتج' : 'منتج جديد'}
        subtitle={capturedCount > 0 ? `${capturedCount}/3 بصمة محفوظة` : 'بلا بصمة بصرية بعد'}
        showBack
        right={
          <AppButton small title="حفظ" icon="save" onPress={save} loading={busy} />
        }
      />

      <KeyboardAvoidingView
        style={{flex: 1}}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled">
          {/* ── Vision enrollment ─────────────────────────────── */}
          <Text style={styles.sectionLabel}>بصمة المنتج (اختياري لكن موصى به)</Text>
          <View style={styles.anglesRow}>
            {ANGLE_LABELS.map(angle => {
              const state = angles[angle];
              const active = cameraOpen && activeAngle === angle;
              return (
                <TouchableOpacity
                  key={angle}
                  style={[
                    styles.angleCard,
                    active && {borderColor: colors.accent, borderWidth: 1.5},
                    state.embedding != null && !active
                      ? {borderColor: colors.success}
                      : null,
                  ]}
                  onPress={() => {
                    setActiveAngle(angle);
                    setCameraOpen(true);
                  }}
                  activeOpacity={0.8}>
                  {state.thumbnailPath != null ? (
                    <Image
                      source={{uri: `file://${state.thumbnailPath}`}}
                      style={styles.angleImage}
                    />
                  ) : (
                    <View style={[styles.angleImage, styles.angleFallback]}>
                      <Icon name="camera" size={22} color={colors.textDim} />
                    </View>
                  )}
                  <Text style={styles.angleLabel}>{ANGLE_LABELS_AR[angle]}</Text>
                  {state.embedding != null ? (
                    <Badge label="مسجّلة" tone="success" />
                  ) : (
                    <Badge label="فارغة" tone="neutral" />
                  )}
                </TouchableOpacity>
              );
            })}
          </View>

          {cameraOpen ? (
            <ErrorBoundary inline label="الكاميرا">
              <View style={styles.cameraSheet}>
                <ScannerCamera ref={cameraRef} mode="capture" />
                <View style={styles.captureBar}>
                  <Text style={styles.captureHint}>
                    التقط {ANGLE_LABELS_AR[activeAngle]} — عبّئ الإطار بالمنتج
                  </Text>
                  <TouchableOpacity
                    style={styles.shutterButton}
                    onPress={captureCurrent}
                    activeOpacity={0.75}>
                    <Icon name="camera" size={26} color={colors.onAccent} />
                  </TouchableOpacity>
                </View>
              </View>
            </ErrorBoundary>
          ) : (
            <AppButton
              title="فتح الكاميرا للتسجيل البصري"
              variant="secondary"
              icon="camera"
              small
              onPress={() => setCameraOpen(true)}
            />
          )}

          {/* ── Details form ──────────────────────────────────── */}
          <Text style={styles.sectionLabel}>بيانات المنتج</Text>
          <Field label="اسم المنتج *" value={name} onChangeText={setName} placeholder="مثال: شوكولاتة دوف 100غ" />
          <Field label="سعر التكلفة (₪) *" value={costPrice} onChangeText={setCostPrice} keyboardType="numeric" placeholder="0.00" />
          <Field label="سعر المفرق (₪) *" value={retailPrice} onChangeText={setRetailPrice} keyboardType="numeric" placeholder="0.00" />
          <Field
            label="سعر الجملة (₪) — اتركه فارغاً ليساوي المفرق"
            value={wholesalePrice}
            onChangeText={setWholesalePrice}
            keyboardType="numeric"
            placeholder="0.00"
          />
          <View style={{flexDirection: 'row', gap: spacing.md}}>
            <View style={{flex: 1}}>
              <Field label="الكمية" value={stock} onChangeText={setStock} keyboardType="numeric" placeholder="0" />
            </View>
            <View style={{flex: 1}}>
              <Field
                label="حد التنبيه"
                value={threshold}
                onChangeText={setThreshold}
                keyboardType="numeric"
                placeholder={String(DEFAULT_LOW_STOCK_THRESHOLD)}
              />
            </View>
          </View>

          {/* Category picker */}
          <Text style={styles.fieldLabelOuter}>التصنيف</Text>
          <View style={styles.categoryWrap}>
            <TouchableOpacity
              style={[styles.catChip, categoryId === 'none' && styles.catChipActive]}
              onPress={() => setCategoryId('none')}>
              <Text style={[styles.catChipText, categoryId === 'none' && styles.catChipTextActive]}>
                بدون تصنيف
              </Text>
            </TouchableOpacity>
            {categories.map(category => (
              <TouchableOpacity
                key={category.id}
                style={[styles.catChip, categoryId === category.id && styles.catChipActive]}
                onPress={() => setCategoryId(category.id)}>
                <Text
                  style={[
                    styles.catChipText,
                    categoryId === category.id && styles.catChipTextActive,
                  ]}>
                  {category.name}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {productId != null ? (
            <View style={{marginTop: spacing.lg}}>
              <AppButton
                title="حذف المنتج نهائياً"
                variant="danger"
                icon="trash"
                onPress={removeProduct}
                loading={busy}
              />
            </View>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: colors.bg},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  loadingText: {
    color: colors.textDim,
    fontFamily: fonts.regular,
    fontSize: typography.caption,
  },
  content: {
    padding: spacing.lg,
    gap: spacing.md,
    paddingBottom: spacing.xxl,
  },
  sectionLabel: {
    color: colors.text,
    fontFamily: fonts.black,
    fontSize: typography.heading,
    marginTop: spacing.xs,
  },
  fieldLabelOuter: {
    color: colors.textDim,
    fontFamily: fonts.bold,
    fontSize: typography.small,
  },
  anglesRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  angleCard: {
    flex: 1,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radius.md,
    padding: spacing.sm,
    alignItems: 'center',
    gap: 5,
  },
  angleImage: {
    width: '100%',
    height: 76,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceAlt,
  },
  angleFallback: {alignItems: 'center', justifyContent: 'center'},
  angleLabel: {
    color: colors.text,
    fontFamily: fonts.bold,
    fontSize: typography.small,
  },
  cameraSheet: {
    height: 330,
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: '#050508',
  },
  captureBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: colors.scrim,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  captureHint: {
    flex: 1,
    color: colors.text,
    fontFamily: fonts.bold,
    fontSize: typography.small,
    marginRight: spacing.sm,
  },
  shutterButton: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  categoryWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  catChip: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: 8,
  },
  catChipActive: {backgroundColor: colors.accent, borderColor: colors.accent},
  catChipText: {
    color: colors.textDim,
    fontFamily: fonts.bold,
    fontSize: typography.small,
  },
  catChipTextActive: {color: colors.onAccent},
});
