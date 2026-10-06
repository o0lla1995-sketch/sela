/**
 * v22 — VouchersTab: the «القسائم» tab of the Sila screen
 * (SILA_POS_VOUCHERS_API §7.2 — شاشة «مستحقات الحملات»).
 * ─────────────────────────────────────────────────────────────────
 * Two sub-views (round-28 #4: «سهولة في عرض أقسام صفحة القسائم
 * ويمكن فيها التعامل مع كمية كبيرة من البيانات»):
 * • «الحملات» — the campaigns book in three COLLAPSIBLE sections
 *   with live counts (فعّالة / مكتملة / متاحة) + a name search:
 *   - فعّالة: figures + «إنهاء الحملة (مكتملة)» — the v21 disable
 *     switch is GONE: the lifecycle is one-way (available → active
 *     → completed), no double activation, no deactivation.
 *   - مكتملة: read-only, «تبقى محفوظة كما هي» — data AND standing
 *     dues stay in the books; only the POS cart button drops them.
 *   - متاحة غير مفعّلة: activate buttons (SQL-guarded, once).
 * • «سجل الصرف» — paged history + state filter + full-text search
 *   (receipt / reference / campaign / code) + the needs-top-up note
 *   for redemptions whose goods sale is still pending.
 * The headline: المستحق لك — the ACTIVATED campaigns (active +
 * completed); «صرف قسيمة» standalone entry; «زامن الآن» (§6).
 */
import React, {useCallback, useEffect, useState} from 'react';
import {
  ActivityIndicator,
  Alert,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  AppButton,
  Badge,
  Card,
  EmptyState,
  SectionTitle,
  Segmented,
} from '../../components/ui';
import {Icon} from '../../components/Icon';
import {
  fonts,
  makeStyles,
  radius,
  spacing,
  typography,
  useThemeColors,
} from '../../core/theme';
import {formatMoney, relativeTime} from '../../core/format';
import {useToastStore} from '../../stores/toastStore';
import {useSilaStore} from '../../stores/silaStore';
import {VouchersRepo} from '../../services/sila/VouchersRepo';
import {VoucherService} from '../../services/VoucherService';
import {SilaSync} from '../../services/sila/SilaSync';
import {getString, KEYS} from '../../storage/storage';
import type {CampaignDebtRow, VoucherRedemptionRow} from '../../core/types';
import type {ReceiptSettings} from '../../services/printer/receipt';

const PAGE_SIZE = 20;
/** v22 (round-28 #4): how many campaign cards render while a
 * section is collapsed — large books stay scannable. */
const CAMPAIGN_PREVIEW = 4;

type VouchersView = 'campaigns' | 'history';

const VIEW_OPTIONS: {value: VouchersView; label: string}[] = [
  {value: 'campaigns', label: 'الحملات'},
  {value: 'history', label: 'سجل الصرف'},
];

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
  /** v24 (round-31 #4c): opens the PARCELS redemption sheet — the
   *  sheet itself lives in SilaScreen (Screen level) because an
   *  absolute overlay inside this tab's ScrollView sticks to the
   *  page bottom (the scroll-to-see complaint). */
  onOpenParcelRedeem: () => void;
  /** v24 (round-31 #4c): bumped by SilaScreen every time the parcel
   *  sheet closes — reloads the books (a redemption may have
   *  landed while it was open). */
  refreshKey: number;
}

