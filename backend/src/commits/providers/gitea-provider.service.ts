import { Injectable, Logger } from '@nestjs/common';
import {
  GitProviderInterface,
  NormalizedCommit,
  FetchCommitsResult,
  GitBranch,
  CommitStats,
  NormalizedRelease,
  NormalizedReleaseAsset,
} from './git-provider.interface';
import { GitRepository } from '../schemas/git-repository.schema';
import { validateGitBaseUrl } from './url-validator';
import {
  BranchResponse,
  GiteaCommit,
  GiteaRelease,
  readJsonArray,
  readJsonObject,
} from './provider-responses';

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

  // Kein `etag`-Parameter: Gitea liefert für Commit-Listen keinen brauchbaren
  // ETag, der Wert wurde hier ohnehin nie benutzt. Weniger Parameter als im
  // Interface ist zulässig — der GitLab-Provider macht es genauso.
  async fetchCommits(
    config: GitRepository,
    token: string,
    since?: Date,
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

      // Fehlerfall/Fremdform ist ein Objekt, kein Array — dann ist nichts mehr
      // zu paginieren.
      const data = await readJsonArray<GiteaCommit>(response);
      if (!data || data.length === 0) break;

      for (const item of data) {
        const committedAt = item.commit?.author?.date || item.created;
        // Ohne SHA oder Datum ist der Commit nicht speicherbar: beide Felder
        // sind im Commit-Schema `required`, und `new Date(undefined)` ergibt
        // ein Invalid Date, das den kompletten Sync mit einem Cast-Fehler
        // abbricht. Einzelnen Datensatz überspringen statt alles verlieren.
        if (!item.sha || !committedAt) {
          this.logger.warn(
            `Skipping Gitea commit without sha/date (sha=${item.sha ?? 'none'})`,
          );
          continue;
        }
        allCommits.push({
          sha: item.sha,
          message: item.commit?.message || '',
          authorName: item.commit?.author?.name || item.author?.login || 'Unknown',
          authorEmail: item.commit?.author?.email,
          committedAt: new Date(committedAt),
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
    const data = await readJsonObject<GiteaCommit>(response);
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
    const url = `${baseUrl}/api/v1/repos/${this.repoPath(config)}/branches?limit=50`;
    const response = await fetch(url, {
      headers: this.getHeaders(token),
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!response.ok) {
      throw new Error(`Gitea API error: ${response.status} ${response.statusText}`);
    }
    // Ein Objekt-Body (Fehler-Payload mit HTTP 200, Antwort eines Proxy) darf
    // nicht als Liste durchgehen — sonst scheitert erst `.map()` mit einem
    // nichtssagenden "is not a function".
    const data = await readJsonArray<BranchResponse>(response);
    if (!data) {
      throw new Error('Gitea API error: branch list response was not an array');
    }
    const defaultBranch = config.defaultBranch || 'main';
    const branches: GitBranch[] = [];
    for (const b of data) {
      if (!b.name) continue;
      branches.push({ name: b.name, isDefault: b.name === defaultBranch });
    }
    return branches;
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
    const data = await readJsonArray<GiteaRelease>(response);
    if (!data) return [];

    const releases: NormalizedRelease[] = [];
    for (const rel of data) {
      const tagName = rel.tag_name;
      // `tagName` landet als `version` in einem `required`-Feld des
      // Release-Schemas — ohne Tag würde `create()` die ganze Sync-Runde
      // mit einem ValidationError abbrechen.
      if (!tagName) {
        this.logger.warn('Skipping Gitea release without tag_name');
        continue;
      }

      const assets: NormalizedReleaseAsset[] = [];
      for (const a of rel.assets ?? []) {
        // ReleaseAsset.name/url sind im Schema `required`.
        if (!a.name || !a.browser_download_url) continue;
        assets.push({
          name: a.name,
          url: a.browser_download_url,
          // `type` gibt es erst in neueren Gitea-Versionen — bleibt leer.
          format: a.type,
        });
      }

      const releasedAt = rel.published_at || rel.created_at;
      releases.push({
        // Fehlt die numerische `id`, ist der Tag-Name der stabilste
        // Ersatz-Schlüssel (String(undefined) === "undefined" hätte alle
        // Releases auf denselben Unique-Key gemappt).
        providerReleaseId: rel.id != null ? String(rel.id) : tagName,
        tagName,
        name: rel.name || tagName,
        description: rel.body || '',
        // Epoch statt Invalid Date, falls beide Datumsfelder fehlen.
        releasedAt: releasedAt ? new Date(releasedAt) : new Date(0),
        url: rel.html_url || `${baseUrl}/${config.owner}/${config.repo}/releases/tag/${tagName}`,
        draft: rel.draft === true,
        prerelease: rel.prerelease === true,
        assets,
      });
    }
    return releases;
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
