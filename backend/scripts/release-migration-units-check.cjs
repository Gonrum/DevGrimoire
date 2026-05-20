#!/usr/bin/env node
/*
 * Verifies idempotent migration logic: legacy gitlabReleaseId/gitlabTagName
 * → provider/providerReleaseId/tagName.
 *
 * Stubs the Mongoose model with an in-memory collection.
 */
const assert = require('node:assert/strict');

function makeStore() {
  const docs = new Map();
  return {
    seed(id, doc) { docs.set(id, { _id: id, ...doc }); },
    all() { return [...docs.values()]; },
    async updateMany(filter, pipeline) {
      let modifiedCount = 0;
      for (const [id, doc] of docs) {
        const matches = matchFilter(doc, filter);
        if (!matches) continue;
        const update = applyPipeline(doc, pipeline);
        docs.set(id, update);
        modifiedCount += 1;
      }
      return { modifiedCount };
    },
  };
}

function matchFilter(doc, filter) {
  for (const [key, cond] of Object.entries(filter)) {
    if (cond?.$exists === true && doc[key] === undefined) return false;
    if (cond?.$exists === false && doc[key] !== undefined) return false;
    if (cond?.$ne !== undefined && doc[key] === cond.$ne) return false;
  }
  return true;
}

function applyPipeline(doc, pipeline) {
  const [stage] = pipeline;
  const next = { ...doc };
  for (const [key, value] of Object.entries(stage.$set ?? {})) {
    if (typeof value === 'string' && value.startsWith('$')) {
      next[key] = doc[value.slice(1)];
    } else {
      next[key] = value;
    }
  }
  return next;
}

// Replicate the bootstrap logic literally (mirror of ReleasesService.onApplicationBootstrap).
async function runMigration(model) {
  return model.updateMany(
    { gitlabReleaseId: { $exists: true, $ne: null }, providerReleaseId: { $exists: false } },
    [{ $set: { provider: 'gitlab', providerReleaseId: '$gitlabReleaseId', tagName: '$gitlabTagName' } }],
  );
}

let failures = 0;
let total = 0;
function check(label, fn) {
  total += 1;
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`✓ ${label}`))
    .catch((err) => {
      failures += 1;
      console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`);
    });
}

(async () => {
  await check('migrates legacy GitLab release', async () => {
    const store = makeStore();
    store.seed('r1', { gitlabReleaseId: 'abc', gitlabTagName: 'v1' });
    const result = await runMigration(store);
    assert.equal(result.modifiedCount, 1);
    const [doc] = store.all();
    assert.equal(doc.provider, 'gitlab');
    assert.equal(doc.providerReleaseId, 'abc');
    assert.equal(doc.tagName, 'v1');
  });

  await check('idempotent: second run touches nothing', async () => {
    const store = makeStore();
    store.seed('r1', { gitlabReleaseId: 'abc', gitlabTagName: 'v1' });
    await runMigration(store);
    const second = await runMigration(store);
    assert.equal(second.modifiedCount, 0);
  });

  await check('manual release without gitlabReleaseId is ignored', async () => {
    const store = makeStore();
    store.seed('m1', { version: '1.0', releaseType: 'manual' });
    const result = await runMigration(store);
    assert.equal(result.modifiedCount, 0);
    const [doc] = store.all();
    assert.equal(doc.provider, undefined);
  });

  console.log(`\n${total - failures}/${total} checks passed.`);
  process.exit(failures === 0 ? 0 : 1);
})();
