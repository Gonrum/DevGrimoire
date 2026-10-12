#!/usr/bin/env node
/*
 * Replication-Log-Writer-Check (Review-Fund H-38, 2026-10-12).
 *
 * Vorher: ein ungültiger Resume-Token (aus dem capped Oplog herausgefallen)
 * beendete den Watcher dauerhaft — `consume()` loggte den Fehler und stoppte
 * den Heartbeat, ohne Retry. Und weil der Token persistiert blieb, las ihn
 * jeder Backend-Neustart erneut und starb sofort wieder. Live beobachtet:
 * sechs Tage ohne einen einzigen replication_log-Eintrag bei 531 nachweislich
 * geänderten Dokumenten, `replication.role = peer`, Container durchgehend
 * `healthy`.
 *
 * Dieser Check belegt das neue Verhalten gegen einen Fake-Change-Stream:
 * Neustart ohne Token, Token wird geleert, andere Fehler lösen KEINEN
 * Neustart aus, das Neustart-Limit greift, und Shutdown startet nichts neu.
 *
 * Lädt aus dist/; vorher `npm run build`.
 */
const path = require('node:path');
const assert = require('node:assert/strict');

function loadCompiled(rel) {
  const abs = path.resolve(__dirname, '..', 'dist', rel);
  try { return require(abs); } catch (err) {
    console.error(`Failed to load ${abs}. Run \`npm load ${abs}\``);
    console.error(err.message);
    process.exit(2);
  }
}

const { ReplicationLogWriterService } = loadCompiled('replication/replication-log-writer.service.js');
const {
  REPL_WATCHER_RESUME_TOKEN,
  REPL_FULL_SYNC_CRON,
} = loadCompiled('replication/replication.constants.js');

const EXPECTED_CHECKS = 5;

let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

/** Der reale Meldungstext aus dem Live-Betrieb (2026-10-12). */
const RESUME_LOST_MESSAGE =
  'PlanExecutor error during aggregation :: caused by :: Resume of change stream was not possible, '
  + 'as the resume point may no longer be in the oplog.';

function resumeLostError() {
  // So liefert es der Treiber: Code 286 plus errorLabel.
  return Object.assign(new Error(RESUME_LOST_MESSAGE), {
    code: 286,
    errorLabels: ['ChangeStreamHistoryLost'],
  });
}

/**
 * Fake-Change-Stream. `behaviour` steuert, was die erste Iteration tut:
 *  - 'resume-lost': wirft den ChangeStreamHistoryLost-Fehler
 *  - 'other'       : wirft einen beliebigen anderen Fehler
 *  - 'end'         : endet sofort regulär
 */
function makeStream(behaviour) {
  const stream = {
    closed: false,
    async close() { stream.closed = true; },
    [Symbol.asyncIterator]() {
      let n = 0;
      return {
        async next() {
          n += 1;
          if (n === 1) {
            if (behaviour === 'resume-lost') throw resumeLostError();
            if (behaviour === 'other') throw new Error('irgendein anderer Treiberfehler');
          }
          return { done: true, value: undefined };
        },
      };
    },
  };
  return stream;
}

/**
 * Baut den Service mit Stubs. `streamBehaviours` ist eine Liste — pro
 * `db.watch()`-Aufruf wird das nächste Verhalten genommen (das letzte bleibt
 * für weitere Aufrufe stehen). `watchCalls` sammelt die Optionen, damit der
 * Test sehen kann, ob mit oder ohne `resumeAfter` gestartet wurde.
 */
function makeService({ storedToken = null, streamBehaviours = ['end'] } = {}) {
  const settings = new Map();
  if (storedToken !== null) settings.set(REPL_WATCHER_RESUME_TOKEN, storedToken);
  settings.set(REPL_FULL_SYNC_CRON, '0 3 * * *');
  const settingsCalls = { set: [] };

  const watchCalls = [];
  let watchIndex = 0;
  const streams = [];
  const db = {
    watch(pipeline, options) {
      watchCalls.push({ options });
      const behaviour = streamBehaviours[Math.min(watchIndex, streamBehaviours.length - 1)];
      watchIndex += 1;
      const s = makeStream(behaviour);
      streams.push(s);
      return s;
    },
    async command() { return { ok: 1 }; },
  };

  const svc = new ReplicationLogWriterService(
    { db },
    { create: async (d) => d, findOne: () => ({ exec: async () => null }) },
    { findOne: () => ({ exec: async () => null }), deleteMany: () => ({ exec: async () => ({}) }) },
    { nextSeq: async () => 1 },
    {
      async get(key) { return settings.has(key) ? settings.get(key) : null; },
      async set(key, value) { settingsCalls.set.push({ key, value }); settings.set(key, value); return { key, value }; },
    },
  );

  const logs = { log: [], warn: [], error: [] };
  svc.logger = {
    log: (m) => logs.log.push(String(m)),
    warn: (m) => logs.warn.push(String(m)),
    error: (m) => logs.error.push(String(m)),
    debug: () => {}, verbose: () => {},
  };

  return { svc, watchCalls, streams, settingsCalls, settings, logs };
}

