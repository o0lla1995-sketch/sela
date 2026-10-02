/**
 * HomeScreen — dashboard with quick stats and navigation tiles.
 */
import React, {useEffect, useState} from 'react';
import {View, Text, StyleSheet, ScrollView, TouchableOpacity} from 'react-native';
import {
  Card,
  Screen,
  StatCard,
  Badge,
} from '../components/ui';
import {useNavigation} from '../core/navigation';
import {useCatalogStore} from '../stores/catalogStore';
import {useSettingsStore} from '../stores/settingsStore';
import {ReportRepo} from '../database/repositories/ReportRepo';
import {colors, radius, spacing, typography} from '../core/theme';
import {localToday} from '../core/format';
import {APP_NAME} from '../core/config';
import {usePrinterStore} from '../stores/printerStore';

interface Tile {
  key: string;
  title: string;
  subtitle: string;
  emoji: string;
  screen: 'pos' | 'inventory' | 'reports' | 'printer' | 'settings';
  tone: string;
}

const TILES: Tile[] = [
  {
    key: 'pos',
    title: 'نقطة البيع',
    subtitle: 'بيع بالتعرف البصري',
    emoji: '🛒',
    screen: 'pos',
    tone: colors.accent,
  },
  {
    key: 'inventory',
    title: 'المخزون',
    subtitle: 'المنتجات والفئات',
    emoji: '📦',
    screen: 'inventory',
    tone: colors.info,
  },
  {
    key: 'reports',
    title: 'التقارير',
    subtitle: 'المبيعات والأرباح',
    emoji: '📊',
    screen: 'reports',
    tone: colors.success,
  },
  {
    key: 'printer',
    title: 'الطابعة',
    subtitle: 'بلوتوث وفواتير',
    emoji: '🖨️',
    screen: 'printer',
    tone: colors.warning,
  },
  {
    key: 'settings',
    title: 'الإعدادات',
    subtitle: 'تخصيص النظام',
    emoji: '⚙️',
    screen: 'settings',
    tone: colors.textDim,
  },
];

