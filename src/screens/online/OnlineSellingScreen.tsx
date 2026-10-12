/**
 * OnlineSellingScreen — إعدادات البيع أونلاين (الجولة 56).
 * ─────────────────────────────────────────────────────────────────
 * بوابة التاجر إلى متجر سيلا ماركت: تفعيل/تعطيل النشر، ملف المتجر
 * (الاسم، الوصف، التصنيف، المنطقة، الهاتف، واتساب)، مناطق التوصيل
 * بأسعارها (تُضاف لفاتورة المستخدم حسب منطقته)، وحالة المزامنة
 * (آخر مزامنة منتجات / استطلاع طلبات + زر «مزامنة الآن»).
 *
 * التفعيل يتطلب اشتراكاً فعّالاً (الخادم يرفض غير الفعّال ويخفي
 * المنتجات فور انتهاء الاشتراك — حماية مدمجة لا تُكسر).
 */
import React, {useCallback, useEffect, useState} from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {AppHeader, Card, SectionTitle, SwitchRow} from '../../components/ui';
import {Icon} from '../../components/Icon';
import {
  loadOnlineSettings,
  saveOnlineSettings,
  registerStore,
  syncProducts,
  ensureEngineStarted,
  stopEngine,
  getImageSyncProgress,
} from '../../services/online/OnlineStoreService';
import {onlineErrorText} from '../../services/online/OnlineStoreService';
import {relativeTime} from '../../core/format';
import {fonts, makeStyles, spacing, useThemeColors} from '../../core/theme';
import {useToastStore} from '../../stores/toastStore';
import type {OnlineDeliveryRegion} from '../../core/types';

