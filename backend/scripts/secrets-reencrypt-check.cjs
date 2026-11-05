#!/usr/bin/env node
/**
 * T-467: reine Logik der Re-Encryption (dist/common/reencrypt.js).
 *
 * Belegt:
 *   - Erkennung des Chiffrat-Formats, ohne Fehlalarm bei Hex-ähnlichen Texten
 *   - Klassifikation alt / neu / unlesbar — unlesbar wird nie umgeschrieben
 *   - verschachtelte Felder und Arrays ergeben Mongo-Punktpfade für `$set`
 *   - _id/__v und BSON-Typen werden nicht betreten
 *   - das neue Chiffrat entschlüsselt mit dem neuen Schlüssel zum alten Klartext
 *   - Idempotenz: ein umgeschlüsseltes Dokument plant nichts mehr
 *   - EncryptionService verhält sich nach der Auslagerung unverändert
 *
 * Läuft gegen `dist/`, ohne MongoDB. Nach `npm run build` ausführen.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Types } = require('mongoose');

const { planDocument, looksLikeCiphertext, classifyCiphertext, parseKey } = require('../dist/common/reencrypt');
const { encryptWithKey, decryptWithKey, EncryptionService } = require('../dist/common/encryption.service');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}: ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  }
}

const OLD = crypto.randomBytes(32);
const NEW = crypto.randomBytes(32);
const OTHER = crypto.randomBytes(32);

/** Wendet einen Plan wie `$set` auf eine Kopie an. */
function apply(doc, plan) {
  const copy = structuredClone(doc);
  for (const f of plan) {
    if (f.state !== 'old') continue;
    const keys = f.path.split('.');
    const last = keys.pop();
    const parent = keys.reduce((n, k) => n[k], copy);
    parent[last] = f.replacement;
  }
  return copy;
}

check('looksLikeCiphertext: echtes Chiffrat ja, Hex-artiger Text nein', () => {
  assert.equal(looksLikeCiphertext(encryptWithKey(OLD, 'x')), true);
  assert.equal(looksLikeCiphertext(encryptWithKey(OLD, '')), true, 'auch leerer Klartext');
  assert.equal(looksLikeCiphertext('deadbeef:cafe:00'), false);
  assert.equal(looksLikeCiphertext('a'.repeat(32) + ':' + 'b'.repeat(32) + ':abc'), false, 'ungerade Hex-Länge');
  assert.equal(looksLikeCiphertext('A'.repeat(32) + ':' + 'b'.repeat(32) + ':ab'), false, 'Grossbuchstaben erzeugt der Service nie');
  assert.equal(looksLikeCiphertext('https://example.com:8080:path'), false);
});

check('classifyCiphertext: alt / neu / unlesbar', () => {
  assert.equal(classifyCiphertext(encryptWithKey(OLD, 's'), OLD, NEW), 'old');
  assert.equal(classifyCiphertext(encryptWithKey(NEW, 's'), OLD, NEW), 'new');
  assert.equal(classifyCiphertext(encryptWithKey(OTHER, 's'), OLD, NEW), 'unreadable');
});

check('planDocument: verschachtelte Felder und Arrays, Pfade für $set', () => {
  const doc = {
    _id: new Types.ObjectId(),
    key: 'API_TOKEN',
    encryptedValue: encryptWithKey(OLD, 'geheim'),
    value: {
      endpoints: [
        { name: 'a', apiKeyEnc: encryptWithKey(OLD, 'k1') },
        { name: 'b', apiKeyEnc: encryptWithKey(NEW, 'k2') },
        { name: 'c', apiKeyEnc: encryptWithKey(OTHER, 'k3') },
      ],
    },
    createdAt: new Date(),
  };
  const plan = planDocument(doc, OLD, NEW);
  const byPath = Object.fromEntries(plan.map((f) => [f.path, f.state]));
  assert.deepEqual(byPath, {
    encryptedValue: 'old',
    'value.endpoints.0.apiKeyEnc': 'old',
    'value.endpoints.1.apiKeyEnc': 'new',
    'value.endpoints.2.apiKeyEnc': 'unreadable',
  });
  for (const f of plan) {
    if (f.state === 'old') assert.ok(f.replacement, 'alt ohne Ersatz');
    else assert.equal(f.replacement, undefined, `${f.state} darf keinen Ersatz haben`);
  }
});

check('planDocument: Ersatz entschlüsselt mit NEU zum alten Klartext, nicht mehr mit ALT', () => {
  const doc = { encryptedValue: encryptWithKey(OLD, 'ü-Umlaut & 🔑') };
  const [f] = planDocument(doc, OLD, NEW);
  assert.equal(decryptWithKey(NEW, f.replacement), 'ü-Umlaut & 🔑');
  assert.throws(() => decryptWithKey(OLD, f.replacement));
});

check('planDocument: idempotent — nach dem Anwenden nur noch neu/unlesbar', () => {
  const doc = {
    a: encryptWithKey(OLD, '1'),
    b: [encryptWithKey(OLD, '2'), 'klartext'],
    c: { d: encryptWithKey(OTHER, '3') },
  };
  const after = apply(doc, planDocument(doc, OLD, NEW));
  const second = planDocument(after, OLD, NEW);
  assert.deepEqual(second.map((f) => f.state).sort(), ['new', 'new', 'unreadable']);
  assert.equal(after.b[1], 'klartext');
  assert.equal(after.c.d, doc.c.d, 'unlesbarer Wert unverändert');
});

check('planDocument: _id/__v und BSON-Typen werden nicht betreten', () => {
  const doc = {
    _id: encryptWithKey(OLD, 'als _id — absurd, aber nie anfassen'),
    __v: 0,
    ref: new Types.ObjectId(),
    at: new Date(),
    bin: Buffer.from('x'),
  };
  assert.deepEqual(planDocument(doc, OLD, NEW), []);
});

check('parseKey: nur 64 Hex-Zeichen', () => {
  assert.equal(parseKey('ab'.repeat(32), 'K').length, 32);
  assert.throws(() => parseKey(undefined, 'K'), /64 Hex/);
  assert.throws(() => parseKey('ab'.repeat(31), 'K'), /64 Hex/);
  assert.throws(() => parseKey('zz'.repeat(32), 'K'), /64 Hex/);
});

check('EncryptionService: Rundreise und Kompatibilität mit encryptWithKey', () => {
  const prev = process.env.SECRETS_ENCRYPTION_KEY;
  process.env.SECRETS_ENCRYPTION_KEY = OLD.toString('hex');
  try {
    const svc = new EncryptionService();
    const c = svc.encrypt('wert');
    assert.equal(svc.decrypt(c), 'wert');
    assert.equal(decryptWithKey(OLD, c), 'wert');
    assert.equal(svc.decrypt(encryptWithKey(OLD, 'w2')), 'w2');
    assert.throws(() => svc.decrypt('kaputt'), /Invalid encrypted value format/);
    assert.throws(() => svc.decrypt(encryptWithKey(NEW, 'w3')));
  } finally {
    if (prev === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
    else process.env.SECRETS_ENCRYPTION_KEY = prev;
  }
});

console.log(`${passed} passed`);
