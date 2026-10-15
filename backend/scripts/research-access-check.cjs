#!/usr/bin/env node
/*
 * Recherche-Zugriff (Webrecherche Plan 1, Task 1).
 *
 * Persönliche Recherchen sieht nur der Besitzer (Admin alle); zugeordnete
 * Recherchen folgen dem Projekt-/Kunden-Scope. Vorher prüfte /api/research
 * keinen Scope.
 *
 * Lädt aus dist/; vorher `npm run build`.
 */
const path = require('node:path');
const assert = require('node:assert/strict');

function loadCompiled(rel) {
  const abs = path.resolve(__dirname, '..', 'dist', rel);
  try { return require(abs); } catch (err) {
    console.error(`Failed to load ${abs}. Run \`npm run build\` first.`);
    console.error(err.message);
    process.exit(2);
  }
}

const { RequestContext } = loadCompiled('common/request-context.js');
const { ResearchService } = loadCompiled('research/research.service.js');
const { canReadResearch, canControlResearch, visibleResearchFilter, assertMoveTarget, isAssigned } = loadCompiled('research/research-access.js');

const EXPECTED_CHECKS = 13;
let failures = 0, total = 0;
const pending = [];
function check(label, fn) {
  total += 1;
  const ok = () => console.log(`✓ ${label}`);
  const bad = (err) => { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); };
  try { const r = fn(); if (r && typeof r.then === 'function') pending.push(r.then(ok, bad)); else ok(); }
  catch (err) { bad(err); }
}

const P1 = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const P2 = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const alice = { userId: '111111111111111111111111', username: 'alice', role: 'user', projectScopeMode: 'allowlist', allowedProjectIds: [P1] };
const bob = { userId: '222222222222222222222222', username: 'bob', role: 'user' };
const admin = { userId: '333333333333333333333333', username: 'root', role: 'admin' };
const mine = { ownerUserId: alice.userId };
const inP1 = { ownerUserId: bob.userId, projectId: P1 };
const inP2 = { ownerUserId: null, projectId: P2 };

check('isAssigned: projectId oder customerId', () => {
  assert.equal(isAssigned(mine), false);
  assert.equal(isAssigned(inP1), true);
  assert.equal(isAssigned({ customerId: P2 }), true);
});

check('persönlich: nur Besitzer und Admin', () => {
  assert.equal(canReadResearch(alice, mine), true);
  assert.equal(canReadResearch(bob, mine), false);
  assert.equal(canReadResearch(admin, mine), true);
});

check('zugeordnet: Projekt-Scope entscheidet, nicht der Besitzer', () => {
  assert.equal(canReadResearch(alice, inP1), true);
  assert.equal(canReadResearch(alice, inP2), false, 'allowlist ohne P2');
  assert.equal(canReadResearch(bob, inP2), true, 'Scope all');
});

check('ohne Actor erlaubt (Auth aus)', () => {
  assert.equal(canReadResearch(undefined, mine), true);
});

check('visibleResearchFilter: persönlich nur eigene, zugeordnet nach Allowlist', () => {
  const f = JSON.stringify(visibleResearchFilter(alice));
  assert.match(f, new RegExp(alice.userId));
  assert.match(f, new RegExp(P1));
  assert.ok(!f.includes(bob.userId));
});

check('visibleResearchFilter: Admin ohne Einschränkung auf persönliche', () => {
  const f = JSON.stringify(visibleResearchFilter(admin));
  assert.ok(!f.includes('ownerUserId'), f);
});

check('assertMoveTarget: genau ein Ziel, Zugriff nötig', () => {
  assert.throws(() => assertMoveTarget(alice, {}), (e) => e.getStatus() === 400);
  assert.throws(() => assertMoveTarget(alice, { projectId: P1, customerId: P2 }), (e) => e.getStatus() === 400);
  assert.throws(() => assertMoveTarget(alice, { projectId: P2 }), (e) => e.getStatus() === 403);
  assert.doesNotThrow(() => assertMoveTarget(alice, { projectId: P1 }));
});

