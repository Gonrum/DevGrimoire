import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { FilterQuery, Model } from 'mongoose';
import { Commit, CommitDocument } from './schemas/commit.schema';
import { GitProviderInterface } from './providers/git-provider.interface';
import { GitProviderRegistry } from './providers/git-provider.registry';
import { GitRepository } from './schemas/git-repository.schema';
import { SecretsService } from '../secrets/secrets.service';
import { ProjectsService } from '../projects/projects.service';
import { PROJECT_CHANGED } from '../events/project-event';
import { projectIdFilter } from '../common/project-id-filter';

/**
 * MongoDB-Duplikatsfehler (E11000). Verengung statt Cast: der Treiber wirft
 * einen `MongoServerError`, die catch-Bindung ist aber ungetypt und uns
 * interessiert nur dieser eine numerische Code.
 *
 * Gleiche Prüfung wie in `releases.service.ts` — das Muster steht rund zehnmal
 * im Backend und gehört langfristig nach `src/common/`.
 */
function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 11000;
}

/**
 * `since`/`until` kommen als Freitext herein (REST-Query-Parameter, MCP-Tool-
 * Argument eines LLM). `new Date('morgen')` ergibt ein `Invalid Date`; Mongoose
 * macht daraus beim Casten einen Fehler, der als 500 beim Aufrufer landet.
 * Hier wird daraus eine klare 400-Antwort.
 */
function parseDateParam(value: string, field: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(`${field} is not a valid date: ${value}`);
  }
  return parsed;
}

@Injectable()
export class CommitsService {
  private readonly logger = new Logger(CommitsService.name);

  constructor(
    @InjectModel(Commit.name) private commitModel: Model<CommitDocument>,
    private eventEmitter: EventEmitter2,
    private registry: GitProviderRegistry,
    private secretsService: SecretsService,
    private projectsService: ProjectsService,
  ) {}

  private async getToken(tokenSecretId: string): Promise<string> {
    const secret = await this.secretsService.findById(tokenSecretId);
    return secret.value;
  }

  async syncRepository(projectId: string, repoIndex: number): Promise<{ newCommits: number }> {
    const project = await this.projectsService.findById(projectId);
    const repos: GitRepository[] = project.toObject().gitRepositories || [];

    if (repoIndex < 0 || repoIndex >= repos.length) {
      throw new BadRequestException(`Repository index ${repoIndex} out of range`);
    }

    const repoConfig = repos[repoIndex];
    if (!repoConfig.tokenSecretId) {
      throw new BadRequestException('No token configured for this repository');
    }

    const token = await this.getToken(repoConfig.tokenSecretId);
    const provider = this.registry.get(repoConfig.provider);

    // `lastSyncAt` is only trustworthy AFTER we've actually fetched a commit
    // (== `lastSyncSha` is set). Otherwise an initial mis-sync (wrong branch,
    // 0-result first run) leaves lastSyncAt=now stuck — every subsequent sync
    // filters everything out with `since=now`. Until we have a SHA, do a full
    // fetch so we recover from those stuck states automatically.
    const sinceForApi = repoConfig.lastSyncSha ? repoConfig.lastSyncAt : undefined;
    const result = await provider.fetchCommits(
      repoConfig,
      token,
      sinceForApi,
      repoConfig.lastEtag,
    );

    if (result.notModified) {
      return { newCommits: 0 };
    }

    let newCommits = 0;
    const newShas: string[] = [];
    for (const commit of result.commits) {
      try {
        const existing = await this.commitModel.findOneAndUpdate(
          { projectId, sha: commit.sha },
          {
            $setOnInsert: {
              projectId,
              provider: repoConfig.provider,
              repoIndex,
              repoLabel: repoConfig.label || undefined,
              sha: commit.sha,
              message: commit.message,
              authorName: commit.authorName,
              authorEmail: commit.authorEmail,
              committedAt: commit.committedAt,
              url: commit.url,
              branch: commit.branch || repoConfig.defaultBranch,
              additions: commit.additions,
              deletions: commit.deletions,
              changedFiles: commit.changedFiles,
            },
          },
          { upsert: true, new: false },
        ).exec();
        // null = new insert (document didn't exist before)
        if (!existing) {
          newCommits++;
          newShas.push(commit.sha);
        }
      } catch (err: unknown) {
        // Duplicate key = already exists, skip
        if (isDuplicateKeyError(err)) continue;
        throw err;
      }
    }

    // Fetch detailed stats (changedFiles, additions, deletions) for new commits
    if (newShas.length > 0) {
      this.fetchAndUpdateStats(provider, repoConfig, token, projectId, newShas).catch((err) =>
        this.logger.error(`Stats enrichment failed for project ${projectId}: ${err}`),
      );
    }

    // Update sync metadata on the project. Don't advance lastSyncAt on a
    // truly-empty initial sync (no SHA yet AND 0 commits returned) — that's
    // the stuck-state we're guarding against above. Once we have any SHA,
    // empty-result syncs are a legitimate "nothing new" and DO advance the
    // timestamp so we hit the etag/304 fast path.
    const updatePath = `gitRepositories.${repoIndex}`;
    const newSha = result.commits[0]?.sha || repoConfig.lastSyncSha;
    const set: Record<string, unknown> = {};
    if (newSha) {
      set[`${updatePath}.lastSyncSha`] = newSha;
    }
    if (newSha || repoConfig.lastSyncSha) {
      set[`${updatePath}.lastSyncAt`] = new Date();
    }
    if (result.etag) {
      set[`${updatePath}.lastEtag`] = result.etag;
    }
    if (Object.keys(set).length) {
      await this.projectsService.updateRaw(projectId, { $set: set });
    }

    if (newCommits > 0) {
      this.eventEmitter.emit(PROJECT_CHANGED, {
        projectId,
        entity: 'commit',
        action: 'created',
        summary: `${newCommits} neue Commits synchronisiert`,
      });
    }

    return { newCommits };
  }

