#!/usr/bin/env node
/*
 * Steuerung, REST und Live-Strom (Webrecherche Plan 1, Task 8).
 * Lädt aus dist/; vorher `npm run build`.
 */
const path = require('node:path');
const assert = require('node:assert/strict');
require(path.resolve(__dirname, '..', 'node_modules', 'reflect-metadata'));

function loadCompiled(rel) {
  const abs = path.resolve(__dirname, '..', 'dist', rel);
  try { return require(abs); } catch (err) {
    console.error(`Failed to load ${abs}. Run \`npm run build\` first.`);
    console.error(err.message);
    process.exit(2);
  }
}

const { NotFoundException } = require(path.resolve(__dirname, '..', 'node_modules', '@nestjs', 'common'));
const { ResearchControlService } = loadCompiled('research/research-control.service.js');
const { ResearchRunsController } = loadCompiled('research/research-runs.controller.js');
const { ResearchController } = loadCompiled('research/research.controller.js');
const { ResearchModule } = loadCompiled('research/research.module.js');
const { ResearchLiveService } = loadCompiled('research/research-live.service.js');
const { RequestContext } = loadCompiled('common/request-context.js');

const EXPECTED_CHECKS = 12;
let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

const OWNER = '111111111111111111111111';
const OTHER = '222222222222222222222222';
const P_OK = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const P_DENIED = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const P_MISSING = 'cccccccccccccccccccccccc';
const owner = { userId: OWNER, username: 'owner', role: 'user', projectScopeMode: 'allowlist', allowedProjectIds: [P_OK, P_MISSING] };
const stranger = { userId: OTHER, username: 'other', role: 'user' };
const as = (user, fn) => RequestContext.run(user, undefined, fn);

const base = {
  title: 'Thema', depth: 'normal', mode: 'research', ownerUserId: OWNER, projectId: null, customerId: null,
  content: '', files: [], tasks: [], sourceList: [], followUps: [], model: [], relatedKnowledge: [], roundsDone: 0,
  cancelRequested: false, pauseRequested: false,
};

function setup({ webEnabled = true, capacity = 2 } = {}) {
  const docs = new Map();
  let seq = 0;
  const store = {
    docs,
    get: async (id) => (docs.has(id) ? structuredClone(docs.get(id)) : null),
    patch: async (id, set) => {
      const d = docs.get(id);
      for (const [k, v] of Object.entries(structuredClone(set))) { if (v === undefined) delete d[k]; else d[k] = v; }
    },
    create: async (input) => {
      seq += 1;
      const id = String(seq).padStart(24, '0');
      docs.set(id, { ...base, id, ...structuredClone(input), status: 'queued', mode: 'research' });
      return id;
    },
    delete: async (id) => { docs.delete(id); },
    listActive: async (o) => [...docs.values()].filter((d) => d.ownerUserId === o && (d.status === 'queued' || d.status === 'running')).map((d) => structuredClone(d)),
  };
  const queue = { enqueued: [], removed: [], enqueue: async (id) => { queue.enqueued.push(id); }, remove: async (id) => { queue.removed.push(id); } };
  const live = { aborted: [], abort: (id) => { live.aborted.push(id); } };
  const stepsRemoved = [];
  const steps = { removeFor: async (id) => { stepsRemoved.push(id); }, list: async () => [] };
  const events = { emitted: [], emit: (name, payload) => { events.emitted.push({ name, payload }); } };
  const notFound = (what) => { throw new NotFoundException(`${what} nicht gefunden`); };
  const projects = { findById: async (id) => { if (id === P_MISSING) notFound('Projekt'); } };
  const customers = { findById: async () => notFound('Kunde') };
  const svc = new ResearchControlService(
    store, queue, live, steps,
    { isEnabled: async () => webEnabled },
    { poolCapacity: async () => capacity },
    projects, customers, events,
  );
  const put = (id, extra) => { docs.set(id, { ...base, id, ...extra }); return id; };
  return { svc, store, queue, live, steps, stepsRemoved, events, put, docs };
}

const status = async (promise) => {
  try { await promise; return 200; } catch (err) { return typeof err.getStatus === 'function' ? err.getStatus() : err; }
};

