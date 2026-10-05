/**
 * ReportService — builds the accounting screen data model from the
 * repository aggregations with the range presets required by the spec:
 * (اليوم، الأمس، آخر 7 أيام، هذا الشهر، الكل).
 *
 * v18 (round-24 #2/#3): the debts bundle became the ONE clean «النقد
 * والديون» card model — net figures first, Sila-specific rows only
 * when the device is ACTUALLY paired (pairing != null, not «the cache
 * was ever synced»). `treasurySnapshot()` feeds the Home dashboard's
 * single expected-cash number (sales cash + every collection source —
 * cashier, local book, Sila app, prepaid credit — Square's
 * house-account rule: a repayment is an asset swap, never revenue).
 */
import {ReportRepo} from '../database/repositories/ReportRepo';
import {LocalDebtsRepo} from '../database/repositories/LocalDebtsRepo';
import {SaleRepo} from '../database/repositories/SaleRepo';
import {SilaRepo} from './sila/SilaRepo';
import {useSilaStore} from '../stores/silaStore';
import {localDateShift, localMonthStart, localToday} from '../core/format';
import type {
  DailyPoint,
  DateRange,
  HourlyPoint,
  ReportRangeKey,
  ReportSummary,
  TopProduct,
} from '../core/types';

/** v18 (round-24 #2): the ONE cash & debts card on the reports page —
 *  net figures the merchant reads in five seconds, with every Sila
 *  row gated behind an ACTIVE pairing. */
export interface CashDebtsBundle {
  /** النقد المحصّل بالفترة = المبيعات النقدية + كل المقبوضات. */
  collected: number;
  /** الجزء النقدي من مبيعات الفترة (الإيراد − فواتير الدين). */
  salesCash: number;
  /** كل المقبوضات بالفترة (كاشير + دفتر + تطبيق صِلة + رصيد مسبق). */
  collections: number;
  /** فواتير الدين بالفترة — إجمالي واحد ثم الانقسام. */
  creditSalesAmount: number;
  creditSalesCount: number;
  /** الجزء المسجّل في دفتر المتجر (INV-L). */
  localCreditSalesAmount: number;
  /** الجزء المسجّل عبر صِلة (INV-D). */
  silaCreditSalesAmount: number;
  /** تفكيك المقبوضات (بالشيكل) — صفوف صِلة تُعرض عند الربط فقط. */
  /** سدادّات استلمها الكاشير لفواتير صِلة. */
  cashierSilaAmount: number;
  /** سدادّات دفتر المتجر. */
  localBookAmount: number;
  /** v18 (round-24 #1): تحصيلات عبر تطبيق صِلة (سدد الزبون من التطبيق). */
  viaSilaAppAmount: number;
  /** تسويات الرصيد المسبق (صِلة). */
  prepaidAmount: number;
  /** لقطة الآن: الدين القائم. */
  localOutstandingMinor: number;
  localDebtorsCount: number;
  /** صِلة (عند الربط): جزء فواتير متجري القائم + غير المرفوع بعد. */
  silaOutstandingMinor: number;
  silaDebtorsCount: number;
  /** صِلة (عند الربط، للمعلومية): ديون وُلدت داخل التطبيق. */
  appOriginOutstandingMinor: number;
  /** الربط الفعلي الآن — يخفي كل صفوف صِلة عند فكّه. */
  paired: boolean;
  /** آخر تحديث لأرصدة صِلة (يُعرض فقط عند الربط). */
  lastSyncedAt: string | null;
}

export interface ReportBundle {
  range: DateRange;
  summary: ReportSummary;
  topByRevenue: TopProduct[];
  topByProfit: TopProduct[];
  daily: DailyPoint[];
  hourly: HourlyPoint[];
  /** v18: the redesigned النقد والديون model (replaces the v17
   *  `debts` wall — «صفحة التقارير مقززة» is gone). */
  cash: CashDebtsBundle;
}

/** v18 (round-24 #2): the Home treasury breakdown — ONE expected-cash
 *  number with its sources, all-time so the drawer matches reality
 *  from the store's first invoice (Loyverse's expected-cash formula
 *  + صِلة collections). */
export interface TreasurySnapshot {
  /** كل المبيعات عبر التاريخ (نقد + دين). */
  revenueAllTime: number;
  /** فواتير الدين عبر التاريخ (لم تدخل خزينة كنقد عند البيع). */
  creditSalesAllTime: number;
  /** تحصيلات دفتر المتجر عبر التاريخ. */
  localCollectionsAllTime: number;
  /** سدادّات استلمها الكاشير لفواتير صِلة. */
  cashierCollectionsAllTime: number;
  /** v18 (round-24 #1): تحصيلات عبر تطبيق صِلة. */
  appCollectionsAllTime: number;
  /** تسويات الرصيد المسبق عبر التاريخ. */
  prepaidCoveredAllTime: number;
  /** النقد المتوقع في الخزينة الآن. */
  cashTotal: number;
}

export function rangeFor(key: ReportRangeKey, custom?: DateRange): DateRange {
  const today = localToday();
  switch (key) {
    case 'today':
      return {from: today, to: today};
    case 'yesterday': {
      const yesterday = localDateShift(-1);
      return {from: yesterday, to: yesterday};
    }
    case 'last7':
      return {from: localDateShift(-6), to: today};
    case 'thisMonth':
      return {from: localMonthStart(), to: today};
    case 'all':
      // v15 (round-21 #2): the whole history — restored-backup
      // invoices are part of the store's accounting.
      return {from: '2000-01-01', to: today};
    case 'custom':
      return custom ?? {from: today, to: today};
    default:
      return {from: today, to: today};
  }
}

