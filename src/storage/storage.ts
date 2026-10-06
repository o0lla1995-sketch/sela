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
  /** v14 (round-20 #1/#3): debt sales carry their OWN numbering
   *  series (INV-D-…) — a separate counter so credit invoices can
   *  never collide with cash invoices, on this device or on the
   *  صِلة server (which remembers every pos_invoice_ref forever). */
  debtInvoiceCounter: 'debt_invoice_counter_v1',
  debtInvoiceDay: 'debt_invoice_day_v1',
  /** v15 (round-21 #3): the repayment receipt series RCP-YYYYMMDD-NNNN
   *  — its own counter/day pair, same never-backwards discipline as
   *  invoices (§3.1 pos_receipt_ref فريد لكل متجر). */
  paymentReceiptCounter: 'payment_receipt_counter_v1',
  paymentReceiptDay: 'payment_receipt_day_v1',
  /** v16 (round-22 #4): the LOCAL debt-book series — INV-L-… debts and
   *  RCP-L-… repayments never leave this device (a separate series so
   *  a future migration to صِلة can take fresh INV-D numbers without
   *  any collision). */
  localDebtCounter: 'local_debt_counter_v1',
  localDebtDay: 'local_debt_day_v1',
  localReceiptCounter: 'local_receipt_counter_v1',
  localReceiptDay: 'local_receipt_day_v1',
  /** v23 (round-29 #2): the RETURNS series RET-YYYYMMDD-NNNN — its
   *  own counter/day pair, same DB-aware never-backwards discipline
   *  as the invoice series. */
  returnCounter: 'return_counter_v1',
  returnDay: 'return_day_v1',
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
  /** v11 (SILA §6.1/§7): merchant pairing blob (pos_token, device,
   *  merchant name, expiry, api base, last sync). */
  silaPairing: 'sila_pairing_v1',
  /** v20 (SILA_POS_VOUCHERS_API): the VOUCHER invoice series
   *  INV-V-YYYYMMDD-NNNN — its own counter/day pair, same
   *  never-backwards discipline (one receipt = one redemption,
   *  pos_receipt_ref UNIQUE per store §4.1). */
  voucherInvoiceCounter: 'voucher_invoice_counter_v1',
  voucherInvoiceDay: 'voucher_invoice_day_v1',
  /** v20 §4.2/§6: the light settlements-sync cursor
   *  (updated_since) — only campaigns with activity since the last
   *  successful fetch come back. */
  silaSettlementsCursor: 'sila_settlements_cursor_v1',
  /** v20 §6: when the last settlements sync succeeded (shown on the
   *  campaigns screen as «آخر مزامنة»). */
  silaSettlementsSyncedAt: 'sila_settlements_synced_at_v1',
} as const;

export function getJson<T>(key: string, fallback: T): T {
  try {
    const raw = storage.getString(key);
    if (raw == null) {
      return fallback;
    }
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

/** Removes a key entirely (v11 — SILA unpair). */
export function deleteKey(key: string): void {
  try {
    storage.delete(key);
  } catch (error) {
    logDiag('storage', `فشل حذف ${key}: ${String(error)}`, 'warn');
  }
}
