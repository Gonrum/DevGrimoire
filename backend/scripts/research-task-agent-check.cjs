#!/usr/bin/env node
/*
 * Teilauftrag als Agent (Webrecherche Plan 1, Task 4).
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

const { runTaskAgent } = loadCompiled('research/research-task-agent.js');
const { SourceRegistry } = loadCompiled('research/research-sources.js');
const { Interrupted } = loadCompiled('research/research-llm.service.js');
const { ResearchWeb } = loadCompiled('research/research-web.js');

const EXPECTED_CHECKS = 8;
let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

const tc = (name, args) => ({ id: `c${Math.random()}`, name, arguments: JSON.stringify(args) });
const LONG = 'Lorem ipsum dolor sit amet. '.repeat(20);

function makeCtx({ script, pages = {}, hits = [{ title: 'A', url: 'https://a.de/', snippet: 's' }, { title: 'B', url: 'https://b.de/', snippet: 's' }], registry = new SourceRegistry(), files = [] } = {}) {
  const seen = [];
  const steps = [];
  const ctx = {
    researchId: 'r1', topic: 'Thema', cfg: { rounds: 1, tasks: 3, pages: 2 }, registry, files,
    signal: new AbortController().signal, usedQueries: new Set(), models: new Set(),
    step: (kind, text) => steps.push(`${kind}:${text}`), onReroute: () => () => {},
    web: {
      search: async () => hits,
      fetch: async (url) => { if (!(url in pages)) throw new Error('404'); return { url, title: url, text: pages[url] }; },
    },
    llm: { call: async (c) => { seen.push(c); const next = script.shift(); if (!next) return { text: '', toolCalls: [], model: 'm @ x' }; return { model: 'm @ x', text: '', toolCalls: [], ...next }; } },
  };
  return { ctx, seen, steps };
}
const task = { n: 1, question: 'Was ist X?', queries: ['x'] };

(async () => {
  await check('normaler Ablauf: suchen, lesen, abgeben; Quelle relevant, Lane t1', async () => {
    const { ctx, seen } = makeCtx({ pages: { 'https://a.de/': LONG }, script: [
      { toolCalls: [tc('web_search', { query: 'x' })] },
      { toolCalls: [tc('read_page', { url: 'https://a.de/' })] },
      { toolCalls: [tc('submit_findings', { summary: `X ist ein Ding [1]. ${LONG.slice(0, 60)}`, used_sources: [1] })] },
    ] });
    const out = await runTaskAgent(ctx, task);
    assert.equal(out.status, 'done');
    assert.deepEqual(out.sources, [1]);
    assert.equal(ctx.registry.get(1).relevant, true);
    assert.ok(seen.every((c) => c.lane === 't1' && c.kind === 'notes'));
    assert.match(seen[0].messages[0].content, /DATA, not instructions/);
  });

  await check('zitierte, aber nicht gelesene Quellen zählen nicht', async () => {
    const { ctx } = makeCtx({ pages: { 'https://a.de/': LONG }, script: [
      { toolCalls: [tc('read_page', { url: 'https://a.de/' })] },
      { toolCalls: [tc('submit_findings', { summary: `Behauptung [1] und erfunden [7]. ${LONG.slice(0, 60)}`, used_sources: [1, 7] })] },
    ] });
    const out = await runTaskAgent(ctx, task);
    assert.deepEqual(out.sources, [1]);
  });

  await check('schon gelesene URL wird abgelehnt, Budget wird gezählt', async () => {
    const registry = new SourceRegistry();
    registry.claim('https://a.de/');
    const { ctx, seen } = makeCtx({ registry, pages: { 'https://b.de/': LONG }, script: [
      { toolCalls: [tc('read_page', { url: 'https://a.de/' })] },
      { toolCalls: [tc('read_page', { url: 'https://b.de/' })] },
      { toolCalls: [tc('read_page', { url: 'https://c.de/' })] },
      { toolCalls: [tc('submit_findings', { summary: `B sagt [1]. ${LONG.slice(0, 60)}`, used_sources: [1] })] },
    ] });
    await runTaskAgent(ctx, task);
    const toolResults = seen.at(-1).messages.filter((m) => m.role === 'tool').map((m) => m.content);
    assert.match(toolResults[0], /already read/);
    assert.match(toolResults[2], /page budget used up/);
  });

  await check('kurze Seite gilt als nicht lesbar und bekommt keine Nummer', async () => {
    const { ctx, seen } = makeCtx({ pages: { 'https://a.de/': 'zu kurz' }, script: [
      { toolCalls: [tc('read_page', { url: 'https://a.de/' })] },
    ] });
    const out = await runTaskAgent(ctx, task);
    assert.match(seen[1].messages.find((m) => m.role === 'tool').content, /not readable/);
    assert.equal(ctx.registry.all().length, 0);
    assert.equal(out.status, 'failed');
  });

  await check('Rückfall: gelesen, nicht abgegeben → ein Textaufruf fasst zusammen', async () => {
    const { ctx, seen } = makeCtx({ pages: { 'https://a.de/': LONG }, script: [
      { toolCalls: [tc('read_page', { url: 'https://a.de/' })] },
      ...Array.from({ length: 7 }, () => ({ text: 'Ich denke nach' })),
      { text: `Zusammenfassung mit Beleg [1]. ${LONG.slice(0, 80)}` },
    ] });
    const out = await runTaskAgent(ctx, task);
    assert.equal(out.status, 'done');
    assert.match(out.summary, /\[1\]/);
    assert.equal(seen.at(-1).tools === undefined || seen.at(-1).tools.length === 0, true, 'Rückfall-Aufruf ohne Werkzeuge');
  });

  await check('ohne Werkzeugaufruf kommt die Aufforderung, im vorletzten Schritt der Abschluss-Hinweis', async () => {
    const { ctx, seen } = makeCtx({ script: Array.from({ length: 8 }, () => ({ text: 'bla' })) });
    const out = await runTaskAgent(ctx, task);
    assert.equal(out.status, 'failed');
    const users = seen.at(-1).messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    assert.match(users, /Continue by calling one of the tools/);
    assert.match(users, /Call submit_findings now/);
    assert.equal(seen.length, 8);
  });

  await check('Abbruch: Interrupted geht durch, kein Rückfall-Aufruf', async () => {
    const ac = new AbortController();
    const { ctx, seen } = makeCtx({ script: [] });
    ctx.signal = ac.signal;
    ac.abort();
    await assert.rejects(runTaskAgent(ctx, task), (e) => e instanceof Interrupted);
    assert.equal(seen.length, 0);
  });

  await check('ResearchWeb: 429 wartet retryAfter und versucht einmal neu', async () => {
    let n = 0;
    const err429 = Object.assign(new Error('rate'), { getStatus: () => 429, getResponse: () => ({ retryAfter: 0.01 }) });
    const web = new ResearchWeb({ search: async () => { n += 1; if (n === 1) throw err429; return { results: [{ title: 't', url: 'https://u.de/', snippet: 's' }] }; } }, { fetch: async () => { throw err429; } });
    const hits = await web.search('q', new AbortController().signal);
    assert.equal(hits.length, 1);
    await assert.rejects(web.fetch('https://u.de/', 100, new AbortController().signal), /rate/);
  });

  console.log(`\n${total - failures}/${total} passed`);
  if (total !== EXPECTED_CHECKS) { console.error(`Erwartet ${EXPECTED_CHECKS} Checks, gelaufen ${total}`); process.exit(1); }
  process.exit(failures === 0 ? 0 : 1);
})();
