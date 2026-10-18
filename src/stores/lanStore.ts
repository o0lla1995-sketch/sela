/**
 * lanStore — v58 (الجولة 62): حالة خادم الكاشير على الشبكة المحلية.
 * ─────────────────────────────────────────────────────────────────
 * يعرض للتطبيق: هل الخادم يعمل؟ على أي منفذ؟ آخر خطأ؟ وعدّاد
 * الطلبات المنجزة (نبض حي بسيط). شاشة الكاشير تستقصي الجداول
 * (lan_cashiers/lan_devices) مباشرة عند الفتح وكل بضع ثوانٍ.
 */
import {create} from 'zustand';

export interface LanState {
  running: boolean;
  starting: boolean;
  port: number;
  lastError: string | null;
  /** طلبات أُنجزت منذ آخر تشغيل — يرتفع مع كل طلب كاشير. */
  requestCount: number;
  setRunning: (running: boolean) => void;
  setStarting: (starting: boolean) => void;
  setPort: (port: number) => void;
  setError: (error: string | null) => void;
  bumpRequests: () => void;
}

export const useLanStore = create<LanState>(set => ({
  running: false,
  starting: false,
  port: 8950,
  lastError: null,
  requestCount: 0,
  setRunning: running => set({running}),
  setStarting: starting => set({starting}),
  setPort: port => set({port}),
  setError: error => set({lastError: error}),
  bumpRequests: () =>
    set(state => ({requestCount: state.requestCount + 1})),
}));
