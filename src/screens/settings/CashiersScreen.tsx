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
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {
  ActivityIndicator,
  Alert,
  I18nManager,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
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
    </Screen>
  );
}

/** حقل إدخال داخل النافذة — بسيط بستايل التطبيق (يدعم الإخفاء). */
function ModalField({
  label,
  value,
  onChangeText,
  placeholder,
  secure = false,
  numeric = false,
  suffix,
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  secure?: boolean;
  numeric?: boolean;
  suffix?: string;
}) {
  const c = useThemeColors();
  return (
    <View>
      <Text
        style={{
          color: c.textDim,
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
          borderColor: c.borderSoft,
          paddingHorizontal: 12,
        }}>
        <TextInput
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
          secureTextEntry={secure}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType={numeric ? 'number-pad' : 'default'}
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
      </View>
    </View>
  );
}

/** نموذج إنشاء/تعديل حساب كاشير. */
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
  const [busy, setBusy] = useState(false);

  const isEdit = cashier != null;

  const save = async () => {
    if (isEdit) {
      if (password.length > 0 && password !== password2) {
        toast('كلمتا المرور غير متطابقتين', 'error');
        return;
      }
      setBusy(true);
      try {
        await CashiersRepo.updateCashier(cashier.id, {
          displayName: displayName.trim() || cashier.display_name,
          maxDiscountPct: Number(maxDiscount) || 0,
          ...(password.length >= 4 ? {password} : {}),
        });
        toast('حُدِّث حساب الكاشير', 'success');
        onSaved();
      } catch (error) {
        toast(
          error instanceof Error ? error.message : 'تعذر تحديث الحساب',
          'error',
        );
      } finally {
        setBusy(false);
      }
      return;
    }
    if (!username.trim()) {
      toast('اسم المستخدم مطلوب', 'error');
      return;
    }
    if (!displayName.trim()) {
      toast('اسم الكاشير مطلوب', 'error');
      return;
    }
    if (password.length < 4) {
      toast('كلمة المرور 4 أحرف على الأقل', 'error');
      return;
    }
    if (password !== password2) {
      toast('كلمتا المرور غير متطابقتين', 'error');
      return;
    }
    setBusy(true);
    try {
      await CashiersRepo.createCashier({
        username,
        password,
        displayName,
        maxDiscountPct: Number(maxDiscount) || 0,
      });
      toast(
        'أُنشئ حساب الكاشير — أعطه الاسم وكلمة المرور لتسجيل الدخول',
        'success',
      );
      onSaved();
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'تعذر إنشاء الحساب',
        'error',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      transparent
      visible
      animationType="fade"
      onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={styles.modalCard} onPress={() => undefined}>
          <Text style={styles.modalTitle}>
            {isEdit ? 'تعديل حساب الكاشير' : 'كاشير جديد'}
          </Text>
          {!isEdit ? (
            <ModalField
              label="اسم المستخدم (للدخول)"
              value={username}
              onChangeText={setUsername}
              placeholder="مثال: ahmad"
            />
          ) : null}
          <ModalField
            label="اسم الكاشير (يظهر في الفواتير)"
            value={displayName}
            onChangeText={setDisplayName}
            placeholder="مثال: أحمد"
          />
          <ModalField
            label={
              isEdit
                ? 'كلمة مرور جديدة (اتركها فارغة للإبقاء)'
                : 'كلمة المرور'
            }
            value={password}
            onChangeText={setPassword}
            placeholder="4 أحرف على الأقل"
            secure
          />
          <ModalField
            label="تأكيد كلمة المرور"
            value={password2}
            onChangeText={setPassword2}
            placeholder="أعد كتابة كلمة المرور"
            secure
          />
          <ModalField
            label="أقصى خصم يسمح به للكاشير"
            value={maxDiscount}
            onChangeText={setMaxDiscount}
            numeric
            suffix="%"
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
              title={isEdit ? 'حفظ التعديلات' : 'إنشاء الحساب'}
              variant="primary"
              small
              style={{flex: 1}}
              loading={busy}
              disabled={busy}
              onPress={() => void save()}
            />
          </View>
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
    },
    modalTitle: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: typography.heading,
      textAlign: 'right',
    },
  }),
);