  private async fetchAndUpdateStats(
    provider: GitProviderInterface,
    config: GitRepository,
    token: string,
    projectId: string,
    shas: string[],
  ): Promise<void> {
    const BATCH_DELAY = 100; // ms between requests to avoid rate limits
    for (const sha of shas) {
      try {
        const stats = await provider.fetchCommitStats(config, token, sha);
        const update: Record<string, unknown> = {};
        if (stats.changedFiles != null) update.changedFiles = stats.changedFiles;
        if (stats.additions != null) update.additions = stats.additions;
        if (stats.deletions != null) update.deletions = stats.deletions;
        if (Object.keys(update).length > 0) {
          await this.commitModel.updateOne(
            { projectId, sha },
            { $set: update },
          ).exec();
        }
      } catch (err) {
        this.logger.warn(`Failed to fetch stats for commit ${sha}: ${err}`);
      }
      if (shas.length > 1) {
        await new Promise((r) => setTimeout(r, BATCH_DELAY));
      }
    }
    this.logger.log(`Stats enriched for ${shas.length} commits in project ${projectId}`);
  }

  async syncAllForProject(projectId: string): Promise<{ totalNewCommits: number }> {
    const project = await this.projectsService.findById(projectId);
    const repos: GitRepository[] = project.toObject().gitRepositories || [];

    let totalNewCommits = 0;
    for (let i = 0; i < repos.length; i++) {
      if (!repos[i].syncEnabled) continue;
      try {
        const result = await this.syncRepository(projectId, i);
        totalNewCommits += result.newCommits;
      } catch (err) {
        this.logger.error(`Sync failed for repo ${i} of project ${projectId}: ${err}`);
      }
    }

    return { totalNewCommits };
  }

  async findByProject(
    projectId: string,
    options?: {
      branch?: string;
      author?: string;
      since?: string;
      until?: string;
      provider?: string;
      repoLabel?: string;
      limit?: number;
      offset?: number;
    },
  ): Promise<CommitDocument[]> {
    const filter: FilterQuery<CommitDocument> = { projectId: projectIdFilter(projectId) };
    if (options?.branch) filter.branch = options.branch;
    if (options?.repoLabel) filter.repoLabel = options.repoLabel;
    if (options?.author) {
      const escaped = options.author.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { authorName: { $regex: escaped, $options: 'i' } },
        { authorEmail: { $regex: escaped, $options: 'i' } },
      ];
    }
    if (options?.provider) filter.provider = options.provider;
    // Range als eigenes Objekt aufbauen und erst dann zuweisen: `filter.committedAt`
    // ist als `Condition<Date>` effektiv `any` — ein `.$gte` darauf wäre wieder
    // ungeprüft.
    if (options?.since || options?.until) {
      const range: { $gte?: Date; $lte?: Date } = {};
      if (options.since) range.$gte = parseDateParam(options.since, 'since');
      if (options.until) range.$lte = parseDateParam(options.until, 'until');
      filter.committedAt = range;
    }

    const query = this.commitModel
      .find(filter)
      .sort({ committedAt: -1 });

    if (options?.offset) query.skip(options.offset);
    query.limit(options?.limit || 50);

    return query.exec();
  }

  async search(
    projectId: string,
    searchQuery: string,
    limit?: number,
  ): Promise<CommitDocument[]> {
    // `projectIdFilter` wie in `findByProject`/`countByProject`: die Collection
    // enthält projectId historisch als ObjectId *und* als String. Ein rohes
    // `{ projectId }` hätte in `commit_search` genau die Commits übersehen, die
    // `commit_list` findet.
    return this.commitModel
      .find(
        { projectId: projectIdFilter(projectId), $text: { $search: searchQuery } },
        { score: { $meta: 'textScore' } },
      )
      .sort({ score: { $meta: 'textScore' } })
      .limit(limit || 20)
      .exec();
  }

  async findById(id: string): Promise<CommitDocument> {
    const commit = await this.commitModel.findById(id).exec();
    if (!commit) throw new NotFoundException(`Commit ${id} not found`);
    return commit;
  }

  async countByProject(projectId: string, repoLabel?: string): Promise<number> {
    const filter: FilterQuery<CommitDocument> = { projectId: projectIdFilter(projectId) };
    if (repoLabel) filter.repoLabel = repoLabel;
    return this.commitModel.countDocuments(filter).exec();
  }

  async removeByProject(projectId: string): Promise<void> {
    // Ebenfalls beide Repräsentationen — sonst bleiben beim Projekt-Löschen
    // string-gespeicherte Commits als Waisen liegen.
    await this.commitModel.deleteMany({ projectId: projectIdFilter(projectId) }).exec();
  }

  async validateRepoToken(config: GitRepository, token: string): Promise<boolean> {
    const provider = this.registry.get(config.provider);
    return provider.validateToken(config, token);
  }

  async fetchBranches(projectId: string, repoIndex: number) {
    const project = await this.projectsService.findById(projectId);
    const repos: GitRepository[] = project.toObject().gitRepositories || [];

    if (repoIndex < 0 || repoIndex >= repos.length) {
      throw new BadRequestException(`Repository index ${repoIndex} out of range`);
    }

    const repoConfig = repos[repoIndex];
    if (!repoConfig.tokenSecretId) {
      throw new BadRequestException('No token configured for this repository');
    }

    const token = await this.getToken(repoConfig.tokenSecretId);
    const provider = this.registry.get(repoConfig.provider);
    return provider.fetchBranches(repoConfig, token);
  }
}
