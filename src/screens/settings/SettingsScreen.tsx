/**
 * SettingsScreen — الإعدادات (v3).
 * ─────────────────────────────────────────────────────────────────
 * Grouped cards: appearance (نهاري/ليلي/تلقائي), store info + logo,
 * scanner engine (باركود/بصري/كلاهما), selling, receipts,
 * notifications, management (categories/units/stocktake), device,
 * data tools and about.
 */
import React, {useCallback, useState} from 'react';
import {
  Alert,
  Image,
  PermissionsAndroid,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import {
  AppButton,
  AppHeader,
  Card,
  Field,
  SectionTitle,
  Segmented,
  SwitchRow,
} from '../../components/ui';
import {Icon, type IconName} from '../../components/Icon';
import {useSettingsStore} from '../../stores/settingsStore';
import {SubscriptionSection} from './SubscriptionSection';
import {useThemeStore, useThemeColors, type ThemeMode} from '../../core/theme';
import {ExportService} from '../../services/ExportService';
import {wipeAllData} from '../../database/connection';
import {useToastStore} from '../../stores/toastStore';
import {useCatalogStore} from '../../stores/catalogStore';
import {useNotificationsStore} from '../../stores/notificationsStore';
import {
  SelaNotificationsNative,
  SelaImagePickerNative,
} from '../../native/nativeBridge';
import {fonts, makeStyles, radius, spacing, typography} from '../../core/theme';
import {
  APP_NAME,
  APP_VERSION,
  DEFAULT_LOW_STOCK_THRESHOLD,
} from '../../core/config';
import type {ScannerMode} from '../../core/config';
import {parseNumber} from '../../core/format';
import type {PricingMode} from '../../core/types';

export function SettingsScreen() {
  const c = useThemeColors();
  const styles = useStyles();
  const navigation = useNavigation<any>();
  const settings = useSettingsStore(state => state.settings);
  const update = useSettingsStore(state => state.update);
  const themeMode = useThemeStore(state => state.mode);
  const setThemeMode = useThemeStore(state => state.setMode);
  const toast = useToastStore(state => state.show);
  const refreshCatalog = useCatalogStore(state => state.refresh);
  const pushNotification = useNotificationsStore(state => state.push);

  const [requestingPermission, setRequestingPermission] = useState(false);
  const [pickingLogo, setPickingLogo] = useState(false);

  const requestNotificationPermission = useCallback(async () => {
    setRequestingPermission(true);
    try {
      if (Platform.OS === 'android' && Platform.Version >= 33) {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS as never,
          {
            title: 'إشعارات sela',
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
          toast(
            'لن تظهر إشعارات النظام — يمكنك تفعيلها من إعدادات أندرويد',
            'info',
            4000,
          );
        }
      } else {
        const enabled =
          await SelaNotificationsNative?.areNotificationsEnabled?.();
        update({systemNotificationsEnabled: enabled !== false});
        toast(
          enabled !== false
            ? 'الإشعارات مفعّلة'
            : 'الإشعارات معطّلة من نظام أندرويد',
          enabled !== false ? 'success' : 'info',
        );
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
      'إشعار تجريبي من sela',
      'إن كنت تقرأ هذا كإشعار نظام فالتنبيهات تعمل بشكل صحيح.',
      {system: true},
    );
    toast('تم إرسال إشعار تجريبي', 'success');
  }, [pushNotification, toast]);

  const pickStoreLogo = useCallback(async () => {
    if (SelaImagePickerNative == null) {
      toast('منتقي الصور غير متوفر في هذا الإصدار', 'error');
      return;
    }
    setPickingLogo(true);
    try {
      const path = await SelaImagePickerNative.pickStoreLogo(512);
      update({storeLogoPath: path});
      toast('تم حفظ شعار المتجر — سيُطبع أعلى الفواتير', 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('لم يتم اختيار')) {
        toast(message || 'فشل اختيار الشعار', 'error');
      }
    } finally {
      setPickingLogo(false);
    }
  }, [toast, update]);

  const removeStoreLogo = useCallback(() => {
    update({storeLogoPath: null});
    toast('تمت إزالة الشعار', 'info');
  }, [toast, update]);

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
      'سيتم حذف كل المنتجات والتصنيفات والوحدات والمبيعات والجرد والبصمات البصرية نهائياً. لا يمكن التراجع!',
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

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}>
        {/* ── Subscription ───────────────────────────────────── */}
        <SubscriptionSection />

        {/* ── Appearance ─────────────────────────────────────── */}
        <Card style={styles.group}>
          <SectionTitle
            title="المظهر"
            hint="الوضع النهاري أو الليلي أو حسب النظام"
          />
          <Segmented
            value={themeMode}
            onChange={(value: ThemeMode) => setThemeMode(value)}
            options={[
              {value: 'light', label: 'نهاري'},
              {value: 'dark', label: 'ليلي'},
              {value: 'system', label: 'تلقائي'},
            ]}
          />
        </Card>

        {/* ── Store info + logo ──────────────────────────────── */}
        <Card style={styles.group}>
          <SectionTitle
            title="معلومات المحل"
            hint="تظهر أعلى الفاتورة المطبوعة"
          />
          <View style={styles.logoRow}>
            {settings.storeLogoPath ? (
              <Image
                source={{uri: `file://${settings.storeLogoPath}`}}
                style={styles.logoImage}
              />
            ) : (
              <View style={[styles.logoImage, styles.logoFallback]}>
                <Icon name="imagePlus" size={22} color={c.textFaint} />
              </View>
            )}
            <View style={{flex: 1, gap: spacing.sm}}>
              <AppButton
                small
                title={settings.storeLogoPath ? 'تغيير الشعار' : 'اختيار شعار'}
                variant="secondary"
                icon="imagePlus"
                loading={pickingLogo}
                onPress={pickStoreLogo}
              />
              {settings.storeLogoPath ? (
                <AppButton
                  small
                  title="إزالة الشعار"
                  variant="ghost"
                  icon="trash"
                  onPress={removeStoreLogo}
                />
              ) : null}
            </View>
          </View>
          <Text style={styles.logoHint}>
            يُطبع الشعار أعلى الفاتورة الحرارية ويظهر في الشاشة الرئيسية.
          </Text>
          <Field
            label="اسم المحل"
            value={settings.storeName}
            onChangeText={text => update({storeName: text})}
            placeholder="متجر sela"
          />
          <Field
            label="رقم الهاتف (اختياري)"
            value={settings.storePhone}
            onChangeText={text => update({storePhone: text})}
            placeholder="05XXXXXXXX"
            keyboardType="phone-pad"
          />
          <Field
            label="رسالة أسفل الفاتورة"
            value={settings.footerMessage}
            onChangeText={text => update({footerMessage: text})}
            placeholder="شكراً لتعاملكم معنا"
            multiline
            numberOfLines={2}
          />
        </Card>

        {/* ── Scanner engine ─────────────────────────────────── */}
        <Card style={styles.group}>
          <SectionTitle
            title="طريقة المسح عند البيع"
            hint="اختر ما يناسب عملك — الباركود أسرع، البصري بلا باركود"
          />
          <Segmented
            value={settings.scannerMode}
            onChange={(value: ScannerMode) => update({scannerMode: value})}
            options={[
              {value: 'barcode', label: 'باركود'},
              {value: 'visual', label: 'بصري'},
              {value: 'both', label: 'كلاهما'},
            ]}
          />
          <Text style={styles.scannerHint}>
            {settings.scannerMode === 'barcode'
              ? 'افتح كاميرا البيع ووجّه الباركود — يُضاف المنتج فوراً، ويمكن مسح باركود وحدة كاملة (كرتونة).'
              : settings.scannerMode === 'visual'
              ? 'الكاميرا تلتقط تلقائياً وتطابق بصمة المنتج — لا يحتاج باركود إطلاقاً.'
              : 'الباركود يعمل باستمرار + زر التقاط للتعرف البصري في نفس الشاشة.'}
          </Text>
          <SwitchRow
            icon="scan"
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
            label={`حد التشابه للتعرف (% افتراضي ${Math.round(
              settings.matchThreshold * 100,
            )})`}
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

        {/* ── Selling ────────────────────────────────────────── */}
        <Card style={styles.group}>
          <SectionTitle title="البيع" />
          <Text style={styles.fieldLabel}>وضع التسعير الافتراضي</Text>
          <Segmented
            value={settings.defaultPricingMode}
            onChange={(value: PricingMode) =>
              update({defaultPricingMode: value})
            }
            options={[
              {value: 'RETAIL', label: 'مفرق'},
              {value: 'WHOLESALE', label: 'جملة'},
            ]}
          />
        </Card>

        {/* ── Receipts ───────────────────────────────────────── */}
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

        {/* ── Notifications ──────────────────────────────────── */}
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

        {/* ── Management ─────────────────────────────────────── */}
        <Card style={styles.group}>
          <SectionTitle title="الإدارة" hint="التصنيفات والوحدات والجرد" />
          <SettingRow
            icon="shapes"
            label="إدارة التصنيفات"
            hint="إضافة وتعديل وحذف تصنيفات المنتجات"
            onPress={() => navigation.navigate('ManageCategories' as never)}
          />
          <SettingRow
            icon="scale"
            label="إدارة الوحدات"
            hint="كرتونة، كيلو، علبة… لبيع الكميات المعبأة"
            onPress={() => navigation.navigate('ManageUnits' as never)}
          />
          <SettingRow
            icon="clipboard"
            label="الجرد"
            hint="جلسة جرد كاملة مع تقرير الفروقات"
            onPress={() => navigation.navigate('Stocktake' as never)}
          />
        </Card>

        {/* ── Device ─────────────────────────────────────────── */}
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

        {/* ── Data tools ─────────────────────────────────────── */}
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
  const c = useThemeColors();
  const styles = useStyles();
  return (
    <TouchableOpacity
      style={styles.settingRow}
      onPress={onPress}
      activeOpacity={0.75}>
      <View style={styles.settingIcon}>
        <Icon name={icon} size={18} color={c.accent} />
      </View>
      <View style={{flex: 1}}>
        <Text style={styles.settingLabel}>{label}</Text>
        <Text style={styles.settingHint}>{hint}</Text>
      </View>
      <Icon name="chevronLeft" size={16} color={c.textFaint} />
    </TouchableOpacity>
  );
}

const useStyles = makeStyles(c =>
  StyleSheet.create({
    screen: {flex: 1, backgroundColor: c.bg},
    content: {
      padding: spacing.lg,
      gap: spacing.md,
      paddingBottom: spacing.xxl,
    },
    group: {gap: spacing.md},
    fieldLabel: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    scannerHint: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      lineHeight: 18,
    },
    logoRow: {
      flexDirection: 'row',
      gap: spacing.md,
      alignItems: 'center',
    },
    logoImage: {
      width: 84,
      height: 84,
      borderRadius: radius.md,
      backgroundColor: c.surfaceAlt,
      borderWidth: 1,
      borderColor: c.border,
    },
    logoFallback: {
      alignItems: 'center',
      justifyContent: 'center',
    },
    logoHint: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 0.5,
      marginTop: -spacing.xs,
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
      backgroundColor: c.accentSoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    settingLabel: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.caption,
    },
    settingHint: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      marginTop: 1,
    },
    about: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      textAlign: 'center',
      marginTop: spacing.md,
    },
  }),
);
