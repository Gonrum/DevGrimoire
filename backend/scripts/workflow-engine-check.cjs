#!/usr/bin/env node
/*
 * Engine integration check (T-250).
 * Drives the running backend over HTTP through a full workflow run.
 * Requires `docker compose up -d backend`.
 *
 * Env vars:
 *   DEVGRIMOIRE_BASE_URL (default http://localhost:3200)
 *   DEVGRIMOIRE_API_KEY  (required)
 *   DEVGRIMOIRE_PROJECT_ID (required — an existing project to attach the workflow to)
 */
const baseUrl = (process.env.DEVGRIMOIRE_BASE_URL || 'http://localhost:3200').replace(/\/$/, '');
const apiKey = process.env.DEVGRIMOIRE_API_KEY;
if (!apiKey) {
  console.error('DEVGRIMOIRE_API_KEY env var required');
  process.exit(2);
}
const projectId = process.env.DEVGRIMOIRE_PROJECT_ID;
if (!projectId) {
  console.error('DEVGRIMOIRE_PROJECT_ID env var required');
  process.exit(2);
}

const headers = {
  'content-type': 'application/json',
  authorization: `Bearer ${apiKey}`,
};

function assert(cond, msg) {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
}

async function http(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return json;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  let defId, todoId;
  try {
    console.log('Creating workflow…');
    const def = await http('POST', '/api/workflows', {
      scope: 'project',
      projectId,
      name: `runner-check-${Date.now()}`,
      trigger: { type: 'manual' },
      nodes: [
        { id: 't', type: 'trigger.manual', position: { x: 0, y: 0 }, config: {}, secretRefs: [] },
        { id: 'log', type: 'action.log', position: { x: 0, y: 0 }, config: { message: 'workflow check tick' }, secretRefs: [] },
        { id: 'todo', type: 'action.todo-create', position: { x: 0, y: 0 }, config: { title: 'Workflow runner check todo (T-250 smoke)', tags: ['workflow-check'] }, secretRefs: [] },
        { id: 'notify', type: 'action.notify', position: { x: 0, y: 0 }, config: { title: 'Workflow runner check', body: 'engine integration test completed' }, secretRefs: [] },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'log' },
        { id: 'e2', source: 'log', target: 'todo' },
        { id: 'e3', source: 'todo', target: 'notify' },
      ],
    });
    defId = def._id;
    console.log(`  workflow created: ${defId}`);

    console.log('Publishing workflow (status=active)…');
    await http('PUT', `/api/workflows/${defId}`, { status: 'active' });

    console.log('Starting run…');
    const run = await http('POST', '/api/workflows/runs', { definitionId: defId });
    const runId = run._id;
    console.log(`  run id: ${runId}`);

    console.log('Polling run…');
    const start = Date.now();
    let final;
    while (Date.now() - start < 15_000) {
      await sleep(300);
      final = await http('GET', `/api/workflows/runs/${runId}`);
      if (['succeeded', 'failed', 'cancelled'].includes(final.status)) break;
    }
    assert(
      final && final.status === 'succeeded',
      `run did not succeed (status=${final?.status}, error=${JSON.stringify(final?.error)})`,
    );
    console.log(`✓ run succeeded`);

    const nodeRuns = await http('GET', `/api/workflows/runs/${runId}/node-runs`);
    assert(nodeRuns.length === 4, `expected 4 node-runs, got ${nodeRuns.length}`);
    for (const nr of nodeRuns) {
      assert(nr.status === 'succeeded', `node-run ${nr.nodeId} status=${nr.status} (error=${JSON.stringify(nr.error)})`);
    }
    console.log('✓ all node-runs succeeded');

    const todoNr = nodeRuns.find((n) => n.nodeId === 'todo');
    todoId = todoNr.outputSnapshot?.todoId;
    assert(todoId, 'todo-create did not produce a todoId');
    const todo = await http('GET', `/api/todos/${todoId}`);
    assert(todo._id === todoId, 'todo fetched by id mismatched');
    console.log(`✓ todo ${todoId} exists`);

    const notifyNr = nodeRuns.find((n) => n.nodeId === 'notify');
    assert(notifyNr.outputSnapshot?.notificationId, 'notify did not produce a notificationId');
    console.log('✓ notify produced notificationId');

    const logNr = nodeRuns.find((n) => n.nodeId === 'log');
    assert(Array.isArray(logNr.logs) && logNr.logs.length > 0, 'log node-run has no logs');
    console.log('✓ log node-run has log entries');

    console.log('\nAll integration checks passed.');
  } finally {
    console.log('Cleanup…');
    if (todoId) {
      try { await http('DELETE', `/api/todos/${todoId}`); } catch (e) { console.warn(`cleanup todo: ${e.message}`); }
    }
    if (defId) {
      try { await http('DELETE', `/api/workflows/${defId}`); } catch (e) { console.warn(`cleanup workflow: ${e.message}`); }
    }
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
