#!/usr/bin/env node
/*
 * Regression check for the pure stack markdown/slug helpers.
 * Loads compiled output from dist/. Run via `npm run check:stack-markdown` after a build.
 */
const assert = require('node:assert');
const { slugifyFilename, stackToMarkdown, entryToMarkdown } = require('../dist/stacks/stack-markdown');

// slugifyFilename
assert.strictEqual(slugifyFilename('Kundenprojekt XY — Stack'), 'kundenprojekt-xy-stack');
assert.strictEqual(slugifyFilename('LanceDB Features!'), 'lancedb-features');
assert.strictEqual(slugifyFilename('Größe & Maß'), 'groesse-mass');
assert.strictEqual(slugifyFilename('  a__b  '), 'a-b');
assert.strictEqual(slugifyFilename('   '), 'stack');
assert.strictEqual(slugifyFilename('!!!', 'bereich'), 'bereich');

// stackToMarkdown — entries are sorted by order defensively
const md = stackToMarkdown({
  name: 'Demo Stack',
  description: 'Eine Beschreibung.',
  entries: [
    { title: 'Backend', content: 'NestJS', order: 1 },
    { title: 'Frontend', content: 'React 19', order: 0 },
  ],
});
assert.strictEqual(
  md,
  '# Demo Stack\n\nEine Beschreibung.\n\n## Frontend\nReact 19\n\n## Backend\nNestJS\n',
);

// stackToMarkdown — no description
const md2 = stackToMarkdown({ name: 'Bare', entries: [{ title: 'A', content: '', order: 0 }] });
assert.strictEqual(md2, '# Bare\n\n## A\n\n');

// entryToMarkdown
assert.strictEqual(entryToMarkdown({ title: 'Frontend', content: 'React 19' }), '# Frontend\nReact 19\n');

console.log('stack-markdown-check OK');
