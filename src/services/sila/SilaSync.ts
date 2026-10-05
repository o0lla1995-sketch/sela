/**
 * sila/SilaSync — Store & Forward sync engine (SILA_POS_API §8).
 * ─────────────────────────────────────────────────────────────────
 * Runs a quiet 60-second loop while the app is open:
 *
 *   0. GET /api/pos/health — no 200 → transient, try next cycle.
 *   1. pending = 0 → light customers refresh (updated_since) → done.
 *   2. take ≤100 oldest pending rows → mark 'syncing'.
 *   3. POST /api/pos/debt-records (same idempotency keys).
 *   4. per result: synced / back-to-pending (transient) / failed
 *      (permanent — Arabic notification for the merchant, §11).
 *   5. repeat while pending remain (max 5 batches per cycle).
 *
 * Device errors (401 DEVICE_INVALID) stop the engine entirely and
 * flag the store so the UI can guide re-pairing; the queue itself is
 * NEVER marked failed for a device problem (§8 guarantee).
 */
import {useSilaStore} from '../../stores/silaStore';
import {notificationsStore} from '../../stores/notificationsStore';
import {logDiag} from '../../core/diagnostics';
import {getString, setString} from '../../storage/storage';
import {SilaRepo} from './SilaRepo';
import {
  silaHealth,
  silaSendDebtBatch,
  silaFetchCustomers,
  SilaApiError,
  silaErrorAdvice,
  type SilaDebtRecordInput,
} from './SilaApi';
import {APP_VERSION} from '../../core/config';

const CYCLE_MS = 60 * 1000;
const MAX_BATCHES_PER_CYCLE = 5;
/** §6.3 light sync cursor — only relationships touched since the
 *  last successful customers fetch come back. */
const CUSTOMERS_CURSOR_KEY = 'sila_customers_updated_since_v1';

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

