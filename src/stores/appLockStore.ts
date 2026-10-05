/**
 * appLockStore — v13 (round-19 #2) app-lock state.
 * ─────────────────────────────────────────────────────────────────
 * Two independent unlock methods, either or both enabled:
 *  • fingerprint (biometric) — hardware prompt, no secret stored;
 *  • 4-digit PIN — stored ONLY as a salted SHA-512 hash in MMKV
 *    (tweetnacl.hash), never the plain digits.
 *
 * v15 (round-21 #1) — THE PIN-SETUP FIX: tweetnacl's PRNG is never
 * seeded inside React Native — Metro resolves require('crypto') to
 * an EMPTY stub through tweetnacl's package.json `browser` field
 * and Hermes has no Web Crypto, so the library kept its default
 * `randombytes = () => { throw new Error('no PRNG') }`. Every
 * setPin() call died at randomSalt() BEFORE writing the hash —
 * «مشكلة في إعداد رمز pin». Salts are now derived from a
 * persisted rolling-entropy combiner hashed with nacl.hash
 * (pure-JS SHA-512 — always available); nacl.setPRNG is also
 * seeded defensively so no other nacl call can ever throw.
 *
 * `locked` starts true on every cold start when any method is
 * enabled; AppLockGate renders the lock overlay above the whole app
 * until unlock() fires. The lock intentionally does NOT re-engage on
 * app resume — the native scanner/picker activities background the
 * React activity constantly, and a lock in the middle of a scan
 * session would wreck the cashier flow. Cold start only, exactly as
 * requested («عند فتح التطبيق»).
 */
import {create} from 'zustand';
import nacl from 'tweetnacl';
import {getString, setString, deleteKey} from '../storage/storage';
import {logDiag} from '../core/diagnostics';

const K = {
  pinHash: 'applock_pin_hash_v1',
  pinSalt: 'applock_pin_salt_v1',
  biometric: 'applock_biometric_v1',
};

/** v15: persisted rolling seed for salt generation. */
const SALT_SEED_KEY = 'applock_salt_entropy_v1';
/** v15: monotonic counter so even identical clocks differ. */
let saltCounter = 0;

/**
 * v15 (round-21 #1): seed tweetnacl's PRNG defensively — the salt no
 * longer uses nacl.randomBytes (the throwing path), and nothing else
 * in the app calls it today, but any future call must never throw.
 */
function seedNaclPrng(): void {
  try {
    let state =
      (Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) || 0x9e3779b9;
    nacl.setPRNG(x => {
      for (let i = 0; i < x.length; i += 1) {
        // xorshift32 — deterministic per-call seeding above mixes
        // time + Math.random, ample for non-crypto generic use.
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        x[i] = state & 0xff;
      }
    });
  } catch {
    // Defensive only — nothing depends on it.
  }
}
seedNaclPrng();

/** ASCII-safe byte view (salt + PIN are hex/digits only). */
function toBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    out[i] = text.charCodeAt(i) & 0xff;
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, '0');
  }
  return hex;
}

/** Salted SHA-512 of the PIN — the stored form. */
export function hashPin(pin: string, salt: string): string {
  return toHex(nacl.hash(toBytes(`${salt}:${pin}`)));
}

function randomSalt(): string {
  // v15 (round-21 #1): see header — nacl.randomBytes THROWS in RN.
  // A persisted rolling seed is re-hashed with fresh time/random
  // entropy on every use; two consecutive salts never share visible
  // structure. For a locally-stored 4-digit PIN salt this is ample —
  // the hash itself stays on this device.
  saltCounter += 1;
  const seed = getString(SALT_SEED_KEY, '');
  const rotation = toHex(
    nacl.hash(toBytes(`${seed}:${Date.now()}:${Math.random()}`)),
  );
  setString(SALT_SEED_KEY, rotation);
  const material = [
    seed,
    rotation,
    Date.now(),
    performance.now(),
    Math.random(),
    Math.random(),
    saltCounter,
  ].join(':');
  return toHex(nacl.hash(toBytes(material))).slice(0, 32);
}

interface AppLockState {
  /** SHA-512 hex of salt+pin — null = no PIN set. */
  pinHash: string | null;
  pinSalt: string | null;
  biometricEnabled: boolean;
  /** True while the lock overlay covers the app. */
  locked: boolean;

  load: () => void;
  /** True when ANY unlock method is configured. */
  isEnabled: () => boolean;
  setPin: (pin: string) => void;
  clearPin: () => void;
  setBiometric: (enabled: boolean) => void;
  verifyPin: (pin: string) => boolean;
  lock: () => void;
  unlock: () => void;
}

export const useAppLockStore = create<AppLockState>((set, get) => ({
  pinHash: null,
  pinSalt: null,
  biometricEnabled: false,
  locked: false,

  load: () => {
    set({
      pinHash: getString(K.pinHash, '') || null,
      pinSalt: getString(K.pinSalt, '') || null,
      biometricEnabled: getString(K.biometric, '') === '1',
    });
  },

  isEnabled: () => {
    const s = get();
    return s.pinHash != null || s.biometricEnabled;
  },

  setPin: pin => {
    const salt = randomSalt();
    setString(K.pinSalt, salt);
    setString(K.pinHash, hashPin(pin, salt));
    set({pinHash: hashPin(pin, salt), pinSalt: salt});
    logDiag('applock', 'تم تعيين رمز دخول جديد للتطبيق');
  },

  clearPin: () => {
    deleteKey(K.pinHash);
    deleteKey(K.pinSalt);
    set({pinHash: null, pinSalt: null});
    logDiag('applock', 'أُلغي رمز الدخول');
  },

  setBiometric: enabled => {
    setString(K.biometric, enabled ? '1' : '0');
    set({biometricEnabled: enabled});
    logDiag('applock', enabled ? 'فُعّل القفل بالبصمة' : 'أُلغي القفل بالبصمة');
  },

  verifyPin: pin => {
    const {pinHash, pinSalt} = get();
    if (pinHash == null || pinSalt == null) {
      return false;
    }
    return hashPin(pin, pinSalt) === pinHash;
  },

  lock: () => set({locked: true}),
  unlock: () => set({locked: false}),
}));