export function VouchersTab({
  receiptSettings,
  printerConnected,
  onOpenParcelRedeem,
  refreshKey,
}: Props) {
  const c = useThemeColors();
  const styles = useStyles();
  const toast = useToastStore(state => state.show);

  const [view, setView] = useState<VouchersView>('campaigns');
  const [campaigns, setCampaigns] = useState<CampaignDebtRow[]>([]);
  const [totals, setTotals] = useState<Awaited<
    ReturnType<typeof VouchersRepo.campaignsTotals>
  > | null>(null);
  const [campaignSearch, setCampaignSearch] = useState('');
  const [showAllActive, setShowAllActive] = useState(false);
  const [completedOpen, setCompletedOpen] = useState(false);
  const [availableOpen, setAvailableOpen] = useState(false);
  const [redemptions, setRedemptions] = useState<VoucherRedemptionRow[]>([]);
  const [redemptionsTotal, setRedemptionsTotal] = useState(0);
  const [filter, setFilter] = useState<RedemptionFilter>('all');
  const [historySearch, setHistorySearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);
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

  // v24 (round-31 #4c): SilaScreen bumps refreshKey when the parcel
  // sheet closes — a redemption may have landed while it was open.
  useEffect(() => {
    if (refreshKey > 0) {
      void loadAll();
    }
  }, [refreshKey, loadAll]);

  // v22: the history search — debounced reload of page 0.
  useEffect(() => {
    const timer = setTimeout(() => {
      const stateFilter = filter === 'all' ? undefined : filter;
      void Promise.all([
        VouchersRepo.recent(
          PAGE_SIZE,
          0,
          stateFilter,
          historySearch.trim() || undefined,
        ),
        VouchersRepo.redemptionsCount(
          stateFilter,
          historySearch.trim() || undefined,
        ),
      ]).then(([rows, count]) => {
        setRedemptions(rows);
        setRedemptionsTotal(count);
      });
    }, 350);
    return () => clearTimeout(timer);
  }, [historySearch, filter]);

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
        historySearch.trim() || undefined,
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
  }, [
    loadingMore,
    redemptions.length,
    redemptionsTotal,
    filter,
    historySearch,
  ]);

  const applyFilter = useCallback(async (next: RedemptionFilter) => {
    setFilter(next);
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

  /** v22 (round-28 #4): ACTIVATE a campaign in this store — one-way
   *  and SQL-guarded: an already-active/completed campaign can never
   *  be activated twice (the repo rejects the move). A FULL
   *  settlements refresh follows immediately so the server's whole
   *  truth for this campaign lands in the books at once. */
  const activateCampaign = useCallback(
    async (campaign: CampaignDebtRow) => {
      setToggling(campaign.campaign_id);
      try {
        const changed = await VouchersRepo.activateCampaign(
          campaign.campaign_id,
        );
        if (!changed) {
          toast('هذه الحملة مفعّلة أصلاً — لا يمكن تفعيلها مرتين', 'info');
          await loadAll();
          return;
        }
        await SilaSync.refreshVouchersFull();
        // Keep the POS cart's قسيمة button in sync with the lifecycle.
        await useSilaStore.getState().refreshActiveCampaigns();
        await loadAll();
        toast(
          `فُعّلت حملة «${campaign.campaign_name}» في متجرك — تُحتسب مستحقاتها وتسوياتها من الآن`,
          'success',
          4500,
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'تعذر تفعيل الحملة';
        toast(message, 'error');
      } finally {
        setToggling(null);
      }
    },
    [loadAll, toast],
  );

  /** v22 (round-28 #4): COMPLETE a campaign — the ONLY way an active
   *  campaign leaves the active list (no deactivation, one-way).
   *  Its data and standing dues stay in the books exactly as they
   *  were; only the POS cart's قسيمة button stops counting it. */
  const completeCampaign = useCallback(
    (campaign: CampaignDebtRow) => {
      Alert.alert(
        'إنهاء الحملة (مكتملة)',
        `ستصبح حملة «${campaign.campaign_name}» مكتملة في متجرك:\n• يختفي زر القسيمة الخاص بها من سلة البيع\n• تبقى بياناتها ومستحقاتها القائمة محفوظة كما هي في دفاترك\n• لا يمكن التراجع أو إعادة التفعيل\nهل أنت متأكد؟`,
        [
          {text: 'تراجع', style: 'cancel'},
          {
            text: 'إنهاء الحملة',
            style: 'destructive',
            onPress: async () => {
              setToggling(campaign.campaign_id);
              try {
                await VouchersRepo.completeCampaign(campaign.campaign_id);
                await useSilaStore.getState().refreshActiveCampaigns();
                await loadAll();
                toast(
                  `أُنهيت حملة «${campaign.campaign_name}» — بياناتها ومستحقاتها القائمة تبقى محفوظة كما هي`,
                  'info',
                  4500,
                );
              } catch (error) {
                const message =
                  error instanceof Error ? error.message : 'تعذر إنهاء الحملة';
                toast(message, 'error');
              } finally {
                setToggling(null);
              }
            },
          },
        ],
      );
    },
    [loadAll, toast],
  );

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

  // v22 (round-28 #4): the lifecycle splits the list — ACTIVE are
  // the live books, COMPLETED keep their standing dues as they were,
  // AVAILABLE are offers the merchant may still activate (once).
  const needle = campaignSearch.trim();
  const matchingCampaigns = needle
    ? campaigns.filter(row => row.campaign_name.includes(needle))
    : campaigns;
  const activeCampaigns = matchingCampaigns.filter(
    row => row.store_state === 'active',
  );
  const completedCampaigns = matchingCampaigns.filter(
    row => row.store_state === 'completed',
  );
  const availableCampaigns = matchingCampaigns.filter(
    row => row.store_state === 'available',
  );
  const activePreview = showAllActive
    ? activeCampaigns
    : activeCampaigns.slice(0, CAMPAIGN_PREVIEW);

  const renderCampaignCard = (campaign: CampaignDebtRow) => {
    const badge = STATE_BADGE[campaign.settlement_state] ?? STATE_BADGE.none;
    const busy = toggling === campaign.campaign_id;
    const completed = campaign.store_state === 'completed';
    return (
      <Card
        key={`${campaign.store_state}-${campaign.campaign_id}`}
        style={styles.campaignCard}>
        <View style={styles.campaignHead}>
          <View style={{flex: 1}}>
            <Text style={styles.campaignName} numberOfLines={1}>
              {campaign.campaign_name}
            </Text>
            <Text style={styles.campaignMeta}>
              {campaign.kind === 'parcel'
                ? 'طرد — يُصرف من صفحة القسائم فقط'
                : 'قسيمة شرائية — تُصرف من سلة البيع فقط'}{' '}
              · {campaign.redeemed_count} عملية صرف
              {campaign.ends_at
                ? ` · تنتهي ${campaign.ends_at.slice(0, 10)}`
                : ''}
            </Text>
          </View>
          {completed ? (
            <Badge label="مكتملة" tone="success" />
          ) : (
            <Badge label={badge.label} tone={badge.tone} />
          )}
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
        {completed ? (
          <Text style={styles.campaignFullText}>
            ✓ مكتملة — بياناتها ومستحقاتها القائمة تبقى محفوظة كما هي في دفاترك،
            وزر القسيمة اختفى من سلة البيع
          </Text>
        ) : campaign.settlement_state === 'full' ? (
          <Text style={styles.campaignFullText}>
            ✓ مسدَّدة كاملة — استُوفي حقك بالكامل (يبقى السجل للمراجعة)
          </Text>
        ) : null}
        {!completed ? (
          <TouchableOpacity
            style={styles.completeBtn}
            onPress={() => completeCampaign(campaign)}
            disabled={busy}
            activeOpacity={0.8}>
            {busy ? (
              <ActivityIndicator size="small" color={c.warning} />
            ) : (
              <Icon name="checkCircle" size={14} color={c.warning} />
            )}
            <Text style={styles.completeBtnText}>
              إنهاء الحملة (مكتملة) — لا يمكن التراجع
            </Text>
          </TouchableOpacity>
        ) : null}
      </Card>
    );
  };

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

      {/* ── The headline (§7.2): what the institutions owe you — v22:
          the ACTIVATED campaigns (active + completed — a completed
          campaign's standing dues stay in the books as they were). ── */}
      <Card style={styles.dueHero}>
        <View style={styles.dueHeroRow}>
          <View style={styles.dueHeroIcon}>
            <Icon name="ticket" size={22} color={c.accent} />
          </View>
          <View style={{flex: 1}}>
            <Text style={styles.dueHeroLabel}>المستحق لك من الحملات</Text>
            <Text style={[styles.dueHeroValue, {color: c.accent}]}>
              {formatMoney((totals?.dueMinor ?? 0) / 100)}
            </Text>
          </View>
        </View>
        <View style={styles.dueMetaRow}>
          <Text style={styles.dueMetaText}>
            فعّالة: {totals?.activeCount ?? 0} · مكتملة:{' '}
            {totals?.completedCount ?? 0} · مصروف:{' '}
            {formatMoney((totals?.redeemedMinor ?? 0) / 100)} · مستلم:{' '}
            {formatMoney((totals?.settledMinorTotal ?? 0) / 100)}
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
        {/* v21 → v24 (round-31 #4/#5): the standalone redemption
            entry — PARCELS ONLY now (the button's name, hint and the
            sheet itself all say طرد). Purchase coupons redeem from
            the POS cart's قسيمة button and are REJECTED here. */}
        <AppButton
          title="صرف طرد صِلة (بدون سلة)"
          icon="qrFrame"
          onPress={onOpenParcelRedeem}
          style={{marginTop: spacing.sm}}
        />
        <Text style={styles.parcelBtnHint}>
          لحملات الطرود فقط — أما القسائم الشرائية فتُصرف من سلة البيع في شاشة
          البيع (زر قسيمة)
        </Text>
      </Card>

      {/* v22 (round-28 #4): the two sub-views — the campaigns book
          and the redemption history, so huge lists never mix. */}
      <Segmented value={view} onChange={setView} options={VIEW_OPTIONS} />

      {view === 'campaigns' ? (
        <>
          {/* Campaign name search (client-side, live). */}
          <TextInput
            style={styles.searchBox}
            value={campaignSearch}
            onChangeText={setCampaignSearch}
            placeholder="ابحث باسم الحملة…"
            placeholderTextColor={c.textFaint}
          />

          {/* ── الحملات الفعّالة ── */}
          <SectionTitle
            title={`الحملات الفعّالة${
              activeCampaigns.length > 0 ? ` (${activeCampaigns.length})` : ''
            }`}
            hint="المفعّلة في متجرك — حملات القسائم الشرائية يظهر زرها في سلة البيع وتُصرف منها، وحملات الطرود تُصرف من زر صرف الطرد هنا فقط"
          />
          {activeCampaigns.length === 0 && !loading ? (
            <EmptyState
              icon="ticket"
              title={needle ? 'لا حملات مطابقة لبحثك' : 'لا توجد حملات فعّالة'}
              subtitle={
                needle
                  ? 'جرّب اسماً آخر أو أمسح البحث'
                  : 'فعّل حملة من قسم «حملات متاحة» بالأسفل حتى تُحتسب مستحقاتها وتسوياتها في متجرك'
              }
            />
          ) : (
            <>
              {activePreview.map(renderCampaignCard)}
              {activeCampaigns.length > CAMPAIGN_PREVIEW ? (
                <TouchableOpacity
                  style={styles.moreBtn}
                  onPress={() => setShowAllActive(previous => !previous)}
                  activeOpacity={0.8}>
                  <Text style={styles.moreText}>
                    {showAllActive
                      ? 'عرض أقل'
                      : `عرض كل الفعّالة (${activeCampaigns.length})`}
                  </Text>
                </TouchableOpacity>
              ) : null}
            </>
          )}

          {/* ── الحملات المكتملة (round-28 #4) — collapsed by default
              so a long history never buries the live books. ── */}
          {completedCampaigns.length > 0 ? (
            <>
              <TouchableOpacity
                style={styles.sectionToggle}
                onPress={() => setCompletedOpen(previous => !previous)}
                activeOpacity={0.8}>
                <Icon
                  name={completedOpen ? 'chevronDown' : 'chevronLeft'}
                  size={15}
                  color={c.textDim}
                />
                <Text style={styles.sectionToggleTitle}>
                  الحملات المكتملة ({completedCampaigns.length})
                </Text>
                <Text style={styles.sectionToggleHint}>
                  محفوظة كما هي — مستحقاتها القائمة باقية في الدفاتر
                </Text>
              </TouchableOpacity>
              {completedOpen
                ? completedCampaigns.map(renderCampaignCard)
                : null}
            </>
          ) : null}

          {/* ── حملات متاحة غير مفعّلة ── */}
          {availableCampaigns.length > 0 ? (
            <>
              <TouchableOpacity
                style={styles.sectionToggle}
                onPress={() => setAvailableOpen(previous => !previous)}
                activeOpacity={0.8}>
                <Icon
                  name={availableOpen ? 'chevronDown' : 'chevronLeft'}
                  size={15}
                  color={c.textDim}
                />
                <Text style={styles.sectionToggleTitle}>
                  حملات متاحة غير مفعّلة ({availableCampaigns.length})
                </Text>
                <Text style={styles.sectionToggleHint}>
                  متجرك متعاقد فيها عبر صِلة — فعّلها لتُحتسب
                </Text>
              </TouchableOpacity>
              {availableOpen
                ? availableCampaigns.map(campaign => {
                    const busy = toggling === campaign.campaign_id;
                    return (
                      <Card
                        key={`off-${campaign.campaign_id}`}
                        style={styles.offerCard}>
                        <View style={styles.campaignHead}>
                          <View style={styles.offerIcon}>
                            <Icon name="ticket" size={17} color={c.textDim} />
                          </View>
                          <View style={{flex: 1}}>
                            <Text style={styles.offerName} numberOfLines={1}>
                              {campaign.campaign_name}
                            </Text>
                            <Text style={styles.campaignMeta}>
                              {campaign.kind === 'parcel'
                                ? 'طرد — يُصرف من صفحة القسائم'
                                : 'قسيمة شرائية — تُصرف من سلة البيع'}
                              {campaign.merchant_status === 'accepted'
                                ? ' · متعاقد فيها'
                                : ''}
                              {campaign.ends_at
                                ? ` · تنتهي ${campaign.ends_at.slice(0, 10)}`
                                : ''}
                            </Text>
                          </View>
                        </View>
                        <Text style={styles.offerHint}>
                          لن يُحتسب أي شيء من مستحقات وتسويات هذه الحملة في
                          متجرك حتى تفعيلها — وبعد التفعيل تُضاف مستحقاتها كدين
                          على المؤسسة حتى التسوية تماماً كديون صِلة. التفعيل لا
                          يتكرر ولا يمكن التراجع عنه إلا بإنهاء الحملة.
                        </Text>
                        <AppButton
                          title="تفعيل الحملة في متجري"
                          icon="check"
                          small
                          onPress={() => void activateCampaign(campaign)}
                          loading={busy}
                        />
                      </Card>
                    );
                  })
                : null}
            </>
          ) : null}
        </>
      ) : (
        <>
          {/* ── سجل الصرف — search + filters + paged list ── */}
          <TextInput
            style={styles.searchBox}
            value={historySearch}
            onChangeText={setHistorySearch}
            placeholder="ابحث برقم الإيصال أو المرجع أو الحملة أو الكود…"
            placeholderTextColor={c.textFaint}
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
              subtitle={
                historySearch.trim()
                  ? 'لا نتائج مطابقة لبحثك — جرّب كلمة أخرى'
                  : 'كل قسيمة تصرفها تُسجَّل هنا مع مرجعها الرسمي وحالتها'
              }
            />
          ) : (
            redemptions.map(row => {
              /** v22 (round-28 #1): a cart-tied redemption whose goods
               *  sale is still pending — the cart was smaller than the
               *  voucher and the handover waits for the top-up. */
              const awaitingGoods =
                row.state === 'ok' &&
                row.cart_json != null &&
                row.sale_id == null;
              return (
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
                        ? ` · فرق نقدي ${formatMoney(
                            row.counter_extra_minor / 100,
                          )}`
                        : ''}
                    </Text>
                    {awaitingGoods ? (
                      <Text style={styles.awaitingGoodsText}>
                        بانتظار إكمال السلة — كانت أقل من قيمة القسيمة، أكملها
                        من شاشة البيع وسجّل البضاعة
                      </Text>
                    ) : null}
                  </View>
                  {printerConnected ? (
                    <Icon name="printer" size={16} color={c.textFaint} />
                  ) : null}
                </TouchableOpacity>
              );
            })
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
        </>
      )}
    </>
  );
}

