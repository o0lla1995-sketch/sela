/**
 * SecuritySettingsScreen — v13 (round-19 #2) app-lock setup.
 * ─────────────────────────────────────────────────────────────────
 * Two independent unlock methods for the cold-start lock:
 *  • fingerprint — availability probe + confirmation prompt;
 *  • 4-digit PIN — set / change / remove flows on the shared PinPad,
 *    every change or removal verified against the CURRENT pin first.
 *
 * The lock itself lives in AppLockGate (cold start only — never
 * mid-session, so the scanner/picker flows stay uninterrupted).
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {ScrollView, StyleSheet, Text, View} from 'react-native';
import {
  AppButton,
  AppHeader,
  Badge,
  Card,
  Screen,
  SectionTitle,
  SwitchRow,
} from '../../components/ui';
import {PinPad, type PinPadHandle} from '../../components/PinPad';
import {useAppLockStore} from '../../stores/appLockStore';
import {useToastStore} from '../../stores/toastStore';
import {
  biometricAuthenticate,
  biometricAvailability,
} from '../../native/nativeBridge';
import {
  fonts,
  makeStyles,
  spacing,
  typography,
  useThemeColors,
} from '../../core/theme';

type PinFlow =
  | null
  | 'set1'
  | 'set2'
  | 'changeVerify'
  | 'change1'
  | 'change2'
  | 'removeVerify';

export function SecuritySettingsScreen() {
  const c = useThemeColors();
  const styles = useStyles();
  const toast = useToastStore(state => state.show);
  const pinHash = useAppLockStore(s => s.pinHash);
  const biometricEnabled = useAppLockStore(s => s.biometricEnabled);
  const setPin = useAppLockStore(s => s.setPin);
  const clearPin = useAppLockStore(s => s.clearPin);
  const setBiometric = useAppLockStore(s => s.setBiometric);
  const verifyPin = useAppLockStore(s => s.verifyPin);

  const [availability, setAvailability] = useState<
    'available' | 'none_enrolled' | 'unavailable' | 'probing'
  >('probing');
  const [bioBusy, setBioBusy] = useState(false);
  const [flow, setFlow] = useState<PinFlow>(null);
  const [firstPin, setFirstPin] = useState('');
  const [flowError, setFlowError] = useState<string | null>(null);
  const [shakeSignal, setShakeSignal] = useState(0);
  const pinPadRef = useRef<PinPadHandle>(null);

  useEffect(() => {
    void biometricAvailability().then(setAvailability);
  }, []);

  const pinIsSet = pinHash != null;

  const resetFlow = useCallback(() => {
    setFlow(null);
    setFirstPin('');
    setFlowError(null);
    setShakeSignal(0);
  }, []);

  const wrongPin = useCallback((message: string) => {
    setFlowError(message);
    setShakeSignal(s => s + 1);
  }, []);

  /** The single PinPad drives every flow step. */
  const handleFlowPin = useCallback(
    (pin: string) => {
      switch (flow) {
        case 'set1':
        case 'change1':
          setFirstPin(pin);
          setFlowError(null);
          setFlow(flow === 'set1' ? 'set2' : 'change2');
          // Empty the pad for the confirmation entry.
          pinPadRef.current?.clear();
          break;
        case 'set2':
        case 'change2':
          if (pin === firstPin) {
            setPin(pin);
            toast('تم تعيين رمز الدخول — سيُطلب عند فتح التطبيق', 'success');
            resetFlow();
          } else {
            wrongPin('الرمزان غير متطابقين — أدخل الرمز من جديد');
            setFirstPin('');
            setFlow(flow === 'set2' ? 'set1' : 'change1');
          }
          break;
        case 'changeVerify':
          if (verifyPin(pin)) {
            setFlowError(null);
            setFlow('change1');
            // Empty the pad for the new-pin entry.
            pinPadRef.current?.clear();
          } else {
            wrongPin('الرمز الحالي غير صحيح');
          }
          break;
        case 'removeVerify':
          if (verifyPin(pin)) {
            clearPin();
            toast(
              biometricEnabled
                ? 'أُلغي رمز الدخول — بقي القفل بالبصمة'
                : 'أُلغي رمز الدخول — لم يعد التطبيق مقفلاً',
              'info',
            );
            resetFlow();
          } else {
            wrongPin('الرمز الحالي غير صحيح');
          }
          break;
        default:
          break;
      }
    },
    [
      biometricEnabled,
      clearPin,
      firstPin,
      flow,
      resetFlow,
      setPin,
      toast,
      verifyPin,
      wrongPin,
    ],
  );

  const handleBioToggle = useCallback(
    async (enable: boolean) => {
      if (!enable) {
        setBiometric(false);
        toast(
          pinIsSet
            ? 'أُلغي القفل بالبصمة — بقي رمز الدخول'
            : 'تم إيقاف قفل التطبيق بالكامل',
          'info',
        );
        return;
      }
      if (availability !== 'available') {
        toast(
          availability === 'none_enrolled'
            ? 'لا توجد بصمة مسجلة — سجّل بصمتك من إعدادات الهاتف أولاً ثم فعّل الخيار'
            : 'البصمة غير متاحة على هذا الجهاز — استخدم رمز الدخول',
          'error',
          5000,
        );
        return;
      }
      setBioBusy(true);
      const ok = await biometricAuthenticate(
        'تأكيد تفعيل البصمة',
        'استخدم بصمتك لتأكيد أنك صاحب الجهاز',
        'إلغاء',
      );
      setBioBusy(false);
      if (ok) {
        setBiometric(true);
        toast(
          'فُعّل الدخول بالبصمة — ستظهر تلقائياً عند فتح التطبيق',
          'success',
        );
      } else {
        toast('لم يكتمل التأكيد — لم يُفعّل القفل بالبصمة', 'info');
      }
    },
    [availability, pinIsSet, setBiometric, toast],
  );

  const flowTitles: Record<
    Exclude<PinFlow, null>,
    {title: string; subtitle: string}
  > = {
    set1: {title: 'تعيين رمز الدخول', subtitle: 'اختر رمزاً من 4 أرقام'},
    set2: {title: 'تأكيد الرمز', subtitle: 'أدخل الرمز نفسه مرة أخرى'},
    changeVerify: {
      title: 'التحقق من الرمز الحالي',
      subtitle: 'أدخل رمزك الحالي للمتابعة',
    },
    change1: {title: 'الرمز الجديد', subtitle: 'اختر رمزاً جديداً من 4 أرقام'},
    change2: {
      title: 'تأكيد الرمز الجديد',
      subtitle: 'أدخل الرمز الجديد نفسه مرة أخرى',
    },
    removeVerify: {
      title: 'التحقق قبل الإلغاء',
      subtitle: 'أدخل رمزك الحالي لإلغاء رمز الدخول',
    },
  };

  const lockActive = pinIsSet || biometricEnabled;

  return (
    <Screen>
      <AppHeader title="قفل التطبيق" subtitle="البصمة ورمز الدخول" />
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}>
        <Card style={styles.statusCard}>
          <View style={styles.statusRow}>
            <View style={styles.statusIconWrap}>
              <View
                style={[
                  styles.statusDot,
                  {
                    backgroundColor: lockActive ? c.success : c.border,
                  },
                ]}
              />
            </View>
            <View style={{flex: 1}}>
              <Text style={styles.statusTitle}>
                {lockActive ? 'القفل مفعّل' : 'القفل متوقف'}
              </Text>
              <Text style={styles.statusText}>
                {lockActive
                  ? 'سيُطلب الدخول عند فتح التطبيق في كل مرة'
                  : 'فعّل البصمة أو رمز الدخول لحماية متجرك'}
              </Text>
            </View>
            {lockActive ? <Badge label="مفعّل" tone="success" /> : null}
          </View>
        </Card>

        {/* ── Fingerprint ─────────────────────────────────── */}
        <Card style={styles.group}>
          <SectionTitle
            title="الدخول بالبصمة"
            hint={
              availability === 'probing'
                ? 'جارٍ فحص الجهاز…'
                : availability === 'available'
                ? 'متاحة على هذا الجهاز'
                : availability === 'none_enrolled'
                ? 'لم تُسجّل أي بصمة على الهاتف'
                : 'غير مدعومة على هذا الجهاز'
            }
          />
          <SwitchRow
            icon="fingerprint"
            label="فتح التطبيق بالبصمة"
            hint={
              availability === 'none_enrolled'
                ? 'سجّل بصمتك من إعدادات الهاتف (الأمان) أولاً'
                : 'تظهر نافذة البصمة تلقائياً عند فتح التطبيق'
            }
            value={biometricEnabled}
            onValueChange={value => void handleBioToggle(value)}
          />
          {bioBusy ? (
            <Text style={styles.hintText}>بانتظار تأكيد البصمة…</Text>
          ) : null}
        </Card>

        {/* ── PIN flows ───────────────────────────────────── */}
        {flow == null ? (
          <Card style={styles.group}>
            <SectionTitle
              title="رمز الدخول (4 أرقام)"
              hint={
                pinIsSet
                  ? 'رمز دخول احتياطي يعمل بلا بصمة'
                  : 'بديل كامل للبصمة أو خيار وحيد للقفل'
              }
            />
            {pinIsSet ? (
              <View style={styles.pinActions}>
                <AppButton
                  title="تغيير الرمز"
                  icon="key"
                  variant="secondary"
                  small
                  onPress={() => {
                    setFlowError(null);
                    setFlow('changeVerify');
                  }}
                />
                <AppButton
                  title="إلغاء الرمز"
                  icon="x"
                  variant="ghost"
                  small
                  onPress={() => {
                    setFlowError(null);
                    setFlow('removeVerify');
                  }}
                />
              </View>
            ) : (
              <AppButton
                title="تعيين رمز دخول"
                icon="key"
                variant="secondary"
                small
                onPress={() => {
                  setFlowError(null);
                  setFlow('set1');
                }}
              />
            )}
            <Text style={styles.hintText}>
              الرمز يُحفظ مشفّراً داخل الجهاز فقط — لا يُرسل لأي خادم، ولا يمكن
              استعادته إن نُسي (عندها أعد تعيينه بعد مسح بيانات التطبيق).
            </Text>
          </Card>
        ) : (
          <Card style={styles.group}>
            <View style={styles.padWrap}>
              <PinPad
                ref={pinPadRef}
                title={flowTitles[flow].title}
                subtitle={flowTitles[flow].subtitle}
                errorText={flowError}
                shakeSignal={shakeSignal}
                onSubmit={handleFlowPin}
              />
              <AppButton
                title="إلغاء"
                variant="ghost"
                small
                onPress={resetFlow}
              />
            </View>
          </Card>
        )}

        {/* ── How it works ────────────────────────────────── */}
        <Card style={styles.group}>
          <SectionTitle title="كيف يعمل القفل؟" />
          <Text style={styles.infoText}>
            عند فتح التطبيق تظهر شاشة القفل تلقائياً: البصمة أولاً إن كانت
            مفعّلة (تظهر فوراً دون أي ضغط)، ويمكن دائماً الدخول برمز الأرقام.
            القفل يظهر عند تشغيل التطبيق فقط ولا يقاطعك أثناء البيع أو المسح
            داخل الجهاز — صمّمناه سريعاً وعديم الإزعاج.
          </Text>
        </Card>
      </ScrollView>
    </Screen>
  );
}

const useStyles = makeStyles(c =>
  StyleSheet.create({
    content: {
      padding: spacing.lg,
      gap: spacing.md,
      paddingBottom: spacing.xxl,
    },
    statusCard: {
      paddingVertical: spacing.md,
    },
    statusRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
    },
    statusIconWrap: {
      width: 44,
      height: 44,
      borderRadius: 13,
      backgroundColor: c.surfaceAlt,
      alignItems: 'center',
      justifyContent: 'center',
    },
    statusDot: {
      width: 14,
      height: 14,
      borderRadius: 7,
    },
    statusTitle: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: typography.body,
    },
    statusText: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      marginTop: 1,
    },
    group: {
      gap: spacing.sm,
    },
    pinActions: {
      gap: spacing.sm,
    },
    padWrap: {
      gap: spacing.lg,
      alignItems: 'center',
      paddingVertical: spacing.sm,
    },
    hintText: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      lineHeight: 17,
    },
    infoText: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      lineHeight: 21,
    },
  }),
);
