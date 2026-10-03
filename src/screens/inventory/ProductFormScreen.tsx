/**
 * ProductFormScreen — إضافة/تعديل منتج (v3).
 * ─────────────────────────────────────────────────────────────────
 * Three-angle vision enrollment + pricing + stock + alert threshold
 * + BARCODE (with scan-to-fill) + UNITS editor (كرتونة × 24 …) with
 * per-unit price overrides that make wholesale-by-carton trivial.
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  Image,
  KeyboardAvoidingView,
  LayoutAnimation,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {useNavigation, useRoute} from '@react-navigation/native';
import {
  AppButton,
  AppHeader,
  Badge,
  Card,
  Field,
  SectionTitle,
  Segmented,
} from '../../components/ui';
import {Icon} from '../../components/Icon';
import {ErrorBoundary} from '../../components/ErrorBoundary';
import {
  ScannerCamera,
  type ScannerCameraHandle,
} from '../../components/ScannerCamera';
import {ProductRepo} from '../../database/repositories/ProductRepo';
import {CategoryRepo} from '../../database/repositories/CategoryRepo';
import {EmbeddingRepo} from '../../database/repositories/EmbeddingRepo';
import {UnitRepo} from '../../database/repositories/UnitRepo';
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
import {parseNumber} from '../../core/format';
import {
  ANGLE_LABELS,
  ANGLE_LABELS_AR,
  BASE_UNIT_NAME,
  DEFAULT_LOW_STOCK_THRESHOLD,
} from '../../core/config';
import type {AngleLabel, Category, ProductUnit, Unit} from '../../core/types';

type AngleState = {
  embedding: Float32Array | null;
  thumbnailPath: string | null;
};

interface UnitRowDraft {
  unit_id: number;
  conversion: string;
  retail: string;
  wholesale: string;
  barcode: string;
}

function unitRowToDraft(row: ProductUnit): UnitRowDraft {
  return {
    unit_id: row.unit_id,
    conversion: String(row.conversion),
    retail: row.retail_price != null ? String(row.retail_price) : '',
    wholesale: row.wholesale_price != null ? String(row.wholesale_price) : '',
    barcode: row.barcode ?? '',
  };
}

export function ProductFormScreen() {
  const c = useThemeColors();
  const styles = useStyles();
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const productId: number | undefined = route.params?.productId;
  const presetBarcode: string | undefined = route.params?.barcode;

  const cameraRef = useRef<ScannerCameraHandle>(null);
  const toast = useToastStore(state => state.show);
  const refreshCatalog = useCatalogStore(state => state.refresh);

  const [categories, setCategories] = useState<Category[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [name, setName] = useState('');
  const [barcode, setBarcode] = useState(presetBarcode ?? '');
  const [costPrice, setCostPrice] = useState('');
  const [retailPrice, setRetailPrice] = useState('');
  const [wholesalePrice, setWholesalePrice] = useState('');
  const [stock, setStock] = useState('');
  const [threshold, setThreshold] = useState('');
  const [categoryId, setCategoryId] = useState<number | 'none'>('none');
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [unitRows, setUnitRows] = useState<UnitRowDraft[]>([]);
  const [angles, setAngles] = useState<Record<AngleLabel, AngleState>>({
    front: {embedding: null, thumbnailPath: null},
    back: {embedding: null, thumbnailPath: null},
    side: {embedding: null, thumbnailPath: null},
  });
  const [cameraOpen, setCameraOpen] = useState(false);
  const [barcodeScannerOpen, setBarcodeScannerOpen] = useState(false);
  const [activeAngle, setActiveAngle] = useState<AngleLabel>('front');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(productId != null);

  // Load existing product for editing.
  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        const [cats, unitList] = await Promise.all([
          CategoryRepo.list(),
          UnitRepo.list(),
        ]);
        if (!mounted) return;
        setCategories(cats);
        setUnits(unitList);
        if (productId != null) {
          const product = await ProductRepo.getById(productId);
          const productUnits = await UnitRepo.listForProduct(productId);
          if (product != null && mounted) {
            setName(product.name);
            setBarcode(product.barcode ?? '');
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
            setUnitRows(productUnits.map(unitRowToDraft));
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
      const next = order.find(
        angle => angles[angle]?.embedding == null && angle !== activeAngle,
      );
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

  // ── Unit rows ─────────────────────────────────────────────────
  const addUnitRow = useCallback(() => {
    const used = new Set(unitRows.map(row => row.unit_id));
    const free = units.find(unit => !used.has(unit.id));
    if (free == null) {
      toast('كل الوحدات مستخدمة — أضف وحدات جديدة من شاشة الوحدات', 'info');
      return;
    }
    setUnitRows(prev => [
      ...prev,
      {
        unit_id: free.id,
        conversion: '',
        retail: '',
        wholesale: '',
        barcode: '',
      },
    ]);
  }, [unitRows, units, toast]);

  const updateUnitRow = useCallback(
    (index: number, patch: Partial<UnitRowDraft>) => {
      setUnitRows(prev =>
        prev.map((row, i) => (i === index ? {...row, ...patch} : row)),
      );
    },
    [],
  );

  const removeUnitRow = useCallback((index: number) => {
    setUnitRows(prev => prev.filter((_, i) => i !== index));
  }, []);

  const unitNameById = useMemo(() => {
    const map = new Map<number, string>();
    units.forEach(unit => map.set(unit.id, unit.name));
    return map;
  }, [units]);

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

    // Validate unit rows.
    const cleanedUnits: {
      unit_id: number;
      conversion: number;
      barcode?: string | null;
      retail_price?: number | null;
      wholesale_price?: number | null;
    }[] = [];
    for (const [index, row] of unitRows.entries()) {
      const conversion = parseNumber(row.conversion);
      if (Number.isNaN(conversion) || conversion <= 0) {
        toast(
          `معامل تحويل الوحدة ${index + 1} يجب أن يكون رقماً أكبر من صفر`,
          'error',
        );
        return;
      }
      const unitRetail = row.retail.trim() ? parseNumber(row.retail) : null;
      const unitWholesale = row.wholesale.trim()
        ? parseNumber(row.wholesale)
        : null;
      if (
        (unitRetail != null && (Number.isNaN(unitRetail) || unitRetail < 0)) ||
        (unitWholesale != null &&
          (Number.isNaN(unitWholesale) || unitWholesale < 0))
      ) {
        toast(`أسعار الوحدة ${index + 1} غير صالحة`, 'error');
        return;
      }
      cleanedUnits.push({
        unit_id: row.unit_id,
        conversion,
        barcode: row.barcode.trim() || null,
        retail_price: unitRetail,
        wholesale_price: unitWholesale,
      });
    }

    setBusy(true);
    try {
      const input = {
        name: trimmedName,
        cost_price: cost,
        retail_price: retail,
        wholesale_price: wholesale,
        stock_quantity: Number.isNaN(stockValue) ? 0 : stockValue,
        category_id: categoryId === 'none' ? null : categoryId,
        image_uri: imageUri,
        low_stock_threshold:
          thresholdValue != null && !Number.isNaN(thresholdValue)
            ? Math.trunc(thresholdValue)
            : null,
        barcode: barcode.trim() || null,
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

      await UnitRepo.replaceForProduct(targetId, cleanedUnits);

      // Save the captured embeddings (replace per-angle).
      for (const angle of ANGLE_LABELS) {
        const state = angles[angle];
        await EmbeddingRepo.deleteOne(targetId, angle);
        if (state.embedding != null) {
          await EmbeddingRepo.save(targetId, angle, state.embedding);
        }
      }

      await refreshCatalog();
      toast(
        productId != null ? 'تم تحديث المنتج' : 'تمت إضافة المنتج',
        'success',
      );
      navigation.goBack();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'فشل حفظ المنتج', 'error');
    } finally {
      setBusy(false);
    }
  }, [
    name,
    barcode,
    costPrice,
    retailPrice,
    wholesalePrice,
    stock,
    threshold,
    categoryId,
    imageUri,
    unitRows,
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
          <Text style={styles.muted}>جارٍ التحميل…</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <AppHeader
        title={productId != null ? 'تعديل منتج' : 'منتج جديد'}
        subtitle={
          capturedCount > 0
            ? `${capturedCount}/3 بصمة محفوظة`
            : 'بلا بصمة بصرية بعد'
        }
        showBack
        right={
          <AppButton
            small
            title="حفظ"
            icon="save"
            onPress={save}
            loading={busy}
          />
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
          <SectionTitle
            title="بصمة المنتج"
            hint="اختياري لكن موصى به — يتيح البيع بالتعرف البصري"
          />
          <View style={styles.anglesRow}>
            {ANGLE_LABELS.map(angle => {
              const state = angles[angle];
              const active = cameraOpen && activeAngle === angle;
              return (
                <TouchableOpacity
                  key={angle}
                  style={[
                    styles.angleCard,
                    active ? {borderColor: c.accent, borderWidth: 1.5} : null,
                    state.embedding != null && !active
                      ? {borderColor: c.success}
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
                      <Icon name="camera" size={22} color={c.textDim} />
                    </View>
                  )}
                  <Text style={styles.angleLabel}>
                    {ANGLE_LABELS_AR[angle]}
                  </Text>
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
                    <Icon name="camera" size={26} color={c.onAccent} />
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
          <SectionTitle title="بيانات المنتج" />
          <Field
            label="اسم المنتج *"
            value={name}
            onChangeText={setName}
            placeholder="مثال: شوكولاتة دوف 100غ"
          />
          <View style={styles.barcodeRow}>
            <View style={{flex: 1}}>
              <Field
                label="الباركود (اختياري)"
                value={barcode}
                onChangeText={setBarcode}
                keyboardType="numeric"
                placeholder="امسحه أو اكتبه"
              />
            </View>
            <TouchableOpacity
              style={styles.barcodeScanBtn}
              onPress={() => {
                LayoutAnimation.configureNext(
                  LayoutAnimation.Presets.easeInEaseOut,
                );
                setBarcodeScannerOpen(value => !value);
              }}
              activeOpacity={0.8}>
              <Icon
                name={barcodeScannerOpen ? 'x' : 'barcode'}
                size={20}
                color={barcodeScannerOpen ? c.danger : c.onAccent}
              />
            </TouchableOpacity>
          </View>
          {barcodeScannerOpen ? (
            <ErrorBoundary inline label="ماسح الباركود">
              <View style={styles.barcodeSheet}>
                <ScannerCamera
                  mode="scan"
                  barcodeEnabled
                  height={210}
                  onBarcode={code => {
                    setBarcode(code);
                    setBarcodeScannerOpen(false);
                    toast(`تم قراءة الباركود: ${code}`, 'success');
                  }}
                />
              </View>
            </ErrorBoundary>
          ) : null}
          <Field
            label="سعر التكلفة للقطعة (₪) *"
            value={costPrice}
            onChangeText={setCostPrice}
            keyboardType="numeric"
            placeholder="0.00"
          />
          <View style={styles.priceRow}>
            <View style={{flex: 1}}>
              <Field
                label="سعر المفرق (₪) *"
                value={retailPrice}
                onChangeText={setRetailPrice}
                keyboardType="numeric"
                placeholder="0.00"
              />
            </View>
            <View style={{flex: 1}}>
              <Field
                label="سعر الجملة (₪)"
                value={wholesalePrice}
                onChangeText={setWholesalePrice}
                keyboardType="numeric"
                placeholder="= المفرق"
              />
            </View>
          </View>
          <View style={styles.priceRow}>
            <View style={{flex: 1}}>
              <Field
                label={`الكمية (${BASE_UNIT_NAME})`}
                value={stock}
                onChangeText={setStock}
                keyboardType="numeric"
                placeholder="0"
              />
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

          {/* ── Category picker ──────────────────────────────── */}
          <View style={styles.categoryHeader}>
            <Text style={styles.fieldLabelOuter}>التصنيف</Text>
            <TouchableOpacity
              onPress={() => navigation.navigate('ManageCategories' as never)}>
              <Text style={styles.manageLink}>إدارة التصنيفات</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.categoryWrap}>
            <TouchableOpacity
              style={[
                styles.catChip,
                categoryId === 'none'
                  ? {backgroundColor: c.accent, borderColor: c.accent}
                  : null,
              ]}
              onPress={() => setCategoryId('none')}>
              <Text
                style={[
                  styles.catChipText,
                  {color: categoryId === 'none' ? c.onAccent : c.textDim},
                ]}>
                بدون تصنيف
              </Text>
            </TouchableOpacity>
            {categories.map(category => (
              <TouchableOpacity
                key={category.id}
                style={[
                  styles.catChip,
                  categoryId === category.id
                    ? {backgroundColor: c.accent, borderColor: c.accent}
                    : null,
                ]}
                onPress={() => setCategoryId(category.id)}>
                <Text
                  style={[
                    styles.catChipText,
                    {
                      color:
                        categoryId === category.id ? c.onAccent : c.textDim,
                    },
                  ]}>
                  {category.name}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* ── Units editor ─────────────────────────────────── */}
          <SectionTitle
            title="وحدات البيع"
            hint="مثال: كرتونة = 24 قطعة — تُخصم من المخزون تلقائياً وتسهّل الجملة"
            action={
              <TouchableOpacity
                onPress={() => navigation.navigate('ManageUnits' as never)}>
                <Text style={styles.manageLink}>إدارة الوحدات</Text>
              </TouchableOpacity>
            }
          />
          {unitRows.length === 0 ? (
            <View style={styles.unitsEmpty}>
              <Icon name="scale" size={20} color={c.textFaint} />
              <Text style={styles.unitsEmptyText}>
                لا وحدات — يُباع المنتج بالقطعة. أضف وحدة (كرتونة، كيلو…) لبيع
                الكميات المعبأة.
              </Text>
            </View>
          ) : (
            <View style={{gap: spacing.md}}>
              {unitRows.map((row, index) => (
                <Card key={row.unit_id} style={styles.unitCard}>
                  <View style={styles.unitHeader}>
                    <Text style={styles.unitTitle}>
                      {unitNameById.get(row.unit_id) ?? 'وحدة'}
                    </Text>
                    <TouchableOpacity
                      onPress={() => removeUnitRow(index)}
                      hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                      <Icon name="trash" size={16} color={c.danger} />
                    </TouchableOpacity>
                  </View>
                  <View style={styles.unitFieldsRow}>
                    <View style={{flex: 1}}>
                      <Field
                        label="تحتوي (قطعة)"
                        value={row.conversion}
                        onChangeText={text =>
                          updateUnitRow(index, {conversion: text})
                        }
                        keyboardType="numeric"
                        placeholder="24"
                      />
                    </View>
                    <View style={{flex: 1}}>
                      <Field
                        label="مفرق الوحدة (₪)"
                        value={row.retail}
                        onChangeText={text =>
                          updateUnitRow(index, {retail: text})
                        }
                        keyboardType="numeric"
                        placeholder="تلقائي"
                      />
                    </View>
                  </View>
                  <View style={styles.unitFieldsRow}>
                    <View style={{flex: 1}}>
                      <Field
                        label="جملة الوحدة (₪)"
                        value={row.wholesale}
                        onChangeText={text =>
                          updateUnitRow(index, {wholesale: text})
                        }
                        keyboardType="numeric"
                        placeholder="تلقائي"
                      />
                    </View>
                    <View style={{flex: 1}}>
                      <Field
                        label="باركود الوحدة"
                        value={row.barcode}
                        onChangeText={text =>
                          updateUnitRow(index, {barcode: text})
                        }
                        keyboardType="numeric"
                        placeholder="اختياري"
                      />
                    </View>
                  </View>
                  <Segmented
                    compact
                    value={row.unit_id}
                    onChange={(value: number) =>
                      updateUnitRow(index, {unit_id: value})
                    }
                    options={units
                      .filter(
                        unit =>
                          unit.id === row.unit_id ||
                          !unitRows.some(r => r.unit_id === unit.id),
                      )
                      .map(unit => ({value: unit.id, label: unit.name}))}
                  />
                </Card>
              ))}
            </View>
          )}
          <AppButton
            title="إضافة وحدة للمنتج"
            variant="secondary"
            icon="plus"
            small
            onPress={addUnitRow}
          />

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

const useStyles = makeStyles(c =>
  StyleSheet.create({
    screen: {flex: 1, backgroundColor: c.bg},
    center: {flex: 1, alignItems: 'center', justifyContent: 'center'},
    muted: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.caption,
    },
    content: {
      padding: spacing.lg,
      gap: spacing.md,
      paddingBottom: spacing.xxl,
    },
    anglesRow: {
      flexDirection: 'row',
      gap: spacing.sm,
    },
    angleCard: {
      flex: 1,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: radius.md,
      padding: spacing.sm,
      alignItems: 'center',
      gap: 5,
    },
    angleImage: {
      width: '100%',
      height: 76,
      borderRadius: radius.sm,
      backgroundColor: c.surfaceAlt,
    },
    angleFallback: {alignItems: 'center', justifyContent: 'center'},
    angleLabel: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    cameraSheet: {
      height: 330,
      borderRadius: radius.lg,
      overflow: 'hidden',
      backgroundColor: '#0B0B10',
    },
    captureBar: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      backgroundColor: c.scrim,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
    },
    captureHint: {
      flex: 1,
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.small,
      marginRight: spacing.sm,
    },
    shutterButton: {
      width: 52,
      height: 52,
      borderRadius: 26,
      backgroundColor: c.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    barcodeRow: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: spacing.sm,
    },
    barcodeScanBtn: {
      width: 50,
      height: 50,
      borderRadius: radius.sm,
      backgroundColor: c.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    barcodeSheet: {
      height: 220,
      borderRadius: radius.lg,
      overflow: 'hidden',
      backgroundColor: '#0B0B10',
    },
    priceRow: {
      flexDirection: 'row',
      gap: spacing.md,
    },
    fieldLabelOuter: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    manageLink: {
      color: c.accent,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    categoryHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    categoryWrap: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.sm,
    },
    catChip: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.lg,
      paddingVertical: 8,
    },
    catChipText: {
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    unitsEmpty: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.md,
      padding: spacing.md,
    },
    unitsEmptyText: {
      flex: 1,
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      lineHeight: 18,
    },
    unitCard: {gap: spacing.sm, padding: spacing.md},
    unitHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    unitTitle: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: typography.caption,
    },
    unitFieldsRow: {
      flexDirection: 'row',
      gap: spacing.sm,
    },
  }),
);
