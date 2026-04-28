'use strict';

const express = require('express');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const PORT = parseInt(process.env.PORT || '9000', 10);
const ROOT = process.env.WORKSPACE_ROOT || '/workspaces';
const TOKEN = process.env.WORKSPACE_API_TOKEN || '';
const READ_MAX_BYTES = parseInt(process.env.READ_MAX_BYTES || `${5 * 1024 * 1024}`, 10);
const DEFAULT_TREE_DEPTH = 3;
const MAX_TREE_DEPTH = 8;
const MAX_TREE_ENTRIES = 5000;
const SEARCH_TIMEOUT_MS = 30_000;
const GIT_TIMEOUT_MS = 5 * 60_000;
const EXEC_DEFAULT_TIMEOUT_MS = 60_000;
const EXEC_MAX_TIMEOUT_MS = 600_000; // 10 min ceiling for slow build steps
const EXEC_OUTPUT_CAP_BYTES = 1 * 1024 * 1024; // 1MB per stream

// Patterns that are rejected hard at the sidecar before the shell ever sees
// them. Caught at substring level so they fire even when wrapped in pipes
// or quoting. Not exhaustive — defence-in-depth, never the only line.
const EXEC_BLACKLIST = [
  /\brm\s+-rf?\s+(\/|--no-preserve-root)/i,    // rm -rf /
  /\bcurl\b[^|;&]*\|\s*(sh|bash|zsh)\b/i,      // curl ... | sh
  /\bwget\b[^|;&]*\|\s*(sh|bash|zsh)\b/i,      // wget ... | sh
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,   // fork bomb
  /\bmkfs\b/i,                                  // format filesystems
  /\bdd\s+if=.*\s+of=\/dev\//i,                 // direct device writes
  /\bshutdown\b|\breboot\b|\bhalt\b/i,
];

// Process environment passed to /exec children. We strip everything by
// default and only pass the bare minimum a shell needs to run. Caller-
// supplied env on /exec is whitelisted on top of this (Phase-5 secrets).
const EXEC_ENV_WHITELIST_KEYS = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'SHELL'];
// Caller-supplied env vars must match this pattern — no =, no $, no spaces.
const EXEC_ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;
const EXEC_ENV_VALUE_MAX_LEN = 4096;

if (!TOKEN || TOKEN.length < 16) {
  console.error('FATAL: WORKSPACE_API_TOKEN env var must be set and at least 16 chars long');
  process.exit(1);
}

// Slug-style workspace ID — matches the API-side schema validator. Restricts
// the segment to a safe character set so path joins cannot escape ROOT.
const WORKSPACE_ID_PATTERN = /^[a-f0-9]{24}$|^[a-z0-9][a-z0-9_-]{0,63}$/i;

function tokenFromHeader(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  return auth.slice(7);
}

function authMiddleware(req, res, next) {
  if (req.path === '/health') return next();
  const supplied = tokenFromHeader(req);
  if (!supplied) return res.status(401).json({ error: 'missing bearer token' });
  const a = Buffer.from(supplied);
  const b = Buffer.from(TOKEN);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'invalid bearer token' });
  }
  next();
}

function requireWorkspaceId(req, res) {
  const id = req.body?.workspaceId;
  if (typeof id !== 'string' || !WORKSPACE_ID_PATTERN.test(id)) {
    res.status(400).json({ error: 'workspaceId must be a slug-compatible string' });
    return null;
  }
  return id;
}

function workspaceRoot(workspaceId) {
  return path.join(ROOT, workspaceId);
}

/**
 * Resolves a caller-supplied path against the workspace root and verifies
 * the result stays inside it. Rejects symlink-escapes by passing the result
 * through fs.realpath when the file exists; for not-yet-existing paths the
 * lexical containment check is sufficient.
 */
async function resolveInsideWorkspace(workspaceId, requestedPath) {
  const root = workspaceRoot(workspaceId);
  const target = path.resolve(root, requestedPath || '.');
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (target !== root && !target.startsWith(rootWithSep)) {
    throw new Error('path escapes workspace root');
  }
  try {
    const real = await fsp.realpath(target);
    if (real !== root && !real.startsWith(rootWithSep)) {
      throw new Error('resolved path escapes workspace root');
    }
    return real;
  } catch (err) {
    if (err.code === 'ENOENT') return target;
    throw err;
  }
}

async function ensureWorkspaceDir(workspaceId) {
  const root = workspaceRoot(workspaceId);
  await fsp.mkdir(root, { recursive: true });
  return root;
}

