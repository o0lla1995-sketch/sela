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
import Slider, {type SliderProps} from '@react-native-community/slider';
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
import {BackupService} from '../../services/BackupService';
import {wipeAllData} from '../../database/connection';
import {useToastStore} from '../../stores/toastStore';
import {useCatalogStore} from '../../stores/catalogStore';
import {useNotificationsStore} from '../../stores/notificationsStore';
import {useSilaStore} from '../../stores/silaStore';
import {SilaSync} from '../../services/sila/SilaSync';
import {
  SelaNotificationsNative,
  SelaImagePickerNative,
} from '../../native/nativeBridge';
import {fonts, makeStyles, radius, spacing, typography} from '../../core/theme';
import {
  APP_NAME,
  APP_VERSION_LABEL,
  DEFAULT_EXPIRY_ALERT_DAYS,
  DEFAULT_LOW_STOCK_THRESHOLD,
} from '../../core/config';
import type {ScannerMode} from '../../core/config';
import {parseNumber} from '../../core/format';
import type {PricingMode} from '../../core/types';
import {
  STORE_MODES,
  storeModeConfig,
  type StoreMode,
} from '../../core/storeModes';
import {CategoryRepo} from '../../database/repositories/CategoryRepo';
import {UnitRepo} from '../../database/repositories/UnitRepo';

/** slider 5.x ships FC types that trip @types/react 18 (returns
 *  ReactNode instead of Element|null) — cast to a plain ComponentType. */
