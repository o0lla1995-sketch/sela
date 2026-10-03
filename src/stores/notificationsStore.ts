/**
 * Notifications store — in-app notification center.
 * ─────────────────────────────────────────────────────────────────
 * Persists the latest 100 notifications in MMKV. Critical stock
 * alerts are additionally posted as Android system notifications via
 * the native SelaNotifications module.
 */
import {create} from 'zustand';
import {getJson, setJson, KEYS} from '../storage/storage';
import {localNow} from '../core/format';
import {logDiag} from '../core/diagnostics';
import {SelaNotificationsNative} from '../native/nativeBridge';
import type {AppNotification, NotificationKind} from '../core/types';

const MAX_ITEMS = 100;

interface NotificationsState {
  items: AppNotification[];
  unreadCount: number;
  /** Fires a push into the center (+ optional system notification). */
  push: (
    kind: NotificationKind,
    title: string,
    body: string,
    options?: {productId?: number; system?: boolean},
  ) => AppNotification;
  markAllRead: () => void;
  markRead: (id: string) => void;
  clearAll: () => void;
}

function loadInitial(): AppNotification[] {
  const stored = getJson<AppNotification[]>(KEYS.notifications, []);
  return Array.isArray(stored) ? stored.slice(0, MAX_ITEMS) : [];
}

function persist(items: AppNotification[]): void {
  setJson(KEYS.notifications, items.slice(0, MAX_ITEMS));
}

function recount(items: AppNotification[]): number {
  let count = 0;
  for (const item of items) {
    if (!item.read) {
      count += 1;
    }
  }
  return count;
}

/** Posts a local Android notification (best-effort, never throws). */
async function postSystemNotification(
  notification: AppNotification,
): Promise<void> {
  try {
    if (SelaNotificationsNative == null) {
      return;
    }
    await SelaNotificationsNative.show(
      (Math.abs(hashCode(notification.id)) % 100000) + 1,
      notification.title,
      notification.body,
      notification.kind === 'out_of_stock' || notification.kind === 'low_stock'
        ? 'stock'
        : notification.kind,
    );
  } catch (error) {
    logDiag(
      'notifications',
      `فشل إرسال إشعار النظام: ${
        error instanceof Error ? error.message : String(error)
      }`,
      'warn',
    );
  }
}

function hashCode(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i++) {
    h = (Math.imul(31, h) + value.charCodeAt(i)) | 0;
  }
  return h;
}

export const useNotificationsStore = create<NotificationsState>((set, get) => ({
  items: loadInitial(),
  unreadCount: recount(loadInitial()),

  push: (kind, title, body, options) => {
    const notification: AppNotification = {
      id: `${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      kind,
      title,
      body,
      createdAt: localNow(),
      read: false,
      productId: options?.productId,
    };
    const items = [notification, ...get().items].slice(0, MAX_ITEMS);
    persist(items);
    set({items, unreadCount: recount(items)});
    if (options?.system) {
      void postSystemNotification(notification);
    }
    return notification;
  },

  markAllRead: () => {
    const items = get().items.map(item =>
      item.read ? item : {...item, read: true},
    );
    persist(items);
    set({items, unreadCount: 0});
  },

  markRead: id => {
    const items = get().items.map(item =>
      item.id === id ? {...item, read: true} : item,
    );
    persist(items);
    set({items, unreadCount: recount(items)});
  },

  clearAll: () => {
    persist([]);
    set({items: [], unreadCount: 0});
  },
}));

/** Imperative accessor for services. */
export const notificationsStore = {
  push: (
    kind: NotificationKind,
    title: string,
    body: string,
    options?: {productId?: number; system?: boolean},
  ) => useNotificationsStore.getState().push(kind, title, body, options),
};
