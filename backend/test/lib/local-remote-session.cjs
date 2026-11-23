/*
 * Local stand-in for a `RemoteSession` (backend/src/workspaces/fs/remote-session.ts):
 * `RemoteFs` over node:fs inside one temp directory, `exec` via a local
 * `sh -c` with that directory as cwd. Used by the SSH file backend checks —
 * no network, no SSH.
 *
 * Every path argument must lie inside `base` (lexically and after resolving
 * links); anything else throws, so a bug in the code under test cannot touch
 * the rest of the machine.
 *
 * Switches (mutable on the returned `switches` object):
 *   probeUid           uid reported by probe() (default: own uid)
 *   noPosixRename      posixRename() answers false (extension missing)
 *   failPosixRename    posixRename() rejects with code `failure`
 *   denyCreateIn       Set of directories: creating a NEW file there -> `denied`
 *   deny               Set of paths: stat/lstat/readdir/readFile -> `denied`
 *   stallRead          createReadStream() returns a stream that never emits
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { PassThrough, Writable } = require('node:stream');

function createLocalRemoteSession(base, RemoteError) {
  const realBase = fs.realpathSync(base);
  const switches = {
    probeUid: typeof process.getuid === 'function' ? process.getuid() : 0,
    noPosixRename: false,
    failPosixRename: false,
    denyCreateIn: new Set(),
    deny: new Set(),
    stallRead: false,
  };
  const calls = { readStreams: [], writeStreams: 0, execs: [], writeFiles: [] };

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
    size: s.size, mode: s.mode, uid: s.uid,
    isFile: s.isFile(), isDirectory: s.isDirectory(), isSymlink: s.isSymbolicLink(),
  });
  const denied = (p) => {
    if (switches.deny.has(p)) throw new RemoteError('denied', `${p}: permission denied`);
  };
  const exists = async (p) => { try { await fsp.lstat(p); return true; } catch { return false; } };
  async function assertCreate(p) {
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
      return new Writable({
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
    },
    rename: wrap('rename', async (from, to) => {
      const f = guard(from); const t = guard(to);
      if (await exists(t)) throw new RemoteError('exists', `${to}: exists`);
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

  const session = {
    fs: rfs,
    exec: (command, opts = {}) => {
      calls.execs.push(command);
      return new Promise((resolve) => {
        execFile('sh', ['-c', command], { cwd: base, timeout: opts.timeoutMs ?? 20_000 }, (err, stdout, stderr) => {
          const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
          resolve({ code, stdout: String(stdout), stderr: String(stderr), truncated: false });
        });
      });
    },
    probe: async () => ({ rg: false, git: false, uid: switches.probeUid }),
  };
  return { session, switches, calls };
}

module.exports = { createLocalRemoteSession };
