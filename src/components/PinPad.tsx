/**
 * PinPad — v13 (round-19 #2) reusable 4-digit PIN keypad.
 * ─────────────────────────────────────────────────────────────────
 * Self-managed digit buffer: when the 4th digit lands the pad fires
 * onSubmit(pin) exactly once. The parent signals a wrong attempt by
 * bumping `shakeSignal` — the pad clears itself and plays a shake +
 * shows `errorText`. Correct attempts normally unmount whatever
 * screen owns the pad, so no success API is needed.
 *
 * Used by both the cold-start lock screen (AppLockGate) and the
 * PIN setup/change/remove flows (SecuritySettingsScreen).
 */
import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import {Animated, Pressable, StyleSheet, Text, View} from 'react-native';
import {Icon} from './Icon';
import {
  fonts,
  makeStyles,
  radius,
  spacing,
  typography,
  useThemeColors,
} from '../core/theme';

export interface PinPadHandle {
  /** Clears the entered digits (no shake). */
  clear: () => void;
}

interface PinPadProps {
  title: string;
  subtitle?: string;
  /** Shown above the dots when non-null (wrong-pin message). */
  errorText?: string | null;
  /** Parent bumps this number to clear + shake (wrong attempt). */
  shakeSignal?: number;
  /** Fires once when the buffer reaches 4 digits. */
  onSubmit: (pin: string) => void;
  /** Optional fingerprint action (bottom-left corner key). */
  biometric?: {onPress: () => void} | null;
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

export const PinPad = forwardRef<PinPadHandle, PinPadProps>(function PinPad(
  {title, subtitle, errorText, shakeSignal = 0, onSubmit, biometric},
  ref,
) {
  const c = useThemeColors();
  const styles = useStyles();
  const [digits, setDigits] = useState('');
  const shake = useRef(new Animated.Value(0)).current;
  const submittedRef = useRef('');

  useImperativeHandle(ref, () => ({
    clear: () => {
      submittedRef.current = '';
      setDigits('');
    },
  }));

  // Wrong-attempt signal → clear + shake.
  useEffect(() => {
    if (shakeSignal === 0) {
      return;
    }
    submittedRef.current = '';
    setDigits('');
    shake.setValue(0);
    Animated.sequence([
      Animated.timing(shake, {
        toValue: 1,
        duration: 50,
        useNativeDriver: true,
      }),
      Animated.timing(shake, {
        toValue: -1,
        duration: 90,
        useNativeDriver: true,
      }),
      Animated.timing(shake, {
        toValue: 0.6,
        duration: 70,
        useNativeDriver: true,
      }),
      Animated.timing(shake, {
        toValue: 0,
        duration: 60,
        useNativeDriver: true,
      }),
    ]).start();
  }, [shakeSignal, shake]);

  // Fire onSubmit exactly once per completed buffer.
  useEffect(() => {
    if (digits.length === 4 && digits !== submittedRef.current) {
      submittedRef.current = digits;
      onSubmit(digits);
    }
  }, [digits, onSubmit]);

  const pressKey = (key: string) => {
    if (digits.length >= 4) {
      return;
    }
    setDigits(d => (d.length < 4 ? d + key : d));
  };

  const backspace = () => {
    submittedRef.current = '';
    setDigits(d => d.slice(0, Math.max(0, d.length - 1)));
  };

  const shakeX = shake.interpolate({
    inputRange: [-1, 0, 1],
    outputRange: [-9, 0, 9],
  });

  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>{title}</Text>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      {errorText != null ? (
        <Text style={styles.errorText}>{errorText}</Text>
      ) : null}

      <Animated.View
        style={[styles.dotsRow, {transform: [{translateX: shakeX}]}]}>
        {[0, 1, 2, 3].map(i => (
          <View
            key={i}
            style={[
              styles.dot,
              i < digits.length ? {backgroundColor: c.accent} : null,
            ]}
          />
        ))}
      </Animated.View>

      <View style={styles.keypad}>
        {KEYS.map(key => (
          <Pressable
            key={key}
            style={({pressed}) => [
              styles.key,
              pressed ? {backgroundColor: c.surfaceHi} : null,
            ]}
            onPress={() => pressKey(key)}
            android_ripple={{color: c.surfaceHi, borderless: false}}>
            <Text style={styles.keyText}>{key}</Text>
          </Pressable>
        ))}
        {biometric != null ? (
          <Pressable
            style={({pressed}) => [
              styles.key,
              pressed ? {backgroundColor: c.surfaceHi} : null,
            ]}
            onPress={biometric.onPress}
            android_ripple={{color: c.surfaceHi, borderless: false}}>
            <Icon name="fingerprint" size={26} color={c.accent} />
          </Pressable>
        ) : (
          <View style={styles.keyGhost} />
        )}
        <Pressable
          style={({pressed}) => [
            styles.key,
            pressed ? {backgroundColor: c.surfaceHi} : null,
          ]}
          onPress={() => pressKey('0')}
          android_ripple={{color: c.surfaceHi, borderless: false}}>
          <Text style={styles.keyText}>0</Text>
        </Pressable>
        <Pressable
          style={({pressed}) => [
            styles.key,
            pressed ? {backgroundColor: c.surfaceHi} : null,
          ]}
          onPress={backspace}
          android_ripple={{color: c.surfaceHi, borderless: false}}>
          <Icon
            name="backspace"
            size={22}
            color={digits.length > 0 ? c.text : c.textFaint}
          />
        </Pressable>
      </View>
    </View>
  );
});

const useStyles = makeStyles(c =>
  StyleSheet.create({
    wrap: {
      alignItems: 'center',
      width: '100%',
    },
    title: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: typography.heading,
      textAlign: 'center',
    },
    subtitle: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      textAlign: 'center',
      marginTop: 4,
    },
    errorText: {
      color: c.danger,
      fontFamily: fonts.bold,
      fontSize: typography.small,
      textAlign: 'center',
      marginTop: spacing.sm,
    },
    dotsRow: {
      flexDirection: 'row',
      gap: spacing.lg,
      marginTop: spacing.lg,
      marginBottom: spacing.xl,
    },
    dot: {
      width: 14,
      height: 14,
      borderRadius: 7,
      borderWidth: 2,
      borderColor: c.border,
      backgroundColor: 'transparent',
    },
    keypad: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'center',
      gap: spacing.sm,
      width: '100%',
      maxWidth: 300,
    },
    key: {
      width: 84,
      height: 64,
      borderRadius: radius.lg,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderSoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    keyGhost: {
      width: 84,
      height: 64,
    },
    keyText: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: 24,
      fontVariant: ['tabular-nums'],
    },
  }),
);
