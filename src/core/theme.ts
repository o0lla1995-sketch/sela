/**
 * sela — Design System v3.0
 * ─────────────────────────────────────────────────────────────────
 * Dynamic light/dark theme. Every component reads colors through
 * useThemeColors() so the whole app re-skins instantly when the
 * merchant switches الوضع النهاري / الليلي / تلقائي from Settings.
 *
 * Full spec: design.md at the repository root.
 */
import {useMemo} from 'react';
import {Appearance, Platform, StatusBar, StyleSheet} from 'react-native';
import {create} from 'zustand';
import {getString, setString, KEYS} from '../storage/storage';

export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

/** Complete semantic palette — identical key set in both modes. */
export interface Palette {
  bg: string;
  surface: string;
  surfaceAlt: string;
  surfaceHi: string;
  border: string;
  borderSoft: string;
  accent: string;
  accentDark: string;
  accentSoft: string;
  accentSofter: string;
  success: string;
  successSoft: string;
  danger: string;
  dangerSoft: string;
  warning: string;
  warningSoft: string;
  info: string;
  infoSoft: string;
  text: string;
  textDim: string;
  textFaint: string;
  onAccent: string;
  /** Camera overlays always sit on live imagery — kept dark. */
  roi: string;
  flash: string;
  scrim: string;
  /** Darkens behind modals/sheets. */
  overlay: string;
  /** Bottom-sheet grabber / hairlines. */
  hairline: string;
}

const DARK: Palette = {
  bg: '#0E0E12',
  surface: '#17171D',
  surfaceAlt: '#1F1F27',
  surfaceHi: '#26262F',
  border: '#2A2A33',
  borderSoft: '#22222B',
  accent: '#F97316',
  accentDark: '#C2410C',
  accentSoft: 'rgba(249, 115, 22, 0.16)',
  accentSofter: 'rgba(249, 115, 22, 0.08)',
  success: '#22C55E',
  successSoft: 'rgba(34, 197, 94, 0.15)',
  danger: '#EF4444',
  dangerSoft: 'rgba(239, 68, 68, 0.15)',
  warning: '#FACC15',
  warningSoft: 'rgba(250, 204, 21, 0.15)',
  info: '#38BDF8',
  infoSoft: 'rgba(56, 189, 248, 0.14)',
  text: '#F4F4F5',
  textDim: '#A1A1AA',
  textFaint: '#71717A',
  onAccent: '#FFFFFF',
  roi: '#F97316',
  flash: 'rgba(34, 197, 94, 0.24)',
  scrim: 'rgba(14, 14, 18, 0.84)',
  overlay: 'rgba(0, 0, 0, 0.55)',
  hairline: '#2A2A33',
};

const LIGHT: Palette = {
  bg: '#F5F5F7',
  surface: '#FFFFFF',
  surfaceAlt: '#F1F1F4',
  surfaceHi: '#E9E9EE',
  border: '#DDDDE4',
  borderSoft: '#E8E8EE',
  accent: '#F97316',
  accentDark: '#C2410C',
  accentSoft: 'rgba(249, 115, 22, 0.13)',
  accentSofter: 'rgba(249, 115, 22, 0.07)',
  success: '#15A34A',
  successSoft: 'rgba(21, 163, 74, 0.13)',
  danger: '#DC2626',
  dangerSoft: 'rgba(220, 38, 38, 0.12)',
  warning: '#B45309',
  warningSoft: 'rgba(180, 83, 9, 0.13)',
  info: '#0369A1',
  infoSoft: 'rgba(3, 105, 161, 0.12)',
  text: '#17171D',
  textDim: '#55555F',
  textFaint: '#8B8B96',
  onAccent: '#FFFFFF',
  roi: '#F97316',
  flash: 'rgba(21, 163, 74, 0.22)',
  scrim: 'rgba(14, 14, 18, 0.84)',
  overlay: 'rgba(20, 20, 26, 0.35)',
  hairline: '#E4E4EA',
};

export function paletteFor(mode: ResolvedTheme): Palette {
  return mode === 'light' ? LIGHT : DARK;
}

function systemTheme(): ResolvedTheme {
  const scheme = Appearance.getColorScheme();
  return scheme === 'light' ? 'light' : 'dark';
}

// ────────────────────────────────────────────────────────────────
// Theme store — zustand so non-navigating services can read it too.
// ────────────────────────────────────────────────────────────────

interface ThemeState {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  palette: Palette;
  setMode: (mode: ThemeMode) => void;
  /** Called from App on Appearance changes (system mode only). */
  syncSystem: () => void;
}

function readStoredMode(): ThemeMode {
  const stored = getString(KEYS.themeMode, 'dark');
  return stored === 'light' || stored === 'system' ? stored : 'dark';
}

const initialMode = readStoredMode();
const initialResolved = initialMode === 'system' ? systemTheme() : initialMode;

export const useThemeStore = create<ThemeState>(set => ({
  mode: initialMode,
  resolved: initialResolved,
  palette: paletteFor(initialResolved),
  setMode: mode => {
    const resolved = mode === 'system' ? systemTheme() : mode;
    setString(KEYS.themeMode, mode);
    set({mode, resolved, palette: paletteFor(resolved)});
  },
  syncSystem: () => {
    const {mode} = useThemeStore.getState();
    if (mode !== 'system') {
      return;
    }
    const resolved = systemTheme();
    if (resolved !== useThemeStore.getState().resolved) {
      set({resolved, palette: paletteFor(resolved)});
    }
  },
}));

/** Hook every component uses for colors. Re-renders on theme change. */
export function useThemeColors(): Palette {
  return useThemeStore(state => state.palette);
}

/** Imperative palette access outside React (notifications, receipts). */
export function getPalette(): Palette {
  return useThemeStore.getState().palette;
}

/**
 * Legacy static export — the DARK palette. Kept only for the rare
 * non-React module that renders nothing (log formatting). Components
 * must use useThemeColors().
 */
export const colors = DARK;

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

/** Minimal elevation — borders + layers carry the depth (design.md §6). */
export const shadows = StyleSheet.create({
  floating: {
    elevation: 6,
    shadowColor: '#000000',
    shadowOffset: {width: 0, height: 3},
    shadowOpacity: 0.28,
    shadowRadius: 6,
  },
  cardLight: {
    elevation: 2,
    shadowColor: '#6B6B7A',
    shadowOffset: {width: 0, height: 2},
    shadowOpacity: 0.1,
    shadowRadius: 5,
  },
});

export const statusBarHeight = Platform.select({
  android: StatusBar.currentHeight ?? 24,
  default: 44,
});

/** Touch targets must never be smaller than this (design.md §12). */
export const MIN_TOUCH = 48;

/**
 * makeStyles — tiny factory helper so screens can build themed
 * StyleSheets that rebuild on palette change:
 *
 *   const useStyles = makeStyles(c => StyleSheet.create({...}));
 *   const styles = useStyles();
 */
export function makeStyles<
  T extends StyleSheet.NamedStyles<T> | StyleSheet.NamedStyles<any>,
>(factory: (c: Palette) => T): () => T {
  const cache = new Map<ResolvedTheme, T>();
  return () => {
    const palette = useThemeColors();
    return useMemo(() => {
      const hit = cache.get(palette === LIGHT ? 'light' : 'dark');
      if (hit != null) {
        return hit;
      }
      const built = StyleSheet.create(factory(palette));
      cache.set(palette === LIGHT ? 'light' : 'dark', built);
      return built;
    }, [palette]);
  };
}
