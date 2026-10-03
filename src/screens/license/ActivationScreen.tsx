/**
 * ActivationScreen — the subscription gate.
 * ─────────────────────────────────────────────────────────────────
 * Shown by LicenseGate until a valid paid subscription is active:
 *  - needs_activation: key entry + management contact info
 *  - locked (expired / revoked / offline too long): status
 *    explanation + re-verify + contact info
 *
 * The screen never crashes on network errors — every failure maps
 * to a readable Arabic message from LicenseService.
 */
import React, {useMemo, useState} from 'react';
import {
  ActivityIndicator,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {Icon} from '../../components/Icon';
import {
  fonts,
  makeStyles,
  radius,
  spacing,
  useThemeColors,
} from '../../core/theme';
import {
  APP_NAME,
  APP_NAME_AR,
  APP_VERSION,
  LICENSE_CONTACT_FALLBACK,
} from '../../core/config';
import {
  activateLicense,
  getDeviceId,
  getServerUrl,
  setServerUrl,
  LicenseError,
  getCachedContact,
  type LicenseStatus,
} from '../../services/license/LicenseService';
import {useLicenseStore} from '../../stores/licenseStore';

const LOCK_REASONS: Record<string, {title: string; body: string}> = {
  expired: {
    title: 'انتهى اشتراك sela',
    body: 'انتهت صلاحية اشتراكك في التطبيق. جدّد الاشتراك لدى الإدارة ثم أعد التفعيل بمفتاحك الجديد.',
  },
  revoked: {
    title: 'تم إيقاف الاشتراك',
    body: 'أوقفت الإدارة هذا الاشتراك. تواصل مع الإدارة لمعرفة السبب أو للاشتراك من جديد.',
  },
  offline_too_long: {
    title: 'مطلوب اتصال بالسيرفر',
    body: 'لم يتم التحقق من الاشتراك عبر الإنترنت لفترة طويلة. اتصل بالإنترنت واضغط "إعادة التحقق الآن" — تُنجز عملية كاملة بعد الاتصال بدقائق.',
  },
  unknown_device: {
    title: 'جهاز غير مرتبط',
    body: 'هذا الجهاز غير مرتبط بالاشتراك الحالي. أعد التفعيل بمفتاحك.',
  },
};

/** Formats raw typing into SELA-XXXXX-XXXXX-XXXXX. */
function formatKeyInput(raw: string): string {
  const clean = raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 17);
  const parts = [
    clean.slice(0, 4),
    clean.slice(4, 9),
    clean.slice(9, 14),
    clean.slice(14, 17),
  ].filter(Boolean);
  return parts.join('-');
}

function isValidKeyFormat(key: string): boolean {
  return /^SELA-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{3}$/.test(key);
}

