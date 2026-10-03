/**
 * License store — mirrors LicenseService status into React state.
 * ─────────────────────────────────────────────────────────────────
 * The gate decision itself lives in LicenseService.evaluate() (pure
 * logic, unit-testable, offline). This store caches the latest
 * LicenseStatus so every screen can render subscription info and the
 * App root can decide whether to show the activation gate.
 */
import {create} from 'zustand';
import {
  evaluate,
  heartbeat,
  type LicenseStatus,
} from '../services/license/LicenseService';

const UNKNOWN_STATUS: LicenseStatus = {
  state: 'needs_activation',
  license: null,
  remainingMs: 0,
  offlineHours: 0,
  lockReason: null,
  revoked: false,
};

interface LicenseStoreState {
  /** null while the first evaluation is still running. */
  status: LicenseStatus | null;
  evaluating: boolean;
  lastCheckedAt: number;
  /** Re-runs the offline gate decision. */
  refresh: () => Promise<void>;
  /** Server heartbeat (throttled to once/hour unless force). */
  verifyOnline: (force?: boolean) => Promise<void>;
}

let heartbeatInFlight = false;

export const useLicenseStore = create<LicenseStoreState>((set, get) => ({
  status: null,
  evaluating: false,
  lastCheckedAt: 0,

  refresh: async () => {
    if (get().evaluating) {
      return;
    }
    set({evaluating: true});
    try {
      const status = await evaluate();
      set({status, lastCheckedAt: Date.now()});
    } finally {
      set({evaluating: false});
    }
  },

  verifyOnline: async (force = false) => {
    if (heartbeatInFlight) {
      return;
    }
    heartbeatInFlight = true;
    try {
      const status = await heartbeat(force);
      set({status, lastCheckedAt: Date.now()});
    } finally {
      heartbeatInFlight = false;
    }
  },
}));

export function initialLicenseStatus(): LicenseStatus {
  return UNKNOWN_STATUS;
}
