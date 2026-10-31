/**
 * QuickProductSheet — v58 (الجولة 62): الإضافة السريعة لمود «نقطة
 * البيع».
 * ─────────────────────────────────────────────────────────────────
 * نموذج واحد مصغّر بلا أي صلاحيات ولا تفاصيل: اسم المنتج + طريقة
 * البيع + السعر + (عدد الحبات بالعلبة) + مخزون اختياري. حالة
 * الاستخدام الأولى التي طلبها التاجر: السجائر — تُباع بالحبة
 * المفردة أو بالعلبة (فيها عدد من السجائر) أو بالغرام.
 *
 * ما يبنيه خلف الكواليس (بالمنظومة القائمة نفسها — لا مسارات
 * جديدة):
 *  • بالحبة/بالعلبة: منتج قطعي أساسه الحبة (retail = سعر الحبة)
 *    بوحدتي «حبة» (=1) و«علبة» (= عدد الحبات) بأسعار كل منهما؛
 *    البيع الافتراضي بالحبة مباشرة من نقطة البيع، والعلبة تتاح
 *    من منتقي الوحدة في سطر السلة.
 *  • بالغرام: منتج وزني (سعر الكيلو مشتق = سعر الغرام × 1000)
 *    بوحدة «غرام» (=0.001 كغ) — لوحة الوزن تعرضها شريحة سريعة.
 *  • المخزون: إن تُرك فارغاً → منتج بلا تتبع (البيع لا يُحجب
 *    أبداً — الأسرع للبسطة)؛ وإن أُدخل → يُحوَّل لوحدة الأساس
 *    (علبة × عدد الحبات، أو غرام ÷ 1000).
 */