export function ActivationScreen({status}: {status: LicenseStatus}) {
  const c = useThemeColors();
  const styles = useStyles();
  const refresh = useLicenseStore(state => state.refresh);
  const verifyOnline = useLicenseStore(state => state.verifyOnline);

  const [keyText, setKeyText] = useState('');
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [serverUrlText, setServerUrlText] = useState(getServerUrl());
  const [deviceId, setDeviceId] = useState('');

  useMemo(() => {
    void getDeviceId().then(id => setDeviceId(id));
  }, []);

  const locked = status.state === 'locked';
  const reason = locked ? LOCK_REASONS[status.lockReason ?? 'expired'] : null;

  // Server-provided contact (cached) with baked-in fallbacks.
  const contact = {...LICENSE_CONTACT_FALLBACK, ...getCachedContact()};

  const runActivate = async () => {
    if (busy) return;
    setError(null);
    if (!isValidKeyFormat(keyText)) {
      setError('صيغة المفتاح غير صحيحة — الشكل: SELA-XXXXX-XXXXX-XXX');
      return;
    }
    setBusy(true);
    try {
      setServerUrl(serverUrlText);
      await activateLicense(keyText, setPhase);
      await refresh();
    } catch (e) {
      setError(
        e instanceof LicenseError
          ? e.message
          : 'تعذر التفعيل — تحقق من الإنترنت وحاول مجدداً',
      );
    } finally {
      setBusy(false);
      setPhase('');
    }
  };

  const runReverify = async () => {
    if (busy) return;
    setError(null);
    setBusy(true);
    setPhase('جارٍ الاتصال بالسيرفر…');
    try {
      setServerUrl(serverUrlText);
      await verifyOnline(true);
      await refresh();
    } catch {
      setError('تعذر الوصول إلى السيرفر — تحقق من الإنترنت');
    } finally {
      setBusy(false);
      setPhase('');
    }
  };

  return (
    <View style={styles.root}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled">
        {/* Brand */}
        <View style={styles.brandRow}>
          <View style={styles.brandMark}>
            <Icon name="basket" size={30} color="#FFFFFF" />
          </View>
          <View style={styles.brandText}>
            <Text style={styles.brandName}>{APP_NAME_AR}</Text>
            <Text style={styles.brandSub}>
              {APP_NAME} · نظام نقاط البيع الذكي
            </Text>
          </View>
        </View>

        {/* Headline card */}
        <View style={styles.card}>
          <View style={styles.cardIconWrap}>
            <Icon name={locked ? 'lock' : 'key'} size={26} color={c.accent} />
          </View>
          <Text style={styles.title}>
            {locked ? reason?.title ?? 'الاشتراك موقوف' : 'فعّل اشتراكك'}
          </Text>
          <Text style={styles.body}>
            {locked
              ? reason?.body ?? 'لا يمكن استخدام التطبيق قبل تفعيل اشتراك صالح.'
              : 'sela يعمل باشتراك مدفوع (شهري أو سنوي). أدخل مفتاح التفعيل الذي استلمته من الإدارة لبدء الاستخدام.'}
          </Text>

          {locked && status.license ? (
            <View style={styles.statusRow}>
              <View style={styles.statusChip}>
                <Text style={styles.statusChipLabel}>الخطة</Text>
                <Text style={styles.statusChipValue}>
                  {status.license.plan === 'yearly'
                    ? 'سنوي'
                    : status.license.plan === 'monthly'
                    ? 'شهري'
                    : 'مخصص'}
                </Text>
              </View>
              <View style={styles.statusChip}>
                <Text style={styles.statusChipLabel}>انتهى بتاريخ</Text>
                <Text style={styles.statusChipValue}>
                  {new Date(status.license.expiresAt).toLocaleDateString(
                    'ar-EG',
                  )}
                </Text>
              </View>
            </View>
          ) : null}
        </View>

        {/* Key entry (needs_activation + expired/unknown → re-activate) */}
        {!locked ||
        status.lockReason === 'expired' ||
        status.lockReason === 'unknown_device' ? (
          <View style={styles.card}>
            <Text style={styles.fieldLabel}>مفتاح التفعيل</Text>
            <TextInput
              style={styles.keyInput}
              value={keyText}
              onChangeText={text => setKeyText(formatKeyInput(text))}
              placeholder="SELA-XXXXX-XXXXX-XXX"
              placeholderTextColor={c.textDim}
              autoCapitalize="characters"
              autoCorrect={false}
              editable={!busy}
              textAlign="center"
            />
            <TouchableOpacity
              style={[
                styles.primaryButton,
                busy ? styles.buttonDisabled : null,
              ]}
              onPress={() => void runActivate()}
              disabled={busy}
              activeOpacity={0.85}>
              {busy ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Icon name="key" size={18} color="#FFFFFF" />
              )}
              <Text style={styles.primaryButtonText}>
                {busy ? phase || 'جارٍ التفعيل…' : 'تفعيل الاشتراك'}
              </Text>
            </TouchableOpacity>
            {error ? (
              <View style={styles.errorBox}>
                <Icon name="alert" size={15} color={c.danger} />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}
          </View>
        ) : (
          <View style={styles.card}>
            <TouchableOpacity
              style={[
                styles.primaryButton,
                busy ? styles.buttonDisabled : null,
              ]}
              onPress={() => void runReverify()}
              disabled={busy}
              activeOpacity={0.85}>
              {busy ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Icon name="refresh" size={18} color="#FFFFFF" />
              )}
              <Text style={styles.primaryButtonText}>
                {busy ? phase || 'جارٍ التحقق…' : 'إعادة التحقق الآن'}
              </Text>
            </TouchableOpacity>
            {error ? (
              <View style={styles.errorBox}>
                <Icon name="alert" size={15} color={c.danger} />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}
          </View>
        )}

        {/* Device id */}
        <View style={styles.deviceRow}>
          <Icon name="shield" size={13} color={c.textDim} />
          <Text style={styles.deviceText} selectable>
            معرّف الجهاز: {deviceId || '…'}
          </Text>
        </View>

        {/* Contact card — subscriptions are sold by the management */}
        <View style={styles.card}>
          <Text style={styles.contactTitle}>لشراء الاشتراك أو تجديده</Text>
          <Text style={styles.contactNote}>{contact.note}</Text>
          <TouchableOpacity
            style={styles.contactRow}
            onPress={() =>
              void Linking.openURL(`tel:${contact.phone.replace(/\s/g, '')}`)
            }>
            <Icon name="phone" size={16} color={c.accent} />
            <Text style={styles.contactValue}>{contact.phone}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.contactRow}
            onPress={() =>
              void Linking.openURL(
                `https://wa.me/${contact.whatsapp.replace(/[^\d]/g, '')}`,
              )
            }>
            <Icon name="send" size={16} color={c.accent} />
            <Text style={styles.contactValue}>واتساب الإدارة</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.contactRow}
            onPress={() => void Linking.openURL(`mailto:${contact.email}`)}>
            <Icon name="mail" size={16} color={c.accent} />
            <Text style={styles.contactValue}>{contact.email}</Text>
          </TouchableOpacity>
        </View>

        {/* Advanced: server URL (for management migrations) */}
        <TouchableOpacity
          style={styles.advancedToggle}
          onPress={() => setShowAdvanced(value => !value)}>
          <Icon name="chevronDown" size={14} color={c.textDim} />
          <Text style={styles.advancedText}>
            إعدادات متقدمة (سيرفر التفعيل)
          </Text>
        </TouchableOpacity>
        {showAdvanced ? (
          <View style={styles.card}>
            <Text style={styles.fieldLabel}>عنوان سيرفر التفعيل</Text>
            <TextInput
              style={styles.urlInput}
              value={serverUrlText}
              onChangeText={setServerUrlText}
              placeholder="https://…"
              placeholderTextColor={c.textDim}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!busy}
              textAlign="left"
            />
            <Text style={styles.urlHint}>
              عدّل هذا العنوان فقط إذا طلبت منك الإدارة ذلك.
            </Text>
          </View>
        ) : null}

        <Text style={styles.version}>sela {APP_VERSION}</Text>
      </ScrollView>
    </View>
  );
}

