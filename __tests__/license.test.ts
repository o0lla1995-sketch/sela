/**
 * LICENSE / ACTIVATION KEY — the anti-tamper engine against the REAL
 * LicenseService logic, with the baked-in public key swapped (via a
 * config mock) for a test keypair whose PRIVATE half we hold — the
 * only way to exercise the genuine Ed25519 verification path.
 *
 * Verified guarantees:
 *  • no license → needs_activation (full gate)
 *  • valid signature + not expired + recently verified → active
 *  • expired → locked
 *  • offline beyond the hard grace (240h) → locked
 *  • offline in the soft grace band (72–240h) → grace banner
 *  • forged/tampered MMKV payload → wiped → needs_activation
 *  • server-revoked flag → locked
 *  • 5 clock-rollback strikes → locked
 */
import nacl from 'tweetnacl';

jest.mock('../src/core/config', () => {
  const actual = jest.requireActual('../src/core/config');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const tweetnacl = require('tweetnacl');
  const pair = tweetnacl.sign.keyPair();
  globalThis.__SELA_TEST_LICENSE_SECRET = Buffer.from(pair.secretKey)
    .toString('hex');
  return {
    ...actual,
    LICENSE_PUBLIC_KEY_HEX: Buffer.from(pair.publicKey).toString('hex'),
  };
});

import {freshApp, load} from './helpers/app';

function toB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/** Signs a payload with the CURRENT test keypair and stores it in the
 *  fresh MMKV — exactly what the activation server does. */
async function installLicense(
  app: ReturnType<typeof freshApp>,
  payload: Record<string, unknown>,
  extra: {lastVerify?: number; strikes?: number} = {},
) {
  const secret = Buffer.from(
    (globalThis as {__SELA_TEST_LICENSE_SECRET: string})
      .__SELA_TEST_LICENSE_SECRET,
    'hex',
  );
  const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = nacl.sign.detached(payloadBytes, secret);

  const {KEYS, storage} = app.storage;
  storage.set(KEYS.licensePayload, toB64(payloadBytes));
  storage.set(KEYS.licenseSignature, toB64(signature));
  storage.set(KEYS.licenseLastVerify, extra.lastVerify ?? Date.now());
  if (extra.strikes != null) {
    storage.set(KEYS.licenseRollbackStrikes, extra.strikes);
  }
}

const HOUR = 3600 * 1000;

async function makeApp() {
  const app = freshApp();
  await app.connection.initDatabase();
  return app;
}

