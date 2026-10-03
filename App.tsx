/**
 * App root — سيلا (Sela).
 * ─────────────────────────────────────────────────────────────────
 * Boot order:
 *  1. SQLite schema bootstrap + migrations (blocking)
 *  2. Catalog + embeddings index refresh
 *  3. Stock alerts evaluation (notifications)
 *  4. TFLite vision model load (async — manual fallback if it fails)
 *  5. Printer auto-reconnect (silent best-effort)
 *
 * Everything renders inside a root ErrorBoundary — a crash anywhere
 * shows a recovery screen instead of a black activity.
 */
import React, {useEffect, useState} from 'react';
import {ActivityIndicator, StatusBar, StyleSheet, Text, View} from 'react-native';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {GestureHandlerRootView} from 'react-native-gesture-handler';

import {RootNavigator} from './src/navigation/RootNavigator';
import {Toaster as UIToaster} from './src/components/ui';
import {ErrorBoundary as Boundary} from './src/components/ErrorBoundary';
import {initDatabase} from './src/database/connection';
import {useCatalogStore} from './src/stores/catalogStore';
import {useCartStore} from './src/stores/cartStore';
import {useSettingsStore} from './src/stores/settingsStore';
import {usePrinterStore} from './src/stores/printerStore';
import {VisionRecognitionService} from './src/services/vision/VisionRecognitionService';
import {StockAlertsService} from './src/services/StockAlertsService';
import {logDiag} from './src/core/diagnostics';
import {colors, fonts, spacing, typography} from './src/core/theme';
import {APP_NAME, APP_VERSION} from './src/core/config';

type BootState = 'booting' | 'ready' | 'error';

export default function App(): React.JSX.Element {
  const [boot, setBoot] = useState<BootState>('booting');
  const [bootError, setBootError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const bootAsync = async () => {
      try {
        // 1. Database schema (must succeed).
        await initDatabase();

        // 2. Catalog & vision index.
        await useCatalogStore.getState().refresh();

        // 3. Stock alerts (best-effort, never blocks boot).
        try {
          await StockAlertsService.evaluate();
        } catch {
          // Notifications are never fatal.
        }

        // 4. Vision model — failure keeps the app usable manually.
        await VisionRecognitionService.loadModel();

        // 5. Apply default pricing mode to a fresh cart.
        const settings = useSettingsStore.getState().settings;
        const cart = useCartStore.getState();
        if (cart.lines.length === 0) {
          cart.setPricingMode(settings.defaultPricingMode);
        }

        // 6. Silent printer auto-reconnect.
        void usePrinterStore.getState().connectSaved();

        if (mounted) {
          setBoot('ready');
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logDiag('boot', `فشل إقلاع التطبيق: ${message}`, 'error');
        if (mounted) {
          setBootError(message);
          setBoot('error');
        }
      }
    };
    void bootAsync();
    return () => {
      mounted = false;
    };
  }, []);

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
        <Boundary label="التطبيق">
          {boot === 'booting' ? (
            <BootSplash />
          ) : boot === 'error' ? (
            <BootError message={bootError ?? 'خطأ غير معروف'} />
          ) : (
            <RootNavigator />
          )}
          <UIToaster />
        </Boundary>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function BootSplash(): React.JSX.Element {
  return (
    <View style={styles.center}>
      <View style={styles.splashMark}>
        <Text style={styles.splashGlyph}>س</Text>
      </View>
      <Text style={styles.splashTitle}>{APP_NAME}</Text>
      <Text style={styles.splashSubtitle}>نقطة بيع ذكية — تعمل بلا إنترنت</Text>
      <ActivityIndicator color={colors.accent} size="large" style={{marginTop: spacing.xl}} />
    </View>
  );
}

function BootError({message}: {message: string}): React.JSX.Element {
  return (
    <View style={styles.center}>
      <View style={styles.splashMark}>
        <Text style={styles.splashGlyph}>س</Text>
      </View>
      <Text style={styles.errorTitle}>تعذّر تشغيل التطبيق</Text>
      <Text style={styles.errorText}>{message}</Text>
      <Text style={styles.errorText}>
        أعد تشغيل التطبيق — إذا استمرت المشكلة جرّب «مسح البيانات» من إعدادات
        أندرويد ثم أعد فتح التطبيق
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    backgroundColor: colors.bg,
  },
  splashMark: {
    width: 92,
    height: 92,
    borderRadius: 28,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  splashGlyph: {
    color: colors.onAccent,
    fontFamily: fonts.black,
    fontSize: 52,
    lineHeight: 64,
    marginTop: 6,
  },
  splashTitle: {
    color: colors.text,
    fontFamily: fonts.black,
    fontSize: 32,
  },
  splashSubtitle: {
    color: colors.textDim,
    fontFamily: fonts.regular,
    fontSize: typography.caption,
    marginTop: spacing.xs,
  },
  errorTitle: {
    color: colors.danger,
    fontFamily: fonts.black,
    fontSize: typography.heading,
    marginBottom: spacing.md,
  },
  errorText: {
    color: colors.textDim,
    fontFamily: fonts.regular,
    fontSize: typography.caption,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: spacing.sm,
  },
});