export function OnlineSellingScreen() {
  const c = useThemeColors();
  const styles = useStyles();
  const toast = useToastStore(state => state.show);

  const [settings, setSettings] = useState(() => loadOnlineSettings());
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const patch = useCallback((part: Partial<typeof settings>) => {
    setSettings(prev => ({...prev, ...part}));
  }, []);

  const validate = useCallback((): string | null => {
    if (settings.enabled) {
      if (settings.storeName.trim().length < 2) {
        return 'اسم المتجر مطلوب (حرفان على الأقل)';
      }
      if (settings.phone.trim().length < 7) {
        return 'رقم هاتف المتجر مطلوب — يتواصل به المستخدمون';
      }
      if (settings.deliveryRegions.length === 0) {
        return 'أضف منطقة توصيل واحدة على الأقل بسعرها — يختارها المستخدم عند الطلب';
      }
    }
    return null;
  }, [settings]);

  const save = useCallback(
    async (next: typeof settings) => {
      const problem = validate();
      if (problem != null && next.enabled) {
        toast(problem, 'error');
        return;
      }
      setBusy(true);
      try {
        saveOnlineSettings(next);
        await registerStore(next);
        if (next.enabled) {
          ensureEngineStarted();
        } else {
          stopEngine();
        }
        setSettings(loadOnlineSettings());
        toast(
          next.enabled
            ? `متجرك ${next.storeName} يعمل على سيلا ماركت — المنتجات تُنشر الآن`
            : 'تم إخفاء منتجات متجرك من المتجر — بياناتك محفوظة',
          'success',
        );
      } catch (error) {
        // فشل التسجيل: احتفظ بالإعدادات محلياً لكن لا تشغل المحرك
        // إلا عند نجاح التسجيل.
        saveOnlineSettings({...next, enabled: false});
        stopEngine();
        setSettings(loadOnlineSettings());
        toast(onlineErrorText(error), 'error');
      } finally {
        setBusy(false);
      }
    },
    [stopEngine, toast, validate],
  );

  const toggleEnabled = useCallback(
    (value: boolean) => {
      const next = {...settings, enabled: value};
      if (value) {
        const problem = validate();
        if (problem != null) {
          toast(problem, 'error');
          return;
        }
      }
      void save(next);
    },
    [save, settings, toast, validate],
  );

  const syncNow = useCallback(async () => {
    setSyncing(true);
    try {
      const saved = await syncProducts();
      setSettings(loadOnlineSettings());
      toast(`تمت مزامنة ${saved} منتجاً مع المتجر`, 'success');
    } catch (error) {
      toast(onlineErrorText(error), 'error');
    } finally {
      setSyncing(false);
    }
  }, [toast]);

  useEffect(() => {
    ensureEngineStarted();
  }, []);

  // v49: تقدم مزامنة صور المتجر (استطلاع كل ثانيتين أثناء التشغيل)
  const [imageSync, setImageSync] = useState(getImageSyncProgress);
  useEffect(() => {
    const timer = setInterval(() => {
      setImageSync(getImageSyncProgress());
    }, 2000);
    return () => clearInterval(timer);
  }, []);

  const addRegion = useCallback(() => {
    patch({deliveryRegions: [...settings.deliveryRegions, {name: '', feeMinor: 0}]});
  }, [patch, settings.deliveryRegions]);

  const setRegion = useCallback(
    (index: number, part: Partial<OnlineDeliveryRegion>) => {
      const regions = settings.deliveryRegions.map((r, i) =>
        i === index ? {...r, ...part} : r,
      );
      patch({deliveryRegions: regions});
    },
    [patch, settings.deliveryRegions],
  );

  const removeRegion = useCallback(
    (index: number) => {
      Alert.alert(
        'حذف المنطقة',
        'لن تظهر هذه المنطقة للمستخدمين في الطلبات الجديدة.',
        [
          {text: 'إلغاء', style: 'cancel'},
          {
            text: 'حذف',
            style: 'destructive',
            onPress: () =>
              patch({
                deliveryRegions: settings.deliveryRegions.filter(
                  (_, i) => i !== index,
                ),
              }),
          },
        ],
      );
    },
    [patch, settings.deliveryRegions],
  );

  return (
    <View style={styles.root}>
      <AppHeader
        title="البيع أونلاين"
        subtitle="متجر سيلا ماركت لمستخدمي تطبيق المتجر"
      />
      <ScrollView contentContainerStyle={styles.content}>
        {/* التفعيل */}
        <Card>
          <SectionTitle
            title="نشر منتجات متجرك أونلاين"
            hint="عند التفعيل تتزامن منتجاتك دورياً ويصلك إشعار عند كل طلب"
          />
          <SwitchRow
            label="تفعيل البيع أونلاين"
            hint={
              settings.enabled
                ? 'متجرك منشور — المنتجات والطلبات تعمل'
                : 'متجرك مخفي — لن تظهر منتجاتك للمستخدمين'
            }
            value={settings.enabled}
            onValueChange={toggleEnabled}
            icon="store"
          />
          {settings.storeNumber != null ? (
            <Text style={styles.storeNumber}>
              رقم متجرك في سيلا ماركت:{' '}
              <Text style={styles.storeNumberValue}>{settings.storeNumber}</Text>
            </Text>
          ) : null}
          {busy ? (
            <View style={styles.busyRow}>
              <ActivityIndicator size="small" color={c.accent} />
              <Text style={styles.dim}>جارٍ تسجيل المتجر على الخادم…</Text>
            </View>
          ) : null}
        </Card>

        {/* ملف المتجر */}
        <Card>
          <SectionTitle title="ملف المتجر" hint="يظهر للمستخدمين في المتجر" />
          <Text style={styles.fieldLabel}>اسم المتجر</Text>
          <TextInput
            style={styles.input}
            value={settings.storeName}
            onChangeText={v => patch({storeName: v})}
            placeholder="مثال: سوبر ماركت النور"
            placeholderTextColor={c.textDim}
          />
          <Text style={styles.fieldLabel}>وصف مختصر</Text>
          <TextInput
            style={[styles.input, styles.multiline]}
            value={settings.description}
            onChangeText={v => patch({description: v})}
            placeholder="ما يميز متجرك (اختياري)"
            placeholderTextColor={c.textDim}
            multiline
          />
          <View style={styles.row2}>
            <View style={{flex: 1}}>
              <Text style={styles.fieldLabel}>التصنيف</Text>
              <TextInput
                style={styles.input}
                value={settings.category}
                onChangeText={v => patch({category: v})}
                placeholder="بقالة / ملابس / صيدلية…"
                placeholderTextColor={c.textDim}
              />
            </View>
            <View style={{flex: 1}}>
              <Text style={styles.fieldLabel}>المنطقة (المدينة)</Text>
              <TextInput
                style={styles.input}
                value={settings.region}
                onChangeText={v => patch({region: v})}
                placeholder="رام الله…"
                placeholderTextColor={c.textDim}
              />
            </View>
          </View>
          <View style={styles.row2}>
            <View style={{flex: 1}}>
              <Text style={styles.fieldLabel}>هاتف المتجر</Text>
              <TextInput
                style={styles.input}
                value={settings.phone}
                onChangeText={v => patch({phone: v})}
                placeholder="0591234567"
                placeholderTextColor={c.textDim}
                keyboardType="phone-pad"
              />
            </View>
            <View style={{flex: 1}}>
              <Text style={styles.fieldLabel}>واتساب</Text>
              <TextInput
                style={styles.input}
                value={settings.whatsapp}
                onChangeText={v => patch({whatsapp: v})}
                placeholder="0591234567"
                placeholderTextColor={c.textDim}
                keyboardType="phone-pad"
              />
            </View>
          </View>
        </Card>

        {/* مناطق التوصيل */}
        <Card>
          <SectionTitle
            title="مناطق التوصيل وأسعارها"
            hint="سعر التوصيل يُضاف لفاتورة المستخدم حسب منطقته"
          />
          {settings.deliveryRegions.map((region, index) => (
            <View key={index} style={styles.regionRow}>
              <TextInput
                style={[styles.input, {flex: 1}]}
                value={region.name}
                onChangeText={v => setRegion(index, {name: v})}
                placeholder="اسم المنطقة"
                placeholderTextColor={c.textDim}
              />
              <View style={styles.feeWrap}>
                <TextInput
                  style={[styles.input, styles.feeInput]}
                  value={String(region.feeMinor / 100)}
                  onChangeText={v => {
                    const num = Number(v.replace(/[^\d.]/g, '')) || 0;
                    setRegion(index, {
                      feeMinor: Math.min(
                        100000000,
                        Math.round(num * 100),
                      ),
                    });
                  }}
                  placeholder="0.00"
                  placeholderTextColor={c.textDim}
                  keyboardType="decimal-pad"
                />
                <Text style={styles.feeSuffix}>₪</Text>
              </View>
              <TouchableOpacity
                style={styles.removeBtn}
                onPress={() => removeRegion(index)}>
                <Icon name="trash" size={15} color={c.danger} />
              </TouchableOpacity>
            </View>
          ))}
          <TouchableOpacity style={styles.addRegionBtn} onPress={addRegion}>
            <Icon name="plus" size={15} color={c.accent} />
            <Text style={styles.addRegionText}>إضافة منطقة توصيل</Text>
          </TouchableOpacity>
        </Card>

        {/* المزامنة */}
        <Card>
          <SectionTitle
            title="المزامنة"
            hint="تلقائية أثناء عمل التطبيق — وهذا زر فوري"
          />
          <View style={styles.syncInfoRow}>
            <Icon name="refresh" size={13} color={c.textDim} />
            <Text style={styles.dim}>
              آخر مزامنة منتجات:{' '}
              {settings.lastProductsSyncAt != null
                ? relativeTime(new Date(settings.lastProductsSyncAt).toISOString())
                : 'لم تتم بعد'}
            </Text>
          </View>
          <View style={styles.syncInfoRow}>
            <Icon name="bell" size={13} color={c.textDim} />
            <Text style={styles.dim}>
              آخر استطلاع طلبات:{' '}
              {settings.lastPollAt != null
                ? relativeTime(new Date(settings.lastPollAt).toISOString())
                : 'لم يتم بعد'}
            </Text>
          </View>
          {imageSync.running ? (
            <View style={styles.syncInfoRow}>
              <ActivityIndicator size="small" color={c.accent} />
              <Text style={styles.dim}>
                رفع صور المنتجات: {imageSync.done}/{imageSync.total} ·
                {' ' + imageSync.uploaded} صورة مرفوعة
              </Text>
            </View>
          ) : (
            <View style={styles.syncInfoRow}>
              <Icon name="image" size={13} color={c.textDim} />
              <Text style={styles.dim}>
                صور المنتجات:{' '}
                {imageSync.lastRunAt != null
                  ? `آخر رفع ${relativeTime(new Date(imageSync.lastRunAt).toISOString())}` +
                    (imageSync.lastError != null ? ' — آخر خطأ محفوظ في التشخيص' : '')
                  : 'تُرفع تلقائياً بعد مزامنة المنتجات'}
              </Text>
            </View>
          )}
          <TouchableOpacity
            style={[styles.saveBtn, {backgroundColor: c.accent}]}
            onPress={() => void syncNow()}
            disabled={syncing || !settings.enabled}>
            {syncing ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <Text style={styles.saveBtnText}>مزامنة المنتجات الآن</Text>
            )}
          </TouchableOpacity>
        </Card>

        {/* حفظ الملف */}
        <TouchableOpacity
          style={[styles.saveBtn, {backgroundColor: c.success}]}
          onPress={() => void save({...settings})}
          disabled={busy}>
          <Text style={styles.saveBtnText}>حفظ ملف المتجر</Text>
        </TouchableOpacity>

        <Text style={styles.footerHint}>
          دورة الطلب: قبول ← تجهيز وإرسال (فاتورة + خصم مخزون + مبيعات
          اليوم + دين مؤقت) ← تأكيد التسليم (الدين إلى الخزينة بسند
          تحصيل). الإرجاع والاستبدال من مركز الفواتير كأي بيع عادي.
        </Text>
      </ScrollView>
    </View>
  );
}

