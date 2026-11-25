'use strict';

const express = require('express');
const http = require('http');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
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
// Ceilings for a caller-supplied `maxBytes` (the backend passes the admin
// setting). Without `maxBytes` the READ_/STREAM_MAX_BYTES values above apply.
const READ_HARD_MAX_BYTES = positiveIntEnv('READ_HARD_MAX_BYTES', 100 * 1024 * 1024);
const STREAM_HARD_MAX_BYTES = positiveIntEnv('STREAM_HARD_MAX_BYTES', 50 * 1024 * 1024 * 1024);
// JSON body of /write: content up to the hard max, escaped (worst case about
// 2.2x for typical source text) plus headroom for the other fields.
const WRITE_BODY_LIMIT_BYTES = Math.ceil(READ_HARD_MAX_BYTES * 2.3) + 1024 * 1024;

/**
 * Effective byte limit of a request: `min(maxBytes, hard)` when the caller
 * sent one, else `base`. Returns `{ error }` for an invalid `maxBytes`.
 */
function effectiveLimit(maxBytes, base, hard) {
  if (maxBytes === undefined || maxBytes === null) return { limit: base };
  if (typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    return { error: 'maxBytes must be a positive integer' };
  }
  return { limit: Math.min(maxBytes, hard) };
}
const DEFAULT_TREE_DEPTH = 3;
const MAX_TREE_DEPTH = 8;
const MAX_TREE_ENTRIES = 5000;
const SEARCH_TIMEOUT_MS = 30_000;
const GIT_TIMEOUT_MS = 5 * 60_000;
const EXEC_DEFAULT_TIMEOUT_MS = 60_000;
const EXEC_MAX_TIMEOUT_MS = 600_000; // 10 min ceiling for slow build steps
const EXEC_OUTPUT_CAP_BYTES = 1 * 1024 * 1024; // 1MB per stream
// `fullOutput` streaming: pause the child while this much waits for the client.
const EXEC_STREAM_BUFFER_MAX = 4 * 1024 * 1024;
// `fullOutput` streaming: longest line event; longer lines go in pieces.
const EXEC_STREAM_LINE_MAX = 64 * 1024;

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

const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

/** No NUL byte in the first 8 KiB and valid UTF-8 throughout. */
function isStrictUtf8Text(buf) {
  if (buf.subarray(0, 8192).includes(0)) return false;
  try {
    STRICT_UTF8.decode(buf);
    return true;
  } catch {
    return false;
  }
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

// /write carries whole file contents (JSON-escaped, so up to ~6x the raw size
// in the worst case); it gets its own larger parser, behind auth so
// unauthenticated callers cannot make us buffer that much. The global parser skips
// bodies that are already parsed.
app.use('/write', authMiddleware, express.json({ limit: WRITE_BODY_LIMIT_BYTES }));
app.use(express.json({ limit: '256kb' }));
app.use(authMiddleware);

app.get('/health', (_req, res) => {
  res.json({ ok: true, root: ROOT });
});

/*
 * Git credentials (T-541). The token used to be embedded in the clone URL
 * (`https://x-access-token:<TOKEN>@host/...`), so git stored it as the
 * `origin` URL in `.git/config`, readable by every command in the workspace.
 * Now the remote URL is always credential-free and the token reaches git only
 * through the ENVIRONMENT of the one git process that needs it, via the
 * credential helper `git-credential-dg.sh`, bound to one host and https.
 * Env rather than argv: argv is visible to every user in `ps`,
 * `/proc/<pid>/environ` only to the same uid and only while that git process
 * runs (known limit: the workspace user IS that uid). Nothing is written to
 * disk.
 *
 * The workspace's own git configuration is attacker-controlled (any command
 * in the workspace can write `.git/config`, `.git/info/attributes` and
 * `~/.gitconfig`). So no git process that carries the token may read it:
 *   - /clone clones with `--no-checkout` under the token and global/system
 *     config disabled (the new repo's config is git's own), then checks out
 *     in a second process WITHOUT any credential in the env;
 *   - /pull fetches through a throw-away git dir with a clean config that
 *     writes straight into the workspace's object store, then fast-forwards
 *     in the workspace in a second process WITHOUT any credential.
 * Filters, hooks, uploadpack, askpass, proxies or insteadOf planted in the
 * workspace therefore never run next to the token.
 */
const GIT_CREDENTIAL_HELPER = path.join(__dirname, 'git-credential-dg.sh');
const GIT_CREDENTIAL_MAX_LEN = 4096;
// Test-only escape hatch: lets the checks use a local plain-http git server.
// Never set in production; without it credentials only ever go over https.
const GIT_ALLOW_HTTP = process.env.DG_GIT_ALLOW_HTTP === '1';
const GIT_REF_PATTERN = /^refs\/heads\/[A-Za-z0-9._/-]{1,200}$/;

function shellSingleQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * `-c` options for the one git process that carries a credential. The empty
 * `credential.helper=` resets every helper configured so far before our
 * env-only helper is added; only https (plus http in test mode) is allowed as
 * a transport, so `ext::`, `file://`, ssh and friends cannot be reached
 * through a rewritten URL.
 */
function gitCredentialArgs({ allowHttp }) {
  return [
    '-c', 'protocol.allow=never',
    '-c', 'protocol.https.allow=always',
    ...(allowHttp ? ['-c', 'protocol.http.allow=always'] : []),
    '-c', 'credential.helper=',
    '-c', `credential.helper=!${shellSingleQuote(GIT_CREDENTIAL_HELPER)}`,
    '-c', 'core.askPass=',
    '-c', 'core.sshCommand=',
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false',
    '-c', 'http.proxy=',
    '-c', 'http.sslVerify=true',
    '-c', 'gc.auto=0',
    '-c', 'maintenance.auto=false',
    '-c', 'fetch.writeCommitGraph=false',
  ];
}

/** Env for that process: no global/system config, plus the one credential. */
function gitCredentialEnv(credentials) {
  return {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    ...(GIT_ALLOW_HTTP ? { DG_GIT_ALLOW_HTTP: '1' } : {}),
    ...(credentials ? {
      DG_GIT_HOST: credentials.host,
      DG_GIT_USERNAME: credentials.username || 'oauth2',
      DG_GIT_PASSWORD: credentials.password,
    } : {}),
  };
}

/** True for a string git's credential protocol can carry (no NUL/CR/LF). */
function isCredentialValue(value, maxLen) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLen && !/[\0\r\n]/.test(value);
}

/** May a credential for `host` be sent to `url`? Only https on that host. */
function credentialTransportOk(url, host) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const protocolOk = parsed.protocol === 'https:' || (GIT_ALLOW_HTTP && parsed.protocol === 'http:');
  return protocolOk && parsed.host === host && !parsed.username && !parsed.password;
}

/**
 * Splits userinfo off an http(s) URL. Returns `{ url, credentials }` with
 * `credentials = { host, username, password }` when the URL carried any, else
 * `credentials = null` and the URL unchanged. Non-URLs come back unchanged.
 */
function splitUrlCredentials(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { url: rawUrl, credentials: null };
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || (!parsed.username && !parsed.password)) {
    return { url: rawUrl, credentials: null };
  }
  const decode = (s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  };
  const credentials = { host: parsed.host, username: decode(parsed.username), password: decode(parsed.password) };
  parsed.username = '';
  parsed.password = '';
  return { url: parsed.toString(), credentials };
}

