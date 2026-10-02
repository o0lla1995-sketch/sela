/**
 * Toast store — tiny in-app notification system (no external deps).
 */
import {create} from 'zustand';

export type ToastKind = 'success' | 'error' | 'info';

export interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
}

interface ToastState {
  toasts: ToastItem[];
  show: (message: string, kind?: ToastKind, durationMs?: number) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToastStore = create<ToastState>(set => ({
  toasts: [],
  show: (message, kind = 'info', durationMs = 2600) => {
    const id = nextId;
    nextId += 1;
    set(state => ({toasts: [...state.toasts, {id, message, kind}]}));
    setTimeout(() => {
      set(state => ({toasts: state.toasts.filter(toast => toast.id !== id)}));
    }, durationMs);
  },
  dismiss: id =>
    set(state => ({toasts: state.toasts.filter(toast => toast.id !== id)})),
}));

/** Imperative helper usable from services. */
export function toast(message: string, kind: ToastKind = 'info'): void {
  useToastStore.getState().show(message, kind);
}
