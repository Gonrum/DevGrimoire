#!/usr/bin/env node
/*
 * Events-Scope-Check (Review-Fund H-13, SSE-Variante, 2026-10-12).
 *
 * GET /api/events nahm `userId` als Query-Fallback und `projectId` ungeprüft:
 * `?userId=<Opfer>` lieferte dessen persönliche Events, `?projectId=<fremd>`
 * jede Änderung eines fremden Projekts. Belegt gegen den echten Controller mit
 * einem echten EventsBusService, plus die gemeinsame Sichtbarkeitsregel, die
 * jetzt auch der WebSocket-Pfad benutzt (inkl. Broadcast-Questions).
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

const { EventsController } = loadCompiled('events/events.controller.js');
const { isProjectEventVisible, isQuestionEventVisible } = loadCompiled('events/event-visibility.js');

const EXPECTED_CHECKS = 6;
let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

const OWN = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const FOREIGN = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const me = {
  userId: 'me', username: 'me', role: 'user',
  projectScopeMode: 'allowlist', allowedProjectIds: [OWN],
};
const req = (user) => ({ headers: {}, user });

/** Der Controller liest nur `events$` und `questionEvents$`. */
function makeBus() {
  const { Subject } = require(path.resolve(__dirname, '..', 'node_modules', 'rxjs'));
  return { events$: new Subject(), questionEvents$: new Subject() };
}

function collect(observable) {
  const got = [];
  const sub = observable.subscribe((m) => got.push(JSON.parse(m.data)));
  return { got, stop: () => sub.unsubscribe() };
}

const ev = (over) => ({ projectId: OWN, entity: 'todo', action: 'updated', entityId: 'x', ...over });

(async () => {
  await check('SSE: ?projectId=<fremd> -> 403', async () => {
    const ctrl = new EventsController(makeBus());
    assert.throws(() => ctrl.sse(req(me), FOREIGN), (e) => e.getStatus() === 403);
  });

  await check('SSE: ?userId wird ignoriert — persönliche Events nur für den echten Nutzer', async () => {
    const bus = makeBus();
    const ctrl = new EventsController(bus);
    // Der alte Fallback hätte den Query-Wert genommen; der Parameter existiert nicht mehr.
    assert.equal(ctrl.sse.length, 2, 'sse() darf nur (req, projectId) nehmen');
    const { got, stop } = collect(ctrl.sse(req(me), OWN));
    bus.events$.next(ev({ userId: 'victim', entity: 'notification', projectId: null }));
    bus.events$.next(ev({ userId: 'me', entity: 'notification', projectId: null }));
    stop();
    assert.deepEqual(got.map((e) => e.userId), ['me']);
  });

  await check('SSE: Events fremder Projekte kommen nie an, eigene schon', async () => {
    const bus = makeBus();
    const ctrl = new EventsController(bus);
    const { got, stop } = collect(ctrl.sse(req(me)));
    bus.events$.next(ev({ projectId: FOREIGN, entity: 'project' }));
    bus.events$.next(ev({ projectId: OWN, entity: 'project' }));
    bus.events$.next(ev({ projectId: null, entity: 'setting' }));
    stop();
    assert.deepEqual(got.map((e) => e.projectId), [OWN, null]);
  });

  await check('SSE: gerichtete und fremd-projektbezogene Questions werden gefiltert', async () => {
    const bus = makeBus();
    const ctrl = new EventsController(bus);
    const { got, stop } = collect(ctrl.sse(req(me)));
    bus.questionEvents$.next({ type: 'question_created', questionId: '1', targetUserId: 'victim' });
    bus.questionEvents$.next({ type: 'question_created', questionId: '2', projectId: FOREIGN });
    bus.questionEvents$.next({ type: 'question_created', questionId: '3', projectId: OWN });
    bus.questionEvents$.next({ type: 'question_created', questionId: '4', targetUserId: 'me' });
    stop();
    assert.deepEqual(got.map((q) => q.questionId), ['3', '4']);
  });

  await check('Regel: ohne Actor (Auth aus) kein Scope, aber gerichtete Events bleiben privat', () => {
    assert.equal(isProjectEventVisible(ev({ projectId: FOREIGN }), undefined, undefined), true);
    assert.equal(isProjectEventVisible(ev({ userId: 'x' }), undefined, undefined), false);
    assert.equal(isQuestionEventVisible({ targetUserId: 'x' }, undefined, undefined), false);
  });

  await check('Regel: Default-Scope "all" sieht alle Projekte', () => {
    const wide = { userId: 'w', role: 'user' };
    assert.equal(isProjectEventVisible(ev({ projectId: FOREIGN }), 'w', wide), true);
    assert.equal(isQuestionEventVisible({ projectId: FOREIGN }, 'w', wide), true);
  });

  console.log(`\n${total - failures}/${total} passed`);
  if (total !== EXPECTED_CHECKS) {
    console.error(`Erwartet ${EXPECTED_CHECKS} Checks, gelaufen ${total}`);
    process.exit(1);
  }
  process.exit(failures === 0 ? 0 : 1);
})();
