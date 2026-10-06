/**
 * silaStore — pairing + queue + sync state for the SILA integration.
 * ─────────────────────────────────────────────────────────────────
 * The pairing blob (pos_token etc.) persists in MMKV (§7
 * pos_settings); the queue counts refresh from SQLite after every
 * enqueue / sync cycle so the UI badges stay truthful.
 */
import {create} from 'zustand';
import {getJson, setJson, KEYS, deleteKey} from '../storage/storage';
import {logDiag} from '../core/diagnostics';
import {SilaRepo} from '../services/sila/SilaRepo';
import {VouchersRepo} from '../services/sila/VouchersRepo';
import type {SilaPairing} from '../core/types';

export type SilaSyncState =
  | 'idle'
  | 'syncing'
  | 'no_internet'
  | 'device_invalid';

interface SilaState {
  pairing: SilaPairing | null;
  /** Queue counters (refreshed from SQLite). */
  pending: number;
  failed: number;
  synced: number;
  /** Latest sync cycle outcome for the UI. */
  syncState: SilaSyncState;
  lastSyncAt: string | null;
  lastSyncMessage: string | null;
  /** True while a pairing request is in flight. */
  pairingBusy: boolean;
  /** v21 (round-27 #6): how many voucher campaigns are ACTIVE in
   *  this store — the POS cart's قسيمة button appears only when this
   *  is > 0 (an active campaign the merchant is contracted in). */
  activeCampaigns: number;

  load: () => void;
  setPairing: (pairing: SilaPairing) => void;
  clearPairing: () => void;
  refreshCounts: () => Promise<void>;
  refreshActiveCampaigns: () => Promise<void>;
  setSyncState: (
    state: SilaSyncState,
    message?: string | null,
    lastSyncAt?: string | null,
  ) => void;
  setPairingBusy: (busy: boolean) => void;
}

function persistPairing(pairing: SilaPairing | null): void {
  if (pairing == null) {
    deleteKey(KEYS.silaPairing);
  } else {
    setJson(KEYS.silaPairing, pairing);
  }
}

export const useSilaStore = create<SilaState>((set, get) => ({
  pairing: getJson<SilaPairing | null>(KEYS.silaPairing, null),
  pending: 0,
  failed: 0,
  synced: 0,
  syncState: 'idle',
  lastSyncAt: null,
  lastSyncMessage: null,
  pairingBusy: false,
  activeCampaigns: 0,

  load: () => {
    const pairing = getJson<SilaPairing | null>(KEYS.silaPairing, null);
    set({pairing});
    if (pairing != null) {
      void get().refreshCounts();
      void get().refreshActiveCampaigns();
    }
  },

  setPairing: pairing => {
    persistPairing(pairing);
    set({pairing, syncState: 'idle', lastSyncMessage: null});
    void get().refreshActiveCampaigns();
    logDiag('sila', `تم ربط حساب التاجر: ${pairing.merchantName}`);
  },

  clearPairing: () => {
    persistPairing(null);
    set({
      pairing: null,
      syncState: 'idle',
      lastSyncMessage: null,
      activeCampaigns: 0,
    });
    logDiag('sila', 'تم فك ربط حساب صِلة من هذا الجهاز');
  },

  refreshCounts: async () => {
    const counts = await SilaRepo.counts();
    set({
      pending: counts.pending,
      failed: counts.failed,
      synced: counts.synced,
    });
  },

  /** v21 (round-27 #6): the active-campaign count for the cart's
   *  قسيمة button. Quiet by design (a fresh install has no table
   *  yet — 0 is the honest answer there). */
  refreshActiveCampaigns: async () => {
    try {
      const count = await VouchersRepo.activeCampaignsCount();
      set({activeCampaigns: count});
    } catch {
      set({activeCampaigns: 0});
    }
  },

  setSyncState: (state, message = null, lastSyncAt = null) => {
    set(prev => ({
      syncState: state,
      lastSyncMessage: message,
      lastSyncAt: lastSyncAt ?? prev.lastSyncAt,
    }));
  },

  setPairingBusy: busy => set({pairingBusy: busy}),
}));

/** Imperative accessor for services outside React. */
export function getSilaPairing(): SilaPairing | null {
  return useSilaStore.getState().pairing;
}
