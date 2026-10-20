/**
 * CashiersScreen — v58 (الجولة 62): إدارة الكاشير على الشبكة المحلية.
 * ─────────────────────────────────────────────────────────────────
 * شاشة المدير في نقطة البيع لكل ما يتعلق بتطبيق «سيلّا كاشير»:
 *
 *  ① مفتاح الخادم — تشغيل/إيقاف خادم الشبكة المحلية + المنفذ.
 *  ② طلبات الاتصال المعلقة — كل جهاز كاشير يتصل أول مرة يظهر هنا
 *     بانتظار موافقة المدير (اسمح/ارفض) كما طلب التاجر حرفياً.
 *  ③ حسابات الكاشيرين — إنشاء (اسم مستخدم + كلمة مرور + اسم
 *     معروض)، تعديل، السماح/المنع، سقف الخصم لكل كاشير، وحذف.
 *  ④ أجهزة كل كاشير — موافق عليها/معلقة/مرفوضة + قطع الثقة +
 *     آخر ظهور («متصل الآن» خلال ٣٠ ثانية) وإحصاءاته.
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  ActivityIndicator,
  Alert,
  I18nManager,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '../../navigation/RootNavigator';
import {Icon} from '../../components/Icon';
import {
  AppButton,
  AppHeader,
  Badge,
  Card,
  EmptyState,
  Screen,
  SectionTitle,
  SwitchRow,
} from '../../components/ui';
import {
  CashiersRepo,
  type CashierDeviceRecord,
  type CashierRecord,
  type CashierStats,
} from '../../database/repositories/CashiersRepo';
import {LanServerService} from '../../services/lan/LanServerService';
import {LanServerNative} from '../../native/nativeBridge';
import {useLanStore} from '../../stores/lanStore';
import {useSettingsStore} from '../../stores/settingsStore';
import {useToastStore} from '../../stores/toastStore';
import {LAN_ONLINE_WINDOW_MS} from '../../core/config';
import {
  fonts,
  makeStyles,
  spacing,
  typography,
  useThemeColors,
} from '../../core/theme';

function deviceOnline(device: CashierDeviceRecord): boolean {
  if (!device.last_seen_at) {
    return false;
  }
  const seen = new Date(device.last_seen_at.replace(' ', 'T')).getTime();
  return Number.isFinite(seen) && Date.now() - seen < LAN_ONLINE_WINDOW_MS;
}

export function CashiersScreen() {
  const c = useThemeColors();
  const styles = useStyles();
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const toast = useToastStore(state => state.show);
  const settings = useSettingsStore(state => state.settings);
  const updateSettings = useSettingsStore(state => state.update);
  const lanRunning = useLanStore(state => state.running);
  const lanStarting = useLanStore(state => state.starting);
  const lanError = useLanStore(state => state.lastError);

  const [cashiers, setCashiers] = useState<CashierRecord[]>([]);
  const [devices, setDevices] = useState<
    Record<number, CashierDeviceRecord[]>
  >({});
  const [stats, setStats] = useState<Record<number, CashierStats>>({});
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<CashierRecord | null>(null);
  const [localIp, setLocalIp] = useState<string | null>(null);
  const [qrOpen, setQrOpen] = useState(false);

  // v59: عنوان IP المحلي لعرضه مع رمز QR للاتصال السريع.
  useEffect(() => {
    if (!lanRunning) {
      setLocalIp(null);
      return;
    }
    let alive = true;
    const fetchIp = () => {
      LanServerNative?.localIp()
        .then(ip => {
          if (alive) {
            setLocalIp(ip);
          }
        })
        .catch(() => undefined);
    };
    fetchIp();
    const timer = setInterval(fetchIp, 10000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [lanRunning]);

  const refresh = useCallback(async () => {
    try {
      const list = await CashiersRepo.list();
      const deviceMap: Record<number, CashierDeviceRecord[]> = {};
      const statsMap: Record<number, CashierStats> = {};
      for (const cashier of list) {
        deviceMap[cashier.id] = await CashiersRepo.devicesFor(cashier.id);
        statsMap[cashier.id] = await CashiersRepo.statsFor(cashier.id);
      }
      setCashiers(list);
      setDevices(deviceMap);
      setStats(statsMap);
    } catch {
      // القاعدة مشغولة مؤقتاً — التحديث التالي يلتقطها.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 4000);
    return () => clearInterval(timer);
  }, [refresh]);

  const pendingDevices = useMemo(() => {
    const all: {cashier: CashierRecord; device: CashierDeviceRecord}[] = [];
    for (const cashier of cashiers) {
      for (const device of devices[cashier.id] ?? []) {
        if (device.status === 'pending') {
          all.push({cashier, device});
        }
      }
    }
    return all;
  }, [cashiers, devices]);

  const connectedCount = useMemo(() => {
    let count = 0;
    for (const list of Object.values(devices)) {
      for (const device of list) {
        if (device.status === 'approved' && deviceOnline(device)) {
          count += 1;
        }
      }
    }
    return count;
  }, [devices]);

  const toggleServer = useCallback(
    async (enabled: boolean) => {
      updateSettings({lanServerEnabled: enabled});
      if (enabled) {
        const ok = await LanServerService.start();
        if (!ok) {
          updateSettings({lanServerEnabled: false});
          toast('تعذر تشغيل خادم الكاشير — جرّب لاحقاً', 'error');
        } else {
          toast('خادم الكاشير يعمل — ابحث عن المتجر من تطبيق الكاشير', 'success');
        }
      } else {
        await LanServerService.stop();
        toast('أُوقف خادم الكاشير', 'info');
      }
    },
    [toast, updateSettings],
  );

  const approve = useCallback(
    async (device: CashierDeviceRecord) => {
      await CashiersRepo.approveDevice(device.id);
      toast('تمت الموافقة على الجهاز — يمكن للكاشير الدخول الآن', 'success');
      void refresh();
    },
    [refresh, toast],
  );

  const deny = useCallback(
    async (device: CashierDeviceRecord) => {
      await CashiersRepo.denyDevice(device.id);
      toast('رُفض الجهاز', 'info');
      void refresh();
    },
    [refresh, toast],
  );

  const revoke = useCallback(
    async (device: CashierDeviceRecord) => {
      await CashiersRepo.revokeDevice(device.id);
      toast('أُلغيت ثقة الجهاز — يحتاج موافقتك للدخول مجدداً', 'info');
      void refresh();
    },
    [refresh, toast],
  );

  const removeCashier = useCallback(
    (cashier: CashierRecord) => {
      Alert.alert(
        'حذف كاشير',
        `حذف «${cashier.display_name}»؟ فواتيره تبقى في السجلات، لكن لن يستطيع الدخول مجدداً.`,
        [
          {text: 'إلغاء', style: 'cancel'},
          {
            text: 'حذف',
            style: 'destructive',
            onPress: async () => {
              await CashiersRepo.removeCashier(cashier.id);
              toast('حُذف حساب الكاشير', 'info');
              void refresh();
            },
          },
        ],
      );
    },
    [refresh, toast],
  );

  // v59: تبديل صلاحيات الكاشير (الدين / المرتجعات) من بطاقته مباشرة.
  const togglePerm = useCallback(
    async (cashier: CashierRecord, perm: 'debt' | 'returns') => {
      const patch =
        perm === 'debt'
          ? {canDebt: cashier.can_debt !== 1}
          : {canReturn: cashier.can_return !== 1};
      await CashiersRepo.updateCashier(cashier.id, patch);
      toast(
        perm === 'debt'
          ? patch.canDebt
            ? `فُتح البيع بالدين لـ ${cashier.display_name}`
            : `أُغلق البيع بالدين لـ ${cashier.display_name}`
          : patch.canReturn
          ? `فُتحت المرتجعات لـ ${cashier.display_name}`
          : `أُغلقت المرتجعات لـ ${cashier.display_name}`,
        'info',
      );
      void refresh();
    },
    [refresh, toast],
  );

  return (
    <Screen>
      <AppHeader
        title="الكاشير على الشبكة"
        subtitle={
          lanRunning ? `يعمل الآن — ${connectedCount} متصل` : 'خادم مطفأ'
        }
        showBack
      />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled">
        {/* ① الخادم */}
        <Card style={styles.card}>
          <SwitchRow
            label="خادم الشبكة المحلية"
            hint="اسمح لتطبيق «سيلّا كاشير» بالاتصال من نفس شبكة Wi-Fi"
            value={settings.lanServerEnabled && lanRunning}
            onValueChange={toggleServer}
            icon="link"
          />
          {lanStarting ? (
            <ActivityIndicator color={c.accent} style={styles.smallGap} />
          ) : null}
          {lanRunning ? (
            <View style={styles.serverInfoRow}>
              <Badge
                label={`المنفذ ${settings.lanPort ?? 8950}`}
                tone="accent"
              />
              <Badge
                label={
                  connectedCount > 0
                    ? `${connectedCount} جهاز متصل`
                    : 'لا اتصالات الآن'
                }
                tone={connectedCount > 0 ? 'success' : 'neutral'}
              />
            </View>
          ) : null}
          {lanError ? (
            <Text style={styles.errorText}>{lanError}</Text>
          ) : null}
          <Text style={styles.hintText}>
            أبقِ هذا التطبيق مفتوحاً أثناء عمل الكاشير — كل عملية بيع أو
            إرجاع من الكاشير تُسجَّل هنا لحظياً في الفواتير والخزينة
            والديون باسمه.
          </Text>
          {lanRunning ? (
            <Pressable
              style={styles.qrTile}
              onPress={() => setQrOpen(true)}>
              <View style={styles.qrIconChip}>
                <Icon name="qr" size={26} color={c.accent} />
              </View>
              <View style={{flex: 1}}>
                <Text style={styles.qrTileTitle}>اتصال سريع بباركود</Text>
                <Text style={styles.qrTileSub}>
                  {localIp
                    ? `${localIp}:${settings.lanPort ?? 8950} — امسح الرمز من تطبيق الكاشير للاتصال فوراً`
                    : 'اعرض رمز QR ليتصل تطبيق الكاشير بلا إدخال يدوي'}
                </Text>
              </View>
              <Icon
                name="chevronLeft"
                size={18}
                color={c.textFaint}
              />
            </Pressable>
          ) : null}
        </Card>

        {/* ② طلبات اتصال معلقة */}
        {pendingDevices.length > 0 ? (
          <>
            <SectionTitle
              title="طلبات اتصال بانتظار موافقتك"
              hint="جهاز كاشير يحاول الدخول لأول مرة"
            />
            {pendingDevices.map(({cashier, device}) => (
              <Card key={device.id} style={styles.card}>
                <View style={styles.pendingHead}>
                  <View style={{flex: 1}}>
                    <Text style={styles.strong}>
                      {cashier.display_name}
                    </Text>
                    <Text style={styles.dim}>
                      {device.device_label || 'جهاز'} · {device.ip ?? ''}
                    </Text>
                  </View>
                  <Badge label="بانتظار الموافقة" tone="warning" />
                </View>
                <View style={styles.actionRow}>
                  <AppButton
                    title="السماح"
                    variant="success"
                    small
                    onPress={() => void approve(device)}
                    style={{flex: 1}}
                  />
                  <AppButton
                    title="الرفض"
                    variant="danger"
                    small
                    onPress={() => void deny(device)}
                    style={{flex: 1}}
                  />
                </View>
              </Card>
            ))}
          </>
        ) : null}

        {/* ③ الحسابات */}
        <SectionTitle
          title="حسابات الكاشيرين"
          hint="اسم مستخدم وكلمة مرور لكل كاشير — أنت تمنحها وتتحكم بها"
        />
        <AppButton
          title="إضافة كاشير جديد"
          icon="plus"
          small
          onPress={() => setAddOpen(true)}
        />
        {loading ? (
          <ActivityIndicator color={c.accent} />
        ) : cashiers.length === 0 ? (
          <EmptyState
            icon="user"
            title="لا كاشيرين بعد"
            subtitle="أنشئ حساباً لكل كاشير يعمل على جهازه من تطبيق سيلّا كاشير"
          />
        ) : (
          cashiers.map(cashier => (
            <Card key={cashier.id} style={styles.card}>
              <View style={styles.cashierHead}>
                <View style={{flex: 1}}>
                  <Text style={styles.strong}>{cashier.display_name}</Text>
                  <Text style={styles.dim}>
                    @{cashier.username} · خصم حتى {cashier.max_discount_pct}%
                  </Text>
                </View>
                <Badge
                  label={cashier.is_active === 1 ? 'مسموح' : 'ممنوع'}
                  tone={cashier.is_active === 1 ? 'success' : 'danger'}
                />
              </View>

              {/* v59: صلاحيات الكاشير — دين ومرتجعات (طلب التاجر) */}
              <View style={styles.permRow}>
                <Pressable
                  style={[
                    styles.permChip,
                    cashier.can_debt === 1 ? styles.permChipOn : null,
                  ]}
                  onPress={() => void togglePerm(cashier, 'debt')}>
                  <Icon
                    name="tag"
                    size={15}
                    color={cashier.can_debt === 1 ? c.success : c.textFaint}
                  />
                  <Text
                    style={[
                      styles.permText,
                      cashier.can_debt === 1 ? {color: c.success} : null,
                    ]}>
                    {cashier.can_debt === 1 ? 'الدين مفتوح' : 'الدين مغلق'}
                  </Text>
                </Pressable>
                <Pressable
                  style={[
                    styles.permChip,
                    cashier.can_return === 1 ? styles.permChipOn : null,
                  ]}
                  onPress={() => void togglePerm(cashier, 'returns')}>
                  <Icon
                    name="undo"
                    size={15}
                    color={cashier.can_return === 1 ? c.success : c.textFaint}
                  />
                  <Text
                    style={[
                      styles.permText,
                      cashier.can_return === 1 ? {color: c.success} : null,
                    ]}>
                    {cashier.can_return === 1
                      ? 'المرتجعات مفتوحة'
                      : 'المرتجعات مغلقة'}
                  </Text>
                </Pressable>
              </View>

              <View style={styles.statsRow}>
                <View style={styles.statBox}>
                  <Text style={styles.statValue}>
                    {stats[cashier.id]?.salesCount ?? 0}
                  </Text>
                  <Text style={styles.dim}>فاتورة</Text>
                </View>
                <View style={styles.statBox}>
                  <Text style={styles.statValue}>
                    {(stats[cashier.id]?.salesTotal ?? 0).toFixed(2)}
                  </Text>
                  <Text style={styles.dim}>مبيعات ₪</Text>
                </View>
                <View style={styles.statBox}>
                  <Text style={styles.statValue}>
                    {Math.abs(stats[cashier.id]?.returnsTotal ?? 0).toFixed(2)}
                  </Text>
                  <Text style={styles.dim}>مرتجعات ₪</Text>
                </View>
              </View>

              {(devices[cashier.id] ?? []).length > 0 ? (
                <View style={styles.devicesWrap}>
                  {(devices[cashier.id] ?? []).map(device => (
                    <View key={device.id} style={styles.deviceRow}>
                      <View style={{flex: 1}}>
                        <Text style={styles.deviceLabel} numberOfLines={1}>
                          {device.device_label || 'جهاز'}
                        </Text>
                        <Text style={styles.dim}>
                          {device.status === 'approved'
                            ? deviceOnline(device)
                              ? 'متصل الآن'
                              : 'موافق عليه'
                            : device.status === 'pending'
                            ? 'بانتظار الموافقة'
                            : 'مرفوض'}
                        </Text>
                      </View>
                      {device.status === 'pending' ? (
                        <View style={styles.actionRowTiny}>
                          <AppButton
                            title="سماح"
                            variant="success"
                            small
                            onPress={() => void approve(device)}
                          />
                          <AppButton
                            title="رفض"
                            variant="danger"
                            small
                            onPress={() => void deny(device)}
                          />
                        </View>
                      ) : device.status === 'approved' ? (
                        <AppButton
                          title="قطع الثقة"
                          variant="ghost"
                          small
                          onPress={() => void revoke(device)}
                        />
                      ) : (
                        <AppButton
                          title="موافقة"
                          variant="ghost"
                          small
                          onPress={() => void approve(device)}
                        />
                      )}
                    </View>
                  ))}
                </View>
              ) : null}

              <View style={styles.actionRow}>
                <AppButton
                  title={
                    cashier.is_active === 1 ? 'منع الاتصال' : 'السماح بالاتصال'
                  }
                  variant={cashier.is_active === 1 ? 'secondary' : 'success'}
                  small
                  style={{flex: 1}}
                  onPress={async () => {
                    await CashiersRepo.updateCashier(cashier.id, {
                      isActive: cashier.is_active === 1 ? 0 : 1,
                    });
                    void refresh();
                  }}
                />
                <AppButton
                  title="تعديل"
                  variant="secondary"
                  small
                  style={{flex: 1}}
                  onPress={() => setEditing(cashier)}
                />
                <AppButton
                  title="حذف"
                  variant="danger"
                  small
                  style={{flex: 1}}
                  onPress={() => removeCashier(cashier)}
                />
              </View>
              <AppButton
                title="التقرير التفصيلي للكاشير"
                icon="chart"
                variant="ghost"
                small
                onPress={() =>
                  navigation.navigate('CashierReport', {
                    cashierId: cashier.id,
                  })
                }
              />
            </Card>
          ))
        )}
      </ScrollView>

      {addOpen ? (
        <CashierFormModal
          onClose={() => setAddOpen(false)}
          onSaved={() => {
            setAddOpen(false);
            void refresh();
          }}
        />
      ) : null}
      {editing ? (
        <CashierFormModal
          cashier={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void refresh();
          }}
        />
      ) : null}
      {qrOpen && localIp ? (
        <Modal
          transparent
          visible
          animationType="fade"
          onRequestClose={() => setQrOpen(false)}>
          <Pressable
            style={styles.modalBackdrop}
            onPress={() => setQrOpen(false)}>
            <Pressable style={styles.qrCard} onPress={() => undefined}>
              <Text style={styles.modalTitle}>اتصال سريع بباركود</Text>
              <Text style={styles.qrHint}>
                من تطبيق «سيلّا كاشير» اختر «مسح باركود الاتصال» ووجّه
                الكاميرا إلى هذا الرمز — يتصل بالمتجر فوراً بلا إدخال يدوي.
              </Text>
              <View style={styles.qrWrap}>
                <QRCode
                  value={`sela-cashier://${localIp}:${settings.lanPort ?? 8950}`}
                  size={210}
                  backgroundColor="#FFFFFF"
                  color="#17171D"
                />
              </View>
              <Text style={styles.qrAddress}>
                {localIp}:{settings.lanPort ?? 8950}
              </Text>
              <Text style={styles.dim}>
                كذلك يظهر متجرك تلقائياً في بحث الشبكة داخل تطبيق الكاشير
              </Text>
              <AppButton
                title="إغلاق"
                variant="ghost"
                small
                onPress={() => setQrOpen(false)}
              />
            </Pressable>
          </Pressable>
        </Modal>
      ) : null}
    </Screen>
  );
}

