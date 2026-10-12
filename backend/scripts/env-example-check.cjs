#!/usr/bin/env node
/*
 * .env.example vollständig? (Review-Fund M-38, 2026-10-12)
 *
 * `.env.example` ist die einzige dokumentierte Konfigurationsquelle
 * (docs/setup.md), las aber 47 der 84 im Backend verwendeten Variablen nicht.
 * Dieser Check findet jedes `process.env.X` / `process.env['X']` in src/ und
 * verlangt eine Zeile `X=` oder `# X=` in .env.example.
 */
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.resolve(__dirname, '..', 'src');
const EXAMPLE = path.resolve(__dirname, '..', '..', '.env.example');

const used = new Set();
(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) { walk(p); continue; }
    if (!name.endsWith('.ts')) continue;
    const src = fs.readFileSync(p, 'utf8');
    for (const m of src.matchAll(/process\.env(?:\.([A-Z][A-Z0-9_]*)|\[['"]([A-Z][A-Z0-9_]*)['"]\])/g)) {
      used.add(m[1] || m[2]);
    }
  }
})(SRC);

const documented = new Set();
for (const line of fs.readFileSync(EXAMPLE, 'utf8').split('\n')) {
  const m = /^#?\s?([A-Z][A-Z0-9_]*)=/.exec(line);
  if (m) documented.add(m[1]);
}

const missing = [...used].filter((v) => !documented.has(v)).sort();
console.log(`${used.size} Variablen im Backend, ${documented.size} in .env.example`);
if (missing.length) {
  console.error(`✗ nicht in .env.example dokumentiert: ${missing.join(', ')}`);
  process.exit(1);
}
console.log('✓ alle dokumentiert');
