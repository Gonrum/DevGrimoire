'use strict';

const express = require('express');
const http = require('http');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');

/**
 * Positive Ganzzahl aus der Umgebung, sonst Abbruch (M-24). Vorher
 * `parseInt(...)` ohne Prüfung: `READ_MAX_BYTES=50MB` wurde zu 50,
 * `READ_MAX_BYTES=MB50` zu NaN — und `size > NaN` ist immer false, die
 * Grössenprüfung feuerte nie. Ein Tippfehler hob also das Limit auf. Lieber
 * laut beim Start scheitern als still ohne Grenze laufen.
 */
function positiveIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) <= 0 || !Number.isSafeInteger(Number(raw))) {
    console.error(`FATAL: ${name}=${JSON.stringify(raw)} ist keine positive Ganzzahl`);
    process.exit(1);
  }
  return Number(raw);
}

const PORT = positiveIntEnv('PORT', 9000);
const ROOT = process.env.WORKSPACE_ROOT || '/workspaces';
const TOKEN = process.env.WORKSPACE_API_TOKEN || '';
const READ_MAX_BYTES = positiveIntEnv('READ_MAX_BYTES', 5 * 1024 * 1024);
const STREAM_MAX_BYTES = positiveIntEnv('STREAM_MAX_BYTES', 500 * 1024 * 1024);
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

// H-5: Ohne diese Handler beendete JEDER einzelne unbehandelte Fehler den
// Prozess — ein ENOSPC beim Cleanup, ein ECONNRESET auf einem Terminal-Socket,
// ein fehlendes `rg` — und mit ihm alle PTYs und laufenden Builds.
// Geloggt wird laut; weitergelaufen wird bewusst: ein
// Sidecar-Neustart trifft jeden Nutzer, ein einzelner fehlgeschlagener
// Request nur einen.
process.on('unhandledRejection', (reason) => {
  console.error(JSON.stringify({ type: 'unhandled-rejection', error: String(reason && reason.stack ? reason.stack : reason) }));
});
process.on('uncaughtException', (err) => {
  console.error(JSON.stringify({ type: 'uncaught-exception', error: String(err && err.stack ? err.stack : err) }));
});

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

/**
 * Per-workspace cwd state. Each /exec call writes `pwd` into this file at
 * the end so the next /exec can resume from the same directory — gives
 * the manual terminal a working `cd`/`mkdir foo && cd foo` workflow
 * without needing a real PTY. Stored OUTSIDE the workspace volume's user
 * tree (in /tmp) so the user's own files can never collide with it.
 */
const CWD_STATE_DIR = '/tmp/dg-cwd';

async function readCwdState(workspaceId) {
  try {
    const raw = await fsp.readFile(`${CWD_STATE_DIR}/${workspaceId}`, 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) return null;
    // Reject anything that escaped the workspace root since the last call —
    // a symlink swap or `cd /etc` should not stick across exec boundaries.
    const root = workspaceRoot(workspaceId);
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
    if (trimmed !== root && !trimmed.startsWith(rootWithSep)) return null;
    return trimmed;
  } catch {
    return null;
  }
}

async function ensureCwdStateDir() {
  await fsp.mkdir(CWD_STATE_DIR, { recursive: true });
}

function cwdStatePath(workspaceId) {
  return `${CWD_STATE_DIR}/${workspaceId}`;
}

/**
 * Wrap a user command so that:
 *   1. it starts in the workspace's last-known cwd (or root on first call)
 *   2. the resulting cwd is persisted to the state file
 * The wrapper runs unconditionally (set -m off, single-quote escaping the
 * inner cwd) — even if the user's command exits non-zero, we still update
 * the state from wherever bash ended up.
 */
