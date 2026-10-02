/**
 * SettingsScreen — إعدادات المحل والتعرف البصري والفواتير + أدوات
 * البيانات + مدخل التشخيص.
 */
import React from 'react';
import {View, Text, StyleSheet, ScrollView, Switch, Alert} from 'react-native';
import {
  AppButton,
  Card,
  Field,
  Screen,
  ScreenHeader,
  Segmented,
} from '../../components/ui';
import {useSettingsStore} from '../../stores/settingsStore';
import {useNavigation} from '../../core/navigation';
import {ExportService} from '../../services/ExportService';
import {wipeAllData} from '../../database/connection';
import {useToastStore} from '../../stores/toastStore';
import {useCatalogStore} from '../../stores/catalogStore';
import {colors, radius, spacing, typography} from '../../core/theme';
import {APP_NAME} from '../../core/config';
import type {PricingMode} from '../../core/types';

export function SettingsScreen() {
  const push = useNavigation(state => state.push);
  const settings = useSettingsStore(state => state.settings);
  const update = useSettingsStore(state => state.update);
  const toast = useToastStore(state => state.show);
  const refreshCatalog = useCatalogStore(state => state.refresh);

  const wipe = () => {
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
  };

  return (
    <Screen>
      <ScreenHeader title="الإعدادات" subtitle="تخصيص النظام" showBack />
      <ScrollView contentContainerStyle={styles.content}>
        {/* ── Store info ───────────────────────────────────────── */}
        <Card>
          <Text style={styles.sectionTitle}>معلومات المحل (تظهر في الفاتورة)</Text>
          <Field
            label="اسم المحل"
            value={settings.storeName}
            onChangeText={text => update({storeName: text})}
            placeholder="متجر Smart Vision"
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
          />
        </Card>

        {/* ── Pricing ──────────────────────────────────────────── */}
        <Card>
          <Text style={styles.sectionTitle}>التسعير الافتراضي</Text>
          <Segmented
            value={settings.defaultPricingMode}
            onChange={value => update({defaultPricingMode: value})}
            options={[
              {value: 'RETAIL' as PricingMode, label: 'مفرق'},
              {value: 'WHOLESALE' as PricingMode, label: 'جملة'},
            ]}
          />
        </Card>

        {/* ── Vision ───────────────────────────────────────────── */}
        <Card>
          <Text style={styles.sectionTitle}>التعرف البصري</Text>

          <View style={styles.switchRow}>
            <View style={{flex: 1}}>
              <Text style={styles.switchLabel}>التعرف التلقائي أثناء البيع</Text>
              <Text style={styles.switchHint}>
                إيقافه يجعل الكاميرا تعمل فقط عند الضغط على "مسح فوري"
              </Text>
            </View>
            <Switch
              value={settings.recognitionEnabled}
              onValueChange={value => update({recognitionEnabled: value})}
              trackColor={{true: colors.accent, false: colors.surfaceAlt}}
              thumbColor={settings.recognitionEnabled ? '#FFFFFF' : colors.textDim}
            />
          </View>

          <Text style={styles.optionLabel}>
            عتبة التطابق: {(settings.matchThreshold * 100).toFixed(0)}%
          </Text>
          <View style={styles.thresholdButtons}>
            {[0.75, 0.82, 0.88, 0.92].map(value => (
              <AppButton
                key={value}
                title={`${(value * 100).toFixed(0)}%`}
                small
                variant={Math.abs(settings.matchThreshold - value) < 0.001 ? 'primary' : 'ghost'}
                onPress={() => update({matchThreshold: value})}
                style={{flex: 1}}
              />
            ))}
          </View>
          <Text style={styles.switchHint}>
            عتبة أدنى = قبول أسرع مع أخطاء محتملة، عتبة أعلى = دقة أكبر
          </Text>

          <Text style={styles.optionLabel}>
            فاصل إعادة الإضافة: {(settings.recognitionCooldownMs / 1000).toFixed(1)} ثانية
          </Text>
          <View style={styles.thresholdButtons}>
            {[800, 1500, 2500, 4000].map(value => (
              <AppButton
                key={value}
                title={`${(value / 1000).toFixed(1)} ث`}
                small
                variant={settings.recognitionCooldownMs === value ? 'primary' : 'ghost'}
                onPress={() => update({recognitionCooldownMs: value})}
                style={{flex: 1}}
              />
            ))}
          </View>

          <View style={styles.switchRow}>
            <View style={{flex: 1}}>
              <Text style={styles.switchLabel}>النغمة الصوتية عند التعرف</Text>
              <Text style={styles.switchHint}>صوت تنبيه سريع عند إضافة منتج للسلة</Text>
            </View>
            <Switch
              value={settings.soundEnabled}
              onValueChange={value => update({soundEnabled: value})}
              trackColor={{true: colors.accent, false: colors.surfaceAlt}}
              thumbColor={settings.soundEnabled ? '#FFFFFF' : colors.textDim}
            />
          </View>
        </Card>

        {/* ── Receipt ──────────────────────────────────────────── */}
        <Card>
          <Text style={styles.sectionTitle}>الفاتورة</Text>
          <View style={styles.switchRow}>
            <View style={{flex: 1}}>
              <Text style={styles.switchLabel}>طباعة صافي الربح في الفاتورة</Text>
              <Text style={styles.switchHint}>
                للمسؤول فقط — لا يُنصح بتفعيله إذا تسلّم الفاتورة الزبون
              </Text>
            </View>
            <Switch
              value={settings.showProfitOnReceipt}
              onValueChange={value => update({showProfitOnReceipt: value})}
              trackColor={{true: colors.accent, false: colors.surfaceAlt}}
              thumbColor={settings.showProfitOnReceipt ? '#FFFFFF' : colors.textDim}
            />
          </View>
          <AppButton
            title="⚙️ إعدادات الطابعة والبلوتوث"
            variant="ghost"
            onPress={() => push('printer')}
          />
        </Card>

        {/* ── Data ─────────────────────────────────────────────── */}
        <Card>
          <Text style={styles.sectionTitle}>البيانات</Text>
          <AppButton
            title="تصدير جرد المخزون CSV"
            variant="ghost"
            onPress={async () => {
              try {
                const path = await ExportService.exportInventory('csv');
                toast(`تم الحفظ: ${path}`, 'success', 4000);
              } catch (error) {
                toast(
                  error instanceof Error ? error.message : String(error),
                  'error',
                );
              }
            }}
          />
          <AppButton title="🧪 التشخيص وسجل النظام" variant="ghost" onPress={() => push('diagnostics')} />
          <AppButton title="🗑️ حذف جميع البيانات" variant="danger" onPress={wipe} />
        </Card>

        <Text style={styles.aboutText}>
          {APP_NAME} — نظام نقاط بيع محلي يعمل بدون إنترنت نهائياً. المعالجة
          البصرية والمحاسبة والطباعة تتم 100% على جهازك.
        </Text>
        <Text style={styles.versionText}>الإصدار 1.0.0</Text>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {padding: spacing.md, gap: spacing.md, paddingBottom: spacing.xxl},
  sectionTitle: {
    color: colors.text,
    fontWeight: '900',
    fontSize: typography.body,
    marginBottom: spacing.md,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  switchLabel: {color: colors.text, fontWeight: '700', fontSize: typography.caption},
  switchHint: {color: colors.textFaint, fontSize: typography.small, lineHeight: 17, marginTop: 2},
  optionLabel: {
    color: colors.textDim,
    fontSize: typography.caption,
    fontWeight: '700',
    marginTop: spacing.md,
    marginBottom: 6,
  },
  thresholdButtons: {flexDirection: 'row', gap: spacing.sm},
  aboutText: {
    color: colors.textDim,
    fontSize: typography.small,
    textAlign: 'center',
    lineHeight: 19,
    marginTop: spacing.md,
  },
  versionText: {
    color: colors.textFaint,
    fontSize: typography.small,
    textAlign: 'center',
  },
});
