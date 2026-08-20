#!/usr/bin/env node
/*
 * Check für KubeLogsService (K2, Task 4).
 * Log-Streams sind der einzige langlebige Cluster-Zugriff in K2 — ein
 * vergessenes release() hält hier nicht Millisekunden, sondern Stunden.
 * Geprüft wird deshalb vor allem der Lebenszyklus.
 */
const path = require('node:path');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

function loadCompiled(rel) {
  const abs = path.resolve(__dirname, '..', 'dist', rel);
  try { return require(abs); } catch (err) {
    console.error(`Failed to load ${abs}. Run \`npm run build\` first.`);
    console.error(err.message);
    process.exit(2);
  }
}

const { KubeLogsService } = loadCompiled('kube/kube-logs.service.js');

// Erwartete Fallzahl (Review-Fund, Important 3): ohne diese Zusicherung
// meldet ein Lauf, der vorzeitig endet — z.B. weil ein Fall für immer
// hängt und der Event-Loop danach einfach leerläuft — Exit 0 und druckt
// die Zusammenfassung nie. Ein Timeout pro Fall (unten in `check()`) ist
// die primäre Abwehr; diese Zählung ist das zweite Netz.
const EXPECTED_CHECKS = 15;
const CHECK_TIMEOUT_MS = 3000;

let failures = 0, total = 0;
function check(label, fn) {
  total += 1;
  let timer;
  // Review-Fund (Important 3): ohne dieses Rennen lässt ein hängender Fall
  // den Prozess mit leerem Event-Loop und Exit 0 enden — die eine
  // Fehlerklasse, für die diese Suite existiert, würde als Erfolg gemeldet.
  const settleGuard = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(
        `Zeitlimit (${CHECK_TIMEOUT_MS}ms) überschritten — der Fall hängt vermutlich (kein settle).`,
      )),
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

const clustersStub = { async findById(id) { return { _id: id }; } };

/**
 * Fake-Log: schreibt vorbereitete Chunks in den übergebenen Stream und
 * meldet Abbrüche. `logFactory` wird dem Service injiziert, damit der Check
 * ohne Cluster auskommt.
 *
 * `opts.abortThrows` lässt den zurückgegebenen AbortController beim Abbruch
 * werfen — ein realer AbortController tut das nicht, aber die Schnittstelle
 * legt es nicht fest, und ein werfender Abbruch darf die Freigabe des
 * Transports trotzdem nicht verhindern.
 *
 * `opts.streamErrors` lässt den Stream nach den Chunks ein 'error'-Event
 * statt eines normalen `end()` feuern — das triggert sowohl den expliziten
 * 'error'-Listener als auch den `finally`-Block des Zeilen-Generators, beide
 * würden ohne Idempotenz-Schutz zweimal freigeben.
 */
function makeEnv(chunks, opts = {}) {
  const state = { released: 0, aborted: 0, written: false };
  const client = {
    async buildConfig() {
      return { kc: {}, release: () => { state.released += 1; } };
    },
  };
  const logFactory = () => ({
    async log(ns, pod, container, stream) {
      state.written = true;
      if (opts.logThrows) throw new Error('kein solcher Pod');
      setImmediate(() => {
        for (const c of chunks) stream.write(c);
        if (opts.streamErrors) {
          stream.emit('error', new Error('Verbindung verloren'));
        } else if (!opts.keepOpen) {
          stream.end();
        }
      });
      return {
        abort: () => {
          state.aborted += 1;
          if (opts.abortThrows) throw new Error('abort kaputt');
        },
      };
    },
  });
  return { state, client, logFactory };
}

/**
 * Bildet nach, wie `Log.log()` (log.js aus @kubernetes/client-node) die
 * HTTP-Antwort tatsächlich anschließt: `nodeStream.pipe(stream)`, OHNE
 * einen 'error'-Listener auf der Quelle. Genau dieses Muster führt ohne den
 * 'pipe'-Hook in KubeLogsService zu einer uncaught exception, sobald die
 * Quelle asynchron (wie bei einem echten AbortSignal über undici) mit
 * einem Fehler endet — der reale Auslöser von Critical 1 im Review.
 */
