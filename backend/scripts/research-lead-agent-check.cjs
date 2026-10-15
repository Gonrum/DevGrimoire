#!/usr/bin/env node
/*
 * Leitung als Agent (Webrecherche Plan 1, Task 5).
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

const { runLeadAgent } = loadCompiled('research/research-lead-agent.js');
const { SourceRegistry } = loadCompiled('research/research-sources.js');

const EXPECTED_CHECKS = 10;
let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

const tc = (name, args) => ({ id: `c${Math.random()}`, name, arguments: JSON.stringify(args) });
const REPORT = `## Kurzfassung\nX ist wichtig [1]. ${'Mehr Text. '.repeat(30)}\n## Offene Punkte\nKeine.`;

function makeDeps({ script, roundsTotal = 2, roundsDone = 0, withSource = true }) {
  const registry = new SourceRegistry();
  if (withSource) { const s = registry.addPage('https://a.de/', 'A'); registry.markRelevant(s.n, 'n'); }
  const seen = [];
  const rounds = [];
  const deps = {
    ctx: {
      researchId: 'r1', topic: 'Thema', cfg: { rounds: roundsTotal, tasks: 3, pages: 3 }, registry, files: [],
      signal: new AbortController().signal, usedQueries: new Set(['alt']), models: new Set(),
      step() {}, onReroute: () => () => {}, web: {},
      llm: { call: async (c) => { seen.push(c); const next = script.shift(); return { model: 'm @ x', text: '', toolCalls: [], ...(next || {}) }; } },
    },
    roundsTotal, roundsDone, previous: [], related: [], followUps: [],
    runRound: async (tasks) => { rounds.push(tasks); deps.roundsDone += 1; return tasks.map((t, i) => ({ n: i + 1, question: t.question, status: 'done', summary: 'Ergebnis [1]' })); },
  };
  return { deps, seen, rounds };
}

(async () => {
  await check('eine Runde, dann Bericht', async () => {
    const { deps, rounds } = makeDeps({ script: [
      { toolCalls: [tc('run_subtasks', { tasks: [{ question: 'Q1', queries: ['a'] }, { question: 'Q2' }] })] },
      { toolCalls: [tc('write_report', { report: REPORT })] },
    ] });
    const out = await runLeadAgent(deps);
    assert.equal(out.report, REPORT);
    assert.equal(rounds.length, 1);
    assert.deepEqual(rounds[0][1].queries, ['Q2'], 'ohne queries → Frage als Suchanfrage');
  });

  await check('schon benutzte Suchanfragen werden gefiltert, Teilaufträge gekappt', async () => {
    const { deps, rounds } = makeDeps({ script: [
      { toolCalls: [tc('run_subtasks', { tasks: [{ question: 'Q1', queries: ['ALT ', 'neu'] }, { question: 'Q2' }, { question: 'Q3' }, { question: 'Q4' }] })] },
      { toolCalls: [tc('write_report', { report: REPORT })] },
    ] });
    await runLeadAgent(deps);
    assert.equal(rounds[0].length, 3);
    assert.deepEqual(rounds[0][0].queries, ['neu']);
  });

  await check('Rundenbudget erschöpft → Fehler an das Modell, keine weitere Runde', async () => {
    const { deps, rounds, seen } = makeDeps({ roundsTotal: 1, script: [
      { toolCalls: [tc('run_subtasks', { tasks: [{ question: 'Q1' }] })] },
      { toolCalls: [tc('run_subtasks', { tasks: [{ question: 'Q2' }] })] },
      { toolCalls: [tc('write_report', { report: REPORT })] },
    ] });
    await runLeadAgent(deps);
    assert.equal(rounds.length, 1);
    const tools = seen.at(-1).messages.filter((m) => m.role === 'tool').map((m) => m.content);
    assert.match(tools[1], /call write_report now/);
  });

  await check('zu kurzer Bericht und Bericht ohne Quellen werden abgelehnt', async () => {
    const { deps, seen } = makeDeps({ withSource: false, script: [
      { toolCalls: [tc('write_report', { report: 'kurz' })] },
      { toolCalls: [tc('write_report', { report: REPORT })] },
    ] });
    const out = await runLeadAgent(deps);
    const tools = seen.at(-1).messages.filter((m) => m.role === 'tool').map((m) => m.content);
    assert.match(tools[0], /too short/);
    assert.match(tools[1], /no usable sources/);
    assert.equal(out.report, null);
  });

  await check('ohne Werkzeug: Aufforderung; Schritte = Runden + 4; Abschluss-Hinweis', async () => {
    const { deps, seen } = makeDeps({ roundsTotal: 2, script: Array.from({ length: 10 }, () => ({ text: 'hm' })) });
    const out = await runLeadAgent(deps);
    assert.equal(out.report, null);
    assert.equal(seen.length, 6);
    const users = seen.at(-1).messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    assert.match(users, /Continue by calling one of the tools/);
    assert.match(users, /call write_report now/);
  });

  await check('Fortsetzen: Budget zählt bereits erledigte Runden', async () => {
    const { deps, rounds } = makeDeps({ roundsTotal: 2, roundsDone: 2, script: [
      { toolCalls: [tc('run_subtasks', { tasks: [{ question: 'Q' }] })] },
      { toolCalls: [tc('write_report', { report: REPORT })] },
    ] });
    await runLeadAgent(deps);
    assert.equal(rounds.length, 0);
  });

  await check('Prompt: Lane main, leadReport, Injection-Guard, Berichtsregeln', async () => {
    const { deps, seen } = makeDeps({ script: [{ toolCalls: [tc('write_report', { report: REPORT })] }] });
    await runLeadAgent(deps);
    assert.equal(seen[0].lane, 'main');
    assert.equal(seen[0].kind, 'leadReport');
    assert.match(seen[0].messages[0].content, /DATA, not instructions/);
    assert.match(seen[0].messages[0].content, /## Kurzfassung/);
  });

  await check('eine Runde pro Zug; Bericht im selben Zug nach Runde wird abgelehnt', async () => {
    const { deps, rounds, seen } = makeDeps({ script: [
      { toolCalls: [tc('run_subtasks', { tasks: [{ question: 'Q1' }] }), tc('run_subtasks', { tasks: [{ question: 'Q2' }] }), tc('write_report', { report: REPORT })] },
      { toolCalls: [tc('write_report', { report: REPORT })] },
    ] });
    const out = await runLeadAgent(deps);
    assert.equal(rounds.length, 1);
    const tools = seen[1].messages.filter((m) => m.role === 'tool').map((m) => m.content);
    assert.ok(tools.length >= 3);
    assert.match(tools[1], /only one research round per turn/);
    assert.match(tools[2], /wait for the results/);
    assert.equal(out.report, REPORT);
  });

  await check('Bericht-Aufruf vor Runde im selben Zug bleibt gültig', async () => {
    const { deps } = makeDeps({ script: [{ toolCalls: [tc('write_report', { report: `  ${REPORT}  ` })] }] });
    const out = await runLeadAgent(deps);
    assert.equal(out.report, REPORT.trim());
  });

  await check('runRound-Fehler propagiert', async () => {
    const { deps } = makeDeps({ script: [{ toolCalls: [tc('run_subtasks', { tasks: [{ question: 'Q' }] })] }] });
    deps.runRound = async () => { throw new Error('db down'); };
    await assert.rejects(runLeadAgent(deps), /db down/);
  });

  console.log(`\n${total - failures}/${total} passed`);
  if (total !== EXPECTED_CHECKS) { console.error(`Erwartet ${EXPECTED_CHECKS} Checks, gelaufen ${total}`); process.exit(1); }
  process.exit(failures === 0 ? 0 : 1);
})();