/** v18: pairing truth — the cache may hold balances from a past
 *  pairing; the merchant's rule is «إحصائيات صِلة تظهر فقط عند
 *  تفعيل الربط», so the gate is the LIVE pairing, not history. */
function isActuallyPaired(): boolean {
  return useSilaStore.getState().pairing != null;
}

export const ReportService = {
  async loadBundle(
    key: ReportRangeKey,
    custom?: DateRange,
  ): Promise<ReportBundle> {
    const range = rangeFor(key, custom);
    const [
      summary,
      topByRevenue,
      daily,
      hourly,
      debtSales,
      silaPayments,
      silaTotals,
      localPayments,
      creditCovered,
      localBook,
      appCollections,
      debtQueueTotals,
    ] = await Promise.all([
      ReportRepo.summary(range),
      ReportRepo.topProducts(range, 10),
      ReportRepo.dailySeries(range),
      ReportRepo.hourlySeries(range),
      ReportRepo.debtSalesSummary(range),
      SilaRepo.paymentsInRange(range.from, range.to),
      SilaRepo.customersOutstandingTotal(),
      LocalDebtsRepo.paymentsInRange(range.from, range.to),
      SilaRepo.creditCoveredInRange(range.from, range.to),
      LocalDebtsRepo.totals(),
      // v18 (round-24 #1): money صِلة collected on the store's behalf
      // inside the range — the rows the reconciliation engine writes.
      SilaRepo.appCollectionsInRange(range.from, range.to),
      SilaRepo.totals(),
    ]);

    const topByProfit = [...topByRevenue]
      .sort((a, b) => b.profit - a.profit)
      .slice(0, 10);

    const salesCash = summary.revenue - debtSales.amount;
    const collections =
      (silaPayments.minor +
        localPayments.minor +
        appCollections.minor +
        creditCovered) /
      100;

    return {
      range,
      summary,
      topByRevenue,
      topByProfit,
      daily,
      hourly,
      cash: {
        collected: salesCash + collections,
        salesCash,
        collections,
        creditSalesAmount: debtSales.amount,
        creditSalesCount: debtSales.count,
        localCreditSalesAmount: debtSales.localAmount,
        silaCreditSalesAmount: debtSales.silaAmount,
        cashierSilaAmount: silaPayments.minor / 100,
        localBookAmount: localPayments.minor / 100,
        viaSilaAppAmount: appCollections.minor / 100,
        prepaidAmount: creditCovered / 100,
        localOutstandingMinor: localBook.outstandingMinor,
        localDebtorsCount: localBook.debtorsCount,
        // Server pos part + this device's not-yet-uploaded debt rows
        // (store-origin by definition — never understate offline).
        silaOutstandingMinor:
          silaTotals.posTotalMinor + debtQueueTotals.pendingMinor,
        silaDebtorsCount:
          silaTotals.debtorsCount +
          (debtQueueTotals.pendingCount > 0 ? 1 : 0),
        appOriginOutstandingMinor: silaTotals.appTotalMinor,
        paired: isActuallyPaired(),
        lastSyncedAt: silaTotals.lastSyncedAt,
      },
    };
  },

  /** v18 (round-24 #2): the Home treasury — all-time expected cash.
   *  revenue − credit sales + every collection source. A repayment
   *  is an asset swap (دين → كاش), NEVER revenue (Square's
   *  house-account double-count rule). */
  async treasurySnapshot(): Promise<TreasurySnapshot> {
    const [
      revenueAllTime,
      debtQueueTotals,
      localBook,
      cashierTotals,
      appTotals,
    ] = await Promise.all([
      SaleRepo.allTimeRevenue(),
      SilaRepo.totals(),
      LocalDebtsRepo.totals(),
      SilaRepo.paymentsTotals(),
      SilaRepo.appCollectionsTotals(),
    ]);
    // Credit sales that never entered the drawer as cash at sale
    // time: the whole INV-D queue (credit-covered parts return via
    // prepaidCovered below) + the local book's unmigrated debts
    // (migrated ones live in the INV-D queue already).
    const creditSalesAllTime =
      debtQueueTotals.allMinor / 100 + localBook.debtsMinor / 100;
    const localCollectionsAllTime = localBook.paymentsMinor / 100;
    const cashierCollectionsAllTime = cashierTotals.allMinor / 100;
    const appCollectionsAllTime = appTotals.allMinor / 100;
    const prepaidCoveredAllTime =
      (await SilaRepo.creditCoveredInRange('2000-01-01', '2999-12-31')) / 100;
    return {
      revenueAllTime,
      creditSalesAllTime,
      localCollectionsAllTime,
      cashierCollectionsAllTime,
      appCollectionsAllTime,
      prepaidCoveredAllTime,
      cashTotal:
        revenueAllTime -
        creditSalesAllTime +
        localCollectionsAllTime +
        cashierCollectionsAllTime +
        appCollectionsAllTime +
        prepaidCoveredAllTime,
    };
  },

  async salesDetail(key: ReportRangeKey, custom?: DateRange) {
    return ReportRepo.salesDetail(rangeFor(key, custom));
  },
};
