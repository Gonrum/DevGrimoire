/*
 * Local stand-in for a `RemoteSession` (backend/src/workspaces/fs/remote-session.ts):
 * `RemoteFs` over node:fs inside one temp directory, `exec` via a local
 * `sh -c` with that directory as cwd. Used by the SSH file backend checks —
 * no network, no SSH.
 *
 * Every path argument must lie inside `base` (lexically and after resolving
 * links); anything else throws, so a bug in the code under test cannot touch
 * the rest of the machine. `exec` only runs commands matching one of the
 * shapes in EXEC_SHAPES, with every path in them guarded the same way; any
 * other command throws.
 *
 * Switches (mutable on the returned `switches` object):
 *   probeUid           uid reported by probe() (default: own uid)
 *   probeGid           gid reported by probe() (default: own gid)
 *   noPosixRename      posixRename() answers false (extension missing)
 *   failPosixRename    posixRename() rejects with code `failure`
 *   failRename         rename() rejects with code `failure`
 *   denyCreateIn       Set of directories: creating a NEW file there -> `denied`
 *   deny               Set of paths: stat/lstat/readdir/readFile -> `denied`
 *   stallRead          createReadStream() returns a stream that never emits
 *   probeRg            rg reported by probe() (default: false -> grep path)
 *   probeGit           git reported by probe() (default: true)
 *   probeTimeout       `timeout` reported by probe() (default: true; search
 *                      commands then carry a `timeout -s TERM <n>` prefix)
 *   execTimeout        exec() rejects with RemoteError('timeout')
 *   denyOpenWrite      Set of paths: opening them for writing (createWriteStream,
 *                      writeFile) -> `denied`, even when the file exists
 *   execScript         null, or the scripted answer for agent commands
 *                      (`cd -- '<root>' && <anything>`, see agentShape):
 *                      { code = 0, stdout = '', stderr = '', delayMs = 0,
 *                        timeout = false }. Such a command is only recorded
 *                      and answered, NEVER run. `timeout: true` rejects with
 *                      RemoteError('timeout') after `delayMs`; an aborted
 *                      `opts.signal` rejects with RemoteError('aborted').
 *                      Both carry the scripted output as `partial`.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { PassThrough, Writable } = require('node:stream');

/** Inverse of shq(): one single-quoted shell word -> its value. */
function unquote(word) {
  if (!/^'(?:[^']|'\\'')*'$/.test(word)) throw new Error(`fake: not a single-quoted word: ${word}`);
  return word.slice(1, -1).replace(/'\\''/g, "'");
}

