/**
 * ReportService — builds the accounting screen data model from the
 * repository aggregations with the range presets required by the spec:
 * (اليوم، الأمس، آخر 7 أيام، هذا الشهر، مخصص).
 */
import {ReportRepo} from '../database/repositories/ReportRepo';
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
    case 'custom':
      return custom ?? {from: today, to: today};
    default:
      return {from: today, to: today};
  }
}

export const ReportService = {
  async loadBundle(key: ReportRangeKey, custom?: DateRange): Promise<ReportBundle> {
    const range = rangeFor(key, custom);
    const [summary, topByRevenue, daily, hourly] = await Promise.all([
      ReportRepo.summary(range),
      ReportRepo.topProducts(range, 10),
      ReportRepo.dailySeries(range),
      ReportRepo.hourlySeries(range),
    ]);

    const topByProfit = [...topByRevenue].sort((a, b) => b.profit - a.profit).slice(0, 10);

    return {range, summary, topByRevenue, topByProfit, daily, hourly};
  },

  async salesDetail(key: ReportRangeKey, custom?: DateRange) {
    return ReportRepo.salesDetail(rangeFor(key, custom));
  },
};
