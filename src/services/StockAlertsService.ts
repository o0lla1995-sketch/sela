/**
 * StockAlertsService — low-stock & out-of-stock detection.
 * ─────────────────────────────────────────────────────────────────
 * Runs after every catalog refresh and after every completed sale.
 * Deduplicates per product per day so the center never spams.
 * Out-of-stock alerts also go out as Android system notifications.
 */
import {useCatalogStore} from '../stores/catalogStore';
import {useSettingsStore} from '../stores/settingsStore';
import {notificationsStore} from '../stores/notificationsStore';
import {localToday} from '../core/format';
import {stockStateOf, expiryStateOf, daysUntilExpiry} from '../core/types';
import {getJson, setJson, KEYS} from '../storage/storage';
import type {Product} from '../core/types';

/** v32 (round-40 #3): كل حالات التنبيه — مخزون وصلاحية معاً. */
export type AlertState = 'out' | 'low' | 'expired' | 'expiring';

/** v32: تنبيه واحد في القائمة — الحالة + الأيام المتبقية للصلاحية. */
export interface StockAlert {
  product: Product;
  state: AlertState;
  /** موجب = باقٍ، سالب = منتهي منذ N يوم (حالات الصلاحية فقط). */
  days?: number;
}

/** v32: ترتيب الخطورة — منتهي ← نفد ← قرب انتهاء ← منخفض. */
const STATE_RANK: Record<AlertState, number> = {
  expired: 0,
  out: 1,
  expiring: 2,
  low: 3,
};

interface AlertLedger {
  /** 'productId:day' keys already alerted today. */
  keys: string[];
  day: string;
}

function loadLedger(): AlertLedger {
  const today = localToday();
  const stored = getJson<AlertLedger>(KEYS.stockAlertLedger, {
    keys: [],
    day: '',
  });
  if (stored.day !== today) {
    return {keys: [], day: today};
  }
  return stored;
}

function saveLedger(ledger: AlertLedger): void {
  setJson(KEYS.stockAlertLedger, ledger);
}

let running = false;

export const StockAlertsService = {
  /**
   * Evaluates every product's stock and pushes notifications for
   * newly-discovered low/out-of-stock states. Safe to call often.
   */
  async evaluate(): Promise<{
    low: number;
    out: number;
    expired: number;
    expiring: number;
  }> {
    if (running) {
      return {low: 0, out: 0, expired: 0, expiring: 0};
    }
    running = true;
    try {
      const settings = useSettingsStore.getState().settings;
      if (!settings.stockAlertsEnabled) {
        return {low: 0, out: 0, expired: 0, expiring: 0};
      }

      const products = useCatalogStore.getState().products;
      const ledger = loadLedger();
      const ledgerKeys = new Set(ledger.keys);

      let low = 0;
      let out = 0;
      let expired = 0;
      let expiring = 0;
      const newKeys: string[] = [];

      for (const product of products) {
        const state = stockStateOf(product, settings.lowStockDefaultThreshold);
        if (state !== 'ok') {
          const key = `${product.id}:${state}`;
          if (!ledgerKeys.has(key)) {
            if (state === 'out') {
              out += 1;
              notificationsStore.push(
                'out_of_stock',
                `نفد المخزون: ${product.name}`,
                'الكمية وصلت إلى الصفر — أعد التزويد لكي لا تفقد مبيعات هذا المنتج.',
                {productId: product.id, system: true},
              );
            } else {
              low += 1;
              notificationsStore.push(
                'low_stock',
                `مخزون منخفض: ${product.name}`,
                `الكمية المتبقية ${product.stock_quantity} قطعة فقط — راجع التزويد.`,
                {productId: product.id, system: false},
              );
            }
            newKeys.push(key);
          }
        }

        // v32 (round-40 #3): صلاحية المنتج — منتهي يصدر إشعار نظام
        // (مثل النفاد تماماً) وقرب الانتهاء إشعار مركز فقط، وكلاهما
        // مرة واحدة في اليوم لكل منتج (نفس دفتر المخصومات).
        const expiry = expiryStateOf(
          product.expiry_date,
          settings.expiryAlertDays,
        );
        if (expiry !== 'ok') {
          const key = `${product.id}:${expiry}`;
          if (!ledgerKeys.has(key)) {
            const days = daysUntilExpiry(product.expiry_date!);
            if (expiry === 'expired') {
              expired += 1;
              notificationsStore.push(
                'expiry',
                `منتهي الصلاحية: ${product.name}`,
                days === 0
                  ? 'تنتهي صلاحيته اليوم — أخرجه من الرف أو خصّمه قبل أن يصل للزبون.'
                  : `انتهت صلاحيته منذ ${Math.abs(
                      days,
                    )} يوم — أخرجه من الرف أو خصّمه قبل أن يصل للزبون.`,
                {productId: product.id, system: true},
              );
            } else {
              expiring += 1;
              notificationsStore.push(
                'expiry',
                `قرب انتهاء الصلاحية: ${product.name}`,
                days === 0
                  ? 'تنتهي صلاحيته اليوم — رتّب عرضاً أو خصماً لتصريفه.'
                  : `باقي ${days} يوم على انتهاء صلاحيته — رتّب عرضاً أو خصماً لتصريفه.`,
                {productId: product.id, system: false},
              );
            }
            newKeys.push(key);
          }
        }
      }

      if (newKeys.length > 0) {
        ledger.keys = [...ledger.keys, ...newKeys].slice(-400);
        saveLedger(ledger);
      }
      return {low, out, expired, expiring};
    } catch (error) {
      // Alerts must never break the business flow.
      return {low: 0, out: 0, expired: 0, expiring: 0};
    } finally {
      running = false;
    }
  },

  /** v32: المنتجات في حالة تنبيه (مخزون أو صلاحية)، الأسوأ أولاً.
   *  الترتيب: منتهي الصلاحية ← نفد المخزون ← قرب الانتهاء ← منخفض،
   *  وداخل كل حالة: الأقل كمية / الأقرب انتهاءً أولاً. */
  activeAlerts(limit = 20): StockAlert[] {
    const settings = useSettingsStore.getState().settings;
    const products = useCatalogStore.getState().products;
    const result: StockAlert[] = [];
    for (const product of products) {
      const state = stockStateOf(product, settings.lowStockDefaultThreshold);
      if (state !== 'ok') {
        result.push({product, state});
      }
      const expiry = expiryStateOf(
        product.expiry_date,
        settings.expiryAlertDays,
      );
      if (expiry !== 'ok') {
        result.push({
          product,
          state: expiry,
          days: daysUntilExpiry(product.expiry_date!),
        });
      }
    }
    result.sort((a, b) => {
      const rankDiff = STATE_RANK[a.state] - STATE_RANK[b.state];
      if (rankDiff !== 0) {
        return rankDiff;
      }
      if (a.state === 'expired' || a.state === 'expiring') {
        return (a.days ?? 0) - (b.days ?? 0);
      }
      return a.product.stock_quantity - b.product.stock_quantity;
    });
    return result.slice(0, limit);
  },
};
