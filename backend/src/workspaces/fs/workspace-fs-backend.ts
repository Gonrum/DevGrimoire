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
}
