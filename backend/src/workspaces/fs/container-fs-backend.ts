import { HttpException } from '@nestjs/common';
import type { Readable } from 'node:stream';
import type { WorkspaceClient } from '../workspace-client.service';
import { parseGitStatus, parseRipgrepJson } from '../workspace-search-parse';
import type {
  FsLimits,
  FsSearchResult,
  FsStatusResult,
  WorkspaceFsBackend,
} from './workspace-fs-backend';

const SEARCH_LIMIT = 2000;

/** Container workspaces: every operation is one call to the sidecar. */
export class ContainerFsBackend implements WorkspaceFsBackend {
  constructor(
    private readonly client: WorkspaceClient,
    private readonly workspaceId: string,
  ) {}

  async listDir(path: string) {
    const res = await this.client.listDir(this.workspaceId, path);
    const entries = res.entries.map((e) => ({
      path: e.path,
      type: e.type,
      ...(e.size !== undefined ? { size: e.size } : {}),
    }));
    return { entries, truncated: res.truncated };
  }

  async readText(path: string, limits: FsLimits) {
    const res = await this.client.readText(this.workspaceId, path, limits.editorMaxBytes);
    return { content: res.content, hash: res.hash, size: res.size };
  }

  readStream(path: string, limits: FsLimits): Promise<{ stream: Readable; size: number }> {
    return this.client.readStream(this.workspaceId, path, { httpErrors: true, maxBytes: limits.downloadMaxBytes });
  }

  async writeText(
    path: string,
    content: string,
    opts: { baseHash: string | null; force: boolean },
    limits: FsLimits,
  ) {
    const res = await this.client.writeText(this.workspaceId, path, content, {
      baseHash: opts.baseHash,
      force: opts.force,
      maxBytes: limits.editorMaxBytes,
    });
    return { hash: res.hash };
  }

  async mkdir(path: string) {
    const res = await this.client.mkdir(this.workspaceId, path);
    return { path: res.path };
  }

  async move(from: string, to: string) {
    const res = await this.client.move(this.workspaceId, from, to);
    return { from: res.from, to: res.to };
  }

  async remove(path: string): Promise<void> {
    await this.client.remove(this.workspaceId, path);
  }

  async upload(dir: string, fileName: string, source: Readable, opts: { size?: number; overwrite: boolean }) {
    // A trailing slash makes the sidecar treat the path as a directory target.
    const dirTarget = `${dir.replace(/\/+$/, '') || '.'}/`;
    const result = await this.client.writeStream(this.workspaceId, dirTarget, source, {
      fileName,
      size: opts.size,
      noOverwrite: !opts.overwrite,
      httpErrors: true,
    });
    return { path: result.path, size: result.size };
  }

  async search(q: {
    query: string;
    regex: boolean;
    caseSensitive: boolean;
    include?: string[];
    exclude?: string[];
  }): Promise<FsSearchResult> {
    const res = await this.client.searchJson(this.workspaceId, {
      query: q.query,
      fixedStrings: !q.regex,
      caseSensitive: q.caseSensitive,
      include: q.include,
      exclude: q.exclude,
    });
    const parsed = parseRipgrepJson(res.matches, SEARCH_LIMIT);
    return { matches: parsed.matches, truncated: parsed.truncated || res.truncated === true, engine: 'rg' };
  }

  async status(): Promise<FsStatusResult> {
    try {
      const res = await this.client.statusFs(this.workspaceId);
      return parseGitStatus(res.status);
    } catch (err: unknown) {
      // The sidecar answers 409 for a workspace without a git repository.
      if (err instanceof HttpException && err.getStatus() === 409) return { branch: null, changed: [] };
      throw err;
    }
  }
}
