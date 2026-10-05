/**
 * ReportService — builds the accounting screen data model from the
 * repository aggregations with the range presets required by the spec:
 * (اليوم، الأمس، آخر 7 أيام، هذا الشهر، مخصص).
 */
import {ReportRepo} from '../database/repositories/ReportRepo';
import {LocalDebtsRepo} from '../database/repositories/LocalDebtsRepo';
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
  /** v15 (round-21 #4) → v17 (round-23 #2): the debts & repayments
   *  accounting section — now split by BOOK (صِلة vs دفتر المتجر)
   *  with the prepaid-credit settlements, so the dashboard mirrors
   *  exactly what the merchant owes and is owed. */
  debts: {
    /** Credit invoices issued in the range — صِلة (INV-D) split from
     *  the store-local book (INV-L) + combined totals. */
    salesCount: number;
    salesAmount: number;
    silaSalesCount: number;
    silaSalesAmount: number;
    localSalesCount: number;
    localSalesAmount: number;
    /** Repayments collected in the range — صِلة uploads split from
     *  the local book receipts. */
    paymentsCount: number;
    paymentsAmount: number;
    silaPaymentsCount: number;
    silaPaymentsAmount: number;
    localPaymentsCount: number;
    localPaymentsAmount: number;
    /** v17 (round-23 #3): prepaid credit absorbed by debt invoices
     *  in the range (sale coverage + migration settlements) — money
     *  the store treats as received. */
    creditCoveredMinor: number;
    /** Snapshot: STORE-origin outstanding per the صِلة cache. */
    storeOutstandingMinor: number;
    /** Snapshot: the local book's outstanding (دفتر المتجر). */
    localOutstandingMinor: number;
    localDebtorsCount: number;
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
    const [
      summary,
      topByRevenue,
      daily,
      hourly,
      debtSales,
      payments,
      silaTotals,
      localPayments,
      creditCovered,
      localBook,
    ] = await Promise.all([
      ReportRepo.summary(range),
      ReportRepo.topProducts(range, 10),
      ReportRepo.dailySeries(range),
      ReportRepo.hourlySeries(range),
      ReportRepo.debtSalesSummary(range),
      SilaRepo.paymentsInRange(range.from, range.to),
      SilaRepo.customersOutstandingTotal(),
      // v17 (round-23 #2): the LOCAL book finally joins the reports.
      LocalDebtsRepo.paymentsInRange(range.from, range.to),
      // v17 (round-23 #3): prepaid-credit settlements in the range.
      SilaRepo.creditCoveredInRange(range.from, range.to),
      LocalDebtsRepo.totals(),
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
        silaSalesCount: debtSales.silaCount,
        silaSalesAmount: debtSales.silaAmount,
        localSalesCount: debtSales.localCount,
        localSalesAmount: debtSales.localAmount,
        paymentsCount: payments.count + localPayments.count,
        paymentsAmount: (payments.minor + localPayments.minor) / 100,
        silaPaymentsCount: payments.count,
        silaPaymentsAmount: payments.minor / 100,
        localPaymentsCount: localPayments.count,
        localPaymentsAmount: localPayments.minor / 100,
        creditCoveredMinor: creditCovered,
        storeOutstandingMinor: silaTotals.posTotalMinor,
        localOutstandingMinor: localBook.outstandingMinor,
        localDebtorsCount: localBook.debtorsCount,
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
