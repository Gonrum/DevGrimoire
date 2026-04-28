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
}
