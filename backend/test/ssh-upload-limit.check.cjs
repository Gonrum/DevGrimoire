'use strict';
// Unit check for the pure upload-limit clamp. Run against compiled dist.
const assert = require('node:assert');
const {
  computeEffectiveUploadLimit,
  SFTP_HARD_MAX_UPLOAD_BYTES,
} = require('../dist/ssh/upload-limit.util');

const MB = 1024 * 1024;

// Ceiling is exactly 500 MB.
assert.strictEqual(SFTP_HARD_MAX_UPLOAD_BYTES, 500 * MB);

// No global set, no override -> 10 MB default.
assert.strictEqual(computeEffectiveUploadLimit(null, null), 10 * MB);

// Global set, no override -> global.
assert.strictEqual(computeEffectiveUploadLimit(50 * MB, null), 50 * MB);

// Override beats global.
assert.strictEqual(computeEffectiveUploadLimit(50 * MB, 5 * MB), 5 * MB);

// Override above ceiling is clamped down.
assert.strictEqual(computeEffectiveUploadLimit(null, 900 * MB), 500 * MB);

// Global above ceiling is clamped down.
assert.strictEqual(computeEffectiveUploadLimit(900 * MB, null), 500 * MB);

// Zero / negative / NaN fall back to default.
assert.strictEqual(computeEffectiveUploadLimit(0, null), 10 * MB);
assert.strictEqual(computeEffectiveUploadLimit(null, -1), 10 * MB);
assert.strictEqual(computeEffectiveUploadLimit(Number.NaN, null), 10 * MB);

console.log('ssh-upload-limit.check.cjs OK');
