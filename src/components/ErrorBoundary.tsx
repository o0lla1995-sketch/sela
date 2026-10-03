/**
 * ErrorBoundary — no black screens, ever.
 * ─────────────────────────────────────────────────────────────────
 * v1 crashed silently (camera screens + reports) leaving a dead
 * black activity. v2 wraps the app root AND every screen AND every
 * chart in recovery boundaries that show a friendly Arabic message
 * with a retry button instead.
 */
import React from 'react';
import {
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  ViewStyle,
} from 'react-native';
import {fonts, radius, spacing, typography, getPalette} from '../core/theme';
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
    const c = getPalette();
    const styles = themedStyles(c);

    const message = error.message || 'خطأ غير معروف';

    if (this.props.inline) {
      return (
        <View style={[styles.inline, this.props.style]}>
          <Icon name="alert" size={20} color={c.warning} />
          <Text style={styles.inlineText}>تعذر عرض هذا الجزء — {message}</Text>
          <TouchableOpacity onPress={this.retry} hitSlop={{top: 8, bottom: 8}}>
            <Text style={styles.inlineRetry}>إعادة المحاولة</Text>
          </TouchableOpacity>
        </View>
      );
    }

    return (
      <View style={[styles.full, this.props.style]}>
        <View style={styles.iconWrap}>
          <Icon name="alert" size={34} color={c.warning} />
        </View>
        <Text style={styles.title}>حدث خطأ غير متوقع</Text>
        <Text style={styles.body}>
          واجه هذا القسم مشكلة أثناء العرض. بياناتك محفوظة وسليمة — يمكنك إعادة
          المحاولة أو العودة والاستمرار في العمل.
        </Text>
        <Text style={styles.detail} numberOfLines={3}>
          {message}
        </Text>
        <TouchableOpacity style={styles.retryButton} onPress={this.retry}>
          <Icon name="refresh" size={18} color={c.onAccent} />
          <Text style={styles.retryText}>إعادة المحاولة</Text>
        </TouchableOpacity>
      </View>
    );
  }
}

function themedStyles(c: ReturnType<typeof getPalette>) {
  return StyleSheet.create({
    full: {
      flex: 1,
      backgroundColor: c.bg,
      alignItems: 'center',
      justifyContent: 'center',
      padding: spacing.xl,
      gap: spacing.sm,
    },
    iconWrap: {
      width: 76,
      height: 76,
      borderRadius: radius.pill,
      backgroundColor: c.warningSoft,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: spacing.md,
    },
    title: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: typography.heading,
    },
    body: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.caption,
      textAlign: 'center',
      lineHeight: 22,
      maxWidth: 300,
    },
    detail: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      textAlign: 'center',
      maxWidth: 300,
    },
    retryButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      backgroundColor: c.accent,
      borderRadius: radius.md,
      paddingHorizontal: spacing.xl,
      paddingVertical: 13,
      marginTop: spacing.md,
    },
    retryText: {
      color: c.onAccent,
      fontFamily: fonts.bold,
      fontSize: typography.body,
    },
    inline: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      padding: spacing.lg,
      alignItems: 'center',
      gap: spacing.xs,
    },
    inlineText: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      textAlign: 'center',
    },
    inlineRetry: {
      color: c.accent,
      fontFamily: fonts.bold,
      fontSize: typography.caption,
      marginTop: spacing.xs,
    },
  });
}
