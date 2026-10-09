/**
 * sela UI kit v3 — components per design.md §8.
 * ─────────────────────────────────────────────────────────────────
 * AppHeader / AppButton / Card / Badge / Segmented / EmptyState /
 * StatCard / Field / Switch row / Stepper / Toaster.
 *
 * v3: fully theme-aware (light/dark). Every component reads colors
 * through useThemeColors() and styles are built with makeStyles(),
 * so switching الوضع النهاري/الليلي re-skins the app instantly.
 * The header brand mark is now the sela basket (not a star), and
 * the bell is a clean filled notification glyph.
 */
import React, {forwardRef, useImperativeHandle, useRef} from 'react';
import {
  ActivityIndicator,
  I18nManager,
  KeyboardTypeOptions,
  Pressable,
  ReturnKeyTypeOptions,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  ViewStyle,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useNavigation} from '@react-navigation/native';
import {Icon, IconChip, type IconName} from './Icon';
import {useToastStore, type ToastKind} from '../stores/toastStore';
import {useNotificationsStore} from '../stores/notificationsStore';
import {
  fonts,
  makeStyles,
  radius,
  shadows,
  spacing,
  statusBarHeight,
  typography,
  useThemeColors,
} from '../core/theme';
import {formatMoney} from '../core/format';

// ────────────────────────────────────────────────────────────────
// Screen scaffolding
// ────────────────────────────────────────────────────────────────

export function Screen({children}: {children: React.ReactNode}) {
  const c = useThemeColors();
  return <View style={{flex: 1, backgroundColor: c.bg}}>{children}</View>;
}