// Winziger Mongo-Matcher: $or, $and, $in, $ne, null (= fehlend), Gleichheit per String.
function matches(doc, f) {
  return Object.entries(f).every(([k, v]) => {
    if (k === '$or') return v.some((x) => matches(doc, x));
    if (k === '$and') return v.every((x) => matches(doc, x));
    const val = doc[k] === undefined ? null : doc[k];
    if (v !== null && typeof v === 'object' && !v._bsontype) {
      if ('$in' in v) return v.$in.some((x) => (x === null ? val === null : val !== null && String(x) === String(val)));
      if ('$ne' in v) return v.$ne === null ? val !== null : String(val) !== String(v.$ne);
    }
    return v === null ? val === null : val !== null && String(v) === String(val);
  });
}
const seen = (actor, doc) => matches(doc, visibleResearchFilter(actor));
const C1 = 'cccccccccccccccccccccccc';
const C2 = 'dddddddddddddddddddddddd';

check('Filter und canRead stimmen auf Beispieldokumenten überein', () => {
  const docs = [mine, { ownerUserId: bob.userId }, inP1, inP2, { projectId: P1, customerId: C1 }, { customerId: C1 }, { customerId: C2 }];
  const actors = [alice, bob, admin,
    { ...alice, customerScopeMode: 'allowlist', allowedCustomerIds: [C1] },
    { ...bob, projectScopeMode: 'none', customerScopeMode: 'none' }];
  for (const a of actors) for (const d of docs) {
    assert.equal(seen(a, d), canReadResearch(a, d), `${a.username} ${JSON.stringify(d)}`);
  }
});

check('Scope-Modus none: nur eigene persönliche', () => {
  const none = { ...bob, projectScopeMode: 'none', customerScopeMode: 'none' };
  assert.equal(canReadResearch(none, inP1), false);
  assert.equal(canReadResearch(none, { customerId: C1 }), false);
  assert.equal(seen(none, inP1), false);
  assert.equal(seen(none, { ownerUserId: bob.userId }), true);
});

check('Kunden-Allowlist', () => {
  const a = { ...bob, customerScopeMode: 'allowlist', allowedCustomerIds: [C1] };
  assert.equal(canReadResearch(a, { customerId: C1 }), true);
  assert.equal(canReadResearch(a, { customerId: C2 }), false);
  assert.equal(seen(a, { customerId: C1 }), true);
  assert.equal(seen(a, { customerId: C2 }), false);
});

check('Projekt UND Kunde gesetzt: beide Achsen nötig (canRead und Filter)', () => {
  const both = { projectId: P1, customerId: C1 };
  const pOnly = { ...alice, customerScopeMode: 'allowlist', allowedCustomerIds: [C2] };
  const pAndC = { ...alice, customerScopeMode: 'allowlist', allowedCustomerIds: [C1] };
  assert.equal(canReadResearch(pOnly, both), false);
  assert.equal(seen(pOnly, both), false);
  assert.equal(canReadResearch(pAndC, both), true);
  assert.equal(seen(pAndC, both), true);
  assert.equal(canControlResearch(pOnly, both), false);
});

check('ungültige userId: persönlicher Teil trifft nichts (auch kein Alt-Eintrag mit ownerUserId null)', () => {
  const broken = { userId: 'nicht-gueltig', username: 'x', role: 'user' };
  assert.equal(seen(broken, { ownerUserId: null }), false);
  assert.equal(seen(broken, {}), false);
  assert.equal(seen(broken, inP1), true, 'zugeordnet bleibt über Scope sichtbar');
});

check('Import-Pfad: createForImport ohne Scope-Prüfung, create mit', async () => {
  const svc = Object.create(ResearchService.prototype);
  const created = [];
  svc.researchModel = { create: async (d) => { created.push(d); return { ...d, _id: 'x', title: 't' }; } };
  svc.eventEmitter = { emit() {} };
  await RequestContext.run(alice, undefined, async () => {
    await assert.rejects(() => svc.create({ projectId: P2, title: 't', content: 'c' }), (e) => e.getStatus() === 403);
    await svc.createForImport({ projectId: P2, title: 't', content: 'c' });
    await assert.rejects(() => svc.createForImport({ title: 't', content: 'c' }), (e) => e.getStatus() === 400);
  });
  assert.equal(created.length, 1);
});

Promise.all(pending).then(() => {
console.log(`\n${total - failures}/${total} passed`);
if (total !== EXPECTED_CHECKS) { console.error(`Erwartet ${EXPECTED_CHECKS} Checks, gelaufen ${total}`); process.exit(1); }
process.exit(failures === 0 ? 0 : 1);
});