/** Validates `{ username, password }` (+ `host` when `withHost`) from a body. */
function parseAuth(auth, { withHost }) {
  if (auth === undefined || auth === null) return { auth: null };
  if (typeof auth !== 'object'
    || !isCredentialValue(auth.username, 256)
    || !isCredentialValue(auth.password, GIT_CREDENTIAL_MAX_LEN)
    || (withHost && !isCredentialValue(auth.host, 256))) {
    return { error: `auth must be { username, password${withHost ? ', host' : ''} } as non-empty single-line strings` };
  }
  return { auth: { username: auth.username, password: auth.password, ...(withHost ? { host: auth.host } : {}) } };
}

/**
 * Masks credentials in git output before it leaves the sidecar: userinfo of
 * any URL plus every known secret value verbatim (raw and URL-encoded).
 */
function redactGitOutput(text, secrets) {
  let out = String(text).replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"]*@/gi, '$1***@');
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 4) continue;
    for (const form of new Set([secret, encodeURIComponent(secret)])) {
      out = out.split(form).join('***');
    }
  }
  return out;
}

function redactResult(result, secrets) {
  return { ...result, stdout: redactGitOutput(result.stdout, secrets), stderr: redactGitOutput(result.stderr, secrets) };
}

/** Concatenates two process results; the first failure decides the outcome. */
function joinResults(first, second) {
  return {
    ...second,
    stdout: `${first.stdout}${second.stdout}`,
    stderr: `${first.stderr}${second.stderr}`,
    truncated: first.truncated || second.truncated,
  };
}

/**
 * Rewrites every remote URL/pushurl of the repo at `root` that embeds
 * credentials to its credential-free form (legacy workspaces cloned before
 * T-541). Returns the removed credentials keyed by config key so a caller
 * can still use them for the current operation.
 */
async function scrubRemoteCredentials(root) {
  // -z: entries end in NUL, key and value are split by the first newline —
  // remote names may contain spaces.
  const list = await runProcess('git', ['config', '-z', '--local', '--get-regexp', '^remote\\..*\\.(url|pushurl)$'], { cwd: root, timeoutMs: 30_000 });
  // Exit code 1 = no remote configured.
  if (list.exitCode !== 0) return [];
  const removed = [];
  for (const entry of list.stdout.split('\0')) {
    const sep = entry.indexOf('\n');
    if (sep < 0) continue;
    const key = entry.slice(0, sep);
    const value = entry.slice(sep + 1);
    const { url, credentials } = splitUrlCredentials(value);
    if (!credentials) continue;
    const r = await runProcess('git', ['config', '--local', '--fixed-value', '--replace-all', key, url, value], { cwd: root, timeoutMs: 30_000 });
    if (r.exitCode !== 0) {
      // Never echo `value` — it holds the token.
      console.error(JSON.stringify({ type: 'git-credential-scrub-failed', key, exitCode: r.exitCode }));
      continue;
    }
    removed.push({ key, credentials });
  }
  return removed;
}

/** `remote.origin.url` after scrubbing, or null. */
async function originUrl(root) {
  const r = await runProcess('git', ['config', '--local', '--get', 'remote.origin.url'], { cwd: root, timeoutMs: 30_000 });
  const url = r.stdout.trim();
  return r.exitCode === 0 && url ? url : null;
}

/** Trimmed stdout of a plain (credential-free) git call, or null on failure. */
async function gitValue(root, args) {
  const r = await runProcess('git', args, { cwd: root, timeoutMs: 30_000 });
  const out = r.stdout.trim();
  return r.exitCode === 0 && out ? out : null;
}

/**
 * Authenticated pull without exposing the token to the workspace's git
 * config. Step 1 fetches the upstream branch through a fresh git dir in
 * /tmp — clean config, no hooks, no attributes — whose object directory is
 * the workspace's, so the objects land where they belong and the workspace's
 * shallow boundary is honoured. Step 2 fast-forwards the workspace in a plain
 * process without any credential. Returns a runProcess-like result or
 * `{ error, status }` for a precondition failure.
 */
async function authenticatedPull(root, url, credentials) {
  const gitDir = path.join(root, '.git');
  const objectsDir = path.join(gitDir, 'objects');
  if (!fs.statSync(gitDir).isDirectory() || !fs.existsSync(objectsDir)) {
    return { status: 409, error: 'workspace .git must be a plain git directory' };
  }
  const branch = await gitValue(root, ['symbolic-ref', '-q', '--short', 'HEAD']);
  if (!branch) return { status: 409, error: 'workspace is not on a branch' };
  const mergeRef = (await gitValue(root, ['config', '--get', `branch.${branch}.merge`])) || `refs/heads/${branch}`;
  if (!GIT_REF_PATTERN.test(mergeRef)) return { status: 409, error: 'upstream branch has an unsupported name' };
  const head = await gitValue(root, ['rev-parse', '-q', '--verify', 'HEAD^{commit}']);

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dg-fetch-'));
  try {
    const plainTmpEnv = { ...gitCredentialEnv(null), GIT_DIR: tmp, GIT_OBJECT_DIRECTORY: objectsDir };
    const init = await runProcess('git', ['init', '-q', '--bare', '--template=', tmp], { env: gitCredentialEnv(null), timeoutMs: 30_000 });
    if (init.exitCode !== 0) return init;
    const shallowFile = path.join(gitDir, 'shallow');
    const hadShallow = fs.existsSync(shallowFile);
    if (hadShallow) await fsp.copyFile(shallowFile, path.join(tmp, 'shallow'));
    // Tell the server what we already have, so only new objects travel.
    if (head) {
      const have = await runProcess('git', ['update-ref', 'refs/dg/have', head], { cwd: tmp, env: plainTmpEnv, timeoutMs: 30_000 });
      if (have.exitCode !== 0) return have;
    }
    const fetch = await runProcess('git', [
      ...gitCredentialArgs({ allowHttp: GIT_ALLOW_HTTP }),
      'fetch', '--no-tags', '--no-auto-gc', '--', url, `+${mergeRef}:refs/dg/fetched`,
    ], {
      cwd: tmp,
      env: { ...plainTmpEnv, ...gitCredentialEnv(credentials) },
      timeoutMs: GIT_TIMEOUT_MS,
    });
    if (fetch.exitCode !== 0) return fetch;
    const fetched = await runProcess('git', ['rev-parse', '--verify', 'refs/dg/fetched^{commit}'], { cwd: tmp, env: plainTmpEnv, timeoutMs: 30_000 });
    const sha = fetched.stdout.trim();
    if (fetched.exitCode !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) return joinResults(fetch, fetched);
    // The fetch may have moved the shallow boundary; carry that back.
    const tmpShallow = path.join(tmp, 'shallow');
    if (fs.existsSync(tmpShallow)) await fsp.copyFile(tmpShallow, shallowFile);
    else if (hadShallow) await fsp.rm(shallowFile, { force: true });

    // Step 2: everything that touches the worktree (and so may run filters
    // or hooks from the workspace's config) runs without any credential.
    const tracking = `refs/remotes/origin/${mergeRef.slice('refs/heads/'.length)}`;
    await runProcess('git', ['update-ref', tracking, sha], { cwd: root, timeoutMs: 30_000 });
    const merge = await runProcess('git', ['merge', '--ff-only', sha], { cwd: root, timeoutMs: GIT_TIMEOUT_MS });
    return joinResults(fetch, merge);
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

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
  const parsedAuth = parseAuth(req.body?.auth, { withHost: false });
  if (parsedAuth.error) return res.status(400).json({ error: parsedAuth.error });
  let cloneHost;
  try {
    cloneHost = new URL(repoUrl).host;
  } catch {
    return res.status(400).json({ error: 'repoUrl is not a valid URL' });
  }
  // Credentials in the URL itself (typed by a user) win over the backend's
  // `auth`, as before; either way the URL git stores is the plain one.
  const split = splitUrlCredentials(repoUrl);
  let credentials = split.credentials;
  if (!credentials && parsedAuth.auth) credentials = { host: cloneHost, ...parsedAuth.auth };
  if (credentials && !credentialTransportOk(split.url, credentials.host)) {
    return res.status(400).json({ error: 'credentials are only sent over https' });
  }
  const secrets = [credentials?.password];

  const root = await ensureWorkspaceDir(id);
  const dotGit = path.join(root, '.git');
  if (fs.existsSync(dotGit)) {
    return res.status(409).json({ error: 'workspace already contains a git repository — use /pull' });
  }
  // Step 1 (with credential): objects and refs only, no checkout, no
  // global/system config.
  const args = [...gitCredentialArgs({ allowHttp: !credentials || GIT_ALLOW_HTTP }), 'clone', '--no-checkout', '--depth', '1'];
  if (branch) args.push('--branch', branch);
  args.push('--', split.url, root);
  const clone = await runProcess('git', args, { timeoutMs: GIT_TIMEOUT_MS, env: gitCredentialEnv(credentials) });
  if (clone.exitCode !== 0) {
    return res.status(500).json({ error: 'git clone failed', ...redactResult(clone, secrets) });
  }
  // Step 2 (no credential): populate the worktree. An empty repository has
  // no HEAD commit and nothing to check out.
  let result = clone;
  if (await gitValue(root, ['rev-parse', '-q', '--verify', 'HEAD^{commit}'])) {
    result = joinResults(clone, await runProcess('git', ['checkout', '-f', '-q'], { cwd: root, timeoutMs: GIT_TIMEOUT_MS }));
  }
  result = redactResult(result, secrets);
  if (result.exitCode !== 0) {
    return res.status(500).json({ error: 'git checkout failed', ...result });
  }
  res.json({ ok: true, ...result });
});

