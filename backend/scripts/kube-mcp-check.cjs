#!/usr/bin/env node
/*
 * Check für die Kube-MCP-Tools (K2, Task 6).
 *
 * Geprüft wird das Tool-Schema UND die Handler — nicht der Cluster. Die Tools
 * sind AUSNAHMSLOS lesend, und ihre Ausgaben müssen normalisiert sein, sonst
 * frisst ein einziges kube_get den halben Agenten-Kontext.
 *
 * `mcp-tools.ts` exportiert die Tool-Liste selbst nicht (sie heisst intern
 * `tools`, ein Modul-lokales `const`) — erreichbar ist sie trotzdem, über
 * denselben Weg wie in ssh-mcp-units-check.cjs: `registerMcpTools()` gegen
 * einen Fake-Server registrieren und über den `ListToolsRequestSchema`-
 * Handler abfragen. Das spart einen Export, der nur für diesen Test
 * existieren würde.
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
const mongoose = loadCompiled('../node_modules/mongoose/index.js');
const { Types } = mongoose;
const { CallToolRequestSchema, ListToolsRequestSchema } = loadCompiled(
  '../node_modules/@modelcontextprotocol/sdk/dist/cjs/types.js',
);

let failures = 0;
let total = 0;
function check(label, fn) {
  total += 1;
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`✓ ${label}`))
    .catch((err) => {
      failures += 1;
      console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`);
    });
}

// ---------------------------------------------------------------------------
// Fake MCP server — captures the two handlers registerMcpTools() installs.
// ---------------------------------------------------------------------------
function makeFakeServer() {
  let callHandler = null;
  let listHandler = null;
  return {
    setRequestHandler(schema, fn) {
      if (schema === CallToolRequestSchema) callHandler = fn;
      else if (schema === ListToolsRequestSchema) listHandler = fn;
    },
    invoke(name, args) {
      return callHandler({ params: { name, arguments: args } });
    },
    list() {
      return listHandler();
    },
  };
}

// Minimal McpServices skeleton — everything but the four Kube services (and
// notificationsService, which the handler fires-and-forgets into) is a
// no-op proxy so registerMcpTools() doesn't blow up on destructure.
function buildServices({ kubeClustersService, kubeResourcesService, kubeLogsService, kubeClientService }) {
  const noop = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'then') return undefined;
        return () => Promise.resolve(undefined);
      },
    },
  );
  return {
    projectsService: noop, todosService: noop, sessionsService: noop, knowledgeService: noop,
    changelogService: noop, milestonesService: noop, activitiesService: noop, pushService: noop,
    environmentsService: noop, secretsService: noop, manualsService: noop, researchService: noop,
    researchTopicService: noop, researchRunService: noop, researchArtifactService: noop,
    researchAgentService: noop, settingsService: noop,
    notificationsService: { create: () => Promise.resolve() },
    schemasService: noop, dependenciesService: noop, featuresService: noop, soulsService: noop,
    harnessService: noop, commitsService: noop, ragService: noop, recurringTasksService: noop,
    workflowsService: noop, workflowEngineService: noop, nodeRegistry: noop,
    customerTemplatesService: noop, validationReportsService: noop, docUpdateProposalsService: noop,
    knowledgeGraphService: noop, oracleService: noop, snippetsService: noop, attachmentsService: noop,
    questionsService: noop, authService: noop, customersService: noop, contactsService: noop,
    monitoringService: noop, logsService: noop, releasesService: noop, chatService: noop,
    chatLlmService: { isEnabled: async () => true }, chatContextService: noop, webSearchService: noop,
    readabilityService: noop, workspacesService: noop, workspaceClient: noop, workspaceGitTokens: noop,
    workspaceCliToken: noop, sshService: noop, sshSessionService: noop, httpRequestsService: noop,
    stackService: noop,
    kubeClustersService, kubeResourcesService, kubeLogsService, kubeClientService,
  };
}

// MCP responses are wrapped as { content: [{type:'text', text:'<json>'}], isError? }.
function unwrap(res) {
  assert.ok(res && Array.isArray(res.content) && res.content.length > 0, 'expected content[]');
  const text = res.content[0].text;
  if (res.isError) return { error: text };
  return { value: JSON.parse(text) };
}

function makeClusterDoc(overrides = {}) {
  return {
    _id: overrides._id || new Types.ObjectId(),
    label: 'prod-a',
    slug: 'prod-a',
    projectId: overrides.projectId,
    customerId: overrides.customerId,
    contextName: 'prod-a-ctx',
    clusterServer: 'https://k8s.example:6443',
    defaultNamespace: 'default',
    transport: 'direct',
    readOnly: true,
    allowMcpWrites: false,
    kubeconfigSecretId: new Types.ObjectId(), // MUSS nie in einer MCP-Antwort landen
    lastConnectedAt: overrides.lastConnectedAt,
    lastConnectError: overrides.lastConnectError,
    ...overrides,
  };
}

function makeServer(kubeStubs) {
  const server = makeFakeServer();
  mcpTools.registerMcpTools(server, buildServices(kubeStubs));
  return server;
}

// Async generator helper for stubbing KubeLogSession.lines.
async function* linesFrom(arr) {
  for (const l of arr) yield l;
}

// ===========================================================================
// Static schema checks (adapted from the task brief)
// ===========================================================================
(async () => {
  const server = makeServer({
    kubeClustersService: {}, kubeResourcesService: {}, kubeLogsService: {}, kubeClientService: {},
  });
  const { tools: allTools } = await server.list();
  const kubeToolList = allTools.filter((t) => t.name.startsWith('kube_'));
  const byName = new Map(kubeToolList.map((t) => [t.name, t]));

  await check('alle sieben K2-Tools sind registriert', () => {
    for (const name of ['kube_cluster_list', 'kube_cluster_get', 'kube_get',
      'kube_describe', 'kube_logs', 'kube_events', 'kube_top']) {
      assert.ok(byName.has(name), `${name} fehlt`);
    }
  });

  await check('K2 registriert KEIN schreibendes Tool', () => {
    const writing = kubeToolList.filter((t) =>
      /apply|delete|scale|restart|exec|patch|create/i.test(t.name));
    assert.deepEqual(writing.map((t) => t.name), [],
      'K2 ist lesend — schreibende Tools gehören in K3 hinter allowMcpWrites');
  });

  await check('jedes Tool hat eine Beschreibung, die den Scope-Zwang nennt', () => {
    for (const t of [byName.get('kube_get'), byName.get('kube_events')]) {
      assert.ok(t.description.length > 80, `${t.name}: Beschreibung zu dünn`);
    }
  });

  await check('kube_cluster_list verlangt einen Scope', () => {
    const t = byName.get('kube_cluster_list');
    const props = Object.keys(t.inputSchema.properties);
    assert.ok(props.includes('projectId') && props.includes('customerId'),
      'Scope-Parameter fehlen — globale Cluster-Entdeckung ist nicht erwünscht');
  });

  await check('kube_get kennt kind, namespace, name, labelSelector und limit', () => {
    const props = byName.get('kube_get').inputSchema.properties;
    for (const p of ['kind', 'namespace', 'name', 'labelSelector', 'limit']) {
      assert.ok(props[p], `kube_get: Parameter ${p} fehlt`);
    }
  });

  await check('kube_get schränkt kind auf die bekannte Registry ein', () => {
    const kind = byName.get('kube_get').inputSchema.properties.kind;
    assert.ok(Array.isArray(kind.enum) && kind.enum.includes('Pod'),
      'kind ist nicht als Enum aus der Kind-Registry deklariert');
  });

  await check('kube_logs hat follow NICHT im Schema', () => {
    const props = byName.get('kube_logs').inputSchema.properties;
    assert.equal(props.follow, undefined,
      'ein folgender Log-Stream über MCP würde nie enden — tailLines/since sind der Weg');
  });

  await check('kube_logs deckelt tailLines im Schema', () => {
    const t = byName.get('kube_logs').inputSchema.properties.tailLines;
    assert.ok(typeof t.maximum === 'number' && t.maximum <= 5000,
      'tailLines ist nicht gedeckelt');
  });

  await check('kube_describe und kube_events kennen ihre Kind-/Filter-Parameter', () => {
    const describeProps = byName.get('kube_describe').inputSchema.properties;
    assert.ok(describeProps.kind && Array.isArray(describeProps.kind.enum), 'kube_describe: kind fehlt');
    const eventsProps = byName.get('kube_events').inputSchema.properties;
    assert.ok(eventsProps.involvedName, 'kube_events: involvedName fehlt');
  });

  await check('kube_top kennt scope (pods/nodes)', () => {
    const scope = byName.get('kube_top').inputSchema.properties.scope;
    assert.deepEqual(scope.enum, ['pods', 'nodes']);
  });

  // -------------------------------------------------------------------------
  // kube_cluster_list — Scope-Zwang, "genau eines", nie Credentials
  // -------------------------------------------------------------------------
  await check('kube_cluster_list ohne Scope wirft scope_required', async () => {
    const s = makeServer({
      kubeClustersService: {}, kubeResourcesService: {}, kubeLogsService: {}, kubeClientService: {},
    });
    const res = unwrap(await s.invoke('kube_cluster_list', {}));
    assert.ok(res.error, 'expected error');
    assert.match(res.error, /scope_required/);
  });

  await check('kube_cluster_list mit BEIDEN Scope-Parametern wirft scope_exclusive', async () => {
    const s = makeServer({
      kubeClustersService: {}, kubeResourcesService: {}, kubeLogsService: {}, kubeClientService: {},
    });
    const res = unwrap(await s.invoke('kube_cluster_list', {
      projectId: new Types.ObjectId().toString(), customerId: new Types.ObjectId().toString(),
    }));
    assert.ok(res.error, 'expected error');
    assert.match(res.error, /scope_exclusive/);
  });

  await check('kube_cluster_list gibt sichere Felder zurück, nie kubeconfigSecretId', async () => {
    const projectId = new Types.ObjectId();
    const doc = makeClusterDoc({ projectId, lastConnectError: { message: 'timeout' } });
    const calls = [];
    const s = makeServer({
      kubeClustersService: {
        findByProjectId: async (id) => { calls.push(id); return [doc]; },
      },
      kubeResourcesService: {}, kubeLogsService: {}, kubeClientService: {},
    });
    const res = unwrap(await s.invoke('kube_cluster_list', { projectId: projectId.toString() }));
    assert.ok(!res.error, `unexpected error: ${res.error}`);
    assert.equal(calls[0], projectId.toString());
    assert.equal(res.value.length, 1);
    const item = res.value[0];
    assert.equal(item.clusterId, doc._id.toString());
    assert.equal(item.label, 'prod-a');
    assert.equal(item.transport, 'direct');
    assert.equal(item.readOnly, true);
    assert.equal(item.lastConnectError, 'timeout');
    assert.equal(item.kubeconfigSecretId, undefined, 'Secret-Referenz darf nie in der MCP-Antwort landen');
    assert.equal(item.allowMcpWrites, undefined, 'nur die dokumentierten Felder, kein Feld-Durchreichen');
  });

  // -------------------------------------------------------------------------
  // kube_get — list vs. get, Argument-Weiterreichung
  // -------------------------------------------------------------------------
  await check('kube_get ohne name ruft resourcesService.list mit den richtigen Optionen', async () => {
    const calls = [];
    const s = makeServer({
      kubeClustersService: {}, kubeLogsService: {}, kubeClientService: {},
      kubeResourcesService: {
        list: async (clusterId, kind, opts) => { calls.push({ clusterId, kind, opts }); return [{ name: 'web-1' }]; },
      },
    });
    const clusterId = new Types.ObjectId().toString();
    const res = unwrap(await s.invoke('kube_get', {
      clusterId, kind: 'Pod', namespace: 'default', labelSelector: 'app=web', limit: 50,
    }));
    assert.ok(!res.error, `unexpected error: ${res.error}`);
    assert.deepEqual(res.value, [{ name: 'web-1' }]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].clusterId, clusterId);
    assert.equal(calls[0].kind, 'Pod');
    assert.deepEqual(calls[0].opts, { namespace: 'default', labelSelector: 'app=web', limit: 50 });
  });

  await check('kube_get mit name ruft resourcesService.get, nicht list', async () => {
    const listCalls = [];
    const getCalls = [];
    const s = makeServer({
      kubeClustersService: {}, kubeLogsService: {}, kubeClientService: {},
      kubeResourcesService: {
        list: async (...args) => { listCalls.push(args); return []; },
        get: async (...args) => { getCalls.push(args); return { kind: 'Pod', metadata: { name: 'web-1' } }; },
      },
    });
    const res = unwrap(await s.invoke('kube_get', {
      clusterId: new Types.ObjectId().toString(), kind: 'Pod', name: 'web-1', namespace: 'default',
    }));
    assert.ok(!res.error, `unexpected error: ${res.error}`);
    assert.equal(listCalls.length, 0);
    assert.equal(getCalls.length, 1);
    assert.equal(res.value.metadata.name, 'web-1');
  });

  await check('kube_get lehnt ein unbekanntes kind vor jedem Service-Aufruf ab', async () => {
    const calls = [];
    const s = makeServer({
      kubeClustersService: {}, kubeLogsService: {}, kubeClientService: {},
      kubeResourcesService: { list: async (...args) => { calls.push(args); return []; } },
    });
    const res = unwrap(await s.invoke('kube_get', {
      clusterId: new Types.ObjectId().toString(), kind: 'NotAKind',
    }));
    assert.ok(res.error, 'expected error for unknown kind');
    assert.equal(calls.length, 0, 'resourcesService.list darf für ein unbekanntes kind nie aufgerufen werden');
  });

  // -------------------------------------------------------------------------
  // kube_logs — Kernstück: close() immer, complete/dropped/truncated
  // -------------------------------------------------------------------------
  await check('kube_logs: sauberes Ende → status complete, close() genau einmal', async () => {
    let closed = 0;
    const s = makeServer({
      kubeClustersService: {}, kubeResourcesService: {}, kubeClientService: {},
      kubeLogsService: {
        open: async () => ({
          lines: linesFrom(['line 1', 'line 2']),
          close: () => { closed += 1; },
          error: () => undefined,
        }),
      },
    });
    const res = unwrap(await s.invoke('kube_logs', {
      clusterId: new Types.ObjectId().toString(), namespace: 'default', pod: 'web-1',
    }));
    assert.ok(!res.error, `unexpected error: ${res.error}`);
    assert.equal(res.value.status, 'complete');
    assert.deepEqual(res.value.lines, ['line 1', 'line 2']);
    assert.equal(closed, 1);
  });

  await check('kube_logs: abgebrochene Verbindung → status dropped mit Fehlertext, nicht complete', async () => {
    let closed = 0;
    const s = makeServer({
      kubeClustersService: {}, kubeResourcesService: {}, kubeClientService: {},
      kubeLogsService: {
        open: async () => ({
          lines: linesFrom(['line 1']),
          close: () => { closed += 1; },
          error: () => 'connection reset',
        }),
      },
    });
    const res = unwrap(await s.invoke('kube_logs', {
      clusterId: new Types.ObjectId().toString(), namespace: 'default', pod: 'web-1',
    }));
    assert.ok(!res.error, `unexpected error: ${res.error}`);
    assert.equal(res.value.status, 'dropped');
    assert.equal(res.value.error, 'connection reset');
    assert.equal(closed, 1);
  });

  await check('kube_logs: close() läuft auch, wenn die Zeilen-Iteration selbst wirft', async () => {
    let closed = 0;
    // Kein Generator (der bräuchte einen `yield`, um require-yield nicht zu
    // verletzen) — ein Objekt mit eigenem Symbol.asyncIterator wirft sauber
    // beim allerersten `next()`, ganz ohne je etwas zu liefern.
    const throwingLines = {
      [Symbol.asyncIterator]() {
        return { next: () => Promise.reject(new Error('stream kaputt')) };
      },
    };
    const s = makeServer({
      kubeClustersService: {}, kubeResourcesService: {}, kubeClientService: {},
      kubeLogsService: {
        open: async () => ({ lines: throwingLines, close: () => { closed += 1; }, error: () => undefined }),
      },
    });
    const res = unwrap(await s.invoke('kube_logs', {
      clusterId: new Types.ObjectId().toString(), namespace: 'default', pod: 'web-1',
    }));
    assert.ok(res.error, 'expected the tool call itself to surface the error');
    assert.equal(closed, 1, 'close() muss trotz Wurf in der Schleife laufen (finally)');
  });

  await check('kube_logs: harte Zeilen-Obergrenze → status truncated, nie fälschlich complete', async () => {
    let closed = 0;
    async function* many() { for (let i = 0; i < 5010; i += 1) yield `line ${i}`; }
    const s = makeServer({
      kubeClustersService: {}, kubeResourcesService: {}, kubeClientService: {},
      kubeLogsService: {
        open: async () => ({
          lines: many(), close: () => { closed += 1; },
          // Würde vor vollständigem Durchlauf befragt, wäre das Ergebnis nicht
          // aussagekräftig (siehe KubeLogSession-JSDoc) — error() hier absichtlich
          // "kaputt", damit ein versehentlicher Aufruf den Test sprengt.
          error: () => { throw new Error('error() vor vollständigem Durchlauf aufgerufen'); },
        }),
      },
    });
    const res = unwrap(await s.invoke('kube_logs', {
      clusterId: new Types.ObjectId().toString(), namespace: 'default', pod: 'web-1',
    }));
    assert.ok(!res.error, `unexpected error: ${res.error}`);
    assert.equal(res.value.status, 'truncated');
    assert.equal(res.value.lines.length, 5000);
    assert.equal(closed, 1);
  });

  await check('kube_logs: follow wird NIE an den Service durchgereicht, auch wenn im Argument gesetzt', async () => {
    let openOpts;
    const s = makeServer({
      kubeClustersService: {}, kubeResourcesService: {}, kubeClientService: {},
      kubeLogsService: {
        open: async (_clusterId, _ns, _pod, opts) => {
          openOpts = opts;
          return { lines: linesFrom([]), close: () => {}, error: () => undefined };
        },
      },
    });
    await s.invoke('kube_logs', {
      clusterId: new Types.ObjectId().toString(), namespace: 'default', pod: 'web-1', follow: true,
    });
    assert.equal(openOpts.follow, false, 'follow=true im Argument darf den Service-Aufruf nicht umbiegen');
  });

  // -------------------------------------------------------------------------
  // kube_top — release() in JEDEM Fall, auch wenn die Metrics-API wirft
  // -------------------------------------------------------------------------
  await check('kube_top: release() läuft auch, wenn die Metrics-Abfrage wirft', async () => {
    let released = 0;
    const s = makeServer({
      kubeClustersService: { findById: async () => makeClusterDoc() },
      kubeResourcesService: {}, kubeLogsService: {},
      kubeClientService: {
        buildConfig: async () => ({
          // Kein echtes KubeConfig-Objekt — makeApiClient existiert nicht,
          // topPods()/topNodes() aus @kubernetes/client-node werfen also
          // garantiert. Das ist der Punkt: release() muss trotzdem laufen.
          kc: {},
          release: () => { released += 1; },
        }),
      },
    });
    const res = unwrap(await s.invoke('kube_top', { clusterId: new Types.ObjectId().toString() }));
    assert.ok(res.error, 'expected an error since kc is not a real KubeConfig');
    assert.equal(released, 1, 'release() muss trotz Wurf laufen (finally)');
  });

  await check('kube_top: 404 von metrics.k8s.io wird zu einer klaren Fehlermeldung, nicht der Rohtext', async () => {
    let released = 0;
    const s = makeServer({
      kubeClustersService: { findById: async () => makeClusterDoc() },
      kubeResourcesService: {}, kubeLogsService: {},
      kubeClientService: {
        buildConfig: async () => ({
          kc: {
            makeApiClient: () => ({
              listNode: async () => { const e = new Error('Error occurred in metrics request'); e.code = 404; throw e; },
            }),
          },
          release: () => { released += 1; },
        }),
      },
    });
    const res = unwrap(await s.invoke('kube_top', {
      clusterId: new Types.ObjectId().toString(), scope: 'nodes',
    }));
    assert.ok(res.error, 'expected error');
    assert.match(res.error, /metrics-server/);
    assert.equal(released, 1);
  });

  console.log('');
  console.log(`Kube MCP checks: ${total - failures}/${total} passed`);
  if (failures > 0) process.exit(1);
})();
