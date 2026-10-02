/**
 * DiagnosticsScreen — فحص ذاتي شامل للنظام: النموذج، الكاميرا،
 * قاعدة البيانات، البصمات، الطابعة، وسجل الأحداث الأخير.
 */
import React, {useEffect, useState} from 'react';
import {View, Text, StyleSheet, ScrollView} from 'react-native';
import {Badge, Card, Screen, ScreenHeader, AppButton} from '../../components/ui';
import {VisionRecognitionService} from '../../services/vision/VisionRecognitionService';
import {ProductRepo} from '../../database/repositories/ProductRepo';
import {CategoryRepo} from '../../database/repositories/CategoryRepo';
import {EmbeddingRepo} from '../../database/repositories/EmbeddingRepo';
import {SaleRepo} from '../../database/repositories/SaleRepo';
import {usePrinterStore} from '../../stores/printerStore';
import {getDiagnostics, clearDiagnostics} from '../../core/diagnostics';
import {colors, radius, spacing, typography} from '../../core/theme';
import {MODEL_INPUT_SIZE} from '../../core/config';

interface Counts {
  products: number;
  categories: number;
  embeddings: number;
  sales: number;
}

export function DiagnosticsScreen() {
  const [counts, setCounts] = useState<Counts | null>(null);
  const [logVersion, setLogVersion] = useState(0);
  const printerStatus = usePrinterStore(state => state.status);
  const printerName = usePrinterStore(state => state.deviceName);

  const modelInfo = VisionRecognitionService.getInfo();

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        const [products, categories, embeddings, sales] = await Promise.all([
          ProductRepo.countAll(),
          CategoryRepo.list(),
          EmbeddingRepo.countAll(),
          SaleRepo.countAll(),
        ]);
        if (mounted) {
          setCounts({
            products,
            categories: categories.length,
            embeddings,
            sales,
          });
        }
      } catch {
        if (mounted) setCounts(null);
      }
    };
    void load();
    return () => {
      mounted = false;
    };
  }, []);

  const entries = getDiagnostics();

  return (
    <Screen>
      <ScreenHeader title="التشخيص وسجل النظام" subtitle="فحص ذاتي شامل" showBack />
      <ScrollView contentContainerStyle={styles.content}>
        {/* ── Vision model ─────────────────────────────────────── */}
        <Card>
          <View style={styles.cardHeaderRow}>
            <Text style={styles.sectionTitle}>نموذج التعرف البصري</Text>
            <Badge
              label={modelInfo.loaded ? 'يعمل' : 'غير متاح'}
              tone={modelInfo.loaded ? 'success' : 'danger'}
            />
          </View>
          <DiagRow label="الحالة" value={modelInfo.loaded ? 'محمّل وجاهز' : modelInfo.loadError ?? 'غير محمّل'} />
          <DiagRow
            label="مقاس الإدخال"
            value={modelInfo.loaded ? `${modelInfo.inputSize}×${modelInfo.inputSize}×3` : `${MODEL_INPUT_SIZE} (افتراضي)`}
          />
          <DiagRow
            label="ترتيب القنوات"
            value={modelInfo.channelsLast ? 'NHWC (قياسي)' : 'NCHW'}
          />
          <DiagRow
            label="بُعد متجه الخصائص"
            value={modelInfo.embeddingDim > 0 ? String(modelInfo.embeddingDim) : 'غير معروف'}
          />
          <DiagRow label="طبقة الإدخال" value={modelInfo.inputName || '-'} />
          <DiagRow label="طبقة الإخراج" value={modelInfo.outputName || '-'} />
          <DiagRow label="النموذج" value="MobileNetV3-Small float32 (محلي 100%)" />
        </Card>

        {/* ── Database ─────────────────────────────────────────── */}
        <Card>
          <View style={styles.cardHeaderRow}>
            <Text style={styles.sectionTitle}>قاعدة البيانات المحلية</Text>
            <Badge label={counts ? 'SQLite ✓' : 'تحقق…'} tone={counts ? 'success' : 'neutral'} />
          </View>
          <DiagRow label="المنتجات" value={String(counts?.products ?? '…')} />
          <DiagRow label="الفئات" value={String(counts?.categories ?? '…')} />
          <DiagRow label="البصمات البصرية" value={String(counts?.embeddings ?? '…')} />
          <DiagRow label="الفواتير المحفوظة" value={String(counts?.sales ?? '…')} />
        </Card>

        {/* ── Printer ──────────────────────────────────────────── */}
        <Card>
          <View style={styles.cardHeaderRow}>
            <Text style={styles.sectionTitle}>الطابعة الحرارية</Text>
            <Badge
              label={
                printerStatus === 'connected'
                  ? 'متصل'
                  : printerStatus === 'connecting'
                  ? 'جارٍ'
                  : 'منفصل'
              }
              tone={printerStatus === 'connected' ? 'success' : 'neutral'}
            />
          </View>
          <DiagRow
            label="الجهاز"
            value={printerName ?? 'لا يوجد'}
          />
          <DiagRow label="البروتوكول" value="Bluetooth SPP + ESC/POS" />
        </Card>

        {/* ── Recent events ────────────────────────────────────── */}
        <Card>
          <View style={styles.cardHeaderRow}>
            <Text style={styles.sectionTitle}>سجل الأحداث ({entries.length})</Text>
            <AppButton
              title="مسح السجل"
              variant="ghost"
              small
              onPress={() => {
                clearDiagnostics();
                setLogVersion(v => v + 1);
              }}
            />
          </View>
          {entries.length === 0 ? (
            <Text style={styles.emptyLog}>لا توجد أحداث مسجلة</Text>
          ) : (
            entries.map((entry, index) => (
              <View
                key={`${entry.at}-${index}-${logVersion}`}
                style={styles.logRow}>
                <Text
                  style={[
                    styles.logLevel,
                    entry.level === 'error' && styles.logError,
                    entry.level === 'warn' && styles.logWarn,
                  ]}>
                  {entry.level === 'error' ? '✖' : entry.level === 'warn' ? '⚠' : 'ℹ'}
                </Text>
                <View style={{flex: 1}}>
                  <Text style={styles.logTag}>[{entry.tag}] {entry.at}</Text>
                  <Text style={styles.logMessage}>{entry.message}</Text>
                </View>
              </View>
            ))
          )}
        </Card>
      </ScrollView>
    </Screen>
  );
}

function DiagRow({label, value}: {label: string; value: string}) {
  return (
    <View style={styles.diagRow}>
      <Text style={styles.diagLabel}>{label}</Text>
      <Text style={styles.diagValue} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {padding: spacing.md, gap: spacing.md, paddingBottom: spacing.xxl},
  cardHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  sectionTitle: {
    color: colors.text,
    fontWeight: '900',
    fontSize: typography.body,
  },
  diagRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.md,
  },
  diagLabel: {color: colors.textDim, fontSize: typography.small, flexShrink: 0},
  diagValue: {
    color: colors.text,
    fontSize: typography.small,
    fontWeight: '700',
    textAlign: 'left',
    flex: 1,
  },
  logRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  logLevel: {fontSize: 14, color: colors.info},
  logError: {color: colors.danger},
  logWarn: {color: colors.warning},
  logTag: {color: colors.textFaint, fontSize: 10, marginBottom: 2},
  logMessage: {color: colors.textDim, fontSize: typography.small, lineHeight: 17},
  emptyLog: {color: colors.textDim, fontSize: typography.small, textAlign: 'center', paddingVertical: spacing.md},
});
