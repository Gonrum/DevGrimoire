import { HttpException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import { PassThrough, Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { errorMessage } from '../../common/narrow';
import { shq } from '../../common/shell-quote';
import type { SshAuditAction } from '../../ssh/schemas/ssh-audit.schema';
import { AUDIT_COMMAND_TRUNC } from '../../ssh/ssh-session.service';
import { parseGitStatus, parseGrepOutput, parseRipgrepJson, relativizeStatus } from '../workspace-search-parse';
import { RemoteError, RemoteExecResult, RemoteSession, RemoteStat, isRemoteError } from './remote-session';
import type { RemoteExecPartial } from './remote-session';
import { normaliseExecInput } from './workspace-fs-backend';
import type {
  FsEntry,
  FsExecOpts,
  FsExecResult,
  FsLimits,
  FsSearchResult,
  FsStatusResult,
  WorkspaceFsBackend,
} from './workspace-fs-backend';

/** Same cap as the sidecar's tree. */
const TREE_MAX_ENTRIES = 5000;
/** A download is aborted when no byte flowed for this long (no absolute limit). */
export const SSH_DOWNLOAD_IDLE_MS = 60_000;
/** Longest stderr excerpt carried in an error answer. */
const STDERR_MAX_CHARS = 1000;
const NEW_FILE_MODE = 0o644;
const SEARCH_LIMIT = 2000;
const SEARCH_TIMEOUT_MS = 20_000;
/**
 * Server-side bound for rg/grep (`timeout -s TERM`), below the exec timeout so
 * the search ends on the server before the channel gives up on it.
 */
const SEARCH_REMOTE_TIMEOUT_S = 18;
/**
 * The search wrapper stopped the command: coreutils `timeout` exits 124,
 * busybox `timeout` passes on the TERM death (143, or no exit status at all).
 */
function isWrapperTimeout(code: number | null): boolean {
  return code === 124 || code === 143 || code === null;
}
/** A recursive delete of a big tree may take a while; it is never interrupted. */
const DELETE_TIMEOUT_MS = 120_000;
const STATUS_TIMEOUT_MS = 30_000;
/** Room for 2000 matches with 300-char texts in rg's JSON framing, plus slack. */
const SEARCH_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DENIED_TEXT = 'keine Berechtigung auf dem Server';

export type SshFsRun = <T>(
  fn: (s: RemoteSession) => Promise<T>,
  opts?: { retryable?: boolean },
) => Promise<T>;
export interface SshFsAuditExtra {
  bytes?: number;
  errorMsg?: string;
  command?: string;
  exitCode?: number;
  durationMs?: number;
}
export type SshFsAudit = (action: SshAuditAction, path: string, extra?: SshFsAuditExtra) => void;
export interface SshFsBackendOpts {
  /** Upload cap of the connection (`SshSessionService.resolveUploadLimit`). */
  uploadMaxBytes: number;
  /** Overridable by checks. */
  downloadIdleMs?: number;
}

const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

/** No NUL byte in the first 8 KiB and valid UTF-8 throughout (sidecar rule). */
export function isStrictUtf8Text(buf: Buffer): boolean {
  if (buf.subarray(0, 8192).includes(0)) return false;
  try {
    STRICT_UTF8.decode(buf);
    return true;
  } catch {
    return false;
  }
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** IDE error shape: `{ error, message, ...extra }`. */
function fail(status: number, message: string, extra: Record<string, unknown> = {}): HttpException {
  return new HttpException({ error: message, message, ...extra }, status);
}

/** `single`: action on one path (denied -> 403); `list`: tree/status load (denied -> 409). */
type ErrorScope = 'single' | 'list';

function isCode(err: unknown, code: RemoteError['code']): boolean {
  return isRemoteError(err) && err.code === code;
}

/**
 * IDE file access on an SSH workspace over SFTP. Paths from the client are
 * relative and joined onto `root` (the workspace's `remotePath`); the bound
 * is purely lexical, symlinks are followed (spec "Pfade"). Every operation
 * runs through `run`, which binds the workspace's held session.
 */
export class SshFsBackend implements WorkspaceFsBackend {
  private readonly downloadIdleMs: number;
  private readonly uploadMaxBytes: number;

  constructor(
    private readonly root: string,
    private readonly run: SshFsRun,
    private readonly audit: SshFsAudit,
    opts: SshFsBackendOpts,
  ) {
    if (!root.startsWith('/') || posix.normalize(root) === '/') {
      throw new Error(`SSH workspace root must be an absolute directory below "/": ${root}`);
    }
    this.root = posix.normalize(root).replace(/\/+$/, '');
    this.uploadMaxBytes = opts.uploadMaxBytes;
    this.downloadIdleMs = opts.downloadIdleMs ?? SSH_DOWNLOAD_IDLE_MS;
  }

  // -------------------------------------------------------------------------
  // Paths and errors
  // -------------------------------------------------------------------------

  /** Absolute remote path for a client path; 400 when it leaves the root. */
  private abs(rel: string): string {
    if (typeof rel !== 'string' || rel.includes('\0') || rel.startsWith('/')) {
      throw fail(400, 'path must be a relative path');
    }
    const joined = posix.normalize(posix.join(this.root, rel)).replace(/(.)\/+$/, '$1');
    if (joined !== this.root && !joined.startsWith(`${this.root}/`)) {
      throw fail(400, 'path escapes workspace root');
    }
    return joined;
  }

  /** Workspace-relative form of an absolute path inside the root (`.` for the root). */
  private rel(abs: string): string {
    return abs === this.root ? '.' : abs.slice(this.root.length + 1);
  }

  private notRoot(abs: string): void {
    if (abs === this.root) throw fail(400, 'the workspace root cannot be modified');
  }

  /** Maps a failure to the IDE's HttpException shape. */
  private toHttp(err: unknown, rel: string, scope: ErrorScope, notFound = 'not found'): HttpException {
    if (err instanceof HttpException) return err;
    if (!isRemoteError(err)) return fail(500, errorMessage(err));
    switch (err.code) {
      case 'not_found':
        return fail(404, notFound);
      case 'exists':
        return fail(409, 'target exists');
      case 'denied':
        return scope === 'single'
          ? fail(403, `${DENIED_TEXT}: ${rel}`)
          : fail(409, `${DENIED_TEXT}: ${rel}`);
      case 'too_large':
        return fail(413, err.message);
      case 'timeout':
        return fail(504, `Zeitüberschreitung auf dem Server: ${err.message}`);
      case 'disconnected':
        return fail(502, `SSH-Verbindung unterbrochen: ${err.message}`);
      default:
        return fail(500, err.message);
    }
  }

  private async guard<T>(
    rel: string,
    scope: ErrorScope,
    work: () => Promise<T>,
    notFound?: string,
  ): Promise<T> {
    try {
      return await work();
    } catch (err: unknown) {
      throw this.toHttp(err, rel, scope, notFound);
    }
  }

  /** lstat that answers `null` for a missing entry; other failures propagate. */
  private static async lstatOrNull(s: RemoteSession, p: string): Promise<RemoteStat | null> {
    try {
      return await s.fs.lstat(p);
    } catch (err: unknown) {
      if (isCode(err, 'not_found')) return null;
      throw err;
    }
  }

  private static async statOrNull(s: RemoteSession, p: string): Promise<RemoteStat | null> {
    try {
      return await s.fs.stat(p);
    } catch (err: unknown) {
      if (isCode(err, 'not_found')) return null;
      throw err;
    }
  }

  /**
   * True when a replace by the SSH user would change the file's owner or
   * group (a new inode gets the user's uid and primary gid). An unknown
   * uid/gid (-1: probe failed, e.g. an SFTP-only account without exec)
   * counts as different, so such a save goes "in place".
   */
  private static async ownedByOther(s: RemoteSession, st: RemoteStat): Promise<boolean> {
    try {
      const probe = await s.probe();
      return st.uid !== probe.uid || st.gid !== probe.gid;
    } catch {
      return true;
    }
  }

  /** `.<name>.dg-tmp-<8 hex>` next to the target. */
  private static tempPath(target: string): string {
    return posix.join(posix.dirname(target), `.${posix.basename(target)}.dg-tmp-${randomBytes(4).toString('hex')}`);
  }

  private static async unlinkQuiet(s: RemoteSession, p: string): Promise<void> {
    try {
      await s.fs.unlink(p);
    } catch {
      /* best effort */
    }
  }

  /** Path for messages: workspace-relative inside the root, absolute otherwise (symlink targets). */
  private shown(abs: string): string {
    return abs === this.root || abs.startsWith(`${this.root}/`) ? this.rel(abs) : abs;
  }

  /**
   * Moves `tmp` onto `target`, replacing it: posix-rename where offered,
   * otherwise remove the target first (non-atomic, as the spec allows).
   * Once the target is gone the temp file is the only copy: `state.keepTmp`
   * tells the caller not to delete it, and a failing rename names it.
   */
  private async replace(
    s: RemoteSession,
    tmp: string,
    target: string,
    state: { keepTmp: boolean },
  ): Promise<void> {
    if (await s.fs.posixRename(tmp, target)) return;
    try {
      await s.fs.unlink(target);
    } catch (err: unknown) {
      if (!isCode(err, 'not_found')) throw err;
    }
    state.keepTmp = true;
    try {
      await s.fs.rename(tmp, target);
    } catch (err: unknown) {
      throw fail(500, `Ersetzen fehlgeschlagen; neuer Inhalt liegt in ${this.shown(tmp)} (${errorMessage(err)})`);
    }
  }

  /**
   * Overwrites `target`'s content with `tmp`'s, keeping the target's inode
   * (owner, group, mode). Once the target is open (and thus truncated) the
   * temp file is the only complete copy: on failure it is kept and named in
   * the error. A refused open leaves the target untouched; that error
   * propagates as is (denied -> 403 like save) and the temp file goes.
   */
  private async copyInto(
    s: RemoteSession,
    tmp: string,
    target: string,
    state: { keepTmp: boolean },
  ): Promise<void> {
    // The mode only applies to a newly created file; the target exists.
    const dst = s.fs.createWriteStream(target, NEW_FILE_MODE);
    dst.once('open', () => { state.keepTmp = true; });
    try {
      await pipeline(s.fs.createReadStream(tmp), dst);
    } catch (err: unknown) {
      if (!state.keepTmp) throw err;
      throw fail(500, `Überschreiben fehlgeschlagen; neuer Inhalt liegt in ${this.shown(tmp)} (${errorMessage(err)})`);
    }
  }

  /** Creates missing directories between the root and `dir` (inclusive). */
  private async ensureDirs(s: RemoteSession, dir: string): Promise<void> {
    if (dir === this.root) return;
    let cur = this.root;
    for (const seg of this.rel(dir).split('/')) {
      cur = `${cur}/${seg}`;
      try {
        await s.fs.mkdir(cur);
      } catch (err: unknown) {
        if (!isCode(err, 'exists')) throw err;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Tree and reads
  // -------------------------------------------------------------------------

  async listDir(path: string): Promise<{ entries: FsEntry[]; truncated: boolean }> {
    const dir = this.abs(path);
    const base = this.rel(dir);
    const list = await this.guard(
      base,
      'list',
      () => this.run((s) => s.fs.readdir(dir), { retryable: true }),
      'directory not found',
    );
    const entries: FsEntry[] = [];
    let truncated = false;
    for (const e of list) {
      if (e.name === '.' || e.name === '..' || e.name === '.git') continue;
      if (entries.length >= TREE_MAX_ENTRIES) {
        truncated = true;
        break;
      }
      const p = base === '.' ? e.name : `${base}/${e.name}`;
      if (e.stat.isDirectory) entries.push({ path: p, type: 'dir' });
      else if (e.stat.isSymlink) entries.push({ path: p, type: 'symlink' });
      else entries.push({ path: p, type: 'file', size: e.stat.size });
    }
    entries.sort((a, b) => a.path.localeCompare(b.path));
    return { entries, truncated };
  }

  async readText(path: string, limits: FsLimits): Promise<{ content: string; hash: string; size: number }> {
    const target = this.abs(path);
    const limit = limits.editorMaxBytes;
    const buf = await this.guard(
      path,
      'single',
      () => this.run(async (s) => {
        const st = await s.fs.stat(target);
        if (!st.isFile) throw fail(400, 'path is not a regular file');
        if (st.size > limit) {
          throw fail(413, `file too large (>${limit} bytes)`, { size: st.size, limit });
        }
        try {
          return await s.fs.readFile(target, limit);
        } catch (err: unknown) {
          // The file grew between stat and read.
          if (isCode(err, 'too_large')) throw fail(413, `file too large (>${limit} bytes)`, { size: st.size, limit });
          throw err;
        }
      }, { retryable: true }),
      'file not found',
    );
    if (!isStrictUtf8Text(buf)) throw fail(415, 'not utf-8 text', { size: buf.length });
    return { content: buf.toString('utf8'), hash: sha256Hex(buf), size: buf.length };
  }

  async readStream(path: string, limits: FsLimits): Promise<{ stream: Readable; size: number }> {
    const target = this.abs(path);
    const limit = limits.downloadMaxBytes;
    const { src, size } = await this.guard(
      path,
      'single',
      () => this.run(async (s) => {
        const st = await s.fs.stat(target);
        if (!st.isFile) throw fail(400, 'path is not a regular file');
        if (st.size > limit) {
          throw fail(413, `file too large (>${limit} bytes)`, { size: st.size, limit });
        }
        // The session wrapper holds the session until this stream closes.
        return { src: s.fs.createReadStream(target), size: st.size };
      }),
      'file not found',
    );
    return { stream: boundedDownload(src, size, this.downloadIdleMs, path), size };
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  async writeText(
    path: string,
    content: string,
    opts: { baseHash: string | null; force: boolean },
    limits: FsLimits,
  ): Promise<{ hash: string }> {
    const data = Buffer.from(content, 'utf8');
    const limit = limits.editorMaxBytes;
    if (data.length > limit) {
      throw fail(413, `content too large (>${limit} bytes)`, { size: data.length, limit });
    }
    const requested = this.abs(path);
    if (requested === this.root) throw fail(400, 'path escapes workspace root');

    const written = await this.guard(path, 'single', () => this.run(async (s) => {
      // Sidecar order: parent directory, target-is-directory, symlink, hash.
      const parent = await SshFsBackend.statOrNull(s, posix.dirname(requested));
      if (!parent) throw fail(404, 'target directory does not exist');
      if (!parent.isDirectory) throw fail(400, 'parent is not a directory');
      const link = await SshFsBackend.lstatOrNull(s, requested);
      if (link?.isDirectory) throw fail(400, 'target is a directory');
      let writePath = requested;
      if (link?.isSymlink) {
        // Reads follow links, so writes do too: update the link's target.
        try {
          writePath = await s.fs.realpath(requested);
        } catch (err: unknown) {
          if (isCode(err, 'not_found')) throw fail(404, 'symlink target does not exist');
          throw err;
        }
      }

      let current: RemoteStat | null = null;
      let currentHash: string | null = null;
      if (link) {
        current = await SshFsBackend.statOrNull(s, writePath);
        if (current && !current.isFile) throw fail(400, 'path is not a regular file');
      }
      // `force` needs no hash; otherwise the same size limit as for reading.
      if (current && opts.force !== true) {
        if (current.size > limit) throw fail(413, `file too large (>${limit} bytes)`, { size: current.size, limit });
        currentHash = sha256Hex(await s.fs.readFile(writePath, limit));
      }
      if (opts.force !== true && opts.baseHash !== currentHash) {
        throw fail(409, 'conflict', { currentHash });
      }

      const mode = current ? current.mode & 0o777 : NEW_FILE_MODE;
      // Fallback "in place": another owner or group (a rename would give the
      // file our uid and primary gid) — only for an existing file.
      if (current && (await SshFsBackend.ownedByOther(s, current))) {
        await s.fs.writeFile(writePath, data, mode);
        return writePath;
      }
      const tmp = SshFsBackend.tempPath(writePath);
      // Unless creating it was refused, a failed write may have left a partial temp file.
      let tmpMayExist = true;
      let done = false;
      const keep = { keepTmp: false };
      try {
        try {
          await s.fs.writeFile(tmp, data, mode);
        } catch (err: unknown) {
          if (!isCode(err, 'denied')) throw err;
          tmpMayExist = false;
          // Directory not writable: overwrite the existing file directly.
          if (!current) throw err;
          await s.fs.writeFile(writePath, data, mode);
          done = true;
          return writePath;
        }
        // The open mode is subject to the umask; chmod sets it exactly.
        await s.fs.chmod(tmp, mode);
        await this.replace(s, tmp, writePath, keep);
        done = true;
        return writePath;
      } finally {
        if (!done && tmpMayExist && !keep.keepTmp) await SshFsBackend.unlinkQuiet(s, tmp);
      }
    }));
    this.audit('write', written, { bytes: data.length });
    return { hash: sha256Hex(data) };
  }

  async mkdir(path: string): Promise<{ path: string }> {
    const target = this.abs(path);
    if (target === this.root) throw fail(400, 'path escapes workspace root');
    await this.guard(path, 'single', () => this.run(async (s) => {
      await this.ensureDirs(s, posix.dirname(target));
      try {
        await s.fs.mkdir(target);
      } catch (err: unknown) {
        if (isCode(err, 'exists')) throw fail(409, 'already exists');
        throw err;
      }
    }));
    this.audit('mkdir', target);
    return { path: this.rel(target) };
  }

  async move(from: string, to: string): Promise<{ from: string; to: string }> {
    const src = this.abs(from);
    const dst = this.abs(to);
    this.notRoot(src);
    this.notRoot(dst);
    await this.guard(from, 'single', () => this.run(async (s) => {
      const st = await SshFsBackend.lstatOrNull(s, src);
      if (!st) throw fail(404, 'not found');
      if (st.isDirectory && (dst === src || dst.startsWith(`${src}/`))) {
        throw fail(400, 'cannot move a directory into itself');
      }
      if (await SshFsBackend.lstatOrNull(s, dst)) throw fail(409, 'target exists');
      await this.ensureDirs(s, posix.dirname(dst));
      // The driver's rename refuses an existing target as well (race).
      await s.fs.rename(src, dst);
    }));
    this.audit('move', `${src} -> ${dst}`);
    return { from: this.rel(src), to: this.rel(dst) };
  }

  async remove(path: string): Promise<void> {
    const target = this.abs(path);
    this.notRoot(target);
    // Once `rm -rf` was sent, the server may have changed even when the call
    // fails: such a failure is audited too.
    let rmSent = false;
    try {
      await this.guard(path, 'single', () => this.run(async (s) => {
        // lstat: a symlink is removed as a link, never followed.
        const st = await SshFsBackend.lstatOrNull(s, target);
        if (!st) throw fail(404, 'not found');
        if (!st.isDirectory) {
          await s.fs.unlink(target);
          return;
        }
        rmSent = true;
        let res: RemoteExecResult;
        try {
          // `target` is absolute (starts with "/"), and `--` ends option parsing.
          // A running rm is never terminated: half a tree is worse than none.
          res = await s.exec(`rm -rf -- ${shq(target)}`, {
            timeoutMs: DELETE_TIMEOUT_MS,
            terminateOnTimeout: false,
          });
        } catch (err: unknown) {
          if (isCode(err, 'timeout')) {
            throw fail(
              504,
              `Zeitüberschreitung beim Löschen von ${path} nach ${DELETE_TIMEOUT_MS / 1000} s: `
              + 'der Löschvorgang läuft auf dem Server möglicherweise noch weiter',
            );
          }
          throw err;
        }
        if (res.code !== 0) {
          const stderr = res.stderr.trim().slice(0, STDERR_MAX_CHARS);
          throw fail(500, `rm failed (exit ${res.code ?? 'unknown'}): ${stderr}`);
        }
      }));
    } catch (err: unknown) {
      if (rmSent) this.audit('delete', target, { errorMsg: errorMessage(err).slice(0, 500) });
      throw err;
    }
    this.audit('delete', target);
  }

  async upload(
    dir: string,
    fileName: string,
    source: Readable,
    opts: { size?: number; overwrite: boolean },
  ): Promise<{ path: string; size: number }> {
    if (
      !fileName || fileName.length > 255 || fileName === '.' || fileName === '..'
      || fileName.includes('/') || fileName.includes('\0')
    ) {
      throw fail(400, 'fileName must be a plain file name');
    }
    const limit = this.uploadMaxBytes;
    if (opts.size !== undefined && opts.size > limit) {
      throw fail(413, `file too large (>${limit} bytes)`, { size: opts.size, limit });
    }
    const dirAbs = this.abs(dir);
    const target = `${dirAbs}/${fileName}`;
    const received = await this.guard(posix.join(dir, fileName), 'single', () => this.run(async (s) => {
      const parent = await SshFsBackend.statOrNull(s, dirAbs);
      if (!parent) throw fail(404, 'target directory does not exist');
      if (!parent.isDirectory) throw fail(400, 'target directory is not a directory');
      const existing = await SshFsBackend.lstatOrNull(s, target);
      if (existing?.isDirectory) throw fail(409, 'target is a directory');
      if (existing && !opts.overwrite) {
        // Discard the unread body so the client gets the 409 instead of a reset.
        source.resume();
        throw fail(409, 'target exists');
      }
      const mode = existing?.isFile ? existing.mode & 0o777 : NEW_FILE_MODE;
      // Same rule as save: a rename would give a file of another owner or
      // group our uid/gid, so such a file keeps its inode. The body still goes
      // to a temp file first; the target is only touched once all of it arrived.
      const inPlace = opts.overwrite && existing?.isFile === true
        && (await SshFsBackend.ownedByOther(s, existing));
      const tmp = SshFsBackend.tempPath(target);
      let done = false;
      const keep = { keepTmp: false };
      let bytes = 0;
      const out = s.fs.createWriteStream(tmp, mode);
      try {
        const counter = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            bytes += chunk.length;
            if (bytes > limit) {
              cb(fail(413, `file too large (>${limit} bytes)`, { limit }));
              return;
            }
            cb(null, chunk);
          },
        });
        await pipeline(source, counter, out);
        if (opts.size !== undefined && bytes !== opts.size) {
          throw fail(400, `incomplete transfer: received ${bytes} of ${opts.size} bytes`);
        }
        if (inPlace) {
          await this.copyInto(s, tmp, target, keep);
          await SshFsBackend.unlinkQuiet(s, tmp);
          done = true;
          return bytes;
        }
        await s.fs.chmod(tmp, mode);
        if (opts.overwrite) await this.replace(s, tmp, target, keep);
        else await s.fs.rename(tmp, target);
        done = true;
        return bytes;
      } finally {
        if (!done && !keep.keepTmp) {
          await waitClosed(out);
          await SshFsBackend.unlinkQuiet(s, tmp);
        }
      }
    }));
    this.audit('upload', target, { bytes: received });
    return { path: this.rel(target), size: received };
  }

  // -------------------------------------------------------------------------
  // Search and git status (commands over the held session)
  // -------------------------------------------------------------------------

  async search(q: {
    query: string;
    regex: boolean;
    caseSensitive: boolean;
    include?: string[];
    exclude?: string[];
  }): Promise<FsSearchResult> {
    if (typeof q.query !== 'string' || !q.query.length) throw fail(400, 'query must be a non-empty string');
    if (q.query.length > 500) throw fail(400, 'query too long (max 500)');
    const include = normaliseGlobs(q.include);
    const exclude = normaliseGlobs(q.exclude);
    const cd = `cd -- ${shq(this.root)} && `;
    try {
      return await this.run(async (s) => {
        const probe = await s.probe();
        const useRg = probe.rg;
        const engine: 'rg' | 'grep' = useRg ? 'rg' : 'grep';
        const tool = useRg ? rgCommand(q, include, exclude) : grepCommand(q, include, exclude);
        // With `timeout` on the server the search stops there as well, instead
        // of running on after the exec channel was given up.
        const command = cd + (probe.timeout ? `timeout -s TERM ${SEARCH_REMOTE_TIMEOUT_S} ${tool}` : tool);
        let res: RemoteExecResult;
        try {
          res = await s.exec(command, { timeoutMs: SEARCH_TIMEOUT_MS, maxOutputBytes: SEARCH_MAX_OUTPUT_BYTES });
        } catch (err: unknown) {
          // The channel is closed on a timeout and no partial output survives.
          if (isCode(err, 'timeout')) return { matches: [], truncated: true, engine };
          throw err;
        }
        // A cut-off output (exit null, truncated) is a partial result, not a timeout.
        if (probe.timeout && !res.truncated && isWrapperTimeout(res.code)) return { matches: [], truncated: true, engine };
        let stdout = res.stdout;
        if (res.truncated) stdout = stdout.slice(0, stdout.lastIndexOf('\n') + 1);
        if (!res.truncated && res.code !== 0 && res.code !== 1) {
          // Exit 2 can also mean "some files unreadable" next to real matches.
          const partial = res.code === 2 && stdout.length > 0;
          if (!partial) throw searchFailure(res, useRg, q.regex);
        }
        const parsed = useRg
          ? parseRipgrepJson(stdout, SEARCH_LIMIT)
          : parseGrepOutput(stdout, q, SEARCH_LIMIT);
        return { ...parsed, truncated: parsed.truncated || res.truncated, engine };
      }, { retryable: true });
    } catch (err: unknown) {
      throw this.toHttp(err, '.', 'list');
    }
  }

  /**
   * Agent command on the server: `cd -- <root> && <command>`. The command is
   * a shell command line on purpose and is not quoted; only the root is. No
   * env (no DevGrimoire credentials to the server), never retried, and not
   * wrapped in `timeout` (commands may legitimately run up to 600 s): the
   * exec timeout ends it with TERM, like an abort.
   */
  async exec(command: string, opts: FsExecOpts): Promise<FsExecResult> {
    const { timeoutMs, maxOutputBytes, signal } = normaliseExecInput(command, opts);
    const empty: RemoteExecPartial = { stdout: '', stderr: '' };
    const auditCommand = command.slice(0, AUDIT_COMMAND_TRUNC);
    const started = Date.now();
    let result: FsExecResult;
    try {
      const res = await this.run((s) => s.exec(`cd -- ${shq(this.root)} && ${command}`, {
        timeoutMs,
        maxOutputBytes,
        terminateOnTimeout: true,
        ...(signal ? { signal } : {}),
      }));
      result = { exitCode: res.code, stdout: res.stdout, stderr: res.stderr, truncated: res.truncated, timedOut: false, aborted: false };
    } catch (err: unknown) {
      const timedOut = isCode(err, 'timeout');
      const aborted = isCode(err, 'aborted');
      if (!timedOut && !aborted) {
        this.audit('exec', this.root, { command: auditCommand, errorMsg: errorMessage(err).slice(0, 500) });
        throw this.toHttp(err, '.', 'single');
      }
      const partial = (isRemoteError(err) && err.partial) || empty;
      result = { exitCode: null, stdout: partial.stdout, stderr: partial.stderr, truncated: partial.truncated === true, timedOut, aborted };
    }
    this.audit('exec', this.root, {
      command: auditCommand,
      durationMs: Date.now() - started,
      ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
      ...(result.timedOut ? { errorMsg: `timeout after ${timeoutMs} ms` } : {}),
      ...(result.aborted ? { errorMsg: 'aborted' } : {}),
    });
    return result;
  }

  async status(): Promise<FsStatusResult> {
    const none: FsStatusResult = { branch: null, changed: [] };
    const cd = `cd -- ${shq(this.root)} && `;
    try {
      return await this.run(async (s) => {
        if (!(await s.probe()).git) return none;
        const prefixRes = await s.exec(`${cd}git --no-optional-locks rev-parse --show-prefix`, { timeoutMs: STATUS_TIMEOUT_MS });
        if (prefixRes.code !== 0) return none;
        const prefix = prefixRes.stdout.replace(/\r?\n$/, '');
        const res = await s.exec(
          // --no-optional-locks: a status must not refresh (write) .git/index.
          `${cd}git --no-optional-locks -c core.quotepath=false status --porcelain=v1 --branch`,
          { timeoutMs: STATUS_TIMEOUT_MS },
        );
        if (res.code !== 0) throw fail(500, `git status failed: ${res.stderr.trim().slice(0, STDERR_MAX_CHARS)}`);
        return relativizeStatus(parseGitStatus(res.stdout), prefix);
      }, { retryable: true });
    } catch (err: unknown) {
      throw this.toHttp(err, '.', 'list');
    }
  }
}

/** Same filter as the sidecar: strings below 200 chars without line breaks, at most 20. */
function normaliseGlobs(input: string[] | undefined): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((g) => typeof g === 'string' && g.length > 0 && g.length < 200 && !/[\n\r\0]/.test(g))
    .slice(0, 20);
}

/**
 * Switches 1:1 from the sidecar's `/search` with `json: true`, plus hidden
 * files (dotfiles such as `.env` are what one searches a server for) with
 * `.git` still excluded, like grep's `--exclude-dir=.git`.
 */
function rgCommand(
  q: { query: string; regex: boolean; caseSensitive: boolean },
  include: string[],
  exclude: string[],
): string {
  const args = ['rg', '--json', '--max-count', '50', '--max-columns', '300', '--hidden', '--glob', shq('!.git')];
  if (!q.caseSensitive) args.push('--ignore-case');
  if (!q.regex) args.push('--fixed-strings');
  for (const g of include) args.push('--glob', shq(g));
  for (const g of exclude) args.push('--glob', shq(`!${g}`));
  args.push('--', shq(q.query), '.');
  return args.join(' ');
}

function grepCommand(
  q: { query: string; regex: boolean; caseSensitive: boolean },
  include: string[],
  exclude: string[],
): string {
  const args = ['grep', '-rnIZ', q.regex ? '-E' : '-F', '-m', '50'];
  if (!q.caseSensitive) args.push('-i');
  for (const g of include) args.push(`--include=${shq(g)}`);
  for (const g of exclude) args.push(`--exclude=${shq(g)}`);
  args.push('--exclude-dir=.git', '-e', shq(q.query), '--', '.');
  return args.join(' ');
}

/**
 * Exit 2 without any match is the user's 400 (as the sidecar) when a regex
 * was typed: rg always, grep unless the complaint is about unreadable files
 * (the message text is locale-dependent, so only the error class is tested).
 */
function searchFailure(res: RemoteExecResult, rg: boolean, regex: boolean): HttpException {
  const first = res.stderr.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  if (res.code === 2 && rg) return fail(400, (first || 'invalid search').slice(0, 300));
  if (res.code === 2 && regex && !/permission|denied|no such file|berechtigung|datei/i.test(first)) return fail(400, first.slice(0, 300));
  return fail(500, `search failed (exit ${String(res.code)}): ${res.stderr.trim().slice(0, STDERR_MAX_CHARS)}`);
}


/** Resolves once a (possibly destroyed) writable has emitted `close`. */
function waitClosed(w: Writable): Promise<void> {
  if (w.closed) return Promise.resolve();
  if (!w.destroyed) w.destroy();
  return new Promise<void>((resolve) => {
    if (w.closed) resolve();
    else w.once('close', () => resolve());
  });
}

/**
 * Download stream over an SFTP read: passes at most `size` bytes (a growing
 * log is sent as it was at the start, matching Content-Length), errors with
 * `RemoteError('timeout')` when the server sent no byte for `idleMs` while
 * the consumer was ready for data (a slow or paused consumer is not idle:
 * the timer is stopped while waiting for 'drain'), has no absolute limit,
 * and destroys the SFTP read when it is destroyed itself (client abort).
 */
function boundedDownload(src: Readable, size: number, idleMs: number, rel: string): Readable {
  const out = new PassThrough();
  let sent = 0;
  let finished = false;
  let timer: NodeJS.Timeout | undefined;
  const stop = (): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const arm = (): void => {
    stop();
    timer = setTimeout(() => {
      out.destroy(new RemoteError('timeout', `download ${rel}: no data for ${idleMs} ms`));
    }, idleMs);
  };
  const end = (): void => {
    if (finished) return;
    finished = true;
    stop();
    out.end();
    src.destroy();
  };
  src.on('data', (chunk: Buffer) => {
    if (finished) return;
    arm();
    const room = size - sent;
    if (chunk.length >= room) {
      if (room > 0) out.write(chunk.subarray(0, room));
      sent = size;
      end();
      return;
    }
    sent += chunk.length;
    if (!out.write(chunk)) {
      // Backpressure: waiting for the consumer, not for the server.
      stop();
      src.pause();
    }
  });
  out.on('drain', () => {
    if (finished) return;
    arm();
    src.resume();
  });
  src.on('end', end);
  src.on('error', (err: Error) => {
    stop();
    out.destroy(isRemoteError(err) ? err : new RemoteError('failure', `download ${rel}: ${err.message}`));
  });
  out.on('close', () => {
    stop();
    finished = true;
    src.destroy();
  });
  // Without a listener an idle timeout would crash the process; consumers
  // still get the error through their own listeners.
  out.on('error', () => undefined);
  if (size === 0) end();
  else arm();
  return out;
}
