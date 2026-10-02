/**
 * Shared UI kit — Bold Commercial Dark theme.
 * Big tap targets, high contrast, Arabic-first layout.
 */
import React, {useState, useCallback} from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  TextInput,
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  KeyboardTypeOptions,
  ViewStyle,
} from 'react-native';
import {colors, spacing, radius, typography, shadows} from '../core/theme';
import {formatMoney} from '../core/format';
import {useToastStore} from '../stores/toastStore';
import {useNavigation} from '../core/navigation';

// ────────────────────────────────────────────────────────────────
// Screen scaffolding
// ────────────────────────────────────────────────────────────────

export function Screen({children}: {children: React.ReactNode}) {
  return <View style={styles.screen}>{children}</View>;
}

export function ScreenHeader({
  title,
  subtitle,
  showBack = false,
}: {
  title: string;
  subtitle?: string;
  showBack?: boolean;
}) {
  const pop = useNavigation(state => state.pop);
  return (
    <View style={styles.header}>
      {showBack ? (
        <TouchableOpacity style={styles.backButton} onPress={pop} hitSlop={{top: 12, bottom: 12, left: 12, right: 12}}>
          <Text style={styles.backIcon}>›</Text>
        </TouchableOpacity>
      ) : (
        <View style={styles.backPlaceholder} />
      )}
      <View style={styles.headerTextWrap}>
        <Text style={styles.headerTitle}>{title}</Text>
        {subtitle ? <Text style={styles.headerSubtitle}>{subtitle}</Text> : null}
      </View>
      <View style={styles.backPlaceholder} />
    </View>
  );
}

// ────────────────────────────────────────────────────────────────
// Buttons
// ────────────────────────────────────────────────────────────────

type ButtonVariant = 'primary' | 'ghost' | 'danger' | 'success';

export function AppButton({
  title,
  onPress,
  variant = 'primary',
  disabled = false,
  loading = false,
  small = false,
  style,
}: {
  title: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  small?: boolean;
  style?: ViewStyle;
}) {
  const backgroundStyle =
    variant === 'primary'
      ? styles.buttonPrimary
      : variant === 'danger'
      ? styles.buttonDanger
      : variant === 'success'
      ? styles.buttonSuccess
      : styles.buttonGhost;

  const textStyle =
    variant === 'ghost' ? styles.buttonGhostText : styles.buttonText;

  return (
    <TouchableOpacity
      style={[
        styles.button,
        small && styles.buttonSmall,
        backgroundStyle,
        (disabled || loading) && styles.buttonDisabled,
        style,
      ]}
      onPress={onPress}
      disabled={disabled || loading}
      activeOpacity={0.75}>
      {loading ? (
        <ActivityIndicator color={variant === 'ghost' ? colors.accent : '#FFFFFF'} />
      ) : (
        <Text style={[textStyle, small && styles.buttonSmallText]}>{title}</Text>
      )}
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
        styles.money,
        big && styles.moneyBig,
        color != null ? {color} : undefined,
      ]}
      adjustsFontSizeToFit
      numberOfLines={1}>
      {formatMoney(value)}
    </Text>
  );
}

export function Badge({
  label,
  tone = 'neutral',
}: {
  label: string;
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'accent';
}) {
  const toneStyle =
    tone === 'success'
      ? styles.badgeSuccess
      : tone === 'warning'
      ? styles.badgeWarning
      : tone === 'danger'
      ? styles.badgeDanger
      : tone === 'accent'
      ? styles.badgeAccent
      : styles.badgeNeutral;
  const toneText =
    tone === 'success'
      ? styles.badgeSuccessText
      : tone === 'warning'
      ? styles.badgeWarningText
      : tone === 'danger'
      ? styles.badgeDangerText
      : tone === 'accent'
      ? styles.badgeAccentText
      : styles.badgeNeutralText;
  return (
    <View style={[styles.badge, toneStyle]}>
      <Text style={[styles.badgeText, toneText]}>{label}</Text>
    </View>
  );
}

export function EmptyState({
  title,
  subtitle,
  emoji = '📦',
}: {
  title: string;
  subtitle?: string;
  emoji?: string;
}) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyEmoji}>{emoji}</Text>
      <Text style={styles.emptyTitle}>{title}</Text>
      {subtitle ? <Text style={styles.emptySubtitle}>{subtitle}</Text> : null}
    </View>
  );
}