async function workspaceExists(workspaceId) {
  try {
    const stat = await fsp.stat(workspaceRoot(workspaceId));
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function runProcess(cmd, args, { cwd, timeoutMs, maxOutputBytes = 10 * 1024 * 1024, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...(env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;

    const append = (current, chunk) => {
      if (current.length >= maxOutputBytes) {
        truncated = true;
        return current;
      }
      const remaining = maxOutputBytes - current.length;
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      if (chunk.length > remaining) truncated = true;
      return Buffer.concat([current, slice]);
    };

    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });

    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          try { child.kill('SIGKILL'); } catch { /* noop */ }
        }, timeoutMs)
      : null;

    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({
        exitCode: code,
        signal,
        timedOut,
        truncated,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
      });
    });
  });
}

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(authMiddleware);

app.get('/health', (_req, res) => {
  res.json({ ok: true, root: ROOT });
});

app.post('/clone', async (req, res) => {
  const id = requireWorkspaceId(req, res); if (!id) return;
  const repoUrl = req.body?.repoUrl;
  const branch = req.body?.branch;
  if (typeof repoUrl !== 'string' || !/^https?:\/\//i.test(repoUrl)) {
    return res.status(400).json({ error: 'repoUrl must be http(s) URL' });
  }
  if (branch !== undefined && (typeof branch !== 'string' || !/^[A-Za-z0-9._/-]{1,128}$/.test(branch))) {
    return res.status(400).json({ error: 'branch must match [A-Za-z0-9._/-]{1,128}' });
  }
  const root = await ensureWorkspaceDir(id);
  const dotGit = path.join(root, '.git');
  if (fs.existsSync(dotGit)) {
    return res.status(409).json({ error: 'workspace already contains a git repository — use /pull' });
  }
  const args = ['clone', '--depth', '1'];
  if (branch) args.push('--branch', branch);
  args.push('--', repoUrl, root);
  const result = await runProcess('git', args, { timeoutMs: GIT_TIMEOUT_MS });
  if (result.exitCode !== 0) {
    return res.status(500).json({ error: 'git clone failed', ...result });
  }
  res.json({ ok: true, ...result });
});

app.post('/pull', async (req, res) => {
  const id = requireWorkspaceId(req, res); if (!id) return;
  if (!await workspaceExists(id)) {
    return res.status(404).json({ error: 'workspace directory does not exist' });
  }
  const root = workspaceRoot(id);
  if (!fs.existsSync(path.join(root, '.git'))) {
    return res.status(409).json({ error: 'workspace contains no git repository' });
  }
  const result = await runProcess('git', ['pull', '--ff-only'], { cwd: root, timeoutMs: GIT_TIMEOUT_MS });
  if (result.exitCode !== 0) {
    return res.status(500).json({ error: 'git pull failed', ...result });
  }
  res.json({ ok: true, ...result });
});

app.post('/read', async (req, res) => {
  const id = requireWorkspaceId(req, res); if (!id) return;
  const requested = req.body?.path;
  if (typeof requested !== 'string' || !requested) {
    return res.status(400).json({ error: 'path must be a non-empty string' });
  }
  try {
    const target = await resolveInsideWorkspace(id, requested);
    const stat = await fsp.stat(target);
    if (!stat.isFile()) return res.status(400).json({ error: 'path is not a regular file' });
    if (stat.size > READ_MAX_BYTES) {
      return res.status(413).json({ error: `file too large (>${READ_MAX_BYTES} bytes)`, size: stat.size });
    }
    const buf = await fsp.readFile(target);
    res.json({ size: stat.size, content: buf.toString('utf8') });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'file not found' });
    res.status(400).json({ error: err.message });
  }
});

