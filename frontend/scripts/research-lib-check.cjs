#!/usr/bin/env node
/**
 * Reine Logik der Recherche-Oberfläche (Webrecherche P2, Task 3).
 * Übersetzt die importfreie `src/lib/research.ts` nach CommonJS (Muster:
 * tool-preview-check.cjs) und prüft erlaubte Aktionen, Zitat-Verlinkung,
 * Live-Reducer, Datei-Vorprüfung und das Parsen der Ziel-Vormerkung.
 */
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-research-lib-'));
try {
  execFileSync('npx', ['tsc', 'src/lib/research.ts', '--outDir', outDir, '--module', 'commonjs', '--target', 'ES2020', '--skipLibCheck'],
    { cwd: root, stdio: 'pipe' });
} catch (err) {
  console.error('tsc-Übersetzung fehlgeschlagen:');
  console.error(err.stdout ? err.stdout.toString() : err.message);
  process.exit(1);
}
const r = require(path.join(outDir, 'research.js'));

let failures = 0;
let total = 0;
function check(label, fn) {
  total += 1;
  try { fn(); console.log(`✓ ${label}`); } catch (err) {
    failures += 1;
    console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`);
  }
}

check('allowedActions je Status', () => {
  const a = (status, hasReport = false, partial = false) => r.allowedActions({ status, hasReport, partial }).sort();
  assert.deepEqual(a('queued'), ['cancel', 'delete', 'pause']);
  assert.deepEqual(a('running'), ['cancel', 'delete', 'pause']);
  assert.deepEqual(a('paused'), ['cancel', 'delete', 'resume']);
  assert.deepEqual(a('done', true), ['deepen', 'delete', 'move']);
  assert.deepEqual(a('done', false), ['delete', 'move']);
  assert.deepEqual(a('failed', false, false), ['delete', 'retry']);
  assert.deepEqual(a('failed', false, true), ['delete', 'resume', 'retry']);
  assert.deepEqual(a('cancelled'), ['delete', 'retry']);
});

check('isActiveStatus', () => {
  assert.equal(r.isActiveStatus('queued'), true);
  assert.equal(r.isActiveStatus('running'), true);
  assert.equal(r.isActiveStatus('paused'), false);
});

check('splitReport: abschließender ## Quellen-Abschnitt wird abgetrennt, sonst unverändert', () => {
  assert.deepEqual(r.splitReport('Text [1]\n\n## Quellen\n- [1] [A](https://a.de)'), { body: 'Text [1]', hasSourcesSection: true });
  assert.deepEqual(r.splitReport('Nur Text'), { body: 'Nur Text', hasSourcesSection: false });
  // Ein ## Quellen mitten im Text mit weiteren Abschnitten danach bleibt stehen.
  const mid = 'A\n\n## Quellen\nx\n\n## Fazit\nB';
  assert.deepEqual(r.splitReport(mid), { body: mid, hasSourcesSection: false });
});

check('citedNumbers: Einzel, Liste, Bereich, Fußnote; a[1] zählt nicht', () => {
  assert.deepEqual(r.citedNumbers('x [2] y [1, 3] z [4-5] w [^6] arr[7]'), [1, 2, 3, 4, 5, 6]);
});

check('linkCitations: bekannte Nummern werden Anker, unbekannte bleiben Text, Code bleibt unberührt', () => {
  const known = new Set([1, 2]);
  assert.equal(r.linkCitations('A [1].', known), 'A \\[[1](#src-1)\\].');
  assert.equal(r.linkCitations('B [1, 9]', known), 'B \\[[1](#src-1), 9\\]');
  assert.equal(r.linkCitations('C [9]', known), 'C [9]');
  assert.equal(r.linkCitations('```\nx [1]\n```\nD [2]', known), '```\nx [1]\n```\nD \\[[2](#src-2)\\]');
  assert.equal(r.linkCitations('E `y [1]` F', known), 'E `y [1]` F');
});

check('applyLiveEvent: snapshot, call, delta, wait, idle, end; Unbekanntes ignoriert', () => {
  let s = r.emptyLive();
  s = r.applyLiveEvent(s, { type: 'snapshot', lanes: { main: { text: 'a', reasoning: '', active: true } } });
  assert.equal(s.lanes.main.text, 'a');
  s = r.applyLiveEvent(s, { type: 'call', lane: 't1', model: 'qwen @ gpu' });
  assert.deepEqual(s.lanes.t1, { text: '', reasoning: '', model: 'qwen @ gpu', active: true });
  s = r.applyLiveEvent(s, { type: 'delta', lane: 't1', kind: 'content', text: 'Hal' });
  s = r.applyLiveEvent(s, { type: 'delta', lane: 't1', kind: 'content', text: 'lo' });
  s = r.applyLiveEvent(s, { type: 'delta', lane: 't1', kind: 'reasoning', text: 'denk' });
  assert.equal(s.lanes.t1.text, 'Hallo');
  assert.equal(s.lanes.t1.reasoning, 'denk');
  s = r.applyLiveEvent(s, { type: 'wait', lane: 't2', busy: { gpu: 2 } });
  assert.deepEqual(s.lanes.t2.busy, { gpu: 2 });
  assert.equal(s.lanes.t2.active, true);
  s = r.applyLiveEvent(s, { type: 'idle', lane: 't1' });
  assert.equal(s.lanes.t1.active, false);
  const before = s;
  s = r.applyLiveEvent(s, { type: 'quatsch' });
  s = r.applyLiveEvent(s, null);
  s = r.applyLiveEvent(s, { type: 'delta', lane: 5, kind: 'content', text: 'x' });
  assert.equal(s, before, 'unbekannte/kaputte Ereignisse ändern nichts');
  s = r.applyLiveEvent(s, { type: 'end' });
  assert.equal(s.ended, true);
  for (const lane of Object.values(s.lanes)) assert.equal(lane.active, false);
});

check('applyLiveEvent: snapshot nach end setzt ended zurück (Wiederaufnahme)', () => {
  let s = r.applyLiveEvent(r.emptyLive(), { type: 'end' });
  assert.equal(s.ended, true);
  s = r.applyLiveEvent(s, { type: 'snapshot', lanes: { main: { text: 'a', reasoning: '', active: true } } });
  assert.equal(s.ended, false);
});

check('applyLiveEvent: Puffer pro Lane auf 30.000 Zeichen begrenzt', () => {
  let s = r.applyLiveEvent(r.emptyLive(), { type: 'call', lane: 'main', model: 'm' });
  s = r.applyLiveEvent(s, { type: 'delta', lane: 'main', kind: 'content', text: 'x'.repeat(29_999) });
  s = r.applyLiveEvent(s, { type: 'delta', lane: 'main', kind: 'content', text: 'yz' });
  assert.equal(s.lanes.main.text.length, 30_000);
  assert.ok(s.lanes.main.text.endsWith('yz'));
});

check('validateResearchFiles', () => {
  assert.equal(r.validateResearchFiles([]), null);
  assert.equal(r.validateResearchFiles([{ name: 'a.md', size: 10 }, { name: 'b.PDF', size: 10 }]), null);
  assert.equal(r.validateResearchFiles([{ name: 'bild.png', size: 10 }]), 'researchRun.errors.fileType');
  assert.equal(r.validateResearchFiles([{ name: 'a.txt', size: r.RESEARCH_MAX_FILE_BYTES + 1 }]), 'researchRun.errors.fileSize');
  const many = Array.from({ length: r.RESEARCH_MAX_FILES + 1 }, (_, i) => ({ name: `${i}.txt`, size: 1 }));
  assert.equal(r.validateResearchFiles(many), 'researchRun.errors.fileCount');
});

check('parseMoveTarget', () => {
  const id = '0123456789abcdef01234567';
  assert.deepEqual(r.parseMoveTarget(`project:${id}`), { kind: 'project', id });
  assert.deepEqual(r.parseMoveTarget(`customer:${id}`), { kind: 'customer', id });
  assert.equal(r.parseMoveTarget('project:xyz'), null);
  assert.equal(r.parseMoveTarget(undefined), null);
  assert.equal(r.parseMoveTarget(''), null);
});

fs.rmSync(outDir, { recursive: true, force: true });
console.log(`\n${total - failures}/${total} passed`);
process.exit(failures ? 1 : 0);
