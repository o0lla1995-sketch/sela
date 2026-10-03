/**
 * SettingsScreen — الإعدادات (design.md §9.6).
 * Grouped cards: store info, selling, receipts, notifications,
 * device (printer/diagnostics), data tools and about.
 */
import React, {useCallback, useState} from 'react';
import {Alert, PermissionsAndroid, Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import {AppButton, AppHeader, Card, Field, SectionTitle, Segmented, SwitchRow} from '../../components/ui';
import {Icon, type IconName} from '../../components/Icon';
import {useSettingsStore} from '../../stores/settingsStore';
import {ExportService} from '../../services/ExportService';
import {wipeAllData} from '../../database/connection';
import {useToastStore} from '../../stores/toastStore';
import {useCatalogStore} from '../../stores/catalogStore';
import {useNotificationsStore} from '../../stores/notificationsStore';
import {StockAlertsService} from '../../services/StockAlertsService';
import {SelaNotificationsNative} from '../../native/nativeBridge';
import {colors, fonts, radius, spacing, typography} from '../../core/theme';
import {APP_NAME, APP_VERSION, DEFAULT_LOW_STOCK_THRESHOLD} from '../../core/config';
import {parseNumber} from '../../core/format';
import type {PricingMode} from '../../core/types';

export function SettingsScreen() {
  const navigation = useNavigation<any>();
  const settings = useSettingsStore(state => state.settings);
  const update = useSettingsStore(state => state.update);
  const toast = useToastStore(state => state.show);
  const refreshCatalog = useCatalogStore(state => state.refresh);
  const pushNotification = useNotificationsStore(state => state.push);

  const [requestingPermission, setRequestingPermission] = useState(false);

  const requestNotificationPermission = useCallback(async () => {
    setRequestingPermission(true);
    try {
      if (Platform.OS === 'android' && Platform.Version >= 33) {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS as never,
          {
            title: 'إشعارات سيلا',
            message: 'نحتاج إذن الإشعارات لإبلاغك عند نفاد المخزون أثناء عملك',
            buttonPositive: 'سماح',
            buttonNegative: 'لاحقاً',
          } as never,
        );
        if (granted === PermissionsAndroid.RESULTS.GRANTED) {
          update({systemNotificationsEnabled: true});
          toast('تم تفعيل إشعارات النظام', 'success');
        } else {
          update({systemNotificationsEnabled: false});
          toast('لن تظهر إشعارات النظام — يمكنك تفعيلها من إعدادات أندرويد', 'info', 4000);
        }
      } else {
        const enabled = await SelaNotificationsNative?.areNotificationsEnabled?.();
        update({systemNotificationsEnabled: enabled !== false});
        toast(enabled !== false ? 'الإشعارات مفعّلة' : 'الإشعارات معطّلة من نظام أندرويد', enabled !== false ? 'success' : 'info');
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : 'تعذر طلب الإذن', 'error');
    } finally {
      setRequestingPermission(false);
    }
  }, [toast, update]);

  const sendTestNotification = useCallback(() => {
    pushNotification(
      'info',
      'إشعار تجريبي من سيلا',
      'إن كنت تقرأ هذا كإشعار نظام فالتنبيهات تعمل بشكل صحيح.',
      {system: true},
    );
    toast('تم إرسال إشعار تجريبي', 'success');
  }, [pushNotification, toast]);

  const backupData = useCallback(async () => {
    try {
      const path = await ExportService.exportBackup();
      toast(`تم حفظ النسخة الاحتياطية: ${path}`, 'success', 5000);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'فشل التصدير', 'error');
    }
  }, [toast]);

  const wipe = useCallback(() => {
    Alert.alert(
      'حذف جميع البيانات',
      'سيتم حذف كل المنتجات والفئات والمبيعات والبصمات البصرية نهائياً. لا يمكن التراجع!',
      [
        {text: 'إلغاء', style: 'cancel'},
        {
          text: 'حذف نهائي',
          style: 'destructive',
          onPress: () => {
            Alert.alert('تأكيد أخير', 'هل أنت متأكد تماماً؟', [
              {text: 'إلغاء', style: 'cancel'},
              {
                text: 'نعم احذف',
                style: 'destructive',
                onPress: async () => {
                  try {
                    await wipeAllData();
                    await refreshCatalog();
                    toast('تم حذف جميع البيانات', 'success');
                  } catch (error) {
                    toast(
                      error instanceof Error ? error.message : String(error),
                      'error',
                    );
                  }
                },
              },
            ]);
          },
        },
      ],
    );
  }, [refreshCatalog, toast]);

  return (
    <View style={styles.screen}>
      <AppHeader title="الإعدادات" subtitle="تخصيص النظام" showBack={false} />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* ── Store info ───────────────────────────────────────── */}
        <Card style={styles.group}>
          <SectionTitle title="معلومات المحل" hint="تظهر أعلى الفاتورة المطبوعة" />
          <Field label="اسم المحل" value={settings.storeName} onChangeText={text => update({storeName: text})} placeholder="متجر سيلا" />
          <Field label="رقم الهاتف (اختياري)" value={settings.storePhone} onChangeText={text => update({storePhone: text})} placeholder="05XXXXXXXX" keyboardType="phone-pad" />
          <Field label="رسالة أسفل الفاتورة" value={settings.footerMessage} onChangeText={text => update({footerMessage: text})} placeholder="شكراً لتعاملكم معنا" multiline numberOfLines={2} />
        </Card>

        {/* ── Selling ──────────────────────────────────────────── */}
        <Card style={styles.group}>
          <SectionTitle title="البيع والتعرف البصري" />
          <Text style={styles.fieldLabel}>وضع التسعير الافتراضي</Text>
          <Segmented
            value={settings.defaultPricingMode}
            onChange={(value: PricingMode) => update({defaultPricingMode: value})}
            options={[
              {value: 'RETAIL', label: 'مفرق'},
              {value: 'WHOLESALE', label: 'جملة'},
            ]}
          />
          <SwitchRow
            icon="sparkles"
            label="التعرف البصري التلقائي"
            hint="فتح الكاميرا تلقائياً عند البيع"
            value={settings.recognitionEnabled}
            onValueChange={value => update({recognitionEnabled: value})}
          />
          <SwitchRow
            icon="flash"
            label="صوت التنبيه"
            hint="نغمة قصيرة عند إضافة منتج للسلة"
            value={settings.soundEnabled}
            onValueChange={value => update({soundEnabled: value})}
          />
          <Field
            label={`حد التشابه للتعرف (% افتراضي ${Math.round(settings.matchThreshold * 100)})`}
            value={String(Math.round(settings.matchThreshold * 100))}
            onChangeText={text => {
              const value = parseNumber(text);
              if (!Number.isNaN(value) && value >= 50 && value <= 100) {
                update({matchThreshold: value / 100});
              }
            }}
            keyboardType="numeric"
            suffix="%"
          />
        </Card>

        {/* ── Receipts ─────────────────────────────────────────── */}
        <Card style={styles.group}>
          <SectionTitle title="الفاتورة المطبوعة" />
          <Text style={styles.fieldLabel}>عرض الورق</Text>
          <Segmented
            value={settings.paperWidth}
            onChange={value => update({paperWidth: value})}
            options={[
              {value: '58', label: '58 مم'},
              {value: '80', label: '80 مم'},
            ]}
          />
          <Text style={styles.fieldLabel}>ترميز الطباعة العربية</Text>
          <Segmented
            value={settings.codepage}
            onChange={value => update({codepage: value})}
            options={[
              {value: 47, label: 'CP1256'},
              {value: 45, label: 'CP864'},
              {value: 0, label: 'ASCII'},
            ]}
            compact
          />
          <SwitchRow
            icon="wallet"
            label="إظهار صافي الربح في الفاتورة"
            hint="للمسؤول فقط — لا يظهر للزبون عادة"
            value={settings.showProfitOnReceipt}
            onValueChange={value => update({showProfitOnReceipt: value})}
          />
        </Card>

        {/* ── Notifications ────────────────────────────────────── */}
        <Card style={styles.group}>
          <SectionTitle title="الإشعارات وتنبيهات المخزون" />
          <SwitchRow
            icon="bell"
            label="تنبيهات المخزون"
            hint="إشعار عند نفاد منتج أو انخفاض كميته"
            value={settings.stockAlertsEnabled}
            onValueChange={value => update({stockAlertsEnabled: value})}
          />
          <Field
            label={`حد التنبيه الافتراضي (قطع، افتراضي ${DEFAULT_LOW_STOCK_THRESHOLD})`}
            value={String(settings.lowStockDefaultThreshold)}
            onChangeText={text => {
              const value = parseNumber(text);
              if (!Number.isNaN(value) && value >= 0 && value <= 1000) {
                update({lowStockDefaultThreshold: Math.trunc(value)});
              }
            }}
            keyboardType="numeric"
          />
          <View style={styles.notifActions}>
            <AppButton
              small
              title="تفعيل إشعارات النظام"
              variant="secondary"
              icon="bell"
              loading={requestingPermission}
              onPress={requestNotificationPermission}
              style={{flex: 1}}
            />
            <AppButton
              small
              title="إشعار تجريبي"
              variant="ghost"
              icon="send"
              onPress={sendTestNotification}
              style={{flex: 1}}
            />
          </View>
        </Card>

        {/* ── Device ───────────────────────────────────────────── */}
        <Card style={styles.group}>
          <SectionTitle title="الطابعة والجهاز" />
          <SettingRow
            icon="printer"
            label="إعدادات الطابعة"
            hint="ربط طابعة حرارية عبر البلوتوث واختبار طباعة"
            onPress={() => navigation.navigate('PrinterSettings' as never)}
          />
          <SettingRow
            icon="stethoscope"
            label="التشخيص الذاتي"
            hint="حالة الكاميرا والنموذج وقاعدة البيانات والطابعة"
            onPress={() => navigation.navigate('Diagnostics' as never)}
          />
        </Card>

        {/* ── Data tools ───────────────────────────────────────── */}
        <Card style={styles.group}>
          <SectionTitle title="أدوات البيانات" />
          <AppButton
            title="نسخة احتياطية (CSV)"
            variant="secondary"
            icon="save"
            small
            onPress={backupData}
          />
          <AppButton
            title="حذف جميع البيانات"
            variant="danger"
            icon="trash"
            small
            onPress={wipe}
          />
        </Card>

        <Text style={styles.about}>
          {APP_NAME} · الإصدار {APP_VERSION} · يعمل دون إنترنت 100%
        </Text>
      </ScrollView>
    </View>
  );
}