app.post('/tree', async (req, res) => {
  const id = requireWorkspaceId(req, res); if (!id) return;
  const requested = typeof req.body?.path === 'string' ? req.body.path : '.';
  const depthInput = Number(req.body?.depth ?? DEFAULT_TREE_DEPTH);
  const depth = Math.min(MAX_TREE_DEPTH, Math.max(1, Number.isFinite(depthInput) ? Math.trunc(depthInput) : DEFAULT_TREE_DEPTH));

  let entries = [];
  let truncated = false;
  try {
    const start = await resolveInsideWorkspace(id, requested);
    const stack = [{ dir: start, level: 0 }];
    while (stack.length) {
      const { dir, level } = stack.pop();
      let listing;
      try {
        listing = await fsp.readdir(dir, { withFileTypes: true });
      } catch (err) {
        if (err.code === 'ENOENT') return res.status(404).json({ error: 'directory not found' });
        throw err;
      }
      for (const entry of listing) {
        if (entries.length >= MAX_TREE_ENTRIES) { truncated = true; break; }
        if (entry.name === '.git') continue;
        const full = path.join(dir, entry.name);
        const rel = path.relative(workspaceRoot(id), full);
        entries.push({ path: rel, type: entry.isDirectory() ? 'dir' : entry.isSymbolicLink() ? 'symlink' : 'file' });
        if (entry.isDirectory() && level + 1 < depth) {
          stack.push({ dir: full, level: level + 1 });
        }
      }
      if (truncated) break;
    }
    entries.sort((a, b) => a.path.localeCompare(b.path));
    res.json({ root: requested, depth, truncated, entries });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/search', async (req, res) => {
  const id = requireWorkspaceId(req, res); if (!id) return;
  const query = req.body?.query;
  const include = req.body?.include;
  const exclude = req.body?.exclude;
  if (typeof query !== 'string' || !query.length) {
    return res.status(400).json({ error: 'query must be a non-empty string' });
  }
  if (query.length > 500) return res.status(400).json({ error: 'query too long (max 500)' });
  if (!await workspaceExists(id)) return res.status(404).json({ error: 'workspace not initialised' });

  const args = ['--no-heading', '--line-number', '--max-count', '50', '--max-columns', '300', '--ignore-case'];
  const validGlob = (g) => typeof g === 'string' && g.length < 200 && !/[\n\r]/.test(g);
  const normaliseGlobs = (input) => {
    if (input === undefined) return [];
    const list = Array.isArray(input) ? input : [input];
    return list.filter(validGlob).slice(0, 20);
  };
  for (const g of normaliseGlobs(include)) args.push('--glob', g);
  for (const g of normaliseGlobs(exclude)) args.push('--glob', `!${g}`);
  args.push('--', query, '.');

  const result = await runProcess('rg', args, {
    cwd: workspaceRoot(id),
    timeoutMs: SEARCH_TIMEOUT_MS,
    maxOutputBytes: 2 * 1024 * 1024,
  });
  // ripgrep exit 1 means "no match" — surface as success with empty matches.
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    return res.status(500).json({ error: 'ripgrep failed', ...result });
  }
  res.json({ matches: result.stdout, truncated: result.truncated, timedOut: result.timedOut });
});

app.post('/status', async (req, res) => {
  const id = requireWorkspaceId(req, res); if (!id) return;
  const root = workspaceRoot(id);
  if (!fs.existsSync(path.join(root, '.git'))) {
    return res.status(409).json({ error: 'workspace contains no git repository' });
  }
  const result = await runProcess('git', ['status', '--porcelain=v1', '--branch'], { cwd: root, timeoutMs: 30_000 });
  if (result.exitCode !== 0) return res.status(500).json({ error: 'git status failed', ...result });
  res.json({ status: result.stdout });
});

function buildExecEnv(callerEnv) {
  const safe = {};
  for (const key of EXEC_ENV_WHITELIST_KEYS) {
    if (process.env[key] !== undefined) safe[key] = process.env[key];
  }
  if (callerEnv && typeof callerEnv === 'object' && !Array.isArray(callerEnv)) {
    for (const [k, v] of Object.entries(callerEnv)) {
      if (!EXEC_ENV_KEY_PATTERN.test(k)) continue;
      if (typeof v !== 'string' || v.length > EXEC_ENV_VALUE_MAX_LEN) continue;
      safe[k] = v;
    }
  }
  return safe;
}

function isCommandBlacklisted(command) {
  return EXEC_BLACKLIST.some((re) => re.test(command));
}

/**
 * Spawns the command via `bash -lc` so users get pipes / globbing / env
 * expansion. Detached so we own the whole process group and can SIGKILL
 * children of children on timeout.
 */
