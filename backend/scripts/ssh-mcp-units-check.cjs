#!/usr/bin/env node
/*
 * Pure-logic regression check for the 5 SSH MCP tools (T-383, Schritt 6/8).
 *
 * Covers the spec acceptance set:
 *   - ssh_connection_list scope-required + safe shape (no credentials/fp)
 *   - ssh_connection_list status derivation (never_tested / fingerprint_pending /
 *     ok / error)
 *   - ssh_connection_get id / slug+projectId / slug+customerId
 *   - ssh_connection_get slug-without-scope + not-found errors
 *   - ssh_connection_get safe output (no credentials)
 *   - ssh_exec wires through sshSessionService.exec with sourceContext='mcp'
 *   - ssh_upload utf-8 + base64 encode/decode
 *   - ssh_upload pre-decode 10 MB cap
 *   - ssh_download binary detection (null byte → base64)
 *   - ssh_download utf-8 round-trip safe → utf-8
 *   - ssh_list_files entries + truncated pass-through
 *
 * Run with `npm run check:ssh-mcp` from backend/ after `npm run build`.
 * No Jest, no real Mongo. Uses the same compiled-output pattern as the other
 * ssh-* check scripts so we exercise PRODUCTION code paths, not test doubles
 * of the units under test.
 */
const path = require('node:path');
const assert = require('node:assert/strict');

function loadCompiled(rel) {
  const abs = path.resolve(__dirname, '..', 'dist', rel);
  try {
    return require(abs);
  } catch (err) {
    console.error(`Failed to load ${abs}. Run \`npm run build\` first.`);
    console.error(err.message);
    process.exit(2);
  }
}

const mcpTools = loadCompiled('mcp-tools.js');
const mongoose = loadCompiled('../node_modules/mongoose/index.js');
const { Types } = mongoose;
// CallToolRequestSchema is the Zod schema used by setRequestHandler — the
// fake server below doesn't validate against it; we just capture by identity.
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
// Fixtures
// ---------------------------------------------------------------------------
function makeConn(overrides = {}) {
  const id = overrides._id || new Types.ObjectId();
  return {
    _id: id,
    label: 'web-01',
    slug: 'web-01',
    customerId: overrides.customerId,
    projectId: overrides.projectId,
    host: 'host.example',
    port: 22,
    username: 'deploy',
    authMethod: 'key',
    privateKeySecretId: new Types.ObjectId(),
    passphraseSecretId: undefined,
    passwordSecretId: undefined,
    description: undefined,
    tags: ['prod'],
    knownHostFingerprint: undefined,
    lastConnectedAt: undefined,
    lastConnectError: undefined,
    notifyOnAuthFailure: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------
function makeSshServiceStub({ connections = [], latestAudit = null } = {}) {
  return {
    async findById(id) {
      const found = connections.find((c) => String(c._id) === String(id));
      if (!found) {
        const err = new Error('SshConnection not found');
        err.status = 404;
        throw err;
      }
      return found;
    },
    async findBySlug(slug, scope) {
      const filter = (c) => {
        if (c.slug !== slug) return false;
        if (scope.projectId) {
          return c.projectId && String(c.projectId) === String(scope.projectId);
        }
        if (scope.customerId) {
          return c.customerId && String(c.customerId) === String(scope.customerId);
        }
        return false;
      };
      return connections.find(filter) || null;
    },
    async findByScopeAndTags({ projectId, customerId, tags }) {
      const out = connections.filter((c) => {
        if (projectId && (!c.projectId || String(c.projectId) !== String(projectId))) return false;
        if (customerId && (!c.customerId || String(c.customerId) !== String(customerId))) return false;
        if (tags && tags.length > 0) {
          for (const t of tags) {
            if (!c.tags || !c.tags.includes(t)) return false;
          }
        }
        return true;
      });
      return out;
    },
    async findLatestAudit(_connId) {
      if (!latestAudit) return null;
      return latestAudit;
    },
  };
}

function makeSshSessionServiceStub() {
  const calls = { exec: [], upload: [], download: [], listFiles: [] };
  return {
    calls,
    async exec(connId, command, opts) {
      calls.exec.push({ connId: String(connId), command, opts });
      return {
        stdout: 'ok\n',
        stderr: '',
        exitCode: 0,
        durationMs: 1,
        truncated: { stdout: false, stderr: false },
      };
    },
    async sftpUpload(connId, remotePath, content, opts) {
      calls.upload.push({ connId: String(connId), remotePath, content, opts });
      return { bytesWritten: content.length, remotePath };
    },
    async sftpDownload(connId, remotePath, opts) {
      calls.download.push({ connId: String(connId), remotePath, opts });
      // Caller can override via opts.__return for per-test buffers.
      const buf = opts.__return || Buffer.from('hello world');
      return { content: buf, bytesRead: buf.length, truncated: false };
    },
    async listFiles(connId, remotePath, opts) {
      calls.listFiles.push({ connId: String(connId), remotePath, opts });
      return {
        entries: [
          { name: 'a.txt', path: `${remotePath}/a.txt`, type: 'file', size: 5, mode: 0o644, mtime: new Date(0) },
        ],
        truncated: false,
      };
    },
  };
}

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

// Minimal McpServices skeleton. Tools touched by tests get real-ish stubs;
// everything else is a no-op proxy so registerMcpTools doesn't blow up on
// destructure (it just reads property names, doesn't call them).
function buildServices({ sshService, sshSessionService }) {
  const noop = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'then') return undefined; // not a thenable
        return () => Promise.resolve(undefined);
      },
    },
  );
  return {
    projectsService: noop,
    todosService: noop,
    sessionsService: noop,
    knowledgeService: noop,
    changelogService: noop,
    milestonesService: noop,
    activitiesService: noop,
    pushService: noop,
    environmentsService: noop,
    secretsService: noop,
    manualsService: noop,
    researchService: noop,
    researchSessionsService: noop,
    settingsService: noop,
    notificationsService: { create: () => Promise.resolve() },
    schemasService: noop,
    dependenciesService: noop,
    featuresService: noop,
    soulsService: noop,
    commitsService: noop,
    ragService: noop,
    recurringTasksService: noop,
    workflowsService: noop,
    workflowEngineService: noop,
    nodeRegistry: noop,
    customerTemplatesService: noop,
    validationReportsService: noop,
    docUpdateProposalsService: noop,
    knowledgeGraphService: noop,
    oracleService: noop,
    snippetsService: noop,
    attachmentsService: noop,
    questionsService: noop,
    authService: noop,
    customersService: noop,
    contactsService: noop,
    monitoringService: noop,
    logsService: noop,
    releasesService: noop,
    chatService: noop,
    chatLlmService: { isEnabled: async () => true },
    chatContextService: noop,
    webSearchService: noop,
    readabilityService: noop,
    workspacesService: noop,
    workspaceClient: noop,
    workspaceGitTokens: noop,
    workspaceCliToken: noop,
    sshService,
    sshSessionService,
  };
}

