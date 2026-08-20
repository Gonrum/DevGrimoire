#!/usr/bin/env node
/*
 * Check für KubeLogsService (K2, Task 4).
 * Log-Streams sind der einzige langlebige Cluster-Zugriff in K2 — ein
 * vergessenes release() hält hier nicht Millisekunden, sondern Stunden.
 * Geprüft wird deshalb vor allem der Lebenszyklus.
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

const { KubeLogsService } = loadCompiled('kube/kube-logs.service.js');

let failures = 0, total = 0;
function check(label, fn) {
  total += 1;
  return Promise.resolve().then(fn).then(
    () => console.log(`✓ ${label}`),
    (err) => { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); },
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

  // Über die sieben Basisfälle hinaus: zwei Lebenszyklus-Pfade, die die
  // Basisfälle nicht ausdrücken (siehe JSDoc an makeEnv).

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

  console.log('');
  console.log(`Kube logs checks: ${total - failures}/${total} passed`);
  if (failures > 0) process.exit(1);
})();
