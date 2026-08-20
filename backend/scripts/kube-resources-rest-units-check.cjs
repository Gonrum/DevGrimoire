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

/** Express-artiges Request-Double mit steuerbarem 'close'-Event. */
function makeFakeReq(userId = 'u1') {
  const listeners = [];
  return {
    user: { userId },
    on(event, cb) { if (event === 'close') listeners.push(cb); },
    __fireClose() { for (const cb of listeners.slice()) cb(); },
  };
}

const authReq = { user: { userId: 'u1' } };
const auditStub = { async record() {} };
const clustersOk = { async findById(id) { return { _id: id }; } };

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
