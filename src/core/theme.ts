/**
 * سيلا (Sela) — Design System Tokens v2.0
 * ─────────────────────────────────────────────────────────────────
 * Single source of truth for every visual decision. Full spec:
 * see design.md at the repository root.
 *
 * Layered surfaces instead of flat black; Tajawal Arabic type scale;
 * 4pt spacing grid; semantic colors reserved for meaning.
 */
import {Platform, StatusBar, StyleSheet} from 'react-native';

export const colors = {
  // ── Layered surfaces (never pure black) ──────────────────────
  bg: '#0E0E12',
  surface: '#17171D',
  surfaceAlt: '#1F1F27',
  surfaceHi: '#26262F',
  border: '#2A2A33',
  borderSoft: '#22222B',

  // ── Brand & actions ──────────────────────────────────────────
  accent: '#F97316',
  accentDark: '#C2410C',
  accentSoft: 'rgba(249, 115, 22, 0.14)',
  accentSofter: 'rgba(249, 115, 22, 0.08)',

  // ── Semantic (meaning only, never decoration) ────────────────
  success: '#22C55E',
  successSoft: 'rgba(34, 197, 94, 0.15)',
  danger: '#EF4444',
  dangerSoft: 'rgba(239, 68, 68, 0.15)',
  warning: '#FACC15',
  warningSoft: 'rgba(250, 204, 21, 0.15)',
  info: '#38BDF8',
  infoSoft: 'rgba(56, 189, 248, 0.14)',

  // ── Text ─────────────────────────────────────────────────────
  text: '#F4F4F5',
  textDim: '#A1A1AA',
  textFaint: '#71717A',
  onAccent: '#FFFFFF',

  // ── Camera / vision ──────────────────────────────────────────
  roi: '#F97316',
  flash: 'rgba(34, 197, 94, 0.24)',
  scrim: 'rgba(14, 14, 18, 0.82)',
} as const;

/** Tajawal font files bundled in android/app/src/main/assets/fonts. */
export const fonts = {
  regular: 'Tajawal-Regular',
  medium: 'Tajawal-Medium',
  bold: 'Tajawal-Bold',
  black: 'Tajawal-Black',
} as const;

export const typography = {
  display: 34,
  title: 24,
  heading: 18,
  body: 15.5,
  caption: 13.5,
  small: 12,
  micro: 10.5,
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
  sm: 8,
  md: 12,
  lg: 16,
  pill: 999,
} as const;

/** Minimal elevation — borders + layers carry the depth (see design.md §6). */
export const shadows = StyleSheet.create({
  floating: {
    elevation: 6,
    shadowColor: '#000000',
    shadowOffset: {width: 0, height: 3},
    shadowOpacity: 0.28,
    shadowRadius: 6,
  },
});

export const statusBarHeight = Platform.select({
  android: StatusBar.currentHeight ?? 24,
  default: 44,
});

/** Touch targets must never be smaller than this (design.md §12). */
export const MIN_TOUCH = 48;