/**
 * Credential-free `origin` URL of a workspace (legacy token URLs are scrubbed
 * first). The backend resolves the matching token against it and passes the
 * result back to /pull bound to that host.
 */
app.post('/origin', async (req, res) => {
  const id = requireWorkspaceId(req, res); if (!id) return;
  const root = workspaceRoot(id);
  if (!fs.existsSync(path.join(root, '.git'))) {
    return res.status(409).json({ error: 'workspace contains no git repository' });
  }
  await scrubRemoteCredentials(root);
  res.json({ url: await originUrl(root) });
});

app.post('/pull', async (req, res) => {
  const id = requireWorkspaceId(req, res); if (!id) return;
  const parsedAuth = parseAuth(req.body?.auth, { withHost: true });
  if (parsedAuth.error) return res.status(400).json({ error: parsedAuth.error });
  if (!await workspaceExists(id)) {
    return res.status(404).json({ error: 'workspace directory does not exist' });
  }
  const root = workspaceRoot(id);
  if (!fs.existsSync(path.join(root, '.git'))) {
    return res.status(409).json({ error: 'workspace contains no git repository' });
  }
  // Legacy clone with the token in `origin`: clean the config first, but keep
  // using that token for this pull so the workspace does not break.
  const removed = await scrubRemoteCredentials(root);
  const legacy = removed.find((r) => r.key === 'remote.origin.url');
  const url = await originUrl(root);
  const secrets = [...removed.map((r) => r.credentials.password), parsedAuth.auth?.password];
  // A credential only goes to the host it was resolved for, over https.
  const candidates = [legacy?.credentials, parsedAuth.auth].filter(Boolean);
  const credentials = url ? candidates.find((c) => credentialTransportOk(url, c.host)) : undefined;

  let result;
  if (credentials) {
    result = await authenticatedPull(root, url, credentials);
    if (result.error) return res.status(result.status).json({ error: result.error });
  } else {
    // No credential involved: nothing to steal, plain pull as always.
    result = await runProcess('git', ['pull', '--ff-only'], { cwd: root, timeoutMs: GIT_TIMEOUT_MS });
  }
  result = redactResult(result, secrets);
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
  const { limit, error: limitError } = effectiveLimit(req.body?.maxBytes, READ_MAX_BYTES, READ_HARD_MAX_BYTES);
  if (limitError) return res.status(400).json({ error: limitError });
  try {
    const target = await resolveInsideWorkspace(id, requested);
    const stat = await fsp.stat(target);
    if (!stat.isFile()) return res.status(400).json({ error: 'path is not a regular file' });
    if (stat.size > limit) {
      return res.status(413).json({ error: `file too large (>${limit} bytes)`, size: stat.size, limit });
    }
    const buf = await fsp.readFile(target);
    if (req.body?.strictText === true && !isStrictUtf8Text(buf)) {
      return res.status(415).json({ error: 'not utf-8 text', size: stat.size });
    }
    res.json({ size: stat.size, content: buf.toString('utf8'), hash: sha256Hex(buf) });
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
  const { limit, error: limitError } = effectiveLimit(req.body?.maxBytes, STREAM_MAX_BYTES, STREAM_HARD_MAX_BYTES);
  if (limitError) return res.status(400).json({ error: limitError });
  let target;
  try {
    target = await resolveInsideWorkspace(id, requested);
    const stat = await fsp.stat(target);
    if (!stat.isFile()) return res.status(400).json({ error: 'path is not a regular file' });
    if (stat.size > limit) {
      return res.status(413).json({ error: `file too large (>${limit} bytes)`, size: stat.size, limit });
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(stat.size));
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'file not found' });
    return res.status(400).json({ error: err.message });
  }
  const stream = fs.createReadStream(target);
  // Abort the read if the client disconnects mid-stream. On `res`, not on
  // `req`: since Node 16 the request's 'close' fires as soon as its (small
  // JSON) body has been read — before this listener is even attached. An
  // aborted download kept the file handle and stream open until the process
  // exited. After a complete send, destroy() is a no-op.
  res.on('close', () => { try { stream.destroy(); } catch { /* noop */ } });
  stream.on('error', (err) => {
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.destroy(err);
  });
  stream.pipe(res);
});

/** A single file name — no path separator, not `.`/`..`, no NUL. */
function isPlainFileName(name) {
  return typeof name === 'string'
    && name.length > 0
    && name.length <= 255
    && name !== '.'
    && name !== '..'
    && !name.includes('/')
    && !name.includes('\0');
}

function isInside(root, candidate) {
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  return candidate === root || candidate.startsWith(rootWithSep);
}

/**
 * Resolves the final path of a file about to be written inside `root` (the
 * realpath of the workspace root) and verifies its parent directory stays
 * inside it. `requested` is relative to `root` or absolute. Throws an Error
 * carrying `.status` (400 escape/invalid, 404 missing parent directory,
 * 409 target is a directory — `.code === 'TARGET_IS_DIR'`).
 *
 * Symlinks: the parent is resolved with realpath(); rename() replaces a
 * symlink at the target itself instead of following it.
 */
