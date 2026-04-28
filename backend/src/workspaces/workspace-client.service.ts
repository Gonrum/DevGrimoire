import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { AxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';

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
    } catch (err) {
      const ax = err as AxiosError<{ error?: string }>;
      if (ax.response) {
        const remoteMsg = ax.response.data?.error || ax.response.statusText;
        throw new Error(`sidecar ${ax.response.status} ${endpoint}: ${remoteMsg}`);
      }
      this.logger.warn(`sidecar transport error on ${endpoint}: ${(err as Error).message}`);
      throw new ServiceUnavailableException(
        `workspace sidecar unreachable at ${this.baseUrl} (${(err as Error).message})`,
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
            onEvent(JSON.parse(trimmed));
          } catch {
            // skip malformed line — sidecar should never produce them
          }
        }
      }
      if (buf.trim()) {
        try { onEvent(JSON.parse(buf.trim())); } catch { /* skip */ }
      }
    } finally {
      try { reader.releaseLock(); } catch { /* noop */ }
    }
  }
}
