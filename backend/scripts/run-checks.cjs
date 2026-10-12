#!/usr/bin/env node
/*
 * Führt alle `check:*`-Skripte aus (M-30) — lokal und in CI dieselbe Liste.
 *
 * Ausgenommen sind nur die Checks, die absichtlich eine Live-Umgebung
 * verlangen und ohne sie mit Exit != 0 abbrechen (Review §2). Jeder neue
 * `check:*`-Eintrag in package.json läuft damit automatisch mit; vergessen
 * kann man nur das Ausnehmen, nicht das Aufnehmen.
 *
 * Erwartet ein frisch gebautes dist/ (`npm run build`).
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const LIVE_ONLY = new Set([
  'check:rag-schema',            // verlangt DG_RAG_SCHEMA_CHECK_CONFIRM=1 + LanceDB
  'check:workflow-engine',       // verlangt DEVGRIMOIRE_PROJECT_ID + laufendes Backend
  'check:workflow-nodes-engine', // dito
]);

const pkg = require(path.resolve(__dirname, '..', 'package.json'));
const names = Object.keys(pkg.scripts).filter((k) => k.startsWith('check:') && !LIVE_ONLY.has(k));

const failed = [];
const started = Date.now();
for (const name of names) {
  const t0 = Date.now();
  const res = spawnSync('npm', ['run', '-s', name], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    timeout: 180_000,
  });
  const ok = res.status === 0;
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`${ok ? '✓' : '✗'} ${name} (${secs}s)`);
  if (!ok) {
    failed.push(name);
    const out = `${res.stdout || ''}${res.stderr || ''}`.trim().split('\n').slice(-25).join('\n    ');
    console.log(`    ${out}`);
  }
}

const total = ((Date.now() - started) / 1000).toFixed(0);
console.log(`\n${names.length - failed.length}/${names.length} grün in ${total}s` +
  ` (ausgenommen, weil live: ${[...LIVE_ONLY].join(', ')})`);
if (failed.length) {
  console.error(`Rot: ${failed.join(', ')}`);
  process.exit(1);
}