async function resolveWriteTarget(root, requested, { createDirs = false } = {}) {
  const fail = (status, message, code) => Object.assign(new Error(message), { status, code });
  if (typeof requested !== 'string' || !requested || requested.includes('\0')) {
    throw fail(400, 'path must be a non-empty string');
  }
  const target = path.resolve(root, requested);
  if (!isInside(root, target) || target === root) throw fail(400, 'path escapes workspace root');
  const base = path.basename(target);
  let parent = path.dirname(target);
  try {
    if (createDirs) {
      // mkdir -p follows symlinks in intermediate components and thereby
      // created directories OUTSIDE the workspace (`evil -> /tmp`,
      // `evil/new/x`) before any later check could catch it. So resolve and
      // check the deepest existing ancestor first; whatever mkdir creates
      // below it is created by mkdir itself and cannot be a symlink.
      let existing = parent;
      for (;;) {
        try {
          await fsp.lstat(existing);
          break;
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
          existing = path.dirname(existing);
        }
      }
      if (!isInside(root, await fsp.realpath(existing))) {
        throw fail(400, 'resolved path escapes workspace root');
      }
      await fsp.mkdir(parent, { recursive: true });
    }
    parent = await fsp.realpath(parent);
  } catch (err) {
    if (err.status) throw err;
    if (err.code === 'ENOENT') throw fail(404, 'target directory does not exist (use --mkdir)');
    throw fail(400, err.message);
  }
  if (!isInside(root, parent)) throw fail(400, 'resolved path escapes workspace root');
  const finalPath = path.join(parent, base);
  try {
    if ((await fsp.lstat(finalPath)).isDirectory()) throw fail(409, 'target is a directory', 'TARGET_IS_DIR');
  } catch (err) {
    if (err.status) throw err;
    if (err.code !== 'ENOENT') throw fail(400, err.message);
  }
  return { finalPath, parent };
}

/**
 * Counterpart of /read-stream (`dg scp host:… ./…`): the request body is the
 * file itself (application/octet-stream); parameters come via the query
 * because the body is not JSON. The file is written to a temporary file in
 * the target directory and only renamed into place once fully received — an
 * aborted transfer leaves no partial file and overwrites nothing.
 *
 * Query:
 *   workspaceId   as everywhere
 *   path          target relative to the workspace root; if it ends in `/`
 *                 or is an existing directory, `fileName` is appended
 *   fileName      file name for directory targets (basename of the source)
 *   size          expected length — a mismatch discards the upload
 *   mode          file permissions as a decimal number (default 0o644)
 *   createDirs    "1" creates missing parent directories
 *
 * Symlinks: the parent directory is resolved with realpath() and must be
 * inside the workspace root; rename() replaces a symlink at the target
 * itself instead of following it.
 */
