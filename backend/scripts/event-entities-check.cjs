#!/usr/bin/env node
/*
 * Event-Entities (Review-Fund M-32, 2026-10-13).
 *
 * Drei Stellen müssen dieselben Entity-Werte kennen: was das Backend als
 * `project.changed` emittiert, PROJECT_EVENT_ENTITIES im Backend und die
 * Union im Frontend (wsEventBus.ts). Vorher fehlten im Frontend 15 Werte und
 * eine Refetch-Tabelle wartete auf `log`, das nie kam — beides unbemerkt,
 * weil `emit()` die Payload nicht typisiert und die Tabellen untypisiert waren.
 *
 * Lädt aus dist/; vorher `npm run build`.
 */
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');

function loadCompiled(rel) {
  const abs = path.resolve(__dirname, '..', 'dist', rel);
  try { return require(abs); } catch (err) {
    console.error(`Failed to load ${abs}. Run \`npm run build\` first.`);
    console.error(err.message);
    process.exit(2);
  }
}

const { PROJECT_EVENT_ENTITIES } = loadCompiled('events/project-event.js');

const EXPECTED_CHECKS = 3;
let failures = 0, total = 0;
function check(label, fn) {
  total += 1;
  try { fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')) out.push(p);
  }
  return out;
}

const backendList = new Set(PROJECT_EVENT_ENTITIES);

check('jedes literal emittierte Entity steht in PROJECT_EVENT_ENTITIES', () => {
  const emitted = new Map();
  for (const file of walk(path.resolve(__dirname, '..', 'src'))) {
    const src = fs.readFileSync(file, 'utf8');
    // Die Objekt-Literale direkt hinter emit(PROJECT_CHANGED, …).
    for (const m of src.matchAll(/emit\(\s*PROJECT_CHANGED\s*,\s*\{([\s\S]*?)\}\s*\)/g)) {
      for (const e of m[1].matchAll(/entity:\s*'([a-z_-]+)'/g)) {
        emitted.set(e[1], path.relative(path.resolve(__dirname, '..'), file));
      }
    }
  }
  assert.ok(emitted.size >= 20, `zu wenige Emits gefunden (${emitted.size}) — Muster kaputt?`);
  const unknown = [...emitted].filter(([e]) => !backendList.has(e)).map(([e, f]) => `${e} (${f})`);
  assert.deepEqual(unknown, []);
});

check('Frontend-Union entspricht PROJECT_EVENT_ENTITIES', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'frontend', 'src', 'api', 'wsEventBus.ts'), 'utf8');
  const block = src.match(/export const PROJECT_EVENT_ENTITIES = \[([\s\S]*?)\] as const/);
  assert.ok(block, 'PROJECT_EVENT_ENTITIES im Frontend nicht gefunden');
  const frontend = new Set([...block[1].matchAll(/'([a-z_-]+)'/g)].map((m) => m[1]));
  assert.deepEqual([...frontend].sort(), [...backendList].sort());
});

check('keine Duplikate in der Liste', () => {
  assert.equal(backendList.size, PROJECT_EVENT_ENTITIES.length);
});

console.log(`\n${total - failures}/${total} passed`);
if (total !== EXPECTED_CHECKS) {
  console.error(`Erwartet ${EXPECTED_CHECKS} Checks, gelaufen ${total}`);
  process.exit(1);
}
process.exit(failures === 0 ? 0 : 1);