(async () => {
  await check('start: zwei Themen → zwei Ids, queued, steigende queuedAt, Besitzer, Reihenfolge enqueued', async () => {
    const t = setup();
    const ids = await as(owner, () => t.svc.start({ topics: ['  Erstes Thema ', 'Zweites Thema'], depth: 'quick', files: [{ name: 'a.txt', text: 'x' }] }));
    assert.equal(ids.length, 2);
    const [a, b] = ids.map((id) => t.docs.get(id));
    assert.equal(a.status, 'queued');
    assert.equal(a.title, 'Erstes Thema');
    assert.equal(a.ownerUserId, OWNER);
    assert.ok(a.queuedAt < b.queuedAt);
    assert.equal(a.files[0].n, 0);
    assert.deepEqual(t.queue.enqueued, ids);
  });

  await check('start: Ablehnung mit 400 legt nichts an', async () => {
    const long = (n) => 'x'.repeat(n);
    const cases = [
      [setup(), { topics: ['ab'] }],
      [setup(), { topics: Array.from({ length: 21 }, (_, i) => `Thema ${i}`) }],
      [setup(), { topics: ['Gutes Thema'], focus: long(501) }],
      [setup({ webEnabled: false }), { topics: ['Gutes Thema'] }],
      [setup({ capacity: 0 }), { topics: ['Gutes Thema'] }],
    ];
    for (const [t, input] of cases) {
      assert.equal(await status(as(owner, () => t.svc.start({ depth: 'normal', files: [], ...input }))), 400);
      assert.equal(t.docs.size, 0);
      assert.equal(t.queue.enqueued.length, 0);
    }
  });

  await check('cancel: queued, queued mit Inhalt, running, done', async () => {
    const t = setup();
    t.put('q1', { status: 'queued' });
    t.put('q2', { status: 'queued', content: 'ALT' });
    t.put('r1', { status: 'running' });
    t.put('d1', { status: 'done', content: 'x' });
    await as(owner, async () => {
      await t.svc.cancel('q1'); await t.svc.cancel('q2'); await t.svc.cancel('r1');
      assert.equal(await status(t.svc.cancel('d1')), 409);
    });
    assert.ok(t.queue.removed.includes('q1'));
    assert.equal(t.docs.get('q1').status, 'cancelled');
    assert.equal(t.docs.get('q2').status, 'done');
    assert.equal(t.docs.get('r1').cancelRequested, true);
    assert.ok(t.live.aborted.includes('r1'));
    assert.equal(t.docs.get('r1').status, 'running');
  });

  await check('pause/resume: running pausiert per Flag; Vertiefen bleibt deepen samt Frage', async () => {
    const t = setup();
    t.put('r1', { status: 'running' });
    t.put('p1', { status: 'paused', mode: 'deepen', modeQuestion: 'Und warum?' });
    t.put('p2', { status: 'paused', mode: 'research' });
    await as(owner, async () => {
      await t.svc.pause('r1'); await t.svc.resume('p1'); await t.svc.resume('p2');
    });
    assert.equal(t.docs.get('r1').pauseRequested, true);
    assert.ok(t.live.aborted.includes('r1'));
    assert.equal(t.docs.get('p1').status, 'queued');
    assert.equal(t.docs.get('p1').mode, 'deepen');
    assert.equal(t.docs.get('p1').modeQuestion, 'Und warum?');
    assert.equal(t.docs.get('p2').mode, 'resume');
    assert.deepEqual(t.queue.enqueued, ['p1', 'p2']);
  });

  await check('resume auf failed: ohne Zwischenergebnis 409, mit done-Teilauftrag queued', async () => {
    const t = setup();
    t.put('f1', { status: 'failed' });
    t.put('f2', { status: 'failed', tasks: [{ n: 1, round: 1, question: 'q', queries: [], status: 'done', sources: [] }] });
    await as(owner, async () => {
      assert.equal(await status(t.svc.resume('f1')), 409);
      await t.svc.resume('f2');
    });
    assert.equal(t.docs.get('f2').status, 'queued');
    assert.equal(t.docs.get('f2').error, null);
  });

  await check('retry auf failed: Felder zurückgesetzt, Schritte entfernt, eingereiht', async () => {
    const t = setup();
    t.put('f1', {
      status: 'failed', content: 'Z', roundsDone: 2, mode: 'deepen', modeQuestion: 'Frage?',
      tasks: [{ n: 1, round: 1, question: 'q', queries: [], status: 'done', sources: [] }],
      sourceList: [{ n: 1, url: 'https://a.de', title: '', notes: '', relevant: true }],
      files: [{ n: 3, name: 'a.txt', text: 'x', notes: 'N' }],
    });
    await as(owner, () => t.svc.retry('f1'));
    const d = t.docs.get('f1');
    assert.deepEqual([d.tasks, d.sourceList, d.content, d.roundsDone], [[], [], '', 0]);
    assert.equal(d.files[0].n, 0);
    assert.equal(d.files[0].notes, '');
    assert.equal(d.mode, 'research');
    assert.equal(d.modeQuestion, undefined);
    assert.equal(d.status, 'queued');
    assert.deepEqual(t.stepsRemoved, ['f1']);
    assert.deepEqual(t.queue.enqueued, ['f1']);
  });

  await check('deepen: ohne Inhalt 409, mit Inhalt followUps + deepen, zu kurze Frage 400', async () => {
    const t = setup();
    t.put('d0', { status: 'done', content: '' });
    t.put('d1', { status: 'done', content: 'Bericht' });
    await as(owner, async () => {
      assert.equal(await status(t.svc.deepen('d0', 'Eine Frage')), 409);
      assert.equal(await status(t.svc.deepen('d1', 'ab')), 400);
      await t.svc.deepen('d1', 'Eine Frage');
    });
    const d = t.docs.get('d1');
    assert.equal(d.followUps.length, 1);
    assert.equal(d.mode, 'deepen');
    assert.equal(d.modeQuestion, 'Eine Frage');
    assert.equal(d.status, 'queued');
    assert.deepEqual(t.queue.enqueued, ['d1']);
  });

  await check('move: fremd 404, ohne Zugriff 403, eigenes Projekt gesetzt + Ereignis, running 409, unbekannt 404', async () => {
    const t = setup();
    t.put('d1', { status: 'done', content: 'x' });
    t.put('r1', { status: 'running' });
    assert.equal(await status(as(stranger, () => t.svc.move('d1', { projectId: P_OK }))), 404);
    assert.equal(await status(as(owner, () => t.svc.move('d1', { projectId: P_DENIED }))), 403);
    assert.equal(await status(as(owner, () => t.svc.move('r1', { projectId: P_OK }))), 409);
    assert.equal(await status(as(owner, () => t.svc.move('d1', { projectId: P_MISSING }))), 404);
    assert.equal(t.events.emitted.length, 0);
    await as(owner, () => t.svc.move('d1', { projectId: P_OK }));
    assert.equal(t.docs.get('d1').projectId, P_OK);
    assert.equal(t.docs.get('d1').customerId, null);
    assert.equal(t.events.emitted.length, 1);
    assert.equal(t.events.emitted[0].payload.action, 'created');
    assert.equal(t.events.emitted[0].payload.projectId, P_OK);
  });

  await check('remove: running → abort, Schritte weg, Dokument weg, Zuordnung → deleted', async () => {
    const t = setup();
    t.put('r1', { status: 'running', projectId: P_OK });
    t.put('r2', { status: 'done', content: 'x' });
    await as(owner, async () => { await t.svc.remove('r1'); await t.svc.remove('r2'); });
    assert.ok(t.live.aborted.includes('r1'));
    assert.deepEqual(t.stepsRemoved, ['r1', 'r2']);
    assert.equal(t.docs.size, 0);
    assert.equal(t.events.emitted.length, 1);
    assert.equal(t.events.emitted[0].payload.action, 'deleted');
    assert.equal(t.events.emitted[0].payload.entityId, 'r1');
  });

  await check('queuePositions: laufende zuerst, dann queuedAt, nur eigene', async () => {
    const t = setup();
    t.put('a', { status: 'queued', queuedAt: new Date(3000) });
    t.put('b', { status: 'queued', queuedAt: new Date(1000) });
    t.put('c', { status: 'running', queuedAt: new Date(5000) });
    t.put('x', { status: 'queued', queuedAt: new Date(10), ownerUserId: OTHER });
    t.put('y', { status: 'done', queuedAt: new Date(1) });
    const res = await as(owner, () => t.svc.queuePositions());
    assert.deepEqual(res, [{ id: 'c', position: 1 }, { id: 'b', position: 2 }, { id: 'a', position: 3 }]);
  });

  await check('Controller-Reihenfolge: ResearchRunsController vor ResearchController', () => {
    const list = Reflect.getMetadata('controllers', ResearchModule);
    const i = list.indexOf(ResearchRunsController);
    const j = list.indexOf(ResearchController);
    assert.ok(i >= 0 && j >= 0 && i < j, `Reihenfolge: ${list.map((c) => c.name).join(', ')}`);
    // Die statischen Routen existieren tatsächlich auf dem vorderen Controller.
    assert.equal(typeof ResearchRunsController.prototype.queue, 'function');
    assert.equal(typeof ResearchRunsController.prototype.start, 'function');
  });

  await check('SSE-Vorprüfung: fremde Recherche → 404 ohne Header', async () => {
    const t = setup();
    t.put('fremd', { status: 'running', ownerUserId: OWNER });
    const calls = [];
    const res = {
      writableEnded: false,
      setHeader: (...a) => calls.push(['setHeader', ...a]),
      flushHeaders: () => calls.push(['flushHeaders']),
      status: (...a) => { calls.push(['status', ...a]); return res; },
      json: (...a) => calls.push(['json', ...a]),
      write: (...a) => calls.push(['write', ...a]),
      end: () => calls.push(['end']),
    };
    const controller = new ResearchRunsController(t.svc, new ResearchLiveService());
    const req = { on: () => {} };
    assert.equal(await status(as(stranger, () => controller.live('fremd', req, res))), 404);
    assert.equal(await status(as(stranger, () => controller.live('gibtsnicht', req, res))), 404);
    assert.deepEqual(calls.filter((c) => c[0] === 'setHeader'), []);
    assert.equal(calls.length, 0);
    // Gegenprobe: der Besitzer bekommt den Strom.
    const unsub = as(owner, () => controller.live('fremd', req, res));
    await unsub;
    assert.ok(calls.some((c) => c[0] === 'setHeader' && String(c[2]).startsWith('text/event-stream')));
  });

  await new Promise((r) => setTimeout(r, 0));
  if (total !== EXPECTED_CHECKS) { console.error(`Erwartet ${EXPECTED_CHECKS} Checks, gelaufen ${total}`); process.exit(1); }
  console.log(`\n${total - failures}/${total} passed`);
  process.exit(failures ? 1 : 0);
})();
