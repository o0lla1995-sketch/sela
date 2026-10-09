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
import {VouchersRepo} from './sila/VouchersRepo';
import {CashRepo} from '../database/repositories/CashRepo';
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
  /** v24 (round-31 #3): الديون التي وُلدت عبر قسائم صِلة بالفترة —
   *  قيمة القسائم المصروفة (مطالبة على المؤسسات حتى التسوية)،
   *  تُعرض في قسم «فواتير الدين بالفترة» كسطرها الخاص. */
  voucherCreditSalesAmount: number;
  /** v24 (round-31 #3): عدد عمليات صرف القسائم بالفترة. */
  voucherCreditSalesCount: number;
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
  /** v32 (round-40 #6): رصيد الخادم POS ككل (كل متاجر التاجر) —
   *  للمعلومية، مقابل الرقم المعتمد من دفاتر هذا المتجر. */
  silaServerPosOutstandingMinor: number;
  /** صِلة (عند الربط، للمعلومية): ديون وُلدت داخل التطبيق. */
  appOriginOutstandingMinor: number;
  /** الربط الفعلي الآن — يخفي كل صفوف صِلة عند فكّه. */
  paired: boolean;
  /** آخر تحديث لأرصدة صِلة (يُعرض فقط عند الربط). */
  lastSyncedAt: string | null;
  /** v20: مبيعات القسائم بالفترة — عدد القسائم المصروفة وقيمتها
   *  الاسمية كما يقرّها الخادم (تطابق «مبيعات الشهر والحملات» في
   *  تطبيق صِلة). */
  voucherSalesCount: number;
  voucherSalesAmount: number;
  /** v20: جزء البضاعة المسجّل كفواتير INV-V (ضمن المبيعات). */
  voucherGoodsAmount: number;
  /** v20: الفرق النقدي الذي دفعه المستحق بالكاشير (سلة > قسيمة). */
  voucherCounterExtraAmount: number;
  /** v20: تسويات الحملات المستلمة بالفترة — المال الذي وصلك من
   *  المؤسسات (خادم صلة هو المرجع: pending + confirmed، ما لم
   *  تُلغَ/تُنازع). v22 (round-28 #2): هذا هو «المستلم» نفسه
   *  الذي تراه في بطاقة كل حملة — يدخل النقد المحصّل بالفترة. */
  campaignSettlementsAmount: number;
  /** v20: المستحق الآن من الحملات (لقطة الخادم). v22 (round-28
   *  #2): يدخل ضمن «الدين القائم الآن» في صفحة التقارير — دين
   *  على المؤسسات حتى التسوية، تماماً كديون الزبائن. */
  campaignDueMinor: number;
  /** v25 (round-32 #3): المصروفات بالفترة — خصم من الخزينة. */
  expensesAmount: number;
  expensesCount: number;
  /** v25: مسحوبات الرصيد بالفترة — خصم من الخزينة. */
  withdrawalsAmount: number;
  withdrawalsCount: number;
  /** v25: الإيداعات النقدية بالفترة — إضافة للخزينة. */
  depositsAmount: number;
  depositsCount: number;
  /** v25: صافي النقد بالفترة بعد المصروفات والمسحوبات. */
  netCashAfterMovements: number;
  /** v26 (round-34 #3): لقطة الآن — النقد المتوقع بالخزينة (نفس
   *  معادلة الرئيسية، لكن بالفترة/الكل حسب الخزينة اللحظية). */
  cashNowMinor: number;
  /** v26 (round-34 #3): إجمالي الخصومات بالفترة — بطاقتها الخاصة
   *  في ملخص المبيعات حتى يرى التاجر «تفاصيل الخصم» صريحة. */
  discountTotal: number;
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
  /** v20: تسويات الحملات المؤكّدة عبر التاريخ (من لقطة الخادم). */
  campaignSettlementsAllTime: number;
  /** v21 (round-27 #3): المستحق الآن من الحملات الفعّالة في
   *  المتجر — مطالبة قائمة (دين) على المؤسسات حتى التسوية،
   *  تُعرض في الخزينة ضمن الديون تماماً كديون صِلة ودفتر
   *  المتجر، وعند كل تسوية مؤكدة تتحول إلى رصيد محصّل. */
  campaignDueAllTime: number;
  /** v21: عدد الحملات الفعّالة (label wording). */
  campaignsActiveCount: number;
  /** v20: فواتير القسائم عبر التاريخ (بضاعة خرجت بلا نقدي كاشير). */
  voucherSalesAllTime: number;
  /** v20: الفرق النقدي الذي دفعه المستحقون بالكاشير عبر التاريخ. */
  voucherCounterExtraAllTime: number;
  /** v25 (round-32 #3): المصروفات المسجّلة عبر التاريخ — خصم من
   *  النقد المتوقع بالخزينة (كل مصروف دُفع من الدرج). */
  expensesAllTime: number;
  /** v25: مسحوبات الرصيد عبر التاريخ — خصم من الخزينة. */
  withdrawalsAllTime: number;
  /** v25: الإيداعات النقدية للخزينة عبر التاريخ — إضافة. */
  depositsAllTime: number;
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
    // v42 (الجولة 50 #3): حبيبية الرسم تتبع الفترة المحددة —
    //  الفترات القصيرة (اليوم/أمس/٧ أيام/الشهر) سلسلة يومية،
    //  وما تجاوز ٦٢ يوماً (مثل «الكل») سلسلة شهرية مجمّعة تبدأ
    //  من أول شهر نشاط؛ قبل هذا كان «الكل» يعدّ الأيام من
    //  2000-01-01 فيقطعه الحارس عند ١٢٠ يوماً ويعرض الرسم أشهراً
    //  خاوية من العقد الماضي بدل مبيعاته الفعلية.
    const spanMs =
      new Date(`${range.to}T00:00:00`).getTime() -
      new Date(`${range.from}T00:00:00`).getTime();
    const spanDays = Math.round(spanMs / 86400000) + 1;
    const dailySeriesPromise =
      spanDays > 62
        ? ReportRepo.monthlySeries(range)
        : ReportRepo.dailySeries(range);
    const [
      summary,
      topByRevenue,
      daily,
      hourly,
      debtSales,
      silaPayments,
      silaTotals,
      // v32 (round-40 #6): دين هذا المتجر من الدفاتر المحلية.
      silaOwnTotals,
      localPayments,
      creditCovered,
      localBook,
      appCollections,
      voucherSales,
      voucherGoods,
      voucherSettlementsReceived,
      campaignTotals,
      cashMovements,
      treasuryNow,
    ] = await Promise.all([
      ReportRepo.summary(range),
      ReportRepo.topProducts(range, 10),
      dailySeriesPromise,
      ReportRepo.hourlySeries(range),
      ReportRepo.debtSalesSummary(range),
      SilaRepo.paymentsInRange(range.from, range.to),
      SilaRepo.customersOutstandingTotal(),
      SilaRepo.storeOwnOutstandingTotal(),
      LocalDebtsRepo.paymentsInRange(range.from, range.to),
      SilaRepo.creditCoveredInRange(range.from, range.to),
      LocalDebtsRepo.totals(),
      // v18 (round-24 #1): money صِلة collected on the store's behalf
      // inside the range — the rows the reconciliation engine writes.
      SilaRepo.appCollectionsInRange(range.from, range.to),
      // v20: the voucher campaigns columns (§2 — sale at face value,
      // goods as INV-V invoices, confirmed settlements as receipts).
      VouchersRepo.okInRange(range.from, range.to),
      ReportRepo.voucherSalesSummary(range),
      // v22 (round-28 #2): the RECEIVED settlements of the period
      // (server truth: pending + confirmed) — «المستلم» الذي يدخل
      // النقد المحصّل بالفترة.
      VouchersRepo.settlementsReceivedInRange(range.from, range.to),
      VouchersRepo.campaignsTotals(),
      // v25 (round-32 #3): the cash-movements ledger of the period.
      CashRepo.totalsFor(range.from, range.to),
      // v26 (round-34 #6): the live «النقد بالخزينة الآن» cell in
      // the الدين القائم الآن grid of the reports page.
      this.treasurySnapshot(),
    ]);

    const topByProfit = [...topByRevenue]
      .sort((a, b) => b.profit - a.profit)
      .slice(0, 10);

    // v20: the voucher sales are inside revenue (INV-V invoices) but
    // only their COUNTER-EXTRA part entered the drawer at sale time —
    // the claim part arrives later with the campaign settlements
    // (§2: التسوية تحصيل). The equation stays balanced either way.
    const salesCash =
      summary.revenue -
      debtSales.amount -
      voucherGoods.goodsAmount +
      voucherSales.counterExtraMinor / 100;
    // v22 (round-28 #2): the period's collected cash includes the
    // campaign settlements RECEIVED in the period (المستلم من
    // المؤسسات) — the user's rule: «المستحق في النقد المحصل
    // بالفترة».
    const collections =
      (silaPayments.minor +
        localPayments.minor +
        appCollections.minor +
        creditCovered +
        voucherSettlementsReceived.minor) /
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
        voucherCreditSalesAmount: voucherSales.valueMinor / 100,
        voucherCreditSalesCount: voucherSales.count,
        cashierSilaAmount: silaPayments.minor / 100,
        localBookAmount: localPayments.minor / 100,
        viaSilaAppAmount: appCollections.minor / 100,
        prepaidAmount: creditCovered / 100,
        localOutstandingMinor: localBook.outstandingMinor,
        localDebtorsCount: localBook.debtorsCount,
        // v32 (round-40 #6): الدين القائم من الدفاتر المحلية
        // للمتجر — فواتير هذا المتجر مطروحاً منها سدادّاته وتحصيلات
        // التطبيق وعكس المرتجعات (تشمل الصفوف غير المرفوعة بعد) —
        // لا أرصدة الخادم المختلطة بفواتير كل متاجر التاجر.
        silaOutstandingMinor: Math.max(0, silaOwnTotals.ownMinor),
        silaDebtorsCount: silaOwnTotals.debtorsCount,
        // v32: أرصدة الخادم للمعلومية (POS ككل + جزء التطبيق).
        silaServerPosOutstandingMinor: silaTotals.posTotalMinor,
        appOriginOutstandingMinor: silaTotals.appTotalMinor,
        paired: isActuallyPaired(),
        lastSyncedAt: silaTotals.lastSyncedAt,
        voucherSalesCount: voucherSales.count,
        voucherSalesAmount: voucherSales.valueMinor / 100,
        voucherGoodsAmount: voucherGoods.goodsAmount,
        voucherCounterExtraAmount: voucherSales.counterExtraMinor / 100,
        campaignSettlementsAmount: voucherSettlementsReceived.minor / 100,
        campaignDueMinor: campaignTotals.dueMinor,
        // v25 (round-32 #3): the drawer's non-sale life of the period.
        expensesAmount: cashMovements.expensesMinor / 100,
        expensesCount: cashMovements.expensesCount,
        withdrawalsAmount: cashMovements.withdrawalsMinor / 100,
        withdrawalsCount: cashMovements.withdrawalsCount,
        depositsAmount: cashMovements.depositsMinor / 100,
        depositsCount: cashMovements.depositsCount,
        netCashAfterMovements:
          salesCash +
          collections +
          cashMovements.depositsMinor / 100 -
          cashMovements.expensesMinor / 100 -
          cashMovements.withdrawalsMinor / 100,
        // v26 (round-34): the live drawer number + the period's
        // discounts (its own KPI — «تفاصيل الخصم بعد الإرجاعات»).
        cashNowMinor: Math.round(treasuryNow.cashTotal * 100),
        discountTotal: summary.discountTotal,
      },
    };
  },

  /** v18 (round-24 #2): the Home treasury — all-time expected cash.
   *  revenue − credit sales + every collection source − the cash
   *  movements ledger (v25: المصروفات والمسحوبات تُخصم والإيداعات
   *  تعود — Loyverse's expected-cash discipline). A repayment
   *  is an asset swap (دين → كاش), NEVER revenue (Square's
   *  house-account double-count rule). */
  async treasurySnapshot(): Promise<TreasurySnapshot> {
    const [
      revenueAllTime,
      debtQueueTotals,
      localBook,
      cashierTotals,
      appTotals,
      voucherGoodsAllTime,
      voucherRedemptionsAllTime,
      campaignTotals,
      returnReversalsTotalMinor,
      cashTotals,
    ] = await Promise.all([
      SaleRepo.allTimeRevenue(),
      SilaRepo.totals(),
      LocalDebtsRepo.totals(),
      SilaRepo.paymentsTotals(),
      SilaRepo.appCollectionsTotals(),
      ReportRepo.voucherSalesSummary({from: '2000-01-01', to: '2999-12-31'}),
      VouchersRepo.okInRange('2000-01-01', '2999-12-31'),
      VouchersRepo.campaignsTotals(),
      // v23 (round-29 #2): the synced-debt reversals — see below.
      SilaRepo.returnReversalsTotal(),
      // v25 (round-32 #3): the cash-movements ledger (expenses /
      // withdrawals / deposits) — the drawer's non-sale life.
      CashRepo.allTimeTotals(),
    ]);
    // Credit sales that never entered the drawer as cash at sale
    // time: the whole INV-D queue (credit-covered parts return via
    // prepaidCovered below) + the local book's unmigrated debts
    // (migrated ones live in the INV-D queue already).
    // v23 (round-29 #2): NET OF RETURNS — a returned local debt
    // already shrank its local_debts row, and a returned PENDING
    // صِلة debt already shrank its queue row; a returned SYNCED
    // صِلة debt keeps its queue amount (the reversal payment row
    // is what cancels it server-side), so the reversal total is
    // subtracted here. The equation stays balanced in every
    // scenario: revenue (net of RET rows) − creditSales (net of
    // returns) + collections (reversals excluded) = the drawer.
    const creditSalesAllTime =
      debtQueueTotals.allMinor / 100 +
      localBook.debtsMinor / 100 -
      returnReversalsTotalMinor / 100;
    const localCollectionsAllTime = localBook.paymentsMinor / 100;
    const cashierCollectionsAllTime = cashierTotals.allMinor / 100;
    const appCollectionsAllTime = appTotals.allMinor / 100;
    const prepaidCoveredAllTime =
      (await SilaRepo.creditCoveredInRange('2000-01-01', '2999-12-31')) / 100;
    // v20: voucher goods left the store inside revenue but only the
    // counter-extra entered the drawer — the claim part arrives with
    // the campaign settlements (server snapshot truth).
    // v22 (round-28 #2): «المستلم» = settled_minor (الخادم هو
    // المرجع — يشمل ما بانتظار تأكيد استلامك، وتظهر لك لقطة
    // الفارق في صفحة القسائم) — يدخل النقد بالخزينة، والمستحق
    // المتبقي (due) يبقى ديناً قائماً على المؤسسات.
    const voucherSalesAllTime = voucherGoodsAllTime.goodsAmount;
    const voucherCounterExtraAllTime =
      voucherRedemptionsAllTime.counterExtraMinor / 100;
    const campaignSettlementsAllTime = campaignTotals.settledMinorTotal / 100;
    return {
      revenueAllTime,
      creditSalesAllTime,
      localCollectionsAllTime,
      cashierCollectionsAllTime,
      appCollectionsAllTime,
      prepaidCoveredAllTime,
      campaignSettlementsAllTime,
      // v21 (round-27 #3): the standing campaign claim — a DEBT on
      // the institutions until each settlement lands (then it turns
      // into received cash above), exactly like صِلة debts.
      campaignDueAllTime: campaignTotals.dueMinor / 100,
      campaignsActiveCount: campaignTotals.campaignsCount,
      voucherSalesAllTime,
      voucherCounterExtraAllTime,
      // v25 (round-32 #3): the drawer's non-sale life — expenses and
      // withdrawals LEAVE the drawer, deposits come back. The
      // expected cash never goes negative: the service layer caps
      // every movement at the drawer's live balance.
      expensesAllTime: cashTotals.expensesMinor / 100,
      withdrawalsAllTime: cashTotals.withdrawalsMinor / 100,
      depositsAllTime: cashTotals.depositsMinor / 100,
      cashTotal:
        revenueAllTime -
        creditSalesAllTime -
        voucherSalesAllTime +
        voucherCounterExtraAllTime +
        localCollectionsAllTime +
        cashierCollectionsAllTime +
        appCollectionsAllTime +
        prepaidCoveredAllTime +
        campaignSettlementsAllTime +
        cashTotals.depositsMinor / 100 -
        cashTotals.expensesMinor / 100 -
        cashTotals.withdrawalsMinor / 100,
    };
  },

  async salesDetail(key: ReportRangeKey, custom?: DateRange) {
    return ReportRepo.salesDetail(rangeFor(key, custom));
  },
};