export function AppHeader({
  title,
  subtitle,
  showBack = false,
  showBell = true,
  right,
}: {
  title: string;
  subtitle?: string;
  showBack?: boolean;
  showBell?: boolean;
  right?: React.ReactNode;
}) {
  const navigation = useNavigation();
  const c = useThemeColors();
  const styles = useHeaderStyles();
  const unreadCount = useNotificationsStore(state => state.unreadCount);
  const canGoBack = navigation.canGoBack();

  return (
    <View style={styles.headerRoot}>
      <View style={styles.headerRow}>
        {showBack && canGoBack ? (
          <TouchableOpacity
            style={styles.headerIconBtn}
            onPress={() => navigation.goBack()}
            hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}>
            <Icon
              name={I18nManager.isRTL ? 'chevronRight' : 'chevronLeft'}
              size={22}
              color={c.text}
            />
          </TouchableOpacity>
        ) : (
          <View style={styles.headerIconBtn} pointerEvents="none">
            <Icon name="basket" size={21} color={c.accent} />
          </View>
        )}

        <View style={styles.headerTextWrap}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {title}
          </Text>
          {subtitle ? (
            <Text style={styles.headerSubtitle} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>

        <View style={styles.headerActions}>
          {right}
          {showBell ? (
            <TouchableOpacity
              style={[
                styles.headerIconBtn,
                unreadCount > 0 ? {borderColor: c.accent} : null,
              ]}
              onPress={() => navigation.navigate('Notifications' as never)}
              hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}>
              <Icon
                name="bell"
                size={19}
                color={unreadCount > 0 ? c.accent : c.textDim}
              />
              {unreadCount > 0 ? (
                <View style={styles.bellBadge}>
                  <Text style={styles.bellBadgeText}>
                    {unreadCount > 99 ? '99+' : unreadCount}
                  </Text>
                </View>
              ) : null}
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const useHeaderStyles = makeStyles(c =>
  StyleSheet.create({
    headerRoot: {
      backgroundColor: c.bg,
      borderBottomWidth: 1,
      borderBottomColor: c.borderSoft,
      paddingTop: statusBarHeight,
    },
    headerRow: {
      height: 58,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.md,
      gap: spacing.sm,
    },
    headerIconBtn: {
      width: 42,
      height: 42,
      borderRadius: 21,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    headerTextWrap: {
      flex: 1,
      alignItems: 'center',
    },
    headerTitle: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: typography.heading,
    },
    headerSubtitle: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      marginTop: -2,
    },
    headerActions: {
      flexDirection: 'row',
      gap: spacing.sm,
      alignItems: 'center',
    },
    bellBadge: {
      position: 'absolute',
      top: -3,
      left: -3,
      minWidth: 17,
      height: 17,
      borderRadius: 9,
      backgroundColor: c.accent,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 4,
      borderWidth: 2,
      borderColor: c.bg,
    },
    bellBadgeText: {
      color: c.onAccent,
      fontSize: 9,
      fontFamily: fonts.bold,
    },
  }),
);

// ────────────────────────────────────────────────────────────────
// Buttons
// ────────────────────────────────────────────────────────────────

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';

export function AppButton({
  title,
  onPress,
  variant = 'primary',
  disabled = false,
  loading = false,
  small = false,
  icon,
  style,
}: {
  title: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  small?: boolean;
  icon?: IconName;
  style?: ViewStyle;
}) {
  const c = useThemeColors();
  const styles = useButtonStyles();

  const bg =
    variant === 'primary'
      ? styles.btnPrimary
      : variant === 'secondary'
      ? styles.btnSecondary
      : variant === 'danger'
      ? styles.btnDanger
      : variant === 'success'
      ? styles.btnSuccess
      : styles.btnGhost;

  const textColor =
    variant === 'primary' || variant === 'success'
      ? c.onAccent
      : variant === 'secondary'
      ? c.text
      : variant === 'danger'
      ? c.danger
      : c.accent;

  return (
    <TouchableOpacity
      style={[
        styles.button,
        small && styles.buttonSmall,
        bg,
        (disabled || loading) && styles.buttonDisabled,
        style,
      ]}
      onPress={onPress}
      disabled={disabled || loading}
      activeOpacity={0.8}>
      {loading ? (
        <ActivityIndicator
          size="small"
          color={
            variant === 'ghost' ||
            variant === 'danger' ||
            variant === 'secondary'
              ? c.accent
              : c.onAccent
          }
        />
      ) : (
        <>
          {icon != null ? (
            <Icon name={icon} size={small ? 15 : 18} color={textColor} />
          ) : null}
          <Text
            style={[
              styles.buttonText,
              small && styles.buttonSmallText,
              {color: textColor},
            ]}>
            {title}
          </Text>
        </>
      )}
    </TouchableOpacity>
  );
}

const useButtonStyles = makeStyles(c =>
  StyleSheet.create({
    button: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      minHeight: 50,
      borderRadius: radius.md,
      paddingHorizontal: spacing.lg,
    },
    buttonSmall: {
      minHeight: 38,
      paddingHorizontal: spacing.md,
      borderRadius: radius.sm,
    },
    btnPrimary: {backgroundColor: c.accent},
    btnSecondary: {
      backgroundColor: c.surfaceHi,
      borderWidth: 1,
      borderColor: c.border,
    },
    btnDanger: {
      backgroundColor: c.dangerSoft,
      borderWidth: 1,
      borderColor: c.danger,
    },
    btnSuccess: {backgroundColor: c.success},
    btnGhost: {
      backgroundColor: c.accentSofter,
      borderWidth: 1,
      borderColor: c.accentDark,
    },
    buttonDisabled: {opacity: 0.45},
    buttonText: {
      fontFamily: fonts.bold,
      fontSize: typography.body,
    },
    buttonSmallText: {
      fontSize: typography.caption,
    },
    iconButton: {
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
    },
  }),
);

export function IconButton({
  name,
  onPress,
  size = 40,
  color,
  bg,
  disabled,
}: {
  name: IconName;
  onPress: () => void;
  size?: number;
  color?: string;
  bg?: string;
  disabled?: boolean;
}) {
  const c = useThemeColors();
  const styles = useButtonStyles();
  return (
    <TouchableOpacity
      style={[
        styles.iconButton,
        {width: size, height: size, borderRadius: size / 2},
        bg != null ? {backgroundColor: bg} : null,
        disabled && styles.buttonDisabled,
      ]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.8}>
      <Icon
        name={name}
        size={Math.round(size * 0.48)}
        color={color ?? c.text}
      />
    </TouchableOpacity>
  );
}

// ────────────────────────────────────────────────────────────────
// Surfaces
// ────────────────────────────────────────────────────────────────

export function Card({
  children,
  style,
  onPress,
}: {
  children: React.ReactNode;
  style?: ViewStyle;
  onPress?: () => void;
}) {
  const styles = useSurfaceStyles();
  if (onPress != null) {
    return (
      <Pressable style={[styles.card, style]} onPress={onPress}>
        {children}
      </Pressable>
    );
  }
  return <View style={[styles.card, style]}>{children}</View>;
}

export function SectionTitle({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  const styles = useSurfaceStyles();
  return (
    <View style={styles.sectionRow}>
      <View style={{flex: 1}}>
        <Text style={styles.sectionTitle}>{title}</Text>
        {hint ? <Text style={styles.sectionHint}>{hint}</Text> : null}
      </View>
      {action}
    </View>
  );
}

const useSurfaceStyles = makeStyles(c =>
  StyleSheet.create({
    card: {
      backgroundColor: c.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: c.borderSoft,
      padding: spacing.lg,
    },
    sectionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      marginBottom: spacing.sm,
    },
    sectionTitle: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: typography.heading,
    },
    sectionHint: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      marginTop: 1,
    },
  }),
);

