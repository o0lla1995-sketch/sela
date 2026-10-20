/**
 * ForceUpdateScreen — v62 (الجولة 66 #4): بوابة التحديث الإجباري.
 * ─────────────────────────────────────────────────────────────────
 * عندما تضبط الإدارة «أقل إصدار مدعوم» من لوحة التحكم ويرد الخادم
 * به في أول اتصال (تفعيل/نبضة/إعدادات) — وُجِد هذا الجهاز أقدم من
 * الحد — تُقفل الواجهة كلها على هذه الشاشة: لا بيع ولا تقارير حتى
 * يحدّث التاجر تطبيقه من جوجل بلاي (أو رابط التنزيل الموزّع).
 *
 * التصميم كشاشة التفعيل نفسها: بطاقات داكنة، أيقونة تحديث كبيرة،
 * رقمَا الإصدارين بوضوح، زر تحديث يفتح الرابط، وزر إعادة فحص
 * (يخدم حالتين: نشر التاجر النسخة ثم أخّر رفع الحد الأدنى — أو
 * حدّث الجهاز من بلاي والنسخة الجديدة لم تُقفل بعد عند الإدارة).
 */
import React, {useState} from 'react';
import {
  ActivityIndicator,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {Icon} from './Icon';
import {fonts, makeStyles, radius, spacing, useThemeColors} from '../core/theme';
import {APP_NAME} from '../core/config';
import {useToastStore} from '../stores/toastStore';
import type {UpdateRequirement} from '../services/license/LicenseService';

export function ForceUpdateScreen({
  requirement,
  onRecheck,
}: {
  requirement: UpdateRequirement;
  onRecheck: () => Promise<void>;
}) {
  const c = useThemeColors();
  const styles = useStyles();
  const toast = useToastStore(state => state.show);
  const [checking, setChecking] = useState(false);

  const openStore = async () => {
    const url = requirement.updateUrl;
    if (url == null) {
      toast('لا يوجد رابط تحديث على الإدارة — تواصل معها لتحديث التطبيق', 'error');
      return;
    }
    try {
      await Linking.openURL(url);
    } catch {
      toast('تعذر فتح رابط التحديث — تأكد من اتصال الإنترنت', 'error');
    }
  };

  const recheck = async () => {
    if (checking) {
      return;
    }
    setChecking(true);
    try {
      await onRecheck();
    } finally {
      setChecking(false);
    }
  };

  return (
    <View style={styles.root}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled">
        {/* Brand */}
        <View style={styles.brandRow}>
          <View style={styles.brandMark}>
            <Icon name="basket" size={30} color="#FFFFFF" />
          </View>
          <View style={styles.brandText}>
            <Text style={styles.brandName}>سيلا</Text>
            <Text style={styles.brandSub}>
              {APP_NAME} · نظام نقاط البيع الذكي
            </Text>
          </View>
        </View>

        {/* Headline */}
        <View style={styles.card}>
          <View style={[styles.cardIconWrap, {backgroundColor: c.warningSoft}]}>
            <Icon name="download" size={26} color={c.warning} />
          </View>
          <Text style={styles.title}>يتوفر تحديث إجباري</Text>
          <Text style={styles.body}>
            هذا الإصدار لم يعد مدعوماً. للحفاظ على بياناتك وسلامة
            المبيعات حدّث التطبيق الآن — بعد التحديث يعمل التطبيق مباشرة
            بكل بياناتك كما هي.
          </Text>

          <View style={styles.versionRow}>
            <View style={styles.versionChip}>
              <Text style={styles.versionChipLabel}>إصدارك الحالي</Text>
              <Text style={[styles.versionChipValue, {color: c.danger}]}>
                {requirement.currentVersion}
              </Text>
            </View>
            <View style={styles.versionChip}>
              <Text style={styles.versionChipLabel}>المطلوب على الأقل</Text>
              <Text style={[styles.versionChipValue, {color: c.success}]}>
                {requirement.minVersion ?? '—'}
              </Text>
            </View>
          </View>
        </View>

        {/* Actions */}
        <View style={styles.card}>
          <TouchableOpacity
            style={styles.primaryButton}
            onPress={() => void openStore()}
            activeOpacity={0.85}>
            <Icon name="download" size={18} color="#FFFFFF" />
            <Text style={styles.primaryButtonText}>تحديث التطبيق الآن</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.ghostButton}
            onPress={() => void recheck()}
            disabled={checking}
            activeOpacity={0.85}>
            {checking ? (
              <ActivityIndicator size="small" color={c.textDim} />
            ) : (
              <Icon name="refresh" size={16} color={c.textDim} />
            )}
            <Text style={styles.ghostButtonText}>
              {checking ? 'جارٍ إعادة الفحص…' : 'حدّثتُ التطبيق — أعد الفحص'}
            </Text>
          </TouchableOpacity>
          <Text style={styles.hint}>
            التحديث من جوجل بلاي يحتفظ بكل بياناتك — المنتجات والفواتير
            والديون تبقى كما هي تماماً. لا تحذف التطبيق أبداً.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

const useStyles = makeStyles(c =>
  StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: c.bg,
    },
    scroll: {
      flexGrow: 1,
      padding: spacing.lg,
      paddingBottom: 40,
    },
    brandRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 14,
      alignSelf: 'center',
      marginTop: 18,
      marginBottom: 22,
    },
    brandMark: {
      width: 58,
      height: 58,
      borderRadius: 18,
      backgroundColor: c.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    brandText: {
      gap: 2,
    },
    brandName: {
      fontFamily: fonts.bold,
      fontSize: 30,
      color: c.text,
    },
    brandSub: {
      fontFamily: fonts.regular,
      fontSize: 12.5,
      color: c.textDim,
    },
    card: {
      backgroundColor: c.surface,
      borderRadius: radius.lg,
      padding: spacing.lg,
      gap: 12,
      marginBottom: spacing.md,
      borderWidth: 1,
      borderColor: c.border,
      alignItems: 'center',
    },
    cardIconWrap: {
      width: 52,
      height: 52,
      borderRadius: 16,
      alignItems: 'center',
      justifyContent: 'center',
    },
    title: {
      fontFamily: fonts.bold,
      fontSize: 20,
      color: c.text,
    },
    body: {
      fontFamily: fonts.regular,
      fontSize: 13.5,
      lineHeight: 22,
      color: c.textDim,
      textAlign: 'center',
    },
    versionRow: {
      flexDirection: 'row-reverse',
      gap: 10,
      alignSelf: 'stretch',
    },
    versionChip: {
      flex: 1,
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.md,
      padding: 10,
      gap: 2,
      alignItems: 'center',
    },
    versionChipLabel: {
      fontFamily: fonts.regular,
      fontSize: 11,
      color: c.textDim,
    },
    versionChipValue: {
      fontFamily: fonts.bold,
      fontSize: 15,
      color: c.text,
    },
    primaryButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 9,
      backgroundColor: c.accent,
      borderRadius: radius.md,
      paddingVertical: 14,
      alignSelf: 'stretch',
    },
    primaryButtonText: {
      fontFamily: fonts.bold,
      fontSize: 15,
      color: '#FFFFFF',
    },
    ghostButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      paddingVertical: 10,
      alignSelf: 'stretch',
    },
    ghostButtonText: {
      fontFamily: fonts.regular,
      fontSize: 13,
      color: c.textDim,
    },
    hint: {
      fontFamily: fonts.regular,
      fontSize: 11,
      lineHeight: 17,
      color: c.textDim,
      textAlign: 'center',
    },
  }),
);
