import type { Readable, Writable } from 'node:stream';

/** Idle time after the last activity before a held session is closed. */
export const SSH_SESSION_IDLE_MS = 120_000;
/** Concurrent `exec` channels per held session (stays below sshd's MaxSessions). */
export const SSH_SESSION_MAX_EXEC = 2;
/** Absolute timeout for one SFTP single operation and one `exec`. */
export const SSH_SESSION_OP_TIMEOUT_MS = 20_000;
/** Default per-stream output cap of `exec` (stdout and stderr each). */
export const SSH_EXEC_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export interface RemoteStat {
  size: number;
  mode: number;
  uid: number;
  gid: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
}

/** `stat` of a directory entry is lstat-like (links are not followed). */
export interface RemoteDirEntry { name: string; stat: RemoteStat }

export interface RemoteFs {
  /** Follows symlinks. */
  stat(p: string): Promise<RemoteStat>;
  lstat(p: string): Promise<RemoteStat>;
  realpath(p: string): Promise<string>;
  readdir(p: string): Promise<RemoteDirEntry[]>;
  /** Rejects with code `too_large` above `maxBytes`. */
  readFile(p: string, maxBytes: number): Promise<Buffer>;
  createReadStream(p: string): Readable;
  writeFile(p: string, data: Buffer, mode: number): Promise<void>;
  createWriteStream(p: string, mode: number): Writable;
  /** Fails with code `exists` if the target exists. */
  rename(from: string, to: string): Promise<void>;
  /** `false` = the server does not offer posix-rename@openssh.com. */
  posixRename(from: string, to: string): Promise<boolean>;
  unlink(p: string): Promise<void>;
  mkdir(p: string): Promise<void>;
  chmod(p: string, mode: number): Promise<void>;
}

export interface RemoteExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export interface RemoteExecOpts { timeoutMs?: number; maxOutputBytes?: number }

export interface RemoteProbe { rg: boolean; git: boolean; uid: number; gid: number }

export interface RemoteSession {
  fs: RemoteFs;
  exec(command: string, opts?: RemoteExecOpts): Promise<RemoteExecResult>;
  /** Cached per session. */
  probe(): Promise<RemoteProbe>;
}

export type RemoteErrorCode =
  | 'not_found'
  | 'exists'
  | 'denied'
  | 'too_large'
  | 'timeout'
  | 'disconnected'
  | 'failure';

/** Error of a remote operation with a stable `code` (see `RemoteErrorCode`). */
export class RemoteError extends Error {
  constructor(public readonly code: RemoteErrorCode, message: string) {
    super(message);
    this.name = 'RemoteError';
  }
}

export function isRemoteError(err: unknown): err is RemoteError {
  return err instanceof RemoteError;
}

/**
 * Raw per-connection operations produced by the driver factory. The sessions
 * service wraps it with activity tracking, timeouts, the exec cap and the
 * probe cache, so a driver only has to talk to the server.
 */
export interface RemoteSessionDriver {
  fs: RemoteFs;
  exec(command: string, opts: Required<RemoteExecOpts>): Promise<RemoteExecResult>;
  /** Closes the driver's channels; the client itself is closed by the caller. */
  close(): void;
}

export interface RemoteDriverContext {
  /** The driver reports a lost channel (e.g. the SFTP subsystem closed). */
  onLost(err: Error): void;
}

/** Turns a ready ssh2 client into a driver; injected so checks can fake it. */
export type RemoteDriverFactory<C = unknown> = (
  client: C,
  ctx: RemoteDriverContext,
) => Promise<RemoteSessionDriver>;

/** One exec: which of rg/git exist, and the remote uid/gid. Parsed by `parseProbeOutput`. */
export const PROBE_COMMAND =
  'command -v rg >/dev/null 2>&1 && echo rg=1 || echo rg=0; '
  + 'command -v git >/dev/null 2>&1 && echo git=1 || echo git=0; '
  + 'echo "uid=$(id -u 2>/dev/null)"; '
  + 'echo "gid=$(id -g 2>/dev/null)"';

/** Tolerates shell noise (motd, CRLF); unknown values fall back to false / -1. */
export function parseProbeOutput(stdout: string): RemoteProbe {
  const flag = (name: string): boolean => new RegExp(`^${name}=1\\s*$`, 'm').test(stdout);
  const id = (name: string): number => {
    const m = new RegExp(`^${name}=(\\d+)\\s*$`, 'm').exec(stdout);
    const v = m ? Number(m[1]) : -1;
    return Number.isSafeInteger(v) ? v : -1;
  };
  return { rg: flag('rg'), git: flag('git'), uid: id('uid'), gid: id('gid') };
}
