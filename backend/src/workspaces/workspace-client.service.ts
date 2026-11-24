import { HttpService } from '@nestjs/axios';
import { ConflictException, HttpException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { isAxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';
import { pipeline, Readable, Transform } from 'node:stream';
import * as http from 'node:http';
import * as https from 'node:https';
import { errorMessage, errorWithCause, isNullaryMethod, isRecord } from '../common/narrow';

/**
 * Fehler mit angehängter Ursache.
 *
 * `new Error(msg, { cause })` bräuchte `lib: es2022`; das Backend kompiliert
 * gegen `target: ES2021`, wo die Überladung nicht existiert. Die Property
 * direkt zu setzen ist zur Laufzeit dasselbe (Node 22 liest `err.cause`).
 */
/**
 * `fetch()` liefert den DOM-`ReadableStream`, `Readable.fromWeb` erwartet den
 * aus `node:stream/web`. Zur Laufzeit ist das dasselbe Objekt, die Typen sind
 * aber nicht ineinander zuweisbar (`value` ist im Read-Result einmal optional,
 * einmal erforderlich). Statt das per Assertion zu übergehen prüft dieses
 * Prädikat die Eigenschaft, auf die `fromWeb` sich stützt: `getReader`.
 */
function isWebReadableStream(
  value: unknown,
): value is import('node:stream/web').ReadableStream {
  return isRecord(value) && isNullaryMethod(value.getReader);
}

export interface SidecarProcessResult {
  exitCode: number | null;
  signal?: string | null;
  timedOut?: boolean;
  truncated?: boolean;
  stdout?: string;
  stderr?: string;
}

export interface CloneResponse extends SidecarProcessResult { ok: true }
export interface PullResponse extends SidecarProcessResult { ok: true }
export interface ReadResponse { size: number; content: string }
export interface ReadTextResponse { size: number; content: string; hash: string }
export interface WriteTextResponse { path: string; hash: string; size: number }

/** Sidecar status codes the IDE routes hand through to the browser unchanged. */
/** A download is aborted when no byte flowed for this long (no absolute limit). */
export const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;

const PASSTHROUGH_STATUSES: ReadonlySet<number> = new Set([400, 404, 409, 413, 415]);
/**
 * Body of a forwarded sidecar error. The sidecar answers `{ error: '…' }`;
 * the frontend reads `message` (Nest's convention), so the error text is
 * copied there. All sidecar keys (`error`, `currentHash`, …) stay as sent.
 */
function forwardedErrorBody(data: unknown, fallback: string): Record<string, unknown> {
  const body: Record<string, unknown> = isRecord(data) ? { ...data } : { error: fallback };
  const text = typeof body.error === 'string' && body.error ? body.error : fallback;
  return { ...body, message: text };
}

/** Error text of a raw sidecar response body (JSON `{ error }` or plain text). */
function sidecarErrorText(text: string, fallback: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed) && typeof parsed.error === 'string' && parsed.error) return parsed.error;
  } catch { /* not JSON */ }
  return text || fallback;
}

export interface TreeEntry { path: string; type: 'file' | 'dir' | 'symlink'; size?: number }
export interface TreeResponse { root: string; depth: number; truncated: boolean; entries: TreeEntry[] }
export interface SearchResponse { matches: string; truncated: boolean; timedOut: boolean }
export interface StatusResponse { status: string }
export interface SizeResponse { sizeBytes: number }
export interface WriteStreamResponse { ok: true; path: string; size: number }
export interface ExecResponse {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  killedAt?: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

/**
 * HTTP client for the workspace sidecar. The sidecar runs on the
 * internal `workspace-api-net` Docker network and is configured via
 * WORKSPACE_API_URL + WORKSPACE_API_TOKEN env vars (set by compose).
 *
 * Callers MUST validate the workspaceId against the local DB before
 * invoking — the sidecar only enforces format-level safety (slug/ObjectId
 * pattern + path-traversal guard), not ownership or existence in our
 * Mongo. See T-146 design notes.
 */
@Injectable()
export class WorkspaceClient {
  private readonly logger = new Logger(WorkspaceClient.name);
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly defaultTimeoutMs = 60_000;
  private readonly cloneTimeoutMs = 5 * 60_000;

  constructor(private readonly http: HttpService) {
    this.baseUrl = (process.env.WORKSPACE_API_URL || 'http://workspace:9000').replace(/\/$/, '');
    this.token = process.env.WORKSPACE_API_TOKEN || '';
  }