const ThemedSlider = Slider as unknown as React.ComponentType<SliderProps>;

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
  // v11 (SILA): pairing status + pending count for the SILA card.
  const silaPairing = useSilaStore(state => state.pairing);
  const silaPending = useSilaStore(state => state.pending);
  const silaPaired = silaPairing != null;

  const [requestingPermission, setRequestingPermission] = useState(false);
  const [pickingLogo, setPickingLogo] = useState(false);
  /** v33 (round-41 #4): منتقي نمط المتجر — طبقة داخلية (نفس انضباط
   *  الـ Modal في هذا الرّوم). */
  const [modePickerOpen, setModePickerOpen] = useState(false);
  const [modeBusy, setModeBusy] = useState(false);

  /** v34 (الجولة 42 #3): تبديل نمط المتجر — نطاق كامل: يزرع
   *  تصنيفات ووحدات النمط الجديد موسومة به فقط إن لم تكن موجودة
   *  له (فلا تراكم فوق بيانات الأنماط الأخرى أبداً)، ثم يحدّث
   *  إعدادات النمط ويقفل الكتالوج — والصفحة/الكتالوج يتكيّفان
   *  فوراً: كل نمط يرى تصنيفاته ووحداته فقط (بلا حذف — إعادة
   *  النمط تعيد الظهور فوراً). */
  const applyStoreMode = useCallback(
    async (mode: StoreMode) => {
      if (modeBusy || mode === settings.storeMode) {
        setModePickerOpen(false);
        return;
      }
      const config = storeModeConfig(mode);
      Alert.alert(
        `تحويل المتجر إلى: ${config.label}`,
        `ستُزرع تصنيفات ووحدات هذا المجال داخل نطاقه فقط — كل نمط يرى تصنيفاته ووحداته دون خليط أو تراكم (لا يُحذف أي منتج أو تصنيف أو وحدة قائمة)، وستتكيف صفحة المنتج وطريقة الإدخال مع مجالك تلقائياً.\n\nهل تريد المتابعة؟`,
        [
          {text: 'تراجع', style: 'cancel'},
          {
            text: 'تحويل المتجر',
            onPress: async () => {
              setModeBusy(true);
              try {
                let addedCategories = 0;
                let addedUnits = 0;
                // v34: النطاق بالنمط — نزرع داخل نطاق النمط الجديد
                // فقط، والتفرد داخل النطاق نفسه (لا عبر المجالات).
                const existingCategories = await CategoryRepo.list(mode);
                const existingNames = new Set(
                  existingCategories.map(cat => cat.name.trim()),
                );
                for (const name of config.categorySeeds) {
                  if (!existingNames.has(name)) {
                    await CategoryRepo.create(name, mode);
                    addedCategories += 1;
                  }
                }
                const existingUnits = await UnitRepo.list(mode);
                const existingUnitNames = new Set(
                  existingUnits.map(u => u.name.trim()),
                );
                for (const seed of config.unitSeeds) {
                  if (!existingUnitNames.has(seed.name)) {
                    await UnitRepo.create(
                      seed.name,
                      seed.short,
                      seed.kind,
                      mode,
                    );
                    addedUnits += 1;
                  }
                }
                update({storeMode: mode});
                await refreshCatalog();
                setModePickerOpen(false);
                toast(
                  `أصبح متجرك «${config.label}»` +
                    (addedCategories > 0 || addedUnits > 0
                      ? ` — أُضيف ${addedCategories} تصنيف و${addedUnits} وحدة لهذا المجال`
                      : ''),
                  'success',
                  5000,
                );
              } catch (error) {
                toast(
                  error instanceof Error
                    ? error.message
                    : 'تعذر تحويل نمط المتجر',
                  'error',
                );
              } finally {
                setModeBusy(false);
              }
            },
          },
        ],
      );
    },
    [modeBusy, settings.storeMode, update, refreshCatalog, toast],
  );

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

  const [busyExport, setBusyExport] = useState(false);
  const [busyRestore, setBusyRestore] = useState(false);
  // v12 (round-18 #1): manual SILA sync straight from settings.
  const [silaSyncing, setSilaSyncing] = useState(false);

  const syncSilaNow = useCallback(async () => {
    if (silaSyncing) {
      return;
    }
    setSilaSyncing(true);
    try {
      const outcome = await SilaSync.syncNow();
      toast(
        outcome.message,
        outcome.pending === 0 && outcome.state !== 'no_internet'
          ? 'success'
          : 'info',
      );
    } catch (error) {
      toast(error instanceof Error ? error.message : 'فشلت المزامنة', 'error');
    } finally {
      setSilaSyncing(false);
    }
  }, [silaSyncing, toast]);

  const backupData = useCallback(async () => {
    setBusyExport(true);
    try {
      const {path, summary} = await BackupService.exportBackup();
      toast(
        `تم حفظ النسخة في ${path} — ${summary.products} منتج و${summary.embeddings} بصمة و${summary.sales} فاتورة`,
        'success',
        6000,
      );
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'فشل إنشاء النسخة الاحتياطية',
        'error',
        5000,
      );
    } finally {
      setBusyExport(false);
    }
  }, [toast]);

  const restoreData = useCallback(async () => {
    setBusyRestore(true);
    try {
      const doc = await BackupService.pickAndParseBackup();
      const summary = BackupService.summarize(doc);
      const sila = BackupService.silaCounts(doc);
      setBusyRestore(false);
      Alert.alert(
        'استرجاع النسخة الاحتياطية',
        `هذا الملف يحتوي:\n${summary.products} منتج · ${summary.categories} تصنيف · ${summary.units} وحدة\n${summary.embeddings} بصمة بصرية · ${summary.sales} فاتورة\n${sila.debts} دين صِلة · ${sila.payments} إيصال سداد\n\nسيتم استبدال كل البيانات الحالية بمحتويات النسخة — الفواتير والديون والسدادّات تدخل إحصائيات المتجر كاملة. هل تريد المتابعة؟`,
        [
          {text: 'إلغاء', style: 'cancel'},
          {
            text: 'استرجاع الآن',
            style: 'destructive',
            onPress: async () => {
              setBusyRestore(true);
              try {
                const result = await BackupService.restoreBackup(doc);
                await refreshCatalog();
                // v15 (round-21 #2): the sila badges + counters must
                // reflect the RESTORED queues immediately — the debt
                // chip and the debts screen read these counters.
                try {
                  await useSilaStore.getState().refreshCounts();
                } catch {
                  // Store unavailable — next app start refreshes.
                }
                toast(
                  `تم الاسترجاع — ${result.products} منتج و${result.sales} فاتورة${
                    result.skippedSales
                      ? ` (تخطي ${result.skippedSales} فاتورة مكررة)`
                      : ''
                  } و${sila.debts} دين و${sila.payments} سداد`,
                  'success',
                  7000,
                );
              } catch (error) {
                toast(
                  error instanceof Error
                    ? error.message
                    : 'فشل الاسترجاع — لم تتغير بياناتك',
                  'error',
                  6000,
                );
              } finally {
                setBusyRestore(false);
              }
            },
          },
        ],
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('إلغاء')) {
        toast(message, 'error', 5000);
      }
      setBusyRestore(false);
    }
  }, [refreshCatalog, toast]);

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

        {/* ── v33 (round-41 #4): نمط المتجر — مجال عملك ────── */}
        <Card style={styles.group}>
          <SectionTitle
            title="نمط المتجر"
            hint="الأصناف والوحدات وصفحة المنتج تتكيّف مع مجالك"
          />
          <TouchableOpacity
            style={styles.modeCard}
            onPress={() => setModePickerOpen(true)}
            activeOpacity={0.8}>
            <View style={styles.modeIcon}>
              <Icon
                name={storeModeConfig(settings.storeMode).icon}
                size={24}
                color={c.accent}
              />
            </View>
            <View style={{flex: 1}}>
              <Text style={styles.modeLabel}>
                {storeModeConfig(settings.storeMode).label}
              </Text>
              <Text style={styles.modeBlurb} numberOfLines={2}>
                {storeModeConfig(settings.storeMode).blurb}
              </Text>
            </View>
            <Icon name="chevronLeft" size={16} color={c.textFaint} />
          </TouchableOpacity>
          <Text style={styles.modeHint}>
            التحويل يضيف التصنيفات والوحدات المقترحة للمجال الجديد ولا يحذف
            أي بيانات — منتجاتك وفواتيرك تبقى كما هي تماماً.
          </Text>
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
              ? 'ماسح الباركود يفتح بنافذة كاملة الشاشة — يُضاف المنتج فوراً، ويدعم باركود الوحدة الكاملة (كرتونة).'
              : settings.scannerMode === 'visual'
              ? 'صوّر المنتج بزر التصوير ويطابق التطبيق بصمته — لا يحتاج باركود إطلاقاً.'
              : 'نافذة مسح واحدة بالمحركين معاً — بدّل بين الباركود والبصري بزر داخل الكاميرا نفسها دون إغلاقها.'}
          </Text>
          <SwitchRow
            icon="flash"
            label="صوت التنبيه"
            hint="نغمة قصيرة عند إضافة منتج للسلة"
            value={settings.soundEnabled}
            onValueChange={value => update({soundEnabled: value})}
          />
          {/* v8.1: the threshold was previously a typed Field whose
              controlled value snapped back on every invalid keystroke —
              merchants literally could not edit it. Replaced with a
              live drag slider (50–95%). */}
          <View style={styles.thresholdCard}>
            <View style={styles.thresholdHead}>
              <View style={{flex: 1}}>
                <Text style={styles.fieldLabel}>حد التشابه للتعرف</Text>
                <Text style={styles.thresholdHint}>
                  أقل = تعرّف أسهل وأسرع (فرص خطأ أعلى) — أعلى = أدق (قد يفوّت
                  بعض المنتجات)
                </Text>
              </View>
              <View style={styles.thresholdValue}>
                <Text style={styles.thresholdValueText}>
                  {Math.round(settings.matchThreshold * 100)}%
                </Text>
              </View>
            </View>
            <ThemedSlider
              style={styles.slider}
              minimumValue={50}
              maximumValue={95}
              step={1}
              value={Math.round(settings.matchThreshold * 100)}
              onValueChange={value =>
                update({matchThreshold: Math.round(value) / 100})
              }
              minimumTrackTintColor={c.accent}
              maximumTrackTintColor={c.border}
              thumbTintColor={c.accent}
            />
            <View style={styles.sliderLabels}>
              <Text style={styles.sliderLabelText}>50%</Text>
              <Text style={styles.sliderLabelText}>95%</Text>
            </View>
          </View>
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
          {/* v32 (round-40 #3): نافذة تنبيه الصلاحية — قبل كم يوم من
              الانتهاء يبدأ المنتج بالظهور في تنبيهات المخزون. */}
          <Field
            label={`التنبيه قبل انتهاء الصلاحية بأيام (افتراضي ${DEFAULT_EXPIRY_ALERT_DAYS})`}
            value={String(settings.expiryAlertDays)}
            onChangeText={text => {
              const value = parseNumber(text);
              if (!Number.isNaN(value) && value >= 1 && value <= 365) {
                update({expiryAlertDays: Math.trunc(value)});
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
          {/* v33 (round-41 #3): الإشعارات تصل حتى والتطبيق مغلق — عامل
              خلفي دوري (كل 6 ساعات تقريباً) يفحص المخزون والصلاحية
              ويرسل إشعار النظام بنفسه. */}
          <View style={styles.bgNotifNote}>
            <Icon name="bell" size={13} color={c.info} />
            <Text style={styles.bgNotifText}>
              تصل التنبيهات إلى هاتفك حتى والتطبيق مغلق تماماً — فحص دوري
              للمخزون وتواريخ الصلاحية كل عدة ساعات يرسل إشعار النظام بنفسه
              (مرة واحدة لكل حالة في اليوم).
            </Text>
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
          {/* v13 (round-19 #2): app-lock entry — fingerprint + PIN. */}
          <SettingRow
            icon="fingerprint"
            label="قفل التطبيق"
            hint="فتح سيلا بالبصمة أو برمز من 4 أرقام عند التشغيل"
            onPress={() => navigation.navigate('Security' as never)}
          />
        </Card>

        {/* ── v11 (SILA): merchant account linking + debts ────── */}
        <Card style={styles.group}>
          <SectionTitle
            title="صِلة — الدين الفلسطيني"
            hint="ربط حساب التاجر، البيع بالدين، والمزامنة"
          />
          <SettingRow
            icon="qrFrame"
            label={
              silaPaired
                ? `صِلة — ${silaPairing?.merchantName ?? 'مرتبط'}`
                : 'ربط حساب التاجر في صِلة'
            }
            hint={
              silaPaired
                ? silaPending > 0
                  ? `${silaPending} دين بانتظار المزامنة`
                  : 'كل الديون مسجلة في صِلة'
                : 'لتفعيل زر «دين» في نقطة البيع — أقل من دقيقة'
            }
            onPress={() => navigation.navigate('Sila' as never)}
          />
          {/* v12 (round-18 #1): the manual sync lives right HERE in the
            settings card — the merchant asked for it from الإعدادات, and
            the result is spoken through a toast, never silent again. */}
          {silaPaired ? (
            <AppButton
              title="زامن الديون الآن"
              icon="refresh"
              variant="secondary"
              small
              loading={silaSyncing}
              onPress={() => void syncSilaNow()}
            />
          ) : null}
        </Card>

        {/* ── Data tools ─────────────────────────────────────── */}
        <Card style={styles.group}>
          <SectionTitle
            title="النسخ الاحتياطي والاستعادة"
            hint="ملف واحد يحمل كل شيء: المنتجات والوحدات والبصمات والفواتير والإعدادات"
          />
          {/* v28 (round-36 #4): the Google Drive cloud-backup center —
              linking, auto-upload every N days, the Drive backups
              list + restore-from-Drive. */}
          <SettingRow
            icon="cloudUp"
            label="النسخ السحابي على Google Drive"
            hint="رفع تلقائي كل بضعة أيام إلى حسابك + استرجاع أي نسخة"
            onPress={() => navigation.navigate('DriveBackup' as never)}
          />
          <AppButton
            title="تنزيل نسخة احتياطية (ملف JSON)"
            variant="secondary"
            icon="save"
            small
            loading={busyExport}
            onPress={backupData}
          />
          <AppButton
            title="استرجاع من نسخة احتياطية"
            variant="secondary"
            icon="inbox"
            small
            loading={busyRestore}
            onPress={restoreData}
          />
          <Text style={styles.backupHint}>
            الملف يُحفظ في مجلد التنزيلات (Downloads/SmartVisionPOS) — انقله
            لجهاز جديد أو استرجع بعد أي إعادة تثبيت بنفس الزر الثاني.
          </Text>
        </Card>

        <Card style={styles.group}>
          <SectionTitle title="أدوات متقدمة" />
          <AppButton
            title="تصدير المخزون (CSV)"
            variant="ghost"
            icon="chart"
            small
            onPress={async () => {
              try {
                const path = await ExportService.exportInventory('csv');
                toast(`تم تصدير المخزون: ${path}`, 'success', 5000);
              } catch (error) {
                toast(
                  error instanceof Error ? error.message : 'فشل التصدير',
                  'error',
                );
              }
            }}
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
          {APP_NAME} · الإصدار {APP_VERSION_LABEL} · يعمل دون إنترنت 100%
        </Text>
      </ScrollView>

      {/* ── v33 (round-41 #4): منتقي نمط المتجر — طبقة داخلية ── */}
      {modePickerOpen ? (
        <View style={styles.modeOverlay}>
          <TouchableOpacity
            style={styles.modeOverlayDim}
            activeOpacity={1}
            onPress={() => setModePickerOpen(false)}
          />
          <View style={styles.modeSheet}>
            <View style={styles.modeSheetHandle} />
            <Text style={styles.modeSheetTitle}>اختر نمط متجرك</Text>
            <Text style={styles.modeSheetHint}>
              كل نمط يجهّز الأصناف والوحدات وصفحة المنتج لمجاله — يمكنك
              التغيير لاحقاً بلا أي فقدان بيانات
            </Text>
            <ScrollView
              style={{flexShrink: 1}}
              contentContainerStyle={{gap: spacing.sm}}
              showsVerticalScrollIndicator={false}>
              {STORE_MODES.map(config => {
                const active = config.key === settings.storeMode;
                return (
                  <TouchableOpacity
                    key={config.key}
                    style={[
                      styles.modeOptionCard,
                      active ? {borderColor: c.accent, borderWidth: 1.5} : null,
                    ]}
                    onPress={() => void applyStoreMode(config.key)}
                    disabled={modeBusy}
                    activeOpacity={0.8}>
                    <View
                      style={[
                        styles.modeOptionIcon,
                        active
                          ? {backgroundColor: c.accentSoft}
                          : null,
                      ]}>
                      <Icon
                        name={config.icon}
                        size={22}
                        color={c.accent}
                      />
                    </View>
                    <View style={{flex: 1}}>
                      <Text style={styles.modeOptionLabel}>
                        {config.label}
                        {active ? '  (النمط الحالي)' : ''}
                      </Text>
                      <Text style={styles.modeOptionBlurb} numberOfLines={2}>
                        {config.blurb}
                      </Text>
                    </View>
                    {active ? (
                      <Icon name="checkCircle" size={18} color={c.success} />
                    ) : (
                      <Icon name="chevronLeft" size={15} color={c.textFaint} />
                    )}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        </View>
      ) : null}
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
    /** v33 (round-41 #3): ملاحظة الإشعارات خارج التطبيق. */
    bgNotifNote: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.sm,
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.borderSoft,
      padding: spacing.md,
    },
    bgNotifText: {
      flex: 1,
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 2,
      lineHeight: 17,
    },
    /** v33 (round-41 #4): بطاقة النمط الحالي + منتقى الأنماط. */
    modeCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: c.surfaceAlt,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      padding: spacing.md,
    },
    modeIcon: {
      width: 46,
      height: 46,
      borderRadius: 14,
      backgroundColor: c.accentSoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    modeLabel: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.body,
    },
    modeBlurb: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      lineHeight: 17,
      marginTop: 2,
    },
    modeHint: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      lineHeight: 16,
    },
    modeOverlay: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(0,0,0,0.55)',
      justifyContent: 'flex-end',
      zIndex: 60,
      elevation: 60,
    },
    modeOverlayDim: {flex: 1},
    modeSheet: {
      backgroundColor: c.bg,
      borderTopLeftRadius: 22,
      borderTopRightRadius: 22,
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.xl,
      maxHeight: '82%',
      gap: spacing.md,
    },
    modeSheetHandle: {
      alignSelf: 'center',
      width: 44,
      height: 4,
      borderRadius: 2,
      backgroundColor: c.border,
      marginTop: spacing.sm,
    },
    modeSheetTitle: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: typography.heading,
    },
    modeSheetHint: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      lineHeight: 18,
    },
    modeOptionCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      padding: spacing.md,
    },
    modeOptionIcon: {
      width: 44,
      height: 44,
      borderRadius: 13,
      backgroundColor: c.surfaceAlt,
      alignItems: 'center',
      justifyContent: 'center',
    },
    modeOptionLabel: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.body - 1,
    },
    modeOptionBlurb: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 2,
      lineHeight: 16,
      marginTop: 2,
    },

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
    thresholdCard: {
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
      padding: spacing.md,
      gap: spacing.xs,
    },
    thresholdHead: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.sm,
    },
    thresholdHint: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      lineHeight: 16,
      marginTop: 2,
    },
    thresholdValue: {
      minWidth: 58,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.accentSoft,
      borderRadius: radius.md,
      paddingHorizontal: spacing.sm,
      paddingVertical: 8,
    },
    thresholdValueText: {
      color: c.accent,
      fontFamily: fonts.black,
      fontSize: typography.body,
      fontVariant: ['tabular-nums'],
    },
    slider: {
      width: '100%',
      height: 40,
    },
    sliderLabels: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginTop: -6,
    },
    sliderLabelText: {
      color: c.textFaint,
      fontFamily: fonts.bold,
      fontSize: typography.micro + 1,
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
    backupHint: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      lineHeight: 17,
      textAlign: 'left',
    },
  }),
);
