/**
 * PrinterSettingsScreen — البحث والاقتران بالطابعة الحرارية
 * (58mm / 80mm) + إعدادات الطباعة + طباعة تجريبية.
 */
import React, {useCallback, useEffect, useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
} from 'react-native';
import {
  AppButton,
  Badge,
  Card,
  Screen,
  AppHeader,
  Segmented,
} from '../../components/ui';
import {usePrinterStore} from '../../stores/printerStore';
import {useSettingsStore} from '../../stores/settingsStore';
import {
  ThermalPrinterService,
  ensureBluetoothPermissions,
} from '../../services/printer/ThermalPrinterService';
import {buildTestJob} from '../../services/printer/receipt';
import {exportReceiptPreviewImage} from '../../services/printer/receiptPreview';
import {useToastStore} from '../../stores/toastStore';
import {
  makeStyles,
  radius,
  spacing,
  typography,
  useThemeColors,
} from '../../core/theme';
import {
  CODEPAGE_ASCII,
  CODEPAGE_CP1256,
  CODEPAGE_CP864,
} from '../../core/config';
import type {PrinterDevice} from '../../core/types';

export function PrinterSettingsScreen() {
  const c = useThemeColors();
  const styles = useStyles();
  const status = usePrinterStore(state => state.status);
  const deviceName = usePrinterStore(state => state.deviceName);
  const bonded = usePrinterStore(state => state.bonded);
  const discovered = usePrinterStore(state => state.discovered);
  const scanning = usePrinterStore(state => state.scanning);
  const lastError = usePrinterStore(state => state.lastError);
  const refreshBonded = usePrinterStore(state => state.refreshBonded);
  const startScan = usePrinterStore(state => state.startScan);
  const connect = usePrinterStore(state => state.connect);
  const disconnect = usePrinterStore(state => state.disconnect);

  const settings = useSettingsStore(state => state.settings);
  const updateSettings = useSettingsStore(state => state.update);

  const toast = useToastStore(state => state.show);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  // Initial state load.
  useEffect(() => {
    void (async () => {
      const granted = await ensureBluetoothPermissions();
      if (!granted) {
        toast('إذن البلوتوث مطلوب لاكتشاف الطابعات', 'error');
        return;
      }
      const enabled = await ThermalPrinterService.isBluetoothEnabled();
      if (!enabled) {
        const ok = await ThermalPrinterService.requestEnableBluetooth();
        if (!ok) {
          toast('فعّل البلوتوث أولاً للاستمرار', 'error');
          return;
        }
      }
      await refreshBonded();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleConnect = useCallback(
    async (device: PrinterDevice) => {
      setConnecting(device.address);
      try {
        await connect(device);
        toast(`تم الاتصال بـ ${device.name}`, 'success');
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), 'error');
      } finally {
        setConnecting(null);
      }
    },
    [connect, toast],
  );

  const handleScan = useCallback(async () => {
    const granted = await ensureBluetoothPermissions();
    if (!granted) {
      toast('امنح إذن البلوتوث أولاً', 'error');
      return;
    }
    const enabled = await ThermalPrinterService.isBluetoothEnabled();
    if (!enabled) {
      const ok = await ThermalPrinterService.requestEnableBluetooth();
      if (!ok) return;
    }
    await refreshBonded();
    await startScan();
  }, [refreshBonded, startScan, toast]);

  const testPrint = useCallback(async () => {
    if (status !== 'connected') {
      toast('اتصل بالطابعة أولاً', 'error');
      return;
    }
    setTesting(true);
    try {
      const job = buildTestJob({
        storeName: settings.storeName,
        storePhone: settings.storePhone,
        footerMessage: settings.footerMessage,
        storeLogoPath: settings.storeLogoPath,
        paperWidth: settings.paperWidth,
        codepage: settings.codepage,
        showProfit: false,
      });
      await ThermalPrinterService.printJob(job);
      toast('أُرسلت الطباعة التجريبية', 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setTesting(false);
    }
  }, [status, settings, toast]);

  // v40 (الجولة 48 #4): تحميل شكل الفاتورة كصورة — معاينة مطابقة
  //  لما ستطبعه الطابعة بإعدادات المتجر الحية (الاسم، الشعار، عرض
  //  الورق، التذييل، إظهار الربح) تُرسم بخط Tajawal وتُحفظ PNG في
  //  مجلد التنزيلات؛ بلا حاجة لطابعة متصلة أصلاً.
  const [savingPreview, setSavingPreview] = useState(false);
  const savePreviewImage = useCallback(async () => {
    if (savingPreview) {
      return;
    }
    setSavingPreview(true);
    try {
      const path = await exportReceiptPreviewImage({
        storeName: settings.storeName,
        storePhone: settings.storePhone,
        footerMessage: settings.footerMessage,
        storeLogoPath: settings.storeLogoPath,
        paperWidth: settings.paperWidth,
        codepage: settings.codepage,
        showProfit: settings.showProfitOnReceipt,
      });
      toast(`حُفظ شكل الفاتورة كصورة في: ${path}`, 'success', 6000);
    } catch (error) {
      toast(
        error instanceof Error ? error.message : String(error),
        'error',
      );
    } finally {
      setSavingPreview(false);
    }
  }, [savingPreview, settings, toast]);

  const connectedAddress = usePrinterStore(state => state.deviceAddress);

  const renderDevice = (
    device: PrinterDevice,
    section: 'bonded' | 'discovered',
  ) => {
    const isConnected =
      status === 'connected' && connectedAddress === device.address;
    const busy = connecting === device.address;
    return (
      <TouchableOpacity
        key={`${section}-${device.address}`}
        style={[styles.deviceRow, isConnected && styles.deviceRowActive]}
        onPress={() => (isConnected ? undefined : handleConnect(device))}
        disabled={busy || status === 'connecting'}>
        <View style={styles.deviceInfo}>
          <Text style={styles.deviceName} numberOfLines={1}>
            {device.name}
          </Text>
          <Text style={styles.deviceAddress}>{device.address}</Text>
        </View>
        {isConnected ? (
          <Badge label="متصل ✓" tone="success" />
        ) : busy ||
          (status === 'connecting' && connecting === device.address) ? (
          <Text style={styles.deviceConnecting}>جارٍ…</Text>
        ) : (
          <Text style={styles.deviceConnect}>اتصال</Text>
        )}
      </TouchableOpacity>
    );
  };

  return (
    <Screen>
      <AppHeader title="الطابعة الحرارية" subtitle="بلوتوث ESC/POS" showBack />
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={false}
            onRefresh={() => {
              void refreshBonded();
            }}
            tintColor={c.accent}
          />
        }>
        {/* ── Connection status ───────────────────────────────── */}
        <Card>
          <View style={styles.statusRow}>
            <View>
              <Text style={styles.statusLabel}>حالة الاتصال</Text>
              <Text style={styles.statusValue}>
                {status === 'connected'
                  ? deviceName ?? 'طابعة حرارية'
                  : status === 'connecting'
                  ? 'جارٍ الاتصال…'
                  : 'غير متصلة'}
              </Text>
            </View>
            <Badge
              label={
                status === 'connected'
                  ? 'متصل'
                  : status === 'connecting'
                  ? '…'
                  : 'منفصل'
              }
              tone={status === 'connected' ? 'success' : 'neutral'}
            />
          </View>
          <View style={styles.statusButtons}>
            <AppButton
              title="بحث عن الأجهزة"
              onPress={handleScan}
              loading={scanning}
              style={{flex: 1}}
            />
            {status === 'connected' ? (
              <AppButton
                title="قطع الاتصال"
                variant="danger"
                onPress={() => {
                  void disconnect();
                }}
                style={{flex: 1}}
              />
            ) : (
              <AppButton
                title="تحديث المقترنة"
                variant="ghost"
                onPress={() => {
                  void refreshBonded();
                }}
                style={{flex: 1}}
              />
            )}
          </View>
          {lastError ? <Text style={styles.errorText}>{lastError}</Text> : null}
        </Card>

        {/* ── Discovered devices ──────────────────────────────── */}
        {discovered.length > 0 ? (
          <Card>
            <Text style={styles.sectionTitle}>
              أجهزة قريبة ({discovered.length})
            </Text>
            {discovered.map(device => renderDevice(device, 'discovered'))}
          </Card>
        ) : null}

        {/* ── Bonded devices ──────────────────────────────────── */}
        <Card>
          <Text style={styles.sectionTitle}>الأجهزة المقترنة</Text>
          {bonded.length === 0 ? (
            <Text style={styles.emptyList}>
              لا توجد أجهزة مقترنة — اضغط "بحث عن الأجهزة" ثم اختر طابعتك
            </Text>
          ) : (
            bonded.map(device => renderDevice(device, 'bonded'))
          )}
        </Card>

        {/* ── Printer configuration ───────────────────────────── */}
        <Card>
          <Text style={styles.sectionTitle}>إعدادات الطباعة</Text>

          <Text style={styles.optionLabel}>عرض الورق</Text>
          <Segmented
            value={settings.paperWidth}
            onChange={value => updateSettings({paperWidth: value})}
            options={[
              {value: '58', label: '58 مم'},
              {value: '80', label: '80 مم'},
            ]}
          />

          <Text style={styles.optionLabel}>ترميز اللغة العربية</Text>
          <Segmented
            value={String(settings.codepage)}
            onChange={value => updateSettings({codepage: Number(value)})}
            options={[
              {value: String(CODEPAGE_CP1256), label: 'عربي CP1256'},
              {value: String(CODEPAGE_CP864), label: 'عربي CP864'},
              {value: String(CODEPAGE_ASCII), label: 'إنجليزي'},
            ]}
          />
          <Text style={styles.hint}>
            إذا ظهرت الحروف العربية مبعثرة في الفاتورة جرّب ترميزاً آخر — معظم
            الطابعات الصينية (Xprinter/Gprinter) تدعم CP1256
          </Text>

          {/* v40 (الجولة 48 #4): زر تحميل شكل الفاتورة كصورة بجانب
              الطباعة التجريبية — يشرح للتاجر شكل فاتورته المطبوعة
              قبل الطباعة، ويعمل حتى بلا طابعة متصلة. */}
          <View style={styles.previewButtonsRow}>
            <AppButton
              title="طباعة تجريبية"
              icon="printer"
              variant="ghost"
              onPress={testPrint}
              loading={testing}
              disabled={status !== 'connected'}
              style={{flex: 1}}
            />
            <AppButton
              title="تحميل شكل الفاتورة كصورة"
              icon="image"
              variant="ghost"
              onPress={() => void savePreviewImage()}
              loading={savingPreview}
              style={{flex: 1}}
            />
          </View>
          <Text style={styles.hint}>
            «تحميل شكل الفاتورة كصورة» يرسم فاتورة نموذجية بإعدادات
            متجرك الحقيقية (الشعار، عرض الورق، الرسالة الختامية) ويحفظها
            صورة في مجلد التنزيلات — هكذا ستبدو فاتورتك المطبوعة تماماً،
            وبلا حاجة لطابعة متصلة
          </Text>
        </Card>

        {/* ── Help ────────────────────────────────────────────── */}
        <Card>
          <Text style={styles.sectionTitle}>إرشادات الاقتران</Text>
          <Text style={styles.helpText}>
            1. شغّل الطابعة وتأكد أن ضوء البلوتوث يومض{'\n'}
            2. اضغط "بحث عن الأجهزة" وانتظر ظهورها{'\n'}
            3. اختر الطابعة واقبل طلب الاقتران (كود 0000 أو 1234 إن طُلب){'\n'}
            4. نفّذ "طباعة تجريبية" للتأكد من سلامة الترميز
          </Text>
        </Card>
      </ScrollView>
    </Screen>
  );
}

const useStyles = makeStyles(c =>
  StyleSheet.create({
    content: {padding: spacing.md, gap: spacing.md, paddingBottom: spacing.xxl},
    statusRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: spacing.md,
    },
    statusLabel: {
      color: c.textDim,
      fontSize: typography.small,
      marginBottom: 4,
    },
    statusValue: {color: c.text, fontWeight: '900', fontSize: typography.body},
    statusButtons: {flexDirection: 'row', gap: spacing.md},
    // v40 (الجولة 48 #4): الطباعة التجريبية بجانب تحميل شكل الفاتورة.
    previewButtonsRow: {
      flexDirection: 'row',
      gap: spacing.sm,
      marginTop: spacing.md,
    },
    errorText: {
      color: c.danger,
      fontSize: typography.small,
      marginTop: spacing.sm,
      textAlign: 'center',
    },
    sectionTitle: {
      color: c.text,
      fontWeight: '900',
      fontSize: typography.body,
      marginBottom: spacing.md,
    },
    deviceRow: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
      padding: spacing.md,
      marginBottom: spacing.sm,
    },
    deviceRowActive: {borderColor: c.success, backgroundColor: c.successSoft},
    deviceInfo: {flex: 1},
    deviceName: {
      color: c.text,
      fontWeight: '800',
      fontSize: typography.caption,
    },
    deviceAddress: {color: c.textDim, fontSize: typography.small, marginTop: 2},
    deviceConnect: {
      color: c.accent,
      fontWeight: '800',
      fontSize: typography.caption,
    },
    deviceConnecting: {
      color: c.warning,
      fontWeight: '800',
      fontSize: typography.caption,
    },
    emptyList: {color: c.textDim, fontSize: typography.small, lineHeight: 20},
    optionLabel: {
      color: c.textDim,
      fontSize: typography.caption,
      fontWeight: '700',
      marginTop: spacing.md,
      marginBottom: 6,
    },
    hint: {
      color: c.textFaint,
      fontSize: typography.small,
      lineHeight: 17,
      marginTop: spacing.sm,
      marginBottom: spacing.md,
    },
    helpText: {color: c.textDim, fontSize: typography.caption, lineHeight: 26},
  }),
);
