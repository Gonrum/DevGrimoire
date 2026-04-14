import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import { Release, ReleaseDocument, ReleaseStatus, ReleasePlatform, ReleaseType } from './schemas/release.schema';
import { CreateReleaseDto } from './dto/create-release.dto';
import { UpdateReleaseDto } from './dto/update-release.dto';
import { PROJECT_CHANGED } from '../events/project-event';
import { ProjectsService } from '../projects/projects.service';
import { SecretsService } from '../secrets/secrets.service';
import { validateGitBaseUrl } from '../commits/providers/url-validator';
import { projectIdFilter } from '../common/project-id-filter';

const FETCH_TIMEOUT = 30000;

@Injectable()
export class ReleasesService {
  private readonly logger = new Logger(ReleasesService.name);

  constructor(
    @InjectModel(Release.name) private releaseModel: Model<ReleaseDocument>,
    private eventEmitter: EventEmitter2,
    private projectsService: ProjectsService,
    private secretsService: SecretsService,
  ) {}

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

  async findByGitlabReleaseId(projectId: string, gitlabReleaseId: string): Promise<ReleaseDocument | null> {
    return this.releaseModel.findOne({ projectId: projectIdFilter(projectId), gitlabReleaseId }).exec();
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
  // GitLab Release Sync
  // =========================================================================

  async syncGitlab(projectId: string, repoIndex?: number): Promise<{ synced: number; created: number; updated: number }> {
    const project = await this.projectsService.findById(projectId);
    const projectObj = project.toObject() as any;
    const repos = projectObj.gitRepositories || [];

    if (repos.length === 0) {
      throw new BadRequestException('No git repositories configured for this project');
    }

    let totalCreated = 0;
    let totalUpdated = 0;
    let totalSynced = 0;

    const indices = repoIndex !== undefined ? [repoIndex] : repos.map((_: any, i: number) => i);

    for (const idx of indices) {
      if (idx < 0 || idx >= repos.length) {
        throw new BadRequestException(`Repository index ${idx} out of range`);
      }

      const repoConfig = repos[idx];
      if (repoConfig.provider !== 'gitlab') {
        this.logger.debug(`Skipping non-GitLab repository at index ${idx}`);
        continue;
      }

      if (!repoConfig.tokenSecretId) {
        throw new BadRequestException('No token configured for this repository');
      }

      const secret = await this.secretsService.findById(repoConfig.tokenSecretId);
      const token = secret.value;
      const result = await this.fetchAndSyncGitlabReleases(projectId, repoConfig, token, idx);
      totalCreated += result.created;
      totalUpdated += result.updated;
      totalSynced += result.synced;
    }

    if (totalCreated > 0) {
      this.eventEmitter.emit(PROJECT_CHANGED, {
        projectId,
        entity: 'release',
        action: 'created',
        summary: `${totalCreated} neue Releases aus GitLab synchronisiert`,
      });
    }

    return { synced: totalSynced, created: totalCreated, updated: totalUpdated };
  }

  private async fetchAndSyncGitlabReleases(
    projectId: string,
    repoConfig: any,
    token: string,
    repoIndex: number,
  ): Promise<{ synced: number; created: number; updated: number }> {
    validateGitBaseUrl(repoConfig.baseUrl);
    const baseUrl = repoConfig.baseUrl || 'https://gitlab.com';
    const projectPath = repoConfig.gitlabProjectId
      ? encodeURIComponent(repoConfig.gitlabProjectId)
      : encodeURIComponent(`${repoConfig.owner}/${repoConfig.repo}`);

    const headers = { 'PRIVATE-TOKEN': token, 'Content-Type': 'application/json' };
    const url = `${baseUrl}/api/v4/projects/${projectPath}/releases?per_page=100`;

    const response = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT) });

    if (response.status === 401 || response.status === 403) {
      throw new BadRequestException(`GitLab auth error: ${response.status}`);
    }
    if (!response.ok) {
      throw new BadRequestException(`GitLab API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    if (!Array.isArray(data)) return { synced: 0, created: 0, updated: 0 };

    let created = 0;
    let updated = 0;

    for (const glRelease of data) {
      const gitlabReleaseId = String(glRelease.tag_name);
      const assets = (glRelease.assets?.links || []).map((link: any) => ({
        name: link.name,
        url: link.direct_asset_url || link.url,
        format: link.link_type,
      }));

      // Add source archives
      for (const source of glRelease.assets?.sources || []) {
        assets.push({
          name: `source.${source.format}`,
          url: source.url,
          format: source.format,
        });
      }

      const releaseData = {
        version: glRelease.tag_name,
        title: glRelease.name || glRelease.tag_name,
        description: glRelease.description || '',
        releaseType: ReleaseType.GITLAB,
        status: ReleaseStatus.PUBLISHED,
        gitlabReleaseId,
        gitlabTagName: glRelease.tag_name,
        assets,
        repoLabel: repoConfig.label || undefined,
      };

      const existing = await this.findByGitlabReleaseId(projectId, gitlabReleaseId);

      if (existing) {
        await this.releaseModel.findByIdAndUpdate(existing._id, releaseData).exec();
        updated++;
      } else {
        try {
          await this.releaseModel.create({ projectId, ...releaseData });
          created++;
        } catch (err: any) {
          // Duplicate key (version already exists) — update instead
          if (err.code === 11000) {
            await this.releaseModel.findOneAndUpdate(
              { projectId, version: glRelease.tag_name },
              releaseData,
            ).exec();
            updated++;
          } else {
            throw err;
          }
        }
      }
    }

    return { synced: data.length, created, updated };
  }
}
