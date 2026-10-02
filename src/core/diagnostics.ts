/**
 * Lightweight in-app diagnostics log — a fixed size ring buffer of the
 * most recent events, mirrored to MMKV so shop owners can show the
 * "سجل النظام" screen to support without a debugger attached.
 */
import {storage} from '../storage/storage';
import {localNow} from './format';

export type DiagLevel = 'info' | 'warn' | 'error';

export interface DiagEntry {
  at: string;
  tag: string;
  message: string;
  level: DiagLevel;
}

const MAX_ENTRIES = 40;
const PERSIST_KEY = 'diag_log_v1';

let entries: DiagEntry[] = [];

function persist(): void {
  try {
    // Persist only the last 20 entries to keep MMKV writes tiny.
    storage.set(PERSIST_KEY, JSON.stringify(entries.slice(0, 20)));
  } catch {
    // Diagnostics must never break the app — swallow storage errors.
  }
}

function load(): void {
  try {
    const raw = storage.getString(PERSIST_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as DiagEntry[];
      if (Array.isArray(parsed)) {
        entries = parsed;
      }
    }
  } catch {
    entries = [];
  }
}

load();

export function logDiag(tag: string, message: string, level: DiagLevel = 'info'): void {
  const entry: DiagEntry = {at: localNow(), tag, message, level};
  entries = [entry, ...entries].slice(0, MAX_ENTRIES);
  if (level === 'error') {
    console.error(`[${tag}] ${message}`);
  } else if (level === 'warn') {
    console.warn(`[${tag}] ${message}`);
  }
  persist();
}

export function getDiagnostics(): DiagEntry[] {
  return entries;
}

export function clearDiagnostics(): void {
  entries = [];
  persist();
}
