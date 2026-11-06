/**
 * screens/MeScreen.tsx — v3.0: حسابي — الإعدادات والصلاحيات.
 * ─────────────────────────────────────────────────────────────────
 * ① بطاقة الحساب: اسمي، متجري، صلاحياتي كما منحها المسؤول.
 * ② حالة الاتصال بنقطة البيع + العمليات المعلقة + مزامنة فورية.
 * ③ الطباعة (جديد): حالة طابعة نقطة البيع المتصلة + تفعيل/إلغاء
 *    طباعة الفواتير منها — تُطبع لحظة البيع مباشرة.
 * ④ الأمان (جديد): الدخول للتطبيق بالبصمة عند الإقلاع.
 * ⑤ الأصوات (v3.1): نغمة تأكيد عند مسح الباركود وإضافة منتج
 *    للسلة — مثل نقطة البيع أندرويد تماماً.
 * ⑥ الوضع النهاري/الليلي/تلقائي — نفس نظام نقطة البيع.
 * ⑦ تسجيل الخروج (يبقى الأرشيف المحلي — يُربط بحسابك عند الدخول).
 */
import React, {useEffect, useState} from 'react';
import {ScrollView, Text, View} from 'react-native';
import {
  AppButton,
  Badge,
  Card,
  SectionTitle,
  SwitchRow,
} from '../ui';
import {Icon} from '../Icon';
import {
  fonts,
  makeStyles,
  spacing,
  typography,
  useThemeStore,
  useThemeColors,
  type ThemeMode,
} from '../theme';
import {useSessionStore} from '../store/session';
import {useSyncStore} from '../store/sync';
import {initOfflineStore, listInvoices} from '../store/offline';
import {useAppSettings} from '../store/settings';
import {CashierApi} from '../api/client';
import {APP_VERSION_LABEL} from '../core/config';
import {biometricAvailability, type BiometricStatus} from '../native';