const useStyles = makeStyles(c =>
  StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: c.bg,
    },
    scroll: {
      flexGrow: 1,
      padding: spacing.lg,
      paddingBottom: 40,
    },
    brandRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 14,
      alignSelf: 'center',
      marginTop: 18,
      marginBottom: 22,
    },
    brandMark: {
      width: 58,
      height: 58,
      borderRadius: 18,
      backgroundColor: c.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    brandText: {
      gap: 2,
    },
    brandName: {
      fontFamily: fonts.bold,
      fontSize: 30,
      color: c.text,
    },
    brandSub: {
      fontFamily: fonts.regular,
      fontSize: 12.5,
      color: c.textDim,
    },
    card: {
      backgroundColor: c.surface,
      borderRadius: radius.lg,
      padding: spacing.lg,
      gap: 12,
      marginBottom: spacing.md,
      borderWidth: 1,
      borderColor: c.border,
    },
    cardIconWrap: {
      width: 52,
      height: 52,
      borderRadius: 16,
      backgroundColor: c.surfaceAlt,
      alignItems: 'center',
      justifyContent: 'center',
    },
    title: {
      fontFamily: fonts.bold,
      fontSize: 20,
      color: c.text,
    },
    body: {
      fontFamily: fonts.regular,
      fontSize: 13.5,
      lineHeight: 22,
      color: c.textDim,
    },
    statusRow: {
      flexDirection: 'row',
      gap: 10,
    },
    statusChip: {
      flex: 1,
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.md,
      padding: 10,
      gap: 2,
    },
    statusChipLabel: {
      fontFamily: fonts.regular,
      fontSize: 11,
      color: c.textDim,
    },
    statusChipValue: {
      fontFamily: fonts.bold,
      fontSize: 14,
      color: c.text,
    },
    fieldLabel: {
      fontFamily: fonts.bold,
      fontSize: 13,
      color: c.text,
    },
    keyInput: {
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
      paddingVertical: 13,
      paddingHorizontal: 14,
      fontFamily: fonts.bold,
      fontSize: 16.5,
      color: c.text,
      letterSpacing: 1,
    },
    primaryButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 9,
      backgroundColor: c.accent,
      borderRadius: radius.md,
      paddingVertical: 14,
    },
    buttonDisabled: {
      opacity: 0.65,
    },
    primaryButtonText: {
      fontFamily: fonts.bold,
      fontSize: 15,
      color: '#FFFFFF',
    },
    errorBox: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: c.dangerSoft,
      borderRadius: radius.md,
      padding: 11,
    },
    errorText: {
      flex: 1,
      fontFamily: fonts.regular,
      fontSize: 12.5,
      lineHeight: 19,
      color: c.danger,
    },
    deviceRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
      justifyContent: 'center',
      marginBottom: spacing.md,
    },
    deviceText: {
      fontFamily: fonts.regular,
      fontSize: 11.5,
      color: c.textDim,
    },
    contactTitle: {
      fontFamily: fonts.bold,
      fontSize: 15,
      color: c.text,
    },
    contactNote: {
      fontFamily: fonts.regular,
      fontSize: 12.5,
      lineHeight: 20,
      color: c.textDim,
    },
    contactRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingVertical: 9,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
    },
    contactValue: {
      fontFamily: fonts.bold,
      fontSize: 13.5,
      color: c.text,
    },
    advancedToggle: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      alignSelf: 'center',
      padding: 10,
    },
    advancedText: {
      fontFamily: fonts.regular,
      fontSize: 12,
      color: c.textDim,
    },
    urlInput: {
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
      paddingVertical: 11,
      paddingHorizontal: 12,
      fontFamily: fonts.regular,
      fontSize: 13,
      color: c.text,
    },
    urlHint: {
      fontFamily: fonts.regular,
      fontSize: 11,
      color: c.textDim,
    },
    version: {
      fontFamily: fonts.regular,
      fontSize: 11,
      color: c.textDim,
      textAlign: 'center',
      marginTop: 8,
    },
  }),
);
