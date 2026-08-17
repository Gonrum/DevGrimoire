import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { isAxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';
import { Readable } from 'node:stream';
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
export interface TreeEntry { path: string; type: 'file' | 'dir' | 'symlink' }
export interface TreeResponse { root: string; depth: number; truncated: boolean; entries: TreeEntry[] }
export interface SearchResponse { matches: string; truncated: boolean; timedOut: boolean }
export interface StatusResponse { status: string }
export interface SizeResponse { sizeBytes: number }
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

  clone(workspaceId: string, repoUrl: string, branch?: string): Promise<CloneResponse> {
    return this.post<CloneResponse>('/clone', { workspaceId, repoUrl, branch }, this.cloneTimeoutMs);
  }

  pull(workspaceId: string): Promise<PullResponse> {
    return this.post<PullResponse>('/pull', { workspaceId }, this.cloneTimeoutMs);
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
   */
  async readStream(
    workspaceId: string,
    path: string,
  ): Promise<{ stream: Readable; size: number }> {
    if (!this.token) {
      throw new ServiceUnavailableException(
        'Workspace sidecar is not configured — set WORKSPACE_API_TOKEN to enable workspace_* tools',
      );
    }
    const res = await fetch(`${this.baseUrl}/read-stream`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ workspaceId, path }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`sidecar ${res.status} /read-stream: ${text}`);
    }
    if (!res.body) throw new Error('sidecar /read-stream: empty response body');
    if (!isWebReadableStream(res.body)) {
      throw new Error('sidecar /read-stream: response body is not a web stream');
    }
    const size = Number.parseInt(res.headers.get('content-length') ?? '0', 10);
    const stream = Readable.fromWeb(res.body);
    return { stream, size: Number.isNaN(size) ? 0 : size };
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
   */
  async execStream(
    workspaceId: string,
    command: string,
    timeoutMs: number | undefined,
    env: Record<string, string> | undefined,
    abortSignal: AbortSignal,
    onEvent: (event: Record<string, unknown>) => void,
  ): Promise<void> {
    if (!this.token) {
      throw new ServiceUnavailableException(
        'Workspace sidecar is not configured — set WORKSPACE_API_TOKEN to enable workspace_* tools',
      );
    }
    const limit = Math.min(timeoutMs ?? 60_000, 600_000);
    const url = `${this.baseUrl}/exec/stream`;
    const body = JSON.stringify({ workspaceId, command, timeout: limit, env });
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
