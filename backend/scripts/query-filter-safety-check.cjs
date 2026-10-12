#!/usr/bin/env node
/*
 * Filter-Sicherheit (Review §8 Punkt 24: M-1, M-2, M-3).
 *
 * M-1  Audit-Log: `{ ...objectId, $exists: true }` spreadete die ObjectId zu
 *      `{}` — `?actorUserId=X&actorType=user` lieferte alle Nutzer.
 * M-2  Skalare String-Query-Parameter dürfen kein Objekt/Array sein
 *      (Operator-Injection mit dem qs-Parser). Unter Express 5 (`simple`)
 *      live geprüft nicht ausnutzbar; die Pipe sichert es unabhängig ab.
 * M-3  removeByProject/removeByCustomer mit undefined wäre deleteMany({}).
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

const { AuditLogService } = loadCompiled('audit-log/audit-log.service.js');
const { ScalarQueryPipe } = loadCompiled('common/scalar-query.pipe.js');
const { assertSafeCascadeId } = loadCompiled('common/cascade-guard.js');
const { TodosService } = loadCompiled('todos/todos.service.js');
const { Types } = require(path.resolve(__dirname, '..', 'node_modules', 'mongoose'));

const EXPECTED_CHECKS = 5;
let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

(async () => {
  await check('M-1: actorUserId + actorType=user behält die Id-Bedingung', () => {
    const svc = Object.create(AuditLogService.prototype);
    const id = new Types.ObjectId().toString();
    const q = svc.buildQuery({ actorUserId: id, actorType: 'user' });
    assert.ok(q.actorUserId instanceof Types.ObjectId, `Filter war ${JSON.stringify(q.actorUserId)}`);
    assert.equal(q.actorUserId.toString(), id);
    assert.deepEqual(svc.buildQuery({ actorType: 'user' }).actorUserId, { $exists: true });
  });

  await check('M-2: Objekt oder Array in einem String-Query-Parameter -> 400', () => {
    const pipe = new ScalarQueryPipe();
    const meta = { type: 'query', data: 'entityType', metatype: String };
    assert.throws(() => pipe.transform({ $ne: 'x' }, meta), (e) => e.getStatus() === 400);
    assert.throws(() => pipe.transform(['a', 'b'], meta), (e) => e.getStatus() === 400);
    assert.equal(pipe.transform('todo', meta), 'todo');
    assert.equal(pipe.transform(undefined, meta), undefined);
    // DTO-Objekte und Nicht-Query-Parameter bleiben unberührt.
    const dto = { a: 1 };
    assert.equal(pipe.transform(dto, { type: 'query', data: undefined, metatype: Object }), dto);
    assert.equal(pipe.transform(dto, { type: 'body', data: 'x', metatype: String }), dto);
  });

  await check('M-3: Kaskaden-Guard lehnt undefined, leer und Nicht-Ids ab', () => {
    for (const bad of [undefined, null, '', 'abc', '{}', 123, { $ne: null }]) {
      assert.throws(() => assertSafeCascadeId(bad, 'projectId'), /verweigert/);
    }
    assertSafeCascadeId(new Types.ObjectId().toString(), 'projectId');
  });

  await check('M-3: removeByProject(undefined) löscht NICHTS', async () => {
    let deletes = 0;
    const svc = Object.create(TodosService.prototype);
    svc.todoModel = { deleteMany: () => { deletes += 1; return { exec: async () => ({}) }; } };
    await assert.rejects(() => svc.removeByProject(undefined), /verweigert/);
    assert.equal(deletes, 0);
  });

  await check('M-3: jede removeByProject/removeByCustomer-Methode trägt den Guard', () => {
    const missing = [];
    (function walk(dir) {
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        if (fs.statSync(p).isDirectory()) { walk(p); continue; }
        if (!name.endsWith('.ts')) continue;
        const src = fs.readFileSync(p, 'utf8');
        const re = /async (removeByProject|removeByCustomer)\((\w+)[^)]*\)[^{]*\{\s*\n\s*([^\n]*)/g;
        for (const m of src.matchAll(re)) {
          if (!m[3].startsWith('assertSafeCascadeId(')) missing.push(`${path.relative(process.cwd(), p)}: ${m[1]}`);
        }
      }
    })(path.resolve(__dirname, '..', 'src'));
    assert.deepEqual(missing, [], 'neue Kaskaden-Methode ohne Guard');
  });

  console.log(`\n${total - failures}/${total} passed`);
  if (total !== EXPECTED_CHECKS) {
    console.error(`Erwartet ${EXPECTED_CHECKS} Checks, gelaufen ${total}`);
    process.exit(1);
  }
  process.exit(failures === 0 ? 0 : 1);
})();
