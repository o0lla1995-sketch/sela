/**
 * sila/SilaSync — Store & Forward sync engine (SILA_POS_API §8).
 * ─────────────────────────────────────────────────────────────────
 * v12 (round-18 #1) — full reliability rework. The v11 engine had a
 * fatal request bug: debt records carried explicit null identity
 * fields, the server's zod rejects nulls with VALIDATION_ERROR, and
 * every debt bounced pending↔retry forever while the UI stayed
 * silent. Now:
 *
 *   • records OMIT absent identity paths (the server accepts only
 *     present fields);
 *   • customers light-sync failures are isolated — they can never
 *     poison the debt sync state ("no internet" lies are gone);
 *   • transient failures back off 1 → 5 → 30 minutes (§11) instead
 *     of hammering every cycle;
 *   • the engine reacts IMMEDIATELY when connectivity returns
 *     (NetInfo) or the app returns to the foreground (AppState) —
 *     no more waiting for the next 60s tick;
 *   • manual «زامن الآن» always runs (bypasses backoff) and returns
 *     a spoken Arabic outcome so the UI can toast real feedback.
 *
 * Loop (each cycle):
 *   0. GET /api/pos/health — no 200 → transient, try next cycle.
 *   1. pending = 0 → light customers refresh (updated_since) → done.
 *   2. take ≤100 oldest pending rows → mark 'syncing'.
 *   3. POST /api/pos/debt-records (same idempotency keys).
 *   4. per result: synced / back-to-pending (transient) / failed
 *      (permanent — Arabic notification for the merchant, §11).
 *   5. repeat while pending remain (max 5 batches per cycle).
 *
 * Device errors (DEVICE_INVALID) stop the engine entirely and flag
 * the store so the UI can guide re-pairing; the queue itself is
 * NEVER marked failed for a device problem (§8 guarantee).
 */
import {AppState} from 'react-native';
import NetInfo from '@react-native-community/netinfo';
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
/** One-time v12 repair flag — requeues rows failed by the v11
 *  null-fields VALIDATION_ERROR bug (see SilaRepo). */
const VALIDATION_REQUEUE_FLAG = 'sila_requeued_validation_fix_v1';

