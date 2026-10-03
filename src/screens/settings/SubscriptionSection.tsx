/**
 * SubscriptionSection — Settings → الاشتراك.
 * ─────────────────────────────────────────────────────────────────
 * Everything the merchant needs to know about their paid sela
 * subscription at a glance (merchant's request):
 *  - state (مفعّل / فترة سماح / موقوف), plan, expiry date,
 *    remaining days, device id, last server verification
 *  - manual "إعادة التحقق الآن" (online heartbeat)
 *  - "إلغاء ربط الجهاز" — frees the device slot to move the
 *    subscription to a new phone
 *  - management contact card for buying/renewing subscriptions
 */
import React, {useCallback, useState} from 'react';
import {
  Alert,
  Linking,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {Icon} from '../../components/Icon';
import {AppButton} from '../../components/ui';
import {
  fonts,
  makeStyles,
  radius,
  spacing,
  useThemeColors,
} from '../../core/theme';
import {LICENSE_CONTACT_FALLBACK} from '../../core/config';
import {useLicenseStore} from '../../stores/licenseStore';
import {
  getDeviceId,
  unbindDevice,
  getCachedContact,
} from '../../services/license/LicenseService';

function planLabel(plan: string | undefined): string {
  switch (plan) {
    case 'yearly':
      return 'سنوي';
    case 'monthly':
      return 'شهري';
    case 'custom':
      return 'مخصص';
    default:
      return '—';
  }
}

export function SubscriptionSection() {
  const c = useThemeColors();
  const styles = useStyles();
  const status = useLicenseStore(state => state.status);
  const refresh = useLicenseStore(state => state.refresh);
  const verifyOnline = useLicenseStore(state => state.verifyOnline);

  const [verifying, setVerifying] = useState(false);
  const [deviceId, setDeviceId] = useState('');

  React.useEffect(() => {
    void getDeviceId().then(setDeviceId);
  }, []);

  const contact = getCachedContact() ?? LICENSE_CONTACT_FALLBACK;

  const license = status?.license ?? null;
  const remainingDays =
    license != null
      ? Math.max(0, Math.ceil((license.expiresAt - Date.now()) / 86400000))
      : 0;
  const state = status?.state ?? 'needs_activation';
  const isGrace = state === 'grace';
  const isActive = state === 'active';

  const runVerify = useCallback(async () => {
    setVerifying(true);
    try {
      await verifyOnline(true);
      await refresh();
    } finally {
      setVerifying(false);
    }
  }, [verifyOnline, refresh]);

  const confirmUnbind = useCallback(() => {
    Alert.alert(
      'إلغاء ربط الجهاز',
      'سيتم فك ارتباط الاشتراك بهذا الجهاز وسيعود التطبيق لشاشة التفعيل. يمكنك بعدها تفعيل المفتاح على جهاز آخر ضمن حد الأجهزة المسموح. هل أنت متأكد؟',
      [
        {text: 'إلغاء', style: 'cancel'},
        {
          text: 'نعم، إلغاء الربط',
          style: 'destructive',
          onPress: async () => {
            await unbindDevice();
            await refresh();
          },
        },
      ],
    );
  }, [refresh]);

  return (
    <View style={styles.group}>
      {/* Status header row */}
      <View style={styles.headerRow}>
        <View style={styles.headerLeft}>
          <Icon
            name={isActive || isGrace ? 'shield' : 'lock'}
            size={22}
            color={isActive ? c.success : isGrace ? c.warning : c.danger}
          />
          <View style={{gap: 1}}>
            <Text style={styles.title}>الاشتراك</Text>
            <Text style={styles.subtitle}>
              خطة sela المدفوعة وحالتها التفصيلية
            </Text>
          </View>
        </View>
        <View
          style={[
            styles.stateChip,
            isActive && {backgroundColor: c.successSoft},
            isGrace && {backgroundColor: c.warningSoft},
            !isActive && !isGrace && {backgroundColor: c.dangerSoft},
          ]}>
          <Text
            style={[
              styles.stateChipText,
              isActive && {color: c.success},
              isGrace && {color: c.warning},
              !isActive && !isGrace && {color: c.danger},
            ]}>
            {isActive ? 'مفعّل' : isGrace ? 'فترة سماح' : 'موقوف'}
          </Text>
        </View>
      </View>

      {license != null ? (
        <>
          <View style={styles.infoGrid}>
            <View style={styles.infoCell}>
              <Text style={styles.infoLabel}>الخطة</Text>
              <Text style={styles.infoValue}>{planLabel(license.plan)}</Text>
            </View>
            <View style={styles.infoCell}>
              <Text style={styles.infoLabel}>المدة المتبقية</Text>
              <Text
                style={[
                  styles.infoValue,
                  remainingDays <= 5 ? {color: c.warning} : null,
                ]}>
                {remainingDays} يوم
              </Text>
            </View>
            <View style={styles.infoCell}>
              <Text style={styles.infoLabel}>تاريخ الانتهاء</Text>
              <Text style={styles.infoValue}>
                {new Date(license.expiresAt).toLocaleDateString('ar-EG')}
              </Text>
            </View>
            <View style={styles.infoCell}>
              <Text style={styles.infoLabel}>فحص سيرفر منذ</Text>
              <Text style={styles.infoValue}>
                {status != null && status.offlineHours < 1
                  ? 'الآن تقريباً'
                  : `${Math.floor(status?.offlineHours ?? 0)} ساعة`}
              </Text>
            </View>
          </View>

          {isGrace ? (
            <View style={styles.graceNote}>
              <Icon name="wifiOff" size={14} color={c.warning} />
              <Text style={styles.graceNoteText}>
                لا اتصال بالسيرفر منذ {Math.floor(status?.offlineHours ?? 0)}{' '}
                ساعة — استمر التطبيق بالعمل بوضع السماح. اتصل بالإنترنت واضغط
                «إعادة التحقق» لتفادي القفل التلقائي.
              </Text>
            </View>
          ) : null}

          <View style={styles.deviceBox}>
            <Text style={styles.deviceLabel}>معرّف هذا الجهاز</Text>
            <Text style={styles.deviceValue} selectable>
              {deviceId || '…'}
            </Text>
          </View>

          <View style={styles.buttonRow}>
            <AppButton
              title={verifying ? 'جارٍ التحقق…' : 'إعادة التحقق الآن'}
              icon={verifying ? undefined : 'refresh'}
              variant="primary"
              small
              loading={verifying}
              onPress={() => void runVerify()}
              style={{flex: 1}}
            />
            <AppButton
              title="إلغاء ربط الجهاز"
              icon="swap"
              variant="ghost"
              small
              onPress={confirmUnbind}
              style={{flex: 1}}
            />
          </View>
        </>
      ) : (
        <View style={styles.graceNote}>
          <Icon name="lock" size={14} color={c.danger} />
          <Text style={styles.graceNoteText}>
            لا يوجد اشتراك مفعّل — التطبيق مقفل حتى يتم التفعيل بمفتاح من
            الإدارة.
          </Text>
        </View>
      )}

      {/* Management contact */}
      <View style={styles.contactCard}>
        <Text style={styles.contactTitle}>لشراء وتجديد الاشتراكات</Text>
        <Text style={styles.contactNote}>{contact.note}</Text>
        <TouchableOpacity
          style={styles.contactRow}
          onPress={() =>
            void Linking.openURL(`tel:${contact.phone.replace(/\s/g, '')}`)
          }>
          <Icon name="phone" size={15} color={c.accent} />
          <Text style={styles.contactValue}>{contact.phone}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.contactRow}
          onPress={() =>
            void Linking.openURL(
              `https://wa.me/${contact.whatsapp.replace(/[^\d]/g, '')}`,
            )
          }>
          <Icon name="send" size={15} color={c.accent} />
          <Text style={styles.contactValue}>واتساب الإدارة</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.contactRow}
          onPress={() => void Linking.openURL(`mailto:${contact.email}`)}>
          <Icon name="mail" size={15} color={c.accent} />
          <Text style={styles.contactValue}>{contact.email}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const useStyles = makeStyles(c =>
  StyleSheet.create({
    group: {
      backgroundColor: c.surface,
      borderRadius: radius.lg,
      padding: spacing.lg,
      gap: 13,
      borderWidth: 1,
      borderColor: c.border,
      marginBottom: spacing.md,
    },
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 10,
    },
    headerLeft: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 11,
      flex: 1,
    },
    title: {
      fontFamily: fonts.bold,
      fontSize: 16,
      color: c.text,
    },
    subtitle: {
      fontFamily: fonts.regular,
      fontSize: 11.5,
      color: c.textDim,
    },
    stateChip: {
      borderRadius: 999,
      paddingHorizontal: 13,
      paddingVertical: 6,
    },
    stateChipText: {
      fontFamily: fonts.bold,
      fontSize: 12.5,
    },
    infoGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
    },
    infoCell: {
      flexBasis: '47%',
      flexGrow: 1,
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.md,
      padding: 11,
      gap: 3,
    },
    infoLabel: {
      fontFamily: fonts.regular,
      fontSize: 11,
      color: c.textDim,
    },
    infoValue: {
      fontFamily: fonts.bold,
      fontSize: 14.5,
      color: c.text,
    },
    graceNote: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 8,
      backgroundColor: c.warningSoft,
      borderRadius: radius.md,
      padding: 11,
    },
    graceNoteText: {
      flex: 1,
      fontFamily: fonts.regular,
      fontSize: 11.5,
      lineHeight: 18,
      color: c.text,
    },
    deviceBox: {
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.md,
      padding: 11,
      gap: 3,
      borderLeftWidth: 3,
      borderLeftColor: c.accent,
    },
    deviceLabel: {
      fontFamily: fonts.regular,
      fontSize: 11,
      color: c.textDim,
    },
    deviceValue: {
      fontFamily: fonts.bold,
      fontSize: 13.5,
      color: c.text,
      letterSpacing: 0.5,
    },
    buttonRow: {
      flexDirection: 'row',
      gap: 10,
    },
    contactCard: {
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.md,
      padding: 13,
      gap: 4,
      marginTop: 2,
    },
    contactTitle: {
      fontFamily: fonts.bold,
      fontSize: 13.5,
      color: c.text,
      marginBottom: 2,
    },
    contactNote: {
      fontFamily: fonts.regular,
      fontSize: 11.5,
      lineHeight: 18,
      color: c.textDim,
      marginBottom: 4,
    },
    contactRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 9,
      paddingVertical: 7,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
    },
    contactValue: {
      fontFamily: fonts.bold,
      fontSize: 12.5,
      color: c.text,
    },
  }),
);
