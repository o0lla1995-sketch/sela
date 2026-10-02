/**
 * ProductFormScreen — add/edit product + 3-angle vision enrollment.
 * ─────────────────────────────────────────────────────────────────
 * Save-then-enroll flow: the product row is created first so the
 * embeddings can reference a real product_id (FK). Each of the three
 * angles (front / back / side) captures:
 *   • the live embedding vector (from the frame processor)
 *   • a JPEG thumbnail stored in the app's private dir
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Image,
  Modal,
} from 'react-native';
import {
  AppButton,
  Badge,
  Card,
  Field,
  Screen,
  ScreenHeader,
  Segmented,
} from '../../components/ui';
import {CameraPanel, type CameraPanelHandle} from '../../components/CameraPanel';
import {useCatalogStore} from '../../stores/catalogStore';
import {useNavigation} from '../../core/navigation';
import {ProductRepo} from '../../database/repositories/ProductRepo';
import {EmbeddingRepo} from '../../database/repositories/EmbeddingRepo';
import {requirePlatformUtils} from '../../native/nativeBridge';
import {useToastStore} from '../../stores/toastStore';
import {colors, radius, spacing, typography} from '../../core/theme';
import {
  ANGLE_LABELS,
  ANGLE_LABELS_AR,
  CAPTURE_FRESHNESS_MS,
} from '../../core/config';
import {parseNumber} from '../../core/format';
import type {AngleLabel, Product} from '../../core/types';
import {imagesDir} from './InventoryScreen';

interface FormState {
  name: string;
  cost: string;
  retail: string;
  wholesale: string;
  stock: string;
  categoryId: number | null;
}

const EMPTY_FORM: FormState = {
  name: '',
  cost: '',
  retail: '',
  wholesale: '',
  stock: '',
  categoryId: null,
};

export function ProductFormScreen({productId}: {productId?: number}) {
  const pop = useNavigation(state => state.pop);
  const categories = useCatalogStore(state => state.categories);
  const refresh = useCatalogStore(state => state.refresh);
  const toast = useToastStore(state => state.show);

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [savedId, setSavedId] = useState<number | null>(productId ?? null);
  const [saving, setSaving] = useState(false);
  const [enrolledAngles, setEnrolledAngles] = useState<Set<string>>(new Set());
  const [captureAngle, setCaptureAngle] = useState<AngleLabel | null>(null);

  // ── Load existing product ────────────────────────────────────
  useEffect(() => {
    let mounted = true;
    const load = async () => {
      if (productId == null) return;
      try {
        const product: Product | null = await ProductRepo.getById(productId);
        if (!product || !mounted) return;
        setForm({
          name: product.name,
          cost: String(product.cost_price),
          retail: String(product.retail_price),
          wholesale: String(product.wholesale_price),
          stock: String(product.stock_quantity),
          categoryId: product.category_id,
        });
        // Check which angles already have embeddings + images.
        const embeddings = await EmbeddingRepo.listAll();
        const angles = new Set<string>(
          embeddings
            .filter(entry => entry.productId === productId)
            .map(entry => String(entry.angle)),
        );
        if (mounted) setEnrolledAngles(angles);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        toast(message, 'error');
      }
    };
    void load();
    return () => {
      mounted = false;
    };
  }, [productId, toast]);

  const update = useCallback((patch: Partial<FormState>) => {
    setForm(prev => ({...prev, ...patch}));
  }, []);

  const validate = (): string | null => {
    if (!form.name.trim()) return 'اسم المنتج مطلوب';
    const cost = parseNumber(form.cost);
    const retail = parseNumber(form.retail);
    const wholesale = parseNumber(form.wholesale);
    const stock = parseNumber(form.stock || '0');
    if (Number.isNaN(retail) || retail <= 0) return 'أدخل سعر مفرق صحيحاً أكبر من صفر';
    if (Number.isNaN(wholesale) || wholesale <= 0) return 'أدخل سعر جملة صحيحاً أكبر من صفر';
    if (Number.isNaN(cost) || cost < 0) return 'أدخل سعر تكلفة صحيحاً';
    if (Number.isNaN(stock) || stock < 0) return 'أدخل كمية صحيحة';
    return null;
  };

  const save = useCallback(async () => {
    const error = validate();
    if (error) {
      toast(error, 'error');
      return null;
    }
    setSaving(true);
    try {
      const input = {
        name: form.name.trim(),
        cost_price: parseNumber(form.cost) || 0,
        retail_price: parseNumber(form.retail),
        wholesale_price: parseNumber(form.wholesale),
        stock_quantity: Math.trunc(parseNumber(form.stock || '0') || 0),
        category_id: form.categoryId,
        image_uri: null,
      };
      let id = savedId;
      if (id == null) {
        id = await ProductRepo.create(input);
        setSavedId(id);
      } else {
        await ProductRepo.update(id, input);
      }
      await refresh();
      toast(productId == null ? 'تم حفظ المنتج — سجّل بصمته البصرية الآن' : 'تم تحديث المنتج', 'success');
      return id;
    } catch (saveError) {
      const message =
        saveError instanceof Error ? saveError.message : String(saveError);
      toast(message, 'error');
      return null;
    } finally {
      setSaving(false);
    }
  }, [form, savedId, refresh, toast, productId]);

  const startEnrollment = useCallback(
    async (angle: AngleLabel) => {
      if (savedId == null) {
        const id = await save();
        if (id == null) return;
      }
      setCaptureAngle(angle);
    },
    [savedId, save],
  );

  const enrollmentCount = enrolledAngles.size;

  return (
    <Screen>
      <ScreenHeader
        title={productId == null ? 'منتج جديد' : 'تعديل المنتج'}
        subtitle="البيانات الأساسية والأسعار"
        showBack
      />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {/* ── Basic fields ─────────────────────────────────────── */}
        <Card>
          <Field
            label="اسم المنتج *"
            value={form.name}
            onChangeText={text => update({name: text})}
            placeholder="مثال: شوكولاتة بالحليب 40غ"
          />
          <View style={styles.pricesGrid}>
            <Field
              label="سعر التكلفة (₪) *"
              value={form.cost}
              onChangeText={text => update({cost: text})}
              keyboardType="numeric"
              placeholder="0.00"
            />
            <Field
              label="سعر المفرق (₪) *"
              value={form.retail}
              onChangeText={text => update({retail: text})}
              keyboardType="numeric"
              placeholder="0.00"
            />
          </View>
          <View style={styles.pricesGrid}>
            <Field
              label="سعر الجملة (₪) *"
              value={form.wholesale}
              onChangeText={text => update({wholesale: text})}
              keyboardType="numeric"
              placeholder="0.00"
            />
            <Field
              label="الكمية الحالية *"
              value={form.stock}
              onChangeText={text => update({stock: text})}
              keyboardType="numeric"
              placeholder="0"
            />
          </View>

          <Text style={styles.sectionLabel}>الفئة</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chipsContent}>
            <TouchableOpacity
              style={[styles.chip, form.categoryId == null && styles.chipActive]}
              onPress={() => update({categoryId: null})}>
              <Text
                style={[styles.chipText, form.categoryId == null && styles.chipTextActive]}>
                بدون فئة
              </Text>
            </TouchableOpacity>
            {categories.map(category => {
              const active = form.categoryId === category.id;
              return (
                <TouchableOpacity
                  key={category.id}
                  style={[styles.chip, active && styles.chipActive]}
                  onPress={() => update({categoryId: category.id})}>
                  <Text style={[styles.chipText, active && styles.chipTextActive]}>
                    {category.name}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </Card>

        {/* ── Vision enrollment ────────────────────────────────── */}
        <Card>
          <View style={styles.enrollHeader}>
            <Text style={styles.enrollTitle}>البصمة البصرية</Text>
            <Badge
              label={`${enrollmentCount}/3 زوايا`}
              tone={enrollmentCount === 3 ? 'success' : 'warning'}
            />
          </View>
          <Text style={styles.enrollHint}>
            التقط 3 لقطات للمنتج من زوايا مختلفة (أمامية، خلفية، جانبية) ليرتفع
            تعرف الكاميرا عليه بدقة عالية.
          </Text>

          {savedId == null ? (
            <View style={styles.enrollLocked}>
              <Text style={styles.enrollLockedText}>
                احفظ المنتج أولاً لتفعيل تسجيل البصمة البصرية
              </Text>
            </View>
          ) : (
            <View style={styles.anglesRow}>
              {ANGLE_LABELS.map(angle => {
                const enrolled = enrolledAngles.has(angle);
                return (
                  <TouchableOpacity
                    key={angle}
                    style={[
                      styles.angleCard,
                      enrolled && styles.angleCardDone,
                    ]}
                    onPress={() => startEnrollment(angle)}>
                    <AngleThumb productId={savedId} angle={angle} />
                    <Text
                      style={[
                        styles.angleLabel,
                        enrolled && styles.angleLabelDone,
                      ]}>
                      {ANGLE_LABELS_AR[angle]}
                    </Text>
                    <Text style={styles.angleAction}>
                      {enrolled ? '✓ مسجّلة — أعد التقاطها' : 'التقاط'}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}
        </Card>

        {/* ── Save ─────────────────────────────────────────────── */}
        <AppButton
          title={productId == null ? 'حفظ المنتج' : 'حفظ التعديلات'}
          onPress={() => {
            void save();
          }}
          loading={saving}
        />
        <AppButton
          title="حفظ والعودة للمخزون"
          variant="ghost"
          onPress={async () => {
            const id = await save();
            if (id != null) pop();
          }}
          disabled={saving}
        />
      </ScrollView>

      {/* ── Capture modal ─────────────────────────────────────── */}
      <Modal
        visible={captureAngle != null}
        animationType="slide"
        onRequestClose={() => setCaptureAngle(null)}>
        {captureAngle != null && savedId != null ? (
          <CaptureModalContent
            angle={captureAngle}
            productId={savedId}
            onClose={() => setCaptureAngle(null)}
            onSaved={async () => {
              setEnrolledAngles(prev => new Set([...prev, captureAngle]));
              await refresh();
              setCaptureAngle(null);
              toast(`تم تسجيل بصمة الزاوية ${ANGLE_LABELS_AR[captureAngle]}`, 'success');
            }}
          />
        ) : null}
      </Modal>
    </Screen>
  );
}

// ────────────────────────────────────────────────────────────────
// Capture modal content
// ────────────────────────────────────────────────────────────────

function CaptureModalContent({
  angle,
  productId,
  onClose,
  onSaved,
}: {
  angle: AngleLabel;
  productId: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const cameraRef = useRef<CameraPanelHandle>(null);
  const toast = useToastStore(state => state.show);
  const [busy, setBusy] = useState(false);

  const capture = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const embedding = cameraRef.current?.captureEmbedding();
      if (!embedding || embedding.ageMs > CAPTURE_FRESHNESS_MS) {
        toast('وجّه الكاميرا نحو المنتج وانتظر لحظة ثم التقط', 'error');
        setBusy(false);
        return;
      }

      // 1. Persist the embedding vector.
      await EmbeddingRepo.save(productId, angle, embedding.vector);

      // 2. Save a JPEG thumbnail next to it (best effort).
      try {
        const photoPath = await cameraRef.current?.takePhoto();
        if (photoPath) {
          const dir = await imagesDir();
          await requirePlatformUtils().copyFile(
            photoPath,
            `${dir}/product_${productId}_${angle}.jpg`,
          );
        }
      } catch {
        // Thumbnail is optional; the embedding is what matters.
      }

      onSaved();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast(message, 'error');
    } finally {
      setBusy(false);
    }
  }, [busy, productId, angle, onSaved, toast]);

  return (
    <View style={styles.captureRoot}>
      <View style={styles.captureHeader}>
        <TouchableOpacity onPress={onClose}>
          <Text style={styles.captureClose}>إلغاء</Text>
        </TouchableOpacity>
        <Text style={styles.captureTitle}>
          بصمة {ANGLE_LABELS_AR[angle]}
        </Text>
        <View style={{width: 48}} />
      </View>

      <View style={styles.captureCamera}>
        <CameraPanel ref={cameraRef} mode="capture" enabled />
      </View>

      <View style={styles.captureFooter}>
        <Text style={styles.captureHint}>
          ضع المنتج داخل الإطار واضغط التقاط — حاول تغيير الزاوية قليلاً بين
          اللقطات لتحسين الدقة
        </Text>
        <AppButton title={`📸 التقاط بصمة ${ANGLE_LABELS_AR[angle]}`} onPress={capture} loading={busy} />
      </View>
    </View>
  );
}

function AngleThumb({productId, angle}: {productId: number; angle: string}) {
  const [path, setPath] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const check = async () => {
      try {
        const dir = await imagesDir();
        const candidate = `${dir}/product_${productId}_${angle}.jpg`;
        const exists = await requirePlatformUtils().fileExists(candidate);
        if (mounted) setPath(exists ? candidate : null);
      } catch {
        if (mounted) setPath(null);
      }
    };
    void check();
    return () => {
      mounted = false;
    };
  }, [productId, angle]);

  if (!path) {
    return (
      <View style={styles.thumbEmpty}>
        <Text style={styles.thumbEmptyIcon}>📷</Text>
      </View>
    );
  }
  return <Image source={{uri: `file://${path}`}} style={styles.thumbImage} />;
}

const styles = StyleSheet.create({
  content: {padding: spacing.md, gap: spacing.md, paddingBottom: spacing.xxl},
  pricesGrid: {flexDirection: 'row', gap: spacing.md},
  sectionLabel: {
    color: colors.textDim,
    fontSize: typography.caption,
    fontWeight: '700',
    marginBottom: 8,
    marginTop: spacing.xs,
  },
  chipsContent: {gap: 8, paddingBottom: spacing.xs},
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
  enrollHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  enrollTitle: {
    color: colors.text,
    fontSize: typography.body,
    fontWeight: '900',
  },
  enrollHint: {
    color: colors.textDim,
    fontSize: typography.small,
    lineHeight: 18,
    marginBottom: spacing.md,
  },
  enrollLocked: {
    backgroundColor: colors.warningSoft,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.warning,
  },
  enrollLockedText: {
    color: colors.warning,
    textAlign: 'center',
    fontWeight: '700',
    fontSize: typography.caption,
  },
  anglesRow: {flexDirection: 'row', gap: spacing.sm},
  angleCard: {
    flex: 1,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    padding: spacing.sm,
    gap: 6,
  },
  angleCardDone: {borderColor: colors.success},
  thumbEmpty: {
    width: 72,
    height: 72,
    borderRadius: radius.md,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbEmptyIcon: {fontSize: 26},
  thumbImage: {width: 72, height: 72, borderRadius: radius.md},
  angleLabel: {color: colors.text, fontWeight: '800', fontSize: typography.caption},
  angleLabelDone: {color: colors.success},
  angleAction: {color: colors.accent, fontSize: typography.small, fontWeight: '700'},
  captureRoot: {flex: 1, backgroundColor: colors.bg},
  captureHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
    paddingBottom: spacing.md,
  },
  captureClose: {color: colors.textDim, fontWeight: '700', fontSize: typography.body, width: 48},
  captureTitle: {color: colors.text, fontWeight: '900', fontSize: typography.heading},
  captureCamera: {flex: 1},
  captureFooter: {padding: spacing.lg, gap: spacing.md},
  captureHint: {
    color: colors.textDim,
    fontSize: typography.small,
    textAlign: 'center',
    lineHeight: 18,
  },
});
