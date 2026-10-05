/**
 * ReportService — builds the accounting screen data model from the
 * repository aggregations with the range presets required by the spec:
 * (اليوم، الأمس، آخر 7 أيام، هذا الشهر، مخصص).
 */
import {ReportRepo} from '../database/repositories/ReportRepo';
import {SilaRepo} from '../services/sila/SilaRepo';
import {localDateShift, localMonthStart, localToday} from '../core/format';
import type {
  DailyPoint,
  DateRange,
  HourlyPoint,
  ReportRangeKey,
  ReportSummary,
  TopProduct,
} from '../core/types';

export interface ReportBundle {
  range: DateRange;
  summary: ReportSummary;
  topByRevenue: TopProduct[];
  topByProfit: TopProduct[];
  daily: DailyPoint[];
  hourly: HourlyPoint[];
  /** v15 (round-21 #4): the debts & repayments accounting section. */
  debts: {
    /** Credit invoices (INV-D-…) issued in the range — count + total. */
    salesCount: number;
    salesAmount: number;
    /** Repayments collected at the cashier in the range. */
    paymentsCount: number;
    paymentsAmount: number;
    /** Snapshot: STORE-origin outstanding per the صِلة cache. */
    storeOutstandingMinor: number;
    /** Snapshot: Sila-app-origin outstanding (informational only). */
    appOutstandingMinor: number;
    debtorsCount: number;
    /** صِلة pairing status — false hides the Sila-specific rows. */
    paired: boolean;
  };
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

export const ReportService = {
  async loadBundle(
    key: ReportRangeKey,
    custom?: DateRange,
  ): Promise<ReportBundle> {
    const range = rangeFor(key, custom);
    const [summary, topByRevenue, daily, hourly, debtSales, payments, silaTotals] =
      await Promise.all([
        ReportRepo.summary(range),
        ReportRepo.topProducts(range, 10),
        ReportRepo.dailySeries(range),
        ReportRepo.hourlySeries(range),
        ReportRepo.debtSalesSummary(range),
        SilaRepo.paymentsInRange(range.from, range.to),
        SilaRepo.customersOutstandingTotal(),
      ]);

    const topByProfit = [...topByRevenue]
      .sort((a, b) => b.profit - a.profit)
      .slice(0, 10);

    return {
      range,
      summary,
      topByRevenue,
      topByProfit,
      daily,
      hourly,
      debts: {
        salesCount: debtSales.count,
        salesAmount: debtSales.amount,
        paymentsCount: payments.count,
        paymentsAmount: payments.minor / 100,
        storeOutstandingMinor: silaTotals.posTotalMinor,
        appOutstandingMinor: silaTotals.appTotalMinor,
        debtorsCount: silaTotals.debtorsCount,
        paired: silaTotals.lastSyncedAt != null,
      },
    };
  },

  async salesDetail(key: ReportRangeKey, custom?: DateRange) {
    return ReportRepo.salesDetail(rangeFor(key, custom));
  },
};
