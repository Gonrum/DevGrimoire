#!/usr/bin/env node
/*
 * Pure-logic regression check for KubeResourcesController (K2, Task 5 Fix
 * Round 1). Pins review findings that only show up at the REST layer — not
 * in KubeResourcesService or KubeLogsService themselves, which is why
 * neither kube-resources-check.cjs nor kube-logs-check.cjs could catch them:
 *
 *   - Critical 2: a client that vanishes WHILE open() is still pending must
 *     not leak the log session — the close listener has to be registered
 *     before the `await`, not after, and a `clientGone` flag must short-
 *     circuit before ever touching `session.lines`.
 *   - Important 3: guarded() must map a cluster ApiException's numeric
 *     `.code` to a real HttpException for 4xx, to 503 for transport/5xx,
 *     and rethrow anything else UNCHANGED so a genuine bug still surfaces
 *     as an unhandled 500 with its stack (Nest's filter does not log an
 *     HttpException — wrapping a real bug in one would hide it).
 *   - Important 4: the cluster must be resolved BEFORE the first
 *     `res.setHeader()` call on /logs/stream, so an unknown cluster id
 *     leaves as a clean JSON 404/400, never a half-opened SSE stream.
 *   - Minor: the heartbeat timer must be cleared on every exit path.
 *   - Critical 1 (DTO half): `?token=` must survive the global
 *     ValidationPipe's `forbidNonWhitelisted` — pinned here at the DTO
 *     level; the live guard interaction is pinned by kube-cluster-e2e.sh.
 *
 * Same lightweight style as ssh-rest-units-check.cjs: direct instantiation,
 * no Nest DI container, fakes for req/res/service dependencies.
 *
 * Run with `npm run check:kube-resources-rest` from backend/ after `npm run build`.
 */
const path = require('node:path');
const assert = require('node:assert/strict');
const { HttpException, NotFoundException } = require('@nestjs/common');
const { validate } = require('class-validator');
const { plainToInstance } = require('class-transformer');

function loadCompiled(rel) {
  const abs = path.resolve(__dirname, '..', 'dist', rel);
  try { return require(abs); } catch (err) {
    console.error(`Failed to load ${abs}. Run \`npm run build\` first.`);
    console.error(err.message);
    process.exit(2);
  }
}

const { KubeResourcesController } = loadCompiled('kube/kube-resources.controller.js');
const { LogsQueryDto } = loadCompiled('kube/dto/logs-query.dto.js');

const CHECK_TIMEOUT_MS = 3000;
let failures = 0, total = 0;
function check(label, fn) {
  total += 1;
  let timer;
  // Case "C2" reproduces a real leak-shaped hang if the fix regresses — a
  // plain await would let that hang the whole script silently (same lesson
  // as kube-logs-check.cjs's CHECK_TIMEOUT_MS).
  const settleGuard = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Zeitlimit (${CHECK_TIMEOUT_MS}ms) überschritten — der Fall hängt vermutlich (kein settle).`)),
      CHECK_TIMEOUT_MS,
    );
  });
  return Promise.race([Promise.resolve().then(fn), settleGuard]).then(
    () => { clearTimeout(timer); console.log(`✓ ${label}`); },
    (err) => {
      clearTimeout(timer);
      failures += 1;
      console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`);
    },
  );
}

function makeFakeRes() {
  const res = {
    headers: {},
    writes: [],
    writableEnded: false,
    setHeader(name, val) { res.headers[name] = val; },
    flushHeaders() {},
    write(chunk) { res.writes.push(chunk); return true; },
    end() { res.writableEnded = true; },
  };
  return res;
}

/**
 * Express-artiges Request-Double mit steuerbarem 'close'-Event UND einem
 * schreibbaren `destroyed`-Flag (Runde 2: die Absicherung direkt nach
 * `findById`, unabhängig vom 'close'-Event).
 */
function makeFakeReq(userId = 'u1') {
  const listeners = [];
  return {
    user: { userId },
    destroyed: false,
    on(event, cb) { if (event === 'close') listeners.push(cb); },
    __fireClose() { for (const cb of listeners.slice()) cb(); },
  };
}

const authReq = { user: { userId: 'u1' } };
/** Derselbe Actor, aber über einen API-Key statt über ein Browser-JWT. */
const apiKeyReq = { user: { userId: 'u1', apiKeyId: 'k1' } };
const auditStub = { async record() {} };
const clustersOk = { async findById(id) { return { _id: id }; } };

