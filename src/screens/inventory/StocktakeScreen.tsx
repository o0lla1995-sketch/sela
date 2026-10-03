/**
 * StocktakeScreen — نظام الجرد الكامل.
 * ─────────────────────────────────────────────────────────────────
 * One open session at a time:
 *   1. بدء الجرد → snapshots every product's system quantity
 *   2. عدّ سريع  → search + numeric entry + "مطابق" one-tap button
 *   3. إنهاء     → variance summary → optional stock reconciliation
 *                  (transactional) → notification + full report
 *
 * Completed sessions are listed with their full audit report and can
 * be exported as CSV from here.
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  Alert,
  Keyboard,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {useFocusEffect} from '@react-navigation/native';
import {
  AppButton,
  AppHeader,
  Badge,
  Card,
  EmptyState,
  SectionTitle,
  SearchBar,
} from '../../components/ui';
import {Icon} from '../../components/Icon';
import {StocktakeRepo} from '../../database/repositories/StocktakeRepo';
import {CategoryRepo} from '../../database/repositories/CategoryRepo';
import {ExportService} from '../../services/ExportService';
import {useCatalogStore} from '../../stores/catalogStore';
import {useNotificationsStore} from '../../stores/notificationsStore';
import {useToastStore} from '../../stores/toastStore';
import {parseNumber, formatDateTime} from '../../core/format';
import {
  fonts,
  makeStyles,
  radius,
  spacing,
  typography,
  useThemeColors,
} from '../../core/theme';
import type {
  Category,
  Stocktake,
  StocktakeItem,
  StocktakeSummary,
} from '../../core/types';

export function StocktakeScreen() {
  const c = useThemeColors();
  const styles = useStyles();
  const toast = useToastStore(state => state.show);
  const refreshCatalog = useCatalogStore(state => state.refresh);
  const pushNotification = useNotificationsStore(state => state.push);

  const [session, setSession] = useState<Stocktake | null>(null);
  const [history, setHistory] = useState<Stocktake[]>([]);
  const [items, setItems] = useState<StocktakeItem[]>([]);
  const [summary, setSummary] = useState<StocktakeSummary | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<number | 'all'>('all');
  const [onlyPending, setOnlyPending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [reportSession, setReportSession] = useState<Stocktake | null>(null);
  const [reportItems, setReportItems] = useState<StocktakeItem[] | null>(null);
  // v8.2 (round-11 #5): while the count keyboard is open, the whole
  // screen works for the LIST — stats, search, filters and the
  // bottom bar fold away so the merchant sees the maximum number of
  // counting rows while typing.
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () =>
      setKeyboardOpen(true),
    );
    const hide = Keyboard.addListener('keyboardDidHide', () =>
      setKeyboardOpen(false),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  /** Count-input chain (round-8): "next" on the keyboard jumps to
   *  the NEXT product's count field — counting flows row by row
   *  without ever touching the screen. */
  const countRefs = useRef<({focus: () => void} | null)[]>([]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [open, past, cats] = await Promise.all([
        StocktakeRepo.getOpen(),
        StocktakeRepo.list(),
        CategoryRepo.list(),
      ]);
      setSession(open);
      setHistory(past.filter(entry => entry.id !== open?.id));
      setCategories(cats);
      if (open != null) {
        const [sessionItems, sessionSummary] = await Promise.all([
          StocktakeRepo.listItems(open.id),
          StocktakeRepo.summary(open.id),
        ]);
        setItems(sessionItems);
        setSummary(sessionSummary);
      } else {
        setItems([]);
        setSummary(null);
      }
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'فشل تحميل الجرد',
        'error',
      );
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useFocusEffect(
    useCallback(() => {
      void loadAll();
    }, [loadAll]),
  );

  const startSession = useCallback(async () => {
    setStarting(true);
    try {
      const created = await StocktakeRepo.start();
      await loadAll();
      toast('بدأت جلسة الجرد — ابدأ عدّ المنتجات', 'success');
      setSession(created);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'تعذر بدء الجرد', 'error');
    } finally {
      setStarting(false);
    }
  }, [loadAll, toast]);

  const setCounted = useCallback(
    async (item: StocktakeItem, raw: string) => {
      if (session == null) {
        return;
      }
      const trimmed = raw.trim();
      const value = trimmed === '' ? null : parseNumber(trimmed);
      if (value != null && (Number.isNaN(value) || value < 0)) {
        return;
      }
      // Optimistic UI update.
      setItems(prev =>
        prev.map(row =>
          row.product_id === item.product_id
            ? {...row, counted_qty: value == null ? null : value}
            : row,
        ),
      );
      try {
        await StocktakeRepo.setCounted(
          session.id,
          item.product_id,
          value == null ? null : value,
        );
        const nextSummary = await StocktakeRepo.summary(session.id);
        setSummary(nextSummary);
      } catch (error) {
        toast(
          error instanceof Error ? error.message : 'تعذر حفظ العدد',
          'error',
        );
        await loadAll();
      }
    },
    [session, loadAll, toast],
  );

  const markMatched = useCallback(
    async (item: StocktakeItem) => {
      await setCounted(item, String(item.system_qty));
    },
    [setCounted],
  );

  const completeSession = useCallback(() => {
    if (session == null || summary == null) {
      return;
    }
    const uncounted = summary.totalItems - summary.countedItems;
    Alert.alert(
      'إنهاء الجرد',
      `تم عدّ ${summary.countedItems} من ${summary.totalItems} منتج` +
        (uncounted > 0
          ? ` (${uncounted} لم يُعدّ — ستبقى كميتها كما هي)`
          : '') +
        `.\nعناصر بها فروقات: ${
          summary.shortageItems + summary.surplusItems
        }.` +
        '\n\nهل تريد تعديل كميات المخزون لتطابق العدّ الفعلي؟',
      [
        {text: 'إلغاء', style: 'cancel'},
        {
          text: 'إنهاء بدون تعديل',
          style: 'destructive',
          onPress: async () => {
            try {
              await StocktakeRepo.complete(session.id, false);
              pushNotification(
                'stocktake',
                'اكتمل الجرد',
                'تم إنهاء جلسة الجرد دون تعديل كميات المخزون.',
                {},
              );
              await loadAll();
              await refreshCatalog();
              toast('تم إنهاء الجرد بدون تعديل المخزون', 'info');
            } catch (error) {
              toast(
                error instanceof Error ? error.message : 'فشل إنهاء الجرد',
                'error',
              );
            }
          },
        },
        {
          text: 'إنهاء وتعديل المخزون',
          onPress: async () => {
            try {
              const result = await StocktakeRepo.complete(session.id, true);
              pushNotification(
                'stocktake',
                'اكتمل الجرد وتحديث المخزون',
                `تم تعديل كميات ${result.adjusted} منتج لتطابق العدّ الفعلي.`,
                {},
              );
              await loadAll();
              await refreshCatalog();
              toast(
                `تم إنهاء الجرد وتعديل ${result.adjusted} منتج`,
                'success',
                4000,
              );
            } catch (error) {
              toast(
                error instanceof Error ? error.message : 'فشل إنهاء الجرد',
                'error',
              );
            }
          },
        },
      ],
    );
  }, [session, summary, loadAll, refreshCatalog, pushNotification, toast]);

  const cancelSession = useCallback(() => {
    if (session == null) {
      return;
    }
    Alert.alert(
      'إلغاء الجرد',
      'سيتم حذف جلسة الجرد الحالية بالكامل دون أي تعديل على المخزون. متابعة؟',
      [
        {text: 'تراجع', style: 'cancel'},
        {
          text: 'إلغاء الجرد',
          style: 'destructive',
          onPress: async () => {
            try {
              await StocktakeRepo.cancel(session.id);
              await loadAll();
              toast('تم إلغاء جلسة الجرد', 'info');
            } catch (error) {
              toast(
                error instanceof Error ? error.message : 'تعذر الإلغاء',
                'error',
              );
            }
          },
        },
      ],
    );
  }, [session, loadAll, toast]);

  const openReport = useCallback(
    async (entry: Stocktake) => {
      try {
        const report = await StocktakeRepo.listItems(entry.id);
        setReportSession(entry);
        setReportItems(report);
      } catch (error) {
        toast(
          error instanceof Error ? error.message : 'تعذر فتح التقرير',
          'error',
        );
      }
    },
    [toast],
  );

  const exportReport = useCallback(
    async (entry: Stocktake) => {
      try {
        const path = await ExportService.exportStocktakeReport(entry.id);
        toast(`تم حفظ تقرير الجرد: ${path}`, 'success', 4500);
      } catch (error) {
        toast(error instanceof Error ? error.message : 'فشل التصدير', 'error');
      }
    },
    [toast],
  );

  const filteredItems = useMemo(() => {
    const query = search.trim().toLowerCase();
    return items.filter(item => {
      if (onlyPending && item.counted_qty != null) {
        return false;
      }
      if (categoryFilter !== 'all' && item.categoryId !== categoryFilter) {
        return false;
      }
      if (query && !item.productName.toLowerCase().includes(query)) {
        return false;
      }
      return true;
    });
  }, [items, search, categoryFilter, onlyPending]);

  // ── Full report view (completed session) ─────────────────────
  if (reportSession != null && reportItems != null) {
    return (
      <View style={styles.screen}>
        <AppHeader
          title={`تقرير الجرد #${reportSession.id}`}
          subtitle={formatDateTime(reportSession.started_at)}
          showBack
          right={
            <AppButton
              small
              title="CSV"
              icon="download"
              variant="secondary"
              onPress={() => exportReport(reportSession)}
            />
          }
        />
        <ScrollView contentContainerStyle={styles.content}>
          <ReportTable items={reportItems} />
        </ScrollView>
        <View style={styles.reportBackBar}>
          <AppButton
            title="رجوع للجرد"
            variant="secondary"
            icon="chevronRight"
            onPress={() => {
              setReportSession(null);
              setReportItems(null);
            }}
          />
        </View>
      </View>
    );
  }

  // ── No open session → start / history ────────────────────────
  if (loading) {
    return (
      <View style={styles.screen}>
        <AppHeader title="الجرد" showBack />
        <View style={styles.center}>
          <Text style={styles.muted}>جارٍ التحميل…</Text>
        </View>
      </View>
    );
  }

  if (session == null) {
    return (
      <View style={styles.screen}>
        <AppHeader title="الجرد" subtitle="جرد كامل للمخزون" showBack />
        <ScrollView contentContainerStyle={styles.content}>
          <Card style={styles.card}>
            <SectionTitle
              title="بدء جلسة جرد"
              hint="يُلتقط عدد النظام الحالي لكل منتج ثم تعدّ المنتجات فعلياً"
            />
            <AppButton
              title="بدء جرد جديد"
              icon="clipboard"
              onPress={startSession}
              loading={starting}
            />
          </Card>

          <Card style={styles.card}>
            <SectionTitle
              title="سجل جلسات الجرد"
              hint="تقرير كامل لكل جلسة سابقة"
            />
            {history.length === 0 ? (
              <EmptyState
                icon="clipboard"
                title="لا توجد جلسات سابقة"
                subtitle="أول جلسة جرد ستظهر هنا مع تقريرها الكامل"
              />
            ) : (
              history.map(entry => (
                <TouchableOpacity
                  key={entry.id}
                  style={styles.historyRow}
                  activeOpacity={0.75}
                  onPress={() => openReport(entry)}>
                  <View
                    style={[styles.rowIcon, {backgroundColor: c.successSoft}]}>
                    <Icon name="clipboard" size={18} color={c.success} />
                  </View>
                  <View style={{flex: 1}}>
                    <Text style={styles.rowName}>جلسة #{entry.id}</Text>
                    <Text style={styles.rowMeta}>
                      {formatDateTime(entry.started_at)}
                      {entry.completed_at
                        ? ` — اكتملت ${formatDateTime(entry.completed_at)}`
                        : ''}
                    </Text>
                  </View>
                  <TouchableOpacity
                    style={styles.rowAction}
                    onPress={() => exportReport(entry)}>
                    <Icon name="download" size={17} color={c.info} />
                  </TouchableOpacity>
                  <Icon name="chevronLeft" size={16} color={c.textFaint} />
                </TouchableOpacity>
              ))
            )}
          </Card>
        </ScrollView>
      </View>
    );
  }

  // ── Active session ───────────────────────────────────────────
  return (
    <View style={styles.screen}>
      <AppHeader
        title={`جرد #${session.id}`}
        subtitle={`${summary?.countedItems ?? 0}/${
          summary?.totalItems ?? 0
        } منتج معدود`}
        showBack
        right={
          <AppButton
            small
            title="إنهاء"
            icon="check"
            onPress={completeSession}
          />
        }
      />

      <View style={styles.body}>
        {/* v8.1 compact progress strip — ONE slim bar (~52dp) replaces
            the three tall stat cards that ate the counting list.
            v8.2: hidden while the count keyboard is open. */}
        {!keyboardOpen ? (
          <View style={styles.miniStats}>
            <MiniStat
              tone="success"
              label="مطابق"
              value={String(summary?.matchedItems ?? 0)}
            />
            <View style={styles.miniStatDivider} />
            <MiniStat
              tone="danger"
              label="نقص"
              value={String(summary?.shortageItems ?? 0)}
            />
            <View style={styles.miniStatDivider} />
            <MiniStat
              tone="info"
              label="زيادة"
              value={String(summary?.surplusItems ?? 0)}
            />
          </View>
        ) : null}

        {!keyboardOpen ? (
          <SearchBar
            value={search}
            onChangeText={setSearch}
            placeholder="ابحث بالاسم أو امسح الباركود…"
          />
        ) : null}

        {/* v8.2 (round-11 #5): ONE tight filters block — the chips row
            and the uncounted-only toggle sit together with a hairline
            gap (the old body-level gap left a hole between them).
            Folds away while the keyboard is open. */}
        {!keyboardOpen ? (
          <View style={styles.filtersBlock}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{gap: 6, paddingVertical: 2}}>
              <FilterChip
                label="الكل"
                active={categoryFilter === 'all'}
                onPress={() => setCategoryFilter('all')}
              />
              {categories.map(cat => (
                <FilterChip
                  key={cat.id}
                  label={cat.name}
                  active={categoryFilter === cat.id}
                  onPress={() => setCategoryFilter(cat.id)}
                />
              ))}
            </ScrollView>
            <TouchableOpacity
              style={styles.pendingToggle}
              onPress={() => setOnlyPending(value => !value)}
              activeOpacity={0.8}>
              <Icon
                name={onlyPending ? 'check' : 'list'}
                size={15}
                color={onlyPending ? c.onAccent : c.textDim}
              />
              <Text
                style={[
                  styles.pendingText,
                  {color: onlyPending ? c.onAccent : c.textDim},
                ]}>
                {onlyPending ? 'إظهار الكل' : 'المنتجات غير المعدودة فقط'}
              </Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {filteredItems.length === 0 ? (
          <EmptyState
            icon="clipboard"
            title="لا نتائج"
            subtitle="جرّب بحثاً أو تصنيفاً آخر"
          />
        ) : (
          <ScrollView
            contentContainerStyle={{
              gap: spacing.sm,
              // v8.2: tight bottom padding while typing — every
              // millimeter above the keyboard shows counting rows.
              paddingBottom: keyboardOpen ? spacing.md : spacing.xxl,
            }}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled">
            {filteredItems.map((item, index) => (
              <CountRow
                key={item.product_id}
                item={item}
                onSetCounted={setCounted}
                onMarkMatched={markMatched}
                returnKeyType={
                  index === filteredItems.length - 1 ? 'done' : 'next'
                }
                onSubmitEditing={() => countRefs.current[index + 1]?.focus()}
                registerRef={handle => {
                  countRefs.current[index] = handle;
                }}
              />
            ))}
          </ScrollView>
        )}

        {!keyboardOpen ? (
          <View style={styles.bottomBar}>
            <AppButton
              title="إلغاء الجرد"
              variant="danger"
              icon="x"
              small
              style={{flex: 1}}
              onPress={cancelSession}
            />
            <AppButton
              title="إنهاء الجرد وتطبيق النتائج"
              icon="check"
              small
              style={{flex: 2}}
              onPress={completeSession}
            />
          </View>
        ) : null}
      </View>
    </View>
  );
}