function SettingRow({
  icon,
  label,
  hint,
  onPress,
}: {
  icon: IconName;
  label: string;
  hint: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity style={styles.settingRow} onPress={onPress} activeOpacity={0.75}>
      <View style={styles.settingIcon}>
        <Icon name={icon} size={18} color={colors.accent} />
      </View>
      <View style={{flex: 1}}>
        <Text style={styles.settingLabel}>{label}</Text>
        <Text style={styles.settingHint}>{hint}</Text>
      </View>
      <Icon name="chevronLeft" size={16} color={colors.textFaint} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: colors.bg},
  content: {
    padding: spacing.lg,
    gap: spacing.md,
    paddingBottom: spacing.xxl,
  },
  group: {gap: spacing.md},
  fieldLabel: {
    color: colors.textDim,
    fontFamily: fonts.bold,
    fontSize: typography.small,
  },
  notifActions: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.xs,
  },
  settingIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  settingLabel: {
    color: colors.text,
    fontFamily: fonts.bold,
    fontSize: typography.caption,
  },
  settingHint: {
    color: colors.textFaint,
    fontFamily: fonts.regular,
    fontSize: typography.micro + 1,
    marginTop: 1,
  },
  about: {
    color: colors.textFaint,
    fontFamily: fonts.regular,
    fontSize: typography.small,
    textAlign: 'center',
    marginTop: spacing.md,
  },
});
