/**
 * App root — initialization pipeline + navigation host.
 * ─────────────────────────────────────────────────────────────────
 * Boot order matters:
 *  1. SQLite schema bootstrap (blocking — nothing works without it)
 *  2. Catalog + embeddings index refresh
 *  3. TFLite vision model load (async — screens degrade gracefully)
 *  4. Printer auto-reconnect (silent best-effort)
 */
import React, {useEffect, useState} from 'react';
import {
  StatusBar,
  StyleSheet,
  Text,
  View,
  ActivityIndicator,
} from 'react-native';
import {GestureHandlerRootView} from 'react-native-gesture-handler';

import {HomeScreen} from './src/screens/HomeScreen';
import {PosScreen} from './src/screens/PosScreen';
import {InventoryScreen} from './src/screens/inventory/InventoryScreen';
import {ProductFormScreen} from './src/screens/inventory/ProductFormScreen';
import {ReportsScreen} from './src/screens/reports/ReportsScreen';
import {PrinterSettingsScreen} from './src/screens/printer/PrinterSettingsScreen';
import {SettingsScreen} from './src/screens/settings/SettingsScreen';
import {DiagnosticsScreen} from './src/screens/settings/DiagnosticsScreen';

import {Toaster} from './src/components/ui';
import {useNavigation} from './src/core/navigation';
import {initDatabase} from './src/database/connection';
import {useCatalogStore} from './src/stores/catalogStore';
import {useCartStore} from './src/stores/cartStore';
import {useSettingsStore} from './src/stores/settingsStore';
import {usePrinterStore} from './src/stores/printerStore';
import {VisionRecognitionService} from './src/services/vision/VisionRecognitionService';
import {logDiag} from './src/core/diagnostics';
import {colors, spacing, typography, statusbarHeight} from './src/core/theme';
import {APP_NAME} from './src/core/config';

type BootState = 'booting' | 'ready' | 'error';

export default function App(): React.JSX.Element {
  const [boot, setBoot] = useState<BootState>('booting');
  const [bootError, setBootError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const boot = async () => {
      try {
        // 1. Database schema (must succeed).
        await initDatabase();

        // 2. Catalog & vision index.
        await useCatalogStore.getState().refresh();

        // 3. Vision model — failure keeps the app usable manually.
        await VisionRecognitionService.loadModel();

        // 4. Apply default pricing mode to a fresh cart.
        const settings = useSettingsStore.getState().settings;
        const cart = useCartStore.getState();
        if (cart.lines.length === 0) {
          cart.setPricingMode(settings.defaultPricingMode);
        }

        // 5. Silent printer auto-reconnect.
        void usePrinterStore.getState().connectSaved();

        if (mounted) setBoot('ready');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logDiag('boot', `فشل إقلاع التطبيق: ${message}`, 'error');
        if (mounted) {
          setBootError(message);
          setBoot('error');
        }
      }
    };
    void boot();
    return () => {
      mounted = false;
    };
  }, []);

  const current = useNavigation(state => state.current);

  return (
    <GestureHandlerRootView style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
      <View style={styles.safe}>
        {boot === 'booting' ? (
          <BootSplash />
        ) : boot === 'error' ? (
          <BootError message={bootError ?? 'خطأ غير معروف'} />
        ) : (
          <View style={styles.screenHost}>
            {renderScreen(current.name, current.params?.productId)}
          </View>
        )}
        <Toaster />
      </View>
    </GestureHandlerRootView>
  );
}

function renderScreen(name: string, productId?: number): React.JSX.Element {
  switch (name) {
    case 'pos':
      return <PosScreen />;
    case 'inventory':
      return <InventoryScreen />;
    case 'product-form':
      return <ProductFormScreen productId={productId} />;
    case 'reports':
      return <ReportsScreen />;
    case 'printer':
      return <PrinterSettingsScreen />;
    case 'settings':
      return <SettingsScreen />;
    case 'diagnostics':
      return <DiagnosticsScreen />;
    case 'home':
    default:
      return <HomeScreen />;
  }
}

function BootSplash(): React.JSX.Element {
  return (
    <View style={styles.center}>
      <Text style={styles.splashTitle}>{APP_NAME}</Text>
      <Text style={styles.splashSubtitle}>نقطة بيع ذكية — يعمل بدون إنترنت</Text>
      <ActivityIndicator color={colors.accent} size="large" style={{marginTop: spacing.xl}} />
    </View>
  );
}

function BootError({message}: {message: string}): React.JSX.Element {
  return (
    <View style={styles.center}>
      <Text style={styles.errorEmoji}>⚠️</Text>
      <Text style={styles.errorTitle}>تعذّر تشغيل التطبيق</Text>
      <Text style={styles.errorText}>{message}</Text>
      <Text style={styles.errorText}>
        أعد تشغيل التطبيق — إذا استمرت المشكلة استخدم شاشة التشخيص من الإعدادات
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
    paddingTop: statusbarHeight,
  },
  screenHost: {
    flex: 1,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    backgroundColor: colors.bg,
  },
  splashTitle: {
    color: colors.accent,
    fontSize: 32,
    fontWeight: '900',
  },
  splashSubtitle: {
    color: colors.textDim,
    fontSize: typography.caption,
    marginTop: spacing.sm,
  },
  errorEmoji: {fontSize: 48, marginBottom: spacing.md},
  errorTitle: {
    color: colors.danger,
    fontSize: typography.heading,
    fontWeight: '900',
    marginBottom: spacing.md,
  },
  errorText: {
    color: colors.textDim,
    fontSize: typography.caption,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: spacing.sm,
  },
});