// ────────────────────────────────────────────────────────────────
// Counting row
// ────────────────────────────────────────────────────────────────

function CountRow({
  item,
  onSetCounted,
  onMarkMatched,
  returnKeyType,
  onSubmitEditing,
  registerRef,
}: {
  item: StocktakeItem;
  onSetCounted: (item: StocktakeItem, raw: string) => Promise<void>;
  onMarkMatched: (item: StocktakeItem) => Promise<void>;
  /** Keyboard chain (round-8): "next" jumps to the next row's count. */
  returnKeyType?: 'next' | 'done';
  onSubmitEditing?: () => void;
  registerRef?: (handle: {focus: () => void} | null) => void;
}) {
  const c = useThemeColors();
  const styles = useStyles();
  const inputRef = useRef<TextInput>(null);
  const [text, setText] = useState(
    item.counted_qty == null ? '' : String(item.counted_qty),
  );

  // Expose focus() to the parent's count chain.
  useEffect(() => {
    registerRef?.({
      focus: () => inputRef.current?.focus(),
    });
    return () => registerRef?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setText(item.counted_qty == null ? '' : String(item.counted_qty));
  }, [item.counted_qty]);

  const counted = item.counted_qty;
  const variance = counted == null ? null : counted - item.system_qty;
  const tone =
    variance == null
      ? 'neutral'
      : variance === 0
      ? 'success'
      : variance > 0
      ? 'info'
      : 'danger';
  const toneLabel =
    variance == null
      ? 'لم يُعد'
      : variance === 0
      ? 'مطابق'
      : variance > 0
      ? `+${variance}`
      : `${variance}`;

  return (
    <View style={styles.row}>
      <View style={{flex: 1}}>
        <Text style={styles.rowName} numberOfLines={1}>
          {item.productName}
        </Text>
        <View style={styles.rowMetaRow}>
          <Text style={styles.rowMeta}>النظام: {item.system_qty}</Text>
          {item.unitHint ? (
            <Text style={styles.rowHint} numberOfLines={1}>
              ({item.unitHint})
            </Text>
          ) : null}
        </View>
        <Badge label={toneLabel} tone={tone} />
      </View>
      <View style={styles.countActions}>
        <TouchableOpacity
          style={styles.matchButton}
          onPress={() => onMarkMatched(item)}
          activeOpacity={0.8}>
          <Icon name="check" size={16} color={c.success} />
          <Text style={styles.matchText}>مطابق</Text>
        </TouchableOpacity>
        <TextInput
          ref={inputRef}
          style={styles.countInput}
          value={text}
          onChangeText={setText}
          onEndEditing={() => onSetCounted(item, text)}
          keyboardType="numeric"
          placeholder="0"
          placeholderTextColor={c.textFaint}
          returnKeyType={returnKeyType ?? 'next'}
          onSubmitEditing={() => {
            void onSetCounted(item, text);
            onSubmitEditing?.();
          }}
          blurOnSubmit={false}
        />
      </View>
    </View>
  );
}

