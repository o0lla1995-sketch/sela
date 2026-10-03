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
import {stockStateOf} from '../core/types';
import {getJson, setJson, KEYS} from '../storage/storage';
import type {Product} from '../core/types';

interface AlertLedger {
  /** 'productId:day' keys already alerted today. */
  keys: string[];
  day: string;
}

function loadLedger(): AlertLedger {
  const today = localToday();
  const stored = getJson<AlertLedger>(KEYS.stockAlertLedger, {keys: [], day: ''});
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
  async evaluate(): Promise<{low: number; out: number}> {
    if (running) {
      return {low: 0, out: 0};
    }
    running = true;
    try {
      const settings = useSettingsStore.getState().settings;
      if (!settings.stockAlertsEnabled) {
        return {low: 0, out: 0};
      }

      const products = useCatalogStore.getState().products;
      const ledger = loadLedger();
      const ledgerKeys = new Set(ledger.keys);

      let low = 0;
      let out = 0;
      const newKeys: string[] = [];

      for (const product of products) {
        const state = stockStateOf(product, settings.lowStockDefaultThreshold);
        if (state === 'ok') {
          continue;
        }
        const key = `${product.id}:${state}`;
        if (ledgerKeys.has(key)) {
          continue;
        }

        if (state === 'out') {
          out += 1;
          notificationsStore.push(
            'out_of_stock',
            `نفد المخزون: ${product.name}`,
            `الكمية وصلت إلى الصفر — أعد التزويد لكي لا تفقد مبيعات هذا المنتج.`,
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

      if (newKeys.length > 0) {
        ledger.keys = [...ledger.keys, ...newKeys].slice(-400);
        saveLedger(ledger);
      }
      return {low, out};
    } catch (error) {
      // Alerts must never break the business flow.
      return {low: 0, out: 0};
    } finally {
      running = false;
    }
  },

  /** Products currently in a low/out state, worst first (for the dashboard). */
  activeAlerts(limit = 20): {product: Product; state: 'low' | 'out'}[] {
    const settings = useSettingsStore.getState().settings;
    const products = useCatalogStore.getState().products;
    const result: {product: Product; state: 'low' | 'out'}[] = [];
    for (const product of products) {
      const state = stockStateOf(product, settings.lowStockDefaultThreshold);
      if (state !== 'ok') {
        result.push({product, state});
      }
    }
    // Out-of-stock first, then lowest quantity.
    result.sort((a, b) => {
      if ((a.state === 'out') !== (b.state === 'out')) {
        return a.state === 'out' ? -1 : 1;
      }
      return a.product.stock_quantity - b.product.stock_quantity;
    });
    return result.slice(0, limit);
  },
};