// ────────────────────────────────────────────────────────────────
// Data display
// ────────────────────────────────────────────────────────────────

export function MoneyText({
  value,
  big = false,
  color,
}: {
  value: number;
  big?: boolean;
  color?: string;
}) {
  const c = useThemeColors();
  const styles = useDataStyles();
  return (
    <Text
      style={[
        big ? styles.moneyBig : styles.money,
        color != null ? {color} : big ? {color: c.accent} : null,
      ]}
      numberOfLines={1}
      /* v9 (round-13 #2): a long total (e.g. 1,234.50 ₪) used to
         overflow the cart panel at display size — the big variant
         now shrinks to fit its line instead of breaking layout. */
      adjustsFontSizeToFit={big}
      minimumFontScale={big ? 0.6 : undefined}
      maxFontSizeMultiplier={big ? 1 : undefined}>
      {formatMoney(value)}
    </Text>
  );
}

type StatTone = 'accent' | 'success' | 'danger' | 'neutral' | 'info';

export function StatCard({
  label,
  value,
  tone = 'neutral',
  icon,
}: {
  label: string;
  value: string;
  tone?: StatTone;
  icon?: IconName;
}) {
  const c = useThemeColors();
  const styles = useDataStyles();
  const valueColor =
    tone === 'accent'
      ? c.accent
      : tone === 'success'
      ? c.success
      : tone === 'danger'
      ? c.danger
      : tone === 'info'
      ? c.info
      : c.text;
  const soft =
    tone === 'accent'
      ? c.accentSoft
      : tone === 'success'
      ? c.successSoft
      : tone === 'danger'
      ? c.dangerSoft
      : tone === 'info'
      ? c.infoSoft
      : c.surfaceAlt;
  return (
    <View style={styles.statCard}>
      {icon != null ? (
        <View style={[styles.statIconWrap, {backgroundColor: soft}]}>
          <Icon name={icon} size={17} color={valueColor} />
        </View>
      ) : null}
      <Text
        style={[styles.statValue, {color: valueColor}]}
        numberOfLines={1}
        adjustsFontSizeToFit>
        {value}
      </Text>
      <Text style={styles.statLabel} numberOfLines={2}>
        {label}
      </Text>
    </View>
  );
}

export function Badge({
  label,
  tone = 'neutral',
}: {
  label: string;
  tone?: 'success' | 'danger' | 'warning' | 'accent' | 'neutral' | 'info';
}) {
  const c = useThemeColors();
  const styles = useDataStyles();
  const bg =
    tone === 'success'
      ? c.successSoft
      : tone === 'danger'
      ? c.dangerSoft
      : tone === 'warning'
      ? c.warningSoft
      : tone === 'accent'
      ? c.accentSoft
      : tone === 'info'
      ? c.infoSoft
      : c.surfaceHi;
  const textColor =
    tone === 'success'
      ? c.success
      : tone === 'danger'
      ? c.danger
      : tone === 'warning'
      ? c.warning
      : tone === 'accent'
      ? c.accent
      : tone === 'info'
      ? c.info
      : c.textDim;
  return (
    <View style={[styles.badge, {backgroundColor: bg}]}>
      <Text style={[styles.badgeText, {color: textColor}]}>{label}</Text>
    </View>
  );
}