// ────────────────────────────────────────────────────────────────
// Report table (completed session)
// ────────────────────────────────────────────────────────────────

function ReportTable({items}: {items: StocktakeItem[]}) {
  const styles = useStyles();
  const countedRows = items.filter(item => item.counted_qty != null);
  const variances = countedRows.filter(
    item => item.counted_qty! !== item.system_qty,
  );
  const totalSystem = items.reduce((sum, item) => sum + item.system_qty, 0);
  const totalCounted = items.reduce(
    (sum, item) => sum + (item.counted_qty ?? 0),
    0,
  );

  return (
    <View style={{gap: spacing.md}}>
      <View style={styles.reportSummary}>
        <Text style={styles.reportSummaryValue}>
          عددّ {countedRows.length} من أصل {items.length} منتج
        </Text>
        <Text style={styles.reportSummaryMeta}>
          إجمالي النظام: {totalSystem} · إجمالي العدّ: {totalCounted} · فرق:{' '}
          {totalCounted - totalSystem}
        </Text>
      </View>

      {variances.length > 0 ? (
        <Card>
          <SectionTitle title="الفروقات" hint="منتجات اختلف عدّها عن النظام" />
          {variances.map(item => {
            const variance = item.counted_qty! - item.system_qty;
            return (
              <View key={item.product_id} style={styles.reportRow}>
                <Text style={styles.rowName} numberOfLines={1}>
                  {item.productName}
                </Text>
                <Text style={styles.reportNumbers}>
                  {item.system_qty} → {item.counted_qty}
                </Text>
                <Badge
                  label={variance > 0 ? `+${variance}` : `${variance}`}
                  tone={variance > 0 ? 'info' : 'danger'}
                />
              </View>
            );
          })}
        </Card>
      ) : (
        <Card>
          <SectionTitle title="الفروقات" />
          <Text style={styles.muted}>
            لا توجد فروقات — كل المنتجات المعدودة مطابقة.
          </Text>
        </Card>
      )}

      <Card>
        <SectionTitle title="التفاصيل الكاملة" hint="كل منتجات الجلسة" />
        <View style={styles.tableHeader}>
          <Text style={[styles.tableHeaderCell, {flex: 2}]}>المنتج</Text>
          <Text style={styles.tableHeaderCell}>النظام</Text>
          <Text style={styles.tableHeaderCell}>العدّ</Text>
          <Text style={styles.tableHeaderCell}>الفرق</Text>
        </View>
        {items.map(item => {
          const variance =
            item.counted_qty == null
              ? null
              : item.counted_qty - item.system_qty;
          return (
            <View key={item.product_id} style={styles.tableRow}>
              <Text style={[styles.tableCell, {flex: 2}]} numberOfLines={1}>
                {item.productName}
              </Text>
              <Text style={styles.tableCell}>{item.system_qty}</Text>
              <Text style={styles.tableCell}>{item.counted_qty ?? '—'}</Text>
              <Text style={styles.tableCell}>
                {variance == null
                  ? '—'
                  : variance > 0
                  ? `+${variance}`
                  : `${variance}`}
              </Text>
            </View>
          );
        })}
      </Card>
    </View>
  );
}

