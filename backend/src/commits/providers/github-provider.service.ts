import { Injectable, Logger } from '@nestjs/common';
import { GitProviderInterface, NormalizedCommit, FetchCommitsResult } from './git-provider.interface';
import { GitRepository } from '../schemas/git-repository.schema';

@Injectable()
export class GitHubProviderService implements GitProviderInterface {
  private readonly logger = new Logger(GitHubProviderService.name);

  private getBaseUrl(config: GitRepository): string {
    return config.baseUrl || 'https://api.github.com';
  }

  private getHeaders(token: string, etag?: string): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'DevGrimoire/1.0',
    };
    if (etag) {
      headers['If-None-Match'] = etag;
    }
    return headers;
  }

  async fetchCommits(
    config: GitRepository,
    token: string,
    since?: Date,
    etag?: string,
  ): Promise<FetchCommitsResult> {
    const baseUrl = this.getBaseUrl(config);
    const allCommits: NormalizedCommit[] = [];
    let page = 1;
    const perPage = 100;
    let newEtag: string | undefined;

    while (true) {
      const params = new URLSearchParams({
        per_page: String(perPage),
        page: String(page),
      });
      if (since) {
        params.set('since', since.toISOString());
      }
      if (config.defaultBranch) {
        params.set('sha', config.defaultBranch);
      }

      const url = `${baseUrl}/repos/${config.owner}/${config.repo}/commits?${params}`;
      const headers = this.getHeaders(token, page === 1 ? etag : undefined);

      const response = await fetch(url, { headers });

      if (response.status === 304) {
        return { commits: [], notModified: true, etag };
      }

      if (response.status === 401 || response.status === 403) {
        const remaining = response.headers.get('x-ratelimit-remaining');
        if (remaining === '0') {
          this.logger.warn('GitHub rate limit exceeded');
          break;
        }
        throw new Error(`GitHub auth error: ${response.status}`);
      }

      if (!response.ok) {
        throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
      }

      if (page === 1) {
        newEtag = response.headers.get('etag') || undefined;
      }

      const data = await response.json();
      if (!Array.isArray(data) || data.length === 0) break;

      for (const item of data) {
        allCommits.push({
          sha: item.sha,
          message: item.commit?.message || '',
          authorName: item.commit?.author?.name || item.author?.login || 'Unknown',
          authorEmail: item.commit?.author?.email,
          committedAt: new Date(item.commit?.author?.date || item.commit?.committer?.date),
          url: item.html_url || '',
          additions: item.stats?.additions,
          deletions: item.stats?.deletions,
        });
      }

      if (data.length < perPage) break;

      // Check Link header for next page
      const linkHeader = response.headers.get('link');
      if (!linkHeader || !linkHeader.includes('rel="next"')) break;

      page++;
    }

    return { commits: allCommits, etag: newEtag };
  }

  async validateToken(config: GitRepository, token: string): Promise<boolean> {
    try {
      const baseUrl = this.getBaseUrl(config);
      const url = `${baseUrl}/repos/${config.owner}/${config.repo}`;
      const response = await fetch(url, { headers: this.getHeaders(token) });
      return response.ok;
    } catch {
      return false;
    }
  }
}