  isConfigured(): boolean {
    return Boolean(this.token);
  }

  private async post<T>(endpoint: string, body: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    if (!this.token) {
      throw new ServiceUnavailableException(
        'Workspace sidecar is not configured — set WORKSPACE_API_TOKEN to enable workspace_* tools',
      );
    }
    try {
      const response = await firstValueFrom(
        this.http.post<T>(`${this.baseUrl}${endpoint}`, body, {
          headers: { Authorization: `Bearer ${this.token}` },
          timeout: timeoutMs ?? this.defaultTimeoutMs,
        }),
      );
      return response.data;
    } catch (err: unknown) {
      // `isAxiosError` ist die Laufzeitprüfung der Bibliothek selbst — vorher
      // wurde der Fehler blind als AxiosError behauptet und nur an `.response`
      // erkannt.
      if (isAxiosError<{ error?: string }>(err) && err.response) {
        const remoteMsg = err.response.data?.error || err.response.statusText;
        throw errorWithCause(
          `sidecar ${err.response.status} ${endpoint}: ${remoteMsg}`,
          err,
        );
      }
      const msg = errorMessage(err);
      this.logger.warn(`sidecar transport error on ${endpoint}: ${msg}`);
      throw new ServiceUnavailableException(
        `workspace sidecar unreachable at ${this.baseUrl} (${msg})`,
      );
    }
  }

  /**
   * Like `post`, but a sidecar 400/404/409/413/415 reaches the caller as an
   * HttpException with the same status AND the sidecar's JSON body (the IDE
   * needs `currentHash` from a write conflict). Everything else behaves as in
   * `post`. Used only by the IDE file operations; older callers keep `post`.
   */
  private async postFs<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    try {
      return await this.post<T>(endpoint, body);
    } catch (err: unknown) {
      const cause = isRecord(err) ? err.cause : undefined;
      if (isAxiosError(cause) && cause.response && PASSTHROUGH_STATUSES.has(cause.response.status)) {
        const data: unknown = cause.response.data;
        throw new HttpException(
          forwardedErrorBody(data, cause.response.statusText),
          cause.response.status,
        );
      }
      throw err;
    }
  }

  /**
   * `auth` travels beside the URL, never inside it: the sidecar gives it to
   * git via the clone process's env, so it never lands in `.git/config`.
   */
  clone(
    workspaceId: string,
    repoUrl: string,
    branch?: string,
    auth?: { username: string; password: string } | null,
  ): Promise<CloneResponse> {
    return this.post<CloneResponse>(
      '/clone',
      { workspaceId, repoUrl, branch, ...(auth ? { auth } : {}) },
      this.cloneTimeoutMs,
    );
  }

  /** `gitEnv` = GH_TOKEN/GITLAB_TOKEN/… as `WorkspaceGitTokensService.resolveForWorkspace` returns it. */
  pull(workspaceId: string, gitEnv?: Record<string, string>): Promise<PullResponse> {
    return this.post<PullResponse>(
      '/pull',
      { workspaceId, ...(gitEnv && Object.keys(gitEnv).length ? { env: gitEnv } : {}) },
      this.cloneTimeoutMs,
    );
  }

  tree(workspaceId: string, path?: string, depth?: number): Promise<TreeResponse> {
    return this.post<TreeResponse>('/tree', { workspaceId, path, depth });
  }

  read(workspaceId: string, path: string): Promise<ReadResponse> {
    return this.post<ReadResponse>('/read', { workspaceId, path });
  }

  /** Binary-safe read — returns base64. Used by workspace_attachment_save to
   *  forward arbitrary files (zip, png, apk, ...) to MinIO without UTF-8 mangling. */
  readBase64(workspaceId: string, path: string): Promise<{ size: number; contentBase64: string }> {
    return this.post<{ size: number; contentBase64: string }>(
      '/read-base64',
      { workspaceId, path },
    );
  }

