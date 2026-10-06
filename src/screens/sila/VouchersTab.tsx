/**
 * v20 — VouchersTab: the «القسائم» tab of the Sila screen
 * (SILA_POS_VOUCHERS_API §7.2 — شاشة «مستحقات الحملات»).
 * ─────────────────────────────────────────────────────────────────
 * • The headline: المستحق لك من كل الحملات (Σ server-stated dues).
 * • Per campaign: المصروف / المستلم / المستحق + the state badge
 *   (لا شيء = رمادية، جزئية = ذهبية، كاملة = خضراء) + آخر تسوية.
 * • صرف قسيمة — the standalone redemption sheet (parcel campaigns /
 *   untracked goods; the POS checkout covers cart-tied redemptions).
 * • سجل الصرف — paged history with state filter + reprint.
 * • زامن الآن — the settlements light sync (§6) + pending retries.
 */
import React, {useCallback, useEffect, useState} from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  AppButton,
  Badge,
  Card,
  EmptyState,
  SectionTitle,
} from '../../components/ui';
import {Icon} from '../../components/Icon';
import {
  fonts,
  radius,
  spacing,
  typography,
  useThemeColors,
} from '../../core/theme';
import {formatMoney, relativeTime} from '../../core/format';
import {useToastStore} from '../../stores/toastStore';
import {VouchersRepo} from '../../services/sila/VouchersRepo';
import {VoucherService} from '../../services/VoucherService';
import {SilaSync} from '../../services/sila/SilaSync';
import {getString, KEYS} from '../../storage/storage';
import {VoucherRedeemSheet} from './VoucherRedeemSheet';
import type {CampaignDebtRow, VoucherRedemptionRow} from '../../core/types';
import type {ReceiptSettings} from '../../services/printer/receipt';

const PAGE_SIZE = 20;

type RedemptionFilter = 'all' | 'ok' | 'pending' | 'failed';

const REDEMPTION_FILTERS: {value: RedemptionFilter; label: string}[] = [
  {value: 'all', label: 'الكل'},
  {value: 'ok', label: 'مصروفة'},
  {value: 'pending', label: 'معلّقة'},
  {value: 'failed', label: 'فاشلة'},
];

const STATE_BADGE: Record<
  CampaignDebtRow['settlement_state'],
  {label: string; tone: 'neutral' | 'warning' | 'success'; text: string}
> = {
  none: {label: 'لا شيء', tone: 'neutral', text: 'لم تصل أي تسوية بعد'},
  partial: {label: 'جزئية', tone: 'warning', text: 'استلمت جزءاً من مستحقاتك'},
  full: {label: 'كاملة', tone: 'success', text: 'مسدَّدة كاملة'},
};

interface Props {
  receiptSettings: ReceiptSettings;
  printerConnected: boolean;
}

