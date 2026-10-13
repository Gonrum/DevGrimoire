#!/usr/bin/env node
/*
 * Auth-Token-Hygiene (Review-Funde M-7 und M-8, 2026-10-13).
 *
 * M-8: Refresh-Rotation löschte das alte Token; ein Replay fand `null` und
 *      bekam einen generischen 401. Wer ein Token kopiert und zuerst rotiert,
 *      blieb unentdeckt. Jetzt: Familie pro Login, rotierte Tokens bleiben
 *      markiert liegen, ein Replay nach der Grace-Zeit widerruft die Familie
 *      und schreibt ein Audit-Event. Rotation ist ein atomarer Claim.
 * M-7: PATCH /api/users/:id gab llmConfig.apiKey unmaskiert zurück; ohne
 *      SECRETS_ENCRYPTION_KEY wurde der Key im Klartext gespeichert.
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

const { AuthService, hashRefreshToken } = loadCompiled('auth/auth.service.js');

const EXPECTED_CHECKS = 8;

let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

/** Versteht genau die Filterformen, die AuthService benutzt. */
function matches(doc, filter) {
  return Object.entries(filter).every(([k, cond]) => {
    const v = doc[k];
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('$exists' in cond) return cond.$exists ? v !== undefined : v === undefined;
      if ('$gt' in cond) return v > cond.$gt;
    }
    return String(v) === String(cond);
  });
}

function tokenModel() {
  const rows = [];
  let seq = 0;
  const exec = (v) => ({ exec: async () => v });
  const wrap = (r) => (r ? { ...r, deleteOne: async () => { rows.splice(rows.indexOf(r), 1); } } : null);
  return {
    rows,
    create: async (d) => { const r = { _id: `t${++seq}`, ...d }; rows.push(r); return r; },
    findOne: (f) => exec(wrap(rows.find((r) => matches(r, f)))),
    findOneAndUpdate: (f, u) => {
      const r = rows.find((x) => matches(x, f));
      if (r) Object.assign(r, u.$set);
      return exec(wrap(r));
    },
    updateOne: (f, u) => { const r = rows.find((x) => matches(x, f)); if (r) Object.assign(r, u.$set); return exec({}); },
    deleteMany: (f) => {
      const hit = rows.filter((r) => matches(r, f));
      for (const r of hit) rows.splice(rows.indexOf(r), 1);
      return exec({ deletedCount: hit.length });
    },
  };
}

function makeAuth(model = tokenModel()) {
  const audit = [];
  const auth = Object.create(AuthService.prototype);
  auth.logger = { warn() {}, log() {}, error() {} };
  auth.refreshTokenModel = model;
  auth.userModel = { findById: () => ({ exec: async () => ({ _id: 'u1', username: 'u', role: 'user', active: true }) }) };
  auth.jwtService = { sign: () => 'access' };
  auth.auditLog = { record: async (e) => { audit.push(e); } };
  return { auth, model, audit };
}

const ago = (ms) => new Date(Date.now() - ms);

