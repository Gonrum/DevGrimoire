#!/usr/bin/env node
/*
 * T-252 integration check.
 * Scenario A: delay + condition + question (always runs)
 * Scenario B: event-trigger (always runs)
 * Scenario C: agent.task — opt-in via DEVGRIMOIRE_WORKFLOW_AGENT_E2E=true
 */
const baseUrl = (process.env.DEVGRIMOIRE_BASE_URL || 'http://localhost:3200').replace(/\/$/, '');
const apiKey = process.env.DEVGRIMOIRE_API_KEY;
if (!apiKey) { console.error('DEVGRIMOIRE_API_KEY required'); process.exit(2); }
const projectId = process.env.DEVGRIMOIRE_PROJECT_ID;
if (!projectId) { console.error('DEVGRIMOIRE_PROJECT_ID required'); process.exit(2); }

const headers = { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` };
function assert(c, m) { if (!c) { console.error(`✗ ${m}`); process.exit(1); } }
async function http(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return json;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function poll(getFn, isDone, timeoutMs, intervalMs = 300) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(intervalMs);
    const v = await getFn();
    if (isDone(v)) return v;
  }
  return null;
}

async function scenarioA() {
  console.log('--- Scenario A: delay + condition + question ---');
  let defId, todoId;
  try {
    const def = await http('POST', '/api/workflows', {
      scope: 'project', projectId, name: `T252-A-${Date.now()}`,
      trigger: { type: 'manual' },
      nodes: [
        { id: 't', type: 'trigger.manual', position: { x: 0, y: 0 }, config: {}, secretRefs: [] },
        { id: 'todo', type: 'action.todo-create', position: { x: 0, y: 0 },
          config: { title: 'T252 scenario A todo' }, secretRefs: [] },
        { id: 'delay', type: 'control.delay', position: { x: 0, y: 0 },
          config: { delayMs: 2000 }, secretRefs: [] },
        { id: 'cond', type: 'control.condition', position: { x: 0, y: 0 },
          config: {
            cases: [{ when: { path: 'nodes.todo.todoId', op: 'exists' }, branch: 'success' }],
            default: 'failure',
          }, secretRefs: [] },
        { id: 'q', type: 'action.user-question', position: { x: 0, y: 0 },
          config: { question: 'continue?', options: ['yes', 'no'], branchMap: { yes: 'success', no: 'failure' } }, secretRefs: [] },
        { id: 'comment', type: 'action.todo-comment', position: { x: 0, y: 0 },
          config: { todoId: '{{nodes.todo.todoId}}', text: 'answer was {{nodes.q.answer}}' }, secretRefs: [] },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'todo' },
        { id: 'e2', source: 'todo', target: 'delay' },
        { id: 'e3', source: 'delay', target: 'cond' },
        { id: 'e4', source: 'cond', target: 'q', branch: 'success' },
        { id: 'e5', source: 'q', target: 'comment', branch: 'success' },
      ],
    });
    defId = def._id;
    await http('PUT', `/api/workflows/${defId}`, { status: 'active' });
    const run = await http('POST', '/api/workflows/runs', { definitionId: defId });
    const runId = run._id;

    const waiting = await poll(
      () => http('GET', `/api/workflows/runs/${runId}`),
      (r) => r.status === 'waiting_for_user',
      20_000,
    );
    assert(waiting, `scenario A: run never entered waiting_for_user`);
    console.log(`✓ run entered waiting_for_user after delay+condition`);

    todoId = await http('GET', `/api/workflows/runs/${runId}/node-runs`)
      .then((nrs) => nrs.find((n) => n.nodeId === 'todo'))
      .then((nr) => nr?.outputSnapshot?.todoId);
    assert(todoId, 'scenario A: todo node-run did not produce todoId');

    // GET /api/questions/open returns { items, total }
    const questionsResp = await http('GET', `/api/questions/open?direction=agent_to_user&limit=10`);
    const questions = questionsResp.items ?? questionsResp;
    const myQ = Array.isArray(questions) && questions.find((q) => q.agentRunId === runId);
    assert(myQ, `scenario A: no question found for run ${runId} (got ${Array.isArray(questions) ? questions.length : JSON.stringify(questionsResp)} items)`);

    // Answer via POST /api/questions/:id/answer
    await http('POST', `/api/questions/${myQ._id}/answer`, { answer: 'yes' });
    const done = await poll(
      () => http('GET', `/api/workflows/runs/${runId}`),
      (r) => ['succeeded', 'failed', 'cancelled'].includes(r.status),
      10_000,
    );
    assert(done && done.status === 'succeeded', `scenario A: run did not succeed (${done?.status})`);
    console.log('✓ scenario A succeeded');

    const todo = await http('GET', `/api/todos/${todoId}`);
    const lastComment = (todo.comments ?? [])[todo.comments.length - 1];
    assert(lastComment?.text?.includes('answer was yes'), 'scenario A: comment missing expected text');
    console.log('✓ scenario A comment present');
  } finally {
    if (todoId) await http('DELETE', `/api/todos/${todoId}`).catch(() => {});
    if (defId) await http('DELETE', `/api/workflows/${defId}`).catch(() => {});
  }
}

async function scenarioB() {
  console.log('--- Scenario B: event-trigger ---');
  let defId, testTodoId;
  try {
    const def = await http('POST', '/api/workflows', {
      scope: 'project', projectId, name: `T252-B-${Date.now()}`,
      trigger: { type: 'manual' },
      nodes: [
        { id: 't', type: 'trigger.project_event', position: { x: 0, y: 0 },
          config: { entity: 'todo', action: 'created' }, secretRefs: [] },
        { id: 'log', type: 'action.log', position: { x: 0, y: 0 },
          config: { message: 'caught {{input.event.entityId}}' }, secretRefs: [] },
      ],
      edges: [{ id: 'e1', source: 't', target: 'log' }],
    });
    defId = def._id;
    await http('PUT', `/api/workflows/${defId}`, { status: 'active' });

    const beforeRuns = await http('GET', `/api/workflows/runs/list?definitionId=${defId}`);
    const beforeCount = Array.isArray(beforeRuns) ? beforeRuns.length : 0;

    const testTodo = await http('POST', '/api/todos', {
      projectId, title: 'T252 scenario B test todo',
    });
    testTodoId = testTodo._id;

    const afterRuns = await poll(
      () => http('GET', `/api/workflows/runs/list?definitionId=${defId}`),
      (rs) => Array.isArray(rs) && rs.length > beforeCount && rs.some((r) => r.status === 'succeeded'),
      15_000,
    );
    assert(afterRuns, 'scenario B: no new succeeded run after todo create');
    const myRun = afterRuns.find((r) => r.status === 'succeeded');
    assert(myRun, 'scenario B: no succeeded run found');
    console.log(`✓ event-triggered run ${myRun._id} succeeded`);

    const nodeRuns = await http('GET', `/api/workflows/runs/${myRun._id}/node-runs`);
    const logNr = nodeRuns.find((n) => n.nodeId === 'log');
    assert(logNr, 'scenario B: log node-run missing');
    const expectedSubstring = testTodoId;
    const logLine = logNr.logs?.find?.((l) => String(l.msg ?? '').includes(expectedSubstring));
    assert(logLine, `scenario B: log node-run did not capture entityId ${expectedSubstring}`);
    console.log('✓ scenario B captured event payload via template');
  } finally {
    if (testTodoId) await http('DELETE', `/api/todos/${testTodoId}`).catch(() => {});
    if (defId) await http('DELETE', `/api/workflows/${defId}`).catch(() => {});
  }
}

async function scenarioC() {
  if (process.env.DEVGRIMOIRE_WORKFLOW_AGENT_E2E !== 'true') {
    console.log('--- Scenario C: agent.task SKIPPED (set DEVGRIMOIRE_WORKFLOW_AGENT_E2E=true to run) ---');
    return;
  }
  console.log('--- Scenario C: agent.task ---');
  const cfg = await http('GET', `/api/workflow-agent/config`);
  assert(cfg && cfg.hasApiKey !== undefined, 'scenario C: agent-config not set up');
  let defId;
  try {
    const def = await http('POST', '/api/workflows', {
      scope: 'project', projectId, name: `T252-C-${Date.now()}`,
      trigger: { type: 'manual' },
      nodes: [
        { id: 't', type: 'trigger.manual', position: { x: 0, y: 0 }, config: {}, secretRefs: [] },
        { id: 'agent', type: 'agent.task', position: { x: 0, y: 0 },
          config: { prompt: 'Answer with exactly the word PONG and nothing else.' }, secretRefs: [] },
      ],
      edges: [{ id: 'e1', source: 't', target: 'agent' }],
    });
    defId = def._id;
    await http('PUT', `/api/workflows/${defId}`, { status: 'active' });
    const run = await http('POST', '/api/workflows/runs', { definitionId: defId });
    const done = await poll(
      () => http('GET', `/api/workflows/runs/${run._id}`),
      (r) => ['succeeded', 'failed', 'cancelled'].includes(r.status),
      120_000,
    );
    assert(done && done.status === 'succeeded', `scenario C: agent run did not succeed (${done?.status} ${JSON.stringify(done?.error)})`);
    const nodeRuns = await http('GET', `/api/workflows/runs/${run._id}/node-runs`);
    const agentNr = nodeRuns.find((n) => n.nodeId === 'agent');
    assert(agentNr?.outputSnapshot?.response, 'scenario C: agent.task produced no response');
    console.log(`✓ scenario C agent response: ${String(agentNr.outputSnapshot.response).slice(0, 80)}...`);
  } finally {
    if (defId) await http('DELETE', `/api/workflows/${defId}`).catch(() => {});
  }
}

(async () => {
  await scenarioA();
  await scenarioB();
  await scenarioC();
  console.log('\nAll T-252 integration scenarios passed.');
})().catch((err) => { console.error(err); process.exit(1); });
