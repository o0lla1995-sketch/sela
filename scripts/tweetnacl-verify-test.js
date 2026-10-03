/** Validates the v4 app's tweetnacl verification against production licenses. */
'use strict';

const nacl = require('tweetnacl');

// Same public key as src/core/config.ts (raw 32 bytes)
const PUB = Uint8Array.from(
  Buffer.from(
    '6ee513c1b7f0b057d970c6c2f4b33e5d026bc4c798b5a0b8bb72818d3197d103',
    'hex',
  ),
);

// Hermes-compatible base64 decode (mirrors LicenseService bytesFromBase64)
function bytesFromBase64(b64) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = b64.replace(/=+$/, '');
  const out = [];
  let bits = 0;
  let buffer = 0;
  for (const ch of clean) {
    const v = chars.indexOf(ch);
    if (v < 0) continue;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

const L = 'http://8jz9a3yyhn3eltmwqgnchn29.130.61.171.201.sslip.io';
const KEY = process.argv[2];

async function main() {
  const act = await (
    await fetch(L + '/api/v1/activate', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        key: KEY,
        deviceId: 'tweetnacl-test-device',
        deviceLabel: 'Tweetnacl Test',
        appVersion: '4.1.0',
      }),
    })
  ).json();

  if (!act.ok) {
    console.log('activation failed:', act.error);
    process.exit(1);
  }

  const msg = bytesFromBase64(act.license);
  const sig = bytesFromBase64(act.signature);
  const ok = nacl.sign.detached.verify(msg, sig, PUB);
  console.log('tweetnacl verify:', ok ? 'PASS' : 'FAIL');

  // Tampered expiry must fail.
  const payload = JSON.parse(Buffer.from(msg).toString('utf8'));
  const tampered = Uint8Array.from(
    Buffer.from(JSON.stringify({...payload, expiresAt: payload.expiresAt * 2})),
  );
  const tamperedOk = nacl.sign.detached.verify(tampered, sig, PUB);
  console.log('tampered rejected:', !tamperedOk ? 'PASS' : 'FAIL');

  // config must include telegram + priced plans (v2 backend).
  const cfg = await (await fetch(L + '/api/v1/config')).json();
  console.log(
    'config telegram field:',
    'telegram' in cfg.contact ? 'PASS' : 'FAIL',
    '| priced plans:',
    cfg.plans.every(p => typeof p.price === 'number') ? 'PASS' : 'FAIL',
  );

  process.exit(ok && !tamperedOk ? 0 : 1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