export function VouchersTab({receiptSettings, printerConnected}: Props) {
  const c = useThemeColors();
  const toast = useToastStore(state => state.show);

  const [campaigns, setCampaigns] = useState<CampaignDebtRow[]>([]);
  const [totals, setTotals] = useState<Awaited<
    ReturnType<typeof VouchersRepo.campaignsTotals>
  > | null>(null);
  const [redemptions, setRedemptions] = useState<VoucherRedemptionRow[]>([]);
  const [redemptionsTotal, setRedemptionsTotal] = useState(0);
  const [filter, setFilter] = useState<RedemptionFilter>('all');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState('');

  const loadAll = useCallback(async () => {
    try {
      const [campaignRows, campaignTotals, rows, count] = await Promise.all([
        VouchersRepo.campaigns(),
        VouchersRepo.campaignsTotals(),
        VouchersRepo.recent(PAGE_SIZE, 0),
        VouchersRepo.redemptionsCount(),
      ]);
      setCampaigns(campaignRows);
      setTotals(campaignTotals);
      setRedemptions(rows);
      setRedemptionsTotal(count);
      setLastSyncAt(getString(KEYS.silaSettlementsSyncedAt, ''));
    } catch {
      // Fresh installs before the first sync — quiet.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // Reload when the sheet closes (a redemption may have landed).
  useEffect(() => {
    if (!sheetOpen) {
      void loadAll();
    }
  }, [sheetOpen, loadAll]);

  const loadMore = useCallback(async () => {
    if (loadingMore || redemptions.length >= redemptionsTotal) {
      return;
    }
    setLoadingMore(true);
    try {
      const stateFilter = filter === 'all' ? undefined : filter;
      const rows = await VouchersRepo.recent(
        PAGE_SIZE,
        redemptions.length,
        stateFilter,
      );
      setRedemptions(previous => {
        const seen = new Set(previous.map(row => row.local_id));
        return [...previous, ...rows.filter(row => !seen.has(row.local_id))];
      });
    } catch {
      // quiet
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, redemptions.length, redemptionsTotal, filter]);

  const applyFilter = useCallback(async (next: RedemptionFilter) => {
    setFilter(next);
    setLoadingMore(true);
    try {
      const stateFilter = next === 'all' ? undefined : next;
      const [rows, count] = await Promise.all([
        VouchersRepo.recent(PAGE_SIZE, 0, stateFilter),
        VouchersRepo.redemptionsCount(stateFilter),
      ]);
      setRedemptions(rows);
      setRedemptionsTotal(count);
    } catch {
      // quiet
    } finally {
      setLoadingMore(false);
    }
  }, []);

  const syncNow = useCallback(async () => {
    setSyncing(true);
    try {
      await SilaSync.refreshVouchers();
      await loadAll();
      toast('تمت مزامنة الحملات والقسائم', 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'تعذرت المزامنة';
      toast(message, 'error');
    } finally {
      setSyncing(false);
    }
  }, [loadAll, toast]);

  const reprint = useCallback(
    async (row: VoucherRedemptionRow) => {
      if (!row.pos_receipt_ref) {
        return;
      }
      try {
        await VoucherService.reprintByReceiptRef(
          row.pos_receipt_ref,
          receiptSettings,
        );
        toast('أُرسل إيصال الصرف للطابعة', 'success');
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'تعذرت إعادة الطباعة';
        toast(message, 'error');
      }
    },
    [receiptSettings, toast],
  );

  return (
    <>
      {/* Sync actions row — the §6 light settlements sync + retries. */}
      <View style={styles.syncRow}>
        <AppButton
          title="زامن الحملات الآن"
          icon="refresh"
          small
          onPress={() => void syncNow()}
          loading={syncing}
          style={{flex: 1}}
        />
      </View>

      {/* ── The headline (§7.2): what the institutions owe you ── */}
      <Card style={styles.dueHero}>
        <View style={styles.dueHeroRow}>
          <View style={styles.dueHeroIcon}>
            <Icon name="ticket" size={22} color={c.accent} />
          </View>
          <View style={{flex: 1}}>
            <Text style={styles.dueHeroLabel}>المستحق لك من كل الحملات</Text>
            <Text style={[styles.dueHeroValue, {color: c.accent}]}>
              {formatMoney((totals?.dueMinor ?? 0) / 100)}
            </Text>
          </View>
        </View>
        <View style={styles.dueMetaRow}>
          <Text style={styles.dueMetaText}>
            حملات: {totals?.campaignsCount ?? 0} · مصروف:{' '}
            {formatMoney((totals?.redeemedMinor ?? 0) / 100)} · مستلم مؤكد:{' '}
            {formatMoney((totals?.settledConfirmedMinor ?? 0) / 100)}
          </Text>
          {lastSyncAt ? (
            <Text style={styles.dueMetaTime}>
              آخر مزامنة:{' '}
              {relativeTime(lastSyncAt.replace('T', ' ').slice(0, 19))}
            </Text>
          ) : (
            <Text style={styles.dueMetaTime}>لم تتم المزامنة بعد</Text>
          )}
        </View>
        {(totals?.settledPendingMinor ?? 0) > 0 ? (
          <View style={styles.pendingBox}>
            <Icon name="clock" size={14} color={c.warning} />
            <Text style={styles.pendingText}>
              تسويات بانتظار تأكيد استلامك:{' '}
              {formatMoney((totals?.settledPendingMinor ?? 0) / 100)} — أكّدها
              من تطبيق صِلة بعد وصول المبلغ
            </Text>
          </View>
        ) : null}
        <AppButton
          title="صرف قسيمة صلة"
          icon="qrFrame"
          onPress={() => setSheetOpen(true)}
          style={{marginTop: spacing.sm}}
        />
      </Card>

      {/* ── مستحقات الحملات (§7.2) ── */}
      <SectionTitle
        title="مستحقات الحملات"
        hint="كل حملة متعاقد فيها متجرك — المطالبة على المؤسسة حتى التسوية"
      />
      {campaigns.length === 0 ? (
        <EmptyState
          icon="ticket"
          title="لا توجد حملات بعد"
          subtitle="تظهر الحملات هنا بعد أول صرف قسيمة أو أول مزامنة — يجب أن يقبل متجرك دعوة المؤسسة من تطبيق صِلة"
        />
      ) : (
        campaigns.map(campaign => {
          const badge =
            STATE_BADGE[campaign.settlement_state] ?? STATE_BADGE.none;
          return (
            <Card key={campaign.campaign_id} style={styles.campaignCard}>
              <View style={styles.campaignHead}>
                <View style={{flex: 1}}>
                  <Text style={styles.campaignName} numberOfLines={1}>
                    {campaign.campaign_name}
                  </Text>
                  <Text style={styles.campaignMeta}>
                    {campaign.kind === 'parcel' ? 'طرد' : 'قسيمة'} ·{' '}
                    {campaign.redeemed_count} عملية صرف
                    {campaign.ends_at
                      ? ` · تنتهي ${campaign.ends_at.slice(0, 10)}`
                      : ''}
                  </Text>
                </View>
                <Badge label={badge.label} tone={badge.tone} />
              </View>
              <View style={styles.campaignGrid}>
                <View style={styles.campaignCell}>
                  <Text style={styles.campaignValue}>
                    {formatMoney(campaign.redeemed_value_minor / 100)}
                  </Text>
                  <Text style={styles.campaignValueLabel}>مصروف</Text>
                </View>
                <View style={styles.campaignCell}>
                  <Text style={[styles.campaignValue, {color: c.success}]}>
                    {formatMoney(campaign.settled_minor / 100)}
                  </Text>
                  <Text style={styles.campaignValueLabel}>مستلم</Text>
                </View>
                <View
                  style={[
                    styles.campaignCell,
                    campaign.due_minor > 0 && styles.campaignCellDue,
                  ]}>
                  <Text
                    style={[
                      styles.campaignValue,
                      campaign.due_minor > 0 && {color: c.warning},
                    ]}>
                    {formatMoney(campaign.due_minor / 100)}
                  </Text>
                  <Text style={styles.campaignValueLabel}>المستحق لك</Text>
                </View>
              </View>
              {campaign.settlement_state === 'full' ? (
                <Text style={styles.campaignFullText}>
                  ✓ مسدَّدة كاملة — استُوفي حقك بالكامل (يبقى السجل للمراجعة)
                </Text>
              ) : null}
            </Card>
          );
        })
      )}

      {/* ── سجل الصرف ── */}
      <SectionTitle
        title="سجل الصرف"
        hint="كل محاولة صرف بحالتها — المعلّقة تُعاد تلقائياً بنفس مفتاحها"
      />
      <View style={styles.filterRow}>
        {REDEMPTION_FILTERS.map(item => (
          <TouchableOpacity
            key={item.value}
            style={[
              styles.filterChip,
              filter === item.value && styles.filterChipActive,
            ]}
            onPress={() => void applyFilter(item.value)}
            activeOpacity={0.8}>
            <Text
              style={[
                styles.filterChipText,
                filter === item.value && {color: c.onAccent},
              ]}>
              {item.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {redemptions.length === 0 && !loading ? (
        <EmptyState
          icon="ticket"
          title="لا توجد عمليات صرف"
          subtitle="كل قسيمة تصرفها تُسجَّل هنا مع مرجعها الرسمي وحالتها"
        />
      ) : (
        redemptions.map(row => (
          <TouchableOpacity
            key={row.local_id}
            style={styles.historyRow}
            onPress={() => void reprint(row)}
            disabled={!printerConnected}
            activeOpacity={0.8}>
            <View style={styles.historyIcon}>
              <Icon
                name={
                  row.state === 'ok'
                    ? 'checkCircle'
                    : row.state === 'pending'
                    ? 'clock'
                    : 'alert'
                }
                size={19}
                color={
                  row.state === 'ok'
                    ? c.success
                    : row.state === 'pending'
                    ? c.warning
                    : c.danger
                }
              />
            </View>
            <View style={{flex: 1}}>
              <Text style={styles.historyTitle}>
                {row.state === 'ok'
                  ? `${formatMoney(row.value_minor / 100)} — ${
                      row.campaign_name ?? 'حملة'
                    }`
                  : row.state === 'pending'
                  ? 'بانتظار الاتصال…'
                  : row.error_message ?? 'فشل الصرف'}
              </Text>
              <Text style={styles.historyMeta} numberOfLines={1}>
                {row.pos_receipt_ref ?? '—'}
                {row.reference_code ? ` · ${row.reference_code}` : ''}
                {row.counter_extra_minor > 0
                  ? ` · فرق نقدي ${formatMoney(row.counter_extra_minor / 100)}`
                  : ''}
              </Text>
            </View>
            {printerConnected ? (
              <Icon name="printer" size={16} color={c.textFaint} />
            ) : null}
          </TouchableOpacity>
        ))
      )}
      {redemptions.length < redemptionsTotal ? (
        <TouchableOpacity
          style={styles.moreBtn}
          onPress={() => void loadMore()}
          disabled={loadingMore}
          activeOpacity={0.8}>
          {loadingMore ? (
            <ActivityIndicator size="small" color={c.accent} />
          ) : (
            <Text style={styles.moreText}>
              عرض المزيد ({redemptions.length} من {redemptionsTotal})
            </Text>
          )}
        </TouchableOpacity>
      ) : null}

      {/* The standalone redemption sheet (no cart — parcels etc.). */}
      <VoucherRedeemSheet
        visible={sheetOpen}
        onClose={() => setSheetOpen(false)}
        cart={null}
        receiptSettings={receiptSettings}
        printerConnected={printerConnected}
      />
    </>
  );
}

const styles = StyleSheet.create({
  syncRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  dueHero: {
    gap: spacing.xs,
  },
  dueHeroRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  dueHeroIcon: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: 'rgba(249,115,22,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dueHeroLabel: {
    color: '#C9C9D4',
    fontFamily: fonts.bold,
    fontSize: typography.small,
  },
  dueHeroValue: {
    color: '#F5F5F7',
    fontFamily: fonts.black,
    fontSize: typography.title,
    marginTop: 2,
  },
  dueMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    flexWrap: 'wrap',
  },
  dueMetaText: {
    color: '#8E8E9A',
    fontFamily: fonts.regular,
    fontSize: typography.micro,
    flex: 1,
  },
  dueMetaTime: {
    color: '#8E8E9A',
    fontFamily: fonts.regular,
    fontSize: typography.micro,
  },
  pendingBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(245,158,11,0.10)',
    borderRadius: radius.sm,
    padding: spacing.sm,
  },
  pendingText: {
    flex: 1,
    color: '#FCD34D',
    fontFamily: fonts.regular,
    fontSize: typography.micro,
    lineHeight: 15,
  },
  campaignCard: {
    gap: spacing.sm,
  },
  campaignHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  campaignName: {
    color: '#F5F5F7',
    fontFamily: fonts.black,
    fontSize: typography.body,
  },
  campaignMeta: {
    color: '#8E8E9A',
    fontFamily: fonts.regular,
    fontSize: typography.micro,
    marginTop: 2,
  },
  campaignGrid: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  campaignCell: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: radius.sm,
    padding: spacing.sm,
    alignItems: 'center',
    gap: 2,
  },
  campaignCellDue: {
    backgroundColor: 'rgba(245,158,11,0.10)',
  },
  campaignValue: {
    color: '#F5F5F7',
    fontFamily: fonts.black,
    fontSize: typography.body,
  },
  campaignValueLabel: {
    color: '#8E8E9A',
    fontFamily: fonts.regular,
    fontSize: typography.micro,
  },
  campaignFullText: {
    color: '#4ADE80',
    fontFamily: fonts.regular,
    fontSize: typography.micro,
  },
  filterRow: {
    flexDirection: 'row',
    gap: 6,
    flexWrap: 'wrap',
  },
  filterChip: {
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    paddingHorizontal: 10,
    paddingVertical: 3,
    minHeight: 26,
    justifyContent: 'center',
  },
  filterChipActive: {
    backgroundColor: '#F97316',
    borderColor: '#F97316',
  },
  filterChipText: {
    color: '#C9C9D4',
    fontFamily: fonts.bold,
    fontSize: 11.5,
  },
  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: radius.sm,
    padding: spacing.sm,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  historyIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(255,255,255,0.05)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  historyTitle: {
    color: '#F5F5F7',
    fontFamily: fonts.bold,
    fontSize: typography.small,
  },
  historyMeta: {
    color: '#8E8E9A',
    fontFamily: fonts.regular,
    fontSize: typography.micro,
    marginTop: 2,
  },
  moreBtn: {
    alignItems: 'center',
    padding: spacing.sm,
  },
  moreText: {
    color: '#F97316',
    fontFamily: fonts.bold,
    fontSize: typography.small,
  },
});
