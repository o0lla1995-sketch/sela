/**
 * LicenseGate — blocks the app until a valid subscription is active.
 * ─────────────────────────────────────────────────────────────────
 * Wraps the whole navigator:
 *   needs_activation / locked  → ActivationScreen (full gate)
 *   grace                      → app + a slim warning banner
 *   active                     → app
 *
 * Verification strategy:
 *  - On mount: offline evaluation (signature + trusted time) → instant.
 *  - Then a throttled online heartbeat (≤1/hour) refreshes the
 *    revocation/expiry status and re-anchors the trusted clock.
 *  - On every AppState→active: same throttled heartbeat, so returning
 *    to the app after hours offline re-checks automatically.
 */
import React, {useEffect, useRef, useState} from 'react';
import {
  AppState,
  type AppStateStatus,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {Icon} from './Icon';
import {fonts, makeStyles, useThemeColors} from '../core/theme';
import {useLicenseStore} from '../stores/licenseStore';
import {ActivationScreen} from '../screens/license/ActivationScreen';
// v47 (الجولة 55 #4): تنبيهات الاشتراك — اقتراب الانتهاء/الانتهاء/
// وضع السماح، مرة واحدة يومياً لكل حدث، إشعار نظام للمهم منها.
import {LicenseAlertsService} from '../services/LicenseAlertsService';
// v62 (الجولة 66 #4): التحديث الإجباري — أول توجيه من الإدارة
// (config/تفعيل/نبضة) يقيَّم محلياً؛ الجهاز الأقدم من الحد الأدنى
// يُقفل على شاشة التحديث قبل أي شيء آخر.
import {ForceUpdateScreen} from './ForceUpdateScreen';
import {
  fetchServerConfig,
  getUpdateRequirement,
  type UpdateRequirement,
} from '../services/license/LicenseService';

export function LicenseGate({children}: {children: React.ReactNode}) {
  const c = useThemeColors();
  const styles = useStyles();
  const status = useLicenseStore(state => state.status);
  const refresh = useLicenseStore(state => state.refresh);
  const verifyOnline = useLicenseStore(state => state.verifyOnline);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const appStateRef = useRef(AppState.currentState);
  // v62: قرار التحديث الإجباري — يُعاد قراءته من الكاش بعد كل تقييم
  // حالة (النبضة/التفعيل قد تكون جلبت توجيهاً جديداً من الخادم).
  const [update, setUpdate] = useState<UpdateRequirement>(() =>
    getUpdateRequirement(),
  );

  const recheckUpdate = async () => {
    await Promise.all([
      verifyOnline(true),
      fetchServerConfig(),
    ]);
    await refresh();
    setUpdate(getUpdateRequirement());
  };

  useEffect(() => {
    // 1. Offline gate decision first (instant, cryptographically valid).
    void refresh();
    // 2. Then the throttled online heartbeat.
    void verifyOnline();
    // v62 (الجولة 66 #1/#4): جلب إعدادات الخادم مباشرة عند الإقلاع
    // — بيانات التواصل الحية + توجيه التحديث قبل أي تفعيل.
    void fetchServerConfig().then(() => setUpdate(getUpdateRequirement()));

    // v47 (الجولة 55 #4): كل تقييم جديد يمر على تنبيهات الاشتراك
    //    (خصم يومي داخلياً — لا إزعاج). يشمل الإقلاع والعودة
    //    للتطبيق والدورة الخمسية أدناه.
    const unsubscribe = useLicenseStore.subscribe(state => {
      LicenseAlertsService.evaluate(state.status);
      // v62 (الجولة 66 #4): النبضة قد جلبت توجيه تحديث جديد.
      setUpdate(getUpdateRequirement());
    });

    const subscription = AppState.addEventListener(
      'change',
      (next: AppStateStatus) => {
        if (
          appStateRef.current.match(/inactive|background/) &&
          next === 'active'
        ) {
          void verifyOnline();
          void refresh();
        }
        appStateRef.current = next;
      },
    );

    // 3. v23.0.1: PERIODIC checks while the app stays open. A POS at a
    //    store can stay foregrounded for DAYS with no AppState change,
    //    so mount+foreground alone never re-checked expiry/revocation.
    //    The offline evaluate() is cheap → every 5 minutes; the online
    //    heartbeat is internally throttled to ≤1/hour → every 20
    //    minutes is plenty and never stacks extra server load.
    const offlineTimer = setInterval(() => {
      if (AppState.currentState === 'active') {
        void refresh();
      }
    }, 5 * 60 * 1000);
    const onlineTimer = setInterval(() => {
      if (AppState.currentState === 'active') {
        void verifyOnline();
      }
    }, 20 * 60 * 1000);

    return () => {
      subscription.remove();
      unsubscribe();
      clearInterval(offlineTimer);
      clearInterval(onlineTimer);
    };
  }, [refresh, verifyOnline]);

  if (status == null) {
    // First evaluation still running — brief splash, never a flash of
    // the locked/unlocked UI.
    return (
      <View style={[styles.splash, {backgroundColor: c.bg}]}>
        <View style={styles.splashMark}>
          <Icon name="basket" size={34} color="#FFFFFF" />
        </View>
      </View>
    );
  }

  // v62 (الجولة 66 #4): التحديث الإجباري له الأولوية على كل شيء —
  // حتى قبل شاشة التفعيل: الجهاز القديم يرى شاشة التحديث أولاً.
  if (update.required) {
    return <ForceUpdateScreen requirement={update} onRecheck={recheckUpdate} />;
  }

  if (status.state === 'needs_activation' || status.state === 'locked') {
    return <ActivationScreen status={status} />;
  }

  const remainingDays = Math.max(
    0,
    Math.ceil(status.remainingMs / (24 * 3600 * 1000)),
  );

  return (
    <View style={styles.flex}>
      {status.state === 'grace' && !bannerDismissed ? (
        <View style={styles.graceBanner}>
          <Icon name="alert" size={15} color={c.warning} />
          <Text style={styles.graceText}>
            وضع السماح: لا يوجد اتصال بالسيرفر منذ{' '}
            {Math.floor(status.offlineHours)} ساعة — يُقفل التطبيق تلقائياً بعد
            تجاوز فترة السماح. تبقّى {remainingDays} يوم على انتهاء الاشتراك.
          </Text>
          <TouchableOpacity
            onPress={() => setBannerDismissed(true)}
            hitSlop={{top: 6, bottom: 6, left: 6, right: 6}}>
            <Icon name="x" size={14} color={c.textDim} />
          </TouchableOpacity>
        </View>
      ) : null}
      {children}
    </View>
  );
}

const useStyles = makeStyles(c =>
  StyleSheet.create({
    flex: {
      flex: 1,
    },
    splash: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
    },
    splashMark: {
      width: 76,
      height: 76,
      borderRadius: 22,
      backgroundColor: c.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    graceBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 9,
      backgroundColor: c.warningSoft,
      paddingHorizontal: 14,
      paddingVertical: 9,
    },
    graceText: {
      flex: 1,
      fontFamily: fonts.regular,
      fontSize: 11.5,
      lineHeight: 17,
      color: c.text,
    },
  }),
);
