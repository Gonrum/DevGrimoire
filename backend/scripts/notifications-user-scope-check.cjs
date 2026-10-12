#!/usr/bin/env node
/*
 * Notifications-/Push-Nutzerbezug (Review-Fund H-12, 2026-10-12).
 *
 * Notifications und Push-Abos hatten keinen Nutzerbezug:
 * `DELETE /api/notifications/all` löschte `deleteMany({})` — jede Notification
 * jedes Nutzers —, `PUT /read-all` setzte den einen globalen Lesestatus, und
 * jeder Push ging an jedes Abo der Instanz. `DELETE /push/subscribe` nahm
 * `endpoint` ungeprüft (Mongo-Operator möglich).
 *
 * Belegt gegen den echten NotificationsService/PushService mit einem kleinen
 * In-Memory-Modell, das genau die benutzten Operatoren auswertet
 * ($and, $or, $ne, $in, null-Match, Array-Felder, $addToSet).
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

const { NotificationsService } = loadCompiled('notifications/notifications.service.js');
const { PushService } = loadCompiled('push/push.service.js');
const { PushController } = loadCompiled('push/push.controller.js');
const { RequestContext } = loadCompiled('common/request-context.js');
const { Types } = require(path.resolve(__dirname, '..', 'node_modules', 'mongoose'));

const EXPECTED_CHECKS = 8;
let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

// ---- Minimaler Mongo-Matcher -------------------------------------------------
function valueMatches(docVal, cond) {
  if (cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Types.ObjectId)) {
    if ('$ne' in cond) return !valueMatches(docVal, cond.$ne);
    if ('$in' in cond) return cond.$in.some((v) => valueMatches(docVal, v));
    throw new Error(`unsupported operator ${JSON.stringify(cond)}`);
  }
  if (cond === null) return docVal === null || docVal === undefined;
  if (Array.isArray(docVal)) return docVal.map(String).includes(String(cond));
  return String(docVal) === String(cond);
}
function matches(doc, f) {
  return Object.entries(f).every(([k, v]) => {
    if (k === '$and') return v.every((sub) => matches(doc, sub));
    if (k === '$or') return v.some((sub) => matches(doc, sub));
    return valueMatches(doc[k], v);
  });
}
function applyUpdate(doc, upd) {
  if (upd.$addToSet) {
    for (const [k, v] of Object.entries(upd.$addToSet)) {
      doc[k] = doc[k] ?? [];
      if (!doc[k].includes(v)) doc[k].push(v);
    }
  }
  if (upd.$set) Object.assign(doc, upd.$set);
}
function makeModel(docs) {
  const q = (val) => ({ sort: () => q(val), limit: () => q(val), lean: () => q(val), exec: async () => val });
  return {
    docs,
    create: async (d) => { const doc = { _id: new Types.ObjectId(), readBy: [], dismissedBy: [], read: false, ...d }; docs.push(doc); return doc; },
    find: (f) => q(docs.filter((d) => matches(d, f))),
    findOne: (f) => q(docs.find((d) => matches(d, f)) ?? null),
    countDocuments: (f) => q(docs.filter((d) => matches(d, f)).length),
    updateOne: (f, u, opts) => q((() => {
      let d = docs.find((x) => matches(x, f));
      if (!d && opts && opts.upsert) { d = {}; docs.push(d); }
      if (d) applyUpdate(d, u);
      return {};
    })()),
    updateMany: (f, u) => q((() => { const hit = docs.filter((x) => matches(x, f)); hit.forEach((d) => applyUpdate(d, u)); return { modifiedCount: hit.length }; })()),
    deleteOne: (f) => q((() => { const i = docs.findIndex((x) => matches(x, f)); if (i >= 0) docs.splice(i, 1); return { deletedCount: i >= 0 ? 1 : 0 }; })()),
    deleteMany: (f) => q((() => { const keep = docs.filter((x) => !matches(x, f)); const n = docs.length - keep.length; docs.splice(0, docs.length, ...keep); return { deletedCount: n }; })()),
  };
}

const OWN = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const FOREIGN = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const alice = { userId: 'alice', username: 'alice', role: 'user', projectScopeMode: 'allowlist', allowedProjectIds: [OWN] };
const bob = { userId: 'bob', username: 'bob', role: 'user' };
const as = (actor, fn) => RequestContext.run(actor, undefined, fn);

function makeService() {
  const model = makeModel([]);
  const settings = { get: async () => null, getOrDefault: async (_k, d) => d };
  const pushed = [];
  const push = { sendNotification: async (...args) => { pushed.push(args); return { sent: 0, failed: 0 }; } };
  const svc = new NotificationsService(model, { emit() {} }, push, settings);
  return { svc, model, pushed };
}

async function seed(svc) {
  await svc.create('broadcast', 'b');
  await svc.create('für bob', 'b', undefined, undefined, { userId: 'bob' });
  await svc.create('für alice', 'b', undefined, undefined, { userId: 'alice' });
  await svc.create('fremdes Projekt', 'b', undefined, undefined, { projectId: FOREIGN });
  await svc.create('eigenes Projekt', 'b', undefined, undefined, { projectId: OWN });
}

(async () => {
  await check('findAll: eigene + Broadcasts, nichts für andere, nichts aus fremden Projekten', async () => {
    const { svc } = makeService();
    await seed(svc);
    const titles = (await as(alice, () => svc.findAll(50))).map((n) => n.title).sort();
    assert.deepEqual(titles, ['broadcast', 'eigenes Projekt', 'für alice']);
    const forBob = (await as(bob, () => svc.findAll(50))).map((n) => n.title).sort();
    assert.deepEqual(forBob, ['broadcast', 'eigenes Projekt', 'fremdes Projekt', 'für bob']);
  });

  await check('deleteAll: löscht NUR die eigene Sicht — Bob behält alles', async () => {
    const { svc, model } = makeService();
    await seed(svc);
    await as(alice, () => svc.deleteAll());
    assert.deepEqual((await as(alice, () => svc.findAll(50))).length, 0);
    assert.equal((await as(bob, () => svc.findAll(50))).length, 4, 'Alices deleteAll hat Bobs Notifications gelöscht');
    assert.ok(!model.docs.some((d) => d.title === 'für alice'), 'eigene Notification physisch gelöscht');
    assert.ok(model.docs.some((d) => d.title === 'broadcast'), 'Broadcast bleibt physisch erhalten');
  });

  await check('read-all / unreadCount: Lesestatus pro Nutzer', async () => {
    const { svc } = makeService();
    await seed(svc);
    await as(alice, () => svc.markAllAsRead());
    assert.equal(await as(alice, () => svc.unreadCount()), 0);
    assert.equal(await as(bob, () => svc.unreadCount()), 4);
    const bobView = await as(bob, () => svc.findAll(50));
    assert.ok(bobView.every((n) => n.read === false));
    assert.ok(bobView.every((n) => !('readBy' in n) && !('dismissedBy' in n)), 'Listen anderer Nutzer nicht ausliefern');
  });

  await check('markAsRead/delete auf fremde Notification: 404, keine Änderung', async () => {
    const { svc, model } = makeService();
    await seed(svc);
    const bobs = model.docs.find((d) => d.title === 'für bob');
    await assert.rejects(() => as(alice, () => svc.markAsRead(String(bobs._id))), /not found/);
    await assert.rejects(() => as(alice, () => svc.delete(String(bobs._id))), /not found/);
    await assert.rejects(() => as(alice, () => svc.delete('kein-objectid')), /not found/);
    assert.deepEqual(bobs.readBy, []);
    assert.ok(model.docs.includes(bobs));
  });

  await check('Push: Ziel-Nutzer und Projekt werden an den PushService durchgereicht', async () => {
    const { svc, pushed } = makeService();
    await svc.create('t', 'b', '/x', undefined, { userId: 'alice', projectId: OWN });
    assert.deepEqual(pushed[0][3], { userId: 'alice', projectId: OWN });
  });

  // ---- PushService -----------------------------------------------------------
  process.env.VAPID_PUBLIC_KEY = '';
  function makePush(subs, users) {
    const svc = new PushService(makeModel(subs), makeModel(users));
    return svc;
  }
  const users = [
    { _id: new Types.ObjectId(), username: 'a', role: 'user', active: true, projectScopeMode: 'allowlist', allowedProjectIds: [new Types.ObjectId(OWN)] },
    { _id: new Types.ObjectId(), username: 'b', role: 'user', active: true, projectScopeMode: 'allowlist', allowedProjectIds: [new Types.ObjectId(FOREIGN)] },
  ];
  const subs = [
    { endpoint: 'https://p/a', keys: {}, userId: users[0]._id.toString() },
    { endpoint: 'https://p/b', keys: {}, userId: users[1]._id.toString() },
    { endpoint: 'https://p/legacy', keys: {}, userId: null },
  ];

  await check('Push-Empfänger: gerichtet, projektbezogen, Broadcast, Altbestand', async () => {
    const push = makePush([...subs], users);
    const ep = async (t) => (await push.recipients(t)).map((s) => s.endpoint).sort();
    assert.deepEqual(await ep({ userId: users[0]._id.toString() }), ['https://p/a']);
    assert.deepEqual(await ep({ projectId: OWN }), ['https://p/a']);
    assert.deepEqual(await ep({}), ['https://p/a', 'https://p/b', 'https://p/legacy']);
  });

  await check('Push-Abo: userId aus der Authentifizierung, fremdes Abo nicht abbestellbar', async () => {
    const model = makeModel([{ endpoint: 'https://p/b', keys: {}, userId: 'bob' }]);
    const push = new PushService(model, makeModel([]));
    const ctrl = new PushController(push);
    await ctrl.subscribe({ endpoint: 'https://p/a', keys: { p256dh: 'x', auth: 'y' }, userId: 'bob' }, { user: alice });
    assert.equal(model.docs.find((d) => d.endpoint === 'https://p/a').userId, 'alice');
    await ctrl.unsubscribe({ endpoint: 'https://p/b' }, { user: alice });
    assert.ok(model.docs.some((d) => d.endpoint === 'https://p/b'), 'Alice hat Bobs Abo gelöscht');
  });

  await check('Push-Abo: Operator statt String im endpoint -> 400', async () => {
    const ctrl = new PushController(new PushService(makeModel([]), makeModel([])));
    await assert.rejects(() => ctrl.unsubscribe({ endpoint: { $ne: null } }, { user: alice }), (e) => e.getStatus() === 400);
    await assert.rejects(() => ctrl.subscribe({ endpoint: 'https://p', keys: { p256dh: {} } }, { user: alice }), (e) => e.getStatus() === 400);
  });

  console.log(`\n${total - failures}/${total} passed`);
  if (total !== EXPECTED_CHECKS) {
    console.error(`Erwartet ${EXPECTED_CHECKS} Checks, gelaufen ${total}`);
    process.exit(1);
  }
  process.exit(failures === 0 ? 0 : 1);
})();
