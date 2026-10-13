#!/usr/bin/env node
/*
 * Chat: Persistenz-Schwärzung und Options-Parsing (Review-Funde M-9, M-10,
 * 2026-10-13).
 *
 * M-9:  Tool-Argumente und -Ergebnisse landeten ungeschwärzt in der Session
 *       und im Chat-Activity-Log — Workflows und Recurring Tasks schwärzten.
 * M-10: getOptions() reichte NaN durch; toolsMaxIterations = NaN liess die
 *       Tool-Schleife nie laufen, der Nutzer sah eine dauerhaft leere Antwort.
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

const { redactToolRecord } = loadCompiled('chat/chat-redaction.js');
const { numericOption } = loadCompiled('chat/chat-llm.service.js');

const EXPECTED_CHECKS = 6;
let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

(async () => {
  await check('M-9: sensible Feldnamen im JSON-Ergebnis werden maskiert, der Rest bleibt', () => {
    const rec = redactToolRecord({
      id: '1', name: 'customer_get', arguments: '{"id":"c1"}', success: true,
      result: JSON.stringify({ name: 'ACME', integration: { apiKey: 'sk-live-123', url: 'https://x' } }),
    });
    assert.ok(!rec.result.includes('sk-live-123'));
    const parsed = JSON.parse(rec.result);
    assert.equal(parsed.integration.apiKey, '[MASKED]');
    assert.equal(parsed.integration.url, 'https://x');
    assert.equal(parsed.name, 'ACME');
  });

  await check('M-9: Bearer und key=value in Klartext-Ausgabe (workspace_exec) werden maskiert', () => {
    const rec = redactToolRecord({
      id: '2', name: 'workspace_exec', success: true,
      arguments: '{"command":"curl -H \\"Authorization: Bearer abc.def\\" x"}',
      result: 'DB_PASSWORD=hunter2\nok',
      error: 'failed with token=xyz',
    });
    assert.ok(!rec.arguments.includes('abc.def'));
    assert.ok(!rec.result.includes('hunter2'));
    assert.ok(!rec.error.includes('xyz'));
  });

  await check('M-9: alle Speicherstellen im Chat-Controller laufen über redactToolRecord', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'chat', 'chat.controller.ts'), 'utf8');
    const pushes = src.match(/persisted\.push\(/g) ?? [];
    const redacted = src.match(/persisted\.push\(redactToolRecord\(/g) ?? [];
    assert.ok(pushes.length >= 3);
    assert.equal(redacted.length, pushes.length, 'ein persisted.push ohne Schwärzung');
    assert.equal((src.match(/dto\.toolCalls\?\.map\(\(tc\) => redactToolRecord\(/g) ?? []).length, 2, 'Browser-Modus-Pfad ohne Schwärzung');
  });

  await check('M-10: ungültiges Setting fällt auf Env, dann auf den Default zurück', () => {
    const b = { min: 1, max: 10, integer: true };
    assert.equal(numericOption(['abc', '7'], 5, b), 7);
    assert.equal(numericOption(['abc', 'xyz'], 5, b), 5);
    assert.equal(numericOption([null, undefined], 5, b), 5);
    assert.equal(numericOption(['', '  '], 5, b), 5);
  });

  await check('M-10: ausserhalb der DTO-Grenzen oder gebrochen -> ungültig, nicht geklemmt', () => {
    const b = { min: 1, max: 10, integer: true };
    assert.equal(numericOption(['0'], 5, b), 5);
    assert.equal(numericOption(['11'], 5, b), 5);
    assert.equal(numericOption(['2.5'], 5, b), 5);
    assert.equal(numericOption(['3'], 5, b), 3);
    assert.equal(numericOption(['0.3'], 0.7, { min: 0, max: 2 }), 0.3);
  });

  await check('M-10: getOptions liefert nie NaN, auch wenn jedes Setting kaputt ist', async () => {
    const { ChatLlmService } = loadCompiled('chat/chat-llm.service.js');
    const svc = Object.create(ChatLlmService.prototype);
    svc.settings = { get: async () => 'kaputt' };
    const opts = await svc.getOptions();
    for (const k of ['temperature', 'maxTokens', 'topK', 'historyLimit', 'toolsMaxIterations']) {
      assert.ok(Number.isFinite(opts[k]), `${k} = ${opts[k]}`);
    }
    assert.ok(opts.toolsMaxIterations >= 1);
  });

  console.log(`\n${total - failures}/${total} passed`);
  if (total !== EXPECTED_CHECKS) {
    console.error(`Erwartet ${EXPECTED_CHECKS} Checks, gelaufen ${total}`);
    process.exit(1);
  }
  process.exit(failures === 0 ? 0 : 1);
})();