function createLocalRemoteSession(base, RemoteError) {
  const realBase = fs.realpathSync(base);
  const switches = {
    probeUid: typeof process.getuid === 'function' ? process.getuid() : 0,
    probeGid: typeof process.getgid === 'function' ? process.getgid() : 0,
    failRename: false,
    noPosixRename: false,
    failPosixRename: false,
    denyCreateIn: new Set(),
    deny: new Set(),
    stallRead: false,
    probeRg: false,
    probeGit: true,
    probeTimeout: true,
    execTimeout: false,
    denyOpenWrite: new Set(),
    execScript: null,
  };
  const calls = { readStreams: [], writeStreams: 0, execs: [], execOpts: [], writeFiles: [], agentExecs: [], aborts: 0 };

  const inside = (root, p) => p === root || p.startsWith(`${root}/`);
  function guard(p) {
    if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error(`fake: not absolute: ${p}`);
    const r = path.resolve(p);
    if (!inside(base, r) && !inside(realBase, r)) throw new Error(`fake: outside the temp dir: ${p}`);
    return r;
  }
  const map = (err, ctx) => {
    if (err instanceof RemoteError) return err;
    const code = err && err.code;
    const msg = `${ctx}: ${err && err.message}`;
    if (code === 'ENOENT' || code === 'ENOTDIR') return new RemoteError('not_found', msg);
    if (code === 'EACCES' || code === 'EPERM') return new RemoteError('denied', msg);
    if (code === 'EEXIST') return new RemoteError('exists', msg);
    return new RemoteError('failure', msg);
  };
  const wrap = (ctx, fn) => async (...args) => {
    try { return await fn(...args); } catch (err) { throw map(err, ctx); }
  };
  const toStat = (s) => ({
    size: s.size, mode: s.mode, uid: s.uid, gid: s.gid,
    isFile: s.isFile(), isDirectory: s.isDirectory(), isSymlink: s.isSymbolicLink(),
  });
  const denied = (p) => {
    if (switches.deny.has(p)) throw new RemoteError('denied', `${p}: permission denied`);
  };
  const exists = async (p) => { try { await fsp.lstat(p); return true; } catch { return false; } };
  async function assertCreate(p) {
    if (switches.denyOpenWrite.has(p)) throw new RemoteError('denied', `${p}: permission denied`);
    if (switches.denyCreateIn.has(path.dirname(p)) && !(await exists(p))) {
      throw new RemoteError('denied', `${p}: permission denied`);
    }
  }

  const rfs = {
    stat: wrap('stat', async (p) => { const r = guard(p); denied(r); return toStat(await fsp.stat(r)); }),
    lstat: wrap('lstat', async (p) => { const r = guard(p); denied(r); return toStat(await fsp.lstat(r)); }),
    realpath: wrap('realpath', async (p) => {
      const real = await fsp.realpath(guard(p));
      guard(real);
      return real;
    }),
    readdir: wrap('readdir', async (p) => {
      const r = guard(p);
      denied(r);
      const names = await fsp.readdir(r);
      const out = [];
      for (const name of names) out.push({ name, stat: toStat(await fsp.lstat(path.join(r, name))) });
      return out;
    }),
    readFile: wrap('readFile', async (p, maxBytes) => {
      const r = guard(p);
      denied(r);
      const st = await fsp.stat(r);
      if (st.size > maxBytes) throw new RemoteError('too_large', `${p}: ${st.size} > ${maxBytes}`);
      return fsp.readFile(r);
    }),
    createReadStream: (p) => {
      const r = guard(p);
      if (switches.stallRead) {
        const s = new PassThrough();
        calls.readStreams.push(s);
        return s;
      }
      const s = fs.createReadStream(r, { highWaterMark: 16 * 1024 });
      calls.readStreams.push(s);
      const out = new PassThrough({ highWaterMark: 16 * 1024 });
      s.on('error', (err) => out.destroy(map(err, 'read')));
      out.on('close', () => s.destroy());
      s.pipe(out);
      return out;
    },
    writeFile: wrap('writeFile', async (p, data, mode) => {
      const r = guard(p);
      await assertCreate(r);
      calls.writeFiles.push(r);
      await fsp.writeFile(r, data, { mode });
    }),
    createWriteStream: (p, mode) => {
      const r = guard(p);
      calls.writeStreams += 1;
      // Same contract as the ssh2 wrapper: errors are RemoteErrors, `finish`
      // fires after the file is closed.
      let dst;
      const ready = (async () => {
        await assertCreate(r);
        dst = fs.createWriteStream(r, { mode, flags: 'w' });
        await new Promise((res, rej) => { dst.once('open', res); dst.once('error', rej); });
      })();
      ready.catch(() => undefined);
      const w = new Writable({
        write(chunk, enc, cb) {
          ready.then(() => dst.write(chunk, enc, (e) => cb(e ? map(e, 'write') : null)), (e) => cb(map(e, 'write')));
        },
        final(cb) {
          ready.then(() => { dst.end(() => cb()); }, (e) => cb(map(e, 'write')));
        },
        // `close` only after the file handle is closed (like the ssh2 wrapper
        // after the SFTP handle), so a caller can unlink the file right after.
        destroy(err, cb) {
          ready
            .then(() => new Promise((res) => {
              if (!dst || dst.closed) { res(); return; }
              dst.once('close', res);
              dst.destroy();
            }), () => undefined)
            .then(() => cb(err));
        },
      });
      // Like the ssh2 wrapper: `open` once the remote file is open.
      ready.then(() => w.emit('open'), () => undefined);
      return w;
    },
    rename: wrap('rename', async (from, to) => {
      const f = guard(from); const t = guard(to);
      if (await exists(t)) throw new RemoteError('exists', `${to}: exists`);
      if (switches.failRename) throw new RemoteError('failure', 'rename failed');
      await fsp.rename(f, t);
    }),
    posixRename: wrap('posixRename', async (from, to) => {
      const f = guard(from); const t = guard(to);
      if (switches.noPosixRename) return false;
      if (switches.failPosixRename) throw new RemoteError('failure', 'posix-rename failed');
      await fsp.rename(f, t);
      return true;
    }),
    unlink: wrap('unlink', async (p) => { await fsp.unlink(guard(p)); }),
    mkdir: wrap('mkdir', async (p) => {
      const r = guard(p);
      await assertCreate(r);
      await fsp.mkdir(r);
    }),
    chmod: wrap('chmod', async (p, mode) => { await fsp.chmod(guard(p), mode); }),
  };

  /**
   * Allowlist of command shapes. Each entry parses a command and returns the
   * paths it touches (all guarded before anything runs), or null if the
   * command does not have this shape. Task 7 adds its `cd -- '<root>' && …`
   * shapes here the same way.
   */
  // Search / status commands: `cd -- '<root>' && <tool> <args>`. The command is
  // split into shell words; a bare word must be on the fixed allowlist, a
  // quoted word is only accepted as the value of a known option (or as the
  // root of the `cd`). Anything else (an unquoted metacharacter, an unknown
  // flag) makes the shape fail, so the fake throws instead of running it.
  const BARE_OK = new Set([
    'rg', '--json', '--max-count', '50', '--max-columns', '300', '--ignore-case',
    '--fixed-strings', '--glob', '--hidden', '--', '.',
    'grep', '-rnIZ', '-F', '-E', '-i', '-m', '--exclude-dir=.git', '-e',
    'git', '--no-optional-locks', 'rev-parse', '--show-prefix', '-c', 'core.quotepath=false', 'status',
    '--porcelain=v1', '--branch',
  ]);
  const QUOTED = /^(?:--include=|--exclude=)?'(?:[^']|'\\'')*'$/;
  function words(cmd) {
    const out = [];
    let i = 0;
    while (i < cmd.length) {
      if (cmd[i] === ' ') { i += 1; continue; }
      let j = i;
      while (j < cmd.length && cmd[j] !== ' ') {
        if (cmd[j] === "'") {
          j += 1;
          for (;;) {
            if (j >= cmd.length) throw new Error(`fake: unterminated quote: ${cmd}`);
            if (cmd[j] === "'") {
              if (cmd.slice(j, j + 4) === "'\\''") { j += 4; continue; }
              j += 1;
              break;
            }
            j += 1;
          }
        } else j += 1;
      }
      out.push(cmd.slice(i, j));
      i = j;
    }
    return out;
  }
  function toolShape(cmd) {
    const m = /^cd -- ('(?:[^']|'\\'')*') && (.*)$/s.exec(cmd);
    if (!m) return null;
    let ws = words(m[2]);
    // Optional server-side bound: exactly `timeout -s TERM <seconds>`, then the tool.
    if (ws[0] === 'timeout') {
      if (ws[1] !== '-s' || ws[2] !== 'TERM' || !/^\d{1,3}$/.test(ws[3] || '')) {
        throw new Error(`fake: malformed timeout prefix: ${cmd}`);
      }
      ws = ws.slice(4);
    }
    if (!['rg', 'grep', 'git'].includes(ws[0])) return null;
    let prevOpt = null;
    for (const w of ws) {
      if (QUOTED.test(w)) {
        const ok = /^--(?:include|exclude)=/.test(w) || ['--glob', '-e', '--'].includes(prevOpt);
        if (!ok) throw new Error(`fake: quoted word in a wrong place: ${w}`);
      } else if (!BARE_OK.has(w)) {
        throw new Error(`fake: bare word not allowed: ${w}`);
      }
      prevOpt = w;
    }
    return [unquote(m[1])];
  }
  /**
   * Agent commands (`exec` of the file backend): `cd -- '<root>' && <anything>`.
   * Only while `switches.execScript` is set — the tail is an arbitrary shell
   * command line and is never run; the root is guarded like every path.
   */
  function agentShape(cmd) {
    if (!switches.execScript) return null;
    const m = /^cd -- ('(?:[^']|'\\'')*') && (.+)$/s.exec(cmd);
    return m ? [unquote(m[1])] : null;
  }
  function scriptedExec(command, opts) {
    const sc = { code: 0, stdout: '', stderr: '', delayMs: 0, timeout: false, ...switches.execScript };
    calls.agentExecs.push(command);
    const cap = (text) => {
      const max = opts.maxOutputBytes;
      if (!max || Buffer.byteLength(text) <= max) return { text, cut: false };
      return { text: Buffer.from(text).subarray(0, max).toString('utf8'), cut: true };
    };
    const out = cap(sc.stdout);
    const err = cap(sc.stderr);
    const partial = { stdout: out.text, stderr: err.text };
    return new Promise((resolve, reject) => {
      const signal = opts.signal;
      let timer;
      const onAbort = () => {
        clearTimeout(timer);
        calls.aborts += 1;
        reject(new RemoteError('aborted', 'exec aborted', partial));
      };
      if (signal && signal.aborted) { onAbort(); return; }
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => {
        if (signal) signal.removeEventListener('abort', onAbort);
        if (sc.timeout) { reject(new RemoteError('timeout', 'exec timed out', partial)); return; }
        const truncated = out.cut || err.cut;
        resolve({ code: truncated ? null : sc.code, stdout: out.text, stderr: err.text, truncated });
      }, sc.delayMs);
    });
  }
  const EXEC_SHAPES = [
    agentShape,
    // remove(): rm -rf -- '<abs>'
    (cmd) => {
      const m = /^rm -rf -- ('(?:[^']|'\\'')*')$/.exec(cmd);
      return m ? [unquote(m[1])] : null;
    },
    toolShape,
  ];
  function execPaths(command) {
    for (const shape of EXEC_SHAPES) {
      const paths = shape(command);
      if (paths) return paths;
    }
    throw new Error(`fake: command not allowed: ${command}`);
  }

  const session = {
    fs: rfs,
    exec: async (command, opts = {}) => {
      // Throws (before running anything) for unknown shapes and outside paths.
      for (const p of execPaths(command)) guard(p);
      calls.execs.push(command);
      calls.execOpts.push(opts);
      if (agentShape(command)) return scriptedExec(command, opts);
      if (switches.execTimeout) throw new RemoteError('timeout', 'exec timed out');
      return new Promise((resolve) => {
        execFile('sh', ['-c', command], { cwd: base, timeout: opts.timeoutMs ?? 20_000, maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
          const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
          let out = String(stdout);
          let truncated = false;
          if (opts.maxOutputBytes && Buffer.byteLength(out) > opts.maxOutputBytes) {
            out = Buffer.from(out).subarray(0, opts.maxOutputBytes).toString('utf8');
            truncated = true;
          }
          resolve({ code, stdout: out, stderr: String(stderr), truncated });
        });
      });
    },
    probe: async () => ({
      rg: switches.probeRg,
      git: switches.probeGit,
      timeout: switches.probeTimeout,
      uid: switches.probeUid,
      gid: switches.probeGid,
    }),
  };
  return { session, switches, calls };
}

module.exports = { createLocalRemoteSession, unquote };