function makePipedEnv() {
  const state = { released: 0, aborted: 0 };
  const client = {
    async buildConfig() {
      return { kc: {}, release: () => { state.released += 1; } };
    },
  };
  const logFactory = () => ({
    async log(ns, pod, container, stream) {
      const src = new Readable({ read() {} });
      src.pipe(stream); // wie log.js — bewusst KEIN error-Listener auf src
      return {
        abort: () => {
          state.aborted += 1;
          // Wie ein echter Abbruch über undici/AbortSignal: die Quelle
          // endet ASYNCHRON mit einem Fehler, nicht innerhalb des
          // synchronen abort()-Aufrufs selbst — sonst würde das bereits
          // bestehende try/catch um abort() ihn zufällig abfangen.
          setImmediate(() => src.emit('error', new Error('This operation was aborted')));
        },
      };
    },
  });
  return { state, client, logFactory };
}

async function collect(iterable, max = 10) {
  const out = [];
  for await (const line of iterable) {
    out.push(line);
    if (out.length >= max) break;
  }
  return out;
}

(async () => {
  await check('Chunks werden zu Zeilen zerlegt', async () => {
    const env = makeEnv(['erste\nzwei', 'te\ndritte\n']);
    const svc = new KubeLogsService(clustersStub, env.client, env.logFactory);
    const session = await svc.open('c1', 'prod', 'api', {});
    const lines = await collect(session.lines);
    assert.deepEqual(lines, ['erste', 'zweite', 'dritte']);
  });

  await check('das Ende des Streams gibt den Transport frei', async () => {
    const env = makeEnv(['a\n']);
    const svc = new KubeLogsService(clustersStub, env.client, env.logFactory);
    const session = await svc.open('c1', 'prod', 'api', {});
    await collect(session.lines);
    await new Promise((r) => setImmediate(r));
    assert.equal(env.state.released, 1, `released=${env.state.released}, erwartet 1`);
  });

  await check('close() bricht ab und gibt frei', async () => {
    const env = makeEnv(['a\n'], { keepOpen: true });
    const svc = new KubeLogsService(clustersStub, env.client, env.logFactory);
    const session = await svc.open('c1', 'prod', 'api', { follow: true });
    session.close();
    await new Promise((r) => setImmediate(r));
    assert.equal(env.state.aborted, 1, 'AbortController wurde nicht ausgelöst');
    assert.equal(env.state.released, 1);
  });

  await check('doppeltes close() gibt nicht doppelt frei', async () => {
    const env = makeEnv([], { keepOpen: true });
    const svc = new KubeLogsService(clustersStub, env.client, env.logFactory);
    const session = await svc.open('c1', 'prod', 'api', { follow: true });
    session.close();
    session.close();
    await new Promise((r) => setImmediate(r));
    assert.equal(env.state.released, 1, `released=${env.state.released} — close() ist nicht idempotent`);
  });

  await check('wirft der Log-Aufruf, wird trotzdem freigegeben', async () => {
    const env = makeEnv([], { logThrows: true });
    const svc = new KubeLogsService(clustersStub, env.client, env.logFactory);
    const err = await svc.open('c1', 'prod', 'api', {}).then(() => null, (e) => e);
    assert.ok(err, 'hätte werfen müssen');
    assert.equal(env.state.released, 1, 'der Transport blieb nach einem Fehlschlag gehalten');
  });

  await check('eine überlange Zeile wird gekappt statt den Speicher zu füllen', async () => {
    const env = makeEnv(['x'.repeat(50_000) + '\n']);
    const svc = new KubeLogsService(clustersStub, env.client, env.logFactory);
    const session = await svc.open('c1', 'prod', 'api', {});
    const lines = await collect(session.lines);
    assert.ok(lines[0].length <= 8192, `Zeile war ${lines[0].length} Zeichen lang`);
  });

  await check('tailLines und previous werden durchgereicht', async () => {
    let seen = null;
    const client = { async buildConfig() { return { kc: {}, release: () => {} }; } };
    const logFactory = () => ({
      async log(ns, pod, container, stream, options) {
        seen = { ns, pod, container, options };
        stream.end();
        return { abort: () => {} };
      },
    });
    const svc = new KubeLogsService(clustersStub, client, logFactory);
    const session = await svc.open('c1', 'prod', 'api', { container: 'side', tailLines: 42, previous: true });
    await collect(session.lines);
    assert.equal(seen.ns, 'prod');
    assert.equal(seen.container, 'side');
    assert.equal(seen.options.tailLines, 42);
    assert.equal(seen.options.previous, true);
  });

  // Über die sieben Basisfälle hinaus: Lebenszyklus-Pfade, die die
  // Basisfälle nicht ausdrücken (siehe JSDoc an makeEnv/makePipedEnv).

  await check('ein werfender abort() verhindert die Freigabe nicht', async () => {
    const env = makeEnv(['a\n'], { keepOpen: true, abortThrows: true });
    const svc = new KubeLogsService(clustersStub, env.client, env.logFactory);
    const session = await svc.open('c1', 'prod', 'api', { follow: true });
    session.close();
    await new Promise((r) => setImmediate(r));
    assert.equal(env.state.aborted, 1, 'AbortController wurde nicht ausgelöst');
    assert.equal(env.state.released, 1, `released=${env.state.released} — ein werfender abort() darf die Freigabe nicht verhindern`);
  });

  await check('ein Stream-Fehler nach etwas Ausgabe gibt trotzdem nur einmal frei', async () => {
    const env = makeEnv(['erste\n'], { streamErrors: true });
    const svc = new KubeLogsService(clustersStub, env.client, env.logFactory);
    const session = await svc.open('c1', 'prod', 'api', {});
    let thrown = null;
    try {
      for await (const _line of session.lines) { /* konsumieren, bis der Fehler durchkommt */ }
    } catch (err) {
      thrown = err;
    }
    await new Promise((r) => setImmediate(r));
    assert.ok(thrown, 'der Stream-Fehler hätte durch die Iteration propagieren müssen');
    assert.equal(
      env.state.released, 1,
      `released=${env.state.released} — 'error'-Event und Generator-finally müssen sich auf eine Freigabe einigen`,
    );
  });

  await check('ein früher Ausstieg aus der Iteration (break) gibt trotzdem frei', async () => {
    // Ein Aufrufer, der `session.lines` per `for await` konsumiert und die
    // Schleife vorzeitig mit `break` verlässt, ruft nie `close()` auf. Die
    // for-await-of-Semantik schließt den zugrundeliegenden Async-Iterator
    // trotzdem (IteratorClose) — das muss bis zum `finally` in toLines()
    // durchreichen, sonst bleibt der Transport offen, bis der Prozess endet.
    const env = makeEnv(['eins\n', 'zwei\n', 'drei\n'], { keepOpen: true });
    const svc = new KubeLogsService(clustersStub, env.client, env.logFactory);
    const session = await svc.open('c1', 'prod', 'api', { follow: true });
    const out = [];
    for await (const line of session.lines) {
      out.push(line);
      if (out.length >= 1) break;
    }
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(out, ['eins']);
    assert.equal(
      env.state.released, 1,
      `released=${env.state.released} — ein früher break() aus der Iteration gab den Transport nicht frei`,
    );
  });

  // Fix round 1 (Reviewer-Fund): fünf weitere Fälle — zwei kritische
  // Lebenszyklus-Lücken (Prozess-Crash, hängender Iterator) und drei
  // Dekodier-/Kappungs-Pfade, die keiner der obigen Fälle erreicht.

  await check('close() auf einem laufenden follow-Stream crasht den Prozess nicht', async () => {
    // Kritisch 1: `Log.log()` verbindet per `nodeStream.pipe(stream)` ohne
    // 'error'-Listener auf der Quelle. Unser abort() lässt die Quelle
    // asynchron mit einem AbortError enden — ohne einen eigenen Listener
    // auf dieser Quelle ist das eine uncaught exception (kein
    // process.on('uncaughtException') im Backend). Ein Zähler-Stub sieht
    // das nicht — deshalb hier ein echter process.on('uncaughtException')
    // als Sensor, scharf geschaltet nur für die Dauer dieses Falls.
    const env = makePipedEnv();
    const svc = new KubeLogsService(clustersStub, env.client, env.logFactory);
    const session = await svc.open('c1', 'prod', 'api', { follow: true });

    let crashed = null;
    const onUncaught = (err) => { crashed = err; };
    process.on('uncaughtException', onUncaught);
    try {
      session.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      process.removeListener('uncaughtException', onUncaught);
    }
    assert.equal(crashed, null, `Prozess wäre gecrasht: ${crashed && crashed.message}`);
    assert.equal(env.state.aborted, 1);
    assert.equal(env.state.released, 1);
  });

  await check('close() auf einem laufenden Stream beendet lines() statt zu hängen', async () => {
    // Kritisch 2: finish() gab den Transport frei, ließ `stream` aber offen
    // — der `for await` in toLines() parkte für immer auf einem Read, der
    // nie ankam. Der Timeout in check() oben ist das Sicherheitsnetz, falls
    // das hier regressiert; die eigentliche Zusicherung ist `await
    // consumerDone` unten, das sich ohne die Freigabe nie lösen würde.
    const env = makeEnv(['eins\n'], { keepOpen: true });
    const svc = new KubeLogsService(clustersStub, env.client, env.logFactory);
    const session = await svc.open('c1', 'prod', 'api', { follow: true });
    const seen = [];
    const consumerDone = (async () => {
      for await (const line of session.lines) seen.push(line);
    })();
    await new Promise((r) => setImmediate(r));
    session.close();
    await consumerDone;
    assert.deepEqual(seen, ['eins']);
    assert.equal(env.state.released, 1);
  });

  await check('mehrbytiges UTF-8-Zeichen an einer Chunk-Grenze wird nicht korrumpiert', async () => {
    // Important 4: naive Chunk-für-Chunk-Dekodierung (String(chunk)) zerlegt
    // ein mehrbytiges Zeichen, das genau an einer Chunk-Grenze auseinander-
    // reißt, in zwei U+FFFD. Beide Writes MÜSSEN in getrennten Ticks
    // passieren — im selben Tick fasst Readable.read() sie zu einem Chunk
    // zusammen und der Fehler bleibt unsichtbar (wie in den Basisfällen).
    const full = Buffer.from('Größe: 20µm läuft\n', 'utf8');
    const splitAt = full.indexOf(Buffer.from('ö', 'utf8')) + 1; // mitten im 2-Byte-Zeichen trennen
    const part1 = full.subarray(0, splitAt);
    const part2 = full.subarray(splitAt);
    const client = { async buildConfig() { return { kc: {}, release: () => {} }; } };
    const logFactory = () => ({
      async log(ns, pod, container, stream) {
        setImmediate(() => {
          stream.write(part1);
          setImmediate(() => {
            stream.write(part2);
            stream.end();
          });
        });
        return { abort: () => {} };
      },
    });
    const svc = new KubeLogsService(clustersStub, client, logFactory);
    const session = await svc.open('c1', 'prod', 'api', {});
    const lines = await collect(session.lines);
    assert.deepEqual(lines, ['Größe: 20µm läuft']);
  });

  await check('Zeilen ohne Zeilenumbruch werden trotzdem bei LINE_MAX gekappt', async () => {
    // Important 5a: der Zwischenspeicher-Kappungspfad (buffer.length >
    // LINE_MAX ohne gefundenes '\n') wurde von keinem Fall erreicht — jeder
    // vorhandene Fall fand sein '\n', bevor der Puffer 8192 überschritt.
    // 3 × 5000 zeilenumbruchfreie Zeichen erzwingen genau diesen Pfad.
    const client = { async buildConfig() { return { kc: {}, release: () => {} }; } };
    const logFactory = () => ({
      async log(ns, pod, container, stream) {
        setImmediate(() => {
          stream.write('x'.repeat(5000));
          stream.write('x'.repeat(5000));
          stream.write('x'.repeat(5000));
          // bewusst offen: kein '\n', kein end() — die Zeile ist noch "im Gange"
        });
        return { abort: () => {} };
      },
    });
    const svc = new KubeLogsService(clustersStub, client, logFactory);
    const session = await svc.open('c1', 'prod', 'api', { follow: true });
    const lines = await collect(session.lines, 1);
    session.close();
    assert.equal(lines.length, 1);
    assert.equal(lines[0].length, 8192, `Zeile war ${lines[0].length} Zeichen lang, erwartet genau 8192`);
  });

  await check('eine letzte Zeile ohne abschließendes Zeilenumbruch wird trotzdem ausgeliefert', async () => {
    // Important 5b: der Pfad nach der Schleife (`if (buffer.length > 0)
    // yield …`) wurde von keinem Fall erreicht — jeder vorhandene Fall
    // endete mit '\n' im letzten Chunk.
    const client = { async buildConfig() { return { kc: {}, release: () => {} }; } };
    const logFactory = () => ({
      async log(ns, pod, container, stream) {
        setImmediate(() => {
          stream.write('erste\nkeinzeilenumbruchamende');
          stream.end();
        });
        return { abort: () => {} };
      },
    });
    const svc = new KubeLogsService(clustersStub, client, logFactory);
    const session = await svc.open('c1', 'prod', 'api', {});
    const lines = await collect(session.lines);
    assert.deepEqual(lines, ['erste', 'keinzeilenumbruchamende']);
  });

  console.log('');
  console.log(`Kube logs checks: ${total - failures}/${total} passed`);
  if (total !== EXPECTED_CHECKS) {
    console.error(
      `FEHLER: erwartet ${EXPECTED_CHECKS} Fälle, tatsächlich ${total} gelaufen — der Lauf wurde offenbar vorzeitig abgebrochen.`,
    );
    process.exit(1);
  }
  process.exit(failures > 0 ? 1 : 0);
})();
