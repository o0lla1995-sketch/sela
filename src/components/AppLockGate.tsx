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
 * v31 (round-39 #3) — «نقطة البيع قبل تسجيل الدخول»: طلب التاجر
 * أن يستطيع العامل البيع من غير فتح التطبيق، فصار الوضع المقفل
 * يعرض نقطة البيع بشكل طبيعي تماماً فوق شاشة القفل:
 *   • مقفل + مشترَك فعّال/سماح → وضع البيع السريع: شريط رقيق
 *     أعلى الشاشة (🔒 التطبيق مقفل — وضع البيع فقط) + زر «الدخول»
 *     بجانبه، وتحته نقطة البيع الحقيقية كاملة (بحث/مسح/سلة/
 *     بيع نقدي/بيع دين/طباعة/قسائم) — كلها فوق طبقة القفل بلا
 *     أي وصول لبقية التطبيق.
 *   • زر «الدخول» يفتح شاشة الدخول المعتادة (البصمة تُطلب
 *     تلقائياً فور فتحها، والبصمة تعمل بلا أي تعارض مع البيع).
 *   • بلا اشتراك فعّال (needs_activation/locked) تبقى شاشة القفل
 *     الكلاسيكية فقط — بوابة التفعيل تحتها تمنع التطبيق أصلاً.
 *
 * The lock does NOT re-engage on app resume — the scanner/picker
 * native activities background the React activity constantly, and a
 * lock mid-scan would wreck the cashier flow. Cold start only.
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  BackHandler,
  I18nManager,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {NavigationContainer} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {PinPad} from './PinPad';
import {Icon} from './Icon';
import {useAppLockStore} from '../stores/appLockStore';
import {useLicenseStore} from '../stores/licenseStore';
import {biometricAuthenticate} from '../native/nativeBridge';
import {PosScreen} from '../screens/PosScreen';
import {SilaScreen} from '../screens/sila/SilaScreen';
import {LocalDebtsScreen} from '../screens/debts/LocalDebtsScreen';
import {
  fonts,
  makeStyles,
  radius,
  spacing,
  typography,
  useThemeColors,
} from '../core/theme';
import {APP_NAME_AR} from '../core/config';

/** v31: الحد الأدنى للتنقل داخل وضع البيع — نقطة البيع نفسها
 *  (أزرار الدين تنتقل لصلة/دفتر الديون، فلا يتعطل أي زر). */
type QuickSaleStackList = {
  QuickSalePos: undefined;
  Sila: undefined;
  LocalDebts: undefined;
};
const QuickSaleStack = createNativeStackNavigator<QuickSaleStackList>();

export function AppLockGate({children}: {children: React.ReactNode}) {
  const locked = useAppLockStore(s => s.locked);
  const pinHash = useAppLockStore(s => s.pinHash);
  const biometricEnabled = useAppLockStore(s => s.biometricEnabled);
  /** v31: quick-sale POS is offered only when the license actually
   *  lets the app work (activation/gate would block it otherwise). */
  const licenseState = useLicenseStore(s => s.status?.state ?? null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [shakeSignal, setShakeSignal] = useState(0);
  /** v31: false = وضع البيع السريع (الافتراضي عند القفل)،
   *  true = شاشة الدخول (بصمة تلقائية + لوحة الرمز). */
  const [showLogin, setShowLogin] = useState(false);
  const bioBusy = useRef(false);

  const quickSaleAllowed =
    licenseState === null || licenseState === 'active' || licenseState === 'grace';

  // Cold start: hydrate from MMKV, then lock when a method is on.
  useEffect(() => {
    useAppLockStore.getState().load();
    const s = useAppLockStore.getState();
    if (s.pinHash != null || s.biometricEnabled) {
      s.lock();
    }
  }, []);

  // Back to the selling surface the moment the app unlocks — the
  // next lock cycle starts fresh at the quick-sale view.
  useEffect(() => {
    if (!locked) {
      setShowLogin(false);
    }
  }, [locked]);

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

  // Auto-prompt the fingerprint the moment the LOGIN view appears
  // (v13 behavior preserved — it simply fires on the login view now
  // instead of interrupting the selling surface at cold start).
  useEffect(() => {
    if (locked && showLogin && biometricEnabled) {
      void tryBiometric();
    }
  }, [locked, showLogin, biometricEnabled, tryBiometric]);

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
        quickSaleAllowed && !showLogin ? (
          <QuickSaleView
            biometricEnabled={biometricEnabled}
            onOpenLogin={() => setShowLogin(true)}
          />
        ) : (
          <LockOverlay
            pinHash={pinHash}
            biometricEnabled={biometricEnabled}
            errorText={errorText}
            shakeSignal={shakeSignal}
            onPinSubmit={handlePinSubmit}
            onBiometric={tryBiometric}
            onBackToSale={
              quickSaleAllowed ? () => setShowLogin(false) : undefined
            }
          />
        )
      ) : null}
    </View>
  );
}

