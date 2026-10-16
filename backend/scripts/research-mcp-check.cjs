#!/usr/bin/env node
/*
 * Check der MCP-Tools der neuen Webrecherche (Plan 2, Task 1).
 * Prüft Schema, Schreib-Einordnung und Handler gegen Attrappen der Dienste —
 * nicht die Engine selbst (die prüfen die research-*-Checks aus Plan 1).
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

const mcpTools = loadCompiled('mcp-tools.js');
const input = loadCompiled('research/research-tool-input.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = loadCompiled(
  '../node_modules/@modelcontextprotocol/sdk/dist/cjs/types.js',
);

let failures = 0;
let total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); } catch (err) {
    failures += 1;
    console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`);
  }
}

function makeFakeServer() {
  let callHandler = null;
  let listHandler = null;
  return {
    setRequestHandler(schema, fn) {
      if (schema === CallToolRequestSchema) callHandler = fn;
      else if (schema === ListToolsRequestSchema) listHandler = fn;
    },
    invoke(name, args) { return callHandler({ params: { name, arguments: args } }); },
    list() { return listHandler(); },
  };
}

function unwrap(res) {
  assert.ok(res && Array.isArray(res.content) && res.content.length > 0, 'expected content[]');
  const text = res.content[0].text;
  if (res.isError) return { error: text };
  return { value: JSON.parse(text) };
}

const ID = '0123456789abcdef01234567';

function makeServices({ control = {}, research = {} } = {}) {
  const noop = new Proxy({}, {
    get: (_t, prop) => (prop === 'then' ? undefined : () => Promise.resolve(undefined)),
  });
  const names = [
    'projectsService', 'todosService', 'sessionsService', 'knowledgeService', 'changelogService',
    'milestonesService', 'activitiesService', 'pushService', 'environmentsService', 'secretsService',
    'manualsService', 'researchTopicService', 'researchRunService', 'researchArtifactService',
    'researchAgentService', 'settingsService', 'schemasService', 'dependenciesService', 'featuresService',
    'soulsService', 'harnessService', 'commitsService', 'ragService', 'recurringTasksService',
    'workflowsService', 'workflowEngineService', 'nodeRegistry', 'customerTemplatesService',
    'validationReportsService', 'docUpdateProposalsService', 'knowledgeGraphService', 'oracleService',
    'snippetsService', 'attachmentsService', 'questionsService', 'authService', 'customersService',
    'contactsService', 'monitoringService', 'logsService', 'releasesService', 'chatService',
    'chatContextService', 'webSearchService', 'readabilityService', 'workspacesService', 'workspaceClient',
    'workspaceGitTokens', 'workspaceCliToken', 'sshService', 'sshSessionService', 'httpRequestsService',
    'stackService', 'kubeClustersService', 'kubeResourcesService', 'kubeLogsService', 'kubeClientService',
    'kubeWritesService',
  ];
  const services = Object.fromEntries(names.map((n) => [n, noop]));
  return {
    ...services,
    notificationsService: { create: () => Promise.resolve() },
    chatLlmService: { isEnabled: async () => true },
    kubeAuditService: { record: async () => {} },
    researchService: { ...research },
    researchControlService: { ...control },
  };
}

function setup(opts) {
  const server = makeFakeServer();
  mcpTools.registerMcpTools(server, makeServices(opts));
  return server;
}

(async () => {
  await check('readTopics: topic (String), topics (Array), topics als String, Leerwerte raus', () => {
    assert.deepEqual(input.readTopics({ topic: '  Thema A ' }), ['Thema A']);
    assert.deepEqual(input.readTopics({ topics: ['A1x', ' ', 'B2y'] }), ['A1x', 'B2y']);
    assert.deepEqual(input.readTopics({ topics: 'Einzelthema' }), ['Einzelthema']);
    assert.deepEqual(input.readTopics({ topic: 'Eins', topics: ['Zwei'] }), ['Eins', 'Zwei']);
    assert.deepEqual(input.readTopics({ topics: [1, null, 'Gültig'] }), ['Gültig']);
    assert.deepEqual(input.readTopics({}), []);
  });

  await check('readDepth: Default normal, ungültig → Fehler', () => {
    assert.equal(input.readDepth({}), 'normal');
    assert.equal(input.readDepth({ depth: 'quick' }), 'quick');
    assert.throws(() => input.readDepth({ depth: 'tief' }), /depth/);
  });

  await check('Schema: alle neuen Tools gelistet, Pflichtfelder gesetzt', async () => {
    const server = setup();
    const { tools } = await server.list();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const n of ['research_start', 'research_status', 'research_cancel', 'research_pause',
      'research_resume', 'research_deepen', 'research_move']) {
      assert.ok(byName[n], `${n} fehlt`);
    }
    assert.deepEqual(byName.research_status.inputSchema.required, ['id']);
    assert.deepEqual(byName.research_deepen.inputSchema.required, ['id', 'question']);
    assert.ok(!('files' in byName.research_start.inputSchema.properties), 'Dateien nur über REST');
  });

  await check('isWriteTool: start/cancel/pause/resume/deepen/move schreibend, status lesend', () => {
    for (const n of ['research_start', 'research_cancel', 'research_pause', 'research_resume',
      'research_deepen', 'research_move']) {
      assert.equal(mcpTools.isWriteTool(n), true, n);
    }
    assert.equal(mcpTools.isWriteTool('research_status'), false);
  });

  await check('research_start: reicht Themen, Fokus, Tiefe durch, ohne Dateien', async () => {
    const calls = [];
    const server = setup({ control: { start: async (i) => { calls.push(i); return [ID]; } } });
    const out = unwrap(await server.invoke('research_start', { topic: 'Vektordatenbanken', focus: 'Self-Hosting', depth: 'quick' }));
    assert.deepEqual(out.value, { ids: [ID] });
    assert.deepEqual(calls[0], { topics: ['Vektordatenbanken'], focus: 'Self-Hosting', depth: 'quick', files: [] });
  });

  await check('research_start ohne Thema → Fehler, Dienst nicht gerufen', async () => {
    let called = false;
    const server = setup({ control: { start: async () => { called = true; return []; } } });
    const out = unwrap(await server.invoke('research_start', { topics: [] }));
    assert.ok(out.error && /topic/.test(out.error), out.error);
    assert.equal(called, false);
  });

  await check('research_status: Position bei wartend, Bericht nur bei done, keine Dateitexte', async () => {
    const queued = { _id: ID, title: 'T', status: 'queued', content: '', files: [{ n: 1, name: 'a.txt', text: 'GEHEIM' }], tasks: [{ n: 1, round: 1, question: 'F?', status: 'queued', queries: [], sources: [] }], sourceList: [] };
    const server = setup({
      research: { findVisibleById: async () => queued },
      control: { queuePositions: async () => [{ id: ID, position: 2 }] },
    });
    const a = unwrap(await server.invoke('research_status', { id: ID })).value;
    assert.equal(a.status, 'queued');
    assert.equal(a.position, 2);
    assert.equal(a.report, undefined);
    assert.ok(!JSON.stringify(a).includes('GEHEIM'));
    assert.deepEqual(a.tasks, [{ n: 1, question: 'F?', status: 'queued' }]);

    const done = { ...queued, status: 'done', content: 'Bericht [1]', sourceList: [{ n: 1, url: 'https://a.de', title: 'A', relevant: true, notes: 'lang' }] };
    const server2 = setup({ research: { findVisibleById: async () => done }, control: { queuePositions: async () => [] } });
    const b = unwrap(await server2.invoke('research_status', { id: ID })).value;
    assert.equal(b.report, 'Bericht [1]');
    assert.equal(b.position, undefined);
    assert.deepEqual(b.sources, [{ n: 1, url: 'https://a.de', title: 'A' }]);
  });

  await check('research_status auf fremde/fehlende Recherche → Fehler, keine Existenz-Auskunft', async () => {
    const server = setup({
      research: { findVisibleById: async () => { const e = new Error(`Research ${ID} not found`); e.status = 404; throw e; } },
      control: { queuePositions: async () => [] },
    });
    const out = unwrap(await server.invoke('research_status', { id: ID }));
    assert.ok(out.error && /not found/i.test(out.error), out.error);
  });

  await check('Steuerung: cancel/pause/resume/deepen/move rufen den Dienst mit den Argumenten', async () => {
    const calls = [];
    const rec = (name) => async (...args) => { calls.push([name, ...args]); };
    const server = setup({ control: {
      cancel: rec('cancel'), pause: rec('pause'), resume: rec('resume'), deepen: rec('deepen'), move: rec('move'),
    } });
    for (const n of ['cancel', 'pause', 'resume']) {
      assert.deepEqual(unwrap(await server.invoke(`research_${n}`, { id: ID })).value, { ok: true, id: ID });
    }
    unwrap(await server.invoke('research_deepen', { id: ID, question: 'Und die Kosten?' }));
    unwrap(await server.invoke('research_move', { id: ID, projectId: ID }));
    assert.deepEqual(calls, [
      ['cancel', ID], ['pause', ID], ['resume', ID],
      ['deepen', ID, 'Und die Kosten?'],
      ['move', ID, { projectId: ID, customerId: undefined }],
    ]);
  });

  await check('research_move: weder projectId noch customerId bzw. beide → Fehler', async () => {
    const server = setup({ control: { move: async () => {} } });
    assert.ok(unwrap(await server.invoke('research_move', { id: ID })).error);
    assert.ok(unwrap(await server.invoke('research_move', { id: ID, projectId: ID, customerId: ID })).error);
  });

  await check('research_list ohne Scope: persönlicher Speicher, kompakt', async () => {
    const server = setup({ research: { listMine: async () => [{ _id: ID, title: 'Mein', status: 'running', content: 'X', sources: ['u'], __v: 0 }] } });
    const out = unwrap(await server.invoke('research_list', {})).value;
    assert.equal(out.length, 1);
    assert.equal(out[0].title, 'Mein');
    assert.equal(out[0].status, 'running');
    assert.equal(out[0].content, undefined);
    assert.equal(out[0].sourceCount, 1);
  });

  console.log(`\n${total - failures}/${total} passed`);
  process.exit(failures ? 1 : 0);
})();
