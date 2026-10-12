#!/usr/bin/env node
/*
 * Admin-Seed-Check (Review-Fund M-51, 2026-10-11).
 *
 * `seedAdminUser()` lief als `void this.seedAdminUser()` im Konstruktor — ohne
 * `.catch()`, ohne internes try/catch. Der Kommentar dort behauptete, eine
 * Ablehnung würde so „als unhandled rejection sichtbar"; tatsächlich beendet
 * sie den Prozess, weil Node >= 15 default `--unhandled-rejections=throw`
 * fährt und das Backend keinen `process.on('unhandledRejection')`-Handler hat.
 *
 * Real auslösbar: `username` ist unique, `findOne()` -> `create()` ist
 * read-then-write ohne atomaren Claim. Zwei gleichzeitig startende Replicas,
 * die beide keinen Admin finden, laufen beide in E11000.
 *
 * Die zentrale Eigenschaft, die dieser Check belegt: seedAdminUser() lehnt in
 * KEINEM der Fehlerfälle ab.
 *
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

const { AuthService } = loadCompiled('auth/auth.service.js');

const EXPECTED_CHECKS = 8;

let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

/** Ein Mongoose-Duplicate-Key-Fehler, wie ihn `create()` auf einem unique-Index wirft. */
function duplicateKeyError() {
  return Object.assign(
    new Error('E11000 duplicate key error collection: devgrimoire.users index: username_1'),
    { code: 11000 },
  );
}

/**
 * Baut einen AuthService mit Stub-Modellen. `overrides` ersetzt einzelne
 * Modell-Methoden; `logs` sammelt die Logger-Ausgaben, weil seedAdminUser()
 * E11000 bewusst als log und alles andere als error meldet.
 */
function makeService(overrides = {}) {
  const created = [];
  const userModel = {
    findOne: () => ({ exec: async () => null }),
    find: () => ({ exec: async () => [] }),
    async create(doc) { created.push(doc); return doc; },
    ...overrides,
  };
  const refreshTokenModel = {
    deleteMany: () => ({ exec: async () => ({ deletedCount: 0 }) }),
  };

  // Der Konstruktor startet seedAdminUser() fire-and-forget. Ist die Env
  // gesetzt — und in einer realen Dev-Shell mit geladener .env ist sie das —
  // läuft dieser Seed asynchron weiter: über `await findOne()` und das langsame
  // `bcrypt.hash()` hinweg, und meldet sich erst NACHDEM dieser Test
  // `svc.logger` durch den Spion ersetzt hat. Er würde also create()s und
  // Log-Zeilen in die Arrays des Tests schreiben und jede Zählung verfälschen
  // (beobachtet: 2 statt 1). Deshalb wird der Konstruktor-Seed hier
  // kurzgeschlossen; der Test ruft seedAdminUser() danach selbst auf.
  const ctorSavedUser = process.env.AUTH_USERNAME;
  const ctorSavedPass = process.env.AUTH_PASSWORD;
  delete process.env.AUTH_USERNAME;
  delete process.env.AUTH_PASSWORD;
  let svc;
  try {
    svc = new AuthService(
      { signAsync: async () => 'stub-token' },
      refreshTokenModel,
      userModel,
      { isEnabled: () => false, encrypt: (v) => `enc:${v}` },
      { record: async () => {} },
    );
  } finally {
    if (ctorSavedUser !== undefined) process.env.AUTH_USERNAME = ctorSavedUser;
    if (ctorSavedPass !== undefined) process.env.AUTH_PASSWORD = ctorSavedPass;
  }

  const logs = { log: [], warn: [], error: [] };
  svc.logger = {
    log: (m) => logs.log.push(String(m)),
    warn: (m) => logs.warn.push(String(m)),
    error: (m) => logs.error.push(String(m)),
    debug: () => {},
    verbose: () => {},
  };
  return { svc, created, logs };
}

/** seedAdminUser() liest die Env zur Laufzeit — gesetzt und wieder geräumt. */
async function withAdminEnv(fn) {
  const savedUser = process.env.AUTH_USERNAME;
  const savedPass = process.env.AUTH_PASSWORD;
  process.env.AUTH_USERNAME = 'admin';
  process.env.AUTH_PASSWORD = 'stub-password';
  try {
    return await fn();
  } finally {
    if (savedUser === undefined) delete process.env.AUTH_USERNAME; else process.env.AUTH_USERNAME = savedUser;
    if (savedPass === undefined) delete process.env.AUTH_PASSWORD; else process.env.AUTH_PASSWORD = savedPass;
  }
}

