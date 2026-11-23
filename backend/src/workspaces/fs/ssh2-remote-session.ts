import { PassThrough, Readable, Writable } from 'node:stream';
import type { Client as Ssh2Client, ClientChannel, FileEntryWithStats, SFTPWrapper, Stats } from 'ssh2';
import { errorMessage, isRecord } from '../../common/narrow';
import {
  RemoteDirEntry,
  RemoteDriverContext,
  RemoteDriverExecOpts,
  RemoteError,
  RemoteExecResult,
  RemoteFs,
  RemoteSessionDriver,
  RemoteStat,
  isRemoteError,
} from './remote-session';

// SFTP status codes (draft-ietf-secsh-filexfer-02 plus FILE_ALREADY_EXISTS from v5).
const FX_NO_SUCH_FILE = 2;
const FX_PERMISSION_DENIED = 3;
const FX_NO_CONNECTION = 6;
const FX_CONNECTION_LOST = 7;
const FX_FILE_ALREADY_EXISTS = 11;

/** Upper bound for waiting on a destroyed SFTP write handle to close. */
const WRITE_CLOSE_WAIT_MS = 5_000;

const LOST_RE = /No response from server|Not connected|connection lost|channel (is )?closed|socket (is )?closed/i;

/**
 * Maps an ssh2 / SFTP failure to a `RemoteError` with a stable code. Exported
 * for callers that consume raw stream errors.
 */
export function toRemoteError(err: unknown, context: string): RemoteError {
  if (isRemoteError(err)) return err;
  const code = isRecord(err) ? err.code : undefined;
  const message = `${context}: ${errorMessage(err)}`;
  if (code === FX_NO_SUCH_FILE || code === 'ENOENT') return new RemoteError('not_found', message);
  if (code === FX_PERMISSION_DENIED || code === 'EACCES') return new RemoteError('denied', message);
  if (code === FX_FILE_ALREADY_EXISTS) return new RemoteError('exists', message);
  if (code === FX_NO_CONNECTION || code === FX_CONNECTION_LOST || LOST_RE.test(errorMessage(err))) {
    return new RemoteError('disconnected', message);
  }
  return new RemoteError('failure', message);
}

function toStat(s: Stats): RemoteStat {
  return {
    size: s.size,
    mode: s.mode,
    uid: s.uid,
    gid: s.gid,
    isFile: s.isFile(),
    isDirectory: s.isDirectory(),
    isSymlink: s.isSymbolicLink(),
  };
}

function safe(fn: () => void): void {
  try { fn(); } catch { /* best effort */ }
}

/** Promise around a callback-style SFTP call; a synchronous throw rejects too. */
function call<T>(context: string, start: (cb: (err: Error | null | undefined, v?: T) => void) => void): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    try {
      start((err, v) => (err ? reject(toRemoteError(err, context)) : resolve(v)));
    } catch (err: unknown) {
      reject(toRemoteError(err, context));
    }
  });
}

async function callValue<T>(context: string, start: (cb: (err: Error | null | undefined, v?: T) => void) => void): Promise<T> {
  const v = await call<T>(context, start);
  if (v === undefined) throw new RemoteError('failure', `${context}: empty response`);
  return v;
}

function openSftp(client: Ssh2Client): Promise<SFTPWrapper> {
  return callValue<SFTPWrapper>('sftp', (cb) => client.sftp((err, sftp) => cb(err, sftp)));
}

/**
 * Builds the raw operations for one ready ssh2 client: one SFTP channel for
 * file operations, one short-lived exec channel per command.
 */