/** Wartet, bis `predicate` wahr ist — consume() läuft fire-and-forget. */
async function waitFor(predicate, timeoutMs = 3000, what = 'Bedingung') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Zeitüberschreitung beim Warten auf: ${what}`);
}

const VALID_TOKEN = JSON.stringify({ _data: '8265F1A2B3000000012B022C0100296E5A1004' });

(async () => {
  await check('start() mit gespeichertem Token setzt resumeAfter', async () => {
    const fx = makeService({ storedToken: VALID_TOKEN, streamBehaviours: ['end'] });
    await fx.svc.start();
    await waitFor(() => fx.watchCalls.length === 1, 2000, 'erster watch()-Aufruf');
    assert.ok(fx.watchCalls[0].options.resumeAfter,
      'der gespeicherte Token wurde nicht als resumeAfter übernommen');
    assert.equal(fx.watchCalls[0].options.resumeAfter._data, JSON.parse(VALID_TOKEN)._data);
    fx.svc.onModuleDestroy();
  });

  await check('Resume-Fehler: Token wird geleert und der Stream startet OHNE resumeAfter neu', async () => {
    const fx = makeService({ storedToken: VALID_TOKEN, streamBehaviours: ['resume-lost', 'end'] });
    await fx.svc.start();
    // Zweiter watch()-Aufruf = der frische Neustart.
    await waitFor(() => fx.watchCalls.length >= 2, 4000, 'Neustart nach Resume-Fehler');
    assert.equal(fx.watchCalls[1].options.resumeAfter, undefined,
      'der Neustart hat denselben ungültigen Token wieder benutzt — das war die Ausfallschleife');
    // Der Token muss geleert sein, sonst stirbt der nächste Prozess-Start erneut.
    const cleared = fx.settingsCalls.set.find((c) => c.key === REPL_WATCHER_RESUME_TOKEN);
    assert.ok(cleared, 'der Resume-Token wurde nicht geleert');
    assert.equal(cleared.value, '', 'der Token wurde nicht auf leer gesetzt');
    assert.equal(fx.settings.get(REPL_WATCHER_RESUME_TOKEN), '');
    // Und die Warnung muss die Lücke benennen, nicht nur „Fehler".
    const warn = fx.logs.warn.join('\n');
    assert.match(warn, /Resume-Token ungültig/, 'die Warnung fehlt');
    assert.match(warn, /fehlen im inkrementellen Log/, 'die Warnung verschweigt die Lücke');
    assert.match(warn, /0 3 \* \* \*/, 'die Warnung nennt den Vollabgleich-Cron nicht');
    assert.equal(fx.logs.error.length, 0,
      `ein heilbarer Token-Fehler wurde als error geloggt: ${JSON.stringify(fx.logs.error)}`);
    fx.svc.onModuleDestroy();
  });

  await check('ein ANDERER Fehler löst keinen Neustart aus', async () => {
    const fx = makeService({ storedToken: VALID_TOKEN, streamBehaviours: ['other'] });
    await fx.svc.start();
    // Kurz warten — wenn fälschlich neu gestartet würde, sähen wir watch() #2.
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(fx.watchCalls.length, 1,
      `ein nicht-Token-Fehler hat ${fx.watchCalls.length} watch()-Aufrufe ausgelöst — erwartet 1`);
    assert.equal(fx.logs.error.length, 1, 'der Fehler wurde nicht als error geloggt');
    assert.match(fx.logs.error[0], /irgendein anderer Treiberfehler/);
    assert.equal(fx.settings.get(REPL_WATCHER_RESUME_TOKEN), VALID_TOKEN,
      'der Token wurde bei einem Fremdfehler verworfen — dann geht der Fortschritt verloren');
    fx.svc.onModuleDestroy();
  });

  await check('Neustart-Limit: kein endloser Neustart, wenn auch der frische Stream stirbt', async () => {
    // Jeder Stream wirft denselben Resume-Fehler. Ohne Obergrenze entstünde
    // eine stille Endlosschleife aus Neustart -> Fehler -> Neustart.
    const fx = makeService({ storedToken: VALID_TOKEN, streamBehaviours: ['resume-lost'] });
    await fx.svc.start();
    // 1 Start mit Token + MAX_FRESH_RESTARTS(3) frische Neustarts = 4 watch().
    await waitFor(() => fx.watchCalls.length >= 4, 6000, 'vier watch()-Aufrufe');
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(fx.watchCalls.length, 4,
      `erwartet genau 4 watch()-Aufrufe (1 + 3 Neustarts), bekam ${fx.watchCalls.length}`);
    const gaveUp = fx.logs.error.join('\n');
    assert.match(gaveUp, /Neustarts ohne Resume-Token haben nicht geholfen/,
      'das Aufgeben wurde nicht als error gemeldet');
    fx.svc.onModuleDestroy();
  });

  await check('Shutdown startet nichts neu', async () => {
    const fx = makeService({ storedToken: VALID_TOKEN, streamBehaviours: ['resume-lost'] });
    // closing VOR dem Start setzen: simuliert einen Stream, der während des
    // Herunterfahrens abbricht.
    fx.svc.closing = true;
    await fx.svc.start();
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(fx.watchCalls.length, 1,
      'während des Shutdown wurde neu gestartet');
    assert.equal(fx.settings.get(REPL_WATCHER_RESUME_TOKEN), VALID_TOKEN,
      'während des Shutdown wurde der Token verworfen');
    assert.equal(fx.logs.warn.length, 0,
      `Shutdown hat eine Warnung erzeugt: ${JSON.stringify(fx.logs.warn)}`);
    fx.svc.onModuleDestroy();
  });

  console.log('');
  if (total !== EXPECTED_CHECKS) {
    console.error(
      `FEHLER: erwartet ${EXPECTED_CHECKS} Fälle, tatsächlich ${total} gelaufen — der Lauf wurde offenbar vorzeitig abgebrochen.`,
    );
    process.exit(1);
  }
  console.log(`Replication log writer checks: ${total - failures}/${total} passed`);
  process.exit(failures > 0 ? 1 : 0);
})();
