#!/usr/bin/env node
/*
 * Pure-logic check for the API-Werkbank download-ticket service.
 * Loads compiled classes from dist/. Run via
 * `npm run check:http-requests-download-ticket` from backend/ after a build.
 */
const path = require('node:path');
const assert = require('node:assert/strict');

// EncryptionService reads SECRETS_ENCRYPTION_KEY in its constructor.
process.env.SECRETS_ENCRYPTION_KEY = 'a'.repeat(64);

function loadCompiled(rel) {
  const abs = path.resolve(__dirname, '..', 'dist', rel);
  try { return require(abs); }
  catch (err) {
    console.error(`Failed to load ${abs}. Run \`npm run build\` first.`);
    console.error(err.message);
    process.exit(2);
  }
}
const { EncryptionService } = loadCompiled('common/encryption.service.js');
const { DownloadTicketService } = loadCompiled('http-requests/download-ticket.service.js');

const enc = new EncryptionService();
const svc = new DownloadTicketService(enc);

let failures = 0, total = 0;
function check(label, fn) {
  total += 1;
  try { fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err.message || err}`); }
}

check('mint → verifyAndConsume returns payload', () => {
  const t = svc.mint({ requestId: 'r1', environmentId: 'e1', userId: 'u1' });
  const out = svc.verifyAndConsume(t, 'r1');
  assert.equal(out.userId, 'u1');
  assert.equal(out.environmentId, 'e1');
});

check('single-use: second consume throws', () => {
  const t = svc.mint({ requestId: 'r2', userId: 'u1' });
  svc.verifyAndConsume(t, 'r2');
  assert.throws(() => svc.verifyAndConsume(t, 'r2'), /verwendet/);
});

check('wrong requestId throws', () => {
  const t = svc.mint({ requestId: 'r3', userId: 'u1' });
  assert.throws(() => svc.verifyAndConsume(t, 'OTHER'), /passt nicht/);
});

check('tampered ticket throws', () => {
  const t = svc.mint({ requestId: 'r4', userId: 'u1' });
  assert.throws(() => svc.verifyAndConsume(t + 'ff', 'r4'), /Ungültig/);
});

check('expired ticket throws', () => {
  // Construct a ticket with a past exp directly via the encryption service.
  const expired = enc.encrypt(JSON.stringify({
    purpose: 'wk-download', requestId: 'r5', environmentId: null, userId: 'u1',
    exp: Date.now() - 1000, jti: 'fixed-jti',
  }));
  assert.throws(() => svc.verifyAndConsume(expired, 'r5'), /abgelaufen/);
});

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures > 0 ? 1 : 0);
