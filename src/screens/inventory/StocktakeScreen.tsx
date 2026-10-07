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
  ActivityIndicator,
  Alert,
  BackHandler,
  FlatList,
  Linking,
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
import {parseNumber, formatDateTime, formatQty} from '../../core/format';
import {
  cameraPermissionMessage,
  ensureCameraPermission,
  scanBarcode,
} from '../../services/vision/scanFlow';
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
  // v29.1 (round-37 #3): صفر مستمعات Keyboard — الإحصاءات والبحث
  // والفلاتر وشريط الأسفل تبقى دائماً. طيّها لحظة فتح اللوحة (v8.2)
  // كان يفكّ شريط البحث نفسه بعد تركيزه مباشرة — أي أن الضغط على
  // البحث كان يقتل لوحة المفاتيح حتماً على أي جهاز، ويحرّك قسم
  // المنتجات كاملاً للأعلى أثناء استقرار الـ IME في باقي الحقول
  // (نفس علة روم الجهاز). الشجرة الآن ثابتة تماماً لحظة فتح أي
  // لوحة — والنظام وحده يقلّص نافذة الشاشة.

  /** Count-input chain (round-8): "next" on the keyboard jumps to
   *  the NEXT product's count field — counting flows row by row
   *  without ever touching the screen. */
  const countRefs = useRef<({focus: () => void} | null)[]>([]);
  /** v30 (round-38 #2): the counting list's ref — a scanned product
   *  may sit far below the rendered window of the virtualized list,
   *  so it is scrolled into view BEFORE its count input is focused. */
  const listRef = useRef<FlatList<StocktakeItem> | null>(null);

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

  /** v31 (round-39 #1): وضع العدّ — عند الضغط على منتج تُطوى
   *  الإحصاءات والفلاتر والشريط السفلي فيمتلئ قسم المنتجات بالصفحة
   *  «كما كان»، ويُركّز حقل عدّ المنتج المضغوط. لا علاقة لهذا
   *  بلوحة المفاتيح إطلاقاً (لا مستمعات ولا ردود فعل onFocus) —
   *  التغيير يحدث بضغطة المنتج نفسها، وقبل فتح أي لوحة، فتستقر
   *  الشجرة ثم يُركّز الحقل بعد ~280ms. شريط البحث لا يتغير أبداً
   *  بين الوضعين فيبقى ساكناً لحظة الضغط عليه (إصلاح v29.1 محفوظ).
   *
   *  v32 (round-40 #2): وضع العدّ صار أحادي المنتج — «عند الضغط
   *  على حقل إدخال الكمية يظهر المنتج المُعَدّ فقط دون باقي
   *  المنتجات» — بطاقة تركيز واحدة تعرض المنتج الحالي بحقل عدّ
   *  كبير ثابت (لا يُفكّك أبداً أثناء التنقل فلا تُغلق اللوحة)،
   *  وزر «التالي» في لوحة المفاتيح ينقل للمنتج التالي مباشرة،
   *  مع أزرار سابق/تالي على الشاشة ومؤشر موضع (٥/١٢٠) وزر
   *  «عرض الكل» للعودة للقائمة الكاملة. */
  const [countMode, setCountMode] = useState(false);
  /** فهرس المنتج المركّز داخل القائمة المفلترة (وضع العدّ الأحادي). */
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  /** نص حقل العدّ في بطاقة التركيز — في الأب ليتسنى التبديل بين
   *  المنتجات دون إعادة تركيب الحقل (الحقل نفسه لا يُفكّك). */
  const [focusText, setFocusText] = useState('');
  const focusInputRef = useRef<TextInput>(null);
  const countFocusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countFocusTimer2 = useRef<ReturnType<typeof setTimeout> | null>(null);
  const matchAdvanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clean the delayed-focus chain on unmount.
  useEffect(
    () => () => {
      if (countFocusTimer.current != null) {
        clearTimeout(countFocusTimer.current);
      }
      if (countFocusTimer2.current != null) {
        clearTimeout(countFocusTimer2.current);
      }
      if (matchAdvanceTimer.current != null) {
        clearTimeout(matchAdvanceTimer.current);
      }
    },
    [],
  );

  /** v31: الضغط على منتج — يفتح وضع العدّ (أول مرة) ويركّز حقل
   *  عدّه. الطيّ يحدث أولاً ثم يُلبث ~280ms حتى يستقر التخطيط
   *  الجديد قبل تركيز الحقل — التركيز لحظة تغيّر الشجرة هو بالضبط
   *  ما كان يقتل لوحة المفاتيح على روم الجهاز (درس v29/v29.1)،
   *  فالترتيب هنا: اطمئ على الشجرة ← ركّز. */
  const startSession = useCallback(async () => {
    setStarting(true);
    setCountMode(false);
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
      // v30 (round-38 #2): the query matches the NAME or an exact
      // BARCODE — so a scanned code filled into the search field
      // lands on its product straight away.
      if (
        query &&
        !item.productName.toLowerCase().includes(query) &&
        (item.barcode ?? '') !== query
      ) {
        return false;
      }
      return true;
    });
  }, [items, search, categoryFilter, onlyPending]);

  /** المنتج المركّز الحالي في وضع العدّ (undefined = خارج الوضع). */
  const focusedItem =
    countMode && focusIndex != null ? filteredItems[focusIndex] : undefined;

  /** v32: يعبّئ نص حقل التركيز من حالة العدّ المحفوظة للمنتج. */
  const syncFocusText = useCallback((item: StocktakeItem | undefined) => {
    setFocusText(item?.counted_qty == null ? '' : String(item.counted_qty));
  }, []);

  /** v32: يحفظ قيمة العدّ الحالية للمنتج المركّز (بلا انتظار). */
  const commitFocusedCount = useCallback(() => {
    if (focusIndex == null) {
      return;
    }
    const item = filteredItems[focusIndex];
    if (item != null) {
      void setCounted(item, focusText);
    }
  }, [focusIndex, filteredItems, focusText, setCounted]);

  /** v32: دخول وضع العدّ الأحادي — يُفقد تركيز أي حقل أولاً (تُغلق
   *  اللوحة بهدوء) ثم يُبدّل التخطيط، وبعد ~280ms يُركّز حقل البطاقة
   *  على شجرة مستقرة (نفس ترتيب v31: اطمئن على الشجرة ← ركّز). */
  const enterCountMode = useCallback(
    (index: number) => {
      const focused = TextInput.State.currentlyFocusedInput();
      focused?.blur?.();
      const item = filteredItems[index];
      setFocusIndex(index);
      syncFocusText(item);
      setCountMode(true);
      if (countFocusTimer.current != null) {
        clearTimeout(countFocusTimer.current);
      }
      if (countFocusTimer2.current != null) {
        clearTimeout(countFocusTimer2.current);
      }
      countFocusTimer.current = setTimeout(() => {
        focusInputRef.current?.focus();
      }, 280);
    },
    [filteredItems, syncFocusText],
  );

  /** v32: الانتقال بين المنتجات في وضع العدّ — يحفظ الحالي ثم ينقل
   *  البطاقة للمنتج المجاور. الحقل لا يُفكّك ولا يُفقد تركيزه فلا
   *  تُغلق لوحة المفاتيح أبداً أثناء التنقل. */
  const advanceFocus = useCallback(
    (delta: 1 | -1) => {
      if (focusIndex == null) {
        return;
      }
      const next = focusIndex + delta;
      if (next < 0 || next >= filteredItems.length) {
        return;
      }
      commitFocusedCount();
      setFocusIndex(next);
      syncFocusText(filteredItems[next]);
    },
    [focusIndex, filteredItems, commitFocusedCount, syncFocusText],
  );

  /** v32: زر «مطابق» في بطاقة التركيز — يساوي العدّ بكمية النظام
   *  ثم ينتقل تلقائياً للمنتج التالي بعد لحظة (تسريع العدّ المتواصل)
   *  — آخر منتج يبقى مكانه. */
  const markMatchedFocused = useCallback(() => {
    if (focusIndex == null) {
      return;
    }
    const item = filteredItems[focusIndex];
    if (item == null) {
      return;
    }
    setFocusText(String(item.system_qty));
    void setCounted(item, String(item.system_qty));
    if (matchAdvanceTimer.current != null) {
      clearTimeout(matchAdvanceTimer.current);
    }
    if (focusIndex < filteredItems.length - 1) {
      matchAdvanceTimer.current = setTimeout(() => {
        advanceFocus(1);
      }, 420);
    }
  }, [focusIndex, filteredItems, setCounted, advanceFocus]);

  /** v31: الرجوع من وضع العدّ — يُفقد تركيز أي حقل أولاً (تُغلق
   *  اللوحة بهدوء) ثم تُفتح الأقسام، فلا يتحرك حقل مركّز أبداً. */
  const exitCountMode = useCallback(() => {
    commitFocusedCount();
    const focused = TextInput.State.currentlyFocusedInput();
    focused?.blur?.();
    setCountMode(false);
    setFocusIndex(null);
  }, [commitFocusedCount]);

  /** v32: خروج صامت (بلا blur) — عند الكتابة في البحث أثناء وضع
   *  العدّ: حقل البحث نفسه هو المركّز ولا يتحرك بين الوضعين
   *  (نفس الارتفاع تماماً — انظر countModeBar)، فتبديل ما تحته
   *  آمن تماماً حسب درس v28/v29.1. */
  const silentExitCountMode = useCallback(() => {
    setCountMode(false);
    setFocusIndex(null);
  }, []);

  /** v32: زر الرجوع في وضع العدّ يخرج منه بدل مغادرة الشاشة. */
  useEffect(() => {
    if (!countMode) {
      return;
    }
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      exitCountMode();
      return true;
    });
    return () => sub.remove();
  }, [countMode, exitCountMode]);

  /** v32: أي كتابة في البحث تُنهي وضع العدّ بصمت — النتائج تتحدث
   *  تحت شريط بحث ثابت لا يتحرك. */
  const onChangeSearch = useCallback(
    (text: string) => {
      if (countMode) {
        silentExitCountMode();
      }
      setSearch(text);
    },
    [countMode, silentExitCountMode],
  );

  // ── v30 (round-38 #2): scan-to-search beside the counting search ──
  const [scanBusy, setScanBusy] = useState(false);
  /** The product whose count input gets focused once the filtered
   *  list containing it has rendered (after a barcode scan). */
  const [pendingFocusId, setPendingFocusId] = useState<number | null>(null);

  const scanForCount = useCallback(async () => {
    if (scanBusy) {
      return;
    }
    const permission = await ensureCameraPermission();
    if (permission !== 'granted') {
      Alert.alert('إذن الكاميرا مطلوب', cameraPermissionMessage(permission), [
        {text: 'إغلاق', style: 'cancel'},
        {
          text: 'فتح الإعدادات',
          onPress: () => {
            void Linking.openSettings();
          },
        },
      ]);
      return;
    }
    setScanBusy(true);
    try {
      const code = await scanBarcode();
      if (code == null) {
        return; // scanner closed without a read.
      }
      setSearch(code);
      const exact = items.filter(item => item.barcode === code);
      if (exact.length === 1) {
        // Found — focus its count input once the list re-renders,
        // ready for the merchant to type the counted quantity.
        setPendingFocusId(exact[0].product_id);
      } else if (exact.length === 0) {
        toast(
          `لا يوجد منتج بهذا الباركود (${code}) في جلسة الجرد`,
          'info',
          4500,
        );
      }
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'فشل مسح الباركود',
        'error',
      );
    } finally {
      setScanBusy(false);
    }
  }, [scanBusy, items, toast]);

  // v32 (round-40 #2): after a barcode scan the matching product
  // lands DIRECTLY in the single-product focus mode — the scanner
  // overlay just closed (no keyboard, no focused input), so the
  // layout swap is safe; the focus card's input is focused once the
  // tree settles (same enterCountMode chain as a product press).
  useEffect(() => {
    if (pendingFocusId == null) {
      return;
    }
    const index = filteredItems.findIndex(
      item => item.product_id === pendingFocusId,
    );
    if (index < 0) {
      return;
    }
    setPendingFocusId(null);
    enterCountMode(index);
  }, [pendingFocusId, filteredItems, enterCountMode]);

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
        {/* v31 (round-39 #1): في الوضع العادي شريط التقدّم المدمج
            (v8.1) — وفي وضع العدّ (ضغط منتج) يحل محله شريط رقيق
            بنفس المكان وزر «عرض الكل» للرجوع، فلا يتزحزح شريط
            البحث بين الوضعين إلا فارق ارتفاع ضئيل مرة واحدة لحظة
            ضغط المنتج — وبعدها يبقى ساكناً تماماً. */}
        {countMode ? (
          <View style={styles.countModeBar}>
            <Icon name="clipboard" size={15} color={c.accent} />
            <Text style={styles.countModeText} numberOfLines={1}>
              {`وضع العدّ — منتج ${(focusIndex ?? 0) + 1} من ${
                filteredItems.length
              }`}
            </Text>
            <TouchableOpacity
              style={styles.countModeExit}
              onPress={exitCountMode}
              activeOpacity={0.75}
              hitSlop={{top: 6, bottom: 6, left: 4, right: 4}}>
              <Icon name="chevronDown" size={14} color={c.textDim} />
              <Text style={styles.countModeExitText}>عرض الكل</Text>
            </TouchableOpacity>
          </View>
        ) : (
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
        )}

        {/* v30 (round-38 #2): البحث + زر مسح الباركود (أيقونة فقط)
            — المسح يعبّئ حقل البحث بالكود ويركّز حقل عدّ المنتج
            المطابق مباشرة (نفس نمط المخزون). */}
        <View style={styles.searchRow}>
          <View style={{flex: 1}}>
            {/* v32: الكتابة في البحث تُنهي وضع العدّ بصمت — شريط
                البحث ثابت في نفس الموضع والارتفاع بين الوضعين. */}
            <SearchBar
              value={search}
              onChangeText={onChangeSearch}
              placeholder="ابحث بالاسم أو امسح الباركود…"
            />
          </View>
          <TouchableOpacity
            style={styles.scanBtn}
            onPress={() => void scanForCount()}
            disabled={scanBusy}
            activeOpacity={0.7}
            hitSlop={{top: 6, bottom: 6, left: 6, right: 6}}>
            {scanBusy ? (
              <ActivityIndicator size="small" color={c.accent} />
            ) : (
              <Icon name="barcode" size={22} color={c.accent} />
            )}
          </TouchableOpacity>
        </View>

        {/* v8.2 (round-11 #5): ONE tight filters block — the chips row
            and the uncounted-only toggle sit together with a hairline
            gap (the old body-level gap left a hole between them).
            v29.1: always visible (stable tree — see top).
            v31: يُطوى في وضع العدّ (ضغط منتج) — انظر أعلى. */}
        {!countMode ? (
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

        {countMode && focusedItem != null ? (
          /* v32 (round-40 #2): بطاقة التركيز الأحادية — المنتج المضغوط
           * فقط بحقل عدّ كبير واحد لا يُفكّك أبداً أثناء التنقل بين
           * المنتجات (زر «التالي» في لوحة المفاتيح أو أزرار الشاشة)
           * فلا تُغلق اللوحة إطلاقاً — والحقل داخل ScrollView بـ
           * keyboardShouldPersistTaps="handled" فتلمس الأزرار مرة
           * واحدة حتى واللوحة مفتوحة. */
          <ScrollView
            style={{flex: 1}}
            contentContainerStyle={styles.focusCardScroll}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}>
            <FocusCountCard
              item={focusedItem}
              position={(focusIndex ?? 0) + 1}
              total={filteredItems.length}
              text={focusText}
              onChangeText={setFocusText}
              inputRef={focusInputRef}
              onMarkMatched={markMatchedFocused}
              onAdvance={advanceFocus}
              onExit={exitCountMode}
            />
          </ScrollView>
        ) : filteredItems.length === 0 ? (
          <EmptyState
            icon="clipboard"
            title="لا نتائج"
            subtitle="جرّب بحثاً أو تصنيفاً آخر"
          />
        ) : (
          /* v30 (round-38 #2): FlatList افتراضية بدل ScrollView العادي
           * — جلسة الجرد تعرض كل كتالوج المتجر؛ بلا افتراضية كان فتح
           * لوحة المفاتيح (البحث أو حقل العدّ) يعيد تخطيط آلاف الصفوف
           * على الخيط الرئيسي فيستسلم الـ IME ويغلقها فوراً (نفس درس
           * المخزون v28). الافتراضية تُبقي التمريرة صغيرة واللوحة
           * مفتوحة، وسلسلة «التالي» بين حقول العدّ تعمل كالمعتاد
           * (الصفوف المجاورة للمنطقة المرئية محمّلة دوماً). */
          <FlatList
            ref={listRef}
            style={{flex: 1}}
            data={filteredItems}
            keyExtractor={item => String(item.product_id)}
            onScrollToIndexFailed={info => {
              // The row's frame is not measured yet (fresh filter) —
              // estimate from the average frame and retry shortly.
              const estimate =
                info.index <= info.highestMeasuredFrameIndex
                  ? info.index
                  : Math.max(
                      0,
                      info.highestMeasuredFrameIndex +
                        Math.floor(
                          (info.index - info.highestMeasuredFrameIndex) /
                            4,
                        ),
                    );
              listRef.current?.scrollToIndex({
                index: estimate,
                animated: false,
              });
              setTimeout(() => {
                listRef.current?.scrollToIndex({
                  index: info.index,
                  viewPosition: 0.4,
                  animated: false,
                });
              }, 120);
            }}
            renderItem={({item, index}) => (
              <CountRow
                item={item}
                onSetCounted={setCounted}
                onMarkMatched={markMatched}
                onPressRow={() => enterCountMode(index)}
                returnKeyType={
                  index === filteredItems.length - 1 ? 'done' : 'next'
                }
                onSubmitEditing={() => countRefs.current[index + 1]?.focus()}
                registerRef={handle => {
                  countRefs.current[index] = handle;
                }}
              />
            )}
            contentContainerStyle={{
              gap: spacing.sm,
              paddingBottom: spacing.xxl,
            }}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            initialNumToRender={12}
            maxToRenderPerBatch={12}
            windowSize={7}
          />
        )}

        {/* v29.1: الشريط السفلي يبقى دائماً — إلغاء/إنهاء الجرد في
            متناول اليد حتى أثناء الكتابة، والشجرة لا تتغير.
            v31: يُطوى في وضع العدّ ليملأ قسم المنتجات الصفحة —
            «إنهاء» يبقى متاحاً دائماً في ترويسة الشاشة. */}
        {!countMode ? (
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
  onPressRow,
  returnKeyType,
  onSubmitEditing,
  registerRef,
}: {
  item: StocktakeItem;
  onSetCounted: (item: StocktakeItem, raw: string) => Promise<void>;
  onMarkMatched: (item: StocktakeItem) => Promise<void>;
  /** v31 (round-39 #1): pressing the PRODUCT itself opens the
   *  full-page counting mode and focuses this row's count input. */
  onPressRow?: () => void;
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

  // v32 (round-40 #2): pressing the row's count INPUT itself enters
  // the single-product focus mode too («عند الضغط على حقل إدخال
  // كمية المنتج يظهر المنتج فقط») — the native focus fires first,
  // then enterCountMode blurs it calmly, swaps the layout and
  // re-focuses the focus card's input on the settled tree. The tree
  // NEVER changes while an input holds focus.
  const onInputFocus = useCallback(() => {
    onPressRow?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onPressRow]);

  useEffect(() => {
    setText(item.counted_qty == null ? '' : String(item.counted_qty));
  }, [item.counted_qty]);

  const counted = item.counted_qty;
  const variance = counted == null ? null : counted - item.system_qty;
  const tone =
    variance == null
      ? 'neutral'
      : Math.abs(variance) < 0.0005
      ? 'success'
      : variance > 0
      ? 'info'
      : 'danger';
  const toneLabel =
    variance == null
      ? 'لم يُعد'
      : Math.abs(variance) < 0.0005
      ? 'مطابق'
      : `${variance > 0 ? '+' : ''}${formatQty(variance)}`;

  return (
    <View style={styles.row}>
      {/* v31 (round-39 #1): الضغط على المنتج نفسه — يفتح وضع العدّ
          بملء الصفحة ويركّز حقل العدّ (بلا أي رد فعل على اللوحة). */}
      <TouchableOpacity
        style={{flex: 1}}
        activeOpacity={0.75}
        onPress={onPressRow}
        disabled={onPressRow == null}>
        <Text style={styles.rowName} numberOfLines={1}>
          {item.productName}
        </Text>
        <View style={styles.rowMetaRow}>
          <Text style={styles.rowMeta}>
            النظام: {formatQty(item.system_qty)}
            {item.soldByWeight === 1 ? ' كغ' : ''}
          </Text>
          {item.unitHint ? (
            <Text style={styles.rowHint} numberOfLines={1}>
              ({item.unitHint})
            </Text>
          ) : null}
        </View>
        <Badge label={toneLabel} tone={tone} />
      </TouchableOpacity>
      <View style={styles.countActions}>
        <TouchableOpacity
          style={styles.matchButton}
          onPress={() => onMarkMatched(item)}
          activeOpacity={0.8}>
          <Icon name="check" size={16} color={c.success} />
          <Text style={styles.matchText}>مطابق</Text>
        </TouchableOpacity>
        {/* v8.3 (round-12 #4): weight products count in fractional
            kilograms — decimal-pad shows the point key. */}
        <TextInput
          ref={inputRef}
          style={styles.countInput}
          value={text}
          onChangeText={setText}
          onEndEditing={() => onSetCounted(item, text)}
          keyboardType={
            item.soldByWeight === 1 ? 'decimal-pad' : 'numeric'
          }
          placeholder={item.soldByWeight === 1 ? '0.0' : '0'}
          placeholderTextColor={c.textFaint}
          returnKeyType={returnKeyType ?? 'next'}
          onSubmitEditing={() => {
            void onSetCounted(item, text);
            onSubmitEditing?.();
          }}
          onFocus={onInputFocus}
          blurOnSubmit={false}
        />
      </View>
    </View>
  );
}

// ────────────────────────────────────────────────────────────────
// v32 (round-40 #2) → v33 (round-41 #6): FocusCountCard — بطاقة
// العدّ أحادية المنتج بتصميم مضغوط: أربعة صفوف فقط (طلب التاجر:
// «البطاقة كبيرة جداً — صغّرها واضغط العناصر سوياً بشكل احترافي
// دون تداخل») — ترويسة تجمع الموضع والاسم والخروج في سطر واحد،
// سطر كمية النظام، ثم حقل العدّ وزر «مطابق» جنباً إلى جنب، ثم
// شارة الفرق الحيّة وأزرار السابق/التالي في سطر واحد. حقل العدّ
// واحد ثابت لا يُعاد تركيبه أبداً عند التنقل بين المنتجات فلا
// تُغلق لوحة المفاتيح (درس روم الجهاز v29+)، وScrollView الأب
// بـ keyboardShouldPersistTaps="handled" فتعمل الأزرار بلمسة
// واحدة حتى واللوحة مفتوحة.
// ────────────────────────────────────────────────────────────

function FocusCountCard({
  item,
  position,
  total,
  text,
  onChangeText,
  inputRef,
  onMarkMatched,
  onAdvance,
  onExit,
}: {
  item: StocktakeItem;
  position: number;
  total: number;
  text: string;
  onChangeText: (value: string) => void;
  inputRef: React.MutableRefObject<TextInput | null>;
  onMarkMatched: () => void;
  onAdvance: (delta: 1 | -1) => void;
  onExit: () => void;
}) {
  const c = useThemeColors();
  const styles = useStyles();

  const parsed = text.trim() === '' ? null : parseNumber(text);
  const counted = parsed == null || Number.isNaN(parsed) ? null : parsed;
  const variance =
    counted == null
      ? null
      : Math.round((counted - item.system_qty) * 1000) / 1000;
  const tone =
    variance == null
      ? 'neutral'
      : Math.abs(variance) < 0.0005
      ? 'success'
      : variance > 0
      ? 'info'
      : 'danger';
  const toneLabel =
    variance == null
      ? 'لم يُعد بعد'
      : Math.abs(variance) < 0.0005
      ? 'مطابق تماماً'
      : `${variance > 0 ? '+' : ''}${formatQty(variance)} عن النظام`;
  const atFirst = position <= 1;
  const atLast = position >= total;

  return (
    <View style={styles.focusCard}>
      {/* ترويسة مضغوطة: الموضع + الاسم + الخروج — سطر واحد */}
      <View style={styles.focusHeaderRow}>
        <View style={styles.focusBadgeWrap}>
          <Badge label={`${position}/${total}`} tone="neutral" />
        </View>
        <Text style={styles.focusName} numberOfLines={1}>
          {item.productName}
        </Text>
        <TouchableOpacity
          style={styles.focusExitBtn}
          onPress={onExit}
          activeOpacity={0.75}>
          <Icon name="list" size={13} color={c.textDim} />
          <Text style={styles.focusExitText}>عرض الكل</Text>
        </TouchableOpacity>
      </View>

      {/* كمية النظام + الوحدة — سطر صغير هادئ */}
      <Text style={styles.focusMeta} numberOfLines={1}>
        بالنظام: {formatQty(item.system_qty)}
        {item.soldByWeight === 1 ? ' كغ' : ''}
        {item.unitHint ? ` · (${item.unitHint})` : ''}
      </Text>

      {/* حقل العدّ + زر المطابقة — جنباً إلى جنب */}
      <View style={styles.focusInputRow}>
        <TextInput
          ref={inputRef}
          style={styles.focusInput}
          value={text}
          onChangeText={onChangeText}
          keyboardType={item.soldByWeight === 1 ? 'decimal-pad' : 'numeric'}
          placeholder={item.soldByWeight === 1 ? '0.0' : '0'}
          placeholderTextColor={c.textFaint}
          returnKeyType={atLast ? 'done' : 'next'}
          onSubmitEditing={() => {
            if (!atLast) {
              onAdvance(1);
            }
          }}
          blurOnSubmit={false}
        />
        <TouchableOpacity
          style={styles.focusMatchBtn}
          onPress={onMarkMatched}
          activeOpacity={0.8}>
          <Icon name="check" size={16} color={c.success} />
          <Text style={styles.focusMatchText}>مطابق</Text>
        </TouchableOpacity>
      </View>

      {/* الفرق الحيّ + التنقل — سطر واحد */}
      <View style={styles.focusNavRow}>
        <View style={styles.focusBadgeWrap}>
          <Badge label={toneLabel} tone={tone} />
        </View>
        <View style={styles.focusNavBtns}>
          <AppButton
            title="السابق"
            icon="chevronRight"
            variant="secondary"
            small
            disabled={atFirst}
            onPress={() => onAdvance(-1)}
            style={{flex: 1}}
          />
          <AppButton
            title={atLast ? 'الأخير' : 'التالي'}
            icon="chevronLeft"
            variant="primary"
            small
            disabled={atLast}
            onPress={() => onAdvance(1)}
            style={{flex: 1}}
          />
        </View>
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
          إجمالي النظام: {formatQty(totalSystem)} · إجمالي العدّ:{' '}
          {formatQty(totalCounted)} · فرق:{' '}
          {formatQty(totalCounted - totalSystem)}
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
    /** v30 (round-38 #2): البحث + زر المسح في صف واحد (نفس نمط
     *  المخزون ومركز الفواتير). */
    searchRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    scanBtn: {
      width: 46,
      height: 48,
      borderRadius: radius.md,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      alignItems: 'center',
      justifyContent: 'center',
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
      // v32 (round-40 #2): نفس ارتفاع شريط وضع العدّ تماماً — شريط
      // البحث لا يتحرك بكسلاً واحداً بين الوضعين (شرط الخروج الصامت
      // الآمن عند الكتابة في البحث أثناء وضع العدّ).
      minHeight: 44,
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
    /** v31 (round-39 #1): شريط وضع العدّ — رقيق (نفس موضع شريط
     *  التقدّم) يظهر عند ضغط منتج: تعريف الوضع + زر «عرض الكل»
     *  للرجوع للوضع الكامل. */
    countModeBar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      backgroundColor: c.accentSofter,
      borderWidth: 1,
      borderColor: c.accentSoft,
      borderRadius: radius.md,
      paddingVertical: 10,
      paddingHorizontal: spacing.sm,
      // v32: مطابق لارتفاع miniStats (44px) — انظر أعلاه.
      minHeight: 44,
    },
    countModeText: {
      flex: 1,
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    countModeExit: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 3,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 4,
    },
    countModeExitText: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.micro + 1,
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
    /** v33 (round-41 #6): بطاقة التركيز المضغوطة — أربعة صفوف
     *  بدل ثمانية (طلب التاجر)، حشوات أصغر واسم بسطر واحد وحقل
     *  عدّ متوسط الحجم بجواره زر المطابقة، وشارة الفرق مع أزرار
     *  التنقل في سطر واحد — لا تداخل ولا تشويه. */
    focusCardScroll: {
      flexGrow: 1,
      justifyContent: 'center',
      paddingVertical: spacing.sm,
      paddingBottom: spacing.lg,
    },
    focusCard: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.lg,
      padding: spacing.md,
      gap: spacing.sm,
    },
    focusHeaderRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    focusBadgeWrap: {alignItems: 'flex-start'},
    focusExitBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 3,
      backgroundColor: c.surfaceAlt,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.pill,
      paddingHorizontal: 8,
      paddingVertical: 4,
    },
    focusExitText: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.micro + 1,
    },
    focusName: {
      flex: 1,
      color: c.text,
      fontFamily: fonts.black,
      fontSize: typography.body + 1,
      textAlign: 'right',
    },
    focusMeta: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.small - 1,
      fontVariant: ['tabular-nums'],
      marginTop: -2,
    },
    focusInputRow: {
      flexDirection: 'row',
      alignItems: 'stretch',
      gap: spacing.sm,
    },
    focusInput: {
      flex: 1,
      color: c.text,
      fontFamily: fonts.black,
      fontSize: typography.heading + 2,
      textAlign: 'center',
      backgroundColor: c.surfaceAlt,
      borderWidth: 1.5,
      borderColor: c.accentSoft,
      borderRadius: radius.md,
      paddingVertical: 8,
    },
    focusMatchBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 5,
      backgroundColor: c.successSoft,
      borderWidth: 1,
      borderColor: c.success,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
    },
    focusMatchText: {
      color: c.success,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    focusNavRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    focusNavBtns: {
      flex: 1,
      flexDirection: 'row',
      gap: spacing.sm,
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