app.post('/write-stream', async (req, res) => {
  const q = req.query || {};
  const id = typeof q.workspaceId === 'string' && WORKSPACE_ID_PATTERN.test(q.workspaceId) ? q.workspaceId : null;
  if (!id) return res.status(400).json({ error: 'workspaceId must be a slug-compatible string' });
  const requested = q.path;
  if (typeof requested !== 'string' || !requested || requested.includes('\0')) {
    return res.status(400).json({ error: 'path must be a non-empty string' });
  }
  const fileName = q.fileName;
  if (fileName !== undefined && !isPlainFileName(fileName)) {
    return res.status(400).json({ error: 'fileName must be a plain file name' });
  }
  let expectedSize;
  if (q.size !== undefined) {
    if (typeof q.size !== 'string' || !/^\d+$/.test(q.size)) return res.status(400).json({ error: 'size must be a non-negative integer' });
    expectedSize = Number(q.size);
    if (expectedSize > STREAM_MAX_BYTES) {
      return res.status(413).json({ error: `file too large (>${STREAM_MAX_BYTES} bytes)`, size: expectedSize });
    }
  }
  let mode = 0o644;
  if (q.mode !== undefined) {
    if (typeof q.mode !== 'string' || !/^\d+$/.test(q.mode) || Number(q.mode) > 0o777) {
      return res.status(400).json({ error: 'mode must be an integer between 0 and 511' });
    }
    mode = Number(q.mode);
  }
  const createDirs = q.createDirs === '1';
  const noOverwrite = q.noOverwrite === '1';

  if (!await workspaceExists(id)) {
    return res.status(404).json({ error: 'workspace directory does not exist' });
  }
  let root;
  try {
    root = await fsp.realpath(workspaceRoot(id));
  } catch {
    // Deleted between workspaceExists and here (cleanup race).
    return res.status(404).json({ error: 'workspace directory does not exist' });
  }

  let target;
  try {
    target = path.resolve(root, requested);
    if (!isInside(root, target)) throw new Error('path escapes workspace root');
    let isDirTarget = requested.endsWith('/') || target === root;
    if (!isDirTarget) {
      try {
        isDirTarget = (await fsp.stat(target)).isDirectory();
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
    if (isDirTarget) {
      if (!fileName) throw new Error('path is a directory and no fileName was given');
      target = path.join(target, fileName);
    }
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  let finalPath, parent;
  try {
    ({ finalPath, parent } = await resolveWriteTarget(root, target, { createDirs }));
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  if (noOverwrite) {
    // Early rejection before the body is consumed; the link() below stays the
    // authoritative check for races.
    try {
      await fsp.lstat(finalPath);
      // Discard the unread body so the client gets the 409 instead of a reset.
      req.resume();
      return res.status(409).json({ error: 'target exists' });
    } catch (err) {
      if (err.code !== 'ENOENT') return res.status(400).json({ error: err.message });
    }
  }
  const base = path.basename(finalPath);
  const tmpPath = path.join(parent, `.${base}.${crypto.randomBytes(6).toString('hex')}.part`);
  const out = fs.createWriteStream(tmpPath, { flags: 'wx', mode });
  let received = 0;
  let failed = false;
  const fail = (status, message) => {
    if (failed) return;
    failed = true;
    req.unpipe(out);
    // Delete only after 'close': a still-pending open('wx') could otherwise
    // create the file after rm() and leave a .part file behind.
    out.once('close', () => { fsp.rm(tmpPath, { force: true }).catch(() => undefined); });
    out.destroy();
    if (!res.headersSent) res.status(status).json({ error: message });
    // Stop reading the rest of the body — the peer should abort.
    req.destroy();
  };

  req.on('data', (chunk) => {
    received += chunk.length;
    if (received > STREAM_MAX_BYTES) fail(413, `file too large (>${STREAM_MAX_BYTES} bytes)`);
  });
  req.on('aborted', () => fail(499, 'client aborted upload'));
  req.on('error', (err) => fail(400, err.message));
  out.on('error', (err) => fail(err.code === 'ENOSPC' ? 507 : 500, err.message));
  out.on('finish', async () => {
    if (failed) return;
    if (expectedSize !== undefined && received !== expectedSize) {
      return fail(400, `incomplete transfer: received ${received} of ${expectedSize} bytes`);
    }
    try {
      // `mode` from open() is subject to the umask; chmod sets it exactly.
      await fsp.chmod(tmpPath, mode);
      if (noOverwrite) {
        // link() fails with EEXIST instead of replacing an existing target,
        // even if it appeared after the early check above.
        try {
          await fsp.link(tmpPath, finalPath);
        } catch (err) {
          await fsp.rm(tmpPath, { force: true }).catch(() => undefined);
          return err.code === 'EEXIST' ? fail(409, 'target exists') : fail(500, err.message);
        }
        await fsp.unlink(tmpPath);
      } else {
        await fsp.rename(tmpPath, finalPath);
      }
    } catch (err) {
      return fail(500, err.message);
    }
    res.json({ ok: true, path: path.relative(root, finalPath), size: received });
  });
  req.pipe(out);
});

/**
 * Text write with optimistic conflict detection. `baseHash` is the sha256 of
 * the content the caller last saw (`null` = "the file must not exist yet").
 * A mismatch answers 409 with the current hash unless `force` is set. The
 * check and the rename are not one atomic step; the window is small and the
 * temp-file + rename keeps the file itself always consistent.
 */
app.post('/write', async (req, res) => {
  const id = requireWorkspaceId(req, res); if (!id) return;
  const { path: requested, content, baseHash, force, createDirs } = req.body || {};
  if (typeof requested !== 'string' || !requested || requested.includes('\0')) {
    return res.status(400).json({ error: 'path must be a non-empty string' });
  }
  if (typeof content !== 'string') return res.status(400).json({ error: 'content must be a string' });
  if (baseHash !== null && typeof baseHash !== 'string') {
    return res.status(400).json({ error: 'baseHash must be a string or null' });
  }
  const { limit, error: limitError } = effectiveLimit(req.body?.maxBytes, READ_MAX_BYTES, READ_HARD_MAX_BYTES);
  if (limitError) return res.status(400).json({ error: limitError });
  const data = Buffer.from(content, 'utf8');
  if (data.length > limit) {
    return res.status(413).json({ error: `content too large (>${limit} bytes)`, size: data.length, limit });
  }
  if (!await workspaceExists(id)) {
    return res.status(404).json({ error: 'workspace directory does not exist' });
  }
  let root;
  try {
    root = await fsp.realpath(workspaceRoot(id));
  } catch {
    return res.status(404).json({ error: 'workspace directory does not exist' });
  }

  let finalPath, parent;
  try {
    ({ finalPath, parent } = await resolveWriteTarget(root, requested, { createDirs: createDirs === true }));
  } catch (err) {
    const status = err.code === 'TARGET_IS_DIR' ? 400 : (err.status || 400);
    return res.status(status).json({ error: err.message });
  }

  // /read follows a symlink, so /write must too: rename() over the link
  // would turn it into a regular file and never update the real target.
  // Write to the link's resolved location instead, but only inside the root.
  let writePath;
  try {
    ({ writePath, parent } = await resolveSymlinkWriteTarget(root, finalPath, parent));
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }

  let currentHash = null;
  let mode = 0o644;
  try {
    const st = await fsp.stat(writePath);
    if (!st.isFile()) return res.status(400).json({ error: 'path is not a regular file' });
    mode = st.mode & 0o777;
    currentHash = sha256Hex(await fsp.readFile(writePath));
  } catch (err) {
    if (err.code !== 'ENOENT') return res.status(400).json({ error: err.message });
  }
  if (force !== true && baseHash !== currentHash) {
    return res.status(409).json({ error: 'conflict', currentHash });
  }

  const tmpPath = path.join(parent, `.${path.basename(writePath)}.${crypto.randomBytes(6).toString('hex')}.part`);
  try {
    await fsp.writeFile(tmpPath, data, { flag: 'wx', mode });
    // writeFile's mode is subject to the umask; chmod sets it exactly.
    await fsp.chmod(tmpPath, mode);
    await fsp.rename(tmpPath, writePath);
  } catch (err) {
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
    return res.status(500).json({ error: err.message });
  }
  res.json({ ok: true, path: path.relative(root, finalPath), hash: sha256Hex(data), size: data.length });
});

/**
 * For /write: if `finalPath` is a symlink, returns the location the link
 * resolves to (and its real parent directory) so the write updates the
 * target instead of replacing the link. Throws an Error with `.status` 400
 * when the target lies outside `root` (also for a dangling link), 404 when a
 * dangling link points into a missing directory. Non-links pass unchanged.
 */
async function resolveSymlinkWriteTarget(root, finalPath, parent) {
  const fail = (status, message) => Object.assign(new Error(message), { status });
  let st;
  try {
    st = await fsp.lstat(finalPath);
  } catch (err) {
    if (err.code === 'ENOENT') return { writePath: finalPath, parent };
    throw fail(400, err.message);
  }
  if (!st.isSymbolicLink()) return { writePath: finalPath, parent };
  try {
    const real = await fsp.realpath(finalPath);
    if (!isInside(root, real) || real === root) throw fail(400, 'resolved path escapes workspace root');
    return { writePath: real, parent: path.dirname(real) };
  } catch (err) {
    if (err.status) throw err;
    if (err.code !== 'ENOENT') throw fail(400, err.message);
  }
  // Dangling link: follow the chain by hand to the first missing component.
  let cur = finalPath;
  for (let hops = 0; hops < 40; hops += 1) {
    const next = path.resolve(path.dirname(cur), await fsp.readlink(cur));
    let nextStat;
    try {
      nextStat = await fsp.lstat(next);
    } catch (err) {
      if (err.code !== 'ENOENT') throw fail(400, err.message);
      let realParent;
      try {
        realParent = await fsp.realpath(path.dirname(next));
      } catch (e) {
        // A missing directory outside the root is still an escape.
        if (!isInside(root, path.dirname(next))) throw fail(400, 'resolved path escapes workspace root');
        if (e.code === 'ENOENT' || e.code === 'ENOTDIR') throw fail(404, 'symlink target directory does not exist');
        throw fail(400, e.message);
      }
      if (!isInside(root, realParent)) throw fail(400, 'resolved path escapes workspace root');
      return { writePath: path.join(realParent, path.basename(next)), parent: realParent };
    }
    if (!nextStat.isSymbolicLink()) throw fail(400, 'cannot resolve symlink');
    cur = next;
  }
  throw fail(400, 'too many levels of symbolic links');
}

/** Real path of an existing workspace root, or null (response already sent). */
async function realWorkspaceRoot(id, res) {
  if (!await workspaceExists(id)) {
    res.status(404).json({ error: 'workspace directory does not exist' });
    return null;
  }
  try {
    return await fsp.realpath(workspaceRoot(id));
  } catch {
    res.status(404).json({ error: 'workspace directory does not exist' });
    return null;
  }
}

const isGitPath = (root, absPath) => path.relative(root, absPath).split(path.sep)[0] === '.git';

/**
 * Resolves an EXISTING entry for delete/move-source without following the
 * entry itself: only the parent directory is resolved with realpath() and
 * must stay inside the workspace, so a symlink is addressed as a link and a
 * path through an outside-pointing symlink directory is rejected. Throws an
 * Error carrying `.status` (400 invalid/root/.git, 404 missing).
 */
async function resolveExistingEntry(root, requested) {
  const fail = (status, message) => Object.assign(new Error(message), { status });
  if (typeof requested !== 'string' || !requested || requested.includes('\0')) {
    throw fail(400, 'path must be a non-empty string');
  }
  const target = path.resolve(root, requested);
  if (!isInside(root, target)) throw fail(400, 'path escapes workspace root');
  if (target === root) throw fail(400, 'the workspace root cannot be modified');
  let parent;
  try {
    parent = await fsp.realpath(path.dirname(target));
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') throw fail(404, 'not found');
    throw fail(400, err.message);
  }
  if (!isInside(root, parent)) throw fail(400, 'resolved path escapes workspace root');
  const entryPath = path.join(parent, path.basename(target));
  if (entryPath === root) throw fail(400, 'the workspace root cannot be modified');
  if (isGitPath(root, entryPath)) throw fail(400, '.git cannot be modified');
  let stat;
  try {
    stat = await fsp.lstat(entryPath);
  } catch (err) {
    if (err.code === 'ENOENT') throw fail(404, 'not found');
    throw fail(400, err.message);
  }
  return { entryPath, stat };
}

app.post('/mkdir', async (req, res) => {
  const id = requireWorkspaceId(req, res); if (!id) return;
  const root = await realWorkspaceRoot(id, res); if (!root) return;
  try {
    const { finalPath } = await resolveWriteTarget(root, req.body?.path, { createDirs: true });
    try {
      await fsp.mkdir(finalPath);
    } catch (err) {
      if (err.code === 'EEXIST') return res.status(409).json({ error: 'already exists' });
      throw err;
    }
    res.json({ ok: true, path: path.relative(root, finalPath) });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

app.post('/move', async (req, res) => {
  const id = requireWorkspaceId(req, res); if (!id) return;
  const { from, to } = req.body || {};
  if (typeof to !== 'string' || !to || to.includes('\0')) {
    return res.status(400).json({ error: 'to must be a non-empty string' });
  }
  const root = await realWorkspaceRoot(id, res); if (!root) return;
  try {
    const source = await resolveExistingEntry(root, from);
    const isDir = source.stat.isDirectory();
    // Lexical checks first so a rejected request creates no directories.
    const lexicalTo = path.resolve(root, to);
    if (isGitPath(root, lexicalTo)) return res.status(400).json({ error: '.git cannot be modified' });
    const intoSelf = (candidate) => candidate === source.entryPath
      || candidate.startsWith(source.entryPath + path.sep);
    if (isDir && intoSelf(lexicalTo)) {
      return res.status(400).json({ error: 'cannot move a directory into itself' });
    }
    let finalPath;
    try {
      ({ finalPath } = await resolveWriteTarget(root, to, { createDirs: true }));
    } catch (err) {
      if (err.code === 'TARGET_IS_DIR') return res.status(409).json({ error: 'target exists' });
      throw err;
    }
    if (isGitPath(root, finalPath)) return res.status(400).json({ error: '.git cannot be modified' });
    if (isDir && intoSelf(finalPath)) {
      return res.status(400).json({ error: 'cannot move a directory into itself' });
    }
    try {
      await fsp.lstat(finalPath);
      return res.status(409).json({ error: 'target exists' });
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    if (isDir) {
      await fsp.rename(source.entryPath, finalPath);
    } else {
      // link() never replaces an existing target (rename() would); a symlink
      // is linked as a link, not followed.
      try {
        await fsp.link(source.entryPath, finalPath);
      } catch (err) {
        if (err.code === 'EEXIST') return res.status(409).json({ error: 'target exists' });
        throw err;
      }
      await fsp.unlink(source.entryPath);
    }
    res.json({ ok: true, from: path.relative(root, source.entryPath), to: path.relative(root, finalPath) });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

app.post('/delete', async (req, res) => {
  const id = requireWorkspaceId(req, res); if (!id) return;
  const root = await realWorkspaceRoot(id, res); if (!root) return;
  try {
    const { entryPath } = await resolveExistingEntry(root, req.body?.path);
    // rm() unlinks a symlink itself and does not descend into its target.
    await fsp.rm(entryPath, { recursive: true });
    res.json({ ok: true, path: path.relative(root, entryPath) });
  } catch (err) {
    res.status(err.status || (err.code === 'ENOENT' ? 404 : 400)).json({ error: err.message });
  }
});

app.post('/tree', async (req, res) => {
  const id = requireWorkspaceId(req, res); if (!id) return;
  const requested = typeof req.body?.path === 'string' ? req.body.path : '.';
  const depthInput = Number(req.body?.depth ?? DEFAULT_TREE_DEPTH);
  const depth = Math.min(MAX_TREE_DEPTH, Math.max(1, Number.isFinite(depthInput) ? Math.trunc(depthInput) : DEFAULT_TREE_DEPTH));

  const withSize = req.body?.withSize === true;
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
        const item = { path: rel, type: entry.isDirectory() ? 'dir' : entry.isSymbolicLink() ? 'symlink' : 'file' };
        if (withSize && item.type === 'file') {
          try {
            item.size = (await fsp.stat(full)).size;
          } catch { /* vanished between readdir and stat */ }
        }
        entries.push(item);
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

  const { fixedStrings, caseSensitive, json } = req.body || {};
  const args = json === true ? ['--json'] : ['--no-heading', '--line-number'];
  args.push('--max-count', '50', '--max-columns', '300');
  if (caseSensitive !== true) args.push('--ignore-case');
  if (fixedStrings === true) args.push('--fixed-strings');
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
  // Exit 2 is an error on rg's side, usually a regex the caller typed wrong:
  // answer 400 with rg's own first stderr line so the user can fix it.
  if (result.exitCode === 2 && !result.timedOut) {
    const firstLine = (result.stderr || '').split('\n').map((l) => l.trim()).find(Boolean) || 'invalid search';
    return res.status(400).json({ error: firstLine.slice(0, 300) });
  }
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    return res.status(500).json({ error: 'ripgrep failed', ...result });
  }
  res.json({ matches: result.stdout, truncated: result.truncated, timedOut: result.timedOut });
});

// Creates the (empty) workspace directory if it does not exist yet. A workspace
// without repoUrl has no directory until the first clone/exec; the IDE routes
// call this so a fresh workspace opens as an empty tree instead of a 404.
app.post('/ensure', async (req, res) => {
  const id = requireWorkspaceId(req, res); if (!id) return;
  try {
    await ensureWorkspaceDir(id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Running exec children per workspace (process group leaders), so a destroy
// can stop them before the directory goes away.
const execChildren = new Map();

function trackExecChild(workspaceId, child) {
  if (typeof workspaceId !== 'string' || !child.pid) return;
  let set = execChildren.get(workspaceId);
  if (!set) { set = new Set(); execChildren.set(workspaceId, set); }
  set.add(child);
  child.once('close', () => {
    set.delete(child);
    if (set.size === 0 && execChildren.get(workspaceId) === set) execChildren.delete(workspaceId);
  });
}

/** Stops terminals and running exec commands of a workspace (before its dir is removed). */
function stopWorkspaceProcesses(id) {
  const prefix = `ws:${id}:`;
  for (const [key, term] of activeTerminals) {
    if (!key.startsWith(prefix)) continue;
    try { term.ws.close(1001, 'workspace_destroyed'); } catch { /* socket dying */ }
    try { term.pty.kill(); } catch { /* already dead */ }
    activeTerminals.delete(key);
  }
  for (const child of execChildren.get(id) ?? []) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
  }
}

// Removes a workspace directory (delete of the workspace record).
// Never follows links: a symlinked root is unlinked, its target is left alone.
// Idempotent: a missing directory is `existed: false`, not an error.
async function destroyWorkspaceRoot(id) {
  const root = workspaceRoot(id);
  // Defense in depth: the id pattern has no separators or dots, but the
  // target must in any case be a direct child of the workspaces root.
  if (path.dirname(root) !== path.resolve(ROOT) || path.basename(root) !== id) {
    throw new Error('workspace path escapes the workspaces root');
  }
  let st;
  try {
    st = await fsp.lstat(root);
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
  stopWorkspaceProcesses(id);
  if (st.isSymbolicLink() || !st.isDirectory()) await fsp.unlink(root);
  else await fsp.rm(root, { recursive: true, force: true });
  await fsp.rm(cwdStatePath(id), { force: true }).catch(() => undefined);
  return true;
}

app.post('/destroy', async (req, res) => {
  const id = requireWorkspaceId(req, res); if (!id) return;
  try {
    const existed = await destroyWorkspaceRoot(id);
    res.json({ ok: true, existed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Only real workspace ids (24 hex) are ever considered orphans; other names
// in the root (scratch dirs such as `ptytest`) are never listed or touched.
const ORPHAN_ID_PATTERN = /^[a-f0-9]{24}$/;
// Directories touched more recently than this are never orphans: a record
// may have been created after the caller read its id list.
const ORPHAN_MIN_AGE_MS = positiveIntEnv('ORPHAN_MIN_AGE_MS', 10 * 60_000);

/** Total size in bytes of a tree, without following symlinks. */
async function treeBytes(dir) {
  let total = 0;
  let entries;
  try {
    // A symlinked root counts as the link itself, never as its target.
    if ((await fsp.lstat(dir)).isSymbolicLink()) return 0;
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += await treeBytes(abs);
      else total += (await fsp.lstat(abs)).size;
    } catch {
      // vanished while walking
    }
  }
  return total;
}

// Body: { knownIds, cutoffSec, delete?, deleteIds? }. A candidate is a 24-hex
// dir that is not known, whose ObjectId timestamp is <= cutoffSec (the caller
// reads its id list first and passes read time minus a margin) and whose
// mtime is older than ORPHAN_MIN_AGE_MS. Deleting additionally requires the
// id to be listed in `deleteIds` (what the dry run showed).
app.post('/orphans', async (req, res) => {
  const { knownIds: known, cutoffSec, deleteIds } = req.body ?? {};
  if (!Array.isArray(known) || known.some((k) => typeof k !== 'string')) {
    return res.status(400).json({ error: 'knownIds must be an array of strings' });
  }
  if (typeof cutoffSec !== 'number' || !Number.isFinite(cutoffSec) || cutoffSec < 0) {
    return res.status(400).json({ error: 'cutoffSec must be a non-negative number' });
  }
  if (req.body?.delete !== undefined && typeof req.body.delete !== 'boolean') {
    return res.status(400).json({ error: 'delete must be a boolean' });
  }
  const del = req.body?.delete === true;
  if (deleteIds !== undefined && (!Array.isArray(deleteIds) || deleteIds.some((k) => typeof k !== 'string'))) {
    return res.status(400).json({ error: 'deleteIds must be an array of strings' });
  }
  if (del && (!Array.isArray(deleteIds) || deleteIds.length === 0)) {
    return res.status(400).json({ error: 'delete requires a non-empty deleteIds list' });
  }
  const knownSet = new Set(known.map((k) => k.toLowerCase()));
  const wanted = new Set((deleteIds ?? []).map((k) => k.toLowerCase()));
  try {
    let names;
    try {
      names = await fsp.readdir(ROOT);
    } catch (err) {
      if (err.code === 'ENOENT') return res.json({ orphans: [], deleted: [], failed: [], skipped: [] });
      throw err;
    }
    const orphans = [];
    const deleted = [];
    const failed = [];
    const skipped = [];
    const now = Date.now();
    for (const name of names.sort()) {
      if (!ORPHAN_ID_PATTERN.test(name) || knownSet.has(name)) continue;
      try {
        if (parseInt(name.slice(0, 8), 16) > cutoffSec) { skipped.push({ id: name, reason: 'too_new' }); continue; }
        const st = await fsp.lstat(workspaceRoot(name));
        if (now - st.mtimeMs < ORPHAN_MIN_AGE_MS) { skipped.push({ id: name, reason: 'recent' }); continue; }
        orphans.push({ id: name, bytes: await treeBytes(workspaceRoot(name)) });
        if (del && wanted.has(name)) {
          await destroyWorkspaceRoot(name);
          deleted.push(name);
        }
      } catch (err) {
        failed.push({ id: name, error: err.message });
      }
    }
    res.json({ orphans, deleted, failed, skipped });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/status', async (req, res) => {
  const id = requireWorkspaceId(req, res); if (!id) return;
  const root = workspaceRoot(id);
  if (!fs.existsSync(path.join(root, '.git'))) {
    return res.status(409).json({ error: 'workspace contains no git repository' });
  }
  // The IDE polls /status, so legacy token URLs get cleaned without a pull.
  await scrubRemoteCredentials(root);
  const result = await runProcess('git', ['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '--branch'], { cwd: root, timeoutMs: 30_000 });
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
function runExec({ command, cwd, timeoutMs, env, workspaceId }) {
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', ['-lc', command], {
      cwd,
      env,
      detached: true,                  // own process group
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    trackExecChild(workspaceId, child);
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
 *
 * `fullOutput: true` drops the per-stream cap (the caller keeps head + tail
 * itself) and instead applies flow control: while more than
 * EXEC_STREAM_BUFFER_MAX bytes wait in `writable`, the child's pipes are
 * paused (the command blocks on output, it is not killed). A line longer than
 * EXEC_STREAM_LINE_MAX is sent in pieces; every piece but the last carries
 * `partial: true` (no newline follows it).
 */
function runExecStream({ command, cwd, timeoutMs, env, abortSignal, fullOutput = false, writable = null, workspaceId }, onEvent) {
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', ['-lc', command], {
      cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    trackExecChild(workspaceId, child);
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

    let paused = false;
    // Per stream: a multi-byte character split across chunks stays intact.
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    // A paused pipe never ends: let it flow again once the command is being stopped.
    const releasePause = () => {
      if (!paused) return;
      paused = false;
      child.stdout.resume();
      child.stderr.resume();
    };
    const applyBackpressure = () => {
      if (paused || !writable || writable.writableLength <= EXEC_STREAM_BUFFER_MAX) return;
      paused = true;
      child.stdout.pause();
      child.stderr.pause();
      writable.once('drain', releasePause);
    };
    // Registered once per request (not per pause): a client gone mid-pause lets the pipes drain.
    if (fullOutput && writable) writable.once('close', releasePause);
    const fullEmitter = (stream) => (chunk) => {
      const text = decoders[stream].write(chunk);
      if (stream === 'stdout') stdoutBytes += chunk.length; else stderrBytes += chunk.length;
      let buf = stream === 'stdout' ? stdoutBuf + text : stderrBuf + text;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        onEvent({ type: stream, line: buf.slice(0, nl) });
        buf = buf.slice(nl + 1);
      }
      while (buf.length > EXEC_STREAM_LINE_MAX) {
        // `partial`: a piece of a longer line, no newline follows it.
        onEvent({ type: stream, line: buf.slice(0, EXEC_STREAM_LINE_MAX), partial: true });
        buf = buf.slice(EXEC_STREAM_LINE_MAX);
      }
      if (stream === 'stdout') stdoutBuf = buf; else stderrBuf = buf;
      applyBackpressure();
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
    const emitter = fullOutput ? fullEmitter : lineEmitter;
    child.stdout.on('data', emitter('stdout'));
    child.stderr.on('data', emitter('stderr'));

    const softTimer = setTimeout(() => {
      timedOut = true;
      killReason = 'timeout';
      releasePause();
      killPg('SIGTERM');
    }, timeoutMs);
    const hardTimer = setTimeout(() => killPg('SIGKILL'), timeoutMs + 5_000);

    const onAbort = () => {
      if (killReason) return;
      killReason = 'abort';
      releasePause();
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
      if (writable) writable.off('close', releasePause);
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

  const result = await runExec({ command: wrappedCommand, cwd, timeoutMs, env, workspaceId: id });
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
  // Client abort: on `res` and BEFORE any await. For a POST, the request's
  // 'close' already fires once express.json has read the body — the former
  // listener never saw the event, and an aborted stream left the command
  // running until its timeout. `writableFinished` tells a dropped connection
  // apart from our own res.end().
  const abort = new AbortController();
  res.on('close', () => { if (!res.writableFinished) abort.abort(); });
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


  const startedAt = Date.now();
  const env = buildExecEnv(req.body?.env);

  // Wrap the command so cd persists across calls (see wrapWithCwdState).
  // `cwdState: false` (strict boolean; anything else keeps the default) opts
  // out: the command starts in the workspace root and its cd is not written
  // back, so a caller (IDE agent) neither inherits nor moves the cwd shared
  // by the terminal and workspace_exec.
  const useCwdState = req.body?.cwdState !== false;
  const startCwd = useCwdState ? ((await readCwdState(id)) || cwd) : cwd;
  const wrappedCommand = useCwdState ? wrapWithCwdState(command, startCwd, cwdStatePath(id), cwd) : command;

  let lastEvent = null;
  // `fullOutput: true` (strict boolean): no 1 MiB cap, flow control instead.
  const fullOutput = req.body?.fullOutput === true;
  await runExecStream({ command: wrappedCommand, cwd, timeoutMs, env, abortSignal: abort.signal, fullOutput, writable: res, workspaceId: id }, (ev) => {
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
  const newCwd = useCwdState ? ((await readCwdState(id)) || cwd) : cwd;
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
  try {
    // Shares destroyWorkspaceRoot: a symlinked root is only unlinked, and the
    // per-workspace cwd state goes with it.
    res.json({ ok: true, removed: await destroyWorkspaceRoot(id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
  if (err && err.type === 'entity.too.large' && !res.headersSent) {
    // The parser cap, not the effective editor limit (the backend enforces that one first).
    return res.status(413).json({
      error: 'request body too large',
      message: `request body too large (>${err.limit} bytes)`,
      limit: err.limit,
    });
  }
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
// Idle limit (no input and no output). The backend passes the admin setting
// per terminal in `X-Dg-Idle-Ms`; TERMINAL_IDLE_MS is the fallback when the
// header is missing or outside TERMINAL_IDLE_HEADER_MIN_MS..MAX_MS.
const TERMINAL_IDLE_MS = positiveIntEnv('TERMINAL_IDLE_MS', 30 * 60_000);
const TERMINAL_IDLE_HEADER_MIN_MS = 5 * 60_000;
const TERMINAL_IDLE_HEADER_MAX_MS = 24 * 3600_000;
const TERMINAL_SWEEP_MS = positiveIntEnv('TERMINAL_SWEEP_MS', 60_000);
// Same close code/reason as the backend's SSH terminal bridge; the frontend
// shows "closed due to inactivity" for it.
const TERMINAL_IDLE_CLOSE_CODE = 4010;
const TERMINAL_IDLE_CLOSE_REASON = 'idle_timeout';
const TERMINAL_MAX_PER_WORKSPACE = 8;
const activeTerminals = new Map();

/** Per-terminal idle limit from `X-Dg-Idle-Ms`, else the TERMINAL_IDLE_MS fallback. */
function parseIdleHeader(raw) {
  if (typeof raw !== 'string' || !/^\d{1,9}$/.test(raw)) return TERMINAL_IDLE_MS;
  const ms = Number(raw);
  if (ms < TERMINAL_IDLE_HEADER_MIN_MS || ms > TERMINAL_IDLE_HEADER_MAX_MS) return TERMINAL_IDLE_MS;
  return ms;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, term] of activeTerminals) {
    if (now - term.lastActivity > term.idleMs) {
      // Close the socket first with the idle code: the pty's onExit then
      // sees a socket that is no longer OPEN and sends no `exit` frame.
      try { term.ws.close(TERMINAL_IDLE_CLOSE_CODE, TERMINAL_IDLE_CLOSE_REASON); } catch { /* socket dying */ }
      try { term.pty.kill(); } catch { /* already dead */ }
      activeTerminals.delete(key);
    }
  }
}, TERMINAL_SWEEP_MS).unref();

// Keys claimed at upgrade time but not yet in activeTerminals: the PTY is
// spawned only after async setup (ensureWorkspaceDir etc.), so without this a
// second upgrade with the same sessionId, or one past the per-workspace cap,
// could slip through in that window.
const reservedTerminals = new Set();

function countTerminalsFor(workspaceId) {
  let n = 0;
  for (const key of activeTerminals.keys()) {
    if (key.startsWith(workspaceId + ':')) n += 1;
  }
  for (const key of reservedTerminals) {
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
  const termKey = `ws:${workspaceId}:${sessionId}`;
  if (activeTerminals.has(termKey) || reservedTerminals.has(termKey)) {
    socket.write('HTTP/1.1 409 Conflict\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
    return;
  }
  const dgEnv = parseDgEnvHeader(req.headers['x-dg-env'], workspaceId);
  const idleMs = parseIdleHeader(req.headers['x-dg-idle-ms']);

  // Key-Präfix `ws:` (M-23) — stammt aus der Zeit der Kube-Terminals, bleibt
  // als Namensraum für die Bookkeeping-Keys erhalten.
  if (countTerminalsFor(`ws:${workspaceId}`) >= TERMINAL_MAX_PER_WORKSPACE) {
    socket.write('HTTP/1.1 429 Too Many Terminals\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
    return;
  }
  // Claimed synchronously, released once the PTY is registered (or setup failed).
  reservedTerminals.add(termKey);
  // If the handshake dies before the callback runs, ws never calls it: free
  // the claim from the socket instead. Once the handler owns it, the handler's
  // `finally` frees it (a late socket close must not drop a newer claim).
  let handedOver = false;
  socket.once('close', () => { if (!handedOver) reservedTerminals.delete(termKey); });
  wss.handleUpgrade(req, socket, head, (ws) => {
    handedOver = true;
    handleTerminalConnection(ws, workspaceId, sessionId, dgEnv, idleMs)
      .catch((err) => {
        console.error('terminal connection failed', err);
        try { ws.close(1011, 'internal error'); } catch { /* noop */ }
      })
      .finally(() => reservedTerminals.delete(termKey));
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

async function handleTerminalConnection(ws, workspaceId, sessionId, dgEnv = {}, idleMs = TERMINAL_IDLE_MS) {
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
  const state = { pty: term, ws, lastActivity: Date.now(), idleMs };
  activeTerminals.set(key, state);
  reservedTerminals.delete(key);

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
