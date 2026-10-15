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

const EXPECTED_CHECKS = 10;
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
function makeRunner({ doc, llm, pages = { 'https://a.de/': LONG }, capacity = 2, rag = async () => [] }) {
  const store = memStore(doc);
  const live = new ResearchLiveService();
  const notes = [];
  const steps = [];
  const calls = [];
  const cap = { value: capacity };
  const runner = new ResearchRunnerService(
    store, live,
    { call: async (c) => { calls.push(c); return { model: 'm @ x', text: '', toolCalls: [], ...(await llm(c, { store, live })) }; } },
    { search: async () => [{ title: 'A', url: 'https://a.de/', snippet: '' }], fetch: async (url) => { if (!(url in pages)) throw new Error('404'); return { url, title: 'A', text: pages[url] }; } },
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
  if (lastContent(c) === 'Start now.' || c.messages.filter((m) => m.role === 'tool').length === 0) return { toolCalls: [tc('read_page', { url: 'https://a.de/' })] };
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

  console.log(`\n${total - failures}/${total} passed`);
  if (total !== EXPECTED_CHECKS) { console.error(`Erwartet ${EXPECTED_CHECKS} Checks, gelaufen ${total}`); process.exit(1); }
  process.exit(failures === 0 ? 0 : 1);
})();