import React, {useMemo, useState} from 'react';
import {
  I18nManager,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {AppButton, Badge} from './ui';
import {Icon} from './Icon';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {
  QuickProductService,
  type QuickExtraUnit,
} from '../services/QuickProductService';
import {useCatalogStore} from '../stores/catalogStore';
import {useToastStore} from '../stores/toastStore';
import {
  fonts,
  makeStyles,
  spacing,
  typography,
  useThemeColors,
} from '../core/theme';

/** v70: صف وحدة إضافية كحقول نص خام — التحويل لحظة الحفظ فقط. */
interface ExtraRow {
  name: string;
  perBase: string;
  price: string;
}

const EMPTY_EXTRA: ExtraRow = {name: '', perBase: '', price: ''};

type SellBy = 'piece' | 'box' | 'gram';

const SELL_BY_OPTIONS: {key: SellBy; label: string; hint: string}[] = [
  {key: 'piece', label: 'بالحبة', hint: 'سعر الحبة — والعلبة تُشتق'},
  {key: 'box', label: 'بالعلبة', hint: 'سعر العلبة — والحبة تُشتق'},
  {key: 'gram', label: 'بالغرام', hint: 'منتج وزني بالغرام'},
];

function parsePositiveNumber(text: string): number | null {
  const value = Number(text.replace(',', '.').trim());
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value;
}

export function QuickProductSheet({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const c = useThemeColors();
  const styles = useStyles();
  const toast = useToastStore(state => state.show);
  const refreshCatalog = useCatalogStore(state => state.refresh);
  // v70 (الجولة 82 #٥): نافذة Modal تُرسم فوق كل شيء (حتى شريط
  // التبويبات) — على أجهزة أندرويد 15/16 المفروض بها الحافة
  // للحافة تُرسم خلف شريط التنقل، فأزرار الحفظ تحتاج هامش
  // الأمان السفلي كي تبقى فوق أزرار النظام.
  const insets = useSafeAreaInsets();

  const [name, setName] = useState('');
  const [sellBy, setSellBy] = useState<SellBy>('piece');
  const [piecePrice, setPiecePrice] = useState('');
  const [boxPrice, setBoxPrice] = useState('');
  const [perBox, setPerBox] = useState('20');
  const [gramPrice, setGramPrice] = useState('');
  const [stock, setStock] = useState('');
  const [barcode, setBarcode] = useState('');
  const [busy, setBusy] = useState(false);
  /** v70 (الجولة 82 #٤): وحدات إضافية بسعر مميّز — قابلة للطي
   *  حتى لا تزاحم المسار السريع الأساسي (الاسم/السعر/الإضافة). */
  const [extrasOpen, setExtrasOpen] = useState(false);
  const [extraRows, setExtraRows] = useState<ExtraRow[]>([]);

  const perBoxCount = useMemo(() => {
    const parsed = parsePositiveNumber(perBox);
    return parsed != null ? Math.round(parsed) : 0;
  }, [perBox]);

  const derivedBoxPrice = useMemo(() => {
    const price = parsePositiveNumber(piecePrice);
    if (price == null || perBoxCount < 2) {
      return null;
    }
    return Math.round(price * perBoxCount * 100) / 100;
  }, [piecePrice, perBoxCount]);

  const derivedPiecePrice = useMemo(() => {
    const price = parsePositiveNumber(boxPrice);
    if (price == null || perBoxCount < 2) {
      return null;
    }
    return Math.round((price / perBoxCount) * 100) / 100;
  }, [boxPrice, perBoxCount]);

  const reset = () => {
    setName('');
    setSellBy('piece');
    setPiecePrice('');
    setBoxPrice('');
    setPerBox('20');
    setGramPrice('');
    setStock('');
    setBarcode('');
    setExtrasOpen(false);
    setExtraRows([]);
  };

  /** v70: تحويل صفوف الوحدات الإضافية لحظة الحفظ — الصف الفارغ
   *  تماماً (لا اسم ولا معامل ولا سعر) يُتجاهل بصمت؛ أي صف ناقص
   *  يوقف الحفظ برسالة تحدد الحقل الناقص بالاسم. */
  const parseExtraRows = (): QuickExtraUnit[] => {
    const out: QuickExtraUnit[] = [];
    for (const row of extraRows) {
      const trimmedName = row.name.trim();
      const perBaseText = row.perBase.replace(',', '.').trim();
      const priceText = row.price.replace(',', '.').trim();
      if (
        trimmedName.length === 0 &&
        perBaseText.length === 0 &&
        priceText.length === 0
      ) {
        continue;
      }
      if (trimmedName.length === 0) {
        throw new Error('أدخل اسم الوحدة الإضافية (مثال: كرتونة)');
      }
      const perBase = Number(perBaseText);
      if (!Number.isFinite(perBase) || perBase <= 0) {
        throw new Error(
          `«${trimmedName}»: أدخل ${
            sellBy === 'gram' ? 'الوزن بالكيلو' : 'عدد الحبات'
          } — رقماً أكبر من صفر`,
        );
      }
      const price = Number(priceText);
      if (!Number.isFinite(price) || price <= 0) {
        throw new Error(`«${trimmedName}»: أدخل سعرها الخاص — رقماً أكبر من صفر`);
      }
      out.push({name: trimmedName, perBase, price});
    }
    return out;
  };

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast('اسم المنتج مطلوب', 'error');
      return;
    }
    let finalPiecePrice: number;
    let finalBoxPrice: number | null = null;
    if (sellBy === 'piece') {
      const price = parsePositiveNumber(piecePrice);
      if (price == null) {
        toast('أدخل سعر الحبة', 'error');
        return;
      }
      finalPiecePrice = price;
      finalBoxPrice =
        parsePositiveNumber(boxPrice) ??
        (derivedBoxPrice != null ? derivedBoxPrice : null);
    } else if (sellBy === 'box') {
      const price = parsePositiveNumber(boxPrice);
      if (price == null) {
        toast('أدخل سعر العلبة', 'error');
        return;
      }
      if (perBoxCount < 2) {
        toast('عدد الحبات في العلبة غير صالح', 'error');
        return;
      }
      finalBoxPrice = price;
      finalPiecePrice = Math.round((price / perBoxCount) * 100) / 100;
    } else {
      const price = parsePositiveNumber(gramPrice);
      if (price == null) {
        toast('أدخل سعر الغرام', 'error');
        return;
      }
      finalPiecePrice = price; // سعر «الوحدة الصغرى» = الغرام
    }

    setBusy(true);
    try {
      const extras = parseExtraRows();
      const stockInput = parsePositiveNumber(stock);
      await QuickProductService.createQuickProduct({
        name: trimmed,
        sellBy,
        price:
          sellBy === 'piece'
            ? parsePositiveNumber(piecePrice) ?? 0
            : sellBy === 'box'
            ? parsePositiveNumber(boxPrice) ?? 0
            : parsePositiveNumber(gramPrice) ?? 0,
        perBox: perBoxCount >= 2 ? perBoxCount : 20,
        boxPriceOverride:
          sellBy === 'piece' ? parsePositiveNumber(boxPrice) : null,
        stockInput,
        barcode: barcode.trim() || null,
        extraUnits: extras,
      });
      await refreshCatalog();
      toast(
        `أُضيف «${trimmed}» — متاح في نقطة البيع فوراً${
          extras.length > 0 ? ` بـ${extras.length + 1} وحدات بيع` : ''
        }`,
        'success',
      );
      reset();
      onClose();
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'فشل إضافة المنتج',
        'error',
        5000,
      );
    } finally {
      setBusy(false);
    }
  };

  if (!visible) {
    return null;
  }

  return (
    <Modal
      transparent
      visible
      animationType="slide"
      onRequestClose={onClose}>
    <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => undefined}>
          <ScrollView
            contentContainerStyle={[
              styles.sheetContent,
              // v70: هامش الأمان السفلي ديناميكياً (خارج كاش makeStyles
              // الذي يُبنى مرة لكل سمة) — Modal يُرسم فوق شريط التنقل
              // على أجهزة الحافة-للحافة.
              {paddingBottom: spacing.xxl + insets.bottom},
            ]}
            keyboardShouldPersistTaps="handled">
            <Text style={styles.title}>إضافة منتج سريع</Text>
            <Text style={styles.subtitle}>
              اسم وسعر وطريقة البيع — لا شيء آخر مطلوب
            </Text>

            <TextInput
              style={styles.nameInput}
              value={name}
              onChangeText={setName}
              placeholder="اسم المنتج — مثال: مارلبورو"
              placeholderTextColor={c.textFaint}
              textAlign={I18nManager.isRTL ? 'right' : 'left'}
            />

            <View style={styles.sellByRow}>
              {SELL_BY_OPTIONS.map(option => (
                <Pressable
                  key={option.key}
                  style={[
                    styles.sellByChip,
                    sellBy === option.key && styles.sellByChipActive,
                  ]}
                  onPress={() => setSellBy(option.key)}>
                  <Text
                    style={[
                      styles.sellByText,
                      sellBy === option.key && styles.sellByTextActive,
                    ]}>
                    {option.label}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Text style={styles.sellByHint}>
              {SELL_BY_OPTIONS.find(o => o.key === sellBy)?.hint}
            </Text>

            {sellBy !== 'gram' ? (
              <>
                <QuickInput
                  label="عدد الحبات في العلبة"
                  value={perBox}
                  onChangeText={setPerBox}
                  numeric
                  placeholder="20"
                />
                {sellBy === 'piece' ? (
                  <>
                    <QuickInput
                      label="سعر الحبة (₪)"
                      value={piecePrice}
                      onChangeText={setPiecePrice}
                      numeric
                      placeholder="مثال: 1"
                    />
                    {derivedBoxPrice != null ? (
                      <View style={styles.derivedRow}>
                        <Badge
                          label={`سعر العلبة المشتق: ${derivedBoxPrice.toFixed(2)} ₪`}
                          tone="accent"
                        />
                      </View>
                    ) : null}
                    <QuickInput
                      label="سعر العلبة (₪) — اختياري لتجاوز المشتق"
                      value={boxPrice}
                      onChangeText={setBoxPrice}
                      numeric
                      placeholder={derivedBoxPrice?.toFixed(2) ?? 'مثال: 18'}
                    />
                  </>
                ) : (
                  <>
                    <QuickInput
                      label="سعر العلبة (₪)"
                      value={boxPrice}
                      onChangeText={setBoxPrice}
                      numeric
                      placeholder="مثال: 18"
                    />
                    {derivedPiecePrice != null ? (
                      <View style={styles.derivedRow}>
                        <Badge
                          label={`سعر الحبة المشتق: ${derivedPiecePrice.toFixed(2)} ₪`}
                          tone="accent"
                        />
                      </View>
                    ) : null}
                  </>
                )}
              </>
            ) : (
              <QuickInput
                label="سعر الغرام (₪)"
                value={gramPrice}
                onChangeText={setGramPrice}
                numeric
                placeholder="مثال: 0.06"
              />
            )}

            <QuickInput
              label={`المخزون الابتدائي (${sellBy === 'gram' ? 'بالغرام' : 'بالعلبة'}) — اتركه فارغاً لبلا تتبع`}
              value={stock}
              onChangeText={setStock}
              numeric
              placeholder="اختياري"
            />
            <QuickInput
              label="باركود (اختياري)"
              value={barcode}
              onChangeText={setBarcode}
              placeholder="امسحه أو اكتبه"
            />

            {/* v70 (الجولة 82 #٤): وحدات إضافية بسعر مميّز — طلب
                التاجر: «إضافة وحدات للمنتج مثلا للبيع بأكثر من قطعة
                بسعر مميز». قسم مطوي افتراضياً حتى يبقى المسار
                السريع كما هو. */}
            <Pressable
              style={styles.extrasToggle}
              onPress={() => setExtrasOpen(prev => !prev)}>
              <View style={styles.extrasToggleRow}>
                <Icon
                  name={extrasOpen ? 'chevronDown' : 'plus'}
                  size={16}
                  color={c.accent}
                />
                <Text style={styles.extrasToggleText}>
                  وحدات إضافية بسعر مميّز (اختياري)
                </Text>
              </View>
              {extraRows.length > 0 ? (
                <Badge
                  label={`${extraRows.length}`}
                  tone="accent"
                />
              ) : null}
            </Pressable>
            {extrasOpen ? (
              <View style={styles.extrasWrap}>
                <Text style={styles.extrasHint}>
                  {sellBy === 'gram'
                    ? 'كل وحدة بوزنها بالكيلو وسعرها الخاص (مثال: ربع كيلو = 0.25)'
                    : 'كل وحدة بعدد حباتها وسعرها الخاص (مثال: كرتونة = 200 حبة)'}
                  — تظهر في منتقي الوحدة في سلة البيع فوراً.
                </Text>
                {extraRows.map((row, index) => (
                  <View key={index} style={styles.extraRow}>
                    <View style={styles.extraFieldName}>
                      <Text style={styles.extraLabel}>الاسم</Text>
                      <TextInput
                        style={styles.extraInput}
                        value={row.name}
                        onChangeText={text =>
                          setExtraRows(prev =>
                            prev.map((r, i) =>
                              i === index ? {...r, name: text} : r,
                            ),
                          )
                        }
                        placeholder="كرتونة"
                        placeholderTextColor={c.textFaint}
                        textAlign={I18nManager.isRTL ? 'right' : 'left'}
                      />
                    </View>
                    <View style={styles.extraFieldCount}>
                      <Text style={styles.extraLabel}>
                        {sellBy === 'gram' ? 'كغ' : 'حبة/وحدة'}
                      </Text>
                      <TextInput
                        style={styles.extraInput}
                        value={row.perBase}
                        onChangeText={text =>
                          setExtraRows(prev =>
                            prev.map((r, i) =>
                              i === index
                                ? {...r, perBase: text.replace(',', '.')}
                                : r,
                            ),
                          )
                        }
                        keyboardType="decimal-pad"
                        placeholder={sellBy === 'gram' ? '0.25' : '200'}
                        placeholderTextColor={c.textFaint}
                        textAlign="center"
                      />
                    </View>
                    <View style={styles.extraFieldPrice}>
                      <Text style={styles.extraLabel}>السعر ₪</Text>
                      <TextInput
                        style={styles.extraInput}
                        value={row.price}
                        onChangeText={text =>
                          setExtraRows(prev =>
                            prev.map((r, i) =>
                              i === index
                                ? {...r, price: text.replace(',', '.')}
                                : r,
                            ),
                          )
                        }
                        keyboardType="decimal-pad"
                        placeholder="150"
                        placeholderTextColor={c.textFaint}
                        textAlign="center"
                      />
                    </View>
                    <Pressable
                      style={styles.extraRemove}
                      onPress={() =>
                        setExtraRows(prev => prev.filter((_, i) => i !== index))
                      }
                      hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                      <Icon name="trash" size={16} color={c.danger} />
                    </Pressable>
                  </View>
                ))}
                <Pressable
                  style={styles.extrasAdd}
                  onPress={() =>
                    setExtraRows(prev => [...prev, {...EMPTY_EXTRA}])
                  }>
                  <Icon name="plus" size={15} color={c.accent} />
                  <Text style={styles.extrasAddText}>إضافة وحدة أخرى</Text>
                </Pressable>
              </View>
            ) : null}

            <View style={styles.actions}>
              <AppButton
                title="إلغاء"
                variant="ghost"
                small
                style={{flex: 1}}
                onPress={onClose}
              />
              <AppButton
                title="إضافة المنتج"
                variant="primary"
                small
                style={{flex: 2}}
                loading={busy}
                disabled={busy}
                onPress={() => void save()}
              />
            </View>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function QuickInput({
  label,
  value,
  onChangeText,
  placeholder,
  numeric = false,
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  numeric?: boolean;
}) {
  const c = useThemeColors();
  const styles = useStyles();
  return (
    <View>
      <Text style={styles.inputLabel}>{label}</Text>
      <View style={styles.inputWrap}>
        <TextInput
          style={styles.input}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={c.textFaint}
          keyboardType={numeric ? 'decimal-pad' : 'default'}
          textAlign={I18nManager.isRTL ? 'right' : 'left'}
        />
      </View>
    </View>
  );
}

const useStyles = makeStyles(c =>
  StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.55)',
      justifyContent: 'flex-end',
    },
    sheet: {
      backgroundColor: c.surface,
      borderTopLeftRadius: 22,
      borderTopRightRadius: 22,
      maxHeight: '88%',
    },
    sheetContent: {
      padding: spacing.lg,
      gap: spacing.md,
      paddingBottom: spacing.xxl,
    },
    title: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: typography.heading,
      textAlign: 'right',
    },
    subtitle: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      textAlign: 'right',
      marginTop: -spacing.xs,
    },
    nameInput: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.body,
      backgroundColor: c.surfaceHi,
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
    sellByRow: {
      flexDirection: 'row-reverse',
      gap: spacing.sm,
    },
    sellByChip: {
      flex: 1,
      backgroundColor: c.surfaceHi,
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: 10,
      paddingVertical: 10,
      alignItems: 'center',
    },
    sellByChipActive: {
      backgroundColor: c.accentSoft,
      borderColor: c.accent,
    },
    sellByText: {
      color: c.textDim,
      fontFamily: fonts.medium,
      fontSize: typography.small,
    },
    sellByTextActive: {
      color: c.accent,
      fontFamily: fonts.bold,
    },
    sellByHint: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      textAlign: 'right',
      marginTop: -spacing.sm,
    },
    derivedRow: {
      flexDirection: 'row-reverse',
      marginTop: -spacing.xs,
    },
    inputLabel: {
      color: c.textDim,
      fontFamily: fonts.medium,
      fontSize: typography.small,
      textAlign: 'right',
      marginBottom: 4,
    },
    inputWrap: {
      backgroundColor: c.surfaceHi,
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: 10,
      paddingHorizontal: 12,
    },
    input: {
      color: c.text,
      fontFamily: fonts.regular,
      fontSize: typography.body,
      paddingVertical: 10,
    },
    actions: {
      flexDirection: 'row-reverse',
      gap: spacing.sm,
      marginTop: spacing.sm,
    },
    /* v70 (الجولة 82 #٤): قسم الوحدات الإضافية. */
    extrasToggle: {
      flexDirection: 'row-reverse',
      alignItems: 'center',
      justifyContent: 'space-between',
      backgroundColor: c.surfaceHi,
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    extrasToggleRow: {
      flexDirection: 'row-reverse',
      alignItems: 'center',
      gap: 7,
    },
    extrasToggleText: {
      color: c.accent,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    extrasWrap: {
      gap: spacing.sm,
    },
    extrasHint: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: 11,
      lineHeight: 16,
      textAlign: 'right',
    },
    extraRow: {
      flexDirection: 'row-reverse',
      alignItems: 'flex-end',
      gap: 6,
    },
    extraFieldName: {flex: 3},
    extraFieldCount: {flex: 1.4},
    extraFieldPrice: {flex: 1.2},
    extraLabel: {
      color: c.textDim,
      fontFamily: fonts.medium,
      fontSize: 10.5,
      marginBottom: 3,
      textAlign: 'right',
    },
    extraInput: {
      color: c.text,
      fontFamily: fonts.regular,
      fontSize: 13,
      backgroundColor: c.surfaceHi,
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: 8,
      paddingHorizontal: 8,
      paddingVertical: 8,
    },
    extraRemove: {
      paddingVertical: 10,
      paddingHorizontal: 4,
    },
    extrasAdd: {
      flexDirection: 'row-reverse',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      borderWidth: 1,
      borderColor: c.accent,
      borderStyle: 'dashed',
      borderRadius: 10,
      paddingVertical: 9,
    },
    extrasAddText: {
      color: c.accent,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
  }),
);
