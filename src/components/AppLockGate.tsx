/**
 * AppLockGate — v13 (round-19 #2) cold-start lock for the whole app.
 * ─────────────────────────────────────────────────────────────────
 * Wraps the app content in App.tsx. When ANY unlock method is
 * configured (fingerprint and/or 4-digit PIN) the gate locks on
 * process start and paints a full-screen overlay ABOVE the live view
 * tree (children stay mounted — navigation state, cart and printers
 * survive). On unlock the overlay disappears instantly.
 *
 * Deliberately an inline absolute overlay, NOT a <Modal>: the
 * merchant's ROM blacks out RN Modals shown right after the native
 * scanner closes (v11 lesson) — the inline overlay is immune and
 * needs no window focus juggling.
 *
 * Behaviour requested by the merchant:
 *  • fingerprint enabled → the system prompt appears AUTOMATICALLY
 *    the moment the lock shows; cancelling it falls back to the PIN
 *    (or a retry button when no PIN is set);
 *  • PIN only → the keypad appears immediately.
 *
 * The lock does NOT re-engage on app resume — the scanner/picker
 * native activities background the React activity constantly, and a
 * lock mid-scan would wreck the cashier flow. Cold start only.
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {BackHandler, Pressable, StyleSheet, Text, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {PinPad} from './PinPad';
import {Icon} from './Icon';
import {useAppLockStore} from '../stores/appLockStore';
import {biometricAuthenticate} from '../native/nativeBridge';
import {
  fonts,
  makeStyles,
  radius,
  spacing,
  typography,
  useThemeColors,
} from '../core/theme';
import {APP_NAME_AR} from '../core/config';

export function AppLockGate({children}: {children: React.ReactNode}) {
  const locked = useAppLockStore(s => s.locked);
  const pinHash = useAppLockStore(s => s.pinHash);
  const biometricEnabled = useAppLockStore(s => s.biometricEnabled);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [shakeSignal, setShakeSignal] = useState(0);
  const bioBusy = useRef(false);

  // Cold start: hydrate from MMKV, then lock when a method is on.
  useEffect(() => {
    useAppLockStore.getState().load();
    const s = useAppLockStore.getState();
    if (s.pinHash != null || s.biometricEnabled) {
      s.lock();
    }
  }, []);

  const tryBiometric = useCallback(async () => {
    if (bioBusy.current) {
      return;
    }
    bioBusy.current = true;
    try {
      const ok = await biometricAuthenticate(
        `الدخول إلى ${APP_NAME_AR}`,
        'استخدم بصمتك لفتح التطبيق',
        'استخدام رمز الدخول',
      );
      if (ok) {
        useAppLockStore.getState().unlock();
      }
    } finally {
      bioBusy.current = false;
    }
  }, []);

  // Auto-prompt the fingerprint the moment the lock appears — the
  // merchant asked for exactly this («يتم إظهار تسجيل الدخول بالبصمة
  // تلقائيا»). Cancelling simply falls back to the keypad below.
  useEffect(() => {
    if (locked && biometricEnabled) {
      void tryBiometric();
    }
  }, [locked, biometricEnabled, tryBiometric]);

  const handlePinSubmit = useCallback((pin: string) => {
    const ok = useAppLockStore.getState().verifyPin(pin);
    if (ok) {
      setErrorText(null);
      useAppLockStore.getState().unlock();
    } else {
      setErrorText('الرمز غير صحيح — حاول مجدداً');
      setShakeSignal(s => s + 1);
    }
  }, []);

  // Android hardware back must never dismiss the lock.
  useEffect(() => {
    if (!locked) {
      return;
    }
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, [locked]);

  // NOTE: the tree must stay IDENTICAL in both states — a wrapper
  // that appears only while locked would remount the whole navigator
  // (losing navigation + screen state) on every lock/unlock. The
  // overlay is simply an absolutely-positioned sibling painted on top.
  return (
    <View style={{flex: 1}}>
      {children}
      {locked ? (
        <LockOverlay
          pinHash={pinHash}
          biometricEnabled={biometricEnabled}
          errorText={errorText}
          shakeSignal={shakeSignal}
          onPinSubmit={handlePinSubmit}
          onBiometric={tryBiometric}
        />
      ) : null}
    </View>
  );
}

function LockOverlay({
  pinHash,
  biometricEnabled,
  errorText,
  shakeSignal,
  onPinSubmit,
  onBiometric,
}: {
  pinHash: string | null;
  biometricEnabled: boolean;
  errorText: string | null;
  shakeSignal: number;
  onPinSubmit: (pin: string) => void;
  onBiometric: () => void;
}) {
  const c = useThemeColors();
  const styles = useStyles();
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[styles.overlay, {backgroundColor: c.bg, paddingTop: insets.top}]}>
      <View style={styles.brandCol}>
        <View style={[styles.mark, {backgroundColor: c.accent}]}>
          <Text style={styles.markGlyph}>S</Text>
        </View>
        <Text style={styles.brandName}>{APP_NAME_AR}</Text>
        <Icon name="lock" size={15} color={c.textFaint} />
      </View>

      <View style={styles.padCol}>
        {pinHash != null ? (
          <PinPad
            title="التطبيق مقفل"
            subtitle="أدخل رمز الدخول للمتابعة"
            errorText={errorText}
            shakeSignal={shakeSignal}
            onSubmit={onPinSubmit}
            biometric={biometricEnabled ? {onPress: onBiometric} : null}
          />
        ) : (
          <View style={styles.bioOnly}>
            <Text style={styles.bioOnlyTitle}>التطبيق مقفل</Text>
            <Text style={styles.bioOnlyHint}>
              افتح التطبيق ببصمتك — اضغط على الأيقونة للمحاولة
            </Text>
            <Pressable
              style={({pressed}) => [
                styles.bioBig,
                {borderColor: c.accent},
                pressed ? {backgroundColor: c.accentSoft} : null,
              ]}
              onPress={onBiometric}
              android_ripple={{color: c.accentSoft, borderless: true}}>
              <Icon name="fingerprint" size={54} color={c.accent} />
            </Pressable>
            <Text style={styles.bioOnlyNote}>
              يمكن تفعيل رمز دخول احتياطي من: الإعدادات ← قفل التطبيق
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

const useStyles = makeStyles(c =>
  StyleSheet.create({
    overlay: {
      ...StyleSheet.absoluteFillObject,
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      zIndex: 9999,
      elevation: 9999,
    },
    brandCol: {
      alignItems: 'center',
      gap: 6,
      marginBottom: spacing.xl,
    },
    mark: {
      width: 74,
      height: 74,
      borderRadius: 22,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: spacing.xs,
    },
    markGlyph: {
      color: c.onAccent,
      fontFamily: fonts.black,
      fontSize: 42,
      lineHeight: 52,
      marginTop: 5,
    },
    brandName: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: typography.heading,
    },
    padCol: {
      width: '100%',
      alignItems: 'center',
      paddingHorizontal: spacing.lg,
    },
    bioOnly: {
      alignItems: 'center',
      paddingHorizontal: spacing.xl,
      gap: spacing.md,
    },
    bioOnlyTitle: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: typography.heading,
    },
    bioOnlyHint: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      textAlign: 'center',
    },
    bioBig: {
      width: 110,
      height: 110,
      borderRadius: radius.lg + 8,
      borderWidth: 2,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: spacing.sm,
    },
    bioOnlyNote: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      textAlign: 'center',
      marginTop: spacing.sm,
    },
  }),
);
