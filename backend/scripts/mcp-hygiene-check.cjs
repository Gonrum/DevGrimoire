#!/usr/bin/env node
/*
 * MCP-Hygiene (Review-Funde M-48, M-49, 2026-10-13).
 *
 * M-48: Jeder Tool-Call legte ein Notification-Dokument an, die Collection
 *       hatte keine TTL. Jetzt nur schreibende/sensibel lesende Tools, und
 *       `mcp_*`-Meldungen laufen nach 7 Tagen ab.
 * M-49: Der Catch-All reichte rohe Fehlermeldungen durch — Mongoose-Details,
 *       Topologie, volle URLs mit Query-String.
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

const { mcpErrorMessage } = loadCompiled('mcp-errors.js');
const { isWriteTool } = loadCompiled('mcp-tools.js');
const { NotificationSchema } = loadCompiled('notifications/schemas/notification.schema.js');
const { NotificationsService, MCP_NOTIFICATION_TTL_MS } = loadCompiled('notifications/notifications.service.js');
const { NotFoundException } = require(path.resolve(__dirname, '..', 'node_modules', '@nestjs/common'));
const mongoose = require(path.resolve(__dirname, '..', 'node_modules', 'mongoose'));

const EXPECTED_CHECKS = 7;
let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

(async () => {
  await check('M-49: Mongoose-Fehler ohne Werte, Collection- oder Topologie-Details', () => {
    const cast = new mongoose.Error.CastError('ObjectId', 'geheimer-wert', '_id');
    const castMsg = mcpErrorMessage(cast);
    assert.match(castMsg, /^invalid_id: _id/);
    assert.ok(!castMsg.includes('geheimer-wert'));
    const v = new mongoose.Error.ValidationError();
    v.addError('title', new mongoose.Error.ValidatorError({ path: 'title', message: 'Wert "x" zu kurz' }));
    assert.equal(mcpErrorMessage(v), 'validation_failed: title');
    const dup = Object.assign(new Error('E11000 duplicate key error collection: devgrimoire.todos index: x dup key: { a: "b" }'), { code: 11000 });
    assert.ok(!mcpErrorMessage(dup).includes('devgrimoire.todos'));
    const topo = Object.assign(new Error('Server selection timed out after 30000 ms, topology: ReplicaSetNoPrimary mongodb:27017'), { name: 'MongoServerSelectionError' });
    assert.equal(mcpErrorMessage(topo), 'database_unavailable: Datenbank nicht erreichbar');
  });

  await check('M-49: URLs ohne Query-String und Benutzerdaten, Credentials geschwärzt', () => {
    const msg = mcpErrorMessage(new Error('request to https://user:pw@api.example.com/v1/x?access_token=abc123 failed, Bearer eyJabc.def'));
    assert.ok(!msg.includes('abc123'), msg);
    assert.ok(!msg.includes('user:pw'), msg);
    assert.ok(!msg.includes('eyJabc'), msg);
    assert.match(msg, /https:\/\/api\.example\.com\/v1\/x\?…/);
  });

  await check('M-49: bewusst formulierte Meldungen bleiben lesbar, alles ist gekappt', () => {
    assert.equal(mcpErrorMessage(new NotFoundException('Todo T-12 nicht gefunden')), 'Todo T-12 nicht gefunden');
    assert.equal(mcpErrorMessage(new Error('Missing required argument: projectId')), 'Missing required argument: projectId');
    assert.ok(mcpErrorMessage(new Error('x'.repeat(5000))).length <= 1001);
  });

  await check('M-49: der Catch-All in mcp-tools.ts benutzt mcpErrorMessage', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'mcp-tools.ts'), 'utf8');
    assert.match(src, /:\s*mcpErrorMessage\(error\);\s*\n[\s\S]{0,400}return errorResult\(`Error: \$\{message\}`\);/);
  });

  await check('M-48: Tool-Meldungen nur für schreibende Tools', () => {
    assert.equal(isWriteTool('ssh_exec_status'), false);
    assert.equal(isWriteTool('todo_list'), false);
    assert.equal(isWriteTool('todo_create'), true);
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'mcp-tools.ts'), 'utf8');
    const i = src.indexOf('notificationsService.create(\n          formatToolTitle');
    assert.ok(i > 0, 'Aufruf nicht gefunden');
    assert.match(src.slice(i - 900, i), /if \(isWriteTool\(name\) && /);
  });

  await check('M-48: Notifications haben einen TTL-Index auf expiresAt', () => {
    const ttl = NotificationSchema.indexes().find(([fields, opts]) => fields.expiresAt === 1 && opts.expireAfterSeconds === 0);
    assert.ok(ttl, 'kein TTL-Index');
  });

  await check('M-48: mcp_*-Meldungen bekommen 7 Tage, echte Alarme kein Ablaufdatum', async () => {
    const created = [];
    const svc = Object.create(NotificationsService.prototype);
    svc.notificationModel = { create: async (d) => { created.push(d); return { _id: new mongoose.Types.ObjectId(), ...d }; } };
    svc.eventEmitter = { emit() {} };
    svc.settingsService = { getOrDefault: async () => '' };
    svc.pushService = { sendNotification: async () => {} };
    await svc.create('t', 'b', undefined, 'mcp_todo');
    await svc.create('t', 'b', undefined, 'backup_failed');
    const delta = created[0].expiresAt.getTime() - Date.now();
    assert.ok(Math.abs(delta - MCP_NOTIFICATION_TTL_MS) < 5000);
    assert.equal(created[1].expiresAt, undefined);
  });

  console.log(`\n${total - failures}/${total} passed`);
  if (total !== EXPECTED_CHECKS) {
    console.error(`Erwartet ${EXPECTED_CHECKS} Checks, gelaufen ${total}`);
    process.exit(1);
  }
  process.exit(failures === 0 ? 0 : 1);
})();
