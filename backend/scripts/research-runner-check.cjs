#!/usr/bin/env node
/*
 * Runner, Warteschlange, Neustart (Webrecherche Plan 1, Task 7).
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

const { ResearchRunnerService } = loadCompiled('research/research-runner.service.js');
const { ResearchLiveService } = loadCompiled('research/research-live.service.js');
const { Interrupted } = loadCompiled('research/research-llm.service.js');
const { ResearchProcessor } = loadCompiled('research/research.processor.js');
const { ResearchControlService } = loadCompiled('research/research-control.service.js');
const { RequestContext } = loadCompiled('common/request-context.js');
const { DelayedError } = require(path.resolve(__dirname, '..', 'node_modules', 'bullmq'));

const EXPECTED_CHECKS = 20;
let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

const OWNER = '111111111111111111111111';
const LONG = 'Belegter Fakt aus 2024. '.repeat(20);
const REPORT = `## Kurzfassung\nErgebnis [1]. ${'Mehr. '.repeat(50)}\n## Offene Punkte\n-`;
const tc = (name, args) => ({ id: `c${Math.random()}`, name, arguments: JSON.stringify(args) });
const lastContent = (c) => String(c.messages.at(-1).content);
const hasTools = (c) => Array.isArray(c.tools) && c.tools.length > 0;

function memStore(doc) {
  const docs = new Map([[doc.id, { title: 'Thema', totalMs: 0, roundsDone: 0, tasks: [], sourceList: [], files: [], followUps: [], model: [], relatedKnowledge: [], content: '', cancelRequested: false, pauseRequested: false, mode: 'research', depth: 'quick', ownerUserId: OWNER, projectId: null, customerId: null, status: 'running', ...doc }]]);
  return {
    docs,
    get: async (id) => (docs.has(id) ? structuredClone(docs.get(id)) : null),
    patch: async (id, set) => { Object.assign(docs.get(id), structuredClone(set)); },
    claimQueued: async (id) => { const d = docs.get(id); if (d.status !== 'queued') return false; d.status = 'running'; return true; },
    countRunning: async () => [...docs.values()].filter((d) => d.status === 'running').length,
    olderQueuedExists: async (d) => [...docs.values()].some((o) => o.id !== d.id && o.ownerUserId === d.ownerUserId && o.status === 'queued' && o.queuedAt < d.queuedAt),
    pauseAllRunning: async (note) => { let n = 0; for (const d of docs.values()) if (d.status === 'running') { d.status = 'paused'; d.error = note; n += 1; } return n; },
  };
}

// llm: (call) => { text, toolCalls } — entscheidet nach lane/Inhalt
function makeRunner({ doc, llm, pages = { 'https://a.de/': LONG }, capacity = 2, rag = async () => [], fetched = [] }) {
  const store = memStore(doc);
  const live = new ResearchLiveService();
  const notes = [];
  const steps = [];
  const calls = [];
  const cap = { value: capacity };
  const runner = new ResearchRunnerService(
    store, live,
    { call: async (c) => { calls.push(c); return { model: 'm @ x', text: '', toolCalls: [], ...(await llm(c, { store, live })) }; } },
    { search: async () => [{ title: 'A', url: 'https://a.de/', snippet: '' }], fetch: async (url) => { fetched.push(url); if (!(url in pages)) throw new Error('404'); return { url, title: 'A', text: pages[url] }; } },
    { record: async (_id, s) => { steps.push(`${s.kind}:${s.text}`); } },
    { search: rag },
    { create: async (...a) => { notes.push(a); } },
    { findUserById: async () => ({ _id: OWNER, username: 'u', role: 'user', active: true, permissions: [], projectScopeMode: 'all', allowedProjectIds: [], customerScopeMode: 'all', allowedCustomerIds: [] }) },
    { poolCapacity: async () => cap.value },
    { emit() {} },
  );
  return { runner, store, notes, steps, live, calls, cap };
}

// Agent-Pfad: Leitung ruft eine Runde, Teilauftrag liest und gibt ab, Leitung schreibt
const agentLlm = (opts = {}) => async (c, env) => {
  if (c.lane === 'main') {
    if (!hasTools(c)) {
      // writeReport des Runners (Rückfälle) und Planer des festen Ablaufs
      if (c.kind === 'leadReport') { if (opts.counter) opts.counter.reports += 1; return { text: REPORT }; }
      return { text: '' };
    }
    const toolMsgs = c.messages.filter((m) => m.role === 'tool');
    if (opts.leadThrowsAfterRound && toolMsgs.length >= 1) throw new Error('Zeitlimit Leitung');
    if (toolMsgs.length === 0) return { toolCalls: [tc('run_subtasks', { tasks: [{ question: 'Q1', queries: ['q'] }] })] };
    return { toolCalls: [tc('write_report', { report: REPORT })] };
  }
  if (opts.onTask) await opts.onTask(c, env);
  const taskTools = c.messages.filter((m) => m.role === 'tool').length;
  if (lastContent(c) === 'Start now.' || taskTools === 0) return { toolCalls: [tc('web_search', { query: 'q' })] };
  if (taskTools === 1) return { toolCalls: [tc('read_page', { url: 'https://a.de/' })] };
  return { toolCalls: [tc('submit_findings', { summary: `Fakt [1]. ${LONG.slice(0, 80)}`, used_sources: [1] })] };
};

// Modell ohne Tool-Calling: Leitung antwortet nur mit Text, der feste Ablauf arbeitet mit JSON
const textLlm = () => async (c) => {
  const last = lastContent(c);
  if (c.kind === 'leadPlan') {
    return { text: last.includes('--- NOTES ---') ? '{"enough":true}' : '{"enough":false,"tasks":[{"question":"Q","queries":["q"]}]}' };
  }
  if (c.lane === 'main' && hasTools(c)) return { text: 'kein tool' };
  if (c.kind === 'leadReport') return { text: REPORT };
  if (last.includes('--- CANDIDATES ---')) return { text: '{"picks":[0]}' };
  if (last.includes('--- PAGE ---')) return { text: '{"relevant":true,"notes":"Fakt 2024 [1]"}' };
  if (last.includes('--- NOTES ---')) return { text: 'Zusammenfassung [1].' };
  return { text: '' };
};

(async () => {

  await check('Agent-Pfad endet done mit Quellenliste, Modell und Benachrichtigung', async () => {
    const { runner, store, notes } = makeRunner({ doc: { id: 'r1' }, llm: agentLlm() });
    await runner.run('r1');
    const d = store.docs.get('r1');
    assert.equal(d.status, 'done', d.error);
    assert.ok(d.content.includes('## Quellen'));
    assert.ok(d.content.includes('- [1] [A](https://a.de/)'));
    assert.deepEqual(d.sources, ['https://a.de/']);
    assert.deepEqual(d.model, ['m @ x']);
    assert.equal(d.tasks[0].status, 'done');
    assert.equal(d.roundsDone, 1);
    assert.equal(d.mode, 'research');
    assert.equal(notes.length, 1);
    assert.equal(notes[0][0], 'Recherche fertig: Thema');
    assert.equal(notes[0][2], '/research/r1');
    assert.equal(notes[0][3], 'research_done');
    assert.deepEqual(notes[0][4], { userId: OWNER });
    assert.ok(notes[0][1].length <= 200 && notes[0][1].startsWith('Ergebnis [1].'));
  });

  await check('Modell ohne Tool-Calling → Rückfall B (fester Ablauf)', async () => {
    const { runner, store, steps } = makeRunner({ doc: { id: 'r1' }, llm: textLlm() });
    await runner.run('r1');
    const d = store.docs.get('r1');
    assert.equal(d.status, 'done', d.error);
    assert.ok(steps.includes('info:Leitung ohne Bericht – fester Ablauf'), steps.join('\n'));
    assert.ok(d.content.includes('- [1] [A](https://a.de/)'));
    assert.equal(d.tasks.length, 1);
    assert.equal(d.tasks[0].status, 'done');
  });

  await check('Leitung scheitert nach einer Runde → Rückfall A', async () => {
    const { runner, store, steps } = makeRunner({ doc: { id: 'r1' }, llm: agentLlm({ leadThrowsAfterRound: true }) });
    await runner.run('r1');
    const d = store.docs.get('r1');
    assert.equal(d.status, 'done', d.error);
    assert.ok(steps.some((s) => s.startsWith('info:Leitung gescheitert (Zeitlimit Leitung)')), steps.join('\n'));
  });

  await check('Keine Quelle → failed ohne Berichtsaufruf', async () => {
    const counter = { reports: 0 };
    const { runner, store, notes } = makeRunner({ doc: { id: 'r1' }, llm: agentLlm({ counter }), pages: {} });
    await runner.run('r1');
    const d = store.docs.get('r1');
    assert.equal(d.status, 'failed');
    assert.equal(d.error, 'Keine verwertbaren Quellen gefunden');
    assert.equal(counter.reports, 0);
    assert.equal(notes.length, 1);
    assert.ok(notes[0][0].startsWith('Recherche fehlgeschlagen: '));
    assert.equal(notes[0][3], 'research_done');
  });

  await check('Pause mitten im Lauf → paused, Teilauftrag bleibt running', async () => {
    let fired = false;
    const onTask = async (_c, { store, live }) => {
      if (fired) return;
      fired = true;
      store.docs.get('r1').pauseRequested = true;
      live.abort('r1');
      throw new Interrupted('x');
    };
    const { runner, store, steps, notes } = makeRunner({ doc: { id: 'r1' }, llm: agentLlm({ onTask }) });
    await runner.run('r1');
    const d = store.docs.get('r1');
    assert.equal(d.status, 'paused');
    assert.equal(d.tasks[0].status, 'running');
    assert.equal(d.pauseRequested, false);
    assert.equal(typeof d.totalMs, 'number');
    assert.ok(d.totalMs >= 0);
    assert.ok(steps.includes('info:pausiert'));
    assert.equal(notes.length, 0);
  });

  await check('Abbruch ohne Bericht → cancelled; Vertiefen-Abbruch → done mit altem Bericht', async () => {
    const cancelOnce = () => {
      let fired = false;
      return async (_c, { store, live }) => {
        if (fired) return;
        fired = true;
        store.docs.get('r1').cancelRequested = true;
        live.abort('r1');
        throw new Interrupted('x');
      };
    };
    const a = makeRunner({ doc: { id: 'r1' }, llm: agentLlm({ onTask: cancelOnce() }) });
    await a.runner.run('r1');
    assert.equal(a.store.docs.get('r1').status, 'cancelled');
    assert.equal(a.store.docs.get('r1').cancelRequested, false);
    assert.ok(a.steps.includes('info:abgebrochen'));

    const b = makeRunner({
      doc: { id: 'r1', mode: 'deepen', content: 'ALT', modeQuestion: 'Und Y?', status: 'running', roundsDone: 1, followUps: [{ question: 'Und Y?', at: new Date() }] },
      llm: agentLlm({ onTask: cancelOnce() }),
    });
    await b.runner.run('r1');
    const d = b.store.docs.get('r1');
    assert.equal(d.status, 'done');
    assert.equal(d.content, 'ALT');
    assert.equal(d.cancelRequested, false);
    assert.equal(d.roundsDone, 1);
  });

  await check('Fortsetzen: unterbrochener Teilauftrag läuft erneut, keine neue Planung', async () => {
    const { runner, store, calls } = makeRunner({
      doc: { id: 'r1', mode: 'resume', depth: 'quick', roundsDone: 0, tasks: [{ n: 1, round: 1, question: 'Q1', queries: ['q'], status: 'running', sources: [] }] },
      llm: agentLlm(),
    });
    await runner.run('r1');
    const d = store.docs.get('r1');
    assert.equal(d.status, 'done', d.error);
    assert.equal(d.tasks.length, 1);
    assert.equal(d.tasks[0].status, 'done');
    assert.equal(d.roundsDone, 1);
    assert.ok(calls.some((c) => c.lane === 't1'));
    assert.ok(!calls.some((c) => c.lane === 't2'));
  });

  await check('mayStart: Reihenfolge pro Besitzer, Kapazität, drop', async () => {
    const { runner, store, cap } = makeRunner({ doc: { id: 'alt', status: 'queued', queuedAt: 1 }, llm: agentLlm(), capacity: 0 });
    store.docs.set('neu', { ...structuredClone(store.docs.get('alt')), id: 'neu', queuedAt: 2 });
    assert.equal(await runner.mayStart('neu'), 'wait');
    assert.equal(await runner.mayStart('alt'), 'wait');
    assert.equal(store.docs.get('alt').status, 'queued');
    cap.value = 2;
    assert.equal(await runner.mayStart('alt'), 'start');
    assert.equal(store.docs.get('alt').status, 'running');
    assert.equal(await runner.mayStart('alt'), 'drop');
    assert.equal(await runner.mayStart('fehlt'), 'drop');
    // Kapazität voll: ein laufender bei Kapazität 1
    cap.value = 1;
    assert.equal(await runner.mayStart('neu'), 'wait');
  });

  await check('Neustart-Erholung: running → paused, nicht im stdio-MCP', async () => {
    const a = makeRunner({ doc: { id: 'r1', status: 'running' }, llm: agentLlm() });
    await a.runner.onModuleInit();
    assert.equal(a.store.docs.get('r1').status, 'paused');
    assert.match(a.store.docs.get('r1').error, /Neustart/);

    const b = makeRunner({ doc: { id: 'r1', status: 'running' }, llm: agentLlm() });
    process.env.MCP_STDIO = 'true';
    try { await b.runner.onModuleInit(); } finally { delete process.env.MCP_STDIO; }
    assert.equal(b.store.docs.get('r1').status, 'running');
  });

  await check('Bereits im Wissen: nur starke Treffer; RAG-Fehler bricht nicht ab', async () => {
    const a = makeRunner({ doc: { id: 'r1' }, llm: agentLlm(), rag: async () => [{ id: 'k1', title: 'Alt', score: 0.9 }, { id: 'k2', title: 'Fern', score: 0.5 }] });
    await a.runner.run('r1');
    const d = a.store.docs.get('r1');
    assert.equal(d.status, 'done', d.error);
    assert.deepEqual(d.relatedKnowledge, [{ id: 'k1', title: 'Alt', score: 0.9 }]);
    const lead = a.calls.find((c) => c.lane === 'main' && hasTools(c));
    assert.ok(String(lead.messages[0].content).includes('Alt'));
    assert.ok(a.steps.some((s) => s.startsWith('info:Bereits im Wissen: ') && s.includes('Alt')));

    const b = makeRunner({ doc: { id: 'r1' }, llm: agentLlm(), rag: async () => { throw new Error('kein RAG'); } });
    await b.runner.run('r1');
    assert.ok(b.steps.includes('info:Wissenssuche nicht verfügbar'));
    assert.equal(b.store.docs.get('r1').status, 'done');
  });

  await check('Boot: wartende Dokumente werden neu eingereiht (Fehler je Dokument toleriert), nicht im stdio-MCP', async () => {
    const enqueued = [];
    const store = { listQueuedIds: async () => ['a', 'b', 'c'] };
    const queue = { enqueue: async (id) => { if (id === 'b') throw new Error('redis weg'); enqueued.push(id); } };
    let started = 0;
    const p = new ResearchProcessor({}, store, queue);
    p._worker = { run: () => { started += 1; return new Promise(() => {}); } };
    await p.onApplicationBootstrap();
    assert.deepEqual(enqueued, ['a', 'c']);
    assert.equal(started, 1);

    enqueued.length = 0;
    const q = new ResearchProcessor({}, store, queue);
    q._worker = { run: () => { started += 1; return new Promise(() => {}); } };
    process.env.MCP_STDIO = 'true';
    try { await q.onApplicationBootstrap(); } finally { delete process.env.MCP_STDIO; }
    assert.deepEqual(enqueued, []);
    assert.equal(started, 1);
  });

  await check('Processor: mayStart wirft → verzögert statt Job-Fehler; nach dem Lauf wieder queued → verzögert', async () => {
    const moved = [];
    const job = { data: { id: 'r1' }, moveToDelayed: async (ts, token) => { moved.push([ts, token]); } };
    let ran = 0;
    const throwing = new ResearchProcessor({ mayStart: async () => { throw new Error('mongo weg'); }, run: async () => { ran += 1; } }, {}, {});
    await assert.rejects(throwing.process(job, 'tok'), DelayedError);
    assert.equal(moved.length, 1);
    assert.equal(moved[0][1], 'tok');
    assert.ok(moved[0][0] >= Date.now() + 9_000);
    assert.equal(ran, 0);

    const requeued = new ResearchProcessor({ mayStart: async () => 'start', run: async () => { ran += 1; }, isQueued: async () => true }, {}, {});
    await assert.rejects(requeued.process(job, 'tok'), DelayedError);
    assert.equal(ran, 1);
    assert.equal(moved.length, 2);

    const normal = new ResearchProcessor({ mayStart: async () => 'start', run: async () => { ran += 1; }, isQueued: async () => false }, {}, {});
    await normal.process(job, 'tok');
    assert.equal(ran, 2);
    assert.equal(moved.length, 2);
  });

  await check('Kein Geister-running: done- und failed-Schreiben scheitern → letzter Versuch setzt failed, run wirft nicht', async () => {
    const { runner, store } = makeRunner({ doc: { id: 'r1' }, llm: agentLlm() });
    const orig = store.patch;
    let doneFails = 1, failedFails = 1;
    store.patch = async (id, set) => {
      if (set.status === 'done' && doneFails > 0) { doneFails -= 1; throw new Error('schreiben done'); }
      if (set.status === 'failed' && set.error === 'schreiben done' && failedFails > 0) { failedFails -= 1; throw new Error('schreiben failed'); }
      return orig(id, set);
    };
    await runner.run('r1');
    const d = store.docs.get('r1');
    assert.equal(d.status, 'failed');
    assert.equal(d.error, 'schreiben done');

    // Besitzer-Lookup wirft → ebenfalls failed statt running
    const b = makeRunner({ doc: { id: 'r1' }, llm: agentLlm() });
    b.runner.auth = { findUserById: async () => { throw new Error('users weg'); } };
    await b.runner.run('r1');
    assert.equal(b.store.docs.get('r1').status, 'failed');
    assert.equal(b.store.docs.get('r1').error, 'users weg');
  });

  await check('Ereignis- oder Benachrichtigungsfehler macht aus done kein failed', async () => {
    const { runner, store } = makeRunner({ doc: { id: 'r1', projectId: '222222222222222222222222' }, llm: agentLlm() });
    runner.events = { emit() { throw new Error('listener kaputt'); } };
    runner.notifications = { create: async () => { throw new Error('push kaputt'); } };
    await runner.run('r1');
    const d = store.docs.get('r1');
    assert.equal(d.status, 'done', d.error);
    assert.equal(d.error, null);
  });

  await check('Stopp zwischen Übernahme und begin(): cancel → cancelled, pause → paused, gelöscht → still; kein LLM-Aufruf', async () => {
    const a = makeRunner({ doc: { id: 'r1', cancelRequested: true }, llm: agentLlm() });
    await a.runner.run('r1');
    assert.equal(a.store.docs.get('r1').status, 'cancelled');
    assert.equal(a.calls.length, 0);
    assert.equal(a.notes.length, 0);
    assert.equal(a.live.controller('r1'), undefined, 'Controller nach dem Ende entfernt');

    const b = makeRunner({ doc: { id: 'r1', pauseRequested: true }, llm: agentLlm() });
    await b.runner.run('r1');
    assert.equal(b.store.docs.get('r1').status, 'paused');
    assert.equal(b.calls.length, 0);

    // Zwischen dem Lesen in run() und begin() gelöscht
    const c = makeRunner({ doc: { id: 'r1' }, llm: agentLlm() });
    const origGet = c.store.get;
    let reads = 0;
    c.store.get = async (id) => { reads += 1; if (reads === 2) c.store.docs.delete(id); return origGet(id); };
    await c.runner.run('r1');
    assert.equal(c.store.docs.has('r1'), false);
    assert.equal(c.calls.length, 0);
    assert.equal(c.notes.length, 0);
    assert.deepEqual(c.steps, [], 'keine verwaisten Schritte');
  });

  await check('Ohne Besitzer (ownerUserId null): läuft ohne Actor und ohne Besitzer-Lookup', async () => {
    const actors = [];
    let ragCalls = 0;
    const { runner, store, notes } = makeRunner({
      doc: { id: 'r1', ownerUserId: null },
      llm: async (c, env) => { actors.push(RequestContext.getUser()); return agentLlm()(c, env); },
      rag: async () => { ragCalls++; return [{ id: 'k1', title: 'Fremd', score: 0.9 }]; },
    });
    runner.auth = { findUserById: async () => { throw new Error('darf nicht gefragt werden'); } };
    await runner.run('r1');
    const d = store.docs.get('r1');
    assert.equal(d.status, 'done', d.error);
    assert.ok(actors.length > 0 && actors.every((a) => a === undefined));
    assert.equal(notes.length, 0, 'ohne Besitzer keine gerichtete Benachrichtigung');
    assert.equal(ragCalls, 0, 'ohne Actor keine ungescopte Wissenssuche');
    assert.deepEqual(d.relatedKnowledge, []);
  });

  await check('Besitzer fehlt/inaktiv: neue Recherche failed; Vertiefen mit Bericht bleibt done mit error', async () => {
    const a = makeRunner({ doc: { id: 'r1' }, llm: agentLlm() });
    a.runner.auth = { findUserById: async () => null };
    await a.runner.run('r1');
    assert.equal(a.store.docs.get('r1').status, 'failed');
    assert.equal(a.store.docs.get('r1').error, 'Besitzer nicht gefunden');

    const b = makeRunner({ doc: { id: 'r1', mode: 'deepen', content: 'ALT', modeQuestion: 'Und Y?' }, llm: agentLlm() });
    b.runner.auth = { findUserById: async () => ({ _id: OWNER, active: false }) };
    await b.runner.run('r1');
    const d = b.store.docs.get('r1');
    assert.equal(d.status, 'done');
    assert.equal(d.content, 'ALT');
    assert.equal(d.error, 'Besitzer nicht gefunden');
    assert.equal(d.mode, 'research');
    assert.equal(d.modeQuestion, undefined);
    assert.equal(b.calls.length, 0);
  });

  await check('Letzter Versuch bei Vertiefen mit Bericht: done mit error statt failed', async () => {
    const { runner, store } = makeRunner({ doc: { id: 'r1', mode: 'deepen', content: 'ALT', modeQuestion: 'Und Y?' }, llm: agentLlm() });
    runner.auth = { findUserById: async () => { throw new Error('users weg'); } };
    await runner.run('r1');
    const d = store.docs.get('r1');
    assert.equal(d.status, 'done');
    assert.equal(d.content, 'ALT');
    assert.equal(d.error, 'users weg');
    assert.equal(d.mode, 'research');
  });

  await check('Pausiertes Vertiefen abbrechen, dann erneut vertiefen → neue Runde statt der alten Teilaufträge', async () => {
    const { runner, store, calls, live } = makeRunner({
      doc: {
        id: '333333333333333333333333', status: 'paused', mode: 'deepen', modeQuestion: 'Und Y?', content: `${REPORT}\n## Quellen\n- [1] [A](https://a.de/)`, roundsDone: 1,
        tasks: [{ n: 1, round: 2, question: 'Alt', queries: ['alt'], status: 'running', sources: [], via: 'agent' }],
        sourceList: [{ n: 1, url: 'https://a.de/', title: 'A', notes: 'n', relevant: true }],
      },
      llm: agentLlm(),
    });
    const id = '333333333333333333333333';
    const queue = { enqueue: async () => {}, remove: async () => {} };
    const control = new ResearchControlService(store, queue, live, { removeFor: async () => {} }, {}, {}, {}, {}, { emit() {} });
    const owner = { userId: OWNER, username: 'u', role: 'user' };
    await RequestContext.run(owner, undefined, () => control.cancel(id));
    let d = store.docs.get(id);
    assert.equal(d.status, 'done');
    assert.equal(d.mode, 'research');
    assert.equal(d.modeQuestion, undefined);
    assert.equal(d.tasks[0].status, 'failed');
    await RequestContext.run(owner, undefined, () => control.deepen(id, 'Und Z?'));
    store.docs.get(id).status = 'running'; // vom Worker übernommen
    await runner.run(id);
    d = store.docs.get(id);
    assert.equal(d.status, 'done', d.error);
    assert.ok(!calls.some((c) => c.lane === 't1'), 'alter Teilauftrag lief erneut');
    assert.ok(calls.some((c) => c.lane === 't2'), 'neue Runde');
    assert.equal(d.tasks[0].status, 'failed');
    assert.equal(d.tasks[1].status, 'done');
  });

  await check('Fortsetzen: gelesene, nicht relevante Seiten des Teilauftrags werden neu gelesen (gleiche Nummer); fester Ablauf bleibt fest', async () => {
    const fetched = [];
    const a = makeRunner({
      fetched,
      doc: {
        id: 'r1', mode: 'resume', roundsDone: 0,
        tasks: [{ n: 1, round: 1, question: 'Q1', queries: ['q'], status: 'running', sources: [], via: 'agent' }],
        sourceList: [{ n: 1, url: 'https://a.de/', title: 'A', notes: '', relevant: false, task: 1 }],
      },
      llm: agentLlm(),
    });
    await a.runner.run('r1');
    let d = a.store.docs.get('r1');
    assert.equal(d.status, 'done', d.error);
    assert.deepEqual(fetched, ['https://a.de/'], 'Seite erneut gelesen');
    assert.equal(d.sourceList.length, 1, 'keine neue Nummer');
    assert.equal(d.sourceList[0].relevant, true);
    assert.deepEqual(d.tasks[0].sources, [1]);

    // via 'fixed': Fortsetzen mit dem festen Ablauf (keine Werkzeuge auf der Lane t1)
    const fixedLlm = textLlm();
    const b = makeRunner({
      doc: {
        id: 'r1', mode: 'resume', roundsDone: 0,
        tasks: [{ n: 1, round: 1, question: 'Q1', queries: ['q'], status: 'running', sources: [], via: 'fixed' }],
        sourceList: [{ n: 1, url: 'https://a.de/', title: 'A', notes: '', relevant: false, task: 1 }],
      },
      llm: async (c, env) => (c.lane === 't1' ? fixedLlm(c) : agentLlm()(c, env)),
    });
    await b.runner.run('r1');
    d = b.store.docs.get('r1');
    assert.equal(d.status, 'done', d.error);
    const t1 = b.calls.filter((c) => c.lane === 't1');
    assert.ok(t1.length > 0 && t1.every((c) => !hasTools(c)), 'fester Ablauf ohne Werkzeuge');
    assert.equal(d.tasks[0].status, 'done');
    assert.equal(d.tasks[0].via, 'fixed');
    assert.equal(d.sourceList.length, 1);
    assert.equal(d.sourceList[0].relevant, true);
  });

  console.log(`\n${total - failures}/${total} passed`);
  if (total !== EXPECTED_CHECKS) { console.error(`Erwartet ${EXPECTED_CHECKS} Checks, gelaufen ${total}`); process.exit(1); }
  process.exit(failures === 0 ? 0 : 1);
})();