export function MeScreen() {
  const c = useThemeColors();
  const styles = useStyles();
  const cashierName = useSessionStore(s => s.cashierName);
  const storeName = useSessionStore(s => s.storeName);
  const perms = useSessionStore(s => s.perms);
  const signOut = useSessionStore(s => s.signOut);
  const online = useSyncStore(s => s.online);
  const pending = useSyncStore(s => s.pending);
  const lastSyncAt = useSyncStore(s => s.lastSyncAt);
  const runCycle = useSyncStore(s => s.runCycle);
  const themeMode = useThemeStore(s => s.mode);
  const setThemeMode = useThemeStore(s => s.setMode);
  const printReceipts = useAppSettings(s => s.printReceipts);
  const setPrintReceipts = useAppSettings(s => s.setPrintReceipts);
  const fingerprintLock = useAppSettings(s => s.fingerprintLock);
  const setFingerprintLock = useAppSettings(s => s.setFingerprintLock);
  const soundEnabled = useAppSettings(s => s.soundEnabled);
  const setSoundEnabled = useAppSettings(s => s.setSoundEnabled);
  const [archiveCount, setArchiveCount] = useState(0);
  // حالة طابعة نقطة البيع: متصلة أم لا (+ اسمها).
  const [printer, setPrinter] = useState<{
    connected: boolean;
    name: string | null;
  } | null>(null);
  const [bio, setBio] = useState<BiometricStatus>('available');

  useEffect(() => {
    void (async () => {
      await initOfflineStore();
      const list = await listInvoices(1000);
      setArchiveCount(list.length);
    })();
  }, []);

  // حالة الطابعة من نقطة البيع كلما فُتحت الشاشة أو عاد الاتصال.
  useEffect(() => {
    setPrinter(null);
    if (!online) {
      return;
    }
    void (async () => {
      try {
        const status = await CashierApi.printerStatus();
        setPrinter({connected: status.connected, name: status.name ?? null});
      } catch {
        setPrinter(null);
      }
    })();
  }, [online]);

  // توفر البصمة على هذا الجهاز.
  useEffect(() => {
    void biometricAvailability().then(setBio);
  }, []);

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={{padding: spacing.lg, gap: spacing.md}}>
      {/* الحساب */}
      <Card style={styles.accountCard}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>
            {(cashierName || 'ك').trim().charAt(0)}
          </Text>
        </View>
        <View style={{flex: 1, minWidth: 0}}>
          <Text style={styles.name} numberOfLines={1}>
            {cashierName || 'كاشير'}
          </Text>
          <Text style={styles.dim} numberOfLines={1}>
            {storeName || 'متجر سيلا'}
          </Text>
        </View>
        <Badge
          label={online ? 'متصل بنقطة البيع' : 'دون اتصال — وضع محلي'}
          tone={online ? 'success' : 'warning'}
        />
      </Card>

      {/* الصلاحيات */}
      <SectionTitle
        title="صلاحياتي"
        hint="يمنحها المسؤول من شاشة الكاشير في نقطة البيع"
      />
      <Card style={{gap: 6}}>
        <View style={styles.permRow}>
          <Icon name="percent" size={16} color={c.accent} />
          <Text style={styles.permLabel}>أقصى خصم</Text>
          <View style={{flex: 1}} />
          <Text style={styles.permValue}>{perms.maxDiscountPct}%</Text>
        </View>
        <View style={styles.permRow}>
          <Icon name="book" size={16} color={perms.canDebt ? c.success : c.danger} />
          <Text style={styles.permLabel}>البيع بالدين</Text>
          <View style={{flex: 1}} />
          <Badge
            label={perms.canDebt ? 'مسموح' : 'مقفول'}
            tone={perms.canDebt ? 'success' : 'danger'}
          />
        </View>
        <View style={styles.permRow}>
          <Icon name="undo" size={16} color={perms.canReturn ? c.success : c.danger} />
          <Text style={styles.permLabel}>المرتجعات والاستبدال</Text>
          <View style={{flex: 1}} />
          <Badge
            label={perms.canReturn ? 'مسموح' : 'مقفول'}
            tone={perms.canReturn ? 'success' : 'danger'}
          />
        </View>
      </Card>

      {/* المزامنة */}
      <SectionTitle title="المزامنة" hint="أرشيفك محفوظ على جهازك دائماً" />
      <Card style={{gap: 8}}>
        <View style={styles.permRow}>
          <Icon name="sync" size={16} color={pending > 0 ? c.warning : c.success} />
          <Text style={styles.permLabel}>عمليات بانتظار المزامنة</Text>
          <View style={{flex: 1}} />
          <Text style={styles.permValue}>{pending}</Text>
        </View>
        <View style={styles.permRow}>
          <Icon name="receipt" size={16} color={c.info} />
          <Text style={styles.permLabel}>فواتيري في الأرشيف</Text>
          <View style={{flex: 1}} />
          <Text style={styles.permValue}>{archiveCount}</Text>
        </View>
        {lastSyncAt ? (
          <Text style={styles.dim}>آخر مزامنة: {lastSyncAt.slice(0, 16)}</Text>
        ) : null}
        <AppButton
          title="مزامنة الآن"
          icon="sync"
          variant="secondary"
          small
          onPress={() => void runCycle({force: true})}
        />
        <Text style={styles.dim}>
          البيع يعمل كاملاً حتى بانقطاع الاتصال: كل عملية تُسجَّل على جهازك
          برقم مؤقت، وتصدر أرقامها الرسمية من نقطة البيع عند المزامنة — فلا
          تعارض بين حسابات الكاشيرين إطلاقاً. وإن تغيّر عنوان نقطة البيع
          (الراوتر أُعيد تشغيله مثلاً) يبحث التطبيق عنها تلقائياً على
          الشبكة ويعيد الاتصال بجلستك نفسها.
        </Text>
      </Card>

      {/* الطباعة — عبر طابعة نقطة البيع المتصلة */}
      <SectionTitle
        title="الطباعة"
        hint="من الطابعة المرتبطة بنقطة البيع — إن وُجدت"
      />
      <Card style={{gap: 8}}>
        <View style={styles.permRow}>
          <Icon
            name="printer"
            size={16}
            color={printer?.connected ? c.success : c.textFaint}
          />
          <Text style={styles.permLabel}>طابعة نقطة البيع</Text>
          <View style={{flex: 1}} />
          {printer == null ? (
            <Badge
              label={online ? 'جارٍ الفحص…' : 'تُفحص عند الاتصال'}
              tone="neutral"
            />
          ) : printer.connected ? (
            <Badge
              label={printer.name ? `متصلة · ${printer.name}` : 'متصلة'}
              tone="success"
            />
          ) : (
            <Badge label="غير متصلة" tone="neutral" />
          )}
        </View>
        <SwitchRow
          label="طباعة الفواتير من طابعة نقطة البيع"
          hint={
            printer != null && !printer.connected
              ? 'الطابعة غير متصلة الآن — سيُتجاهل الطلب حتى تتصل'
              : 'كل فاتورة تُطبع لحظة إتمامها مباشرة من طابعة نقطة البيع'
          }
          icon="printer"
          value={printReceipts}
          onValueChange={on => setPrintReceipts(on)}
        />
      </Card>

      {/* الأمان — الدخول بالبصمة */}
      <SectionTitle
        title="الأمان"
        hint="بوابة الدخول عند فتح التطبيق"
      />
      <Card>
        <SwitchRow
          label="الدخول للتطبيق بالبصمة"
          hint={
            bio === 'available'
              ? 'عند فتح التطبيق تُطلب بصمتك قبل الدخول لشاشة البيع'
              : bio === 'none_enrolled'
              ? 'لا توجد بصمة مسجلة في الجهاز — أضفها من إعدادات الجهاز أولاً'
              : 'جهازك لا يدعم البصمة'
          }
          icon="fingerprint"
          value={fingerprintLock}
          onValueChange={on => {
            if (on && bio !== 'available') {
              return; // لا يمكن التفعيل بلا بصمة مسجلة.
            }
            setFingerprintLock(on);
          }}
        />
      </Card>

      {/* الأصوات — نغمة المسح والإضافة (v3.1) */}
      <SectionTitle
        title="الأصوات"
        hint="نغمة تأكيد مثل نقطة البيع أندرويد"
      />
      <Card>
        <SwitchRow
          label="نغمة عند مسح الباركود وإضافة منتج"
          hint="نغمة قصيرة من مكبر الجهاز عند تطابق الباركود وكل إضافة ناجحة للسلة"
          icon="barcode"
          value={soundEnabled}
          onValueChange={on => setSoundEnabled(on)}
        />
      </Card>

      {/* المظهر */}
      <SectionTitle title="المظهر" hint="نفس أوضاع نقطة البيع" />
      <Card>
        <View style={{gap: 2}}>
          {(
            [
              {mode: 'light', label: 'الوضع النهاري', icon: 'sun'},
              {mode: 'dark', label: 'الوضع الليلي', icon: 'moon'},
              {mode: 'system', label: 'تلقائي (حسب النظام)', icon: 'settings'},
            ] as {mode: ThemeMode; label: string; icon: 'sun' | 'moon' | 'settings'}[]
          ).map(item => (
            <SwitchRow
              key={item.mode}
              label={item.label}
              icon={item.icon}
              value={themeMode === item.mode}
              onValueChange={on => {
                if (on) {
                  setThemeMode(item.mode);
                }
              }}
            />
          ))}
        </View>
      </Card>

      <AppButton
        title="تسجيل الخروج"
        icon="logout"
        variant="danger"
        onPress={() => void signOut()}
      />
      <Text style={styles.version}>سيلّا كاشير · الإصدار {APP_VERSION_LABEL}</Text>
    </ScrollView>
  );
}

const useStyles = makeStyles(c =>
  ({
    screen: {flex: 1, backgroundColor: c.bg},
    accountCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
    },
    avatar: {
      width: 54,
      height: 54,
      borderRadius: 17,
      backgroundColor: c.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    avatarText: {
      color: c.onAccent,
      fontFamily: fonts.black,
      fontSize: 26,
    },
    name: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: typography.heading,
      textAlign: 'right',
    },
    dim: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      textAlign: 'right',
      lineHeight: 19,
    },
    permRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm + 2,
      paddingVertical: 4,
    },
    permLabel: {
      color: c.text,
      fontFamily: fonts.medium,
      fontSize: typography.body,
      textAlign: 'right',
      flexShrink: 1,
    },
    permValue: {
      color: c.accent,
      fontFamily: fonts.black,
      fontSize: typography.body,
    },
    version: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 2,
      textAlign: 'center',
      marginTop: spacing.sm,
    },
  }) as const,
);