export function StatCard({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  tone?: 'neutral' | 'success' | 'accent' | 'danger';
}) {
  const valueColor =
    tone === 'success'
      ? colors.success
      : tone === 'accent'
      ? colors.accent
      : tone === 'danger'
      ? colors.danger
      : colors.text;
  return (
    <View style={styles.statCard}>
      <Text style={styles.statLabel} numberOfLines={1}>
        {label}
      </Text>
      <Text style={[styles.statValue, {color: valueColor}]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
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
  keyboardType = 'default',
  suffix,
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  keyboardType?: KeyboardTypeOptions;
  suffix?: string;
}) {
  return (
    <View style={styles.fieldWrap}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.fieldRow}>
        <TextInput
          style={styles.fieldInput}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={colors.textFaint}
          keyboardType={keyboardType}
          textAlign="right"
        />
        {suffix ? <Text style={styles.fieldSuffix}>{suffix}</Text> : null}
      </View>
    </View>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: {value: T; label: string}[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <View style={styles.segmentWrap}>
      {options.map(option => {
        const active = option.value === value;
        return (
          <TouchableOpacity
            key={option.value}
            style={[styles.segmentItem, active && styles.segmentItemActive]}
            onPress={() => onChange(option.value)}>
            <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
              {option.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

// ────────────────────────────────────────────────────────────────
// Dialogs
// ────────────────────────────────────────────────────────────────

export function ConfirmDialog({
  visible,
  title,
  message,
  confirmLabel = 'تأكيد',
  danger = false,
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.dialogBackdrop}>
        <View style={styles.dialogCard}>
          <Text style={styles.dialogTitle}>{title}</Text>
          <Text style={styles.dialogMessage}>{message}</Text>
          <View style={styles.dialogButtons}>
            <AppButton title="إلغاء" variant="ghost" small onPress={onCancel} style={{flex: 1}} />
            <AppButton
              title={confirmLabel}
              variant={danger ? 'danger' : 'primary'}
              small
              onPress={onConfirm}
              style={{flex: 1}}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ────────────────────────────────────────────────────────────────
// Toaster
// ────────────────────────────────────────────────────────────────

export function Toaster() {
  const toasts = useToastStore(state => state.toasts);
  const dismiss = useToastStore(state => state.dismiss);
  if (toasts.length === 0) return null;
  return (
    <View style={styles.toasterWrap} pointerEvents="box-none">
      {toasts.slice(-3).map(item => (
        <TouchableOpacity
          key={item.id}
          style={[
            styles.toast,
            item.kind === 'success' && styles.toastSuccess,
            item.kind === 'error' && styles.toastError,
          ]}
          onPress={() => dismiss(item.id)}
          activeOpacity={0.9}>
          <Text style={styles.toastText}>{item.message}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

// ────────────────────────────────────────────────────────────────
// Horizontal chips row (categories / filters)
// ────────────────────────────────────────────────────────────────

export function ChipsRow<T extends string | number>({
  options,
  value,
  onChange,
}: {
  options: {value: T; label: string}[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.chipsContent}
      style={styles.chipsRow}>
      {options.map(option => {
        const active = option.value === value;
        return (
          <TouchableOpacity
            key={String(option.value)}
            style={[styles.chip, active && styles.chipActive]}
            onPress={() => onChange(option.value)}>
            <Text style={[styles.chipText, active && styles.chipTextActive]}>
              {option.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

export function useConfirm() {
  const [state, setState] = useState<{
    visible: boolean;
    title: string;
    message: string;
    danger: boolean;
    confirmLabel: string;
    onConfirm: () => void;
  }>({
    visible: false,
    title: '',
    message: '',
    danger: false,
    confirmLabel: 'تأكيد',
    onConfirm: () => undefined,
  });

  const ask = useCallback(
    (title: string, message: string, onConfirm: () => void, danger = false, confirmLabel = 'تأكيد') => {
      setState({visible: true, title, message, danger, confirmLabel, onConfirm});
    },
    [],
  );

  const dialog = (
    <ConfirmDialog
      visible={state.visible}
      title={state.title}
      message={state.message}
      danger={state.danger}
      confirmLabel={state.confirmLabel}
      onConfirm={() => {
        state.onConfirm();
        setState(prev => ({...prev, visible: false}));
      }}
      onCancel={() => setState(prev => ({...prev, visible: false}))}
    />
  );

  return {ask, dialog};
}

// ────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  backButton: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backIcon: {
    color: colors.accent,
    fontSize: 30,
    fontWeight: '700',
    marginTop: -4,
  },
  backPlaceholder: {
    width: 44,
  },
  headerTextWrap: {
    flex: 1,
    alignItems: 'center',
  },
  headerTitle: {
    color: colors.text,
    fontSize: typography.heading,
    fontWeight: '800',
  },
  headerSubtitle: {
    color: colors.textDim,
    fontSize: typography.caption,
    marginTop: 2,
  },
  button: {
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    paddingHorizontal: spacing.lg,
    flexDirection: 'row',
  },
  buttonSmall: {
    paddingVertical: 9,
    paddingHorizontal: spacing.md,
  },
  buttonPrimary: {
    backgroundColor: colors.accent,
  },
  buttonDanger: {
    backgroundColor: colors.danger,
  },
  buttonSuccess: {
    backgroundColor: colors.success,
  },
  buttonGhost: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
  },
  buttonDisabled: {
    opacity: 0.45,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: typography.body,
    fontWeight: '800',
  },
  buttonSmallText: {
    fontSize: typography.caption,
  },
  buttonGhostText: {
    color: colors.text,
    fontSize: typography.body,
    fontWeight: '700',
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    ...shadows.card,
  },
  money: {
    color: colors.text,
    fontSize: typography.money,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  moneyBig: {
    fontSize: typography.moneyBig,
    color: colors.accent,
  },
  badge: {
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
  },
  badgeNeutral: {backgroundColor: colors.surfaceAlt},
  badgeSuccess: {backgroundColor: colors.successSoft},
  badgeWarning: {backgroundColor: colors.warningSoft},
  badgeDanger: {backgroundColor: colors.dangerSoft},
  badgeAccent: {backgroundColor: colors.accentSoft},
  badgeText: {
    fontSize: typography.small,
    fontWeight: '700',
  },
  badgeNeutralText: {color: colors.textDim},
  badgeSuccessText: {color: colors.success},
  badgeWarningText: {color: colors.warning},
  badgeDangerText: {color: colors.danger},
  badgeAccentText: {color: colors.accent},
  empty: {
    alignItems: 'center',
    paddingVertical: spacing.xxl,
    paddingHorizontal: spacing.xl,
  },
  emptyEmoji: {
    fontSize: 44,
    marginBottom: spacing.md,
  },
  emptyTitle: {
    color: colors.text,
    fontSize: typography.body,
    fontWeight: '700',
    textAlign: 'center',
  },
  emptySubtitle: {
    color: colors.textDim,
    fontSize: typography.caption,
    textAlign: 'center',
    marginTop: spacing.sm,
    lineHeight: 20,
  },
  statCard: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginHorizontal: 4,
    borderWidth: 1,
    borderColor: colors.border,
  },
  statLabel: {
    color: colors.textDim,
    fontSize: typography.small,
    marginBottom: 4,
  },
  statValue: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  fieldWrap: {
    marginBottom: spacing.lg,
  },
  fieldLabel: {
    color: colors.textDim,
    fontSize: typography.caption,
    marginBottom: 6,
    fontWeight: '700',
  },
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
  },
  fieldInput: {
    flex: 1,
    color: colors.text,
    fontSize: typography.body,
    paddingVertical: 12,
    fontWeight: '600',
  },
  fieldSuffix: {
    color: colors.textDim,
    fontSize: typography.body,
    marginLeft: spacing.sm,
  },
  segmentWrap: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.lg,
    padding: 4,
    borderWidth: 1,
    borderColor: colors.border,
  },
  segmentItem: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  segmentItemActive: {
    backgroundColor: colors.accent,
  },
  segmentText: {
    color: colors.textDim,
    fontSize: typography.caption,
    fontWeight: '700',
  },
  segmentTextActive: {
    color: '#FFFFFF',
  },
  dialogBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.72)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  dialogCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    padding: spacing.xl,
    width: '100%',
  },
  dialogTitle: {
    color: colors.text,
    fontSize: typography.heading,
    fontWeight: '800',
    textAlign: 'center',
    marginBottom: spacing.md,
  },
  dialogMessage: {
    color: colors.textDim,
    fontSize: typography.body,
    textAlign: 'center',
    lineHeight: 24,
    marginBottom: spacing.xl,
  },
  dialogButtons: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  toasterWrap: {
    position: 'absolute',
    bottom: 28,
    left: spacing.lg,
    right: spacing.lg,
    gap: 8,
  },
  toast: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingVertical: 12,
    paddingHorizontal: spacing.lg,
  },
  toastSuccess: {
    borderColor: colors.success,
    backgroundColor: '#12291C',
  },
  toastError: {
    borderColor: colors.danger,
    backgroundColor: '#2C1416',
  },
  toastText: {
    color: colors.text,
    fontSize: typography.caption,
    textAlign: 'center',
    fontWeight: '700',
  },
  chipsRow: {
    flexGrow: 0,
  },
  chipsContent: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: 8,
  },
  chip: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.xl,
    paddingHorizontal: spacing.lg,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipActive: {
    backgroundColor: colors.accentSoft,
    borderColor: colors.accent,
  },
  chipText: {
    color: colors.textDim,
    fontSize: typography.caption,
    fontWeight: '700',
  },
  chipTextActive: {
    color: colors.accent,
  },
});
