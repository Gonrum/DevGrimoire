import { Injectable, Logger, NotFoundException, BadRequestException, OnApplicationBootstrap } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import { Release, ReleaseDocument, ReleaseStatus, ReleasePlatform, ReleaseType } from './schemas/release.schema';
import { CreateReleaseDto } from './dto/create-release.dto';
import { UpdateReleaseDto } from './dto/update-release.dto';
import { PROJECT_CHANGED } from '../events/project-event';
import { ProjectsService } from '../projects/projects.service';
import { SecretsService } from '../secrets/secrets.service';
import { projectIdFilter } from '../common/project-id-filter';
import { GitProviderRegistry } from '../commits/providers/git-provider.registry';
import { GitProvider, GitRepository } from '../commits/schemas/git-repository.schema';

/**
 * MongoDB duplicate-key error (E11000). Narrowing instead of casting: the
 * driver throws `MongoServerError`, but the catch binding is `unknown` and we
 * only care about that one numeric code.
 */
function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 11000;
}

/**
 * Git provider → ReleaseType. `Record<GitProvider, …>` on purpose: a new
 * provider in the union breaks the build here instead of silently producing
 * `undefined` as releaseType.
 */
const RELEASE_TYPE_BY_PROVIDER: Record<GitProvider, ReleaseType> = {
  github: ReleaseType.GITHUB,
  gitlab: ReleaseType.GITLAB,
  gitea: ReleaseType.GITEA,
};

@Injectable()
export class ReleasesService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReleasesService.name);

  constructor(
    @InjectModel(Release.name) private releaseModel: Model<ReleaseDocument>,
    private eventEmitter: EventEmitter2,
    private projectsService: ProjectsService,
    private secretsService: SecretsService,
    private registry: GitProviderRegistry,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const result = await this.releaseModel.updateMany(
      {
        gitlabReleaseId: { $exists: true, $ne: null },
        providerReleaseId: { $exists: false },
      },
      [
        {
          $set: {
            provider: 'gitlab',
            providerReleaseId: '$gitlabReleaseId',
            tagName: '$gitlabTagName',
          },
        },
      ],
    ).exec();
    if (result.modifiedCount > 0) {
      this.logger.log(`Migrated ${result.modifiedCount} legacy GitLab releases to generic provider fields`);
    }
  }

  async create(dto: CreateReleaseDto): Promise<ReleaseDocument> {
    const release = await this.releaseModel.create(dto);
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: release.projectId.toString(),
      entity: 'release',
      action: 'created',
      entityId: release._id.toString(),
      summary: `Release "${release.version}" erstellt`,
    });
    return release;
  }

  async findByProject(
    projectId: string,
    filters?: { status?: ReleaseStatus; platform?: ReleasePlatform; releaseType?: ReleaseType },
    limit?: number,
    offset?: number,
  ): Promise<ReleaseDocument[]> {
    const query: Record<string, unknown> = { projectId: projectIdFilter(projectId) };
    if (filters?.status) query.status = filters.status;
    if (filters?.platform) query.platform = filters.platform;
    if (filters?.releaseType) query.releaseType = filters.releaseType;
    return this.releaseModel
      .find(query)
      .sort({ createdAt: -1 })
      .skip(offset || 0)
      .limit(limit || 50)
      .exec();
  }

  async findById(id: string): Promise<ReleaseDocument> {
    const release = await this.releaseModel.findById(id).exec();
    if (!release) throw new NotFoundException(`Release ${id} not found`);
    return release;
  }

  async update(id: string, dto: UpdateReleaseDto): Promise<ReleaseDocument> {
    const release = await this.releaseModel.findByIdAndUpdate(id, dto, { new: true }).exec();
    if (!release) throw new NotFoundException(`Release ${id} not found`);
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: release.projectId.toString(),
      entity: 'release',
      action: 'updated',
      entityId: id,
      summary: `Release "${release.version}" aktualisiert`,
    });
    return release;
  }

  async remove(id: string): Promise<void> {
    const result = await this.releaseModel.findByIdAndDelete(id).exec();
    if (!result) throw new NotFoundException(`Release ${id} not found`);
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: result.projectId.toString(),
      entity: 'release',
      action: 'deleted',
      entityId: id,
      summary: `Release "${result.version}" entfernt`,
    });
  }

  async removeByProject(projectId: string): Promise<void> {
    await this.releaseModel.deleteMany({ projectId }).exec();
  }

  // =========================================================================
  // Provider-agnostic Release Sync
  // =========================================================================

  async syncReleases(projectId: string, repoIndex?: number): Promise<{ synced: number; created: number; updated: number }> {
    const project = await this.projectsService.findById(projectId);
    const projectObj = project.toObject();
    const repos: GitRepository[] = projectObj.gitRepositories || [];

    if (repos.length === 0) {
      throw new BadRequestException('No git repositories configured for this project');
    }

    let totalCreated = 0;
    let totalUpdated = 0;
    let totalSynced = 0;

    const indices = repoIndex !== undefined ? [repoIndex] : repos.map((_, i) => i);

    for (const idx of indices) {
      if (idx < 0 || idx >= repos.length) {
        throw new BadRequestException(`Repository index ${idx} out of range`);
      }

      const repoConfig = repos[idx];

      if (!repoConfig.tokenSecretId) {
        throw new BadRequestException('No token configured for this repository');
      }

      const secret = await this.secretsService.findById(repoConfig.tokenSecretId);
      const token = secret.value;
      const result = await this.fetchAndSyncReleases(projectId, repoConfig, token);
      totalCreated += result.created;
      totalUpdated += result.updated;
      totalSynced += result.synced;
    }

    if (totalCreated > 0) {
      this.eventEmitter.emit(PROJECT_CHANGED, {
        projectId,
        entity: 'release',
        action: 'created',
        summary: `${totalCreated} neue Releases synchronisiert`,
      });
    }

    return { synced: totalSynced, created: totalCreated, updated: totalUpdated };
  }

  private async fetchAndSyncReleases(
    projectId: string,
    repoConfig: GitRepository,
    token: string,
  ): Promise<{ synced: number; created: number; updated: number }> {
    const provider = this.registry.get(repoConfig.provider);
    const releases = await provider.fetchReleases(repoConfig, token);

    let created = 0;
    let updated = 0;

    for (const rel of releases) {
      const releaseData = {
        version: rel.tagName,
        title: rel.name,
        description: rel.description || '',
        releaseType: RELEASE_TYPE_BY_PROVIDER[repoConfig.provider],
        status: ReleaseStatus.PUBLISHED,
        provider: repoConfig.provider,
        providerReleaseId: rel.providerReleaseId,
        tagName: rel.tagName,
        assets: rel.assets,
        repoLabel: repoConfig.label || undefined,
      };

      const existing = await this.releaseModel.findOne({
        projectId,
        provider: repoConfig.provider,
        providerReleaseId: rel.providerReleaseId,
      }).exec();

      if (existing) {
        await this.releaseModel.findByIdAndUpdate(existing._id, releaseData).exec();
        updated++;
      } else {
        try {
          await this.releaseModel.create({ projectId, ...releaseData });
          created++;
        } catch (err: unknown) {
          if (isDuplicateKeyError(err)) {
            await this.releaseModel.findOneAndUpdate(
              { projectId, version: rel.tagName },
              releaseData,
            ).exec();
            updated++;
          } else {
            throw err;
          }
        }
      }
    }

    return { synced: releases.length, created, updated };
  }
}