/** Result of one cycle — the UI toasts `message` on manual sync. */
export interface SilaSyncOutcome {
  state: 'idle' | 'syncing' | 'no_internet' | 'device_invalid';
  synced: number;
  pending: number;
  failed: number;
  message: string;
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
let netInfoUnsub: (() => void) | null = null;
let appStateSub: {remove: () => void} | null = null;
/** Transient backoff (§11): after 1/2/4+ transient cycles the engine
 *  sleeps 1/5/30 minutes before the next automatic attempt. Manual
 *  syncNow() always bypasses this. */
let transientStreak = 0;
let nextAttemptAt = 0;
/** Debounce for the fast wake paths (NetInfo online / foreground). */
let fastWakeTimer: ReturnType<typeof setTimeout> | null = null;

function stopLoop(): void {
  if (timer != null) {
    clearInterval(timer);
    timer = null;
    logDiag('sila', 'توقفت دورة مزامنة صِلة');
  }
  if (fastWakeTimer != null) {
    clearTimeout(fastWakeTimer);
    fastWakeTimer = null;
  }
}

function detachListeners(): void {
  if (netInfoUnsub != null) {
    netInfoUnsub();
    netInfoUnsub = null;
  }
  if (appStateSub != null) {
    appStateSub.remove();
    appStateSub = null;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Transient failures back off: 1 min → 5 → 30 (§11). */
export function backoffFor(retryCount: number): number {
  if (retryCount >= 4) {
    return 30;
  }
  return retryCount >= 2 ? 5 : 1;
}

function noteTransientBackoff(): void {
  transientStreak += 1;
  const minutes = backoffFor(transientStreak);
  nextAttemptAt = Date.now() + minutes * 60 * 1000;
  logDiag(
    'sila',
    `فشل مؤقت في المزامنة (${transientStreak} متتالية) — المحاولة التالية بعد ${minutes} دقيقة`,
    'warn',
  );
}

function resetBackoff(): void {
  if (transientStreak > 0) {
    transientStreak = 0;
    nextAttemptAt = 0;
  }
}

/** v12 (round-18 #1): builds a §6.2 record with ONLY the identity
 *  paths the scanned code actually provided — the server's zod
 *  schema rejects explicit nulls, which silently broke every debt
 *  sync in v11. */
function buildDebtRecord(row: {
  customer_card: string | null;
  offline_qr: string | null;
  customer_id: string | null;
  amount_minor: number;
  currency: string;
  pos_invoice_ref: string;
  description: string | null;
  scanned_at: string;
  idempotency_key: string;
}): SilaDebtRecordInput {
  const record: SilaDebtRecordInput = {
    amount_minor: String(row.amount_minor),
    currency: row.currency,
    pos_invoice_ref: row.pos_invoice_ref,
    description: row.description ?? 'بيع بضاعة — فاتورة نقاط البيع',
    scanned_at: row.scanned_at,
    idempotency_key: row.idempotency_key,
  };
  if (row.customer_card != null && row.customer_card.length > 0) {
    record.customer_card = row.customer_card;
  }
  if (row.offline_qr != null && row.offline_qr.length > 0) {
    record.offline_qr = row.offline_qr;
  }
  if (row.customer_id != null && row.customer_id.length > 0) {
    record.customer_id = row.customer_id;
  }
  return record;
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

/** v13 (round-19 #1): isolated customers-only refresh — the Home
 *  dashboard calls this on focus so «الديون القائمة» و«الرصيد بعد
 *  السداد» mirror the صِلة server (repayments included) with the
 *  same freshness as the debts screen, instead of summing local
 *  debt rows that never shrink. Never throws; resolves to true when
 *  new balances landed. */
async function refreshBalancesCycle(): Promise<boolean> {
  const store = useSilaStore.getState();
  if (store.pairing == null) {
    return false;
  }
  if (running) {
    return false; // a full cycle is already refreshing everything
  }
  try {
    await syncCustomersCycle();
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logDiag('sila', `تحديث أرصدة الزبائن فشل: ${message}`, 'warn');
    return false;
  }
}

async function runCycle(manual: boolean): Promise<SilaSyncOutcome> {
  const store = useSilaStore.getState();
  const pairing = store.pairing;
  if (pairing == null) {
    return {
      state: 'idle',
      synced: 0,
      pending: 0,
      failed: 0,
      message: 'الجهاز غير مرتبط بصِلة — اربط حساب التاجر أولاً',
    };
  }
  if (running) {
    const counts = await SilaRepo.counts();
    return {
      state: 'syncing',
      synced: 0,
      pending: counts.pending,
      failed: counts.failed,
      message: 'المزامنة جارية الآن — انتظر لحظات',
    };
  }
  if (!manual && Date.now() < nextAttemptAt) {
    const counts = await SilaRepo.counts();
    const minutes = Math.max(
      1,
      Math.round((nextAttemptAt - Date.now()) / 60000),
    );
    return {
      state: 'syncing',
      synced: 0,
      pending: counts.pending,
      failed: counts.failed,
      message: `انتظار قبل المحاولة التالية (${minutes} دقيقة) — زامن الآن لتجاوز الانتظار`,
    };
  }

  running = true;
  try {
    // Step 0 — health probe (quiet transient on failure).
    const healthy = await silaHealth(pairing);
    if (!healthy) {
      noteTransientBackoff();
      useSilaStore
        .getState()
        .setSyncState(
          'no_internet',
          'لا يوجد اتصال بصِلة الآن — الطابور محفوظ وسيُزامن تلقائياً عند توفر الإنترنت',
        );
      const counts = await SilaRepo.counts();
      return {
        state: 'no_internet',
        synced: 0,
        pending: counts.pending,
        failed: counts.failed,
        message: 'تعذر الوصول إلى صِلة — تحقق من الإنترنت وحاول مجدداً',
      };
    }

    // Recover rows stuck in 'syncing' from a crash mid-batch (§8).
    await SilaRepo.recoverStuck();

    const counts = await SilaRepo.counts();
    await useSilaStore.getState().refreshCounts();

    if (counts.pending === 0) {
      // Step 1 — light customers cache refresh. v12: isolated —
      // a failure here must NEVER poison the debt sync state
      // (v11 showed "no internet" forever because of this).
      try {
        await syncCustomersCycle();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logDiag('sila', `تحديث أرصدة الزبائن فشل: ${message}`, 'warn');
      }
      useSilaStore
        .getState()
        .setSyncState('idle', 'كل الديون مسجلة في صِلة', nowIso());
      return {
        state: 'idle',
        synced: 0,
        pending: 0,
        failed: counts.failed,
        message:
          counts.failed > 0
            ? `لا توجد ديون بانتظار المزامنة — و${counts.failed} دين فاشل بحاجة لمراجعة`
            : 'كل الديون مسجلة في صِلة',
      };
    }

    useSilaStore.getState().setSyncState('syncing');

    let syncedThisCycle = 0;
    let deviceInvalid = false;
    let transientFailure = false;

    for (let batch = 0; batch < MAX_BATCHES_PER_CYCLE; batch += 1) {
      const pendingRows = await SilaRepo.pendingBatch(100);
      if (pendingRows.length === 0) {
        break;
      }
      await SilaRepo.markSyncing(pendingRows.map(row => row.local_id));

      const records = pendingRows.map(row => buildDebtRecord(row));

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
            transientFailure = true;
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
              transientFailure = true;
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
            transientFailure = true;
            break;
          }
          // Unexpected permanent at batch level (e.g. body-wide
          // VALIDATION_ERROR) — per-row classification is
          // impossible, keep pending for the next cycle + log.
          for (const row of pendingRows) {
            await SilaRepo.markRetry(row.local_id);
          }
          logDiag(
            'sila',
            `خطأ على مستوى الدفعة: ${error.code} — أعيدت الصفوف للطابور`,
            'warn',
          );
          transientFailure = true;
          break;
        }
        // Network-level surprise — transient.
        for (const row of pendingRows) {
          await SilaRepo.markRetry(row.local_id);
        }
        transientFailure = true;
        break;
      }
    }

    // v13 (round-19 #1): light customers refresh on EVERY healthy
    // cycle — previously it only ran when the queue was empty, so
    // while debts were still pending (or right after they synced)
    // the Home report kept stale balances that ignored repayments
    // made through the صِلة app. Isolated — never poisons state.
    if (!deviceInvalid && !transientFailure) {
      try {
        await syncCustomersCycle();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logDiag('sila', `تحديث أرصدة الزبائن فشل: ${message}`, 'warn');
      }
    }

    await useSilaStore.getState().refreshCounts();

    if (deviceInvalid) {
      transientStreak = 0;
      nextAttemptAt = 0;
      useSilaStore
        .getState()
        .setSyncState(
          'device_invalid',
          'ربط هذا الجهاز بصِلة منتهٍ أو ملغى — أعد الربط من إعدادات صِلة',
        );
      stopLoop();
      const after = await SilaRepo.counts();
      return {
        state: 'device_invalid',
        synced: syncedThisCycle,
        pending: after.pending,
        failed: after.failed,
        message: 'ربط هذا الجهاز بصِلة منتهٍ أو ملغى — أعد الربط برمز جديد',
      };
    }

    if (transientFailure) {
      noteTransientBackoff();
    } else if (syncedThisCycle > 0) {
      resetBackoff();
    }

    const after = await SilaRepo.counts();
    const message =
      after.pending > 0
        ? `زُامن ${syncedThisCycle} دين — بقي ${after.pending} بانتظار المزامنة`
        : syncedThisCycle > 0
        ? `تمت المزامنة — سُجّل ${syncedThisCycle} دين في صِلة`
        : 'كل الديون مسجلة في صِلة';
    useSilaStore
      .getState()
      .setSyncState(after.pending > 0 ? 'syncing' : 'idle', message, nowIso());
    return {
      state: after.pending > 0 ? 'syncing' : 'idle',
      synced: syncedThisCycle,
      pending: after.pending,
      failed: after.failed,
      message,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logDiag('sila', `دورة مزامنة فشلت: ${message}`, 'warn');
    noteTransientBackoff();
    const counts = await SilaRepo.counts();
    let state: SilaSyncOutcome['state'] = 'no_internet';
    let text = 'تعذر الاتصال بصِلة — المحاولة تتكرر تلقائياً عند توفر الإنترنت';
    if (error instanceof SilaApiError) {
      if (error.errorClass === 'device') {
        state = 'device_invalid';
        text = silaErrorAdvice(error.code);
      } else {
        text = `${silaErrorAdvice(error.code)} (${error.code})`;
      }
    }
    useSilaStore.getState().setSyncState(state, text);
    return {
      state,
      synced: 0,
      pending: counts.pending,
      failed: counts.failed,
      message: text,
    };
  } finally {
    running = false;
  }
}

/** Immediate, debounced wake — used by the connectivity listener and
 *  the foreground transition so debts sync the moment internet is
 *  back instead of waiting for the next 60s tick. */
function scheduleFastWake(): void {
  if (timer == null) {
    return; // engine stopped (unpaired / device invalid)
  }
  if (fastWakeTimer != null) {
    return; // already scheduled
  }
  fastWakeTimer = setTimeout(() => {
    fastWakeTimer = null;
    const store = useSilaStore.getState();
    if (store.pairing == null) {
      return;
    }
    void SilaRepo.counts()
      .then(counts => {
        if (counts.pending > 0 || store.syncState === 'no_internet') {
          void runCycle(false);
        }
      })
      .catch(() => undefined);
  }, 4000);
}

export const SilaSync = {
  /** Boots the loop (idempotent) — called at app start when paired
   *  and right after a successful pairing. */
  start(): void {
    // One-time v12 repair: rows failed by the v11 null-fields bug.
    if (!getString(VALIDATION_REQUEUE_FLAG, '')) {
      setString(VALIDATION_REQUEUE_FLAG, '1');
      void SilaRepo.requeueFailedValidation().then(() =>
        useSilaStore.getState().refreshCounts(),
      );
    }
    if (timer != null) {
      return;
    }
    transientStreak = 0;
    nextAttemptAt = 0;
    timer = setInterval(() => {
      void runCycle(false);
    }, CYCLE_MS);
    // First cycle right away — cheap health probe decides the rest.
    setTimeout(() => {
      void runCycle(false);
    }, 2500);

    // v12: react to connectivity the moment it returns (round-18 #1).
    if (netInfoUnsub == null) {
      netInfoUnsub = NetInfo.addEventListener(state => {
        const online =
          state.isConnected === true && state.isInternetReachable !== false;
        if (online) {
          scheduleFastWake();
        }
      });
    }
    // v12: returning to the foreground also wakes the engine —
    // Android throttles JS timers while backgrounded.
    if (appStateSub == null) {
      appStateSub = AppState.addEventListener('change', next => {
        if (next === 'active') {
          scheduleFastWake();
        }
      });
    }
    logDiag(
      'sila',
      'بدأت دورة مزامنة صِلة (كل 60 ثانية + تفاعل فوري مع الإنترنت)',
    );
  },

  stop(): void {
    stopLoop();
    detachListeners();
  },

  /** Manual «زامن الآن» — one immediate full cycle, backoff bypassed,
   *  with a spoken outcome for the UI toast (round-18 #1). */
  async syncNow(): Promise<SilaSyncOutcome> {
    return runCycle(true);
  },

  /** v13 (round-19 #1): light balances-only refresh for the Home
   *  dashboard — pulls /api/pos/customers (updated_since cursor →
   * cheap) so the debts & treasury report reflects صِلة-side
   * repayments. Safe offline (resolves false, never throws). */
  async refreshBalances(): Promise<boolean> {
    return refreshBalancesCycle();
  },

  /** Exponential backoff hint for the UI (§11). */
  backoffFor,
};
