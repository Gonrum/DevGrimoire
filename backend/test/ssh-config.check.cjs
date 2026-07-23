'use strict';
// Unit check for SshController.getConfig / setConfig (admin upload-limit config).
const assert = require('node:assert');
const path = require('node:path');
const { SshController } = require(path.resolve(__dirname, '..', 'dist', 'ssh', 'ssh.controller'));

function makeSettingsStub(initial = null) {
  const store = { 'ssh.maxUploadBytes': initial };
  return {
    store,
    async get(key) { return store[key] ?? null; },
    async set(key, value) { store[key] = value; return { key, value }; },
  };
}

function makeController(settings) {
  // Positional: (sshService, sshTestService, auditModel, settingsService, sshSessionService)
  return new SshController({}, {}, {}, settings, {});
}

const MB = 1024 * 1024;

(async () => {
  // getConfig with nothing set -> 10 MB default, 500 MB ceiling.
  {
    const settings = makeSettingsStub(null);
    const cfg = await makeController(settings).getConfig();
    assert.strictEqual(cfg.maxUploadBytes, 10 * MB);
    assert.strictEqual(cfg.hardMaxBytes, 500 * MB);
    assert.strictEqual(cfg.defaultBytes, 10 * MB);
  }

  // setConfig persists a valid value and echoes it.
  {
    const settings = makeSettingsStub(null);
    const ctrl = makeController(settings);
    const res = await ctrl.setConfig({ maxUploadBytes: 50 * MB });
    assert.strictEqual(res.maxUploadBytes, 50 * MB);
    assert.strictEqual(settings.store['ssh.maxUploadBytes'], String(50 * MB));
    const cfg = await ctrl.getConfig();
    assert.strictEqual(cfg.maxUploadBytes, 50 * MB);
  }

  // setConfig rejects non-numeric / zero / over-ceiling.
  {
    const ctrl = makeController(makeSettingsStub(null));
    await assert.rejects(() => ctrl.setConfig({ maxUploadBytes: 0 }), /positive integer/);
    await assert.rejects(() => ctrl.setConfig({}), /positive integer/);
    await assert.rejects(() => ctrl.setConfig({ maxUploadBytes: 600 * MB }), /hard ceiling/);
  }

  console.log('ssh-config.check.cjs OK');
})().catch((e) => { console.error(e); process.exit(1); });
