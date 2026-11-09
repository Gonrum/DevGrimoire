#!/usr/bin/env node
/**
 * T-510: Referenzfelder müssen echte ObjectId-Pfade sein.
 *
 * `@Prop({ type: Types.ObjectId })` sieht richtig aus, ist es aber nicht:
 * @nestjs/mongoose behandelt die BSON-Klasse `Types.ObjectId` als
 * verschachtelte Klasse und legt ein `Mixed`-Feld an. Mongoose castet dort
 * nie — weder beim Schreiben noch in Abfragen. Richtig ist
 * `SchemaTypes.ObjectId` (= `mongoose.Schema.Types.ObjectId`).
 *
 * Belegt:
 *   - keine Quelldatei unter src/ nutzt `type: Types.ObjectId` (auch nicht in
 *     Arrays `[{ type: Types.ObjectId }]` oder mehrzeilig)
 *   - stellvertretend: TodoSchema.path('projectId').instance === 'ObjectId'
 *   - Arrays (Todo.blockedBy) und verschachtelte Pfade sind ObjectId-Arrays
 *   - kein Schema in dist/ hat einen Mixed-Pfad, der wie eine Referenz heisst
 *     (`…Id`/`…Ids`), ausser den hier ausdrücklich erlaubten
 *   - die Abfrage castet: ein String-Filter wird zur ObjectId
 *
 * Läuft gegen `dist/` und `src/`, ohne MongoDB. Nach `npm run build` ausführen.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');
const { loadSchemas } = require('./objectid-migrate.cjs');

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

const SRC = path.join(__dirname, '..', 'src');
const DIST = path.join(__dirname, '..', 'dist');

function tsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...tsFiles(p));
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * Mixed-Pfade mit Referenz-Namen, die bewusst Mixed sind. Jeder Eintrag
 * braucht eine Begründung; ein neuer Fund ist zuerst ein Fehler.
 */
const ALLOWED_MIXED = new Map([
  // derzeit keine
]);

check('src/: kein `type: Types.ObjectId` (auch Arrays, mehrzeilig)', () => {
  const hits = [];
  for (const f of tsFiles(SRC)) {
    // Kommentare zählen nicht (Zeilen bleiben erhalten, damit die Zeilennummer stimmt).
    const text = fs.readFileSync(f, 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
      .replace(/\/\/[^\n]*/g, '');
    const re = /type:\s*\[?\s*\{?\s*type:\s*Types\.ObjectId\b|type:\s*\[?\s*Types\.ObjectId\b/g;
    let m;
    while ((m = re.exec(text))) {
      const line = text.slice(0, m.index).split('\n').length;
      hits.push(`${path.relative(SRC, f)}:${line}`);
    }
  }
  assert.deepEqual(hits, [], `Types.ObjectId als Schema-Typ (wird Mixed) — SchemaTypes.ObjectId verwenden:\n  ${hits.join('\n  ')}`);
});

const schemas = loadSchemas(DIST);
const byName = new Map(schemas.map((s) => [s.modelName, s.schema]));

check('stellvertretend: TodoSchema.path("projectId") ist ObjectId', () => {
  const todo = byName.get('Todo');
  assert.ok(todo, 'TodoSchema nicht gefunden');
  assert.equal(todo.path('projectId').instance, 'ObjectId');
  assert.equal(todo.path('milestoneId').instance, 'ObjectId');
});

check('Arrays: Todo.blockedBy ist ein ObjectId-Array', () => {
  const p = byName.get('Todo').path('blockedBy');
  assert.equal(p.instance, 'Array');
  assert.equal((p.embeddedSchemaType || p.caster).instance, 'ObjectId');
});

check('dist/: kein Mixed-Pfad mit Referenz-Namen (…Id / …Ids)', () => {
  const hits = [];
  for (const { modelName, schema } of schemas) {
    schema.eachPath((p, type) => {
      if (type.instance !== 'Mixed') return;
      const leaf = p.split('.').pop();
      if (!/(Id|Ids)$/.test(leaf)) return;
      const key = `${modelName}.${p}`;
      if (!ALLOWED_MIXED.has(key)) hits.push(key);
    });
  }
  assert.deepEqual(hits, [], `Mixed statt ObjectId:\n  ${hits.join('\n  ')}`);
});

check('Abfrage castet: String-Filter wird zur ObjectId', () => {
  const Todo = mongoose.model('TodoGuardCheck', byName.get('Todo'));
  const id = new mongoose.Types.ObjectId();
  const q = Todo.find({ projectId: id.toString(), blockedBy: { $in: [id.toString()] } });
  q.cast(Todo);
  const f = q.getFilter();
  assert.ok(f.projectId instanceof mongoose.Types.ObjectId, `projectId ist ${typeof f.projectId}`);
  assert.ok(f.blockedBy.$in[0] instanceof mongoose.Types.ObjectId);
});

console.log(`${passed} passed`);