  /**
   * Streaming binary read for large files. Uses native fetch (like execStream)
   * so the body is not buffered; returns a Node Readable plus the declared
   * size from Content-Length. Throws ServiceUnavailable if the sidecar is
   * unconfigured, Error on non-2xx.
   *
   * There is no absolute timeout: a log of several GB may take as long as the
   * link needs. Instead the transfer is aborted once no byte has flowed for
   * `DOWNLOAD_IDLE_TIMEOUT_MS`, and destroying the returned stream aborts the
   * upstream request. `maxBytes` (download limit) is optional; without it the
   * sidecar's STREAM_MAX_BYTES applies.
   */
  async readStream(
    workspaceId: string,
    path: string,
    opts: { httpErrors?: boolean; maxBytes?: number } = {},
  ): Promise<{ stream: Readable; size: number }> {
    if (!this.token) {
      throw new ServiceUnavailableException(
        'Workspace sidecar is not configured — set WORKSPACE_API_TOKEN to enable workspace_* tools',
      );
    }
    const abort = new AbortController();
    // Idle watchdog: armed while waiting for the response headers, re-armed on
    // every chunk, cleared when the stream ends or is destroyed.
    let idleFired = false;
    let idleTimer: NodeJS.Timeout | undefined;
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleFired = true;
        abort.abort();
        ref.stream?.destroy(new Error(`sidecar download idle for ${DOWNLOAD_IDLE_TIMEOUT_MS / 1000}s`));
      }, DOWNLOAD_IDLE_TIMEOUT_MS);
    };
    const disarmIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = undefined;
    };
    const ref: { stream?: Readable } = {};
    armIdle();
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/read-stream`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ workspaceId, path, maxBytes: opts.maxBytes }),
        signal: abort.signal,
      });
    } catch (err: unknown) {
      disarmIdle();
      if (idleFired) throw errorWithCause('sidecar /read-stream: no response (idle timeout)', err);
      throw err;
    }
    if (!res.ok) {
      // Keep the idle timer armed while the error body is read: a sidecar that
      // sends headers and then stalls must not hang this call forever.
      const text = await res.text().catch(() => res.statusText);
      disarmIdle();
      // IDE download: let the browser see the sidecar's 400/404/413 instead of a 500.
      if (opts.httpErrors && PASSTHROUGH_STATUSES.has(res.status)) {
        let parsed: unknown;
        try { parsed = JSON.parse(text); } catch { parsed = undefined; }
        throw new HttpException(
          isRecord(parsed)
            ? forwardedErrorBody(parsed, res.statusText)
            : { error: text || res.statusText, message: sidecarErrorText(text, res.statusText) },
          res.status,
        );
      }
      throw new Error(`sidecar ${res.status} /read-stream: ${text}`);
    }
    if (!res.body) {
      disarmIdle();
      throw new Error('sidecar /read-stream: empty response body');
    }
    if (!isWebReadableStream(res.body)) {
      disarmIdle();
      throw new Error('sidecar /read-stream: response body is not a web stream');
    }
    const size = Number.parseInt(res.headers.get('content-length') ?? '0', 10);
    // A pass-through (not a 'data' listener, which would start flowing before
    // the consumer is attached) re-arms the idle timer per chunk and keeps
    // backpressure intact. pipeline() forwards a destroy upstream.
    const source = Readable.fromWeb(res.body);
    const watched = new Transform({
      transform(chunk, _enc, cb) {
        armIdle();
        cb(null, chunk);
      },
    });
    pipeline(source, watched, () => undefined);
    ref.stream = watched;
    // Closing the stream (client left, idle timeout, end) cancels the upstream request.
    watched.on('close', () => {
      disarmIdle();
      abort.abort();
    });
    return { stream: watched, size: Number.isNaN(size) ? 0 : size };
  }

  /**
   * Counterpart of readStream: writes `source` as a file into the workspace
   * without buffering (`dg scp host:… ./…`). `node:http` instead of fetch,
   * because a Node Readable as fetch body would need `duplex: 'half'` and an
   * assertion to BodyInit. The sidecar writes to a temporary file and only
   * renames it once fully received.
   */
  async writeStream(
    workspaceId: string,
    path: string,
    source: Readable,
    opts: { fileName?: string; size?: number; mode?: number; createDirs?: boolean; noOverwrite?: boolean; httpErrors?: boolean } = {},
  ): Promise<WriteStreamResponse> {
    if (!this.token) {
      try { source.destroy(); } catch { /* noop */ }
      throw new ServiceUnavailableException(
        'Workspace sidecar is not configured — set WORKSPACE_API_TOKEN to enable workspace_* tools',
      );
    }
    const url = new URL(`${this.baseUrl}/write-stream`);
    url.searchParams.set('workspaceId', workspaceId);
    url.searchParams.set('path', path);
    if (opts.fileName !== undefined) url.searchParams.set('fileName', opts.fileName);
    if (opts.size !== undefined) url.searchParams.set('size', String(opts.size));
    if (opts.mode !== undefined) url.searchParams.set('mode', String(opts.mode));
    if (opts.createDirs) url.searchParams.set('createDirs', '1');
    if (opts.noOverwrite) url.searchParams.set('noOverwrite', '1');
    const transport = url.protocol === 'https:' ? https : http;

    return new Promise<WriteStreamResponse>((resolve, reject) => {
      let settled = false;
      // `answered`: the sidecar itself answered with an error (not a transport
      // failure). With `httpErrors` the source may be a server request whose
      // socket carries our own HTTP answer; destroying it would reset the
      // connection instead of letting the 409 through. Stop piping and drain.
      const finish = (err: Error | null, value?: WriteStreamResponse, answered = false) => {
        if (settled) return;
        settled = true;
        if (err) {
          if (answered && opts.httpErrors) {
            source.unpipe(req);
            source.resume();
            req.destroy();
          } else {
            try { source.destroy(); } catch { /* noop */ }
          }
          reject(err);
        } else if (value) {
          resolve(value);
        }
      };
      const req = transport.request(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/octet-stream',
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('error', (err) => finish(err));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body: unknown;
          try { body = JSON.parse(text); } catch { body = undefined; }
          const status = res.statusCode ?? 0;
          if (opts.httpErrors && PASSTHROUGH_STATUSES.has(status)) {
            finish(new HttpException(forwardedErrorBody(body, text || res.statusMessage || 'sidecar error'), status), undefined, true);
            return;
          }
          if (opts.noOverwrite && status === 409) {
            finish(new ConflictException('target exists'));
            return;
          }
          if (status < 200 || status >= 300) {
            const remote = isRecord(body) && typeof body.error === 'string' ? body.error : text || res.statusMessage;
            finish(new Error(`sidecar ${status} /write-stream: ${remote}`));
            return;
          }
          if (!isRecord(body) || typeof body.path !== 'string' || typeof body.size !== 'number') {
            finish(new Error('sidecar /write-stream: unexpected response'));
            return;
          }
          finish(null, { ok: true, path: body.path, size: body.size });
        });
      });
      req.on('error', (err) => {
        this.logger.warn(`sidecar transport error on /write-stream: ${err.message}`);
        finish(new ServiceUnavailableException(`workspace sidecar unreachable at ${this.baseUrl} (${err.message})`));
      });
      // If the source fails (SFTP error, limit), the sidecar must not treat
      // the partial file as complete: abort the request instead of ending it.
      source.on('error', (err: Error) => {
        req.destroy(err);
        finish(err);
      });
      // A destroy() without error (timeout in the caller) only fires 'close'.
      // Without this branch the request would stay half open and the sidecar
      // would wait forever for the rest of the body.
      let ended = false;
      source.on('end', () => { ended = true; });
      source.on('close', () => {
        if (ended) return;
        const err = new Error('source closed before end of file');
        req.destroy(err);
        finish(err);
      });
      source.pipe(req);
    });
  }

  /** Creates the workspace directory in the sidecar if it is missing (idempotent). */
  async ensureDir(workspaceId: string): Promise<void> {
    await this.postFs<{ ok: true }>('/ensure', { workspaceId });
  }

  /** `maxBytes` (editor limit) is optional: without it the sidecar's own READ_MAX_BYTES applies. */
  readText(workspaceId: string, path: string, maxBytes?: number): Promise<ReadTextResponse> {
    return this.postFs<ReadTextResponse>('/read', { workspaceId, path, strictText: true, maxBytes });
  }

  /** `baseHash` is always sent (string or null): the sidecar rejects an omitted field. */
  writeText(
    workspaceId: string,
    path: string,
    content: string,
    opts: { baseHash: string | null; force?: boolean; createDirs?: boolean; maxBytes?: number },
  ): Promise<WriteTextResponse> {
    return this.postFs<WriteTextResponse>('/write', {
      workspaceId,
      path,
      content,
      baseHash: opts.baseHash,
      force: opts.force,
      createDirs: opts.createDirs,
      maxBytes: opts.maxBytes,
    });
  }

  listDir(workspaceId: string, path: string): Promise<TreeResponse> {
    return this.postFs<TreeResponse>('/tree', { workspaceId, path, depth: 1, withSize: true });
  }

  mkdir(workspaceId: string, path: string): Promise<{ ok: true; path: string }> {
    return this.postFs<{ ok: true; path: string }>('/mkdir', { workspaceId, path });
  }

  move(workspaceId: string, from: string, to: string): Promise<{ ok: true; from: string; to: string }> {
    return this.postFs<{ ok: true; from: string; to: string }>('/move', { workspaceId, from, to });
  }

  remove(workspaceId: string, path: string): Promise<{ ok: true; path: string }> {
    return this.postFs<{ ok: true; path: string }>('/delete', { workspaceId, path });
  }

  /** ripgrep `--json` NDJSON in `matches`; parse with `parseRipgrepJson`. */
  searchJson(
    workspaceId: string,
    q: { query: string; fixedStrings: boolean; caseSensitive: boolean; include?: string[]; exclude?: string[] },
  ): Promise<SearchResponse> {
    return this.postFs<SearchResponse>('/search', { workspaceId, ...q, json: true });
  }

  /** Raw status call for the IDE: a 409 (no git repo) reaches the caller as such. */
  statusFs(workspaceId: string): Promise<StatusResponse> {
    return this.postFs<StatusResponse>('/status', { workspaceId });
  }

  search(workspaceId: string, query: string, include?: string[], exclude?: string[]): Promise<SearchResponse> {
    return this.post<SearchResponse>('/search', { workspaceId, query, include, exclude });
  }

  status(workspaceId: string): Promise<StatusResponse> {
    return this.post<StatusResponse>('/status', { workspaceId });
  }

  cleanup(workspaceId: string): Promise<{ ok: boolean; removed: boolean }> {
    return this.post<{ ok: boolean; removed: boolean }>('/cleanup', { workspaceId });
  }

  size(workspaceId: string): Promise<SizeResponse> {
    return this.post<SizeResponse>('/size', { workspaceId });
  }

  exec(
    workspaceId: string,
    command: string,
    timeoutMs?: number,
    env?: Record<string, string>,
  ): Promise<ExecResponse> {
    // HTTP timeout includes the sidecar's grace period after SIGTERM (5s)
    // plus a small buffer so we never undercut the in-process timer.
    const limit = Math.min(timeoutMs ?? 60_000, 600_000);
    return this.post<ExecResponse>(
      '/exec',
      { workspaceId, command, timeout: limit, env },
      limit + 10_000,
    );
  }

  /**
   * Streams /exec/stream NDJSON events from the sidecar to `onEvent`.
   * Uses native fetch (Node 20+) so we can iterate the response body
   * without buffering. abortSignal cancels the upstream request, which
   * makes the sidecar's req.on('close') fire and SIGKILL the child.
   *
   * `opts.cwdState: false` runs the command in the workspace root without
   * reading or writing the cwd state the terminal and workspace_exec share.
   */
  async execStream(
    workspaceId: string,
    command: string,
    timeoutMs: number | undefined,
    env: Record<string, string> | undefined,
    abortSignal: AbortSignal,
    onEvent: (event: Record<string, unknown>) => void,
    opts: { cwdState?: boolean; fullOutput?: boolean } = {},
  ): Promise<void> {
    if (!this.token) {
      throw new ServiceUnavailableException(
        'Workspace sidecar is not configured — set WORKSPACE_API_TOKEN to enable workspace_* tools',
      );
    }
    const limit = Math.min(timeoutMs ?? 60_000, 600_000);
    const url = `${this.baseUrl}/exec/stream`;
    const body = JSON.stringify({
      workspaceId,
      command,
      timeout: limit,
      env,
      ...(opts.cwdState === false ? { cwdState: false } : {}),
      // No 1 MiB per-stream cap in the sidecar: the caller keeps head + tail itself.
      ...(opts.fullOutput === true ? { fullOutput: true } : {}),
    });
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body,
      signal: abortSignal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`sidecar ${res.status} /exec/stream: ${text}`);
    }
    if (!res.body) throw new Error('sidecar /exec/stream: empty response body');
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            // NDJSON-Events sind Objekte. Ein skalarer oder Array-Wert wäre
            // kein Event und wird — wie eine kaputte Zeile — übersprungen,
            // statt als `any` an onEvent durchzulaufen.
            const parsed: unknown = JSON.parse(trimmed);
            if (isRecord(parsed)) onEvent(parsed);
          } catch {
            // skip malformed line — sidecar should never produce them
          }
        }
      }
      if (buf.trim()) {
        try {
          const parsed: unknown = JSON.parse(buf.trim());
          if (isRecord(parsed)) onEvent(parsed);
        } catch { /* skip */ }
      }
    } finally {
      try { reader.releaseLock(); } catch { /* noop */ }
    }
  }
}