function stopLoop(): void {
  if (timer != null) {
    clearInterval(timer);
    timer = null;
    logDiag('sila', 'توقفت دورة مزامنة صِلة');
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Transient failures back off: 1 min → 5 → 30 (§11). */
function backoffFor(retryCount: number): number {
  if (retryCount >= 4) {
    return 30;
  }
  return retryCount >= 2 ? 5 : 1;
}

async function syncCustomersCycle(): Promise<void> {
  const store = useSilaStore.getState();
  const pairing = store.pairing;
  if (pairing == null) {
    return;
  }
  const updatedSince = getString(CUSTOMERS_CURSOR_KEY, '');
  const rows = await silaFetchCustomers(
    pairing,
    updatedSince.length > 0 ? updatedSince : null,
  );
  const stamp = nowIso();
  await SilaRepo.upsertCustomers(
    rows.map(row => ({
      customerId: row.customer_id,
      name: row.customer_name,
      phoneLast4: row.customer_phone_last4 ?? null,
      outstandingMinor: row.outstanding_minor,
    })),
    stamp,
  );
  setString(CUSTOMERS_CURSOR_KEY, stamp);
  logDiag('sila', `تم تحديث أرصدة ${rows.length} زبون من صِلة`);
}

async function runCycle(): Promise<void> {
  const store = useSilaStore.getState();
  const pairing = store.pairing;
  if (pairing == null || running) {
    return;
  }
  running = true;
  try {
    // Step 0 — health probe (quiet transient on failure).
    const healthy = await silaHealth(pairing);
    if (!healthy) {
      useSilaStore
        .getState()
        .setSyncState(
          'no_internet',
          'لا يوجد اتصال بصِلة الآن — الطابور محفوظ وسيُزامن تلقائياً',
        );
      return;
    }

    // Recover rows stuck in 'syncing' from a crash mid-batch (§8).
    await SilaRepo.recoverStuck();

    const counts = await SilaRepo.counts();
    await useSilaStore.getState().refreshCounts();

    if (counts.pending === 0) {
      // Step 1 — light customers cache refresh.
      await syncCustomersCycle();
      useSilaStore
        .getState()
        .setSyncState('idle', 'كل الديون مسجلة في صِلة', nowIso());
      return;
    }

    useSilaStore.getState().setSyncState('syncing');

    let syncedThisCycle = 0;
    let deviceInvalid = false;

    for (let batch = 0; batch < MAX_BATCHES_PER_CYCLE; batch += 1) {
      const pendingRows = await SilaRepo.pendingBatch(100);
      if (pendingRows.length === 0) {
        break;
      }
      await SilaRepo.markSyncing(pendingRows.map(row => row.local_id));

      const records: SilaDebtRecordInput[] = pendingRows.map(row => ({
        customer_card: row.customer_card,
        offline_qr: row.offline_qr,
        customer_id: row.customer_id,
        amount_minor: String(row.amount_minor),
        currency: row.currency,
        pos_invoice_ref: row.pos_invoice_ref,
        description: row.description ?? 'بيع بضاعة — فاتورة نقاط البيع',
        scanned_at: row.scanned_at,
        idempotency_key: row.idempotency_key,
      }));

      try {
        const results = await silaSendDebtBatch(pairing, records, APP_VERSION);
        const byKey = new Map(
          results.map(result => [result.idempotency_key, result]),
        );

        for (const row of pendingRows) {
          const result = byKey.get(row.idempotency_key);
          if (result == null) {
            // Server didn't answer for this record — transient.
            await SilaRepo.markRetry(row.local_id);
            continue;
          }
          if (result.ok) {
            await SilaRepo.markSynced(row.local_id, {
              referenceCode: result.reference_code ?? '',
              transactionId: result.transaction_id ?? '',
              outstandingAfter: result.outstanding_minor ?? 0,
            });
            syncedThisCycle += 1;
            // Cache the customer name/balance for the balances screen.
            if (result.customer_name && row.customer_id) {
              await SilaRepo.upsertCustomers(
                [
                  {
                    customerId: row.customer_id,
                    name: result.customer_name,
                    phoneLast4:
                      result.customer_phone_last4 ??
                      row.customer_phone_last4 ??
                      null,
                    outstandingMinor: result.outstanding_minor ?? 0,
                  },
                ],
                nowIso(),
              );
            }
          } else {
            const code = result.error ?? 'UNKNOWN';
            const error = new SilaApiError(200, code, result.message ?? '');
            if (error.errorClass === 'transient') {
              await SilaRepo.markRetry(row.local_id);
            } else if (error.errorClass === 'device') {
              // Device problem — DO NOT fail the invoices (§8).
              await SilaRepo.requeue(row.local_id);
              deviceInvalid = true;
            } else {
              // permanent / conflict — merchant attention (§11).
              await SilaRepo.markFailed(
                row.local_id,
                code,
                silaErrorAdvice(code),
              );
              notificationsStore.push(
                'sila_debt',
                `دين فاشل: ${row.pos_invoice_ref}`,
                `${row.customer_name ?? 'زبون'} — ${silaErrorAdvice(code)}`,
                {system: true},
              );
            }
          }
        }
      } catch (error) {
        if (error instanceof SilaApiError) {
          if (error.errorClass === 'device') {
            // The whole batch belongs to a broken device link —
            // requeue everything untouched and stop the engine.
            for (const row of pendingRows) {
              await SilaRepo.requeue(row.local_id);
            }
            deviceInvalid = true;
            break;
          }
          if (error.errorClass === 'transient') {
            for (const row of pendingRows) {
              await SilaRepo.markRetry(row.local_id);
            }
            break;
          }
          // Unexpected permanent at batch level — classify per row is
          // impossible, keep pending for the next cycle + log.
          for (const row of pendingRows) {
            await SilaRepo.markRetry(row.local_id);
          }
          logDiag(
            'sila',
            `خطأ على مستوى الدفعة: ${error.code} — أعيدت الصفوف للطابور`,
            'warn',
          );
          break;
        }
        // Network-level surprise — transient.
        for (const row of pendingRows) {
          await SilaRepo.markRetry(row.local_id);
        }
        break;
      }
    }

    await useSilaStore.getState().refreshCounts();

    if (deviceInvalid) {
      useSilaStore
        .getState()
        .setSyncState(
          'device_invalid',
          'ربط هذا الجهاز بصِلة منتهٍ أو ملغى — أعد الربط من الإعدادات',
        );
      stopLoop();
      return;
    }

    const after = await SilaRepo.counts();
    const message =
      after.pending > 0
        ? `بقي ${after.pending} دين بانتظار المزامنة`
        : `كل الديون مسجلة في صِلة${
            syncedThisCycle > 0 ? ` (${syncedThisCycle} هذه الدورة)` : ''
          }`;
    useSilaStore
      .getState()
      .setSyncState(after.pending > 0 ? 'syncing' : 'idle', message, nowIso());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logDiag('sila', `دورة مزامنة فشلت: ${message}`, 'warn');
    useSilaStore
      .getState()
      .setSyncState(
        'no_internet',
        'تعذر الاتصال بصِلة — المحاولة تتكرر تلقائياً',
      );
  } finally {
    running = false;
  }
}

export const SilaSync = {
  /** Boots the loop (idempotent) — called at app start when paired. */
  start(): void {
    if (timer != null) {
      return;
    }
    timer = setInterval(() => {
      void runCycle();
    }, CYCLE_MS);
    // First cycle right away — cheap health probe decides the rest.
    setTimeout(() => {
      void runCycle();
    }, 2500);
    logDiag('sila', 'بدأت دورة مزامنة صِلة (كل 60 ثانية)');
  },

  stop(): void {
    stopLoop();
  },

  /** Manual «زامن الآن» — one immediate full cycle. */
  async syncNow(): Promise<void> {
    await runCycle();
  },

  /** Exponential backoff hint for the UI (§11). */
  backoffFor,
};
