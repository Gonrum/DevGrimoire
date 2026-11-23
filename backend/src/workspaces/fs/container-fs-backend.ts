import { HttpException } from '@nestjs/common';
import type { Readable } from 'node:stream';
import type { WorkspaceClient } from '../workspace-client.service';
import { parseGitStatus, parseRipgrepJson } from '../workspace-search-parse';
import { normaliseExecInput } from './workspace-fs-backend';
import { HeadTailOutput } from './head-tail-output';
import type {
  FsExecOpts,
  FsExecResult,
  FsLimits,
  FsSearchResult,
  FsStatusResult,
  WorkspaceFsBackend,
} from './workspace-fs-backend';

const SEARCH_LIMIT = 2000;
/**
 * Local backstop on top of the sidecar's own timeout (which kills the
 * process group after timeout + 5 s): a sidecar that stops answering must not
 * hold the call forever.
 */
const EXEC_BACKSTOP_MS = 15_000;

/**
 * Lines of one stream into a head + rolling tail collector: `\n` between
 * lines, none after a `partial` piece (the sidecar splits long lines).
 */
class StreamLines {
  private joinNext = false;
  constructor(readonly out: HeadTailOutput) {}

  add(line: string, partial = false): void {
    this.out.push(this.joinNext ? `\n${line}` : line);
    this.joinNext = !partial;
  }
}

/** Env of a command run in this workspace; resolved per call (DG token TTL). */
export type ContainerExecEnv = () => Promise<Record<string, string> | undefined>;

/** Container workspaces: every operation is one call to the sidecar. */
export class ContainerFsBackend implements WorkspaceFsBackend {
  constructor(
    private readonly client: WorkspaceClient,
    private readonly workspaceId: string,
    private readonly execEnv: ContainerExecEnv = () => Promise.resolve(undefined),
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

  async exec(command: string, opts: FsExecOpts): Promise<FsExecResult> {
    const { timeoutMs, maxOutputBytes, signal } = normaliseExecInput(command, opts);
    // Head + rolling tail per stream; the sidecar sends the whole output
    // (`fullOutput`), so the end of a long log is kept.
    const stdout = new StreamLines(new HeadTailOutput(maxOutputBytes));
    const stderr = new StreamLines(new HeadTailOutput(maxOutputBytes));
    let exitCode: number | null = null;
    let timedOut = false;
    let sidecarTruncated = false;
    const result = (aborted: boolean): FsExecResult => ({
      exitCode: aborted ? null : exitCode,
      stdout: stdout.out.text(),
      stderr: stderr.out.text(),
      truncated: stdout.out.truncated || stderr.out.truncated || sidecarTruncated,
      timedOut,
      aborted,
    });
    if (signal?.aborted) return result(true);

    const env = await this.execEnv();
    // Aborted while the env was resolved: the listener below would never fire.
    if (signal?.aborted) return result(true);
    // Our own controller: aborted by the caller's signal or by the backstop.
    const upstream = new AbortController();
    const onAbort = (): void => upstream.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let backstopHit = false;
    const backstop = setTimeout(() => {
      backstopHit = true;
      upstream.abort();
    }, timeoutMs + EXEC_BACKSTOP_MS);
    try {
      await this.client.execStream(this.workspaceId, command, timeoutMs, env, upstream.signal, (ev) => {
        switch (ev.type) {
          case 'stdout':
            if (typeof ev.line === 'string') stdout.add(ev.line, ev.partial === true);
            break;
          case 'stderr':
            if (typeof ev.line === 'string') stderr.add(ev.line, ev.partial === true);
            break;
          case 'truncated':
            sidecarTruncated = true;
            break;
          case 'error':
            // The sidecar could not start the command (spawn failure): no exit
            // code; the message goes to stderr with a marker so it cannot be
            // mistaken for output of the command.
            stderr.add(`[sidecar] ${typeof ev.message === 'string' ? ev.message : 'exec failed'}`);
            break;
          case 'done':
            exitCode = typeof ev.exitCode === 'number' ? ev.exitCode : null;
            timedOut = ev.timedOut === true;
            if (ev.stdoutTruncated === true || ev.stderrTruncated === true) sidecarTruncated = true;
            break;
          default:
            break;
        }
      }, { cwdState: false, fullOutput: true });
    } catch (err: unknown) {
      if (signal?.aborted) return result(true);
      if (backstopHit) {
        timedOut = true;
        return result(false);
      }
      throw err;
    } finally {
      clearTimeout(backstop);
      signal?.removeEventListener('abort', onAbort);
    }
    // An abort racing the end of the stream still counts as aborted.
    return result(signal?.aborted === true && exitCode === null);
  }
}
