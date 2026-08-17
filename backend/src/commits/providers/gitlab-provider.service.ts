import { Injectable, Logger } from '@nestjs/common';
import { GitProviderInterface, NormalizedCommit, FetchCommitsResult, GitBranch, CommitStats, NormalizedRelease, NormalizedReleaseAsset } from './git-provider.interface';
import { GitRepository } from '../schemas/git-repository.schema';
import { validateGitBaseUrl } from './url-validator';
import {
  GitLabBranch,
  GitLabCommit,
  GitLabCommitDetail,
  GitLabRelease,
  readJsonArray,
  readJsonObject,
} from './provider-responses';

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

      // Fehlerfall/Fremdform ist ein Objekt, kein Array — dann ist nichts mehr
      // zu paginieren.
      const data = await readJsonArray<GitLabCommit>(response);
      if (!data || data.length === 0) break;

      for (const item of data) {
        const committedAt = item.authored_date || item.committed_date || item.created_at;
        // Ohne SHA (`id`) oder Datum ist der Commit nicht speicherbar: beide
        // Felder sind im Commit-Schema `required`, und `new Date(undefined)`
        // ergibt ein Invalid Date, das den kompletten Sync mit einem
        // Cast-Fehler abbricht. Einzelnen Datensatz überspringen.
        if (!item.id || !committedAt) {
          this.logger.warn(
            `Skipping GitLab commit without id/date (id=${item.id ?? 'none'})`,
          );
          continue;
        }
        allCommits.push({
          sha: item.id,
          message: item.message || '',
          authorName: item.author_name || 'Unknown',
          authorEmail: item.author_email,
          committedAt: new Date(committedAt),
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
      // Vom Diff brauchen wir nur die Anzahl der Einträge, keine Feldform.
      const diffs = await readJsonArray<unknown>(diffResp);
      changedFiles = diffs?.length;
    }
    // Fetch single commit for stats (additions/deletions)
    const commitUrl = `${baseUrl}/api/v4/projects/${projectPath}/repository/commits/${sha}?stats=true`;
    const commitResp = await fetch(commitUrl, { headers: this.getHeaders(token), signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    if (!commitResp.ok) return { changedFiles };
    const data = await readJsonObject<GitLabCommitDetail>(commitResp);
    if (!data) return { changedFiles };
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
    // Ein Objekt-Body (Fehler-Payload mit HTTP 200, Antwort eines Proxy) darf
    // nicht als Liste durchgehen — sonst scheitert erst `.map()` mit einem
    // nichtssagenden "is not a function".
    const data = await readJsonArray<GitLabBranch>(response);
    if (!data) {
      throw new Error('GitLab API error: branch list response was not an array');
    }
    const branches: GitBranch[] = [];
    for (const b of data) {
      if (!b.name) continue;
      branches.push({ name: b.name, isDefault: b.default === true });
    }
    return branches;
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
    const data = await readJsonArray<GitLabRelease>(response);
    if (!data) return [];

    const releases: NormalizedRelease[] = [];
    for (const glRelease of data) {
      const tagName = glRelease.tag_name;
      // GitLab-Releases haben keine numerische ID — der Tag-Name IST der
      // Schlüssel (`providerReleaseId`) und landet als `version` in einem
      // `required`-Feld. Ohne Tag gibt es nichts zu speichern.
      if (!tagName) {
        this.logger.warn('Skipping GitLab release without tag_name');
        continue;
      }

      const assets: NormalizedReleaseAsset[] = [];
      for (const link of glRelease.assets?.links ?? []) {
        // `direct_asset_url` fehlt ohne konfigurierten direct_asset_path.
        const url = link.direct_asset_url || link.url;
        // ReleaseAsset.name/url sind im Schema `required`.
        if (!link.name || !url) continue;
        assets.push({ name: link.name, url, format: link.link_type });
      }
      for (const source of glRelease.assets?.sources ?? []) {
        // Ohne `format` gäbe es nur einen "source.undefined"-Eintrag.
        if (!source.format || !source.url) continue;
        assets.push({
          name: `source.${source.format}`,
          url: source.url,
          format: source.format,
        });
      }

      const releasedAt = glRelease.released_at || glRelease.created_at;
      releases.push({
        providerReleaseId: tagName,
        tagName,
        name: glRelease.name || tagName,
        description: glRelease.description || '',
        // Epoch statt Invalid Date, falls beide Datumsfelder fehlen.
        releasedAt: releasedAt ? new Date(releasedAt) : new Date(0),
        url: glRelease._links?.self || `${baseUrl}/-/releases/${tagName}`,
        assets,
      });
    }
    return releases;
  }
}
