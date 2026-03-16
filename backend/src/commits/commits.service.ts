import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import { Commit, CommitDocument, GitProvider } from './schemas/commit.schema';
import { GitHubProviderService } from './providers/github-provider.service';
import { GitLabProviderService } from './providers/gitlab-provider.service';
import { GitProviderInterface } from './providers/git-provider.interface';
import { GitRepository } from './schemas/git-repository.schema';
import { SecretsService } from '../secrets/secrets.service';
import { ProjectsService } from '../projects/projects.service';
import { PROJECT_CHANGED } from '../events/project-event';

@Injectable()
export class CommitsService {
  private readonly logger = new Logger(CommitsService.name);

  constructor(
    @InjectModel(Commit.name) private commitModel: Model<CommitDocument>,
    private eventEmitter: EventEmitter2,
    private githubProvider: GitHubProviderService,
    private gitlabProvider: GitLabProviderService,
    private secretsService: SecretsService,
    private projectsService: ProjectsService,
  ) {}

  private getProvider(provider: string): GitProviderInterface {
    switch (provider) {
      case 'github':
        return this.githubProvider;
      case 'gitlab':
        return this.gitlabProvider;
      default:
        throw new BadRequestException(`Unknown provider: ${provider}`);
    }
  }

  private async getToken(tokenSecretId: string): Promise<string> {
    const secret = await this.secretsService.findById(tokenSecretId);
    return secret.value;
  }

  async syncRepository(projectId: string, repoIndex: number): Promise<{ newCommits: number }> {
    const project = await this.projectsService.findById(projectId);
    const projectObj = project.toObject() as any;
    const repos: GitRepository[] = projectObj.gitRepositories || [];

    if (repoIndex < 0 || repoIndex >= repos.length) {
      throw new BadRequestException(`Repository index ${repoIndex} out of range`);
    }

    const repoConfig = repos[repoIndex];
    if (!repoConfig.tokenSecretId) {
      throw new BadRequestException('No token configured for this repository');
    }

    const token = await this.getToken(repoConfig.tokenSecretId);
    const provider = this.getProvider(repoConfig.provider);

    const result = await provider.fetchCommits(
      repoConfig,
      token,
      repoConfig.lastSyncAt,
      repoConfig.lastEtag,
    );

    if (result.notModified) {
      return { newCommits: 0 };
    }

    let newCommits = 0;
    for (const commit of result.commits) {
      try {
        const existing = await this.commitModel.findOneAndUpdate(
          { projectId, sha: commit.sha },
          {
            $setOnInsert: {
              projectId,
              provider: repoConfig.provider,
              sha: commit.sha,
              message: commit.message,
              authorName: commit.authorName,
              authorEmail: commit.authorEmail,
              committedAt: commit.committedAt,
              url: commit.url,
              branch: commit.branch || repoConfig.defaultBranch,
              additions: commit.additions,
              deletions: commit.deletions,
            },
          },
          { upsert: true, new: false },
        ).exec();
        // null = new insert (document didn't exist before)
        if (!existing) newCommits++;
      } catch (err: any) {
        // Duplicate key = already exists, skip
        if (err.code === 11000) continue;
        throw err;
      }
    }

    // Update sync metadata on the project
    const updatePath = `gitRepositories.${repoIndex}`;
    await this.projectsService.updateRaw(projectId, {
      $set: {
        [`${updatePath}.lastSyncAt`]: new Date(),
        [`${updatePath}.lastSyncSha`]: result.commits[0]?.sha || repoConfig.lastSyncSha,
        ...(result.etag ? { [`${updatePath}.lastEtag`]: result.etag } : {}),
      },
    });

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

  async syncAllForProject(projectId: string): Promise<{ totalNewCommits: number }> {
    const project = await this.projectsService.findById(projectId);
    const projectObj = project.toObject() as any;
    const repos: GitRepository[] = projectObj.gitRepositories || [];

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
      limit?: number;
      offset?: number;
    },
  ): Promise<CommitDocument[]> {
    const filter: Record<string, unknown> = { projectId };
    if (options?.branch) filter.branch = options.branch;
    if (options?.author) {
      filter.$or = [
        { authorName: { $regex: options.author, $options: 'i' } },
        { authorEmail: { $regex: options.author, $options: 'i' } },
      ];
    }
    if (options?.provider) filter.provider = options.provider;
    if (options?.since || options?.until) {
      filter.committedAt = {};
      if (options.since) (filter.committedAt as any).$gte = new Date(options.since);
      if (options.until) (filter.committedAt as any).$lte = new Date(options.until);
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
    return this.commitModel
      .find(
        { projectId, $text: { $search: searchQuery } },
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

  async countByProject(projectId: string): Promise<number> {
    return this.commitModel.countDocuments({ projectId }).exec();
  }

  async removeByProject(projectId: string): Promise<void> {
    await this.commitModel.deleteMany({ projectId }).exec();
  }

  async validateRepoToken(config: GitRepository, token: string): Promise<boolean> {
    const provider = this.getProvider(config.provider);
    return provider.validateToken(config, token);
  }
}
