import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model, Types } from 'mongoose';
import { ResearchArtifact, ResearchArtifactDocument } from './schemas/research-artifact.schema';
import {
  ResearchArtifactVersion,
  ResearchArtifactVersionDocument,
} from './schemas/research-artifact-version.schema';
import { ResearchScope } from './schemas/research-topic.schema';
import { PROJECT_CHANGED } from '../events/project-event';

/** Fields the research agent (or an operator) supplies when writing an artifact. */
export interface WriteArtifactInput {
  slug: string;
  title: string;
  content: string;
  summary?: string;
  tags?: string[];
  sources?: string[];
  changeNote?: string;
  runId?: string;
}

export interface ArtifactSummary {
  slug: string;
  title: string;
  summary?: string;
  version: number;
}

/**
 * Normalizes free-form text into the identity-safe slug artifacts are
 * upserted against (see `ARTIFACT_UNIQUE` on ResearchArtifactSchema):
 * lowercase, `[a-z0-9]` only, runs of any other character collapsed to a
 * single `-`, leading/trailing `-` trimmed. A pure function — no `this`, no
 * locale-dependent casing — so it stays trivially unit-testable
 * (`research-slug-check.cjs`).
 *
 * Throws if the result is empty (e.g. input is only punctuation/whitespace)
 * rather than silently minting a slug that would collide with every other
 * empty-titled artifact in the same topic.
 */
export function normalizeSlug(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) {
    throw new BadRequestException(`Cannot derive a slug from "${input}"`);
  }
  return slug;
}

@Injectable()
export class ResearchArtifactService {
  constructor(
    @InjectModel(ResearchArtifact.name)
    private readonly artifactModel: Model<ResearchArtifactDocument>,
    @InjectModel(ResearchArtifactVersion.name)
    private readonly artifactVersionModel: Model<ResearchArtifactVersionDocument>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async listByTopic(topicId: string): Promise<ArtifactSummary[]> {
    const artifacts = await this.artifactModel
      .find({ topicId: new Types.ObjectId(topicId) }, { slug: 1, title: 1, summary: 1, version: 1 })
      .sort({ updatedAt: -1 })
      .exec();
    return artifacts.map((a) => ({ slug: a.slug, title: a.title, summary: a.summary, version: a.version }));
  }

  async getBySlug(topicId: string, slug: string): Promise<ResearchArtifactDocument | null> {
    return this.artifactModel
      .findOne({ topicId: new Types.ObjectId(topicId), slug: normalizeSlug(slug) })
      .exec();
  }

  /**
   * Derives artifact ownership from the topic's scope: the first configured
   * project wins, otherwise the first configured customer, otherwise the
   * artifact is global. This gates RAG indexing/visibility exactly like any
   * other project/customer/global-scoped entity.
   */
  private deriveOwnership(scope: ResearchScope): {
    projectId?: Types.ObjectId;
    customerId?: Types.ObjectId;
    isGlobal: boolean;
  } {
    if (scope.projectIds.length > 0) {
      return { projectId: scope.projectIds[0], isGlobal: false };
    }
    if (scope.customerIds.length > 0) {
      return { customerId: scope.customerIds[0], isGlobal: false };
    }
    return { isGlobal: true };
  }

  /**
   * Upserts an artifact by `{topicId, slug}`.
   *
   * If one already exists, its CURRENT `content`/`version` are snapshotted
   * into a ResearchArtifactVersion row BEFORE any field is overwritten — the
   * version row must record "what version N looked like", so the snapshot
   * has to be written while `existing.content`/`.version` still hold the
   * outgoing values, never after they've been mutated in place. Only then is
   * `version` incremented and the document's fields overwritten.
   *
   * A brand-new artifact starts at `version=1` with no snapshot (there is no
   * prior content to preserve).
   */
  async write(
    topicId: string,
    input: WriteArtifactInput,
    scope: ResearchScope,
  ): Promise<ResearchArtifactDocument> {
    const topicObjectId = new Types.ObjectId(topicId);
    const slug = normalizeSlug(input.slug);
    const ownership = this.deriveOwnership(scope);
    const runId = input.runId ? new Types.ObjectId(input.runId) : undefined;

    const existing = await this.artifactModel.findOne({ topicId: topicObjectId, slug }).exec();

    let artifact: ResearchArtifactDocument;
    let action: 'created' | 'updated';

    if (existing) {
      // Snapshot BEFORE mutating — see method doc.
      await this.artifactVersionModel.create({
        artifactId: existing._id,
        version: existing.version,
        content: existing.content,
        changeNote: input.changeNote,
        runId,
      });

      existing.title = input.title;
      existing.content = input.content;
      existing.summary = input.summary;
      existing.tags = input.tags ?? [];
      existing.sources = input.sources ?? [];
      existing.version = existing.version + 1;
      existing.projectId = ownership.projectId;
      existing.customerId = ownership.customerId;
      existing.isGlobal = ownership.isGlobal;
      if (runId) existing.lastRunId = runId;

      await existing.save();
      artifact = existing;
      action = 'updated';
    } else {
      artifact = await this.artifactModel.create({
        topicId: topicObjectId,
        slug,
        title: input.title,
        content: input.content,
        summary: input.summary,
        tags: input.tags ?? [],
        sources: input.sources ?? [],
        version: 1,
        projectId: ownership.projectId,
        customerId: ownership.customerId,
        isGlobal: ownership.isGlobal,
        lastRunId: runId,
      });
      action = 'created';
    }

    this.emitChange(artifact, action);
    return artifact;
  }

  /** Deletes an artifact together with all its version snapshots. */
  async remove(topicId: string, slug: string): Promise<void> {
    const normalized = normalizeSlug(slug);
    const artifact = await this.artifactModel
      .findOne({ topicId: new Types.ObjectId(topicId), slug: normalized })
      .exec();
    if (!artifact) {
      throw new NotFoundException(`ResearchArtifact "${normalized}" not found for topic ${topicId}`);
    }

    await this.artifactVersionModel.deleteMany({ artifactId: artifact._id }).exec();
    await this.artifactModel.deleteOne({ _id: artifact._id }).exec();

    this.emitChange(artifact, 'deleted');
  }

  async listVersions(artifactId: string): Promise<ResearchArtifactVersionDocument[]> {
    return this.artifactVersionModel
      .find({ artifactId: new Types.ObjectId(artifactId) })
      .sort({ version: -1 })
      .exec();
  }

  private emitChange(artifact: ResearchArtifactDocument, action: 'created' | 'updated' | 'deleted'): void {
    const verb = action === 'created' ? 'erstellt' : action === 'updated' ? 'aktualisiert' : 'gelöscht';
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: artifact.projectId?.toString() || null,
      customerId: artifact.customerId?.toString() || null,
      entity: 'research_artifact',
      action,
      entityId: artifact._id.toString(),
      summary: `Recherche-Artefakt "${artifact.title}" ${verb}`,
    });
  }
}
