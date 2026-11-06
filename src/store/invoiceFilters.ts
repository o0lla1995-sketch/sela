/**
 * store/invoiceFilters.ts — v3.5 (الجولة 91 — كاشير #4): فلاتر
 * أرشيف الفواتير كمنطق خالص قابل للاختبار.
 * ─────────────────────────────────────────────────────────────────
 * طلب التاجر: «تحديث فلاتر الفواتير في سيلا كاشير خصوصاً بعد
 * إضافة المحافظ والبنوك». الفلاتر الجديدة فوق القديمة:
 *  • قناة الدفع (نقدي / بنك / محفظة) — تُبنى رقائقها ديناميكياً
 *    من طرق الدفع المفعّلة عند التاجر (المخزن العالمي الدائم).
 *  • حالة المزامنة (الكل / متزامنة / بانتظار / مرفوضة) — لإيجاد
 *    الفواتير المعلقة والمرافضة بسرعة.
 * والبحث متعدد الأبعاد (رقم/زبون/صنف) والزمن والنوع كما هما.
 */
import type {LocalInvoice, LocalInvoiceItem} from './offline';

export type Period = 'today' | 'week' | 'all';
export type Kind = 'all' | 'sales' | 'returns' | 'debts';
export type SyncStatus = 'all' | 'synced' | 'pending' | 'rejected';

export interface InvoiceFilterState {
  period: Period;
  kind: Kind;
  /** 'all' أو معرّف طريقة الدفع (نقدي أو بنك أو محفظة). */
  pay: string;
  status: SyncStatus;
  query: string;
}

export const INITIAL_FILTERS: InvoiceFilterState = {
  period: 'today',
  kind: 'all',
  pay: 'all',
  status: 'all',
  query: '',
};

function dayKey(date: Date): string {
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** ضمن فترة الزمن (اليوم/7 أيام/الكل). */
export function withinPeriod(createdAt: string, period: Period): boolean {
  if (period === 'all') {
    return true;
  }
  const day = createdAt.slice(0, 10);
  const today = dayKey(new Date());
  if (period === 'today') {
    return day === today;
  }
  const weekAgo = new Date(Date.now() - 6 * 86400000);
  const from = dayKey(weekAgo);
  return day >= from && day <= today;
}

/** البحث متعدد الأبعاد: رقم/زبون/صنف (الأصناف من الذاكرة المؤقتة). */
function matchesQuery(
  invoice: LocalInvoice,
  query: string,
  items: LocalInvoiceItem[] | undefined,
): boolean {
  if (query.length === 0) {
    return true;
  }
  if (invoice.displayNumber.toLowerCase().includes(query)) {
    return true;
  }
  if (
    invoice.syncedNumber != null &&
    invoice.syncedNumber.toLowerCase().includes(query)
  ) {
    return true;
  }
  if ((invoice.customerName ?? '').toLowerCase().includes(query)) {
    return true;
  }
  if (items != null) {
    return items.some(item => item.name.toLowerCase().includes(query));
  }
  return false;
}

/** الفلترة الكاملة — نفس منطق الشاشة سابقاً + القناة والحالة. */
export function filterInvoices(
  invoices: LocalInvoice[],
  filters: InvoiceFilterState,
  itemsByRef: Record<string, LocalInvoiceItem[]>,
): LocalInvoice[] {
  const query = filters.query.trim().toLowerCase();
  return invoices.filter(inv => {
    if (!withinPeriod(inv.createdAt, filters.period)) {
      return false;
    }
    if (filters.kind === 'sales' && inv.kind !== 'sale') {
      return false;
    }
    if (filters.kind === 'returns' && inv.kind !== 'return') {
      return false;
    }
    if (
      filters.kind === 'debts' &&
      !(inv.kind === 'sale' && inv.payKind === 'debt')
    ) {
      return false;
    }
    // v3.5: قناة الدفع — الفاتورة تحمل payMethod (cash أو بنك/محفظة).
    if (filters.pay !== 'all') {
      const invPay = inv.payMethod || 'cash';
      if (invPay !== filters.pay) {
        return false;
      }
    }
    // v3.5: حالة المزامنة.
    if (filters.status !== 'all' && inv.status !== filters.status) {
      return false;
    }
    return matchesQuery(inv, query, itemsByRef[inv.ref]);
  });
}