function wrapWithCwdState(userCmd, startCwd, statePath, workspaceRootDir) {
  // Single-quote-escape any path going into the bash wrapper — wrap each
  // ' as '\\'' so bash sees a literal string. Same trick as `printf %q`
  // but we don't rely on it being present across all bash builds.
  const sq = (s) => s.replace(/'/g, `'\\''`);
  const safeCwd = sq(startCwd);
  const safeStatePath = sq(statePath);
  const safeRoot = sq(workspaceRootDir);
  // Only persist the resulting cwd when it stays inside the workspace
  // root. If the user's command escaped (`cd /etc`), we silently leave
  // the state file untouched so the *next* exec resumes from the last
  // good cwd instead of getting reset to root.
  return [
    `cd '${safeCwd}' 2>/dev/null || cd '${safeRoot}'`,
    `{ ${userCmd}; }`,
    `__DG_RC=$?`,
    `__DG_PWD="$(pwd)"`,
    `case "$__DG_PWD" in '${safeRoot}'|'${safeRoot}'/*) printf %s "$__DG_PWD" > '${safeStatePath}' 2>/dev/null;; esac`,
    `exit $__DG_RC`,
  ].join('; ');
}

async function workspaceExists(workspaceId) {
  try {
    const stat = await fsp.stat(workspaceRoot(workspaceId));
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Minimale Umgebung für Kindprozesse (M-21): nur die Whitelist, nie das volle
 * `process.env`. Vorher erbten git/rg/du — anders als /exec — alles,
 * inklusive WORKSPACE_API_TOKEN. Über /exec liess sich `.git/config` mit
 * `core.fsmonitor`/`core.hooksPath` präparieren; das nächste /pull führte den
 * Code dann MIT dem Sidecar-Token in der Umgebung aus — und mit dem Token
 * /exec auf jeden Workspace. `env` ist hier immer intern gesetzt, kein
 * Caller-Input.
 */
function baseChildEnv() {
  const safe = {};
  for (const key of EXEC_ENV_WHITELIST_KEYS) {
    if (process.env[key] !== undefined) safe[key] = process.env[key];
  }
  return safe;
}

function runProcess(cmd, args, { cwd, timeoutMs, maxOutputBytes = 10 * 1024 * 1024, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...baseChildEnv(), GIT_TERMINAL_PROMPT: '0', ...(env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // H-5: ohne 'error'-Listener (z. B. ENOENT, wenn rg/git/du fehlt) warf
    // spawn asynchron ein 'error'-Event ohne Abnehmer -> Prozess-Ende.
    let spawnError = null;
    child.on('error', (err) => { spawnError = err; });

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
        exitCode: spawnError ? null : code,
        signal,
        timedOut,
        truncated,
        stdout: stdout.toString('utf8'),
        stderr: spawnError ? `${stderr.toString('utf8')}${spawnError.message}` : stderr.toString('utf8'),
      });
    });
  });
}

const app = express();

/**
 * Express 4 fängt Rejections aus async Handlern nicht (H-5): ein `await`,
 * das wirft (ensureWorkspaceDir, fsp.rm mit ENOSPC/EBUSY …), wurde zur
 * unhandled rejection. Statt jede Route einzeln zu wrappen, reichen die
 * Routing-Methoden jede Handler-Promise an `next(err)` weiter — eine neue
 * Route kann es damit nicht vergessen. `app.get(name)` mit einem Argument
 * ist der Settings-Getter und bleibt unangetastet.
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    try {
      const out = fn(req, res, next);
      if (out && typeof out.then === 'function') out.catch(next);
    } catch (err) {
      next(err);
    }
  };
}
for (const method of ['get', 'post', 'put', 'delete']) {
  const original = app[method].bind(app);
  app[method] = (routePath, ...handlers) => {
    if (handlers.length === 0) return original(routePath);
    return original(routePath, ...handlers.map((h) => (typeof h === 'function' && h.length < 4 ? asyncHandler(h) : h)));
  };
}

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

/**
 * Binary-safe variant of /read. Returns the file as base64 so the upstream can
 * forward it to MinIO/Attachments without UTF-8 corruption. Same path-safety
 * rules and size cap as /read — that endpoint stays utf-8-only because the
 * common agent use-case is reading source code.
 */
app.post('/read-base64', async (req, res) => {
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
    res.json({ size: stat.size, contentBase64: buf.toString('base64') });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'file not found' });
    res.status(400).json({ error: err.message });
  }
});

/**
 * Streaming download for large files (SFTP uploads etc.). Unlike /read, this
 * pipes the file straight to the response — no full-buffer, no base64 — so it
 * supports files far larger than READ_MAX_BYTES (capped at STREAM_MAX_BYTES,
 * default 500 MB). Same path-safety rules as /read.
 */