// ────────────────────────────────────────────────────────────────
// v31 (round-39 #3) — QuickSaleView: نقطة البيع فوق شاشة القفل.
// ────────────────────────────────────────────────────────────────

function QuickSaleView({
  biometricEnabled,
  onOpenLogin,
}: {
  biometricEnabled: boolean;
  onOpenLogin: () => void;
}) {
  const c = useThemeColors();
  const styles = useStyles();
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.qsRoot, {backgroundColor: c.bg}]}>
      {/* شريط الوضع — رقيق، يغطي شريط الحالة، ويحمل زر الدخول */}
      <View style={[styles.qsBar, {paddingTop: insets.top}]}>
        <View style={styles.qsBarInner}>
          <View style={styles.qsLockChip}>
            <Icon name="lock" size={13} color={c.warning} />
            <Text style={styles.qsLockText} numberOfLines={1}>
              {APP_NAME_AR} — التطبيق مقفل · وضع البيع فقط
            </Text>
          </View>
          <TouchableOpacity
            style={styles.qsLoginBtn}
            onPress={onOpenLogin}
            activeOpacity={0.8}>
            <Icon
              name={biometricEnabled ? 'fingerprint' : 'key'}
              size={16}
              color={c.onAccent}
            />
            <Text style={styles.qsLoginText}>الدخول</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* نقطة البيع الحقيقية — بحاوية تنقل مستقلة تحمل الحد
          الأدنى من الشاشات (نقطة البيع + صلة + دفتر الديون) فكل
          أزرار شاشة البيع تعمل: البيع النقدي، البيع بالدين،
          القسائم، الطباعة — والسلة مشتركة مع التطبيق الأصلي. */}
      <View style={{flex: 1}}>
        <NavigationContainer>
          <QuickSaleStack.Navigator
            screenOptions={{
              headerShown: false,
              animation: I18nManager.isRTL
                ? 'slide_from_left'
                : 'slide_from_right',
              contentStyle: {backgroundColor: c.bg},
            }}>
            <QuickSaleStack.Screen name="QuickSalePos">
              {() => <PosScreen topGap={spacing.sm} />}
            </QuickSaleStack.Screen>
            <QuickSaleStack.Screen name="Sila" component={SilaScreen} />
            <QuickSaleStack.Screen
              name="LocalDebts"
              component={LocalDebtsScreen}
            />
          </QuickSaleStack.Navigator>
        </NavigationContainer>
      </View>
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
  onBackToSale,
}: {
  pinHash: string | null;
  biometricEnabled: boolean;
  errorText: string | null;
  shakeSignal: number;
  onPinSubmit: (pin: string) => void;
  onBiometric: () => void;
  /** v31: العودة لوضع البيع السريع دون فتح التطبيق. */
  onBackToSale?: () => void;
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

        {/* v31: الرجوع لنقطة البيع دون فتح التطبيق — العامل يبيع
            والمالك يدخل عند الحاجة. */}
        {onBackToSale != null ? (
          <TouchableOpacity
            style={styles.backToSaleBtn}
            onPress={onBackToSale}
            activeOpacity={0.8}>
            <Icon name="cart" size={16} color={c.accent} />
            <Text style={styles.backToSaleText}>رجوع لنقطة البيع</Text>
          </TouchableOpacity>
        ) : null}
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
    /** v31 (round-39 #3): وضع البيع السريع — الجذر والشريط. */
    qsRoot: {
      ...StyleSheet.absoluteFillObject,
      flex: 1,
      zIndex: 9999,
      elevation: 9999,
    },
    qsBar: {
      backgroundColor: c.surface,
      borderBottomWidth: 1,
      borderBottomColor: c.borderSoft,
    },
    qsBarInner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingBottom: 7,
      paddingTop: 7,
      minHeight: 44,
    },
    qsLockChip: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      backgroundColor: c.warningSoft,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.sm + 2,
      paddingVertical: 5,
    },
    qsLockText: {
      flex: 1,
      color: c.warning,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    qsLoginBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      backgroundColor: c.accent,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: 8,
    },
    qsLoginText: {
      color: c.onAccent,
      fontFamily: fonts.black,
      fontSize: typography.small,
    },
    /** v31: زر الرجوع لنقطة البيع من شاشة الدخول. */
    backToSaleBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      borderWidth: 1.5,
      borderColor: c.accentSoft,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.lg,
      paddingVertical: 10,
      marginTop: spacing.xl,
      backgroundColor: c.surface,
    },
    backToSaleText: {
      color: c.accent,
      fontFamily: fonts.black,
      fontSize: typography.small,
    },
  }),
);
