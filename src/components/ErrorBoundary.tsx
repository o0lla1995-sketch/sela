/**
 * ErrorBoundary — no black screens, ever.
 * ─────────────────────────────────────────────────────────────────
 * v1 crashed silently (camera screens + reports) leaving a dead
 * black activity. v2 wraps the app root AND every screen AND every
 * chart in recovery boundaries that show a friendly Arabic message
 * with a retry button instead.
 */
import React from 'react';
import {StyleSheet, Text, TouchableOpacity, View, ViewStyle} from 'react-native';
import {colors, fonts, radius, spacing, typography} from '../core/theme';
import {Icon} from './Icon';
import {logDiag} from '../core/diagnostics';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Small inline variant for embedded widgets (charts, panels). */
  inline?: boolean;
  style?: ViewStyle;
  label?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {error: null};
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {error};
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    logDiag(
      'ui',
      `انهيار ${this.props.label ?? 'مكوّن'}: ${error.message} ${
        info.componentStack?.split('\n')[1] ?? ''
      }`,
      'error',
    );
  }

  private retry = () => {
    this.setState({error: null});
  };

  render(): React.ReactNode {
    const {error} = this.state;
    if (error == null) {
      return this.props.children;
    }

    const message = error.message || 'خطأ غير معروف';

    if (this.props.inline) {
      return (
        <View style={[styles.inline, this.props.style]}>
          <Icon name="alert" size={20} color={colors.warning} />
          <Text style={styles.inlineText}>
            تعذر عرض هذا الجزء — {message}
          </Text>
          <TouchableOpacity onPress={this.retry} hitSlop={{top: 8, bottom: 8}}>
            <Text style={styles.inlineRetry}>إعادة المحاولة</Text>
          </TouchableOpacity>
        </View>
      );
    }

    return (
      <View style={[styles.full, this.props.style]}>
        <View style={styles.iconWrap}>
          <Icon name="alert" size={34} color={colors.warning} />
        </View>
        <Text style={styles.title}>حدث خطأ غير متوقع</Text>
        <Text style={styles.body}>
          واجه هذا القسم مشكلة أثناء العرض. بياناتك محفوظة وسليمة — يمكنك
          إعادة المحاولة أو العودة والاستمرار في العمل.
        </Text>
        <Text style={styles.detail} numberOfLines={3}>
          {message}
        </Text>
        <TouchableOpacity style={styles.retryButton} onPress={this.retry}>
          <Icon name="refresh" size={18} color={colors.onAccent} />
          <Text style={styles.retryText}>إعادة المحاولة</Text>
        </TouchableOpacity>
      </View>
    );
  }
}

const styles = StyleSheet.create({
    full: {
      flex: 1,
      backgroundColor: colors.bg,
      alignItems: 'center',
      justifyContent: 'center',
      padding: spacing.xl,
      gap: spacing.sm,
    },
    iconWrap: {
      width: 76,
      height: 76,
      borderRadius: radius.pill,
      backgroundColor: colors.warningSoft,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: spacing.md,
    },
    title: {
      color: colors.text,
      fontFamily: fonts.black,
      fontSize: typography.heading,
    },
    body: {
      color: colors.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.caption,
      textAlign: 'center',
      lineHeight: 22,
      maxWidth: 300,
    },
    detail: {
      color: colors.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      textAlign: 'center',
      maxWidth: 300,
    },
    retryButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      backgroundColor: colors.accent,
      borderRadius: radius.md,
      paddingHorizontal: spacing.xl,
      paddingVertical: 13,
      marginTop: spacing.md,
    },
    retryText: {
      color: colors.onAccent,
      fontFamily: fonts.bold,
      fontSize: typography.body,
    },
    inline: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.md,
      padding: spacing.lg,
      alignItems: 'center',
      gap: spacing.xs,
    },
    inlineText: {
      color: colors.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      textAlign: 'center',
    },
    inlineRetry: {
      color: colors.accent,
      fontFamily: fonts.bold,
      fontSize: typography.caption,
      marginTop: spacing.xs,
    },
  });