function FilterChip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  const c = useThemeColors();
  const styles = useStyles();
  return (
    <TouchableOpacity
      style={[
        styles.chip,
        active ? {backgroundColor: c.accent, borderColor: c.accent} : null,
      ]}
      onPress={onPress}
      activeOpacity={0.7}
      hitSlop={{top: 4, bottom: 4, left: 2, right: 2}}>
      <Text style={[styles.chipText, {color: active ? c.onAccent : c.textDim}]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

/** v8.1 compact stat segment for the progress strip. */
function MiniStat({
  tone,
  label,
  value,
}: {
  tone: 'success' | 'danger' | 'info';
  label: string;
  value: string;
}) {
  const c = useThemeColors();
  const styles = useStyles();
  const color =
    tone === 'success' ? c.success : tone === 'danger' ? c.danger : c.info;
  return (
    <View style={styles.miniStat}>
      <View style={[styles.miniDot, {backgroundColor: color}]} />
      <Text style={styles.miniStatValue}>{value}</Text>
      <Text style={styles.miniStatLabel}>{label}</Text>
    </View>
  );
}

const useStyles = makeStyles(c =>
  StyleSheet.create({
    screen: {flex: 1, backgroundColor: c.bg},
    center: {flex: 1, alignItems: 'center', justifyContent: 'center'},
    muted: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.caption,
    },
    content: {
      padding: spacing.lg,
      gap: spacing.md,
      paddingBottom: spacing.xxl,
    },
    card: {gap: spacing.md},
    body: {
      flex: 1,
      padding: spacing.lg,
      gap: spacing.md,
    },
    miniStats: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: radius.md,
      paddingVertical: 10,
      paddingHorizontal: spacing.sm,
    },
    miniStat: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
    },
    miniDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
    },
    miniStatValue: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: 16,
      fontVariant: ['tabular-nums'],
    },
    miniStatLabel: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.micro + 1,
    },
    miniStatDivider: {
      width: 1,
      alignSelf: 'stretch',
      backgroundColor: c.borderSoft,
      marginVertical: 2,
    },
    /** v8.2 (round-11 #5): chips + uncounted toggle grouped in ONE
     *  tight block — no stray gap between them. */
    filtersBlock: {
      gap: 6,
    },
    pendingToggle: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.pill,
      paddingVertical: 8,
    },
    pendingText: {
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: radius.md,
      padding: spacing.md,
    },
    rowIcon: {
      width: 40,
      height: 40,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
    },
    rowName: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.caption,
    },
    rowMetaRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginVertical: 2,
    },
    rowMeta: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      fontVariant: ['tabular-nums'],
    },
    rowHint: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro,
      flexShrink: 1,
    },
    rowAction: {
      width: 38,
      height: 38,
      borderRadius: 12,
      backgroundColor: c.surfaceAlt,
      alignItems: 'center',
      justifyContent: 'center',
    },
    historyRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: c.borderSoft,
    },
    countActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    matchButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      backgroundColor: c.successSoft,
      borderWidth: 1,
      borderColor: c.success,
      borderRadius: radius.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: 9,
    },
    matchText: {
      color: c.success,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    countInput: {
      width: 74,
      color: c.text,
      fontFamily: fonts.black,
      fontSize: typography.body,
      textAlign: 'center',
      backgroundColor: c.surfaceAlt,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.sm,
      paddingVertical: 8,
    },
    bottomBar: {
      flexDirection: 'row',
      gap: spacing.sm,
      paddingTop: spacing.xs,
    },
    reportBackBar: {
      padding: spacing.lg,
    },
    reportSummary: {
      backgroundColor: c.accentSoft,
      borderRadius: radius.md,
      padding: spacing.lg,
      gap: 4,
    },
    reportSummaryValue: {
      color: c.text,
      fontFamily: fonts.black,
      fontSize: typography.heading,
    },
    reportSummaryMeta: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      lineHeight: 18,
    },
    reportRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: 9,
      borderBottomWidth: 1,
      borderBottomColor: c.borderSoft,
    },
    reportNumbers: {
      flex: 1,
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.small,
      fontVariant: ['tabular-nums'],
    },
    tableHeader: {
      flexDirection: 'row',
      gap: spacing.sm,
      paddingBottom: spacing.xs,
      borderBottomWidth: 1.5,
      borderBottomColor: c.border,
    },
    tableHeaderCell: {
      flex: 1,
      color: c.textFaint,
      fontFamily: fonts.bold,
      fontSize: typography.micro,
      textAlign: 'center',
    },
    tableRow: {
      flexDirection: 'row',
      gap: spacing.sm,
      paddingVertical: 8,
      borderBottomWidth: 1,
      borderBottomColor: c.borderSoft,
      alignItems: 'center',
    },
    tableCell: {
      flex: 1,
      color: c.text,
      fontFamily: fonts.medium,
      fontSize: typography.small,
      textAlign: 'center',
      fontVariant: ['tabular-nums'],
    },
    chip: {
      // v8.1: fixed 30dp height + tight padding — identical chip size
      // across every category, pill → small rectangle, instant tap.
      height: 30,
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 6,
      paddingHorizontal: 10,
    },
    chipText: {
      fontFamily: fonts.bold,
      fontSize: 12,
    },
  }),
);