export function HomeScreen() {
  const push = useNavigation(state => state.push);
  const settings = useSettingsStore(state => state.settings);
  const productsCount = useCatalogStore(state => state.products.length);
  const embeddingsCount = useCatalogStore(state => state.embeddingsCount);
  const refresh = useCatalogStore(state => state.refresh);
  const printerStatus = usePrinterStore(state => state.status);

  const [today, setToday] = useState({revenue: 0, profit: 0, invoices: 0});

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        const day = localToday();
        const summary = await ReportRepo.summary({from: day, to: day});
        if (mounted) {
          setToday({
            revenue: summary.revenue,
            profit: summary.netProfit,
            invoices: summary.invoicesCount,
          });
        }
      } catch {
        // Dashboard is decorative — keep zeros on failure.
      }
    };
    void load();
    void refresh();
    return () => {
      mounted = false;
    };
  }, [refresh]);

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        {/* ── Brand header ──────────────────────────────────── */}
        <View style={styles.brandRow}>
          <View>
            <Text style={styles.brandTitle}>{APP_NAME}</Text>
            <Text style={styles.brandSubtitle}>
              نقطة بيع ذكية — تعرف بصري محلي 100%
            </Text>
          </View>
          <Badge
            label={printerStatus === 'connected' ? 'طابعة متصلة' : 'بدون طابعة'}
            tone={printerStatus === 'connected' ? 'success' : 'neutral'}
          />
        </View>

        {/* ── Today stats ───────────────────────────────────── */}
        <View style={styles.statsRow}>
          <StatCard label="مبيعات اليوم" value={`${today.revenue.toFixed(2)} ₪`} tone="accent" />
          <StatCard
            label="أرباح اليوم"
            value={`${today.profit.toFixed(2)} ₪`}
            tone={today.profit >= 0 ? 'success' : 'danger'}
          />
          <StatCard label="فواتير اليوم" value={String(today.invoices)} />
        </View>

        {/* ── Quick sale CTA ────────────────────────────────── */}
        <Card style={styles.ctaCard} onPress={() => push('pos')}>
          <View style={styles.ctaRow}>
            <View style={styles.ctaIconWrap}>
              <Text style={styles.ctaIcon}>📷</Text>
            </View>
            <View style={styles.ctaTextWrap}>
              <Text style={styles.ctaTitle}>ابدأ البيع الآن</Text>
              <Text style={styles.ctaSubtitle}>
                وجّه الكاميرا للمنتج — يُضاف تلقائياً للسلة
              </Text>
            </View>
            <Text style={styles.ctaArrow}>›</Text>
          </View>
        </Card>

        {/* ── Tiles grid ────────────────────────────────────── */}
        <View style={styles.grid}>
          {TILES.map(tile => (
            <TouchableOpacity
              key={tile.key}
              style={[styles.tile, {borderColor: tile.tone}]}
              activeOpacity={0.8}
              onPress={() => push(tile.screen)}>
              <Text style={styles.tileEmoji}>{tile.emoji}</Text>
              <Text style={styles.tileTitle}>{tile.title}</Text>
              <Text style={styles.tileSubtitle}>{tile.subtitle}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* ── System snapshot ───────────────────────────────── */}
        <Card style={styles.snapshotCard}>
          <Text style={styles.snapshotTitle}>حالة النظام</Text>
          <View style={styles.snapshotRow}>
            <Text style={styles.snapshotLabel}>المنتجات المسجلة</Text>
            <Text style={styles.snapshotValue}>{productsCount}</Text>
          </View>
          <View style={styles.snapshotRow}>
            <Text style={styles.snapshotLabel}>البصمات البصرية</Text>
            <Text style={styles.snapshotValue}>{embeddingsCount}</Text>
          </View>
          <View style={styles.snapshotRow}>
            <Text style={styles.snapshotLabel}>وضع التسعير الافتراضي</Text>
            <Text style={styles.snapshotValue}>
              {settings.defaultPricingMode === 'WHOLESALE' ? 'جملة' : 'مفرق'}
            </Text>
          </View>
          <View style={styles.snapshotRow}>
            <Text style={styles.snapshotLabel}>عتبة التطابق</Text>
            <Text style={styles.snapshotValue}>
              {(settings.matchThreshold * 100).toFixed(0)}%
            </Text>
          </View>
        </Card>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: spacing.lg,
    paddingTop: spacing.xl,
    gap: spacing.lg,
  },
  brandRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  brandTitle: {
    color: colors.accent,
    fontSize: 28,
    fontWeight: '900',
  },
  brandSubtitle: {
    color: colors.textDim,
    fontSize: typography.caption,
    marginTop: 4,
  },
  statsRow: {
    flexDirection: 'row',
    marginHorizontal: -4,
  },
  ctaCard: {
    backgroundColor: colors.accent,
    borderWidth: 0,
  },
  ctaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  ctaIconWrap: {
    width: 54,
    height: 54,
    borderRadius: radius.lg,
    backgroundColor: 'rgba(0,0,0,0.25)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaIcon: {fontSize: 28},
  ctaTextWrap: {flex: 1},
  ctaTitle: {color: '#FFFFFF', fontSize: typography.heading, fontWeight: '900'},
  ctaSubtitle: {color: 'rgba(255,255,255,0.85)', fontSize: typography.caption, marginTop: 2},
  ctaArrow: {color: '#FFFFFF', fontSize: 34, fontWeight: '900'},
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  tile: {
    width: '31%',
    aspectRatio: 0.9,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.sm,
    gap: 6,
  },
  tileEmoji: {fontSize: 30},
  tileTitle: {color: colors.text, fontWeight: '800', fontSize: typography.caption},
  tileSubtitle: {
    color: colors.textDim,
    fontSize: 10,
    textAlign: 'center',
  },
  snapshotCard: {gap: 10},
  snapshotTitle: {
    color: colors.text,
    fontWeight: '800',
    fontSize: typography.body,
    marginBottom: 4,
  },
  snapshotRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  snapshotLabel: {color: colors.textDim, fontSize: typography.caption},
  snapshotValue: {color: colors.text, fontWeight: '700', fontSize: typography.caption},
});