/** v62 (الجولة 66 #5): حقل إدخال داخل النافذة — مطوّر بالكامل:
 *  انتقال «التالي» بين الحقول (refs + onSubmitEditing)، إظهار
 *  كلمة المرور بعين قابلة للتبديل، أخطاء داخلية تحت الحقل نفسه
 *  (حدّ أحمر + نص)، حد أقصى للطول، وأنواع لوحة مفاتيح صحيحة. */
function ModalField({
  label,
  value,
  onChangeText,
  placeholder,
  secure = false,
  numeric = false,
  suffix,
  inputRef,
  onSubmitEditing,
  returnKeyType,
  error,
  maxLength,
  autoFocus = false,
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  secure?: boolean;
  numeric?: boolean;
  suffix?: string;
  inputRef?: React.RefObject<TextInput>;
  onSubmitEditing?: () => void;
  returnKeyType?: 'next' | 'done';
  error?: string | null;
  maxLength?: number;
  autoFocus?: boolean;
}) {
  const c = useThemeColors();
  const [revealed, setRevealed] = useState(false);
  return (
    <View>
      <Text
        style={{
          color: error != null ? c.danger : c.textDim,
          fontFamily: fonts.medium,
          fontSize: typography.small,
          textAlign: 'right',
          marginBottom: 4,
        }}>
        {label}
      </Text>
      <View
        style={{
          flexDirection: 'row-reverse',
          alignItems: 'center',
          backgroundColor: c.surfaceHi,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: error != null ? c.danger : c.borderSoft,
          paddingHorizontal: 12,
        }}>
        <TextInput
          ref={inputRef}
          style={{
            flex: 1,
            color: c.text,
            fontFamily: fonts.regular,
            fontSize: typography.body,
            paddingVertical: 10,
            textAlign: I18nManager.isRTL ? 'right' : 'left',
          }}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={c.textFaint}
          secureTextEntry={secure && !revealed}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={maxLength}
          autoFocus={autoFocus}
          keyboardType={numeric ? 'number-pad' : 'default'}
          returnKeyType={returnKeyType ?? (onSubmitEditing ? 'next' : 'done')}
          onSubmitEditing={onSubmitEditing}
          blurOnSubmit={returnKeyType !== 'next' || onSubmitEditing == null}
        />
        {suffix ? (
          <Text
            style={{
              color: c.textDim,
              fontFamily: fonts.medium,
              fontSize: typography.small,
            }}>
            {suffix}
          </Text>
        ) : null}
        {secure ? (
          <Pressable
            onPress={() => setRevealed(shown => !shown)}
            hitSlop={{top: 10, bottom: 10, left: 6, right: 6}}
            accessibilityLabel={
              revealed ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور'
            }
            style={{marginRight: 4}}>
            <Icon
              name={revealed ? 'eyeOff' : 'eye'}
              size={17}
              color={c.textDim}
            />
          </Pressable>
        ) : null}
      </View>
      {error != null ? (
        <Text
          style={{
            color: c.danger,
            fontFamily: fonts.regular,
            fontSize: typography.micro + 1,
            textAlign: 'right',
            marginTop: 3,
          }}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

/** نموذج إنشاء/تعديل حساب كاشير — v62 (الجولة 66 #5) مطوّر:
 *  تمرير داخلي (ScrollView) فلا يقصّ المحتوى على الشاشات الصغيرة
 *  أو مع لوحة المفاتيح المفتوحة، انتقال «التالي» بين الحقول،
 *  أخطاء داخلية لكل حقل، وزر «إنشاء وإضافة التالي» يُبقي النافذة
 *  مفتوحة لإدخال كاشير آخر متتابعين. */
function CashierFormModal({
  cashier,
  onClose,
  onSaved,
}: {
  cashier?: CashierRecord;
  onClose: () => void;
  onSaved: () => void;
}) {
  const c = useThemeColors();
  const styles = useStyles();
  const toast = useToastStore(state => state.show);
  const [username, setUsername] = useState(cashier?.username ?? '');
  const [displayName, setDisplayName] = useState(cashier?.display_name ?? '');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [maxDiscount, setMaxDiscount] = useState(
    String(cashier?.max_discount_pct ?? 10),
  );
  const [canDebt, setCanDebt] = useState(
    cashier ? cashier.can_debt === 1 : true,
  );
  const [canReturn, setCanReturn] = useState(
    cashier ? cashier.can_return === 1 : true,
  );
  const [busy, setBusy] = useState(false);
  // v62: أخطاء داخلية لكل حقل — تُمسح فور تصحيح القيمة.
  const [errors, setErrors] = useState<{
    username?: string;
    displayName?: string;
    password?: string;
    password2?: string;
    maxDiscount?: string;
  }>({});

  const isEdit = cashier != null;

  const usernameRef = useRef<TextInput>(null);
  const displayNameRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);
  const password2Ref = useRef<TextInput>(null);
  const maxDiscountRef = useRef<TextInput>(null);

  const validate = useCallback((): boolean => {
    const next: typeof errors = {};
    if (!isEdit) {
      const name = username.trim();
      if (name.length === 0) {
        next.username = 'اسم المستخدم مطلوب للدخول';
      } else if (name.length < 3) {
        next.username = 'ثلاثة أحرف على الأقل';
      } else if (/\s/.test(name)) {
        next.username = 'بلا مسافات — أحرف وأرقام فقط';
      }
    }
    if (displayName.trim().length === 0) {
      next.displayName = 'اسم الكاشير مطلوب (يظهر على فواتيره)';
    }
    if (isEdit) {
      if (password.length > 0 && password.length < 4) {
        next.password = 'كلمة المرور 4 أحرف على الأقل (أو اتركها فارغة)';
      }
    } else if (password.length < 4) {
      next.password = 'كلمة المرور 4 أحرف على الأقل';
    }
    if (password2 !== password) {
      next.password2 = 'كلمتا المرور غير متطابقتين';
    }
    const discount = Number(maxDiscount);
    if (
      maxDiscount.trim().length === 0 ||
      !Number.isFinite(discount) ||
      discount < 0 ||
      discount > 100
    ) {
      next.maxDiscount = 'نسبة صحيحة بين 0 و 100';
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }, [displayName, isEdit, maxDiscount, password, password2, username]);

  /** ينشئ الحساب — `next` يبقي النافذة مفتوحة ويصفّر الحقول لإدخال
   *  كاشير آخر فوراً («الانتقال للتالي» بطلب التاجر). */
  const save = async (mode: 'close' | 'next') => {
    if (busy) {
      return;
    }
    if (!validate()) {
      toast('راجع الحقول المعلّمة بالأحمر', 'error');
      return;
    }
    setBusy(true);
    try {
      if (isEdit) {
        await CashiersRepo.updateCashier(cashier.id, {
          displayName: displayName.trim() || cashier.display_name,
          maxDiscountPct: Number(maxDiscount) || 0,
          canDebt,
          canReturn,
          ...(password.length >= 4 ? {password} : {}),
        });
        toast('حُدِّث حساب الكاشير', 'success');
        onSaved();
        return;
      }
      await CashiersRepo.createCashier({
        username: username.trim(),
        password,
        displayName: displayName.trim(),
        maxDiscountPct: Number(maxDiscount) || 0,
        canDebt,
        canReturn,
      });
      if (mode === 'next') {
        toast(
          `أُنشئ حساب ${displayName.trim()} — أدخل بيانات الكاشير التالي`,
          'success',
        );
        setUsername('');
        setDisplayName('');
        setPassword('');
        setPassword2('');
        setErrors({});
        // نبدأ من أول حقل مباشرة — إدخال متتابع بلا لمس إضافي.
        requestAnimationFrame(() => usernameRef.current?.focus());
      } else {
        toast(
          'أُنشئ حساب الكاشير — أعطه الاسم وكلمة المرور لتسجيل الدخول',
          'success',
        );
        onSaved();
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'تعذر إنشاء الحساب';
      toast(message, 'error');
      // اسم مستخدم مكرر؟ علّم حقه مباشرة.
      if (message.includes('مستخدم') || message.includes('username')) {
        setErrors(prev => ({...prev, username: message}));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      transparent
      visible
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={styles.modalCard} onPress={() => undefined}>
          <ScrollView
            style={styles.modalScroll}
            contentContainerStyle={styles.modalScrollContent}
            keyboardShouldPersistTaps="handled">
            <Text style={styles.modalTitle}>
              {isEdit ? 'تعديل حساب الكاشير' : 'كاشير جديد'}
            </Text>
            {!isEdit ? (
              <ModalField
                label="اسم المستخدم (للدخول)"
                value={username}
                onChangeText={text => {
                  setUsername(text);
                  if (errors.username) {
                    setErrors(prev => ({...prev, username: undefined}));
                  }
                }}
                placeholder="مثال: ahmad"
                maxLength={30}
                autoFocus
                inputRef={usernameRef}
                returnKeyType="next"
                onSubmitEditing={() => displayNameRef.current?.focus()}
                error={errors.username}
              />
            ) : null}
            <ModalField
              label="اسم الكاشير (يظهر في الفواتير)"
              value={displayName}
              onChangeText={text => {
                setDisplayName(text);
                if (errors.displayName) {
                  setErrors(prev => ({...prev, displayName: undefined}));
                }
              }}
              placeholder="مثال: أحمد"
              maxLength={40}
              inputRef={displayNameRef}
              returnKeyType="next"
              onSubmitEditing={() => passwordRef.current?.focus()}
              error={errors.displayName}
            />
            <ModalField
              label={
                isEdit
                  ? 'كلمة مرور جديدة (اتركها فارغة للإبقاء)'
                  : 'كلمة المرور'
              }
              value={password}
              onChangeText={text => {
                setPassword(text);
                if (errors.password) {
                  setErrors(prev => ({...prev, password: undefined}));
                }
              }}
              placeholder="4 أحرف على الأقل"
              secure
              maxLength={40}
              inputRef={passwordRef}
              returnKeyType="next"
              onSubmitEditing={() => password2Ref.current?.focus()}
              error={errors.password}
            />
            <ModalField
              label="تأكيد كلمة المرور"
              value={password2}
              onChangeText={text => {
                setPassword2(text);
                if (errors.password2) {
                  setErrors(prev => ({...prev, password2: undefined}));
                }
              }}
              placeholder="أعد كتابة كلمة المرور"
              secure
              maxLength={40}
              inputRef={password2Ref}
              returnKeyType="next"
              onSubmitEditing={() => maxDiscountRef.current?.focus()}
              error={errors.password2}
            />
            <ModalField
              label="أقصى خصم يسمح به للكاشير"
              value={maxDiscount}
              onChangeText={text => {
                setMaxDiscount(text);
                if (errors.maxDiscount) {
                  setErrors(prev => ({...prev, maxDiscount: undefined}));
                }
              }}
              numeric
              maxLength={3}
              suffix="%"
              inputRef={maxDiscountRef}
              returnKeyType="done"
              onSubmitEditing={() => void save(isEdit ? 'close' : 'next')}
              error={errors.maxDiscount}
            />
            <View style={{gap: 8, marginTop: 4}}>
              <View style={styles.permSwitchRow}>
                <Text
                  style={{
                    color: c.text,
                    fontFamily: fonts.medium,
                    fontSize: typography.small + 1,
                    textAlign: 'right',
                    flex: 1,
                  }}>
                  السماح بالبيع بالدين (دفتر المتجر)
                </Text>
                <Switch value={canDebt} onValueChange={setCanDebt} />
              </View>
              <View style={styles.permSwitchRow}>
                <Text
                  style={{
                    color: c.text,
                    fontFamily: fonts.medium,
                    fontSize: typography.small + 1,
                    textAlign: 'right',
                    flex: 1,
                  }}>
                  السماح بالمرتجعات والاستبدال
                </Text>
                <Switch value={canReturn} onValueChange={setCanReturn} />
              </View>
            </View>
            {isEdit ? (
              <View style={styles.actionRow}>
                <AppButton
                  title="إلغاء"
                  variant="ghost"
                  small
                  style={{flex: 1}}
                  onPress={onClose}
                />
                <AppButton
                  title="حفظ التعديلات"
                  variant="primary"
                  small
                  style={{flex: 1}}
                  loading={busy}
                  disabled={busy}
                  onPress={() => void save('close')}
                />
              </View>
            ) : (
              <View style={{gap: 8, marginTop: 2}}>
                <AppButton
                  title="إنشاء وإضافة التالي"
                  icon="plus"
                  variant="primary"
                  small
                  loading={busy}
                  disabled={busy}
                  onPress={() => void save('next')}
                />
                <View style={styles.actionRow}>
                  <AppButton
                    title="إلغاء"
                    variant="ghost"
                    small
                    style={{flex: 1}}
                    onPress={onClose}
                  />
                  <AppButton
                    title="إنشاء وإغلاق"
                    variant="secondary"
                    small
                    style={{flex: 1}}
                    loading={busy}
                    disabled={busy}
                    onPress={() => void save('close')}
                  />
                </View>
              </View>
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const useStyles = makeStyles(c =>
  StyleSheet.create({
    scroll: {flex: 1},
    content: {
      padding: spacing.lg,
      gap: spacing.md,
      paddingBottom: spacing.xxl,
    },
    card: {padding: spacing.md, gap: spacing.sm},
    smallGap: {marginTop: spacing.sm},
    serverInfoRow: {
      flexDirection: 'row-reverse',
      gap: spacing.sm,
      marginTop: spacing.xs,
    },
    strong: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.body,
      textAlign: 'right',
    },
    dim: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      textAlign: 'right',
      marginTop: 1,
    },
    errorText: {
      color: c.danger,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      textAlign: 'right',
    },
    hintText: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      textAlign: 'right',
      lineHeight: 19,
    },
    pendingHead: {
      flexDirection: 'row-reverse',
      alignItems: 'center',
      gap: spacing.sm,
    },
    cashierHead: {
      flexDirection: 'row-reverse',
      alignItems: 'center',
      gap: spacing.sm,
    },
    statsRow: {
      flexDirection: 'row-reverse',
      gap: spacing.sm,
    },
    statBox: {
      flex: 1,
      backgroundColor: c.surfaceHi,
      borderRadius: 10,
      paddingVertical: spacing.sm,
      alignItems: 'center',
    },
    statValue: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.body,
    },
    devicesWrap: {gap: spacing.xs},
    deviceRow: {
      flexDirection: 'row-reverse',
      alignItems: 'center',
      gap: spacing.sm,
      backgroundColor: c.surfaceHi,
      borderRadius: 10,
      padding: spacing.sm,
    },
    deviceLabel: {
      color: c.text,
      fontFamily: fonts.medium,
      fontSize: typography.small,
      textAlign: 'right',
    },
    actionRow: {
      flexDirection: 'row-reverse',
      gap: spacing.sm,
      marginTop: spacing.xs,
    },
    actionRowTiny: {flexDirection: 'row-reverse', gap: spacing.xs},
    permSwitchRow: {
      flexDirection: 'row-reverse',
      alignItems: 'center',
      gap: spacing.sm,
      backgroundColor: c.surfaceHi,
      borderRadius: 10,
      padding: spacing.sm + 2,
    },
    qrTile: {
      flexDirection: 'row-reverse',
      alignItems: 'center',
      gap: spacing.sm,
      backgroundColor: c.accentSofter,
      borderWidth: 1,
      borderColor: c.accentSoft,
      borderRadius: 12,
      padding: spacing.md,
      marginTop: spacing.xs,
    },
    qrIconChip: {
      width: 46,
      height: 46,
      borderRadius: 12,
      backgroundColor: c.surfaceHi,
      alignItems: 'center',
      justifyContent: 'center',
    },
    qrTileTitle: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.small + 1,
      textAlign: 'right',
    },
    qrTileSub: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 2,
      textAlign: 'right',
      lineHeight: 17,
      marginTop: 1,
    },
    permRow: {
      flexDirection: 'row-reverse',
      gap: spacing.sm,
    },
    permChip: {
      flex: 1,
      flexDirection: 'row-reverse',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 10,
      paddingVertical: 8,
      backgroundColor: c.surfaceHi,
    },
    permChipOn: {
      borderColor: c.successSoft,
      backgroundColor: c.successSoft,
    },
    permText: {
      color: c.textDim,
      fontFamily: fonts.medium,
      fontSize: typography.micro + 2,
    },
    qrWrap: {
      backgroundColor: '#FFFFFF',
      borderRadius: 14,
      padding: spacing.md,
      alignSelf: 'center',
    },
    qrCard: {
      backgroundColor: c.surface,
      borderRadius: 16,
      padding: spacing.lg,
      gap: spacing.md,
      maxHeight: '88%',
    },
    qrHint: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      textAlign: 'right',
      lineHeight: 19,
    },
    qrAddress: {
      color: c.accent,
      fontFamily: fonts.black,
      fontSize: typography.heading,
      textAlign: 'center',
    },
    modalBackdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.55)',
      justifyContent: 'center',
      padding: spacing.lg,
    },
    modalCard: {
      backgroundColor: c.surface,
      borderRadius: 16,
      padding: spacing.lg,
      gap: spacing.md,
      maxHeight: '88%',
    },
    /** v62 (الجولة 66 #5): تمرير داخلي للنموذج — الشاشات الصغيرة
     *  ولوحة المفاتيح المفتوحة لم تقص الحقول بعد الآن. */
    modalScroll: {
      flexGrow: 0,
    },
    modalScrollContent: {
      gap: spacing.md,
    },
    modalTitle: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: typography.heading,
      textAlign: 'right',
    },
  }),
);