app.post('/read-stream', async (req, res) => {
  const id = requireWorkspaceId(req, res); if (!id) return;
  const requested = req.body?.path;
  if (typeof requested !== 'string' || !requested) {
    return res.status(400).json({ error: 'path must be a non-empty string' });
  }
  let target;
  try {
    target = await resolveInsideWorkspace(id, requested);
    const stat = await fsp.stat(target);
    if (!stat.isFile()) return res.status(400).json({ error: 'path is not a regular file' });
    if (stat.size > STREAM_MAX_BYTES) {
      return res.status(413).json({ error: `file too large (>${STREAM_MAX_BYTES} bytes)`, size: stat.size });
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(stat.size));
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'file not found' });
    return res.status(400).json({ error: err.message });
  }
  const stream = fs.createReadStream(target);
  // Abort the read if the client disconnects mid-stream.
  req.on('close', () => { try { stream.destroy(); } catch { /* noop */ } });
  stream.on('error', (err) => {
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.destroy(err);
  });
  stream.pipe(res);
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

/**
 * Streaming variant of runExec. Emits one event per line of stdout/stderr
 * via `onEvent` and a final `done` (or `error`) event. The same safety
 * layers as runExec apply: detached process group, SIGTERM→SIGKILL on
 * timeout or upstream abort, 1MB cap per stream. The caller controls
 * cancellation through `abortSignal`.
 */
