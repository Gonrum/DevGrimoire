#!/usr/bin/env node
/*
 * i18n-Key-Check (Review-Fund H-26, 2026-10-12).
 *
 * 13 statische `t('…')`-Keys fehlten in BEIDEN Lokales — darunter der
 * Speech-Consent-Dialog, der dem Nutzer die Zustimmung zur Audio-Übertragung
 * an einen Drittanbieter mit rohen Schlüsseln statt Text abverlangte.
 * i18next gibt bei fehlendem Key den Key selbst zurück, also fällt das weder
 * beim Bauen noch im Typecheck auf.
 *
 * Prüft jeden statischen `t('a.b')`-Aufruf in frontend/src gegen de.json und
 * en.json (Plural-Suffixe _one/_other/_zero zählen als vorhanden). Dynamische
 * Keys (`t(\`x.${y}\`)`) sind nicht statisch prüfbar und bleiben aussen vor.
 * Braucht weder dist/ noch einen Build.
 */
const fs = require('node:fs');
const path = require('node:path');

const FRONTEND = path.resolve(__dirname, '..', '..', 'frontend');

function flatten(obj, prefix = '', out = new Set()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') flatten(v, key, out);
    else out.add(key);
  }
  return out;
}

const locales = {};
for (const lang of ['de', 'en']) {
  const file = path.join(FRONTEND, 'src', 'locales', `${lang}.json`);
  locales[lang] = flatten(JSON.parse(fs.readFileSync(file, 'utf8')));
}
const has = (set, key) => set.has(key) || ['_one', '_other', '_zero'].some((s) => set.has(key + s));

const files = [];
(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (/\.(tsx?|jsx?)$/.test(name)) files.push(p);
  }
})(path.join(FRONTEND, 'src'));

const KEY_CALL = /\bt\(\s*['"]([a-zA-Z0-9_.-]+)['"]/g;
const missing = [];
let calls = 0;
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  for (const match of src.matchAll(KEY_CALL)) {
    const key = match[1];
    if (!key.includes('.')) continue;
    calls += 1;
    const langs = Object.keys(locales).filter((lang) => !has(locales[lang], key));
    if (langs.length) missing.push(`${key}  [fehlt: ${langs.join('+')}]  ${path.relative(FRONTEND, file)}`);
  }
}

console.log(`${calls} statische t()-Aufrufe in ${files.length} Dateien geprüft`);
if (missing.length) {
  console.error(`✗ ${missing.length} fehlende Keys:\n  ${[...new Set(missing)].join('\n  ')}`);
  process.exit(1);
}
console.log('✓ alle statischen Keys in de und en vorhanden');
