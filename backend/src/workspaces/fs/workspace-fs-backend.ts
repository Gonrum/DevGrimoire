import { HttpException } from '@nestjs/common';
import type { Readable } from 'node:stream';
import type { parseGitStatus, parseRipgrepJson } from '../workspace-search-parse';

/** `symlink` is what the sidecar reports for links; the IDE already handles it. */
export interface FsEntry { path: string; type: 'file' | 'dir' | 'symlink'; size?: number }
export type FsSearchResult = ReturnType<typeof parseRipgrepJson> & { engine: 'rg' | 'grep' };
export type FsStatusResult = ReturnType<typeof parseGitStatus>;

/** Byte limits for one request; built once per request from `WorkspaceLimitsService`. */
export interface FsLimits {
  editorMaxBytes: number;
  downloadMaxBytes: number;
  /** Unset for containers: the sidecar keeps its own upload cap. */
  uploadMaxBytes?: number;
}

/** Result of `exec`; `exitCode` is null after a timeout, an abort or a cut-off output. */
export interface FsExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** stdout or stderr exceeded `maxOutputBytes` (each stream is capped on its own). */
  truncated: boolean;
  timedOut: boolean;
  aborted: boolean;
}

export interface FsExecOpts {
  timeoutMs: number;
  /** Aborting ends the running command (container: upstream abort; SSH: TERM + channel close). */
  signal?: AbortSignal;
  maxOutputBytes: number;
}

/** Same ceiling as the sidecar's `/exec` (`EXEC_MAX_TIMEOUT_MS`). */
export const FS_EXEC_MAX_TIMEOUT_MS = 600_000;
/** Spec default of `ws_exec` when no usable timeout is given. */
export const FS_EXEC_DEFAULT_TIMEOUT_MS = 60_000;
/** Fallback output cap per stream when no usable one is given (the LLM sees 64 KiB anyway). */
export const FS_EXEC_DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
/** Same command length limit as the sidecar. */
export const FS_EXEC_MAX_COMMAND_LENGTH = 8 * 1024;

/**
 * Shared input rules of `exec`: a non-empty command without NUL up to 8 KiB
 * (400 otherwise); timeout clamped to 1 ms .. 600 s (non-finite -> 60 s), output
 * cap >= 1 byte (non-finite or <= 0 -> 64 KiB).
 */
export function normaliseExecInput(command: string, opts: FsExecOpts): FsExecOpts {
  const bad = (message: string): HttpException => new HttpException({ error: message, message }, 400);
  if (typeof command !== 'string' || !command.trim()) throw bad('command must be a non-empty string');
  if (command.includes('\0')) throw bad('command must not contain NUL');
  if (command.length > FS_EXEC_MAX_COMMAND_LENGTH) throw bad(`command too long (max ${FS_EXEC_MAX_COMMAND_LENGTH})`);
  const timeoutMs = Number.isFinite(opts.timeoutMs)
    ? Math.min(Math.max(Math.floor(opts.timeoutMs), 1), FS_EXEC_MAX_TIMEOUT_MS)
    : FS_EXEC_DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = Number.isFinite(opts.maxOutputBytes) && Math.floor(opts.maxOutputBytes) >= 1
    ? Math.floor(opts.maxOutputBytes)
    : FS_EXEC_DEFAULT_MAX_OUTPUT_BYTES;
  return { timeoutMs, maxOutputBytes, ...(opts.signal ? { signal: opts.signal } : {}) };
}

/**
 * File operations behind the IDE routes. Implementations return data or
 * streams and throw `HttpException`s in the shape the IDE expects
 * (`{ error, message, currentHash? }`, status 400/404/409/413/415).
 */
export interface WorkspaceFsBackend {
  listDir(path: string): Promise<{ entries: FsEntry[]; truncated: boolean }>;
  readText(path: string, limits: FsLimits): Promise<{ content: string; hash: string; size: number }>;
  readStream(path: string, limits: FsLimits): Promise<{ stream: Readable; size: number }>;
  writeText(
    path: string,
    content: string,
    opts: { baseHash: string | null; force: boolean },
    limits: FsLimits,
  ): Promise<{ hash: string }>;
  mkdir(path: string): Promise<{ path: string }>;
  move(from: string, to: string): Promise<{ from: string; to: string }>;
  remove(path: string): Promise<void>;
  upload(
    dir: string,
    fileName: string,
    source: Readable,
    opts: { size?: number; overwrite: boolean },
  ): Promise<{ path: string; size: number }>;
  search(q: {
    query: string;
    regex: boolean;
    caseSensitive: boolean;
    include?: string[];
    exclude?: string[];
  }): Promise<FsSearchResult>;
  status(): Promise<FsStatusResult>;
  /**
   * Runs a shell command line in the workspace directory, without a PTY.
   * Container: sidecar `/exec/stream` with the same env as `workspace_exec`;
   * SSH: the held session, no env, never retried.
   */
  exec(command: string, opts: FsExecOpts): Promise<FsExecResult>;
}
