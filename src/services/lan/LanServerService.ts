/**
 * LanServerService — v58 (الجولة 62): صلة التشغيل بين غلاف Kotlin
 * الأصلي (LanServerModule) ومنطق البروتوكول النقي (LanHandlers).
 * ─────────────────────────────────────────────────────────────────
 * start(port) يفتح الخادم ويشترك في حدث `lanRequest` القادم من
 * الأصلي؛ كل طلب يُمرَّر إلى handleLanRequest ثم يُعاد رده إلى
 * الأصلي عبر respond(id, status, body). stop() يغلق الخادم ويلغي
 * الاشتراك. ensureStarted() يستعمل إعدادات التاجر (تشغيل تلقائي
 * عند الإقلاع) — وهو المستدعى من App.tsx.
 *
 * منطق العمل كله في TS: نفس InvoiceService ونفس المعاملات الذرية
 * التي تمر منها مبيعات نقطة البيع نفسها — فالخزينة والديون
 * والمخزون تتحدث لحظياً وبلا أي مسار مزامنة موازٍ.
 */
import {DeviceEventEmitter} from 'react-native';
import {LanServerNative} from '../../native/nativeBridge';
import {
  handleLanRequest,
  setLanEventSink,
  type LanEvent,
} from './LanHandlers';
import {useLanStore} from '../../stores/lanStore';
import {useSettingsStore} from '../../stores/settingsStore';
import {notificationsStore} from '../../stores/notificationsStore';
import {formatMoney} from '../../core/format';
import {LAN_DEFAULT_PORT} from '../../core/config';

let subscription: {remove: () => void} | null = null;
let currentPort = LAN_DEFAULT_PORT;

// ── v59 (الجولة 63): أحداث الخادم الحية → مركز الإشعارات +
// إشعار نظام أندرويد. المدير يرى كل عملية كاشير لحظياً (بيع/مرتجع/
// جهاز جديد ينتظر موافقته) دون أن يفتح شاشة الكاشير.
function lanEventToNotification(event: LanEvent): void {
  try {
    if (event.kind === 'sale') {
      const title = event.offline
        ? `كاشير: بيع بعد انقطاع — ${event.cashierName}`
        : `بيع من كاشير — ${event.cashierName}`;
      const body = `فاتورة ${event.invoiceNumber} · ${event.itemCount} صنف · ${formatMoney(
        event.total,
      )}${event.debt ? ' · دين' : ''}`;
      notificationsStore.push('cashier', title, body, {system: true});
    } else if (event.kind === 'return') {
      const title = event.isExchange
        ? `استبدال من كاشير — ${event.cashierName}`
        : `مرتجع من كاشير — ${event.cashierName}`;
      const body = `إشعار ${event.returnNumber} · ${formatMoney(
        event.refundMinor / 100,
      )}${event.isExchange ? ' · استبدال' : ''}`;
      notificationsStore.push('cashier', title, body, {system: true});
    } else if (event.kind === 'device_pending') {
      notificationsStore.push(
        'cashier',
        'جهاز كاشير ينتظر موافقتك',
        `${event.cashierName} · ${event.deviceLabel}${
          event.ip ? ` · ${event.ip}` : ''
        } — افتح شاشة الكاشير للسماح أو الرفض`,
        {system: true},
      );
    } else if (event.kind === 'login') {
      notificationsStore.push(
        'cashier',
        `دخول كاشير — ${event.cashierName}`,
        `${event.deviceLabel} سجّل الدخول الآن`,
      );
    }
  } catch {
    // إشعار فاشل لا يمس العملية نفسها أبداً.
  }
}
setLanEventSink(lanEventToNotification);

// v58: اسم المتجر في ردود بث الاستكشاف يبقى محدّثاً مع الإعدادات —
// اشتراك وحيد على مستوى الوحدة، بلا أي اشتراكات متكررة.
let lastStoreName: string | null = null;
useSettingsStore.subscribe(state => {
  const name = state.settings.storeName;
  if (name !== lastStoreName) {
    lastStoreName = name;
    LanServerNative?.setStoreName(name);
  }
});

/** تحويل نص الاستعلام (?a=1&b=2) إلى خريطة. */
function parseQuery(raw: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) {
    return out;
  }
  for (const pair of raw.split('&')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    try {
      out[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(
        pair.slice(eq + 1),
      );
    } catch {
      out[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
  }
  return out;
}

export const LanServerService = {
  /** هل الخادم يعمل الآن (بحسب حالة المتجر). */
  isRunning(): boolean {
    return useLanStore.getState().running;
  },

  /** تشغيل الخادم على منفذ محدد وباسم المتجر الحالي. */
  async start(port?: number): Promise<boolean> {
    const store = useLanStore.getState();
    if (store.running || store.starting) {
      return true;
    }
    const settings = useSettingsStore.getState().settings;
    const chosenPort = port ?? settings.lanPort ?? LAN_DEFAULT_PORT;
    if (LanServerNative == null) {
      useLanStore.getState().setError('وحدة الشبكة غير متاحة على هذا الجهاز');
      return false;
    }
    useLanStore.getState().setStarting(true);
    try {
      await LanServerNative.start(chosenPort, settings.storeName);
      currentPort = chosenPort;
      useLanStore.getState().setPort(chosenPort);
      useLanStore.getState().setRunning(true);
      useLanStore.getState().setError(null);

      if (subscription == null) {
        subscription = DeviceEventEmitter.addListener(
          'lanRequest',
          (payload: {
            id: string;
            method: string;
            path: string;
            query?: string;
            body?: string;
            auth?: string | null;
            ip?: string | null;
          }) => {
            useLanStore.getState().bumpRequests();
            handleLanRequest({
              id: payload.id,
              method: payload.method,
              path: payload.path,
              query: parseQuery(payload.query),
              body: payload.body ?? '',
              auth: payload.auth ?? null,
              ip: payload.ip ?? null,
            })
              .then(response => {
                LanServerNative?.respond(
                  payload.id,
                  response.status,
                  response.body,
                );
              })
              .catch(error => {
                const message =
                  error instanceof Error
                    ? error.message
                    : 'خطأ غير متوقع في الخادم';
                LanServerNative?.respond(
                  payload.id,
                  400,
                  JSON.stringify({ok: false, error: message}),
                );
              });
          },
        );
      }
      return true;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'تعذر تشغيل خادم الكاشير';
      useLanStore.getState().setError(message);
      return false;
    } finally {
      useLanStore.getState().setStarting(false);
    }
  },

  /** إيقاف الخادم. */
  async stop(): Promise<void> {
    try {
      await LanServerNative?.stop();
    } catch {
      // الإيقاف لا يفشل أبداً أمام المستخدم.
    }
    subscription?.remove();
    subscription = null;
    useLanStore.getState().setRunning(false);
  },

  /** الإقلاع وفق إعدادات التاجر — يشغّل الخادم إن كان مفعّلاً. */
  async ensureStarted(): Promise<void> {
    const settings = useSettingsStore.getState().settings;
    if (settings.lanServerEnabled) {
      await this.start();
    }
  },

  /** تحديث اسم المتجر في ردود بث الاستكشاف (بعد تعديل الإعدادات). */
  refreshStoreName(): void {
    const settings = useSettingsStore.getState().settings;
    LanServerNative?.setStoreName(settings.storeName);
  },

  /** المنفذ الحالي (للعرض في واجهة المدير). */
  port(): number {
    return currentPort;
  },
};
