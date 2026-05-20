import { Injectable, Logger } from '@nestjs/common';
import {
  GitProviderInterface,
  NormalizedCommit,
  FetchCommitsResult,
  GitBranch,
  CommitStats,
  NormalizedRelease,
} from './git-provider.interface';
import { GitRepository } from '../schemas/git-repository.schema';
import { validateGitBaseUrl } from './url-validator';

const MAX_PAGES = 10;
const FETCH_TIMEOUT = 30000;
const PER_PAGE = 50;

@Injectable()
export class GiteaProviderService implements GitProviderInterface {
  private readonly logger = new Logger(GiteaProviderService.name);

  private getBaseUrl(config: GitRepository): string {
    if (!config.baseUrl) {
      throw new Error('Gitea baseUrl is required (no public default)');
    }
    return config.baseUrl.replace(/\/+$/, '');
  }

  private repoPath(config: GitRepository): string {
    return `${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`;
  }

  private getHeaders(token: string): Record<string, string> {
    return {
      'Authorization': `token ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
  }

  async fetchCommits(
    config: GitRepository,
    token: string,
    since?: Date,
    _etag?: string,
  ): Promise<FetchCommitsResult> {
    validateGitBaseUrl(config.baseUrl, config.allowPrivateHost);
    const baseUrl = this.getBaseUrl(config);
    const allCommits: NormalizedCommit[] = [];
    let page = 1;

    while (page <= MAX_PAGES) {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(PER_PAGE),
        stat: 'true',
      });
      if (config.defaultBranch) params.set('sha', config.defaultBranch);
      if (since) params.set('since', since.toISOString());

      const url = `${baseUrl}/api/v1/repos/${this.repoPath(config)}/commits?${params}`;
      const response = await fetch(url, {
        headers: this.getHeaders(token),
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      });

      if (response.status === 401 || response.status === 403) {
        throw new Error(`Gitea auth error: ${response.status}`);
      }
      if (response.status === 429) {
        this.logger.warn('Gitea rate limit exceeded');
        break;
      }
      if (!response.ok) {
        throw new Error(`Gitea API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      if (!Array.isArray(data) || data.length === 0) break;

      for (const item of data) {
        allCommits.push({
          sha: item.sha,
          message: item.commit?.message || '',
          authorName: item.commit?.author?.name || item.author?.login || 'Unknown',
          authorEmail: item.commit?.author?.email,
          committedAt: new Date(item.commit?.author?.date || item.created),
          url: item.html_url || `${baseUrl}/${config.owner}/${config.repo}/commit/${item.sha}`,
          additions: item.stats?.additions,
          deletions: item.stats?.deletions,
          changedFiles: Array.isArray(item.files) ? item.files.length : undefined,
        });
      }

      if (data.length < PER_PAGE) break;

      const linkHeader = response.headers.get('link');
      if (!linkHeader || !linkHeader.includes('rel="next"')) break;

      page++;
    }

    return { commits: allCommits };
  }

  async fetchCommitStats(config: GitRepository, token: string, sha: string): Promise<CommitStats> {
    validateGitBaseUrl(config.baseUrl, config.allowPrivateHost);
    const baseUrl = this.getBaseUrl(config);
    const url = `${baseUrl}/api/v1/repos/${this.repoPath(config)}/git/commits/${encodeURIComponent(sha)}`;
    const response = await fetch(url, {
      headers: this.getHeaders(token),
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!response.ok) return {};
    const data = await response.json();
    return {
      additions: data.stats?.additions,
      deletions: data.stats?.deletions,
      changedFiles: Array.isArray(data.files) ? data.files.length : undefined,
    };
  }

  async fetchBranches(config: GitRepository, token: string): Promise<GitBranch[]> {
    validateGitBaseUrl(config.baseUrl, config.allowPrivateHost);
    const baseUrl = this.getBaseUrl(config);
    const url = `${baseUrl}/api/v1/repos/${this.repoPath(config)}/branches?limit=50`;
    const response = await fetch(url, {
      headers: this.getHeaders(token),
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!response.ok) {
      throw new Error(`Gitea API error: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    const defaultBranch = config.defaultBranch || 'main';
    return (data as any[]).map((b) => ({
      name: b.name,
      isDefault: b.name === defaultBranch,
    }));
  }

  async fetchReleases(config: GitRepository, token: string): Promise<NormalizedRelease[]> {
    validateGitBaseUrl(config.baseUrl, config.allowPrivateHost);
    const baseUrl = this.getBaseUrl(config);
    const url = `${baseUrl}/api/v1/repos/${this.repoPath(config)}/releases?limit=50`;
    const response = await fetch(url, {
      headers: this.getHeaders(token),
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Gitea auth error: ${response.status}`);
    }
    if (!response.ok) {
      throw new Error(`Gitea API error: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    if (!Array.isArray(data)) return [];

    return data.map((rel: any): NormalizedRelease => ({
      providerReleaseId: String(rel.id),
      tagName: rel.tag_name,
      name: rel.name || rel.tag_name,
      description: rel.body || '',
      releasedAt: new Date(rel.published_at || rel.created_at),
      url: rel.html_url || `${baseUrl}/${config.owner}/${config.repo}/releases/tag/${rel.tag_name}`,
      draft: rel.draft === true,
      prerelease: rel.prerelease === true,
      assets: (rel.assets ?? []).map((a: any) => ({
        name: a.name,
        url: a.browser_download_url,
        format: a.type,
      })),
    }));
  }

  async validateToken(config: GitRepository, token: string): Promise<boolean> {
    try {
      validateGitBaseUrl(config.baseUrl, config.allowPrivateHost);
      const baseUrl = this.getBaseUrl(config);
      const url = `${baseUrl}/api/v1/repos/${this.repoPath(config)}`;
      const response = await fetch(url, {
        headers: this.getHeaders(token),
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
