import { Injectable, Logger } from '@nestjs/common';
import { ProjectsService } from '../projects/projects.service';
import { SecretsService } from '../secrets/secrets.service';
import { WorkspaceDocument } from './schemas/workspace.schema';

/**
 * Resolves env vars (GH_TOKEN / GITLAB_TOKEN / GITLAB_HOST) for a workspace
 * by reading its project's `gitRepositories[]` and decrypting the linked
 * token secrets. The map is merged into the env passed to /exec, so `gh`
 * and `glab` inside the sidecar work without manual `gh auth login`.
 *
 * First repo per provider wins. Self-hosted GitLab `baseUrl` is normalised
 * to a host (no scheme, no path) since `glab` expects e.g. `gitlab.example.com`.
 */
@Injectable()
export class WorkspaceGitTokensService {
  private readonly logger = new Logger(WorkspaceGitTokensService.name);

  constructor(
    private readonly projects: ProjectsService,
    private readonly secrets: SecretsService,
  ) {}

  async resolveForWorkspace(workspace: WorkspaceDocument): Promise<Record<string, string>> {
    const env: Record<string, string> = {};
    let project;
    try {
      project = await this.projects.findById(workspace.projectId.toString());
    } catch {
      return env;
    }
    const repos = project.gitRepositories ?? [];
    if (!repos.length) return env;

    // Explicit gitRepoId wins — pick exactly that repo, ignore others. If the
    // referenced repo was deleted/renamed since the workspace was created, fall
    // through to the first-wins default so the workspace is not silently broken.
    if (workspace.gitRepoId) {
      const explicit = repos.find((r) => r._id?.toString() === workspace.gitRepoId);
      if (explicit?.tokenSecretId) {
        const token = await this.decrypt(explicit.tokenSecretId);
        if (token) {
          if (explicit.provider === 'github') {
            env.GH_TOKEN = token;
          } else if (explicit.provider === 'gitlab') {
            env.GITLAB_TOKEN = token;
            const host = normaliseGitlabHost(explicit.baseUrl);
            if (host) env.GITLAB_HOST = host;
          }
          return env;
        }
      }
      this.logger.warn(
        `workspace ${workspace._id.toString()} references missing gitRepoId ${workspace.gitRepoId} — falling back to default`,
      );
    }

    let ghDone = false;
    let glDone = false;

    for (const repo of repos) {
      if (!repo.tokenSecretId) continue;
      if (repo.provider === 'github' && !ghDone) {
        const token = await this.decrypt(repo.tokenSecretId);
        if (token) {
          env.GH_TOKEN = token;
          ghDone = true;
        }
      } else if (repo.provider === 'gitlab' && !glDone) {
        const token = await this.decrypt(repo.tokenSecretId);
        if (token) {
          env.GITLAB_TOKEN = token;
          const host = normaliseGitlabHost(repo.baseUrl);
          if (host) env.GITLAB_HOST = host;
          glDone = true;
        }
      }
      if (ghDone && glDone) break;
    }
    return env;
  }

  /**
   * Rewrites `repoUrl` to embed the matching git token so private clones
   * work without manual `https://oauth2:$TOKEN@host/...` gymnastics. Used by
   * `workspace_clone`. Returns the original URL unchanged if no token applies
   * (already-authenticated URL, host mismatch, or no token configured).
   *
   * Match priority:
   *   1. workspace.gitRepoId (explicit pin)
   *   2. host of repoUrl matches a project gitRepository's host
   *   3. provider deduced from URL (github.com → first GitHub repo, GitLab host → first GitLab repo)
   *
   * Token user prefix is provider-specific:
   *   - GitLab: `oauth2:<TOKEN>` (any username works with PAT)
   *   - GitHub: `x-access-token:<TOKEN>` (GitHub's accepted form for HTTPS)
   */
  async buildAuthenticatedCloneUrl(
    workspace: WorkspaceDocument,
    repoUrl: string,
  ): Promise<string> {
    if (!repoUrl) return repoUrl;
    let parsed: URL;
    try {
      parsed = new URL(repoUrl);
    } catch {
      return repoUrl;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return repoUrl;
    if (parsed.username || parsed.password) return repoUrl; // already authenticated

    let project;
    try {
      project = await this.projects.findById(workspace.projectId.toString());
    } catch {
      return repoUrl;
    }
    const repos = project.gitRepositories ?? [];
    if (!repos.length) return repoUrl;

    const matched = pickRepoForUrl(repos, parsed.host, workspace.gitRepoId);
    if (!matched?.tokenSecretId) return repoUrl;
    const token = await this.decrypt(matched.tokenSecretId);
    if (!token) return repoUrl;

    const userPrefix = matched.provider === 'github' ? 'x-access-token' : 'oauth2';
    parsed.username = userPrefix;
    parsed.password = encodeURIComponent(token);
    return parsed.toString();
  }

  private async decrypt(secretId: string): Promise<string | null> {
    try {
      const secret = await this.secrets.findById(secretId);
      return secret.value;
    } catch (err) {
      this.logger.warn(
        `git token secret ${secretId} could not be loaded: ${(err as Error).message}`,
      );
      return null;
    }
  }
}

interface RepoLike {
  _id?: { toString(): string } | string;
  provider: 'github' | 'gitlab';
  baseUrl?: string;
  tokenSecretId?: string;
}

function pickRepoForUrl<T extends RepoLike>(
  repos: T[],
  urlHost: string,
  explicitGitRepoId: string | undefined,
): T | null {
  if (explicitGitRepoId) {
    const explicit = repos.find((r) => idToString(r._id) === explicitGitRepoId);
    if (explicit) return explicit;
  }
  const hostMatch = repos.find((r) => {
    if (r.provider === 'github') return urlHost === 'github.com';
    const cfgHost = normaliseGitlabHost(r.baseUrl) ?? 'gitlab.com';
    return cfgHost === urlHost;
  });
  if (hostMatch) return hostMatch;
  if (urlHost === 'github.com') return repos.find((r) => r.provider === 'github') ?? null;
  return repos.find((r) => r.provider === 'gitlab') ?? null;
}

function idToString(id: unknown): string | null {
  if (!id) return null;
  if (typeof id === 'string') return id;
  if (typeof id === 'object' && 'toString' in (id as object)) {
    return (id as { toString(): string }).toString();
  }
  return null;
}

function normaliseGitlabHost(baseUrl?: string): string | null {
  if (!baseUrl) return null;
  const trimmed = baseUrl.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    return url.host || null;
  } catch {
    return null;
  }
}
