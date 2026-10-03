/**
 * سيلا UI kit — components per design.md §8.
 * ─────────────────────────────────────────────────────────────────
 * AppHeader / AppButton / Card / Badge / Segmented / EmptyState /
 * StatCard / Field / Switch row / Stepper / Toaster.
 * All Tajawal, layered surfaces, 48dp touch targets, zero emojis.
 */
import React from 'react';
import {
  ActivityIndicator,
  I18nManager,
  KeyboardTypeOptions,
  Pressable,
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
import {colors, fonts, radius, shadows, spacing, statusBarHeight, typography} from '../core/theme';
import {formatMoney} from '../core/format';

// ────────────────────────────────────────────────────────────────
// Screen scaffolding
// ────────────────────────────────────────────────────────────────

export function Screen({children}: {children: React.ReactNode}) {
  return <View style={styles.screen}>{children}</View>;
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
              color={colors.text}
            />
          </TouchableOpacity>
        ) : (
          <View style={styles.headerIconBtn} pointerEvents="none">
            <Icon name="sparkles" size={20} color={colors.accent} />
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
              style={styles.headerIconBtn}
              onPress={() => navigation.navigate('Notifications' as never)}
              hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}>
              <Icon
                name={unreadCount > 0 ? 'bell' : 'bellOff'}
                size={20}
                color={unreadCount > 0 ? colors.accent : colors.textDim}
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
      ? colors.onAccent
      : variant === 'secondary'
      ? colors.text
      : variant === 'danger'
      ? colors.danger
      : colors.accent;

  return (
    <TouchableOpacity
      style={[styles.button, small && styles.buttonSmall, bg, (disabled || loading) && styles.buttonDisabled, style]}
      onPress={onPress}
      disabled={disabled || loading}
      activeOpacity={0.8}>
      {loading ? (
        <ActivityIndicator
          size="small"
          color={variant === 'ghost' || variant === 'danger' || variant === 'secondary' ? colors.accent : colors.onAccent}
        />
      ) : (
        <>
          {icon != null ? <Icon name={icon} size={small ? 15 : 18} color={textColor} /> : null}
          <Text style={[styles.buttonText, small && styles.buttonSmallText, {color: textColor}]}>
            {title}
          </Text>
        </>
      )}
    </TouchableOpacity>
  );
}

