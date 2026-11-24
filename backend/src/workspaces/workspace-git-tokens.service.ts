import { Injectable, Logger } from '@nestjs/common';
import { ProjectsService } from '../projects/projects.service';
import { SecretsService } from '../secrets/secrets.service';
import { WorkspaceDocument } from './schemas/workspace.schema';
import { errorMessage } from '../common/narrow';
import { assertContainerWorkspace } from './container-only';

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
    // No DevGrimoire credentials toward a remote SSH server.
    assertContainerWorkspace(workspace);
    const env: Record<string, string> = {};
    let project;
    try {
      project = await this.projects.findById(workspace.projectId.toString());
    } catch {
      return env;
    }
    const projectId = workspace.projectId.toString();
    const repos = project.gitRepositories ?? [];
    if (!repos.length) return env;

    // Explicit gitRepoId wins — pick exactly that repo, ignore others. If the
    // referenced repo was deleted/renamed since the workspace was created, fall
    // through to the first-wins default so the workspace is not silently broken.
    if (workspace.gitRepoId) {
      const explicit = repos.find((r) => r._id?.toString() === workspace.gitRepoId);
      if (explicit?.tokenSecretId) {
        const token = await this.decrypt(explicit.tokenSecretId, projectId);
        if (token) {
          if (explicit.provider === 'github') {
            env.GH_TOKEN = token;
          } else if (explicit.provider === 'gitlab') {
            env.GITLAB_TOKEN = token;
            const host = normaliseGitlabHost(explicit.baseUrl);
            if (host) env.GITLAB_HOST = host;
          } else if (explicit.provider === 'gitea') {
            env.GITEA_TOKEN = token;
            const host = normaliseGiteaHost(explicit.baseUrl);
            if (host) env.GITEA_HOST = host;
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
    let gtDone = false;

    for (const repo of repos) {
      if (!repo.tokenSecretId) continue;
      if (repo.provider === 'github' && !ghDone) {
        const token = await this.decrypt(repo.tokenSecretId, projectId);
        if (token) {
          env.GH_TOKEN = token;
          ghDone = true;
        }
      } else if (repo.provider === 'gitlab' && !glDone) {
        const token = await this.decrypt(repo.tokenSecretId, projectId);
        if (token) {
          env.GITLAB_TOKEN = token;
          const host = normaliseGitlabHost(repo.baseUrl);
          if (host) env.GITLAB_HOST = host;
          glDone = true;
        }
      } else if (repo.provider === 'gitea' && !gtDone) {
        const token = await this.decrypt(repo.tokenSecretId, projectId);
        if (token) {
          env.GITEA_TOKEN = token;
          const host = normaliseGiteaHost(repo.baseUrl);
          if (host) env.GITEA_HOST = host;
          gtDone = true;
        }
      }
      if (ghDone && glDone && gtDone) break;
    }
    return env;
  }

  /**
   * Credentials for cloning `repoUrl`, so private clones work without manual
   * `https://oauth2:$TOKEN@host/...` gymnastics. Used by `workspace_clone`.
   *
   * Deliberately NOT embedded in the URL (T-541): git stores the clone URL as
   * the `origin` remote in `.git/config`, where every command in the
   * workspace could read the token. The sidecar hands these to git through
   * the environment of the clone process only. `null` if no token applies
   * (URL already carries userinfo, not https, or no token configured) — a
   * token never travels over plain http.
   *
   * Match priority:
   *   1. workspace.gitRepoId (explicit pin)
   *   2. host of repoUrl matches a project gitRepository's host
   *   3. provider deduced from URL (github.com → first GitHub repo, GitLab host → first GitLab repo)
   *
   * Username is provider-specific:
   *   - GitLab/Gitea: `oauth2` (any username works with a PAT)
   *   - GitHub: `x-access-token` (GitHub's accepted form for HTTPS)
   */
  async resolveCloneAuth(
    workspace: WorkspaceDocument,
    repoUrl: string,
  ): Promise<GitCloneAuth | null> {
    assertContainerWorkspace(workspace);
    if (!repoUrl) return null;
    let parsed: URL;
    try {
      parsed = new URL(repoUrl);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null; // caller brought its own

    const repos = await this.repositoriesOf(workspace);
    return this.authFor(workspace, pickRepoForUrl(repos, parsed.host, workspace.gitRepoId));
  }

  /**
   * Credentials for `workspace_pull`, bound to the workspace's current
   * `origin` URL as the sidecar reports it. Stricter than the clone case:
   * the origin is writable by any command in the workspace, so the token
   * goes only to the exact host its repository is configured for — no
   * gitRepoId pin that ignores the host, no provider fallback. Returns the
   * host so the sidecar can refuse a remote that changed in between.
   */
  async resolvePullAuth(
    workspace: WorkspaceDocument,
    originUrl: string | null,
  ): Promise<(GitCloneAuth & { host: string }) | null> {
    assertContainerWorkspace(workspace);
    if (!originUrl) return null;
    let parsed: URL;
    try {
      parsed = new URL(originUrl);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    const repos = (await this.repositoriesOf(workspace)).filter((r) => repoHostMatches(r, parsed.host));
    const pinned = workspace.gitRepoId
      ? repos.find((r) => idToString(r._id) === workspace.gitRepoId)
      : undefined;
    const auth = await this.authFor(workspace, pinned ?? repos.find((r) => r.tokenSecretId) ?? null);
    return auth ? { ...auth, host: parsed.host } : null;
  }

  private async repositoriesOf(workspace: WorkspaceDocument) {
    try {
      const project = await this.projects.findById(workspace.projectId.toString());
      return project.gitRepositories ?? [];
    } catch {
      return [];
    }
  }

  private async authFor(
    workspace: WorkspaceDocument,
    repo: RepoLike | null,
  ): Promise<GitCloneAuth | null> {
    if (!repo?.tokenSecretId) return null;
    const token = await this.decrypt(repo.tokenSecretId, workspace.projectId.toString());
    if (!token) return null;
    return { username: repo.provider === 'github' ? 'x-access-token' : 'oauth2', password: token };
  }

  /**
   * The token secret must belong to the workspace's project. Workspace exec
   * injects it into the environment of arbitrary commands — a foreign
   * tokenSecretId stored on the project would otherwise hand another
   * project's Git token to whoever runs `env` in this workspace.
   */
  private async decrypt(secretId: string, projectId: string): Promise<string | null> {
    try {
      return await this.secrets.findValueForOwner(secretId, { projectId }, `project ${projectId}`);
    } catch (err: unknown) {
      this.logger.warn(
        `git token secret ${secretId} could not be loaded: ${errorMessage(err)}`,
      );
      return null;
    }
  }
}

/** Basic-auth credentials for one git clone, sent to the sidecar separately from the URL. */
export interface GitCloneAuth {
  username: string;
  password: string;
}

interface RepoLike {
  _id?: { toString(): string } | string;
  provider: 'github' | 'gitlab' | 'gitea';
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
  const hostMatch = repos.find((r) => repoHostMatches(r, urlHost));
  if (hostMatch) return hostMatch;
  if (urlHost === 'github.com') return repos.find((r) => r.provider === 'github') ?? null;
  return (
    repos.find((r) => r.provider === 'gitea') ??
    repos.find((r) => r.provider === 'gitlab') ??
    null
  );
}

/** Is `urlHost` the host this repository's token was issued for? */
function repoHostMatches(r: RepoLike, urlHost: string): boolean {
  if (r.provider === 'github') return urlHost === 'github.com';
  if (r.provider === 'gitea') {
    const cfgHost = normaliseGiteaHost(r.baseUrl);
    return cfgHost !== null && urlHost === cfgHost;
  }
  const cfgHost = normaliseGitlabHost(r.baseUrl) ?? 'gitlab.com';
  return cfgHost === urlHost;
}

function idToString(id: unknown): string | null {
  if (!id) return null;
  if (typeof id === 'string') return id;
  if (typeof id === 'object' && 'toString' in (id)) {
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

function normaliseGiteaHost(baseUrl: string | undefined): string | null {
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