export function EmptyState({
  icon = 'inbox',
  title,
  subtitle,
  action,
}: {
  icon?: IconName;
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  const c = useThemeColors();
  const styles = useDataStyles();
  return (
    <View style={styles.empty}>
      <IconChip
        name={icon}
        chipSize={64}
        size={28}
        bg={c.accentSoft}
        color={c.accent}
      />
      <Text style={styles.emptyTitle}>{title}</Text>
      {subtitle ? <Text style={styles.emptyText}>{subtitle}</Text> : null}
      {action ? <View style={{marginTop: spacing.md}}>{action}</View> : null}
    </View>
  );
}

const useDataStyles = makeStyles(c =>
  StyleSheet.create({
    money: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.body,
      fontVariant: ['tabular-nums'],
    },
    moneyBig: {
      color: c.accent,
      fontFamily: fonts.black,
      // v9 (round-13 #2): display 34 → 23 — the POS total used to
      // exceed the cart panel's width on long amounts; 23 + the
      // shrink-to-fit in MoneyText keeps it inside the frame at
      // any amount length while staying the dominant number.
      fontSize: 23,
      fontVariant: ['tabular-nums'],
    },
    statCard: {
      flex: 1,
      backgroundColor: c.surface,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.borderSoft,
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.md,
      gap: 3,
      minHeight: 104,
      justifyContent: 'center',
    },
    statIconWrap: {
      width: 32,
      height: 32,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: spacing.xs,
    },
    statValue: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: 20,
      fontVariant: ['tabular-nums'],
    },
    statLabel: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      lineHeight: 15,
    },
    badge: {
      borderRadius: radius.pill,
      paddingHorizontal: 10,
      paddingVertical: 3,
      alignSelf: 'flex-start',
    },
    badgeText: {
      fontFamily: fonts.bold,
      fontSize: typography.micro,
    },
    empty: {
      alignItems: 'center',
      paddingVertical: spacing.xxl,
      paddingHorizontal: spacing.xl,
      gap: spacing.xs,
    },
    emptyTitle: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.body,
      marginTop: spacing.sm,
    },
    emptyText: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.caption,
      textAlign: 'center',
      lineHeight: 21,
    },
  }),
);

// ────────────────────────────────────────────────────────────────
// Inputs
// ────────────────────────────────────────────────────────────────

/**
 * Text field with keyboard NEXT/DONE navigation.
 *
 * Round-8 feedback: "لا تستخدم الانتقال بين الحقول من خلال لوحة
 * المفاتيح بشكل سلس" — the field now forwards a ref exposing
 * focus()/blur(), accepts returnKeyType/onSubmitEditing and keeps
 * the keyboard up between submits (blurOnSubmit={false}), so forms
 * chain like native Android apps: زر "التالي" على لوحة المفاتيح
 * يقفز للحقـل التالي مباشرة.
 */
export interface FieldHandle {
  focus: () => void;
  blur: () => void;
  isFocused: () => boolean;
}

interface FieldProps {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  keyboardType?: KeyboardTypeOptions;
  suffix?: string;
  multiline?: boolean;
  numberOfLines?: number;
  onFocus?: () => void;
  /** Keyboard action button ("next" jumps to the next field). */
  returnKeyType?: ReturnKeyTypeOptions;
  /** Fired when the keyboard's action button is pressed. */
  onSubmitEditing?: () => void;
}

export const Field = forwardRef<FieldHandle, FieldProps>(function Field(
  {
    label,
    value,
    onChangeText,
    placeholder,
    keyboardType,
    suffix,
    multiline = false,
    numberOfLines = 1,
    onFocus,
    returnKeyType,
    onSubmitEditing,
  },
  ref,
) {
  const c = useThemeColors();
  const styles = useInputStyles();
  const inputRef = useRef<TextInput>(null);

  useImperativeHandle(ref, () => ({
    focus: () => inputRef.current?.focus(),
    blur: () => inputRef.current?.blur(),
    isFocused: () => inputRef.current?.isFocused() ?? false,
  }));

  return (
    <View style={styles.fieldWrap}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.fieldRow}>
        <TextInput
          ref={inputRef}
          style={[styles.fieldInput, multiline && styles.fieldMultiline]}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={c.textFaint}
          keyboardType={keyboardType}
          multiline={multiline}
          numberOfLines={numberOfLines}
          textAlign={I18nManager.isRTL ? 'right' : 'left'}
          textAlignVertical={multiline ? 'top' : 'center'}
          onFocus={onFocus}
          returnKeyType={returnKeyType ?? (multiline ? 'done' : 'next')}
          onSubmitEditing={onSubmitEditing}
          blurOnSubmit={multiline ? true : false}
        />
        {suffix ? <Text style={styles.fieldSuffix}>{suffix}</Text> : null}
      </View>
    </View>
  );
});