(async () => {
  await check('M-8: Rotation markiert statt löscht, neues Token erbt die Familie', async () => {
    const { auth, model } = makeAuth();
    const t1 = await auth.generateRefreshToken('u1');
    const fam = model.rows[0].familyId;
    assert.match(fam, /^[0-9a-f]{32}$/);
    const { refreshToken: t2 } = await auth.refresh(t1);
    assert.equal(model.rows.length, 2);
    const old = model.rows.find((r) => r.token === hashRefreshToken(t1));
    const neu = model.rows.find((r) => r.token === hashRefreshToken(t2));
    assert.ok(old.rotatedAt instanceof Date);
    assert.equal(neu.familyId, fam);
    assert.equal(neu.rotatedAt, undefined);
  });

  await check('M-8: Replay eines rotierten Tokens widerruft die ganze Familie + Audit', async () => {
    const { auth, model, audit } = makeAuth();
    const t1 = await auth.generateRefreshToken('u1');
    const { refreshToken: t2 } = await auth.refresh(t1);
    const other = await auth.generateRefreshToken('u1'); // andere Login-Session
    model.rows.find((r) => r.token === hashRefreshToken(t1)).rotatedAt = ago(60_000);
    await assert.rejects(() => auth.refresh(t1), /Invalid or expired/);
    assert.ok(!model.rows.some((r) => r.token === hashRefreshToken(t2)), 'Zweig des Nutzers/Angreifers lebt noch');
    assert.ok(model.rows.some((r) => r.token === hashRefreshToken(other)), 'fremde Session mitgerissen');
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, 'auth.refresh_token_reuse');
    assert.equal(audit[0].meta.revokedTokens, 2);
    await assert.rejects(() => auth.refresh(t2), /Invalid or expired/);
  });

  await check('M-8: paralleler Refresh innerhalb der Grace-Zeit widerruft nichts', async () => {
    const { auth, model, audit } = makeAuth();
    const t1 = await auth.generateRefreshToken('u1');
    const { refreshToken: t2 } = await auth.refresh(t1);
    await assert.rejects(() => auth.refresh(t1), /Invalid or expired/);
    assert.equal(audit.length, 0);
    assert.ok(model.rows.some((r) => r.token === hashRefreshToken(t2)));
  });

  await check('M-8: zwei gleichzeitige Refreshes -> genau einer rotiert', async () => {
    const { auth, model } = makeAuth();
    const t1 = await auth.generateRefreshToken('u1');
    const results = await Promise.allSettled([auth.refresh(t1), auth.refresh(t1)]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(model.rows.length, 2);
  });

  await check('M-8: Altbestand ohne Familie bekommt eine, Replay danach wird erkannt', async () => {
    const { auth, model, audit } = makeAuth();
    await model.create({ token: hashRefreshToken('legacy'), userId: 'u1', expiresAt: new Date(Date.now() + 1e7) });
    const { refreshToken: t2 } = await auth.refresh('legacy');
    const legacy = model.rows.find((r) => r.token === hashRefreshToken('legacy'));
    assert.ok(legacy.familyId);
    legacy.rotatedAt = ago(60_000);
    await assert.rejects(() => auth.refresh('legacy'));
    assert.ok(!model.rows.some((r) => r.token === hashRefreshToken(t2)));
    assert.equal(audit.length, 1);
  });

  await check('M-8: abgelaufenes Token -> 401 und wird entfernt, kein Audit', async () => {
    const { auth, model, audit } = makeAuth();
    await model.create({ token: hashRefreshToken('old'), userId: 'u1', expiresAt: ago(1), familyId: 'f' });
    await assert.rejects(() => auth.refresh('old'), /Invalid or expired/);
    assert.equal(model.rows.length, 0);
    assert.equal(audit.length, 0);
  });

  await check('M-8: Logout beendet die ganze Session-Familie', async () => {
    const { auth, model } = makeAuth();
    const t1 = await auth.generateRefreshToken('u1');
    const { refreshToken: t2 } = await auth.refresh(t1);
    const other = await auth.generateRefreshToken('u1');
    await auth.logout(t2);
    assert.deepEqual(model.rows.map((r) => r.token), [hashRefreshToken(other)]);
  });

  await check('M-7: updateUser maskiert den API-Key, updateProfile speichert ohne Schlüssel keinen Klartext', async () => {
    const auth = Object.create(AuthService.prototype);
    auth.logger = { warn() {}, log() {}, error() {} };
    auth.auditLog = { record: async () => {} };
    const doc = { _id: 'u1', llmConfig: { apiKey: 'aa:bb:cc' } };
    let written;
    auth.userModel = {
      findByIdAndUpdate: (_id, update) => { written = update; return { select: () => ({ exec: async () => doc }) }; },
      findById: () => ({ select: () => ({ exec: async () => ({ llmConfig: {} }) }) }),
    };
    const res = await auth.updateUser('u1', { email: 'x@y' });
    assert.equal(res.llmConfig.apiKey, '***');
    auth.encryptionService = { isEnabled: () => false };
    written = undefined;
    await assert.rejects(() => auth.updateProfile('u1', { llmConfig: { apiKey: 'sk-plain' } }), /SECRETS_ENCRYPTION_KEY/);
    assert.equal(written, undefined, 'Klartext wurde trotzdem geschrieben');
  });

  console.log(`\n${total - failures}/${total} passed`);
  if (total !== EXPECTED_CHECKS) {
    console.error(`Erwartet ${EXPECTED_CHECKS} Checks, gelaufen ${total}`);
    process.exit(1);
  }
  process.exit(failures === 0 ? 0 : 1);
})();
