#!/usr/bin/env node
/*
 * Pure-logic check for the API-Werkbank download-ticket service.
 * Loads compiled classes from dist/. Run via
 * `npm run check:http-requests-download-ticket` from backend/ after a build.
 */
const path = require('node:path');
const assert = require('node:assert/strict');

function loadCompiled(rel) {
  const abs = path.resolve(__dirname, '..', 'dist', rel);
  try { return require(abs); }
  catch (err) {
    console.error(`Failed to load ${abs}. Run \`npm run build\` first.`);
    console.error(err.message);
    process.exit(2);
  }
}
const { DownloadTicketService } = loadCompiled('http-requests/download-ticket.service.js');

const svc = new DownloadTicketService();
const actor = { userId: 'u1', username: 'alice', role: 'user', projectScopeMode: 'allowlist', allowedProjectIds: ['p1'] };

let failures = 0, total = 0;
function check(label, fn) {
  total += 1;
  try { fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err.message || err}`); }
}

check('mint → verifyAndConsume returns payload', () => {
  const t = svc.mint({ requestId: 'r1', environmentId: 'e1', actor });
  const out = svc.verifyAndConsume(t, 'r1');
  assert.equal(out.actor.userId, 'u1');
  assert.deepEqual(out.actor.allowedProjectIds, ['p1']);
  assert.equal(out.environmentId, 'e1');
});

check('single-use: second consume throws', () => {
  const t = svc.mint({ requestId: 'r2', actor });
  svc.verifyAndConsume(t, 'r2');
  assert.throws(() => svc.verifyAndConsume(t, 'r2'), /verwendet/);
});

check('wrong requestId throws', () => {
  const t = svc.mint({ requestId: 'r3', actor });
  assert.throws(() => svc.verifyAndConsume(t, 'OTHER'), /passt nicht/);
  // A mismatched id must not burn the ticket for its real request.
  svc.verifyAndConsume(t, 'r3');
});

check('tampered ticket throws', () => {
  const t = svc.mint({ requestId: 'r4', actor });
  assert.throws(() => svc.verifyAndConsume(t + 'ff', 'r4'), /Ungültig/);
});

check('expired ticket throws', () => {
  const realNow = Date.now;
  const t = svc.mint({ requestId: 'r5', actor });
  try {
    Date.now = () => realNow() + 61_000;
    assert.throws(() => svc.verifyAndConsume(t, 'r5'), /abgelaufen/);
  } finally {
    Date.now = realNow;
  }
});

check('encrypted JSON (old ticket format) is not accepted', () => {
  // The old format was forgeable via a secret's encryptedValue; any string
  // that was not minted by this instance must be rejected.
  assert.throws(() => svc.verifyAndConsume('00:11:22', 'r6'), /Ungültig/);
  assert.throws(() => svc.verifyAndConsume(undefined, 'r6'), /Ungültig/);
});

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures > 0 ? 1 : 0);