function runExecStream({ command, cwd, timeoutMs, env, abortSignal }, onEvent) {
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', ['-lc', command], {
      cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const startedAt = Date.now();
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let stdoutBuf = '';
    let stderrBuf = '';
    let timedOut = false;
    let killReason = null;

    const killPg = (signal) => {
      try { process.kill(-child.pid, signal); } catch { /* gone */ }
    };

    const lineEmitter = (stream) => (chunk) => {
      const cap = stream === 'stdout' ? stdoutBytes : stderrBytes;
      if (cap >= EXEC_OUTPUT_CAP_BYTES) {
        if (stream === 'stdout' && !stdoutTruncated) { stdoutTruncated = true; onEvent({ type: 'truncated', stream }); }
        if (stream === 'stderr' && !stderrTruncated) { stderrTruncated = true; onEvent({ type: 'truncated', stream }); }
        return;
      }
      const remaining = EXEC_OUTPUT_CAP_BYTES - cap;
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      if (chunk.length > remaining) {
        if (stream === 'stdout') stdoutTruncated = true; else stderrTruncated = true;
      }
      const text = slice.toString('utf8');
      if (stream === 'stdout') stdoutBytes += slice.length; else stderrBytes += slice.length;
      // Line-buffer so partial UTF-8/lines don't ship as half-events.
      let buf = stream === 'stdout' ? stdoutBuf + text : stderrBuf + text;
      const newlineIndex = buf.lastIndexOf('\n');
      if (newlineIndex >= 0) {
        const complete = buf.slice(0, newlineIndex);
        const tail = buf.slice(newlineIndex + 1);
        for (const line of complete.split('\n')) {
          onEvent({ type: stream, line });
        }
        if (stream === 'stdout') stdoutBuf = tail; else stderrBuf = tail;
      } else {
        if (stream === 'stdout') stdoutBuf = buf; else stderrBuf = buf;
      }
    };
    child.stdout.on('data', lineEmitter('stdout'));
    child.stderr.on('data', lineEmitter('stderr'));

    const softTimer = setTimeout(() => {
      timedOut = true;
      killReason = 'timeout';
      killPg('SIGTERM');
    }, timeoutMs);
    const hardTimer = setTimeout(() => killPg('SIGKILL'), timeoutMs + 5_000);

    const onAbort = () => {
      if (killReason) return;
      killReason = 'abort';
      killPg('SIGTERM');
      setTimeout(() => killPg('SIGKILL'), 2_000);
    };
    if (abortSignal) {
      if (abortSignal.aborted) onAbort();
      else abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (err) => {
      clearTimeout(softTimer); clearTimeout(hardTimer);
      onEvent({ type: 'error', message: String(err && err.message ? err.message : err) });
      resolve();
    });
    child.on('close', (code, signal) => {
      clearTimeout(softTimer); clearTimeout(hardTimer);
      // Flush trailing partial lines (no terminating newline).
      if (stdoutBuf) onEvent({ type: 'stdout', line: stdoutBuf });
      if (stderrBuf) onEvent({ type: 'stderr', line: stderrBuf });
      onEvent({
        type: 'done',
        exitCode: code,
        signal,
        timedOut,
        killReason,
        durationMs: Date.now() - startedAt,
        stdoutTruncated,
        stderrTruncated,
        stdoutBytes,
        stderrBytes,
      });
      resolve();
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

  // Lazy-create the workspace dir so empty/just-created workspaces support
  // exec from the get-go (mkdir/git clone/curl/whatever). For tools that
  // strictly need an existing clone (/pull, /tree, /read, /search, /status,
  // /size) we still 404.
  const cwd = await ensureWorkspaceDir(id);
  await ensureCwdStateDir();
  const startCwd = (await readCwdState(id)) || cwd;
  const wrappedCommand = wrapWithCwdState(command, startCwd, cwdStatePath(id), cwd);
  const env = buildExecEnv(req.body?.env);

  const result = await runExec({ command: wrappedCommand, cwd, timeoutMs, env });
  // Echo the resulting cwd back so callers can show it in a prompt.
  result.cwd = (await readCwdState(id)) || cwd;
  console.log(JSON.stringify({
    type: 'exec',
    workspaceId: id,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    cmdLen: command.length,
    // M-26: kein Klartext-Ausschnitt mehr. `curl -H "Authorization: …"`,
    // `export DB_PASS=…`, `git clone https://user:pass@…` landeten sonst in
    // docker logs und jedem Log-Driver. Der Hash erlaubt Korrelation, ohne
    // den Inhalt preiszugeben.
    cmdSha256: crypto.createHash('sha256').update(command).digest('hex').slice(0, 16),
  }));
  res.json(result);
});

/**
 * Streaming variant of /exec. Emits NDJSON (one JSON object per line) so
 * the upstream can pipe the body through unchanged or repackage it as SSE.
 * The same safety layers apply (blacklist, scrubbed env, timeouts, process
 * group cleanup). Closing the upstream connection aborts the child via
 * abortSignal → SIGTERM → SIGKILL.
 */
app.post('/exec/stream', async (req, res) => {
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
  // Lazy-create the workspace dir so empty/just-created workspaces support
  // exec from the get-go (mkdir/git clone/curl/whatever). For tools that
  // strictly need an existing clone (/pull, /tree, /read, /search, /status,
  // /size) we still 404.
  const cwd = await ensureWorkspaceDir(id);
  await ensureCwdStateDir();
  let timeoutMs = Number(req.body?.timeout ?? EXEC_DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = EXEC_DEFAULT_TIMEOUT_MS;
  if (timeoutMs > EXEC_MAX_TIMEOUT_MS) timeoutMs = EXEC_MAX_TIMEOUT_MS;

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');

  const abort = new AbortController();
  req.on('close', () => abort.abort());

  const startedAt = Date.now();
  const env = buildExecEnv(req.body?.env);

  // Wrap the command so cd persists across calls (see wrapWithCwdState).
  const startCwd = (await readCwdState(id)) || cwd;
  const wrappedCommand = wrapWithCwdState(command, startCwd, cwdStatePath(id), cwd);

  let lastEvent = null;
  await runExecStream({ command: wrappedCommand, cwd, timeoutMs, env, abortSignal: abort.signal }, (ev) => {
    lastEvent = ev;
    // Inject the resulting cwd into the done event so the frontend can
    // render it in the prompt without an extra round-trip.
    if (ev.type === 'done') {
      // Read synchronously-after-the-fact via a final fs op — done event
      // emits before the wrapper writes? No: bash exits AFTER `pwd > file`,
      // and the child's `close` fires AFTER bash exits, so the file is
      // flushed by then. We resolve the read async below before flushing.
    }
    if (!res.writableEnded) res.write(JSON.stringify(ev) + '\n');
  });
  // After the stream finished, send a small follow-up event with the new
  // cwd. Done event was already on the wire; this is a sibling event.
  const newCwd = (await readCwdState(id)) || cwd;
  if (!res.writableEnded) res.write(JSON.stringify({ type: 'cwd', cwd: newCwd }) + '\n');
  if (!res.writableEnded) res.end();

  const done = lastEvent && lastEvent.type === 'done' ? lastEvent : null;
  console.log(JSON.stringify({
    type: 'exec-stream',
    workspaceId: id,
    durationMs: Date.now() - startedAt,
    exitCode: done ? done.exitCode : null,
    timedOut: done ? done.timedOut : true,
    killReason: done ? done.killReason : 'aborted',
    cmdLen: command.length,
    cmdSha256: crypto.createHash('sha256').update(command).digest('hex').slice(0, 16),
  }));
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
  // Drop the per-workspace cwd state too so a re-created workspace with
  // the same id (TTL-resurrection corner case) starts at root.
  await fsp.rm(cwdStatePath(id), { force: true });
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

// Kube-Sessions (K3) gibt es hier nicht mehr (C-3): ihre Kubeconfigs lagen
// unter derselben UID wie jede Workspace-Shell und waren damit für jede Shell
// lesbar. Cluster-Zugriff aus der Shell läuft über `dg kube` → Backend; die
// Credentials verlassen das Backend nicht.

app.use((err, _req, res, _next) => {
  console.error(JSON.stringify({ type: 'route-error', error: String(err && err.stack ? err.stack : err) }));
  if (res.headersSent) {
    // Streaming-Route mitten in der Antwort: nur noch beenden.
    try { res.end(); } catch { /* noop */ }
    return;
  }
  res.status(500).json({ error: (err && err.message) || 'internal error' });
});

// ---------------------------------------------------------------------------
// WebSocket terminal — persistent bash -i per (workspaceId,sessionId) so cd,
// env vars, aliases, history and TTY-only programs (htop/vim/...) all work
// like a normal shell. Per-Command /exec/stream stays for one-shot/agent
// flows; this is the human-facing interactive surface.
// ---------------------------------------------------------------------------

/**
 * Active PTYs keyed by `ws:<workspaceId>:<sessionId>`. We keep a reference so an
 * accidental WS close (browser tab refresh, transient network drop) gives the
 * user a few seconds to reconnect before we kill bash.
 */
const TERMINAL_IDLE_MS = 30 * 60_000;
const TERMINAL_MAX_PER_WORKSPACE = 8;
const activeTerminals = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, term] of activeTerminals) {
    if (now - term.lastActivity > TERMINAL_IDLE_MS) {
      try { term.pty.kill(); } catch { /* already dead */ }
      activeTerminals.delete(key);
    }
  }
}, 60_000);

