#!/usr/bin/env node
/**
 * Vorschau-Leser für Chat-Tool-Aufrufe (T-415, M-49).
 *
 * Der erste Unit-Check im Frontend. Anlass: `src/lib/toolPreview.ts`
 * verarbeitet **ungeprüfte Modell-Ausgabe** — die Tool-Argumente kommen aus
 * einem `JSON.parse` über einen vom LLM erzeugten String. Wirft dort etwas,
 * blockiert ein kaputter Vorschlag den ganzen Chat, statt nur ablehnbar zu
 * sein. Genau das prüft dieser Check.
 *
 * Warum ein eigener Compile-Schritt: das Frontend baut mit Vite zu einem
 * Bundle, aus dem sich einzelne Module nicht laden lassen. Der Check
 * übersetzt deshalb die beiden importfreien Lib-Dateien nach CommonJS in ein
 * Temp-Verzeichnis und lädt sie von dort. Das geht nur, weil `toolPreview.ts`
 * und `narrow.ts` bewusst ohne React-Abhängigkeiten geschrieben sind.
 */
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-toolpreview-'));

try {
  execFileSync(
    'npx',
    ['tsc', 'src/lib/toolPreview.ts', 'src/lib/narrow.ts',
     '--outDir', outDir, '--module', 'commonjs', '--target', 'ES2020', '--skipLibCheck'],
    { cwd: root, stdio: 'pipe' },
  );
} catch (err) {
  console.error('tsc-Übersetzung fehlgeschlagen:');
  console.error(err.stdout ? err.stdout.toString() : err.message);
  process.exit(1);
}

const { previewTodos, previewCriteria, previewStringList, previewText } = require(
  path.join(outDir, 'toolPreview.js'),
);

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(`  ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  }
}

check('Nicht-Array als todos ergibt eine leere Liste statt eines Fehlers', () => {
  for (const v of [null, undefined, 42, 'text', {}, true]) {
    assert.deepStrictEqual(previewTodos(v), []);
  }
});

check('Skalare in der todos-Liste werden ausgelassen', () => {
  assert.deepStrictEqual(previewTodos([1, 'x', null, []]), []);
});

check('Todo ohne Titel wird angezeigt, nicht verschluckt', () => {
  // Sonst sieht der Nutzer weniger Todos, als tatsaechlich angelegt wuerden.
  const r = previewTodos([{ description: 'nur Text' }]);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].title, '');
});

check('falsche Feldtypen werden ignoriert statt uebernommen', () => {
  const r = previewTodos([{ title: 42, priority: {}, tags: 'nope', description: [] }]);
  assert.deepStrictEqual(
    { t: r[0].title, p: r[0].priority, g: r[0].tags, d: r[0].description },
    { t: '', p: undefined, g: [], d: undefined },
  );
});

check('tags: nur nicht-leere Strings', () => {
  assert.deepStrictEqual(previewStringList(['a', 1, null, '  ', 'b']), ['a', 'b']);
});

check('Akzeptanzkriterien: Objektform UND reine Stringliste', () => {
  // Das Schema sagt [{text}], Modelle liefern regelmaessig Strings.
  assert.deepStrictEqual(previewCriteria([{ text: 'a', done: false }, 'b', { done: true }, 42]), ['a', 'b']);
});

check('leere und Whitespace-Strings gelten als nicht gesetzt', () => {
  assert.strictEqual(previewText('   '), undefined);
  assert.strictEqual(previewText(''), undefined);
  assert.strictEqual(previewText('x'), 'x');
});

check('tief verschachtelter Unsinn wirft nicht', () => {
  const evil = [{ title: { a: [1, { b: null }] }, acceptanceCriteria: [[[]]], tags: [{}] }];
  const r = previewTodos(evil);
  assert.strictEqual(r.length, 1);
  assert.deepStrictEqual(r[0].acceptanceCriteria, []);
  assert.deepStrictEqual(r[0].tags, []);
});

check('vollstaendiger Vorschlag kommt unveraendert durch', () => {
  const r = previewTodos([{
    title: 'T', priority: 'high', tags: ['a'], description: 'd',
    userStories: 'u', acceptanceCriteria: [{ text: 'c' }], outOfScope: 'o', edgeCases: 'e',
  }]);
  assert.deepStrictEqual(r[0], {
    title: 'T', priority: 'high', tags: ['a'], description: 'd',
    userStories: 'u', acceptanceCriteria: ['c'], outOfScope: 'o', edgeCases: 'e',
  });
});

fs.rmSync(outDir, { recursive: true, force: true });
console.log(`\n${passed} Prüfungen bestanden.`);
