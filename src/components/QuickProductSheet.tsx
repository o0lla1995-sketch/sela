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
import {QuickProductService} from '../services/QuickProductService';
import {useCatalogStore} from '../stores/catalogStore';
import {useToastStore} from '../stores/toastStore';
import {
  fonts,
  makeStyles,
  spacing,
  typography,
  useThemeColors,
} from '../core/theme';

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

  const [name, setName] = useState('');
  const [sellBy, setSellBy] = useState<SellBy>('piece');
  const [piecePrice, setPiecePrice] = useState('');
  const [boxPrice, setBoxPrice] = useState('');
  const [perBox, setPerBox] = useState('20');
  const [gramPrice, setGramPrice] = useState('');
  const [stock, setStock] = useState('');
  const [barcode, setBarcode] = useState('');
  const [busy, setBusy] = useState(false);

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
      });
      await refreshCatalog();
      toast(`أُضيف «${trimmed}» — متاح في نقطة البيع فوراً`, 'success');
      reset();
      onClose();
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
            contentContainerStyle={styles.sheetContent}
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
  }),
);