function countTerminalsFor(workspaceId) {
  let n = 0;
  for (const key of activeTerminals.keys()) {
    if (key.startsWith(workspaceId + ':')) n += 1;
  }
  return n;
}

function timingSafeTokenMatch(supplied) {
  if (!supplied) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(TOKEN);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// M-22: `ws` erlaubt per Default 100 MiB pro Frame, und `term.write(raw)`
// schob den kompletten Frame ins PTY. Tastatureingaben und Resize-Nachrichten
// sind winzig; 1 MiB deckt auch grosses Einfügen aus der Zwischenablage ab.
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

/**
 * sessionId kommt aus dem Query-String (M-23). Ohne Prüfung überschrieb eine
 * wiederverwendete Id den Map-Eintrag: das alte PTY lief weiter, war aber für
 * Limit und Idle-Reaper unsichtbar, und sein onExit löschte später den
 * Eintrag des NEUEN Terminals — unbegrenzt PTYs trotz Limit. `:` ist der
 * Trenner der Map-Keys und deshalb nicht erlaubt.
 */
const TERMINAL_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const DG_ENV_KEYS = ['DG_API_URL', 'DG_API_TOKEN', 'DG_WORKSPACE_ID', 'DG_PROJECT_ID'];

/**
 * DG_*-Variablen für das interaktive Terminal, vom Backend-Proxy als
 * `X-Dg-Env` (Base64-JSON) mitgegeben — damit `dg` (insbesondere `dg kube`)
 * auch im Terminal funktioniert, nicht nur bei /exec. Nur die vier bekannten
 * Schlüssel, nur Strings, und DG_WORKSPACE_ID muss zum Terminal passen: ein
 * Token eines anderen Workspace landet nicht in dieser Shell. Alles andere
 * wird still verworfen — das Terminal geht dann ohne `dg` auf, wie bisher.
 * Der Header ist nur hinter der Bearer-Prüfung erreichbar.
 */
function parseDgEnvHeader(raw, workspaceId) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 8192) return {};
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const env = {};
  for (const key of DG_ENV_KEYS) {
    const v = parsed[key];
    if (typeof v !== 'string' || v.length === 0 || v.length > EXEC_ENV_VALUE_MAX_LEN) return {};
    env[key] = v;
  }
  if (env.DG_WORKSPACE_ID !== workspaceId) return {};
  return env;
}

