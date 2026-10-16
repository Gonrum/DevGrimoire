#!/usr/bin/env node
/*
 * Chat-Tools der Webrecherche (Plan 2, Task 2): research_start ist schreibend,
 * merkt in einer Projekt-Session das Projekt vor, research_get gibt keinen Dateitext aus.
 * Lädt aus dist/; vorher `npm run build`.
 */
const assert = require('node:assert/strict');
const m = require('../dist/chat/chat-tools');

const ID = '0123456789abcdef01234567';
let failures = 0;
let total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); } catch (err) {
    failures += 1;
    console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`);
  }
}

/** Dienst ohne Nest: nur die Felder, die die Research-Zweige brauchen. */
function makeService({ start, findVisibleById } = {}) {
  const svc = Object.create(m.ChatToolsService.prototype);
  svc.researchControl = { start: start || (async () => [ID]) };
  svc.research = { findVisibleById: findVisibleById || (async () => null) };
  svc.auditWrite = async () => {};
  return svc;
}

(async () => {
  await check('research_start: Gruppe knowledge_write, schreibend, Definition vorhanden, nicht blockiert', () => {
    assert.ok(m.TOOL_GROUPS.knowledge_write.includes('research_start'));
    assert.ok(m.WRITE_TOOL_NAMES.has('research_start'));
    assert.ok(m.TOOL_DEFINITIONS.research_start, 'Definition fehlt');
    assert.ok(!m.PERMANENTLY_BLOCKED_TOOLS.has('research_start'));
    assert.ok(!('files' in m.TOOL_DEFINITIONS.research_start.parameters.properties));
  });

  await check('research_start in Projekt-Session: Vormerkung project:<id>', async () => {
    const calls = [];
    const svc = makeService({ start: async (i) => { calls.push(i); return [ID]; } });
    const res = await svc.execute('research_start', { topic: 'Thema X' }, { projectId: ID }, ['research_start']);
    assert.equal(res.success, true, res.error);
    assert.deepEqual(res.result, { ids: [ID] });
    assert.deepEqual(calls[0], { topics: ['Thema X'], focus: undefined, depth: 'normal', files: [], moveTargetHint: `project:${ID}` });
  });

  await check('research_start ohne Projekt: keine Vormerkung; topics als String', async () => {
    const calls = [];
    const svc = makeService({ start: async (i) => { calls.push(i); return [ID]; } });
    const res = await svc.execute('research_start', { topics: 'Einzelthema', depth: 'quick' }, {}, ['research_start']);
    assert.equal(res.success, true, res.error);
    assert.deepEqual(calls[0], { topics: ['Einzelthema'], focus: undefined, depth: 'quick', files: [] });
  });

  await check('research_start ohne Thema / ungültige Tiefe → success false, Dienst nicht gerufen', async () => {
    let called = false;
    const svc = makeService({ start: async () => { called = true; return []; } });
    const a = await svc.execute('research_start', {}, {}, ['research_start']);
    const b = await svc.execute('research_start', { topic: 'Thema', depth: 'tief' }, {}, ['research_start']);
    assert.equal(a.success, false);
    assert.equal(b.success, false);
    assert.equal(called, false);
  });

  await check('research_start nicht in der Allowlist → abgelehnt', async () => {
    const svc = makeService();
    const res = await svc.execute('research_start', { topic: 'Thema' }, {}, ['research_get']);
    assert.equal(res.success, false);
  });

  await check('research_get: Dateinamen ja, Dateitext nein', async () => {
    const doc = { _id: ID, title: 'T', content: 'B', files: [{ n: 1, name: 'a.txt', text: 'GEHEIM' }] };
    const svc = makeService({ findVisibleById: async () => ({ toObject: () => doc, ...doc }) });
    const res = await svc.execute('research_get', { id: ID }, {}, ['research_get']);
    assert.equal(res.success, true, res.error);
    assert.ok(!JSON.stringify(res.result).includes('GEHEIM'));
    assert.deepEqual(res.result.files, [{ n: 1, name: 'a.txt' }]);
  });

  console.log(`\n${total - failures}/${total} passed`);
  process.exit(failures ? 1 : 0);
})();
