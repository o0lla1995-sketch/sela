/**
 * MMKV instance + typed helpers.
 * Used for: settings, draft cart, invoice counters, diagnostics log
 * and the saved printer address. Everything is synchronous and
 * crash-safe (each accessor swallows and logs serialization errors).
 */
import {MMKV} from 'react-native-mmkv';
import {logDiag} from '../core/diagnostics';

export const storage = new MMKV({id: 'vision-pos-store'});

export const KEYS = {
  settings: 'settings_json_v1',
  cartDraft: 'cart_draft_v2',
  invoiceCounter: 'invoice_counter_v1',
  invoiceDay: 'invoice_day_v1',
  savedPrinter: 'saved_printer_v1',
  seededFlag: 'db_seeded_v1',
  notifications: 'notifications_v1',
  stockAlertLedger: 'stock_alert_ledger_v1',
  schemaVersion: 'db_schema_version',
  themeMode: 'theme_mode_v1',
  licensePayload: 'license_payload_b64_v1',
  licenseSignature: 'license_signature_b64_v1',
  licenseAnchor: 'license_anchor_v1',
  licenseLastVerify: 'license_last_verify_v1',
  licenseRollbackStrikes: 'license_rollback_strikes_v1',
  licenseServerUrl: 'license_server_url_v1',
  licenseDeviceId: 'license_device_id_v1',
  licenseContact: 'license_contact_v1',
  /** v10 (round-16 #4): generation of the embeddings currently in
   *  the database — wiped once when the bundled model changes. */
  embeddingModelVersion: 'embedding_model_version_v1',
} as const;

export function getJson<T>(key: string, fallback: T): T {
  try {
    const raw = storage.getString(key);
    if (raw == null) return fallback;
    return JSON.parse(raw) as T;
  } catch (error) {
    logDiag('storage', `فشل قراءة ${key}: ${String(error)}`, 'warn');
    return fallback;
  }
}

export function setJson(key: string, value: unknown): void {
  try {
    storage.set(key, JSON.stringify(value));
  } catch (error) {
    logDiag('storage', `فشل حفظ ${key}: ${String(error)}`, 'warn');
  }
}

export function getNumber(key: string, fallback: number): number {
  try {
    const value = storage.getNumber(key);
    return value == null ? fallback : value;
  } catch {
    return fallback;
  }
}

export function setNumber(key: string, value: number): void {
  try {
    storage.set(key, value);
  } catch (error) {
    logDiag('storage', `فشل حفظ رقم ${key}: ${String(error)}`, 'warn');
  }
}

export function getString(key: string, fallback: string): string {
  try {
    const value = storage.getString(key);
    return value == null ? fallback : value;
  } catch {
    return fallback;
  }
}

export function setString(key: string, value: string): void {
  try {
    storage.set(key, value);
  } catch (error) {
    logDiag('storage', `فشل حفظ نص ${key}: ${String(error)}`, 'warn');
  }
}