const server = http.createServer(app);

server.on('upgrade', (req, socket, head) => {
  // H-5: ohne Listener beendete ein Socket-Fehler (ECONNRESET während des
  // Handshakes) den Prozess.
  socket.on('error', (err) => {
    console.error(JSON.stringify({ type: 'upgrade-socket-error', error: String(err && err.message ? err.message : err) }));
  });
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (url.pathname !== '/term') {
    socket.destroy();
    return;
  }
  // Browsers can't set Authorization headers on WS upgrade — accept the
  // bearer either via header (curl/server-side proxies) or ?token= query.
  const auth = req.headers.authorization;
  const headerToken = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const queryToken = url.searchParams.get('token');
  if (!timingSafeTokenMatch(headerToken || queryToken)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
    return;
  }

  const workspaceId = url.searchParams.get('workspaceId');
  if (!workspaceId || !WORKSPACE_ID_PATTERN.test(workspaceId)) {
    socket.write('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
    return;
  }

  const sessionId = url.searchParams.get('sessionId') || crypto.randomUUID();
  if (!TERMINAL_SESSION_ID_PATTERN.test(sessionId)) {
    socket.write('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
    return;
  }
  if (activeTerminals.has(`ws:${workspaceId}:${sessionId}`)) {
    socket.write('HTTP/1.1 409 Conflict\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
    return;
  }
  const dgEnv = parseDgEnvHeader(req.headers['x-dg-env'], workspaceId);

  // Key-Präfix `ws:` (M-23) — stammt aus der Zeit der Kube-Terminals, bleibt
  // als Namensraum für die Bookkeeping-Keys erhalten.
  if (countTerminalsFor(`ws:${workspaceId}`) >= TERMINAL_MAX_PER_WORKSPACE) {
    socket.write('HTTP/1.1 429 Too Many Terminals\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    handleTerminalConnection(ws, workspaceId, sessionId, dgEnv).catch((err) => {
      console.error('terminal connection failed', err);
      try { ws.close(1011, 'internal error'); } catch { /* noop */ }
    });
  });
});

/**
 * Wires a spawned PTY to its WebSocket: forwards PTY output to the socket,
 * routes socket input to keystrokes (or a resize control message), and
 * tears both down together on exit/close. `key` is the activeTerminals key
 * (`ws:<workspaceId>:<sessionId>`); this function treats it as an opaque
 * bookkeeping/log id, never branches on its shape.
 */
function wireTerminal(ws, term, state, key) {
  // Nur den EIGENEN Eintrag entfernen (M-23) — nie einen, den inzwischen ein
  // anderes Terminal unter demselben Key hält.
  const release = () => {
    if (activeTerminals.get(key) === state) activeTerminals.delete(key);
  };

  // M-22: Backpressure. Ohne sie wuchs der Sendepuffer bei einem langsamen
  // Client unbegrenzt (`yes | base64`), bis der OOM-Kill node traf — und mit
  // ihm alle Terminals. Über HIGH wird das PTY pausiert, unter LOW fortgesetzt.
  const HIGH_WATER = 4 * 1024 * 1024;
  const LOW_WATER = 512 * 1024;
  let paused = false;
  let drainTimer = null;
  const resumeWhenDrained = () => {
    if (drainTimer) return;
    drainTimer = setInterval(() => {
      if (ws.readyState !== ws.OPEN || ws.bufferedAmount < LOW_WATER) {
        clearInterval(drainTimer);
        drainTimer = null;
        paused = false;
        try { term.resume(); } catch { /* pty dead */ }
      }
    }, 50);
  };

  term.onData((data) => {
    state.lastActivity = Date.now();
    if (ws.readyState === ws.OPEN) {
      try { ws.send(data); } catch { /* socket dying */ }
      if (!paused && ws.bufferedAmount > HIGH_WATER) {
        paused = true;
        try { term.pause(); } catch { /* pty dead */ }
        resumeWhenDrained();
      }
    }
  });

  // H-5: Socket-Fehler kommen als Event, nicht als Throw aus send(); ohne
  // Listener beendete ein ECONNRESET den Prozess.
  ws.on('error', (err) => {
    console.error(JSON.stringify({ type: 'terminal-ws-error', key, error: String(err && err.message ? err.message : err) }));
    try { term.kill(); } catch { /* noop */ }
    release();
  });
  term.onExit(({ exitCode, signal }) => {
    console.log(JSON.stringify({
      type: 'pty-exit', key, exitCode, signal,
    }));
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'exit', exitCode, signal }));
        ws.close(1000, 'shell exited');
      } catch { /* noop */ }
    }
    if (drainTimer) clearInterval(drainTimer);
    release();
  });

  ws.on('message', (raw, isBinary) => {
    state.lastActivity = Date.now();
    // Resize messages come as JSON text frames; everything else is keystrokes.
    if (!isBinary) {
      const str = raw.toString('utf8');
      if (str.startsWith('{')) {
        try {
          const msg = JSON.parse(str);
          if (msg && msg.type === 'resize'
              && Number.isInteger(msg.cols) && msg.cols > 0 && msg.cols < 1000
              && Number.isInteger(msg.rows) && msg.rows > 0 && msg.rows < 1000) {
            term.resize(msg.cols, msg.rows);
            return;
          }
        } catch { /* fall through and treat as keystrokes */ }
      }
      term.write(str);
    } else {
      term.write(raw);
    }
  });

  ws.on('close', () => {
    try { term.kill(); } catch { /* noop */ }
    if (drainTimer) clearInterval(drainTimer);
    release();
    // Snapshot the last-known cwd so the per-command /exec path picks up
    // where the interactive session left off. node-pty doesn't expose a
    // cwd field directly, but bash's PWD env via a final command would —
    // for now we rely on the user's bash session having written its
    // state via PROMPT_COMMAND or just leave it stale.
  });
}