// MCP responses are wrapped as { content: [{type:'text', text:'<json>'}], isError? }.
// For errors thrown inside the handler the top-level returns errorResult — text
// payload begins with 'Error: '. For success we JSON.parse the text payload.
function unwrap(res) {
  assert.ok(res && Array.isArray(res.content) && res.content.length > 0, 'expected content[]');
  const text = res.content[0].text;
  if (res.isError) return { error: text };
  return { value: JSON.parse(text) };
}

// ---------------------------------------------------------------------------
// userId env for requireUserId(): every write-tier SSH tool needs one.
// ---------------------------------------------------------------------------
const TEST_USER_ID = new Types.ObjectId().toString();
process.env.MCP_STDIO_USER_ID = TEST_USER_ID;

// ===========================================================================
// Tests
// ===========================================================================
(async () => {
  // -------------------------------------------------------------------------
  // ssh_connection_list
  // -------------------------------------------------------------------------
  await check('ssh_connection_list without scope throws scope_required', async () => {
    const ssh = makeSshServiceStub({ connections: [] });
    const session = makeSshSessionServiceStub();
    const server = makeFakeServer();
    mcpTools.registerMcpTools(server, buildServices({ sshService: ssh, sshSessionService: session }));
    const res = unwrap(await server.invoke('ssh_connection_list', {}));
    assert.ok(res.error, 'expected error');
    assert.match(res.error, /scope_required/);
  });

  await check('ssh_connection_list with projectId returns safe list shape (no credentials/fp)', async () => {
    const projectId = new Types.ObjectId();
    const conn = makeConn({
      projectId,
      knownHostFingerprint: 'aa:bb:cc',
      lastConnectedAt: new Date('2024-01-01T00:00:00Z'),
      description: 'web frontend',
      tags: ['prod', 'tier1'],
    });
    const ssh = makeSshServiceStub({ connections: [conn] });
    const session = makeSshSessionServiceStub();
    const server = makeFakeServer();
    mcpTools.registerMcpTools(server, buildServices({ sshService: ssh, sshSessionService: session }));
    const res = unwrap(await server.invoke('ssh_connection_list', { projectId: projectId.toString() }));
    assert.ok(!res.error, `unexpected error: ${res.error}`);
    assert.equal(res.value.length, 1);
    const item = res.value[0];
    assert.equal(item.id, conn._id.toString());
    assert.equal(item.slug, 'web-01');
    assert.equal(item.host, 'host.example');
    assert.equal(item.port, 22);
    assert.equal(item.username, 'deploy');
    assert.equal(item.authMethod, 'key');
    assert.deepEqual(item.scope, { projectId: projectId.toString() });
    assert.deepEqual(item.tags, ['prod', 'tier1']);
    assert.equal(item.description, 'web frontend');
    assert.equal(item.status, 'ok');
    assert.ok(item.lastConnectedAt);
    // Defense-in-depth: forbidden keys MUST NOT appear in the projection.
    const forbidden = [
      'privateKeySecretId', 'passphraseSecretId', 'passwordSecretId',
      'knownHostFingerprint',
    ];
    for (const k of forbidden) {
      assert.equal(item[k], undefined, `must not expose ${k}`);
    }
  });

  await check('ssh_connection_list status derivation covers never_tested/fingerprint_pending/ok/error', async () => {
    const projectId = new Types.ObjectId();
    // 'never_tested' = TOFU accepted (knownHostFingerprint set) but the
    // user hasn't actually connected yet (no lastConnectedAt, no error).
    // Unusual state, but the spec enumerates it explicitly.
    const cNever = makeConn({
      projectId,
      _id: new Types.ObjectId(),
      knownHostFingerprint: 'aa',
    });
    const cPending = makeConn({
      projectId,
      _id: new Types.ObjectId(),
      lastConnectedAt: new Date('2024-01-01'),
      // no knownHostFingerprint → fingerprint_pending wins over the
      // lastConnectedAt path (matches deriveSshStatus precedence)
    });
    const cOk = makeConn({
      projectId,
      _id: new Types.ObjectId(),
      knownHostFingerprint: 'aa',
      lastConnectedAt: new Date(),
    });
    const cErr = makeConn({
      projectId,
      _id: new Types.ObjectId(),
      knownHostFingerprint: 'aa',
      lastConnectedAt: new Date(),
      lastConnectError: { at: new Date(), message: 'boom' },
    });
    const ssh = makeSshServiceStub({ connections: [cNever, cPending, cOk, cErr] });
    const session = makeSshSessionServiceStub();
    const server = makeFakeServer();
    mcpTools.registerMcpTools(server, buildServices({ sshService: ssh, sshSessionService: session }));
    const res = unwrap(await server.invoke('ssh_connection_list', { projectId: projectId.toString() }));
    assert.ok(!res.error);
    const byId = new Map(res.value.map((v) => [v.id, v.status]));
    assert.equal(byId.get(cNever._id.toString()), 'never_tested');
    assert.equal(byId.get(cPending._id.toString()), 'fingerprint_pending');
    assert.equal(byId.get(cOk._id.toString()), 'ok');
    assert.equal(byId.get(cErr._id.toString()), 'error');
  });

  // Direct unit-check on the exported helper too — guards against the
  // service-stub diverging from production.
  await check('deriveSshStatus precedence: error > fingerprint_pending > ok > never_tested', async () => {
    assert.equal(mcpTools.deriveSshStatus({ lastConnectError: { at: new Date(), message: 'x' } }), 'error');
    assert.equal(mcpTools.deriveSshStatus({ knownHostFingerprint: undefined }), 'fingerprint_pending');
    assert.equal(mcpTools.deriveSshStatus({ knownHostFingerprint: 'a', lastConnectedAt: new Date() }), 'ok');
    assert.equal(mcpTools.deriveSshStatus({ knownHostFingerprint: 'a' }), 'never_tested');
  });

  // -------------------------------------------------------------------------
  // ssh_connection_get
  // -------------------------------------------------------------------------
  await check('ssh_connection_get by id returns connection + lastAuditEntry', async () => {
    const projectId = new Types.ObjectId();
    const conn = makeConn({
      projectId,
      knownHostFingerprint: 'aa',
      lastConnectedAt: new Date('2024-01-01'),
    });
    const latestAudit = {
      at: new Date('2024-02-02'),
      action: 'exec',
      sourceContext: 'mcp',
      exitCode: 0,
      errorMsg: undefined,
      // Extra fields we should NOT expose:
      command: 'ls -la /etc/shadow',
      userId: new Types.ObjectId(),
      remotePath: '/etc/shadow',
    };
    const ssh = makeSshServiceStub({ connections: [conn], latestAudit });
    const session = makeSshSessionServiceStub();
    const server = makeFakeServer();
    mcpTools.registerMcpTools(server, buildServices({ sshService: ssh, sshSessionService: session }));
    const res = unwrap(await server.invoke('ssh_connection_get', { id: conn._id.toString() }));
    assert.ok(!res.error, `unexpected error: ${res.error}`);
    assert.equal(res.value.id, conn._id.toString());
    assert.equal(res.value.status, 'ok');
    assert.ok(res.value.lastAuditEntry);
    assert.equal(res.value.lastAuditEntry.action, 'exec');
    assert.equal(res.value.lastAuditEntry.sourceContext, 'mcp');
    assert.equal(res.value.lastAuditEntry.exitCode, 0);
    // No command/userId/remotePath leakage in the audit projection.
    assert.equal(res.value.lastAuditEntry.command, undefined);
    assert.equal(res.value.lastAuditEntry.userId, undefined);
    assert.equal(res.value.lastAuditEntry.remotePath, undefined);
    // No credentials at top level.
    assert.equal(res.value.privateKeySecretId, undefined);
    assert.equal(res.value.knownHostFingerprint, undefined);
  });

  await check('ssh_connection_get by slug+projectId resolves', async () => {
    const projectId = new Types.ObjectId();
    const conn = makeConn({ projectId, slug: 'lookup-me' });
    const ssh = makeSshServiceStub({ connections: [conn] });
    const session = makeSshSessionServiceStub();
    const server = makeFakeServer();
    mcpTools.registerMcpTools(server, buildServices({ sshService: ssh, sshSessionService: session }));
    const res = unwrap(await server.invoke('ssh_connection_get', { slug: 'lookup-me', projectId: projectId.toString() }));
    assert.ok(!res.error);
    assert.equal(res.value.id, conn._id.toString());
  });

  await check('ssh_connection_get by slug+customerId resolves', async () => {
    const customerId = new Types.ObjectId();
    const conn = makeConn({ customerId, slug: 'cust-host' });
    const ssh = makeSshServiceStub({ connections: [conn] });
    const session = makeSshSessionServiceStub();
    const server = makeFakeServer();
    mcpTools.registerMcpTools(server, buildServices({ sshService: ssh, sshSessionService: session }));
    const res = unwrap(await server.invoke('ssh_connection_get', { slug: 'cust-host', customerId: customerId.toString() }));
    assert.ok(!res.error);
    assert.equal(res.value.id, conn._id.toString());
  });

  await check('ssh_connection_get slug without scope throws slug_requires_scope', async () => {
    const ssh = makeSshServiceStub({ connections: [] });
    const session = makeSshSessionServiceStub();
    const server = makeFakeServer();
    mcpTools.registerMcpTools(server, buildServices({ sshService: ssh, sshSessionService: session }));
    const res = unwrap(await server.invoke('ssh_connection_get', { slug: 'orphan' }));
    assert.ok(res.error);
    assert.match(res.error, /slug_requires_scope/);
  });

  await check('ssh_connection_get with no id and no slug throws connection_identifier_required', async () => {
    const ssh = makeSshServiceStub({ connections: [] });
    const session = makeSshSessionServiceStub();
    const server = makeFakeServer();
    mcpTools.registerMcpTools(server, buildServices({ sshService: ssh, sshSessionService: session }));
    const res = unwrap(await server.invoke('ssh_connection_get', {}));
    assert.ok(res.error);
    assert.match(res.error, /connection_identifier_required/);
  });

  await check('ssh_connection_get with non-existent id throws connection_not_found', async () => {
    const ssh = makeSshServiceStub({ connections: [] });
    const session = makeSshSessionServiceStub();
    const server = makeFakeServer();
    mcpTools.registerMcpTools(server, buildServices({ sshService: ssh, sshSessionService: session }));
    const res = unwrap(await server.invoke('ssh_connection_get', { id: new Types.ObjectId().toString() }));
    assert.ok(res.error);
    assert.match(res.error, /connection_not_found/);
  });

  // -------------------------------------------------------------------------
  // ssh_exec
  // -------------------------------------------------------------------------
  await check('ssh_exec calls SshSessionService.exec with sourceContext=mcp', async () => {
    const projectId = new Types.ObjectId();
    const conn = makeConn({ projectId, knownHostFingerprint: 'aa' });
    const ssh = makeSshServiceStub({ connections: [conn] });
    const session = makeSshSessionServiceStub();
    const server = makeFakeServer();
    mcpTools.registerMcpTools(server, buildServices({ sshService: ssh, sshSessionService: session }));
    const res = unwrap(await server.invoke('ssh_exec', {
      connectionId: conn._id.toString(),
      command: 'whoami',
      timeoutMs: 5000,
      cwd: '/tmp',
      env: { FOO: 'bar' },
    }));
    assert.ok(!res.error, `unexpected error: ${res.error}`);
    assert.equal(res.value.exitCode, 0);
    assert.equal(session.calls.exec.length, 1);
    const call = session.calls.exec[0];
    assert.equal(call.connId, conn._id.toString());
    assert.equal(call.command, 'whoami');
    assert.equal(call.opts.sourceContext, 'mcp');
    assert.equal(call.opts.timeoutMs, 5000);
    assert.equal(call.opts.cwd, '/tmp');
    assert.deepEqual(call.opts.env, { FOO: 'bar' });
    assert.equal(call.opts.userId, TEST_USER_ID);
  });

  // -------------------------------------------------------------------------
  // ssh_upload
  // -------------------------------------------------------------------------
  await check('ssh_upload utf-8 content is encoded as Buffer.from(content, utf8)', async () => {
    const projectId = new Types.ObjectId();
    const conn = makeConn({ projectId, knownHostFingerprint: 'aa' });
    const ssh = makeSshServiceStub({ connections: [conn] });
    const session = makeSshSessionServiceStub();
    const server = makeFakeServer();
    mcpTools.registerMcpTools(server, buildServices({ sshService: ssh, sshSessionService: session }));
    const res = unwrap(await server.invoke('ssh_upload', {
      connectionId: conn._id.toString(),
      remotePath: '/tmp/test.txt',
      content: 'hello world',
      // no encoding → defaults to utf-8
    }));
    assert.ok(!res.error, `unexpected error: ${res.error}`);
    assert.equal(session.calls.upload.length, 1);
    const call = session.calls.upload[0];
    assert.ok(Buffer.isBuffer(call.content));
    assert.equal(call.content.toString('utf8'), 'hello world');
    assert.equal(call.opts.sourceContext, 'mcp');
    assert.equal(call.opts.userId, TEST_USER_ID);
  });

  await check('ssh_upload base64 content is decoded back to original bytes', async () => {
    const projectId = new Types.ObjectId();
    const conn = makeConn({ projectId, knownHostFingerprint: 'aa' });
    const ssh = makeSshServiceStub({ connections: [conn] });
    const session = makeSshSessionServiceStub();
    const server = makeFakeServer();
    mcpTools.registerMcpTools(server, buildServices({ sshService: ssh, sshSessionService: session }));
    // Bytes 0..7 including a NUL — would mangle through utf-8.
    const original = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]);
    const b64 = original.toString('base64');
    const res = unwrap(await server.invoke('ssh_upload', {
      connectionId: conn._id.toString(),
      remotePath: '/tmp/bin',
      content: b64,
      encoding: 'base64',
    }));
    assert.ok(!res.error, `unexpected error: ${res.error}`);
    const call = session.calls.upload[0];
    assert.ok(call.content.equals(original));
  });

  await check('ssh_upload rejects pre-decode size > 10 MB', async () => {
    const projectId = new Types.ObjectId();
    const conn = makeConn({ projectId, knownHostFingerprint: 'aa' });
    const ssh = makeSshServiceStub({ connections: [conn] });
    const session = makeSshSessionServiceStub();
    const server = makeFakeServer();
    mcpTools.registerMcpTools(server, buildServices({ sshService: ssh, sshSessionService: session }));
    const huge = 'a'.repeat(10 * 1024 * 1024 + 1);
    const res = unwrap(await server.invoke('ssh_upload', {
      connectionId: conn._id.toString(),
      remotePath: '/tmp/huge',
      content: huge,
    }));
    assert.ok(res.error, 'expected error');
    assert.match(res.error, /upload_too_large/);
    // Should not have reached the session service.
    assert.equal(session.calls.upload.length, 0);
  });

  await check('ssh_upload rejects oversized base64 BEFORE decoding (RAM guard)', async () => {
    const projectId = new Types.ObjectId();
    const conn = makeConn({ projectId, knownHostFingerprint: 'aa' });
    const ssh = makeSshServiceStub({ connections: [conn] });
    const session = makeSshSessionServiceStub();
    const server = makeFakeServer();
    mcpTools.registerMcpTools(server, buildServices({ sshService: ssh, sshSessionService: session }));
    // BASE64_PRE_MAX = ceil(10MB * 4/3) + 4 ≈ 13_981_018. Use a string well
    // above that — about 14 MB — to ensure pre-decode rejection. Decoding
    // this would yield ~10.5 MB which is over HARD_MAX but the point is the
    // pre-decode cap must fire first.
    const overcap = 'A'.repeat(14 * 1024 * 1024);
    // Spy on Buffer.from to assert the base64 decode path is NOT taken.
    const realBufferFrom = Buffer.from;
    let base64DecodeCalled = false;
    Buffer.from = function patched(...args) {
      if (args.length >= 2 && args[1] === 'base64') {
        base64DecodeCalled = true;
      }
      return realBufferFrom.apply(Buffer, args);
    };
    try {
      const res = unwrap(await server.invoke('ssh_upload', {
        connectionId: conn._id.toString(),
        remotePath: '/tmp/huge.bin',
        content: overcap,
        encoding: 'base64',
      }));
      assert.ok(res.error, 'expected error');
      assert.match(res.error, /upload_too_large/);
      assert.match(res.error, /would decode beyond/);
      assert.equal(base64DecodeCalled, false, 'base64 decode must NOT run before pre-decode cap');
      assert.equal(session.calls.upload.length, 0);
    } finally {
      Buffer.from = realBufferFrom;
    }
  });

  // -------------------------------------------------------------------------
  // ssh_upload integrity (T-435): strict base64 + sha256 + append
  // -------------------------------------------------------------------------
  await check('ssh_upload rejects base64 that lost a character instead of writing corrupt bytes', async () => {
    const projectId = new Types.ObjectId();
    const conn = makeConn({ projectId, knownHostFingerprint: 'aa' });
    const ssh = makeSshServiceStub({ connections: [conn] });
    const session = makeSshSessionServiceStub();
    const server = makeFakeServer();
    mcpTools.registerMcpTools(server, buildServices({ sshService: ssh, sshSessionService: session }));
    // The exact failure seen in the field: one character dropped mid-payload.
    // Buffer.from would decode this happily into 1 byte less.
    const b64 = Buffer.from('Hello DevGrimoire, a test payload!').toString('base64');
    const res = unwrap(await server.invoke('ssh_upload', {
      connectionId: conn._id.toString(),
      remotePath: '/tmp/bin',
      content: b64.slice(0, 12) + b64.slice(13),
      encoding: 'base64',
    }));
    assert.ok(res.error, 'expected error');
    assert.match(res.error, /invalid_base64/);
    assert.equal(session.calls.upload.length, 0, 'nothing may be written');
  });

  await check('ssh_upload rejects stray characters in the base64 payload', async () => {
    const projectId = new Types.ObjectId();
    const conn = makeConn({ projectId, knownHostFingerprint: 'aa' });
    const ssh = makeSshServiceStub({ connections: [conn] });
    const session = makeSshSessionServiceStub();
    const server = makeFakeServer();
    mcpTools.registerMcpTools(server, buildServices({ sshService: ssh, sshSessionService: session }));
    const res = unwrap(await server.invoke('ssh_upload', {
      connectionId: conn._id.toString(),
      remotePath: '/tmp/bin',
      content: 'SGVsbG8h!!@#',
      encoding: 'base64',
    }));
    assert.ok(res.error, 'expected error');
    assert.match(res.error, /invalid_base64/);
    assert.equal(session.calls.upload.length, 0);
  });

  await check('ssh_upload tolerates line breaks in base64 (base64 without -w0)', async () => {
    const projectId = new Types.ObjectId();
    const conn = makeConn({ projectId, knownHostFingerprint: 'aa' });
    const ssh = makeSshServiceStub({ connections: [conn] });
    const session = makeSshSessionServiceStub();
    const server = makeFakeServer();
    mcpTools.registerMcpTools(server, buildServices({ sshService: ssh, sshSessionService: session }));
    const original = Buffer.from('a'.repeat(200));
    const wrapped = original.toString('base64').replace(/(.{76})/g, '$1\n');
    const res = unwrap(await server.invoke('ssh_upload', {
      connectionId: conn._id.toString(),
      remotePath: '/tmp/wrapped',
      content: wrapped,
      encoding: 'base64',
    }));
    assert.ok(!res.error, `unexpected error: ${res.error}`);
    assert.ok(session.calls.upload[0].content.equals(original));
  });

  await check('ssh_upload verifies sha256 and refuses to write on mismatch', async () => {
    const projectId = new Types.ObjectId();
    const conn = makeConn({ projectId, knownHostFingerprint: 'aa' });
    const ssh = makeSshServiceStub({ connections: [conn] });
    const session = makeSshSessionServiceStub();
    const server = makeFakeServer();
    mcpTools.registerMcpTools(server, buildServices({ sshService: ssh, sshSessionService: session }));
    const res = unwrap(await server.invoke('ssh_upload', {
      connectionId: conn._id.toString(),
      remotePath: '/tmp/cfg',
      content: 'hello world',
      sha256: 'f'.repeat(64),
    }));
    assert.ok(res.error, 'expected error');
    assert.match(res.error, /checksum_mismatch/);
    assert.equal(session.calls.upload.length, 0, 'mismatch must abort before the write');
  });

  await check('ssh_upload accepts a matching sha256 (case/whitespace tolerant)', async () => {
    const projectId = new Types.ObjectId();
    const conn = makeConn({ projectId, knownHostFingerprint: 'aa' });
    const ssh = makeSshServiceStub({ connections: [conn] });
    const session = makeSshSessionServiceStub();
    const server = makeFakeServer();
    mcpTools.registerMcpTools(server, buildServices({ sshService: ssh, sshSessionService: session }));
    const digest = require('node:crypto')
      .createHash('sha256').update(Buffer.from('hello world')).digest('hex');
    const res = unwrap(await server.invoke('ssh_upload', {
      connectionId: conn._id.toString(),
      remotePath: '/tmp/cfg',
      content: 'hello world',
      sha256: `  ${digest.toUpperCase()}  `,
    }));
    assert.ok(!res.error, `unexpected error: ${res.error}`);
    assert.equal(session.calls.upload.length, 1);
  });

  await check('ssh_upload rejects a malformed sha256 instead of ignoring it', async () => {
    const projectId = new Types.ObjectId();
    const conn = makeConn({ projectId, knownHostFingerprint: 'aa' });
    const ssh = makeSshServiceStub({ connections: [conn] });
    const session = makeSshSessionServiceStub();
    const server = makeFakeServer();
    mcpTools.registerMcpTools(server, buildServices({ sshService: ssh, sshSessionService: session }));
    const res = unwrap(await server.invoke('ssh_upload', {
      connectionId: conn._id.toString(),
      remotePath: '/tmp/cfg',
      content: 'hello world',
      sha256: 'not-a-digest',
    }));
    assert.ok(res.error, 'expected error');
    assert.match(res.error, /invalid_sha256/);
    assert.equal(session.calls.upload.length, 0);
  });

  await check('ssh_upload passes append through to the session service', async () => {
    const projectId = new Types.ObjectId();
    const conn = makeConn({ projectId, knownHostFingerprint: 'aa' });
    const ssh = makeSshServiceStub({ connections: [conn] });
    const session = makeSshSessionServiceStub();
    const server = makeFakeServer();
    mcpTools.registerMcpTools(server, buildServices({ sshService: ssh, sshSessionService: session }));
    const res = unwrap(await server.invoke('ssh_upload', {
      connectionId: conn._id.toString(),
      remotePath: '/tmp/chunked.bin',
      content: 'chunk-2',
      append: true,
    }));
    assert.ok(!res.error, `unexpected error: ${res.error}`);
    assert.equal(session.calls.upload[0].opts.append, true);
  });

  // -------------------------------------------------------------------------
  // ssh_download
  // -------------------------------------------------------------------------
  await check('ssh_download auto-switches to base64 when buffer contains null byte', async () => {
    const projectId = new Types.ObjectId();
    const conn = makeConn({ projectId, knownHostFingerprint: 'aa' });
    const ssh = makeSshServiceStub({ connections: [conn] });
    const session = makeSshSessionServiceStub();
    // Inject a binary buffer (NUL inside).
    const original = Buffer.from([0xde, 0xad, 0x00, 0xbe, 0xef]);
    session.sftpDownload = async (connId, remotePath, opts) => {
      session.calls.download.push({ connId: String(connId), remotePath, opts });
      return { content: original, bytesRead: original.length, truncated: false };
    };
    const server = makeFakeServer();
    mcpTools.registerMcpTools(server, buildServices({ sshService: ssh, sshSessionService: session }));
    const res = unwrap(await server.invoke('ssh_download', {
      connectionId: conn._id.toString(),
      remotePath: '/tmp/blob',
      // requested encoding utf-8 by default — but binary detection downgrades
    }));
    assert.ok(!res.error, `unexpected error: ${res.error}`);
    assert.equal(res.value.encoding, 'base64');
    const decoded = Buffer.from(res.value.content, 'base64');
    assert.ok(decoded.equals(original));
    assert.equal(res.value.bytesRead, 5);
    assert.equal(res.value.truncated, false);
  });

  await check('ssh_download keeps utf-8 when buffer is round-trip safe', async () => {
    const projectId = new Types.ObjectId();
    const conn = makeConn({ projectId, knownHostFingerprint: 'aa' });
    const ssh = makeSshServiceStub({ connections: [conn] });
    const session = makeSshSessionServiceStub();
    const original = Buffer.from('hello\nworld\n', 'utf8');
    session.sftpDownload = async (connId, remotePath, opts) => {
      session.calls.download.push({ connId: String(connId), remotePath, opts });
      return { content: original, bytesRead: original.length, truncated: false };
    };
    const server = makeFakeServer();
    mcpTools.registerMcpTools(server, buildServices({ sshService: ssh, sshSessionService: session }));
    const res = unwrap(await server.invoke('ssh_download', {
      connectionId: conn._id.toString(),
      remotePath: '/tmp/text',
    }));
    assert.ok(!res.error, `unexpected error: ${res.error}`);
    assert.equal(res.value.encoding, 'utf-8');
    assert.equal(res.value.content, 'hello\nworld\n');
  });

  // -------------------------------------------------------------------------
  // ssh_list_files
  // -------------------------------------------------------------------------
  await check('ssh_list_files pass-through entries + truncated', async () => {
    const projectId = new Types.ObjectId();
    const conn = makeConn({ projectId, knownHostFingerprint: 'aa' });
    const ssh = makeSshServiceStub({ connections: [conn] });
    const session = makeSshSessionServiceStub();
    session.listFiles = async (connId, remotePath, opts) => {
      session.calls.listFiles.push({ connId: String(connId), remotePath, opts });
      return {
        entries: [
          { name: 'x', path: '/srv/x', type: 'file', size: 1, mode: 0o600, mtime: new Date(0) },
          { name: 'y', path: '/srv/y', type: 'dir', size: 0, mode: 0o755, mtime: new Date(0) },
        ],
        truncated: true,
      };
    };
    const server = makeFakeServer();
    mcpTools.registerMcpTools(server, buildServices({ sshService: ssh, sshSessionService: session }));
    const res = unwrap(await server.invoke('ssh_list_files', {
      connectionId: conn._id.toString(),
      remotePath: '/srv',
      recursive: true,
      maxEntries: 500,
    }));
    assert.ok(!res.error, `unexpected error: ${res.error}`);
    assert.equal(res.value.entries.length, 2);
    assert.equal(res.value.entries[0].name, 'x');
    assert.equal(res.value.entries[1].type, 'dir');
    assert.equal(res.value.truncated, true);
    const call = session.calls.listFiles[0];
    assert.equal(call.opts.recursive, true);
    assert.equal(call.opts.maxEntries, 500);
    assert.equal(call.opts.sourceContext, 'mcp');
  });

  // -------------------------------------------------------------------------
  // isUtf8RoundTripSafe helper (exported alongside deriveSshStatus)
  // -------------------------------------------------------------------------
  await check('isUtf8RoundTripSafe rejects null bytes and malformed utf-8', async () => {
    assert.equal(mcpTools.isUtf8RoundTripSafe(Buffer.from('hello')), true);
    assert.equal(mcpTools.isUtf8RoundTripSafe(Buffer.from([0x68, 0x00, 0x69])), false);
    // Lone continuation byte 0x80 — invalid UTF-8 start. The Buffer toString
    // replaces with U+FFFD which doesn't round-trip.
    assert.equal(mcpTools.isUtf8RoundTripSafe(Buffer.from([0x80])), false);
  });

  if (failures > 0) {
    console.error(`\n${failures}/${total} test(s) failed`);
    process.exit(1);
  }
  console.log(`\n${total}/${total} test(s) passed`);
})().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(2);
});
