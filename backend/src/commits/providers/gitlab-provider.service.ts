import { Injectable, Logger } from '@nestjs/common';
import { GitProviderInterface, NormalizedCommit, FetchCommitsResult, GitBranch, CommitStats, NormalizedRelease } from './git-provider.interface';
import { GitRepository } from '../schemas/git-repository.schema';
import { validateGitBaseUrl } from './url-validator';

const MAX_PAGES = 10;
const FETCH_TIMEOUT = 30000;

@Injectable()
export class GitLabProviderService implements GitProviderInterface {
  private readonly logger = new Logger(GitLabProviderService.name);

  private getBaseUrl(config: GitRepository): string {
    return config.baseUrl || 'https://gitlab.com';
  }

  private getProjectPath(config: GitRepository): string {
    if (config.gitlabProjectId) {
      return encodeURIComponent(config.gitlabProjectId);
    }
    return encodeURIComponent(`${config.owner}/${config.repo}`);
  }

  private getHeaders(token: string): Record<string, string> {
    return {
      'PRIVATE-TOKEN': token,
      'Content-Type': 'application/json',
    };
  }

  async fetchCommits(
    config: GitRepository,
    token: string,
    since?: Date,
  ): Promise<FetchCommitsResult> {
    validateGitBaseUrl(config.baseUrl, config.allowPrivateHost);
    const baseUrl = this.getBaseUrl(config);
    const projectPath = this.getProjectPath(config);
    const allCommits: NormalizedCommit[] = [];
    let page = 1;
    const perPage = 100;

    while (page <= MAX_PAGES) {
      const params = new URLSearchParams({
        per_page: String(perPage),
        page: String(page),
        with_stats: 'true',
      });
      if (since) {
        params.set('since', since.toISOString());
      }
      if (config.defaultBranch) {
        params.set('ref_name', config.defaultBranch);
      }

      const url = `${baseUrl}/api/v4/projects/${projectPath}/repository/commits?${params}`;
      const response = await fetch(url, { headers: this.getHeaders(token), signal: AbortSignal.timeout(FETCH_TIMEOUT) });

      if (response.status === 401 || response.status === 403) {
        throw new Error(`GitLab auth error: ${response.status}`);
      }

      if (response.status === 429) {
        this.logger.warn('GitLab rate limit exceeded');
        break;
      }

      if (!response.ok) {
        throw new Error(`GitLab API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      if (!Array.isArray(data) || data.length === 0) break;

      for (const item of data) {
        allCommits.push({
          sha: item.id,
          message: item.message || '',
          authorName: item.author_name || 'Unknown',
          authorEmail: item.author_email,
          committedAt: new Date(item.authored_date || item.committed_date || item.created_at),
          url: item.web_url || '',
          additions: item.stats?.additions,
          deletions: item.stats?.deletions,
        });
      }

      if (data.length < perPage) break;

      const linkHeader = response.headers.get('link');
      if (!linkHeader || !linkHeader.includes('rel="next"')) break;

      page++;
    }

    return { commits: allCommits };
  }

  async fetchCommitStats(config: GitRepository, token: string, sha: string): Promise<CommitStats> {
    validateGitBaseUrl(config.baseUrl, config.allowPrivateHost);
    const baseUrl = this.getBaseUrl(config);
    const projectPath = this.getProjectPath(config);
    // Fetch diff to get file count
    const diffUrl = `${baseUrl}/api/v4/projects/${projectPath}/repository/commits/${sha}/diff`;
    const diffResp = await fetch(diffUrl, { headers: this.getHeaders(token), signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    let changedFiles: number | undefined;
    if (diffResp.ok) {
      const diffs = await diffResp.json();
      changedFiles = Array.isArray(diffs) ? diffs.length : undefined;
    }
    // Fetch single commit for stats (additions/deletions)
    const commitUrl = `${baseUrl}/api/v4/projects/${projectPath}/repository/commits/${sha}?stats=true`;
    const commitResp = await fetch(commitUrl, { headers: this.getHeaders(token), signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    if (!commitResp.ok) return { changedFiles };
    const data = await commitResp.json();
    return {
      additions: data.stats?.additions,
      deletions: data.stats?.deletions,
      changedFiles,
    };
  }

  async fetchBranches(config: GitRepository, token: string): Promise<GitBranch[]> {
    validateGitBaseUrl(config.baseUrl, config.allowPrivateHost);
    const baseUrl = this.getBaseUrl(config);
    const projectPath = this.getProjectPath(config);
    const url = `${baseUrl}/api/v4/projects/${projectPath}/repository/branches?per_page=100`;
    const response = await fetch(url, { headers: this.getHeaders(token), signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    if (!response.ok) {
      throw new Error(`GitLab API error: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    return (data as any[]).map((b) => ({ name: b.name, isDefault: b.default === true }));
  }

  async validateToken(config: GitRepository, token: string): Promise<boolean> {
    try {
      validateGitBaseUrl(config.baseUrl, config.allowPrivateHost);
      const baseUrl = this.getBaseUrl(config);
      const projectPath = this.getProjectPath(config);
      const url = `${baseUrl}/api/v4/projects/${projectPath}`;
      const response = await fetch(url, { headers: this.getHeaders(token), signal: AbortSignal.timeout(FETCH_TIMEOUT) });
      return response.ok;
    } catch {
      return false;
    }
  }

  async fetchReleases(config: GitRepository, token: string): Promise<NormalizedRelease[]> {
    validateGitBaseUrl(config.baseUrl, config.allowPrivateHost);
    const baseUrl = this.getBaseUrl(config);
    const projectPath = this.getProjectPath(config);
    const url = `${baseUrl}/api/v4/projects/${projectPath}/releases?per_page=100`;

    const response = await fetch(url, {
      headers: this.getHeaders(token),
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (response.status === 401 || response.status === 403) {
      throw new Error(`GitLab auth error: ${response.status}`);
    }
    if (!response.ok) {
      throw new Error(`GitLab API error: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    if (!Array.isArray(data)) return [];

    return data.map((glRelease: any): NormalizedRelease => {
      const assets: { name: string; url: string; format?: string }[] = [];
      for (const link of glRelease.assets?.links ?? []) {
        assets.push({
          name: link.name,
          url: link.direct_asset_url || link.url,
          format: link.link_type,
        });
      }
      for (const source of glRelease.assets?.sources ?? []) {
        assets.push({
          name: `source.${source.format}`,
          url: source.url,
          format: source.format,
        });
      }
      return {
        providerReleaseId: String(glRelease.tag_name),
        tagName: glRelease.tag_name,
        name: glRelease.name || glRelease.tag_name,
        description: glRelease.description || '',
        releasedAt: new Date(glRelease.released_at || glRelease.created_at),
        url: glRelease._links?.self || `${baseUrl}/-/releases/${glRelease.tag_name}`,
        assets,
      };
    });
  }
}