async function handleTerminalConnection(ws, workspaceId, sessionId, dgEnv = {}) {
  await ensureWorkspaceDir(workspaceId);
  await ensureCwdStateDir();
  const startCwd = (await readCwdState(workspaceId)) || workspaceRoot(workspaceId);

  const term = pty.spawn('/bin/bash', ['-i'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: startCwd,
    env: {
      ...buildExecEnv({}),
      ...dgEnv,
      // PTY-only niceties — make the prompt obvious and history work.
      TERM: 'xterm-256color',
      PS1: '\\[\\033[36m\\]\\w\\[\\033[0m\\] $ ',
      HISTFILE: `${ROOT}/${workspaceId}/.bash_history`,
      HISTSIZE: '500',
      HISTCONTROL: 'ignoredups:erasedups',
    },
  });

  const key = `ws:${workspaceId}:${sessionId}`;
  const state = { pty: term, ws, lastActivity: Date.now() };
  activeTerminals.set(key, state);

  console.log(JSON.stringify({
    type: 'pty-open', workspaceId, sessionId, pid: term.pid, cwd: startCwd,
  }));

  wireTerminal(ws, term, state, key);

  // Greeting line so the browser sees something even if bash takes a beat.
  ws.send(`\x1b[2m# devgrimoire workspace ${workspaceId} — bash session\x1b[0m\r\n`);
}

// M-25: SIGTERM sauber behandeln (docker stop). Vorher gab es keinen Handler;
// node als PID 1 ignoriert SIGTERM ohne Handler, docker wartete die 10 s ab
// und schickte SIGKILL — PTYs ohne Gelegenheit zum Aufräumen.
function shutdown(signal) {
  console.log(JSON.stringify({ type: 'shutdown', signal, terminals: activeTerminals.size }));
  for (const state of activeTerminals.values()) {
    try { state.pty.kill(); } catch { /* noop */ }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(PORT, () => {
  console.log(`devgrimoire-workspace sidecar listening on :${PORT}, root=${ROOT}`);
});