function runExec({ command, cwd, timeoutMs, env }) {
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', ['-lc', command], {
      cwd,
      env,
      detached: true,                  // own process group
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const startedAt = Date.now();
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let killedAt = null;

    const append = (current, chunk, capRef) => {
      if (current.length >= EXEC_OUTPUT_CAP_BYTES) { capRef.truncated = true; return current; }
      const remaining = EXEC_OUTPUT_CAP_BYTES - current.length;
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      if (chunk.length > remaining) capRef.truncated = true;
      return Buffer.concat([current, slice]);
    };
    const stdoutRef = { get truncated() { return stdoutTruncated; }, set truncated(v) { stdoutTruncated = v; } };
    const stderrRef = { get truncated() { return stderrTruncated; }, set truncated(v) { stderrTruncated = v; } };
    child.stdout.on('data', (c) => { stdout = append(stdout, c, stdoutRef); });
    child.stderr.on('data', (c) => { stderr = append(stderr, c, stderrRef); });

    // SIGTERM after timeout, then SIGKILL after a 5s grace period. We kill
    // the negative pid to take down the whole process group (npm spawns
    // node spawns…) so nothing leaks.
    const killPg = (signal) => {
      try { process.kill(-child.pid, signal); } catch { /* group may be gone */ }
    };
    const softTimer = setTimeout(() => {
      timedOut = true;
      killedAt = Date.now();
      killPg('SIGTERM');
    }, timeoutMs);
    const hardTimer = setTimeout(() => killPg('SIGKILL'), timeoutMs + 5_000);

    child.on('error', (err) => {
      clearTimeout(softTimer); clearTimeout(hardTimer);
      resolve({
        exitCode: null, signal: null, timedOut, durationMs: Date.now() - startedAt,
        stdout: '', stderr: String(err && err.message ? err.message : err),
        stdoutTruncated: false, stderrTruncated: false,
      });
    });
    child.on('close', (code, signal) => {
      clearTimeout(softTimer); clearTimeout(hardTimer);
      resolve({
        exitCode: code,
        signal,
        timedOut,
        killedAt,
        durationMs: Date.now() - startedAt,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
        stdoutTruncated,
        stderrTruncated,
      });
    });
  });
}

app.post('/exec', async (req, res) => {
  const id = requireWorkspaceId(req, res); if (!id) return;
  const command = req.body?.command;
  if (typeof command !== 'string' || !command.trim()) {
    return res.status(400).json({ error: 'command must be a non-empty string' });
  }
  if (command.length > 8 * 1024) {
    return res.status(400).json({ error: 'command too long (max 8KB)' });
  }
  if (isCommandBlacklisted(command)) {
    return res.status(400).json({ error: 'command rejected by safety blacklist' });
  }

  let timeoutMs = Number(req.body?.timeout ?? EXEC_DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = EXEC_DEFAULT_TIMEOUT_MS;
  if (timeoutMs > EXEC_MAX_TIMEOUT_MS) timeoutMs = EXEC_MAX_TIMEOUT_MS;

  if (!await workspaceExists(id)) {
    return res.status(404).json({ error: 'workspace directory does not exist — clone first' });
  }
  const cwd = workspaceRoot(id);
  const env = buildExecEnv(req.body?.env);

  const result = await runExec({ command, cwd, timeoutMs, env });
  console.log(JSON.stringify({
    type: 'exec',
    workspaceId: id,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    cmdLen: command.length,
    cmdPreview: command.slice(0, 120),
  }));
  res.json(result);
});

app.post('/cleanup', async (req, res) => {
  const id = requireWorkspaceId(req, res); if (!id) return;
  const root = workspaceRoot(id);
  // Defence-in-depth: reject if root somehow resolved outside ROOT.
  if (!root.startsWith(ROOT + path.sep)) {
    return res.status(500).json({ error: 'computed workspace root is outside ROOT' });
  }
  if (!await workspaceExists(id)) return res.json({ ok: true, removed: false });
  await fsp.rm(root, { recursive: true, force: true });
  res.json({ ok: true, removed: true });
});

app.post('/size', async (req, res) => {
  const id = requireWorkspaceId(req, res); if (!id) return;
  const root = workspaceRoot(id);
  if (!await workspaceExists(id)) return res.json({ sizeBytes: 0 });
  const result = await runProcess('du', ['-sb', root], { timeoutMs: 30_000 });
  if (result.exitCode !== 0) return res.status(500).json({ error: 'du failed', ...result });
  const sizeBytes = parseInt(result.stdout.split(/\s+/)[0] || '0', 10);
  res.json({ sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : 0 });
});

app.use((err, _req, res, _next) => {
  console.error('unhandled error', err);
  res.status(500).json({ error: err.message || 'internal error' });
});

app.listen(PORT, () => {
  console.log(`devgrimoire-workspace sidecar listening on :${PORT}, root=${ROOT}`);
});
