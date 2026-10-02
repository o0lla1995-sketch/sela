/**
 * Bold Commercial Design System
 * ─────────────────────────────────────────────────────────────────
 * Deep charcoal surfaces + high-energy orange accents.
 * Tuned for retail environments: high contrast, big tap targets,
 * readable at arm's length under strong shop lighting.
 */
import {StyleSheet, Platform, StatusBar} from 'react-native';

export const colors = {
  /** App background — deep charcoal. */
  bg: '#111111',
  /** Elevated cards / panels. */
  surface: '#1B1B1F',
  /** Slightly lighter surface for nested elements. */
  surfaceAlt: '#232329',
  /** Border / divider color. */
  border: '#2E2E36',
  /** Energy orange — primary action color. */
  accent: '#F97316',
  /** Pressed / darker orange. */
  accentDark: '#C2410C',
  /** Soft orange background (chips, highlights). */
  accentSoft: 'rgba(249, 115, 22, 0.16)',
  /** Success green (stock OK, connection OK). */
  success: '#22C55E',
  successSoft: 'rgba(34, 197, 94, 0.15)',
  /** Danger red (deletes, errors, low stock). */
  danger: '#EF4444',
  dangerSoft: 'rgba(239, 68, 68, 0.15)',
  /** Warning amber (low stock). */
  warning: '#FACC15',
  warningSoft: 'rgba(250, 204, 21, 0.15)',
  /** Info blue. */
  info: '#38BDF8',
  infoSoft: 'rgba(56, 189, 248, 0.14)',
  /** Primary text. */
  text: '#FAFAFA',
  /** Secondary / muted text. */
  textDim: '#9CA3AF',
  /** Even softer text (labels, hints). */
  textFaint: '#6B7280',
  /** Camera ROI frame. */
  roi: '#F97316',
  /** Scanner flash. */
  flash: 'rgba(34, 197, 94, 0.22)',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 14,
  xl: 20,
} as const;

export const typography = {
  title: 26,
  heading: 20,
  body: 16,
  caption: 13,
  small: 11,
  money: 18,
  moneyBig: 28,
} as const;

export const shadows = StyleSheet.create({
  card: {
    elevation: 3,
    shadowColor: '#000000',
    shadowOffset: {width: 0, height: 2},
    shadowOpacity: 0.35,
    shadowRadius: 4,
  },
});

export const statusbarHeight = Platform.select({
  android: StatusBar.currentHeight ?? 24,
  default: 44,
});

export const common = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
});
