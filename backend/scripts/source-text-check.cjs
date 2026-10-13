#!/usr/bin/env node
/*
 * Quelltexte sind Text (Review-Fund M-39, 2026-10-13).
 *
 * ProjectsOverview.tsx enthielt ein rohes NUL-Byte als Cache-Key-Trenner.
 * Damit galt die Datei für grep/rg und Secret-Scanner als binär: jeder
 * Suchlauf meldete „Übereinstimmungen in Binärdatei" und unterdrückte alle
 * Treffer — 599 Zeilen unsichtbar für Review-Tooling. Steuerzeichen gehören
 * als Escape-Sequenz (`\u0000`) in den Quelltext, nicht roh.
 *
 * Braucht kein dist/.
 */
const path = require('node:path');
const fs = require('node:fs');

const ROOTS = ['backend/src', 'backend/scripts', 'frontend/src', 'workspace/server', 'workspace/dg-cli'];
const SKIP_DIRS = new Set(['node_modules', 'dist']);
// Alle C0-Steuerzeichen ausser Tab, LF, CR — als Codes statt als Regex, die
// no-control-regex zu Recht beanstanden würde.
const ALLOWED = new Set([0x09, 0x0a, 0x0d]);
function firstControl(text) {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x20 && !ALLOWED.has(c)) return i;
  }
  return -1;
}

const repo = path.resolve(__dirname, '..', '..');
const hits = [];
let files = 0;
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!/\.(ts|tsx|js|cjs|mjs|json|css|html|sh)$/.test(e.name) && e.name !== 'dg') continue;
    files += 1;
    const text = fs.readFileSync(p, 'latin1');
    const at = firstControl(text);
    if (at >= 0) {
      const line = text.slice(0, at).split('\n').length;
      hits.push(`${path.relative(repo, p)}:${line} (0x${text.charCodeAt(at).toString(16).padStart(2, '0')})`);
    }
  }
}
for (const r of ROOTS) {
  const abs = path.join(repo, r);
  if (fs.existsSync(abs)) walk(abs);
}

if (files < 100) {
  console.error(`✗ nur ${files} Dateien gefunden — Pfade kaputt?`);
  process.exit(1);
}
if (hits.length) {
  console.error(`✗ rohe Steuerzeichen in Quelltexten:\n  ${hits.join('\n  ')}`);
  process.exit(1);
}
console.log(`✓ ${files} Quelltexte ohne rohe Steuerzeichen`);