export function SearchBar({
  value,
  onChangeText,
  placeholder,
}: {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
}) {
  const c = useThemeColors();
  const styles = useInputStyles();
  return (
    <View style={styles.searchWrap}>
      <Icon name="search" size={18} color={c.textFaint} />
      <TextInput
        style={styles.searchInput}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder ?? 'بحث…'}
        placeholderTextColor={c.textFaint}
        textAlign={I18nManager.isRTL ? 'right' : 'left'}
      />
      {value.length > 0 ? (
        <TouchableOpacity
          onPress={() => onChangeText('')}
          hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
          <Icon name="x" size={16} color={c.textDim} />
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

export function Segmented<T extends string | number>({
  value,
  onChange,
  options,
  compact = false,
  dense = false,
}: {
  value: T;
  onChange: (value: T) => void;
  options: {value: T; label: string}[];
  compact?: boolean;
  /** v42 (الجولة 50 #1): القياس المضغوط — أصغر وأضيق لصف
   *  جملة/مفرق في نقطة البيع حتى يتسع صف التحكم كاملاً مع زر
   *  شكل العرض بجانبه (طلب التاجر: ضغط الصف وملاءمة حجم
   *  المبدّل). */
  dense?: boolean;
}) {
  const c = useThemeColors();
  const styles = useInputStyles();
  return (
    <View
      style={[
        styles.segmented,
        compact && styles.segmentedCompact,
        dense && styles.segmentedDense,
      ]}>
      {options.map(option => {
        const active = option.value === value;
        return (
          <TouchableOpacity
            key={String(option.value)}
            style={[
              styles.segItem,
              dense && styles.segItemDense,
              active && {backgroundColor: c.accent},
            ]}
            onPress={() => onChange(option.value)}
            activeOpacity={0.8}>
            <Text
              style={[
                styles.segText,
                compact && !dense ? styles.segTextCompact : null,
                dense ? styles.segTextDense : null,
                {color: active ? c.onAccent : c.textDim},
              ]}
              numberOfLines={1}>
              {option.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const useInputStyles = makeStyles(c =>
  StyleSheet.create({
    fieldWrap: {
      gap: 6,
    },
    fieldLabel: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    fieldRow: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: c.surfaceAlt,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.sm,
      paddingHorizontal: spacing.md,
    },
    fieldInput: {
      flex: 1,
      color: c.text,
      fontFamily: fonts.medium,
      fontSize: typography.body,
      paddingVertical: 12,
    },
    fieldMultiline: {
      minHeight: 84,
    },
    fieldSuffix: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.caption,
    },
    searchWrap: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      height: 48,
    },
    searchInput: {
      flex: 1,
      color: c.text,
      fontFamily: fonts.medium,
      fontSize: typography.caption,
      paddingVertical: 0,
    },
    segmented: {
      flexDirection: 'row',
      backgroundColor: c.surface,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
      padding: 3,
    },
    segmentedCompact: {
      borderRadius: radius.sm,
    },
    // v42 (الجولة 50 #1): القياس المضغوط — حاوية أرق وقطع بحشو
    // أفقي محسوب؛ ارتفاع الكل ≈ ٣٣dp بدل ≈ ٤٠dp.
    segmentedDense: {
      padding: 2,
      borderRadius: radius.sm,
    },
    segItemDense: {
      flex: 0,
      paddingVertical: 7,
      paddingHorizontal: 12,
    },
    segTextDense: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: 11.5,
    },
    segItem: {
      flex: 1,
      alignItems: 'center',
      paddingVertical: 10,
      borderRadius: radius.sm,
    },
    segText: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.caption,
    },
    segTextCompact: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
  }),
);

// ────────────────────────────────────────────────────────────────
// Switch row / Stepper
// ────────────────────────────────────────────────────────────────

export function SwitchRow({
  label,
  hint,
  value,
  onValueChange,
  icon,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  icon?: IconName;
}) {
  const c = useThemeColors();
  const styles = useControlStyles();
  return (
    <View style={styles.switchRow}>
      {icon != null ? (
        <View style={styles.switchIconWrap}>
          <Icon name={icon} size={17} color={c.accent} />
        </View>
      ) : null}
      <View style={{flex: 1}}>
        <Text style={styles.switchLabel}>{label}</Text>
        {hint ? <Text style={styles.switchHint}>{hint}</Text> : null}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{false: c.surfaceHi, true: c.accent}}
        thumbColor="#FFFFFF"
      />
    </View>
  );
}

export function Stepper({
  value,
  onIncrement,
  onDecrement,
  min = 0,
  decrementDanger = false,
  compact = false,
}: {
  value: number;
  onIncrement: () => void;
  onDecrement: () => void;
  min?: number;
  decrementDanger?: boolean;
  /** Round-9: cart rows — 26px buttons so nothing overflows. */
  compact?: boolean;
}) {
  const c = useThemeColors();
  const styles = useControlStyles();
  const btnStyle = compact
    ? [styles.stepperBtn, styles.stepperBtnCompact]
    : [styles.stepperBtn];
  return (
    <View style={[styles.stepper, compact && {gap: 4}]}>
      <TouchableOpacity
        style={[...btnStyle, styles.stepperBtnInc]}
        onPress={onIncrement}
        activeOpacity={0.8}>
        <Icon name="plus" size={compact ? 14 : 17} color={c.onAccent} />
      </TouchableOpacity>
      <Text
        style={[styles.stepperValue, compact && styles.stepperValueCompact]}>
        {value}
      </Text>
      <TouchableOpacity
        style={[
          ...btnStyle,
          decrementDanger && value <= min + 1
            ? {backgroundColor: c.dangerSoft, borderColor: c.danger}
            : styles.stepperBtnDec,
        ]}
        onPress={onDecrement}
        activeOpacity={0.8}>
        <Icon
          name="minus"
          size={compact ? 14 : 17}
          color={decrementDanger && value <= min + 1 ? c.danger : c.text}
        />
      </TouchableOpacity>
    </View>
  );
}

const useControlStyles = makeStyles(c =>
  StyleSheet.create({
    switchRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.sm,
    },
    switchIconWrap: {
      width: 38,
      height: 38,
      borderRadius: 12,
      backgroundColor: c.accentSoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    switchLabel: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.caption,
    },
    switchHint: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      marginTop: 1,
    },
    stepper: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    stepperBtn: {
      width: 34,
      height: 34,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
    },
    stepperBtnCompact: {
      width: 26,
      height: 26,
      borderRadius: 8,
    },
    stepperBtnInc: {
      backgroundColor: c.accent,
    },
    stepperBtnDec: {
      backgroundColor: c.surfaceAlt,
      borderWidth: 1,
      borderColor: c.border,
    },
    stepperValue: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: typography.body,
      minWidth: 30,
      textAlign: 'center',
      fontVariant: ['tabular-nums'],
    },
    stepperValueCompact: {
      fontSize: typography.caption,
      minWidth: 22,
    },
  }),
);

// ────────────────────────────────────────────────────────────────
// Toaster
// ────────────────────────────────────────────────────────────────

const TOAST_ICON: Record<ToastKind, IconName> = {
  success: 'checkCircle',
  error: 'alert',
  info: 'info',
};

export function Toaster() {
  const c = useThemeColors();
  const styles = useToastStyles();
  const toasts = useToastStore(state => state.toasts);
  const dismiss = useToastStore(state => state.dismiss);
  const insets = useSafeAreaInsets();

  if (toasts.length === 0) {
    return null;
  }

  const toastColor = (kind: ToastKind): string =>
    kind === 'success' ? c.success : kind === 'error' ? c.danger : c.info;

  return (
    <View
      style={[
        styles.toasterWrap,
        {top: (statusBarHeight ?? 24) + insets.top + 4},
      ]}
      pointerEvents="box-none">
      {toasts.slice(-3).map(item => (
        <TouchableOpacity
          key={item.id}
          style={[styles.toast, {borderRightColor: toastColor(item.kind)}]}
          onPress={() => dismiss(item.id)}
          activeOpacity={0.9}>
          <Icon
            name={TOAST_ICON[item.kind]}
            size={19}
            color={toastColor(item.kind)}
          />
          <Text style={styles.toastText}>{item.message}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const useToastStyles = makeStyles(c =>
  StyleSheet.create({
    toasterWrap: {
      position: 'absolute',
      left: spacing.lg,
      right: spacing.lg,
      gap: spacing.sm,
      // v31 (round-39 #3): فوق طبقة القفل (9999) — رسائل البيع في
      // «وضع البيع السريع» (نقطة البيع فوق شاشة القفل) يجب أن
      // تظهر فوق كل شيء وإلا لَما رأى العامل تأكيد البيع.
      zIndex: 10000,
      elevation: 10000,
    },
    toast: {
      ...shadows.floating,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: c.surfaceHi,
      borderWidth: 1,
      borderColor: c.border,
      borderRightWidth: 4,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      paddingVertical: 13,
    },
    toastText: {
      flex: 1,
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.caption,
      lineHeight: 19,
    },
  }),
);