(async () => {
  // WICHTIG: makeService() läuft VOR withAdminEnv(). Der Konstruktor ruft
  // seedAdminUser() selbst auf — wäre die Env da schon gesetzt, würde er einen
  // Admin anlegen, bevor der Test explizit aufruft, und `created` hätte zwei
  // Einträge. Ohne Env kehrt der Konstruktor-Seed mit einer Warnung zurück
  // (sichtbar als [Nest] WARN, weil svc.logger erst danach ersetzt wird).

  await check('E11000 beim Anlegen lehnt NICHT ab und meldet den Concurrent-Case', async () => {
    const { svc, logs } = makeService({
      async create() { throw duplicateKeyError(); },
    });
    await withAdminEnv(async () => {
      // Die Kernaussage: kein Reject. Ein Reject hier wäre eine unhandled
      // rejection im Konstruktor und damit ein Prozess-Exit.
      await assert.doesNotReject(
        () => svc.seedAdminUser(),
        'seedAdminUser() hat bei E11000 abgelehnt — das beendet den Bootstrap',
      );
      assert.equal(logs.error.length, 0,
        `E11000 wurde als Fehler geloggt: ${JSON.stringify(logs.error)} — das Rennen ist der Erwartungsfall`);
      assert.ok(logs.log.some((m) => /concurrently/i.test(m)),
        `der Concurrent-Case wurde nicht als solcher gemeldet: ${JSON.stringify(logs.log)}`);
    });
  });

  await check('ein generischer Mongo-Fehler lehnt NICHT ab und wird als error geloggt', async () => {
    const { svc, logs } = makeService({
      async create() { throw new Error('MongoNetworkTimeout: connection timed out'); },
    });
    await withAdminEnv(async () => {
      await assert.doesNotReject(() => svc.seedAdminUser());
      assert.equal(logs.error.length, 1, 'der Fehler wurde nicht als error geloggt');
      assert.match(logs.error[0], /MongoNetworkTimeout/, 'die Ursache fehlt in der Meldung');
    });
  });

  await check('ein Fehler im findOne() lehnt NICHT ab', async () => {
    const { svc, logs } = makeService({
      findOne: () => ({ exec: async () => { throw new Error('topology was destroyed'); } }),
    });
    await withAdminEnv(async () => {
      await assert.doesNotReject(() => svc.seedAdminUser());
      assert.equal(logs.error.length, 1);
      assert.match(logs.error[0], /topology was destroyed/);
    });
  });

  await check('ohne AUTH_USERNAME/AUTH_PASSWORD: Warnung, kein Anlegen, kein Reject', async () => {
    const { svc, created, logs } = makeService();
    const savedUser = process.env.AUTH_USERNAME;
    const savedPass = process.env.AUTH_PASSWORD;
    delete process.env.AUTH_USERNAME;
    delete process.env.AUTH_PASSWORD;
    try {
      await assert.doesNotReject(() => svc.seedAdminUser());
      assert.equal(created.length, 0, 'es wurde ein Nutzer ohne Credentials angelegt');
      assert.equal(logs.warn.length, 1);
      assert.match(logs.warn[0], /Authentication DISABLED/);
    } finally {
      if (savedUser !== undefined) process.env.AUTH_USERNAME = savedUser;
      if (savedPass !== undefined) process.env.AUTH_PASSWORD = savedPass;
    }
  });

  await check('existiert der Admin bereits, wird nichts angelegt', async () => {
    const { svc, created, logs } = makeService({
      findOne: () => ({ exec: async () => ({ username: 'admin', role: 'admin' }) }),
    });
    await withAdminEnv(async () => {
      await assert.doesNotReject(() => svc.seedAdminUser());
      assert.equal(created.length, 0, 'der bestehende Admin wurde überschrieben');
      assert.ok(logs.log.some((m) => /already exists/.test(m)));
    });
  });

  await check('Happy Path legt einen aktiven Admin an', async () => {
    const { svc, created } = makeService();
    await withAdminEnv(async () => {
      await assert.doesNotReject(() => svc.seedAdminUser());
      assert.equal(created.length, 1, `erwartet genau 1 create(), bekam ${created.length}`);
      assert.equal(created[0].username, 'admin');
      assert.equal(created[0].role, 'admin');
      assert.equal(created[0].active, true);
      assert.notEqual(created[0].passwordHash, 'stub-password',
        'das Passwort wurde im Klartext gespeichert');
      assert.ok(String(created[0].passwordHash).length >= 40,
        'passwordHash sieht nicht nach bcrypt aus');
    });
  });

  // ── Der eigentliche Fehlermodus: Prozess-Exit, nicht Reject ─────────────
  //
  // `assert.doesNotReject` oben belegt, dass seedAdminUser() nicht ablehnt.
  // Der gemeldete Schaden war aber ein anderer: `void this.seedAdminUser()` im
  // Konstruktor ohne .catch(), und Node >= 15 fährt default
  // `--unhandled-rejections=throw` — eine Ablehnung beendet also den PROZESS,
  // mitten im Nest-Bootstrap. Das ist nur in einem echten Kindprozess testbar.
  //
  // Bewusst KEIN process.on('unhandledRejection')-Handler im Kind: allein seine
  // Installation ersetzt das Default-Verhalten und der Prozess würde trotz
  // Ablehnung mit 0 enden — der Test wäre blind. Das Signal ist der Exit-Code
  // plus das Ausbleiben des SURVIVED-Markers.

  /**
   * Kindprozess: konstruiert AuthService, wartet, und meldet sich nur dann mit
   * `SURVIVED` + Exit 0, wenn bis dahin keine unhandled rejection den Prozess
   * beendet hat. `injectRejection` erzwingt eine Ablehnung ohne .catch() — für
   * den Gegenbeweis, dass der Harness die Bedingung überhaupt sieht.
   */
  function runChild({ createThrows = false, injectRejection = false } = {}) {
    const distService = path.resolve(__dirname, '..', 'dist', 'auth', 'auth.service.js');
    const lines = [
      `const { AuthService } = require(${JSON.stringify(distService)});`,
      'const userModel = {',
      '  findOne: () => ({ exec: async () => null }),',
      '  find: () => ({ exec: async () => [] }),',
      createThrows
        ? "  async create() { throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 }); },"
        : '  async create() { return {}; },',
      '};',
      'const refreshTokenModel = { deleteMany: () => ({ exec: async () => ({ deletedCount: 0 }) }) };',
      'new AuthService(',
      "  { signAsync: async () => 'x' },",
      '  refreshTokenModel,',
      '  userModel,',
      "  { isEnabled: () => false, encrypt: (v) => v },",
      '  { record: async () => {} },',
      ');',
    ];
    if (injectRejection) {
      // Dasselbe Muster wie vorher im Konstruktor: fire-and-forget ohne .catch().
      lines.push("void Promise.reject(new Error('absichtliche Ablehnung'));");
    }
    // Warten, bis der fire-and-forget-Seed durch ist (bcrypt 10 Rounds ~60ms).
    lines.push("setTimeout(() => { process.stdout.write('SURVIVED'); process.exit(0); }, 2000);");

    return require('node:child_process').spawnSync(process.execPath, ['-e', lines.join('\n')], {
      encoding: 'utf8',
      env: { ...process.env, AUTH_USERNAME: 'admin', AUTH_PASSWORD: 'stub-password' },
    });
  }

  await check('der Konstruktor überlebt ein werfendes create() ohne Prozess-Exit', async () => {
    const res = runChild({ createThrows: true });
    assert.equal(res.error, undefined, `Kindprozess konnte nicht starten: ${res.error}`);
    assert.equal(res.status, 0,
      `Kindprozess endete mit ${res.status} statt 0 — die Ablehnung hat den Bootstrap beendet.\n`
      + `stderr: ${String(res.stderr).slice(0, 800)}`);
    assert.match(res.stdout, /SURVIVED/,
      'der Kindprozess hat das Zeitfenster nicht überlebt');
  });

  await check('GEGENBEWEIS: dieselbe Konstruktion ohne .catch() beendet den Prozess', async () => {
    // Ohne diesen Fall wäre der Test oben wertlos — er bestünde auch, wenn der
    // Harness die Bedingung gar nicht beobachten kann. Hier läuft exakt
    // dasselbe Setup, zusätzlich mit einer fire-and-forget-Ablehnung ohne
    // .catch() (dem Muster, das vorher im Konstruktor stand). Erwartet: kein
    // SURVIVED, Exit != 0.
    const res = runChild({ createThrows: true, injectRejection: true });
    assert.notEqual(res.status, 0,
      'die unhandled rejection hat den Prozess NICHT beendet — dann ist auch der Exit-Code oben keine Aussage');
    assert.ok(!/SURVIVED/.test(res.stdout),
      'der Kindprozess hat trotz unhandled rejection überlebt — Node-Default passt nicht zur Annahme');
  });

  console.log('');
  if (total !== EXPECTED_CHECKS) {
    console.error(
      `FEHLER: erwartet ${EXPECTED_CHECKS} Fälle, tatsächlich ${total} gelaufen — der Lauf wurde offenbar vorzeitig abgebrochen.`,
    );
    process.exit(1);
  }
  console.log(`Auth seed checks: ${total - failures}/${total} passed`);
  process.exit(failures > 0 ? 1 : 0);
})();
