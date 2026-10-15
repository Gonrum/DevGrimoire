#!/usr/bin/env node
/*
 * Regression check für KubeWritesController + write-actions.dto (K3, Task 6).
 * Pinnt: (1) die DTOs lehnen unpassende Bodies unter der echten globalen
 * ValidationPipe-Konfiguration ab, (2) der Controller reicht Cluster-Id,
 * Body, Actor und User-Id an den Service durch und wendet selbst keine
 * readOnly-/Scope-Logik an, (3) ein Service-HttpException (403) läuft
 * unverändert durch.
 *
 * Run with `npm run check:kube-writes-rest` from backend/ after `npm run build`.
 */
require('reflect-metadata');
const path = require('node:path');
const assert = require('node:assert/strict');
const { ValidationPipe, ForbiddenException } = require('@nestjs/common');

function loadCompiled(rel) {
  const abs = path.resolve(__dirname, '..', 'dist', rel);
  try { return require(abs); } catch (err) {
    console.error(`Failed to load ${abs}. Run \`npm run build\` first.`);
    console.error(err.message);
    process.exit(2);
  }
}
const D = loadCompiled('kube/dto/write-actions.dto.js');
const { RequestContext } = loadCompiled('common/request-context.js');
const { KubeWritesController } = loadCompiled('kube/kube-writes.controller.js');

const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
const status = async (metatype, value) => {
  try { await pipe.transform(value, { type: 'body', metatype }); return 200; } catch (e) { return e.getStatus(); }
};
const base = { name: 'x', namespace: 'default' };

let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`ok   ${label}`); } catch (err) {
    failures += 1; console.error(`FAIL ${label}\n     ${err.message}`);
  }
}

(async () => {
  await check('scale: gültiger Body', async () => assert.equal(await status(D.ScaleActionDto, { kind: 'Deployment', ...base, replicas: 2 }), 200));
  await check('scale: negative Replicas -> 400', async () => assert.equal(await status(D.ScaleActionDto, { kind: 'Deployment', ...base, replicas: -1 }), 400));
  await check('scale: Replicas > 1000 -> 400', async () => assert.equal(await status(D.ScaleActionDto, { kind: 'Deployment', ...base, replicas: 1001 }), 400));
  await check('scale: Kind Pod -> 400', async () => assert.equal(await status(D.ScaleActionDto, { kind: 'Pod', ...base, replicas: 1 }), 400));
  await check('scale: fehlende Replicas -> 400', async () => assert.equal(await status(D.ScaleActionDto, { kind: 'Deployment', ...base }), 400));
  await check('restart: DaemonSet ok, Pod 400', async () => {
    assert.equal(await status(D.RestartActionDto, { kind: 'DaemonSet', ...base }), 200);
    assert.equal(await status(D.RestartActionDto, { kind: 'Pod', ...base }), 400);
  });
  await check('delete: Pod ok, Deployment 400, Zusatzfeld 400', async () => {
    assert.equal(await status(D.DeleteActionDto, { kind: 'Pod', ...base }), 200);
    assert.equal(await status(D.DeleteActionDto, { kind: 'Deployment', ...base }), 400);
    assert.equal(await status(D.DeleteActionDto, { kind: 'Pod', ...base, extra: 1 }), 400);
  });
  await check('cordon: unschedulable muss boolean sein', async () => {
    assert.equal(await status(D.CordonActionDto, { node: 'n', unschedulable: true }), 200);
    assert.equal(await status(D.CordonActionDto, { node: 'n', unschedulable: 'yes' }), 400);
    assert.equal(await status(D.CordonActionDto, { node: 'n' }), 400);
  });
  await check('apply: yaml/namespace Pflicht, yaml begrenzt', async () => {
    assert.equal(await status(D.ApplyActionDto, { yaml: 'a: b', namespace: 'd' }), 200);
    assert.equal(await status(D.ApplyActionDto, { yaml: '', namespace: 'd' }), 400);
    assert.equal(await status(D.ApplyActionDto, { yaml: 'x'.repeat(256 * 1024 + 1), namespace: 'd' }), 400);
    assert.equal(await status(D.ApplyActionDto, { yaml: 'a: b' }), 400);
  });

  await check('Controller reicht Id, Body und User-Id an den Service durch', async () => {
    const calls = {};
    const svc = {};
    for (const m of ['scale', 'restart', 'remove', 'cordon', 'apply']) svc[m] = async (a) => { calls[m] = a; return { ok: m }; };
    const c = new KubeWritesController(svc);
    const req = { user: { userId: 'u1' } };
    assert.deepEqual(await c.scale('cid', { kind: 'Deployment', ...base, replicas: 3 }, req), { ok: 'scale' });
    await c.restart('cid', { kind: 'Deployment', ...base }, req);
    await c.remove('cid', { kind: 'Pod', ...base }, req);
    await c.cordon('cid', { node: 'n', unschedulable: true }, req);
    await c.apply('cid', { yaml: 'a: b', namespace: 'd' }, {});
    assert.equal(calls.scale.clusterId, 'cid');
    assert.equal(calls.scale.replicas, 3);
    assert.equal(calls.scale.userId, 'u1');
    assert.deepEqual([calls.restart.clusterId, calls.restart.kind, calls.restart.name, calls.restart.namespace, calls.restart.userId],
      ['cid', 'Deployment', 'x', 'default', 'u1']);
    assert.equal(calls.remove.kind, 'Pod');
    assert.equal(calls.cordon.node, 'n');
    assert.equal(calls.apply.userId, 'system', 'ohne User -> system');
  });

  await check('Controller übergibt den authentifizierten Actor aus dem RequestContext', async () => {
    let got;
    const c = new KubeWritesController({ scale: async (a) => { got = a; return {}; } });
    const user = { userId: 'u9', username: 'n', role: 'admin' };
    await RequestContext.run(user, undefined, () => c.scale('cid', { kind: 'Deployment', ...base, replicas: 1 }, { user }));
    assert.equal(got.actor, user);
    assert.equal(got.userId, 'u9');
  });

  await check('Service-403 läuft unverändert durch', async () => {
    const c = new KubeWritesController({ scale: async () => { throw new ForbiddenException('ro'); } });
    await assert.rejects(c.scale('cid', { kind: 'Deployment', ...base, replicas: 1 }, {}), (e) => e.getStatus() === 403);
  });

  console.log(`\n${total - failures}/${total} Prüfungen bestanden`);
  process.exit(failures ? 1 : 0);
})();
