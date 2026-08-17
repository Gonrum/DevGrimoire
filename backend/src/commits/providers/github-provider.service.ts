import { Injectable, Logger } from '@nestjs/common';
import { GitProviderInterface, NormalizedCommit, FetchCommitsResult, GitBranch, CommitStats, NormalizedRelease, NormalizedReleaseAsset } from './git-provider.interface';
import { GitRepository } from '../schemas/git-repository.schema';
import { validateGitBaseUrl } from './url-validator';
import {
  GitHubBranch,
  GitHubRelease,
  GitHubStyleCommit,
  readJsonArray,
  readJsonObject,
} from './provider-responses';

const MAX_PAGES = 10;
const FETCH_TIMEOUT = 30000;

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
    validateGitBaseUrl(config.baseUrl, config.allowPrivateHost);
    const baseUrl = this.getBaseUrl(config);
    const allCommits: NormalizedCommit[] = [];
    let page = 1;
    const perPage = 100;
    let newEtag: string | undefined;

    while (page <= MAX_PAGES) {
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

      const response = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT) });

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

      // Fehlerfall/Fremdform ist ein Objekt, kein Array — dann ist nichts mehr
      // zu paginieren.
      const data = await readJsonArray<GitHubStyleCommit>(response);
      if (!data || data.length === 0) break;

      for (const item of data) {
        const committedAt = item.commit?.author?.date || item.commit?.committer?.date;
        // Ohne SHA oder Datum ist der Commit nicht speicherbar: beide Felder
        // sind im Commit-Schema `required`, und `new Date(undefined)` ergibt
        // ein Invalid Date, das den kompletten Sync mit einem Cast-Fehler
        // abbricht. Einzelnen Datensatz überspringen statt alles verlieren.
        if (!item.sha || !committedAt) {
          this.logger.warn(
            `Skipping GitHub commit without sha/date (sha=${item.sha ?? 'none'})`,
          );
          continue;
        }
        allCommits.push({
          sha: item.sha,
          message: item.commit?.message || '',
          authorName: item.commit?.author?.name || item.author?.login || 'Unknown',
          authorEmail: item.commit?.author?.email,
          committedAt: new Date(committedAt),
          url: item.html_url || '',
          additions: item.stats?.additions,
          deletions: item.stats?.deletions,
        });
      }

      if (data.length < perPage) break;

      const linkHeader = response.headers.get('link');
      if (!linkHeader || !linkHeader.includes('rel="next"')) break;

      page++;
    }

    return { commits: allCommits, etag: newEtag };
  }

  async fetchCommitStats(config: GitRepository, token: string, sha: string): Promise<CommitStats> {
    validateGitBaseUrl(config.baseUrl, config.allowPrivateHost);
    const baseUrl = this.getBaseUrl(config);
    const url = `${baseUrl}/repos/${config.owner}/${config.repo}/commits/${sha}`;
    const response = await fetch(url, { headers: this.getHeaders(token), signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    if (!response.ok) return {};
    const data = await readJsonObject<GitHubStyleCommit>(response);
    if (!data) return {};
    return {
      additions: data.stats?.additions,
      deletions: data.stats?.deletions,
      changedFiles: Array.isArray(data.files) ? data.files.length : undefined,
    };
  }

  async fetchBranches(config: GitRepository, token: string): Promise<GitBranch[]> {
    validateGitBaseUrl(config.baseUrl, config.allowPrivateHost);
    const baseUrl = this.getBaseUrl(config);
    const url = `${baseUrl}/repos/${config.owner}/${config.repo}/branches?per_page=100`;
    const response = await fetch(url, { headers: this.getHeaders(token), signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }
    // Ein Objekt-Body (Fehler-Payload mit HTTP 200, Antwort eines Proxy) darf
    // nicht als Liste durchgehen — sonst scheitert erst `.map()` mit einem
    // nichtssagenden "is not a function".
    const data = await readJsonArray<GitHubBranch>(response);
    if (!data) {
      throw new Error('GitHub API error: branch list response was not an array');
    }
    const branches: GitBranch[] = [];
    for (const b of data) {
      if (!b.name) continue;
      branches.push({ name: b.name, isDefault: b.protected === true });
    }
    return branches;
  }

  async validateToken(config: GitRepository, token: string): Promise<boolean> {
    try {
      validateGitBaseUrl(config.baseUrl, config.allowPrivateHost);
      const baseUrl = this.getBaseUrl(config);
      const url = `${baseUrl}/repos/${config.owner}/${config.repo}`;
      const response = await fetch(url, { headers: this.getHeaders(token), signal: AbortSignal.timeout(FETCH_TIMEOUT) });
      return response.ok;
    } catch {
      return false;
    }
  }

  async fetchReleases(config: GitRepository, token: string): Promise<NormalizedRelease[]> {
    validateGitBaseUrl(config.baseUrl, config.allowPrivateHost);
    const baseUrl = this.getBaseUrl(config);
    const url = `${baseUrl}/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/releases?per_page=100`;

    const response = await fetch(url, {
      headers: this.getHeaders(token),
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });

    if (response.status === 401 || response.status === 403) {
      throw new Error(`GitHub auth error: ${response.status}`);
    }
    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }
    const data = await readJsonArray<GitHubRelease>(response);
    if (!data) return [];

    const releases: NormalizedRelease[] = [];
    for (const ghRelease of data) {
      const tagName = ghRelease.tag_name;
      // `tagName` landet als `version` in einem `required`-Feld des
      // Release-Schemas — ohne Tag würde `create()` die ganze Sync-Runde
      // mit einem ValidationError abbrechen.
      if (!tagName) {
        this.logger.warn('Skipping GitHub release without tag_name');
        continue;
      }

      const assets: NormalizedReleaseAsset[] = [];
      for (const a of ghRelease.assets ?? []) {
        // ReleaseAsset.name/url sind im Schema `required`.
        if (!a.name || !a.browser_download_url) continue;
        assets.push({
          name: a.name,
          url: a.browser_download_url,
          format: a.content_type,
        });
      }

      const releasedAt = ghRelease.published_at || ghRelease.created_at;
      releases.push({
        // `id` ist bei GitHub numerisch; fehlt sie, ist der Tag-Name der
        // stabilste Ersatz-Schlüssel (String(undefined) === "undefined" hätte
        // alle Releases auf denselben Unique-Key gemappt).
        providerReleaseId: ghRelease.id != null ? String(ghRelease.id) : tagName,
        tagName,
        name: ghRelease.name || tagName,
        description: ghRelease.body || '',
        // Epoch statt Invalid Date, falls beide Datumsfelder fehlen.
        releasedAt: releasedAt ? new Date(releasedAt) : new Date(0),
        url: ghRelease.html_url || '',
        draft: ghRelease.draft === true,
        prerelease: ghRelease.prerelease === true,
        assets,
      });
    }
    return releases;
  }
}
