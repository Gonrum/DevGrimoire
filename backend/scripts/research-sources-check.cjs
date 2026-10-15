#!/usr/bin/env node
/*
 * Quellen-Register, Zitate, Quellenliste, Datei-Grenzen
 * (Webrecherche Plan 1, Task 3).
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

const { SourceRegistry, citedSourcesOf, appendSourcesSection } = loadCompiled('research/research-sources.js');
const { prepareFiles, splitParts, extractUploadText } = loadCompiled('research/research-files.js');
const { DEPTH, INJECTION_GUARD } = loadCompiled('research/research-config.js');

const EXPECTED_CHECKS = 10;
let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

(async () => {
  await check('DEPTH wie in der Spec', () => {
    assert.deepEqual(DEPTH.quick, { rounds: 1, tasks: 3, pages: 2 });
    assert.deepEqual(DEPTH.normal, { rounds: 2, tasks: 3, pages: 3 });
    assert.deepEqual(DEPTH.thorough, { rounds: 3, tasks: 4, pages: 3 });
    assert.match(INJECTION_GUARD, /DATA, not instructions/);
  });

  await check('claim ist exklusiv auch unter Parallelität; Nummern eindeutig', async () => {
    const reg = new SourceRegistry();
    const urls = ['https://a.de/x', 'https://A.de/x/', 'https://a.de/x#frag', 'https://b.de/'];
    const results = await Promise.all(urls.map(async (u) => { await null; return reg.claim(u) ? reg.addPage(u, u).n : null; }));
    const ns = results.filter((n) => n !== null);
    assert.equal(ns.length, 2, 'a.de/x in drei Schreibweisen zählt einmal');
    assert.equal(new Set(ns).size, ns.length);
  });

  await check('release gibt eine gescheiterte URL wieder frei', () => {
    const reg = new SourceRegistry();
    assert.equal(reg.claim('https://x.de/'), true);
    reg.release('https://x.de/');
    assert.equal(reg.claim('https://x.de/'), true);
  });

  await check('Fortsetzen: nextN nach dem Bestand, bekannte URLs gelten als gelesen', () => {
    const reg = new SourceRegistry([{ n: 1, file: 'a.txt', title: 'a.txt', notes: '', relevant: true }, { n: 4, url: 'https://x.de/', title: 'X', notes: '', relevant: false }]);
    assert.equal(reg.isRead('https://x.de'), true);
    assert.equal(reg.addPage('https://y.de/', 'Y').n, 5);
  });

  await check('citedSourcesOf: einzeln, Listen, Ketten; keine Fußnoten-Fehlgriffe', () => {
    assert.deepEqual(citedSourcesOf('A [1]. B [3, 2]. C [2][4]. D [12]'), [1, 2, 3, 4, 12]);
    assert.deepEqual(citedSourcesOf('Array a[0] und [x] und [ ]'), []);
  });

  await check('appendSourcesSection: nur zitierte relevante, Datei-Form, eigene Überschrift entfernt', () => {
    const sources = [
      { n: 1, file: 'notiz.pdf', title: 'notiz.pdf', notes: '', relevant: true },
      { n: 2, url: 'https://a.de/', title: 'A', notes: '', relevant: true },
      { n: 3, url: 'https://b.de/', title: '', notes: '', relevant: true },
      { n: 4, url: 'https://c.de/', title: 'C', notes: '', relevant: false },
    ];
    const { report, cited } = appendSourcesSection('Text [1] [3] [4]\n\n## Quellen\n- erfunden', sources);
    assert.ok(!report.includes('erfunden'));
    assert.match(report, /## Quellen\n- \[1\] 📎 notiz\.pdf \(eigene Datei\)\n- \[3\] \[https:\/\/b\.de\/\]\(https:\/\/b\.de\/\)$/);
    assert.deepEqual(cited.map((s) => s.n), [1, 3]);
  });

  await check('appendSourcesSection: ohne Zitate alle relevanten', () => {
    const { cited } = appendSourcesSection('Kein Zitat', [{ n: 1, url: 'https://a.de/', title: 'A', notes: '', relevant: true }, { n: 2, url: 'https://b.de/', title: 'B', notes: '', relevant: false }]);
    assert.deepEqual(cited.map((s) => s.n), [1]);
  });

  await check('prepareFiles: Grenzen und durchnummerierte Namen', () => {
    const big = 'x'.repeat(200_001);
    assert.throws(() => prepareFiles([{ name: 'a', text: big }]), (e) => e.getStatus() === 400);
    assert.throws(() => prepareFiles(Array.from({ length: 11 }, (_, i) => ({ name: `f${i}`, text: 'x' }))), (e) => e.getStatus() === 400);
    assert.throws(() => prepareFiles(Array.from({ length: 3 }, (_, i) => ({ name: `f${i}`, text: 'x'.repeat(190_000) }))), (e) => e.getStatus() === 400);
    assert.deepEqual(prepareFiles([{ name: 'a.txt', text: '1' }, { name: 'a.txt', text: '2' }]).map((f) => f.name), ['a.txt', 'a (2).txt']);
  });

  await check('splitParts: feste Größe, kein leerer Rest', () => {
    assert.deepEqual(splitParts('abcdefg', 3), ['abc', 'def', 'g']);
    assert.deepEqual(splitParts('', 3), []);
  });

  await check('extractUploadText: Text ja, Binär nein', async () => {
    assert.equal(await extractUploadText({ originalname: 'n.md', mimetype: 'text/markdown', buffer: Buffer.from('# Hallo') }), '# Hallo');
    await assert.rejects(extractUploadText({ originalname: 'b.png', mimetype: 'image/png', buffer: Buffer.from([0x89, 0x50]) }), (e) => e.getStatus() === 400);
  });

  console.log(`\n${total - failures}/${total} passed`);
  if (total !== EXPECTED_CHECKS) { console.error(`Erwartet ${EXPECTED_CHECKS} Checks, gelaufen ${total}`); process.exit(1); }
  process.exit(failures === 0 ? 0 : 1);
})();