export function IconButton({
  name,
  onPress,
  size = 40,
  color = colors.text,
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
      <Icon name={name} size={Math.round(size * 0.48)} color={color} />
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
  return (
    <Text
      style={[
        big ? styles.moneyBig : styles.money,
        color != null ? {color} : null,
      ]}
      numberOfLines={1}>
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
  const valueColor =
    tone === 'accent'
      ? colors.accent
      : tone === 'success'
      ? colors.success
      : tone === 'danger'
      ? colors.danger
      : tone === 'info'
      ? colors.info
      : colors.text;
  return (
    <View style={styles.statCard}>
      {icon != null ? (
        <View style={styles.statIconWrap}>
          <Icon name={icon} size={16} color={valueColor} />
        </View>
      ) : null}
      <Text style={[styles.statValue, {color: valueColor}]} numberOfLines={1}>
        {value}
      </Text>
      <Text style={styles.statLabel} numberOfLines={1}>
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
  const style =
    tone === 'success'
      ? [styles.badge, {backgroundColor: colors.successSoft}, {color: colors.success}]
      : tone === 'danger'
      ? [styles.badge, {backgroundColor: colors.dangerSoft}, {color: colors.danger}]
      : tone === 'warning'
      ? [styles.badge, {backgroundColor: colors.warningSoft}, {color: colors.warning}]
      : tone === 'accent'
      ? [styles.badge, {backgroundColor: colors.accentSoft}, {color: colors.accent}]
      : tone === 'info'
      ? [styles.badge, {backgroundColor: colors.infoSoft}, {color: colors.info}]
      : [styles.badge, {backgroundColor: colors.surfaceHi}, {color: colors.textDim}];
  const textColor =
    tone === 'success'
      ? colors.success
      : tone === 'danger'
      ? colors.danger
      : tone === 'warning'
      ? colors.warning
      : tone === 'accent'
      ? colors.accent
      : tone === 'info'
      ? colors.info
      : colors.textDim;
  return (
    <View style={style}>
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
  return (
    <View style={styles.empty}>
      <IconChip name={icon} chipSize={64} size={28} bg={colors.accentSoft} color={colors.accent} />
      <Text style={styles.emptyTitle}>{title}</Text>
      {subtitle ? <Text style={styles.emptyText}>{subtitle}</Text> : null}
      {action ? <View style={{marginTop: spacing.md}}>{action}</View> : null}
    </View>
  );
}

// ────────────────────────────────────────────────────────────────
// Inputs
// ────────────────────────────────────────────────────────────────

export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType,
  suffix,
  multiline = false,
  numberOfLines = 1,
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  keyboardType?: KeyboardTypeOptions;
  suffix?: string;
  multiline?: boolean;
  numberOfLines?: number;
}) {
  return (
    <View style={styles.fieldWrap}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.fieldRow}>
        <TextInput
          style={[styles.fieldInput, multiline && styles.fieldMultiline]}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={colors.textFaint}
          keyboardType={keyboardType}
          multiline={multiline}
          numberOfLines={numberOfLines}
          textAlign={I18nManager.isRTL ? 'right' : 'left'}
          textAlignVertical={multiline ? 'top' : 'center'}
        />
        {suffix ? <Text style={styles.fieldSuffix}>{suffix}</Text> : null}
      </View>
    </View>
  );
}

export function SearchBar({
  value,
  onChangeText,
  placeholder,
}: {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
}) {
  return (
    <View style={styles.searchWrap}>
      <Icon name="search" size={18} color={colors.textFaint} />
      <TextInput
        style={styles.searchInput}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder ?? 'بحث…'}
        placeholderTextColor={colors.textFaint}
        textAlign={I18nManager.isRTL ? 'right' : 'left'}
      />
      {value.length > 0 ? (
        <TouchableOpacity onPress={() => onChangeText('')} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
          <Icon name="x" size={16} color={colors.textDim} />
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
}: {
  value: T;
  onChange: (value: T) => void;
  options: {value: T; label: string}[];
  compact?: boolean;
}) {
  return (
    <View style={[styles.segmented, compact && styles.segmentedCompact]}>
      {options.map(option => {
        const active = option.value === value;
        return (
          <TouchableOpacity
            key={String(option.value)}
            style={[styles.segItem, active && styles.segItemActive]}
            onPress={() => onChange(option.value)}
            activeOpacity={0.8}>
            <Text
              style={[
                compact ? styles.segTextCompact : styles.segText,
                active && styles.segTextActive,
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
  return (
    <View style={styles.switchRow}>
      {icon != null ? (
        <View style={styles.switchIconWrap}>
          <Icon name={icon} size={17} color={colors.accent} />
        </View>
      ) : null}
      <View style={{flex: 1}}>
        <Text style={styles.switchLabel}>{label}</Text>
        {hint ? <Text style={styles.switchHint}>{hint}</Text> : null}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{false: colors.surfaceHi, true: colors.accent}}
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
}: {
  value: number;
  onIncrement: () => void;
  onDecrement: () => void;
  min?: number;
  decrementDanger?: boolean;
}) {
  return (
    <View style={styles.stepper}>
      <TouchableOpacity
        style={[styles.stepperBtn, styles.stepperBtnInc]}
        onPress={onIncrement}
        activeOpacity={0.8}>
        <Icon name="plus" size={17} color={colors.onAccent} />
      </TouchableOpacity>
      <Text style={styles.stepperValue}>{value}</Text>
      <TouchableOpacity
        style={[
          styles.stepperBtn,
          decrementDanger && value <= min + 1
            ? {backgroundColor: colors.dangerSoft, borderColor: colors.danger}
            : styles.stepperBtnDec,
        ]}
        onPress={onDecrement}
        activeOpacity={0.8}>
        <Icon
          name="minus"
          size={17}
          color={decrementDanger && value <= min + 1 ? colors.danger : colors.text}
        />
      </TouchableOpacity>
    </View>
  );
}

// ────────────────────────────────────────────────────────────────
// Toaster
// ────────────────────────────────────────────────────────────────

const TOAST_ICON: Record<ToastKind, IconName> = {
  success: 'checkCircle',
  error: 'alert',
  info: 'info',
};

export function Toaster() {
  const toasts = useToastStore(state => state.toasts);
  const dismiss = useToastStore(state => state.dismiss);
  const insets = useSafeAreaInsets();

  if (toasts.length === 0) {
    return null;
  }

  return (
    <View
      style={[styles.toasterWrap, {top: (statusBarHeight ?? 24) + insets.top + 4}]}
      pointerEvents="box-none">
      {toasts.slice(-3).map(item => (
        <TouchableOpacity
          key={item.id}
          style={[styles.toast, {borderRightColor: toastColor(item.kind)}]}
          onPress={() => dismiss(item.id)}
          activeOpacity={0.9}>
          <Icon name={TOAST_ICON[item.kind]} size={19} color={toastColor(item.kind)} />
          <Text style={styles.toastText}>{item.message}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

function toastColor(kind: ToastKind): string {
  return kind === 'success' ? colors.success : kind === 'error' ? colors.danger : colors.info;
}

// ────────────────────────────────────────────────────────────────
// Styles
// ────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },

  // Header
  headerRoot: {
    backgroundColor: colors.bg,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSoft,
    paddingTop: statusBarHeight,
  },
  headerRow: {
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
  },
  headerIconBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTextWrap: {
    flex: 1,
    alignItems: 'center',
  },
  headerTitle: {
    color: colors.text,
    fontFamily: fonts.black,
    fontSize: typography.heading,
  },
  headerSubtitle: {
    color: colors.textDim,
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
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
    borderWidth: 2,
    borderColor: colors.bg,
  },
  bellBadgeText: {
    color: colors.onAccent,
    fontSize: 9,
    fontFamily: fonts.bold,
  },

  // Buttons
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
  btnPrimary: {backgroundColor: colors.accent},
  btnSecondary: {backgroundColor: colors.surfaceHi, borderWidth: 1, borderColor: colors.border},
  btnDanger: {backgroundColor: colors.dangerSoft, borderWidth: 1, borderColor: colors.danger},
  btnSuccess: {backgroundColor: colors.success},
  btnGhost: {backgroundColor: colors.accentSofter, borderWidth: 1, borderColor: colors.accentDark},
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
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },

  // Surfaces
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    padding: spacing.lg,
  },
  sectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginBottom: spacing.sm,
  },
  sectionTitle: {
    color: colors.text,
    fontFamily: fonts.black,
    fontSize: typography.heading,
  },
  sectionHint: {
    color: colors.textFaint,
    fontFamily: fonts.regular,
    fontSize: typography.small,
    marginTop: 1,
  },

  // Data display
  money: {
    color: colors.text,
    fontFamily: fonts.bold,
    fontSize: typography.body,
    fontVariant: ['tabular-nums'],
  },
  moneyBig: {
    color: colors.accent,
    fontFamily: fonts.black,
    fontSize: typography.display,
    fontVariant: ['tabular-nums'],
  },
  statCard: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    padding: spacing.md,
    gap: 2,
  },
  statIconWrap: {
    marginBottom: spacing.xs,
  },
  statValue: {
    color: colors.text,
    fontFamily: fonts.black,
    fontSize: 21,
    fontVariant: ['tabular-nums'],
  },
  statLabel: {
    color: colors.textDim,
    fontFamily: fonts.regular,
    fontSize: typography.small,
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
    color: colors.text,
    fontFamily: fonts.bold,
    fontSize: typography.body,
    marginTop: spacing.sm,
  },
  emptyText: {
    color: colors.textDim,
    fontFamily: fonts.regular,
    fontSize: typography.caption,
    textAlign: 'center',
    lineHeight: 21,
  },

  // Inputs
  fieldWrap: {
    gap: 6,
  },
  fieldLabel: {
    color: colors.textDim,
    fontFamily: fonts.bold,
    fontSize: typography.small,
  },
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
  },
  fieldInput: {
    flex: 1,
    color: colors.text,
    fontFamily: fonts.medium,
    fontSize: typography.body,
    paddingVertical: 12,
  },
  fieldMultiline: {
    minHeight: 84,
  },
  fieldSuffix: {
    color: colors.textDim,
    fontFamily: fonts.bold,
    fontSize: typography.caption,
  },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    height: 46,
  },
  searchInput: {
    flex: 1,
    color: colors.text,
    fontFamily: fonts.medium,
    fontSize: typography.caption,
    paddingVertical: 0,
  },

  // Segmented
  segmented: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 3,
  },
  segmentedCompact: {
    borderRadius: radius.sm,
  },
  segItem: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 9,
    borderRadius: radius.sm,
  },
  segItemActive: {
    backgroundColor: colors.accent,
  },
  segText: {
    color: colors.textDim,
    fontFamily: fonts.bold,
    fontSize: typography.caption,
  },
  segTextActive: {
    color: colors.onAccent,
  },
  segTextCompact: {
    color: colors.textDim,
    fontFamily: fonts.bold,
    fontSize: typography.small,
  },

  // Switch row
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
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  switchLabel: {
    color: colors.text,
    fontFamily: fonts.bold,
    fontSize: typography.caption,
  },
  switchHint: {
    color: colors.textFaint,
    fontFamily: fonts.regular,
    fontSize: typography.small,
    marginTop: 1,
  },

  // Stepper
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
  stepperBtnInc: {
    backgroundColor: colors.accent,
  },
  stepperBtnDec: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
  },
  stepperValue: {
    color: colors.text,
    fontFamily: fonts.black,
    fontSize: typography.body,
    minWidth: 30,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },

  // Toaster
  toasterWrap: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    gap: spacing.sm,
  },
  toast: {
    ...shadows.floating,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surfaceHi,
    borderWidth: 1,
    borderColor: colors.border,
    borderRightWidth: 4,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 13,
  },
  toastText: {
    flex: 1,
    color: colors.text,
    fontFamily: fonts.bold,
    fontSize: typography.caption,
    lineHeight: 19,
  },
});