export async function createSsh2Driver(
  client: Ssh2Client,
  ctx: RemoteDriverContext,
): Promise<RemoteSessionDriver> {
  const sftp = await openSftp(client);
  sftp.on('close', () => ctx.onLost(new Error('SFTP channel closed')));
  sftp.on('error', (err: Error) => ctx.onLost(err));

  const stat = async (p: string): Promise<RemoteStat> =>
    toStat(await callValue<Stats>(`stat ${p}`, (cb) => sftp.stat(p, cb)));
  const lstat = async (p: string): Promise<RemoteStat> =>
    toStat(await callValue<Stats>(`lstat ${p}`, (cb) => sftp.lstat(p, cb)));
  /** Only `not_found` means absent; any other lstat failure propagates. */
  const exists = async (p: string): Promise<boolean> => {
    try {
      await lstat(p);
      return true;
    } catch (err: unknown) {
      if (isRemoteError(err) && err.code === 'not_found') return false;
      throw err;
    }
  };
  const existsQuiet = async (p: string): Promise<boolean> => {
    try {
      return await exists(p);
    } catch {
      return false;
    }
  };
  /** FAILURE is ambiguous; it means "exists" when the target is there. */
  const refineExists = async (err: unknown, target: string): Promise<never> => {
    const remote = toRemoteError(err, target);
    if (remote.code === 'failure' && (await existsQuiet(target))) {
      throw new RemoteError('exists', `${target}: already exists`);
    }
    throw remote;
  };

  const fs: RemoteFs = {
    stat,
    lstat,
    realpath: (p) => callValue<string>(`realpath ${p}`, (cb) => sftp.realpath(p, cb)),
    readdir: async (p) =>
      listOf(await callValue<FileEntryWithStats[]>(`readdir ${p}`, (cb) => sftp.readdir(p, cb))),
    readFile: async (p, maxBytes) => {
      const st = await stat(p);
      if (st.size > maxBytes) throw new RemoteError('too_large', `${p}: ${st.size} > ${maxBytes} bytes`);
      return new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let src: Readable;
        try {
          src = sftp.createReadStream(p);
        } catch (err: unknown) {
          reject(toRemoteError(err, `read ${p}`));
          return;
        }
        src.on('data', (chunk: Buffer) => {
          total += chunk.length;
          // The size from stat() is a snapshot; a growing file stops here.
          if (total > maxBytes) {
            src.destroy();
            reject(new RemoteError('too_large', `${p}: more than ${maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        src.on('error', (err: Error) => reject(toRemoteError(err, `read ${p}`)));
        src.on('end', () => resolve(Buffer.concat(chunks, total)));
      });
    },
    createReadStream: (p) => wrapReadStream(() => sftp.createReadStream(p), `read ${p}`),
    writeFile: async (p, data, mode) => {
      await call(`write ${p}`, (cb) => sftp.writeFile(p, data, { mode }, cb));
    },
    createWriteStream: (p, mode) => wrapWriteStream(() => sftp.createWriteStream(p, { mode }), `write ${p}`),
    rename: async (from, to) => {
      // SFTP rename semantics differ between servers (some overwrite): check first.
      if (await exists(to)) throw new RemoteError('exists', `${to}: already exists`);
      try {
        await call(`rename ${from}`, (cb) => sftp.rename(from, to, cb));
      } catch (err: unknown) {
        await refineExists(err, to);
      }
    },
    posixRename: (from, to) =>
      new Promise<boolean>((resolve, reject) => {
        try {
          sftp.ext_openssh_rename(from, to, (err) =>
            err ? reject(toRemoteError(err, `rename ${from}`)) : resolve(true));
        } catch (err: unknown) {
          // ssh2 throws synchronously when the server did not advertise the extension.
          if (/does not support/i.test(errorMessage(err))) resolve(false);
          else reject(toRemoteError(err, `rename ${from}`));
        }
      }),
    unlink: async (p) => {
      await call(`unlink ${p}`, (cb) => sftp.unlink(p, cb));
    },
    mkdir: async (p) => {
      try {
        await call(`mkdir ${p}`, (cb) => sftp.mkdir(p, cb));
      } catch (err: unknown) {
        await refineExists(err, p);
      }
    },
    chmod: async (p, mode) => {
      await call(`chmod ${p}`, (cb) => sftp.chmod(p, mode, cb));
    },
  };

  return {
    fs,
    exec: (command, opts) => runExec(client, command, opts),
    close: () => safe(() => sftp.end()),
  };
}

function listOf(list: FileEntryWithStats[]): RemoteDirEntry[] {
  return list.map((e) => ({ name: e.filename, stat: toStat(e.attrs) }));
}

/** Pass-through whose errors are `RemoteError`s; destroying it closes the SFTP handle. */
function wrapReadStream(open: () => Readable, context: string): Readable {
  const out = new PassThrough();
  let src: Readable;
  try {
    src = open();
  } catch (err: unknown) {
    process.nextTick(() => out.destroy(toRemoteError(err, context)));
    return out;
  }
  src.on('error', (err: Error) => out.destroy(toRemoteError(err, context)));
  out.on('close', () => safe(() => src.destroy()));
  src.pipe(out);
  return out;
}

/**
 * Writable whose errors are `RemoteError`s. `finish` (and thus `close`) only
 * fires after the remote handle is closed, so a caller may rename the file
 * right after.
 */
function wrapWriteStream(open: () => Writable, context: string): Writable {
  let dst: Writable | undefined;
  let dstError: RemoteError | undefined;
  let dstClosed = false;
  const out = new Writable({
    write(chunk: Buffer, encoding, cb) {
      if (!dst) {
        cb(dstError ?? new RemoteError('failure', `${context}: not open`));
        return;
      }
      dst.write(chunk, encoding, (err) => cb(err ? toRemoteError(err, context) : null));
    },
    final(cb) {
      if (!dst || dstError) {
        cb(dstError ?? new RemoteError('failure', `${context}: not open`));
        return;
      }
      dst.once('close', () => cb(dstError ?? null));
      dst.end();
    },
    // Calls back once the remote handle is closed (capped), so a caller can
    // remove a temp file right after without racing a still-pending open.
    destroy(err, cb) {
      const target = dst;
      if (!target || dstClosed) {
        cb(err);
        return;
      }
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(cap);
        cb(err);
      };
      const cap = setTimeout(finish, WRITE_CLOSE_WAIT_MS);
      target.once('close', finish);
      if (!target.destroyed) safe(() => target.destroy());
    },
  });
  try {
    dst = open();
    dst.once('close', () => { dstClosed = true; });
    // The SFTP handle is open (target truncated): callers keep their temp copy from here on.
    dst.once('open', () => out.emit('open'));
    dst.on('error', (err: Error) => {
      dstError = toRemoteError(err, context);
      out.destroy(dstError);
    });
  } catch (err: unknown) {
    dstError = toRemoteError(err, context);
    process.nextTick(() => out.destroy(dstError));
  }
  return out;
}

interface OutputSink { chunks: Buffer[]; len: number }

/**
 * One exec channel with an absolute timeout, a per-stream output cap and an
 * optional abort signal. Timeout and abort reject with the output collected
 * so far as `partial`.
 */
function runExec(client: Ssh2Client, command: string, opts: RemoteDriverExecOpts): Promise<RemoteExecResult> {
  const { timeoutMs, maxOutputBytes, terminateOnTimeout, signal } = opts;
  return new Promise<RemoteExecResult>((resolve, reject) => {
    let settled = false;
    let truncated = false;
    let exitCode: number | null = null;
    let channel: ClientChannel | undefined;
    const out: OutputSink = { chunks: [], len: 0 };
    const err: OutputSink = { chunks: [], len: 0 };
    const text = (sink: OutputSink): string => Buffer.concat(sink.chunks, sink.len).toString('utf8');
    const partial = (): { stdout: string; stderr: string } => ({ stdout: text(out), stderr: text(err) });
    const closeChannel = (): void => safe(() => channel?.close());
    const timer = setTimeout(() => {
      finish(() => reject(new RemoteError('timeout', `exec timed out after ${timeoutMs} ms`, partial())));
      // Closing the channel alone leaves the remote command running. Ask the
      // server to terminate it first; many sshd builds ignore the request,
      // which is harmless.
      if (terminateOnTimeout) safe(() => channel?.signal('TERM'));
      closeChannel();
    }, timeoutMs);
    let aborted = false;
    const onAbort = (): void => {
      aborted = true;
      finish(() => reject(new RemoteError('aborted', 'exec aborted', partial())));
      safe(() => channel?.signal('TERM'));
      closeChannel();
    };
    function finish(fn: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    }
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    const take = (sink: OutputSink, chunk: Buffer): void => {
      const room = maxOutputBytes - sink.len;
      if (room > 0) {
        const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
        sink.chunks.push(part);
        sink.len += part.length;
      }
      if (chunk.length > room) {
        truncated = true;
        closeChannel();
      }
    };
    try {
      client.exec(command, (openErr, ch) => {
        if (openErr) {
          finish(() => reject(toRemoteError(openErr, 'exec')));
          return;
        }
        if (settled) {
          // Aborted while the channel was opening: the command may already run.
          if (aborted) safe(() => ch.signal('TERM'));
          safe(() => ch.close());
          return;
        }
        channel = ch;
        // No PTY, no input: EOF on stdin, so a command waiting for input ends
        // instead of hanging until its timeout (the sidecar does the same).
        safe(() => ch.end());
        ch.on('data', (d: Buffer) => take(out, d));
        ch.stderr.on('data', (d: Buffer) => take(err, d));
        ch.on('exit', (code: unknown) => {
          if (typeof code === 'number') exitCode = code;
        });
        ch.on('error', (e: Error) => finish(() => reject(toRemoteError(e, 'exec'))));
        ch.on('close', (code: unknown) => {
          if (exitCode === null && typeof code === 'number') exitCode = code;
          finish(() => resolve({ code: truncated ? null : exitCode, ...partial(), truncated }));
        });
      });
    } catch (e: unknown) {
      finish(() => reject(toRemoteError(e, 'exec')));
    }
  });
}