const useStyles = makeStyles(c =>
  StyleSheet.create({
    root: {flex: 1, backgroundColor: c.bg},
    content: {
      padding: spacing.lg,
      gap: spacing.md,
      paddingBottom: 48,
    },
    storeNumber: {
      fontFamily: fonts.regular,
      fontSize: 12.5,
      color: c.textDim,
      marginTop: 4,
    },
    storeNumberValue: {
      fontFamily: fonts.bold,
      color: c.accent,
      fontSize: 13,
    },
    busyRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginTop: 8,
    },
    fieldLabel: {
      fontFamily: fonts.bold,
      fontSize: 12.5,
      color: c.textDim,
      marginBottom: 5,
      marginTop: 4,
    },
    input: {
      backgroundColor: c.surfaceAlt,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.border,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontFamily: fonts.regular,
      fontSize: 13.5,
      color: c.text,
    },
    multiline: {minHeight: 72, textAlignVertical: 'top'},
    row2: {flexDirection: 'row', gap: 10},
    regionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginBottom: 8,
    },
    feeWrap: {flexDirection: 'row', alignItems: 'center'},
    feeInput: {width: 92, textAlign: 'center'},
    feeSuffix: {
      fontFamily: fonts.bold,
      fontSize: 13,
      color: c.textDim,
      marginStart: 6,
    },
    removeBtn: {
      width: 38,
      height: 38,
      borderRadius: 12,
      backgroundColor: c.surfaceAlt,
      borderWidth: 1,
      borderColor: c.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    addRegionBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      borderWidth: 1,
      borderColor: c.accent,
      borderRadius: 12,
      paddingVertical: 10,
      borderStyle: 'dashed',
    },
    addRegionText: {
      fontFamily: fonts.bold,
      fontSize: 13,
      color: c.accent,
    },
    syncInfoRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingVertical: 3,
    },
    dim: {fontFamily: fonts.regular, fontSize: 12.5, color: c.textDim},
    saveBtn: {
      borderRadius: 14,
      paddingVertical: 14,
      alignItems: 'center',
      justifyContent: 'center',
    },
    saveBtnText: {
      fontFamily: fonts.black,
      fontSize: 14,
      color: '#FFFFFF',
    },
    footerHint: {
      fontFamily: fonts.regular,
      fontSize: 11.5,
      color: c.textFaint,
      lineHeight: 18,
      textAlign: 'center',
    },
  }),
);