/** Audit-Attrappe, die die geschriebenen Zeilen festhält. */
function makeAuditRecorder() {
  const rows = [];
  return { rows, async record(entry) { rows.push(entry); } };
}

(async () => {
  await check(
    'logStream: ein Client, der geht WÄHREND open() noch läuft, gibt die Session trotzdem frei (kein Hänger)',
    async () => {
      // Kritisch 2 (Review-Fund): der alte Code registrierte req.on('close', …)
      // erst NACH dem await auf open() — feuerte 'close' währenddessen (wie
      // hier simuliert), sah der Handler es nie, und `session.lines` (hier
      // absichtlich EIN Wert + danach für immer offen, wie ein ruhiger
      // follow-Stream) hätte für die Lebensdauer des Pods weitergelaufen.
      let resolveOpen;
      const openPromise = new Promise((resolve) => { resolveOpen = resolve; });
      const state = { closeCalls: 0 };
      const session = {
        lines: (async function* () {
          yield 'sollte nie gesendet werden — clientGone bricht vor der Schleife ab';
          await new Promise(() => {}); // hängt bewusst; nur close() darf das beenden
        })(),
        close() { state.closeCalls += 1; },
        error() { return undefined; },
      };
      const logs = { async open() { return openPromise; } };
      const ctrl = new KubeResourcesController({}, logs, auditStub, clustersOk);
      const req = makeFakeReq();
      const res = makeFakeRes();

      const handlerDone = ctrl.logStream('c1', { namespace: 'prod', pod: 'api' }, req, res);
      // Lässt den synchronen Teil bis zum await auf open() durchlaufen —
      // danach ist der close-Listener registriert (Fix: VOR dem await).
      await new Promise((r) => setImmediate(r));
      req.__fireClose(); // Client geht, WÄHREND open() noch aussteht.
      resolveOpen(session);
      await handlerDone;

      assert.equal(state.closeCalls, 1, `close() wurde ${state.closeCalls}x aufgerufen, erwartet genau 1`);
      assert.equal(res.writableEnded, true, 'die Antwort wurde nie beendet — der Handler hing');
      assert.equal(res.writes.length, 0, 'es wurde eine Zeile gesendet, obwohl der Client schon weg war');
    },
  );

  await check(
    'logStream: ein Client, der geht WÄHREND clusters.findById() noch läuft, öffnet den Log-Stream gar nicht erst (Runde 2)',
    async () => {
      // Runde 2 (Review-Fund): Rundes-1-Fix registrierte den close-Listener
      // VOR open(), aber NACH clusters.findById() — ein schmaleres, aber
      // strukturell identisches Fenster wie das ursprüngliche Critical 2.
      // Ein Client, der genau während dieses einen Lookups geht, hätte
      // clientGone nie gesetzt gesehen, open() trotzdem aufgerufen und bei
      // follow=true für die Lebensdauer des Pods weitergelaufen.
      let resolveFindById;
      const findByIdPromise = new Promise((resolve) => { resolveFindById = resolve; });
      const clustersSlow = { async findById() { return findByIdPromise; } };
      let openCalls = 0;
      const logs = {
        async open() {
          openCalls += 1;
          return { lines: (async function* () { })(), close() {}, error() { return undefined; } };
        },
      };
      const ctrl = new KubeResourcesController({}, logs, auditStub, clustersSlow);
      const req = makeFakeReq();
      const res = makeFakeRes();

      const handlerDone = ctrl.logStream('c1', { namespace: 'prod', pod: 'api' }, req, res);
      // Lässt den synchronen Teil bis zum await auf findById() durchlaufen —
      // der close-Listener ist zu diesem Zeitpunkt bereits registriert
      // (Fix: VOR jedem await, nicht nur vor open()).
      await new Promise((r) => setImmediate(r));
      req.__fireClose(); // Client geht, WÄHREND findById() noch aussteht.
      resolveFindById({ _id: 'c1' });
      await handlerDone;

      assert.equal(openCalls, 0, `logs.open() wurde ${openCalls}x aufgerufen — ein bereits gegangener Client hätte den Stream nie öffnen dürfen`);
      assert.deepEqual(res.headers, {}, 'Header wurden gesetzt, obwohl der Client schon vor dem ersten setHeader weg war');
      assert.equal(res.writes.length, 0, 'es wurde in die Antwort geschrieben, obwohl der Client schon weg war');
    },
  );

  await check(
    'logStream: req.destroyed (ohne dass close schon gefeuert hat) verhindert das Öffnen ebenfalls (Runde 2)',
    async () => {
      // Die zweite, synchrone Absicherung direkt nach findById: Node setzt
      // `destroyed` beim Zerstören eines Streams sofort, das 'close'-Event
      // selbst kann noch einen Tick brauchen. Dieser Fall testet GENAU
      // diesen Pfad, indem er __fireClose() bewusst NICHT aufruft.
      let resolveFindById;
      const findByIdPromise = new Promise((resolve) => { resolveFindById = resolve; });
      const clustersSlow = { async findById() { return findByIdPromise; } };
      let openCalls = 0;
      const logs = {
        async open() {
          openCalls += 1;
          return { lines: (async function* () { })(), close() {}, error() { return undefined; } };
        },
      };
      const ctrl = new KubeResourcesController({}, logs, auditStub, clustersSlow);
      const req = makeFakeReq();
      const res = makeFakeRes();

      const handlerDone = ctrl.logStream('c1', { namespace: 'prod', pod: 'api' }, req, res);
      await new Promise((r) => setImmediate(r));
      req.destroyed = true; // Verbindung schon weg, 'close' aber (noch) nicht gefeuert.
      resolveFindById({ _id: 'c1' });
      await handlerDone;

      assert.equal(openCalls, 0, `logs.open() wurde ${openCalls}x aufgerufen trotz req.destroyed`);
      assert.deepEqual(res.headers, {}, 'Header wurden trotz req.destroyed gesetzt');
    },
  );

  await check(
    'logStream: Heartbeat-Timer wird auf jedem Ausstiegspfad garantiert gelöscht',
    async () => {
      const realSetInterval = global.setInterval;
      const realClearInterval = global.clearInterval;
      const created = [];
      const cleared = [];
      global.setInterval = (fn, ms) => { const t = realSetInterval(fn, ms); created.push(t); return t; };
      global.clearInterval = (t) => { cleared.push(t); return realClearInterval(t); };
      try {
        const session = {
          lines: (async function* () { /* leer — endet sofort regulär */ })(),
          close() {}, error() { return undefined; },
        };
        const logs = { async open() { return session; } };
        const ctrl = new KubeResourcesController({}, logs, auditStub, clustersOk);
        await ctrl.logStream('c1', { namespace: 'prod', pod: 'api' }, makeFakeReq(), makeFakeRes());
        assert.equal(created.length, 1, 'kein Heartbeat-Timer wurde angelegt');
        assert.deepEqual(cleared, created, 'der Heartbeat-Timer wurde nicht (oder ein falscher) gelöscht');
      } finally {
        global.setInterval = realSetInterval;
        global.clearInterval = realClearInterval;
      }
    },
  );

  await check(
    'logStream: ein unbekannter Cluster wirft VOR dem ersten setHeader (kein halb geöffneter Stream)',
    async () => {
      // Important 4 (Review-Fund): workspaces.controller.ts (execStream)
      // löst die Entity ebenfalls vor dem ersten setHeader auf — derselbe
      // Grund: der Browser bekommt eine saubere JSON-Antwort statt eines
      // 200 mit einem type:error-Event mittendrin.
      const clustersFail = { async findById() { throw new NotFoundException('Kube-Cluster x nicht gefunden'); } };
      const ctrl = new KubeResourcesController({}, {}, auditStub, clustersFail);
      const req = makeFakeReq();
      const res = makeFakeRes();
      let caught = null;
      try {
        await ctrl.logStream('unknown', { namespace: 'prod', pod: 'api' }, req, res);
      } catch (err) { caught = err; }
      assert.ok(caught instanceof NotFoundException, 'kein NotFoundException geworfen');
      assert.deepEqual(res.headers, {}, 'Header wurden bereits gesetzt, bevor der Cluster aufgelöst war');
      assert.equal(res.writes.length, 0, 'es wurde bereits in die Antwort geschrieben');
    },
  );

  await check(
    'guarded(): ein Cluster-ApiException mit code 404 wird zu einer 404-HttpException, nicht 503',
    async () => {
      // Important 3 (Review-Fund): @kubernetes/client-node's ApiException
      // (gen/apis/exception.js) ist kein Nest-HttpException — ohne die
      // .code-Erkennung landete "pod not found" hinter einem 503 "cluster
      // unavailable", genau während des Incidents, in dem das zählt.
      const apiErr = new Error('HTTP-Code: 404\nMessage: pods "foo" not found\nBody: {"message":"pods \\"foo\\" not found"}\nHeaders: {}');
      apiErr.code = 404;
      apiErr.body = { message: 'pods "foo" not found' };
      const resources = { async list() { throw apiErr; } };
      const ctrl = new KubeResourcesController(resources, {}, auditStub, clustersOk);
      let caught = null;
      try { await ctrl.list('c1', { kind: 'Pod' }, authReq); } catch (err) { caught = err; }
      assert.ok(caught instanceof HttpException, 'kein HttpException geworfen');
      assert.equal(caught.getStatus(), 404, `Status war ${caught.getStatus && caught.getStatus()}`);
      assert.equal(caught.message, 'pods "foo" not found', `Meldung war "${caught.message}" — die rohe ApiException.message statt der Status.message aus dem Body`);
    },
  );

  await check(
    'guarded(): "fetch failed" (undici, unerreichbarer Cluster) wird zu 503, nicht durchgereicht',
    async () => {
      const err = new TypeError('fetch failed');
      err.cause = Object.assign(new Error('getaddrinfo ENOTFOUND cluster.invalid'), { code: 'ENOTFOUND' });
      const resources = { async list() { throw err; } };
      const ctrl = new KubeResourcesController(resources, {}, auditStub, clustersOk);
      let caught = null;
      try { await ctrl.list('c1', { kind: 'Pod' }, authReq); } catch (e) { caught = e; }
      assert.ok(caught instanceof HttpException, 'kein HttpException geworfen');
      assert.equal(caught.getStatus(), 503, `Status war ${caught.getStatus && caught.getStatus()}`);
    },
  );

  await check(
    'guarded(): ein unerkannter Fehler (echter Bug im eigenen Code) läuft UNVERÄNDERT durch, kein 503',
    async () => {
      // Wichtig, weil Nests eingebauter Filter eine HttpException NICHT
      // loggt (das ist der "behandelte" Pfad) — ein 503 hier würde einen
      // echten Bug ohne Stacktrace verschwinden lassen.
      const bug = new TypeError("Cannot read properties of undefined (reading 'foo')");
      const resources = { async list() { throw bug; } };
      const ctrl = new KubeResourcesController(resources, {}, auditStub, clustersOk);
      let caught = null;
      try { await ctrl.list('c1', { kind: 'Pod' }, authReq); } catch (e) { caught = e; }
      assert.equal(caught, bug, 'der Fehler wurde ersetzt statt unverändert durchgereicht');
      assert.ok(!(caught instanceof HttpException), 'ein echter Bug wurde fälschlich in eine HttpException verpackt');
    },
  );

  await check(
    'guarded(): ein Bug an einem TLS-klingenden Bezeichner (skipTLSVerify) läuft UNVERÄNDERT durch, kein 503 (Runde 2)',
    async () => {
      // Runde 2 (Review-Fund): vorher stand hier ein /certificate|TLS|SSL/i-
      // Textmuster auf der zusammengesetzten Meldung — dieses Modul hat
      // lebende Bezeichner wie skipTLSVerify/tlsServerName/allowInsecureTls,
      // ein TypeError genau an so einer Stelle hätte gematcht und wäre als
      // warn-geloggtes 503 OHNE Stacktrace verschwunden. Der Regex ist weg;
      // dieser Fall pinnt, dass ein solcher Bug jetzt wieder roh durchläuft.
      const bug = new TypeError("Cannot read properties of undefined (reading 'skipTLSVerify')");
      const resources = { async list() { throw bug; } };
      const ctrl = new KubeResourcesController(resources, {}, auditStub, clustersOk);
      let caught = null;
      try { await ctrl.list('c1', { kind: 'Pod' }, authReq); } catch (e) { caught = e; }
      assert.equal(caught, bug, 'der Fehler wurde ersetzt statt unverändert durchgereicht');
      assert.ok(!(caught instanceof HttpException), 'ein Bug an einem TLS-klingenden Bezeichner wurde fälschlich zu 503');
    },
  );

  await check(
    'guarded(): eine echte OpenSSL-Verifikationsfehler-Ursache (UNABLE_TO_VERIFY_LEAF_SIGNATURE) wird zu 503 (Runde 2)',
    async () => {
      // Strukturelles Gegenstück zum vorigen Fall: ein ECHTER TLS-Fehler
      // (hier direkt über .cause.code modelliert, nicht über den
      // fetch-failed-Zweig) muss weiterhin als Transport-Störung erkannt
      // werden — nur eben über den stabilen Code, nicht über einen Text-
      // Treffer.
      const err = new Error('unable to verify the first certificate');
      err.cause = Object.assign(new Error('self-signed certificate'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' });
      const resources = { async list() { throw err; } };
      const ctrl = new KubeResourcesController(resources, {}, auditStub, clustersOk);
      let caught = null;
      try { await ctrl.list('c1', { kind: 'Pod' }, authReq); } catch (e) { caught = e; }
      assert.ok(caught instanceof HttpException, 'kein HttpException geworfen');
      assert.equal(caught.getStatus(), 503, `Status war ${caught.getStatus && caught.getStatus()}`);
    },
  );

  // ---------------------------------------------------------------------------
  // Audit-Vollständigkeit und Herkunft (Review-Fund I2)
  //
  // Spec: „Reads werden auditiert, aber ohne Payload." Gemessen schrieben
  // namespaces/resources/resources/:kind/:name eine Zeile, …/yaml,
  // describe/… und events KEINE. `sourceContext` stand auf allen sechs
  // Routen fest auf 'ui' — ein API-Key-Aufruf wurde als Browser-Verkehr
  // protokolliert, obwohl K1s `KubeClientService.test()` für dieselbe
  // Controller-Familie 'rest' schreibt.
  // ---------------------------------------------------------------------------
  const AUDITED_READS = [
    {
      label: 'namespaces',
      call: (ctrl, req) => ctrl.namespaces('c1', req),
      resources: { async listNamespaces() { return []; } },
      expect: { action: 'list', resource: 'Namespace' },
    },
    {
      label: 'resources (list)',
      call: (ctrl, req) => ctrl.list('c1', { kind: 'Pod', namespace: 'prod' }, req),
      resources: { async list() { return []; } },
      expect: { action: 'list', resource: 'Pod', namespace: 'prod' },
    },
    {
      label: 'resources/:kind/:name',
      call: (ctrl, req) => ctrl.get('c1', 'Pod', 'api', { namespace: 'prod' }, req),
      resources: { async get() { return {}; } },
      expect: { action: 'get', resource: 'Pod', namespace: 'prod', name: 'api' },
    },
    {
      label: 'resources/:kind/:name/yaml',
      call: (ctrl, req) => ctrl.yaml('c1', 'Secret', 'db', { namespace: 'prod' }, req),
      resources: { async getYaml() { return 'kind: Secret\n'; } },
      expect: { action: 'get', resource: 'Secret', namespace: 'prod', name: 'db' },
    },
    {
      label: 'describe/:kind/:name',
      call: (ctrl, req) => ctrl.describe('c1', 'Pod', 'api', { namespace: 'prod' }, req),
      resources: { async describe() { return { object: {}, events: [], conditions: [] }; } },
      expect: { action: 'get', resource: 'Pod', namespace: 'prod', name: 'api' },
    },
    {
      label: 'events',
      call: (ctrl, req) => ctrl.events('c1', { namespace: 'prod' }, req),
      resources: { async events() { return []; } },
      expect: { action: 'list', resource: 'Event', namespace: 'prod' },
    },
  ];

  for (const route of AUDITED_READS) {
    await check(`Audit: ${route.label} schreibt genau eine Zeile`, async () => {
      const audit = makeAuditRecorder();
      const ctrl = new KubeResourcesController(route.resources, {}, audit, clustersOk);
      await route.call(ctrl, authReq);
      assert.equal(audit.rows.length, 1, `${audit.rows.length} Audit-Zeilen statt 1`);
      const row = audit.rows[0];
      for (const [key, value] of Object.entries(route.expect)) {
        assert.equal(row[key], value, `${key} war ${JSON.stringify(row[key])}, erwartet ${JSON.stringify(value)}`);
      }
      assert.equal(row.clusterId, 'c1');
      assert.equal(row.userId, 'u1');
    });

    await check(`Audit: ${route.label} unterscheidet API-Key ('rest') von Browser ('ui')`, async () => {
      const uiAudit = makeAuditRecorder();
      await route.call(new KubeResourcesController(route.resources, {}, uiAudit, clustersOk), authReq);
      assert.equal(uiAudit.rows[0].sourceContext, 'ui');

      const restAudit = makeAuditRecorder();
      await route.call(new KubeResourcesController(route.resources, {}, restAudit, clustersOk), apiKeyReq);
      assert.equal(restAudit.rows[0].sourceContext, 'rest',
        'ein API-Key-Aufruf wurde als Browser-Verkehr protokolliert');
    });
  }

  await check('Audit: logStream schreibt auch dann eine Zeile, wenn open() scheitert', async () => {
    const audit = makeAuditRecorder();
    const logs = { async open() { const e = new Error('boom'); e.code = 404; e.body = { message: 'pods "api" not found' }; throw e; } };
    const ctrl = new KubeResourcesController({}, logs, audit, clustersOk);
    await ctrl.logStream('c1', { namespace: 'prod', pod: 'api' }, makeFakeReq(), makeFakeRes());
    assert.equal(audit.rows.length, 1, `${audit.rows.length} Audit-Zeilen statt 1`);
    assert.equal(audit.rows[0].action, 'logs');
    assert.equal(audit.rows[0].sourceContext, 'ui');
    assert.match(audit.rows[0].errorMsg ?? '', /not found/,
      'der Grund des Fehlschlags steht nicht in der Audit-Zeile');
  });

  await check('Audit: logStream schreibt eine Zeile, wenn der Client vor dem Öffnen geht', async () => {
    const audit = makeAuditRecorder();
    let resolveFindById;
    const findByIdPromise = new Promise((resolve) => { resolveFindById = resolve; });
    const clustersSlow = { async findById() { return findByIdPromise; } };
    const ctrl = new KubeResourcesController({}, { async open() { throw new Error('darf nie laufen'); } }, audit, clustersSlow);
    const req = makeFakeReq();
    const done = ctrl.logStream('c1', { namespace: 'prod', pod: 'api' }, req, makeFakeRes());
    await new Promise((r) => setImmediate(r));
    req.__fireClose();
    resolveFindById({ _id: 'c1' });
    await done;
    assert.equal(audit.rows.length, 1, `${audit.rows.length} Audit-Zeilen statt 1 — der Abbruch vor open() blieb unprotokolliert`);
    assert.equal(audit.rows[0].action, 'logs');
  });

  await check('Audit: logStream schreibt genau eine Zeile auf dem Erfolgspfad', async () => {
    const audit = makeAuditRecorder();
    const logs = {
      async open() {
        return {
          lines: (async function* () { yield 'a'; yield 'b'; })(),
          close() {}, error() { return undefined; },
        };
      },
    };
    const ctrl = new KubeResourcesController({}, logs, audit, clustersOk);
    await ctrl.logStream('c1', { namespace: 'prod', pod: 'api' }, makeFakeReq(), makeFakeRes());
    assert.equal(audit.rows.length, 1, `${audit.rows.length} Audit-Zeilen statt 1`);
    assert.equal(audit.rows[0].errorMsg, undefined);
    assert.equal(audit.rows[0].name, 'api');
    assert.ok(typeof audit.rows[0].durationMs === 'number');
  });

  await check(
    'LogsQueryDto: ?token= wird von der globalen ValidationPipe akzeptiert (kein forbidNonWhitelisted-400)',
    async () => {
      // Kritisch 1 (Review-Fund): EventSource kann keine Header setzen —
      // ?token= ist der einzige Weg, wie ein Browser diese Route
      // authentifiziert aufruft. Ohne das Feld lehnt whitelist:true +
      // forbidNonWhitelisted:true (main.ts) den Parameter ab, BEVOR der
      // Guard ihn je sieht.
      const dto = plainToInstance(
        LogsQueryDto,
        { namespace: 'prod', pod: 'api', token: 'header.payload.signature' },
      );
      const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
      assert.equal(errors.length, 0, `Validierung schlug fehl: ${JSON.stringify(errors)}`);
    },
  );

  console.log('');
  console.log(`Kube resources REST checks: ${total - failures}/${total} passed`);
  process.exit(failures > 0 ? 1 : 0);
})();