// v24 (round-31 #4e): THEMED — the tab was dark-only (hard-coded
// #F5F5F7 / #8E8E9A / rgba(255,255,255,…) text and surfaces) and
// ignored the light mode entirely (the merchant's complaint:
// «الألوان في الخطوط في صفحة القسائم في الوضع النهاري لا تتبدل»).
// Every color now reads the live palette.
const useStyles = makeStyles(c =>
  StyleSheet.create({
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
      backgroundColor: c.accentSofter,
      alignItems: 'center',
      justifyContent: 'center',
    },
    dueHeroLabel: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    dueHeroValue: {
      color: c.text,
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
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro,
      flex: 1,
    },
    dueMetaTime: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro,
    },
    pendingBox: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      backgroundColor: c.warningSoft,
      borderRadius: radius.sm,
      padding: spacing.sm,
    },
    pendingText: {
      flex: 1,
      color: c.warning,
      fontFamily: fonts.regular,
      fontSize: typography.micro,
      lineHeight: 15,
    },
    /** v24 (round-31 #4/#5): the parcels-only button's charter. */
    parcelBtnHint: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro,
      lineHeight: 15,
      textAlign: 'center',
    },
    /** v22 (round-28 #4): the campaign/history search boxes. */
    searchBox: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: radius.sm,
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.small,
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.md,
    },
    /** v22 (round-28 #4): the collapsible section header. */
    sectionToggle: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingVertical: spacing.xs + 2,
      flexWrap: 'wrap',
    },
    sectionToggleTitle: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: typography.small,
    },
    sectionToggleHint: {
      flex: 1,
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro,
      textAlign: 'left',
      minWidth: 120,
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
      color: c.text,
      fontFamily: fonts.black,
      fontSize: typography.body,
    },
    campaignMeta: {
      color: c.textFaint,
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
      backgroundColor: c.surfaceHi,
      borderRadius: radius.sm,
      padding: spacing.sm,
      alignItems: 'center',
      gap: 2,
    },
    campaignCellDue: {
      backgroundColor: c.warningSoft,
    },
    campaignValue: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: typography.body,
    },
    campaignValueLabel: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro,
    },
    campaignFullText: {
      color: c.success,
      fontFamily: fonts.regular,
      fontSize: typography.micro,
    },
    /** v22 (round-28 #4): the one-way «complete campaign» button —
     *  replaces the v21 disable switch (deactivation is gone). */
    completeBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      paddingVertical: spacing.xs + 2,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: c.warning,
      backgroundColor: c.warningSoft,
    },
    completeBtnText: {
      color: c.warning,
      fontFamily: fonts.bold,
      fontSize: typography.micro + 1,
    },
    /** The AVAILABLE (not activated) campaign card. */
    offerCard: {
      gap: spacing.sm,
    },
    offerIcon: {
      width: 38,
      height: 38,
      borderRadius: 12,
      backgroundColor: c.surfaceHi,
      alignItems: 'center',
      justifyContent: 'center',
    },
    offerName: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    offerHint: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro,
      lineHeight: 15,
    },
    filterRow: {
      flexDirection: 'row',
      gap: 6,
      flexWrap: 'wrap',
    },
    filterChip: {
      borderRadius: 6,
      borderWidth: 1,
      borderColor: c.border,
      paddingHorizontal: 10,
      paddingVertical: 3,
      minHeight: 26,
      justifyContent: 'center',
    },
    filterChipActive: {
      backgroundColor: c.accent,
      borderColor: c.accent,
    },
    filterChipText: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: 11.5,
    },
    historyRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      backgroundColor: c.surface,
      borderRadius: radius.sm,
      padding: spacing.sm,
      borderWidth: 1,
      borderColor: c.borderSoft,
    },
    historyIcon: {
      width: 34,
      height: 34,
      borderRadius: 17,
      backgroundColor: c.surfaceHi,
      alignItems: 'center',
      justifyContent: 'center',
    },
    historyTitle: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    historyMeta: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro,
      marginTop: 2,
    },
    /** v22 (round-28 #1): the needs-top-up note on a history row. */
    awaitingGoodsText: {
      color: c.warning,
      fontFamily: fonts.bold,
      fontSize: typography.micro,
      marginTop: 3,
      lineHeight: 14,
    },
    moreBtn: {
      alignItems: 'center',
      padding: spacing.sm,
    },
    moreText: {
      color: c.accent,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
  }),
);