describe('license gate evaluation', () => {
  test('no license → needs_activation (the app is fully gated)', async () => {
    const app = await makeApp();
    const {evaluate} = load('src/services/license/LicenseService');
    const status = await evaluate();
    expect(status.state).toBe('needs_activation');
  });

  test('valid, current, recently verified → active', async () => {
    const app = await makeApp();
    await installLicense(app, {
      v: 1,
      keyId: 7,
      plan: 'monthly',
      deviceId: 'dev-1',
      activatedAt: Date.now() - 24 * HOUR,
      expiresAt: Date.now() + 30 * 24 * HOUR,
    });
    const {evaluate} = load('src/services/license/LicenseService');
    const status = await evaluate();
    expect(status.state).toBe('active');
    expect(status.lockReason).toBeNull();
    expect(status.remainingMs).toBeGreaterThan(0);
  });

  test('expired → locked (server dates win, offline)', async () => {
    const app = await makeApp();
    await installLicense(app, {
      v: 1,
      keyId: 7,
      plan: 'monthly',
      deviceId: 'dev-1',
      activatedAt: Date.now() - 60 * 24 * HOUR,
      expiresAt: Date.now() - HOUR,
    });
    const {evaluate} = load('src/services/license/LicenseService');
    const status = await evaluate();
    expect(status.state).toBe('locked');
    expect(status.lockReason).toBe('expired');
  });

  test('offline beyond the HARD grace (240h) → locked', async () => {
    const app = await makeApp();
    await installLicense(
      app,
      {
        v: 1,
        keyId: 7,
        plan: 'yearly',
        deviceId: 'dev-1',
        activatedAt: Date.now() - 400 * HOUR,
        expiresAt: Date.now() + 200 * 24 * HOUR,
      },
      {lastVerify: Date.now() - 300 * HOUR},
    );
    const {evaluate} = load('src/services/license/LicenseService');
    const status = await evaluate();
    expect(status.state).toBe('locked');
    expect(status.lockReason).toBe('offline_too_long');
  });

  test('offline in the SOFT grace band (72–240h) → grace, not locked', async () => {
    const app = await makeApp();
    await installLicense(
      app,
      {
        v: 1,
        keyId: 7,
        plan: 'monthly',
        deviceId: 'dev-1',
        activatedAt: Date.now() - 100 * HOUR,
        expiresAt: Date.now() + 20 * 24 * HOUR,
      },
      {lastVerify: Date.now() - 100 * HOUR},
    );
    const {evaluate} = load('src/services/license/LicenseService');
    const status = await evaluate();
    expect(status.state).toBe('grace');
    expect(status.offlineHours).toBeGreaterThan(72);
  });

  test('TAMPERED payload (forged expiry on a real signature) → wiped + gated', async () => {
    const app = await makeApp();
    // Install a valid license…
    await installLicense(app, {
      v: 1,
      keyId: 7,
      plan: 'monthly',
      deviceId: 'dev-1',
      activatedAt: Date.now(),
      expiresAt: Date.now() + 5 * 24 * HOUR,
    });
    // …then tamper with the stored payload (extend the expiry).
    const {KEYS, storage} = app.storage;
    const raw = storage.getString(KEYS.licensePayload)!;
    const parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    parsed.expiresAt = Date.now() + 365 * 24 * HOUR; // forged
    storage.set(
      KEYS.licensePayload,
      Buffer.from(JSON.stringify(parsed), 'utf8').toString('base64'),
    );

    const {evaluate} = load('src/services/license/LicenseService');
    const status = await evaluate();
    expect(status.state).toBe('needs_activation'); // wiped — no grace, no lock banner
    expect(storage.getString(KEYS.licensePayload)).toBeUndefined();
  });

  test('server-revoked flag (lastVerify = −1) → locked revoked', async () => {
    const app = await makeApp();
    await installLicense(
      app,
      {
        v: 1,
        keyId: 7,
        plan: 'monthly',
        deviceId: 'dev-1',
        activatedAt: Date.now(),
        expiresAt: Date.now() + 30 * 24 * HOUR,
      },
      {lastVerify: -1},
    );
    const {evaluate} = load('src/services/license/LicenseService');
    const status = await evaluate();
    expect(status.state).toBe('locked');
    expect(status.lockReason).toBe('revoked');
    expect(status.revoked).toBe(true);
  });

  test('5 clock-rollback strikes → locked', async () => {
    const app = await makeApp();
    await installLicense(
      app,
      {
        v: 1,
        keyId: 7,
        plan: 'monthly',
        deviceId: 'dev-1',
        activatedAt: Date.now(),
        expiresAt: Date.now() + 30 * 24 * HOUR,
      },
      {strikes: 5},
    );
    const {evaluate} = load('src/services/license/LicenseService');
    const status = await evaluate();
    expect(status.state).toBe('locked');
    expect(status.lockReason).toBe('offline_too_long');
  });

  test('heartbeat: revoked answer locks the app offline-side', async () => {
    const app = await makeApp();
    await installLicense(app, {
      v: 1,
      keyId: 7,
      plan: 'monthly',
      deviceId: 'dev-1',
      activatedAt: Date.now(),
      expiresAt: Date.now() + 30 * 24 * HOUR,
    });

    // The throttled heartbeat skips within an hour…
    const {heartbeat} = load('src/services/license/LicenseService');
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return {
        ok: true,
        json: async () => ({
          ok: true,
          status: 'revoked',
          serverTime: Date.now(),
          expiresAt: Date.now() + 30 * 24 * HOUR,
        }),
      };
    }) as unknown as typeof fetch;

    let status = await heartbeat(false); // throttled — no network
    expect(calls).toBe(0);
    expect(status.state).toBe('active');

    status = await heartbeat(true); // forced — the server says revoked
    expect(calls).toBe(1);
    expect(status.state).toBe('locked');
    expect(status.lockReason).toBe('revoked');
  });
});
