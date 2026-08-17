import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { errorMessage, isDuplicateKeyError } from '../common/narrow';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Model, Types } from 'mongoose';
import { PROJECT_CHANGED, ProjectChangeEvent } from '../events/project-event';
import { CreateKgEdgeDto, ListKgEdgesDto } from './dto/knowledge-graph.dto';
import {
  KgEntityType,
  KgRelation,
  KnowledgeGraphEdge,
  KnowledgeGraphEdgeDocument,
} from './schemas/knowledge-graph-edge.schema';
import { Todo, TodoDocument } from '../todos/schemas/todo.schema';
import { Milestone, MilestoneDocument } from '../milestones/schemas/milestone.schema';
import { Knowledge, KnowledgeDocument } from '../knowledge/schemas/knowledge.schema';
import { Manual, ManualDocument } from '../manuals/schemas/manual.schema';
import { Changelog, ChangelogDocument } from '../changelog/schemas/changelog.schema';
import {
  ValidationReport,
  ValidationReportDocument,
} from '../validation-reports/schemas/validation-report.schema';
import {
  DocUpdateProposal,
  DocUpdateProposalDocument,
} from '../doc-update-proposals/schemas/doc-update-proposal.schema';
import { Commit, CommitDocument } from '../commits/schemas/commit.schema';
import { projectIdFilter } from '../common/project-id-filter';

const REBUILD_ENTITIES: Array<ProjectChangeEvent['entity']> = [
  'todo',
  'milestone',
  'knowledge',
  'manual',
  'changelog',
  'commit',
  'doc-update-proposal',
];

interface EdgeKey {
  source: { entityType: KgEntityType; entityId: string };
  target: { entityType: KgEntityType; entityId: string };
  relation: KgRelation;
}

function edgeKeyOf(e: EdgeKey): string {
  return [
    e.source.entityType, e.source.entityId,
    e.target.entityType, e.target.entityId,
    e.relation,
  ].join('|');
}

interface DiscoveredEdge extends EdgeKey {
  source: { entityType: KgEntityType; entityId: string; label?: string };
  target: { entityType: KgEntityType; entityId: string; label?: string };
  weight: number;
  confidence: number;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class KnowledgeGraphService {
  private readonly logger = new Logger(KnowledgeGraphService.name);
  private readonly debouncedProjects = new Map<string, NodeJS.Timeout>();

  constructor(
    @InjectModel(KnowledgeGraphEdge.name)
    private readonly edgeModel: Model<KnowledgeGraphEdgeDocument>,
    @InjectModel(Todo.name) private readonly todoModel: Model<TodoDocument>,
    @InjectModel(Milestone.name) private readonly milestoneModel: Model<MilestoneDocument>,
    @InjectModel(Knowledge.name) private readonly knowledgeModel: Model<KnowledgeDocument>,
    @InjectModel(Manual.name) private readonly manualModel: Model<ManualDocument>,
    @InjectModel(Changelog.name) private readonly changelogModel: Model<ChangelogDocument>,
    @InjectModel(ValidationReport.name)
    private readonly validationReportModel: Model<ValidationReportDocument>,
    @InjectModel(DocUpdateProposal.name)
    private readonly docProposalModel: Model<DocUpdateProposalDocument>,
    @InjectModel(Commit.name) private readonly commitModel: Model<CommitDocument>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ---- CRUD ---------------------------------------------------------------

  async create(dto: CreateKgEdgeDto): Promise<KnowledgeGraphEdgeDocument> {
    if (
      dto.source.entityType === dto.target.entityType &&
      dto.source.entityId === dto.target.entityId
    ) {
      throw new BadRequestException('Self-loops are not allowed');
    }
    try {
      return await this.edgeModel.create({
        projectId: new Types.ObjectId(dto.projectId),
        source: dto.source,
        target: dto.target,
        relation: dto.relation,
        weight: dto.weight ?? 1,
        confidence: dto.confidence ?? 1,
        direction: dto.direction ?? 'directed',
        createdBy: dto.createdBy ?? 'user',
        userConfirmed: (dto.createdBy ?? 'user') === 'user',
        metadata: dto.metadata,
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        // Duplicate — return existing
        const existing = await this.edgeModel
          .findOne({
            projectId: new Types.ObjectId(dto.projectId),
            'source.entityType': dto.source.entityType,
            'source.entityId': dto.source.entityId,
            'target.entityType': dto.target.entityType,
            'target.entityId': dto.target.entityId,
            relation: dto.relation,
          })
          .exec();
        if (existing) return existing;
      }
      throw err;
    }
  }

  async list(query: ListKgEdgesDto): Promise<KnowledgeGraphEdgeDocument[]> {
    const filter: Record<string, unknown> = {};
    if (query.projectId) filter.projectId = new Types.ObjectId(query.projectId);
    if (query.entityType && query.entityId) {
      filter.$or = [
        { 'source.entityType': query.entityType, 'source.entityId': query.entityId },
        { 'target.entityType': query.entityType, 'target.entityId': query.entityId },
      ];
    } else if (query.entityType) {
      filter.$or = [
        { 'source.entityType': query.entityType },
        { 'target.entityType': query.entityType },
      ];
    }
    if (query.relation) filter.relation = query.relation;
    const limit = Math.min(Math.max(query.limit ?? 500, 1), 5000);
    return this.edgeModel.find(filter).sort({ createdAt: -1 }).limit(limit).exec();
  }

  async findById(id: string): Promise<KnowledgeGraphEdgeDocument> {
    const edge = await this.edgeModel.findById(id).exec();
    if (!edge) throw new NotFoundException(`Edge ${id} not found`);
    return edge;
  }

  async remove(id: string): Promise<void> {
    const result = await this.edgeModel.findByIdAndDelete(id).exec();
    if (!result) throw new NotFoundException(`Edge ${id} not found`);
  }

  async confirm(id: string, confirmed: boolean): Promise<KnowledgeGraphEdgeDocument> {
    const edge = await this.findById(id);
    edge.userConfirmed = confirmed;
    await edge.save();
    return edge;
  }

  async removeByProject(projectId: string): Promise<void> {
    if (!Types.ObjectId.isValid(projectId)) return;
    await this.edgeModel.deleteMany({ projectId: new Types.ObjectId(projectId) }).exec();
  }

  // ---- Query helpers ------------------------------------------------------

  async neighbors(
    projectId: string,
    entityType: KgEntityType,
    entityId: string,
  ): Promise<KnowledgeGraphEdgeDocument[]> {
    return this.edgeModel
      .find({
        projectId: new Types.ObjectId(projectId),
        $or: [
          { 'source.entityType': entityType, 'source.entityId': entityId },
          { 'target.entityType': entityType, 'target.entityId': entityId },
        ],
      })
      .sort({ createdAt: -1 })
      .exec();
  }

  async impact(
    projectId: string,
    entityType: KgEntityType,
    entityId: string,
    depth = 2,
  ): Promise<{
    focal: { entityType: KgEntityType; entityId: string };
    reachable: Array<{ entityType: KgEntityType; entityId: string; label?: string; depth: number }>;
    edges: KnowledgeGraphEdgeDocument[];
  }> {
    const maxDepth = Math.max(1, Math.min(5, depth));
    const projectOid = new Types.ObjectId(projectId);
    const visited = new Map<string, { depth: number; label?: string }>();
    const allEdges: KnowledgeGraphEdgeDocument[] = [];
    const focalKey = `${entityType}:${entityId}`;
    visited.set(focalKey, { depth: 0 });
    let frontier: Array<{ entityType: KgEntityType; entityId: string }> = [{ entityType, entityId }];

    for (let d = 1; d <= maxDepth; d++) {
      if (frontier.length === 0) break;
      const edges = await this.edgeModel
        .find({
          projectId: projectOid,
          $or: frontier.flatMap((f) => [
            { 'source.entityType': f.entityType, 'source.entityId': f.entityId },
            { 'target.entityType': f.entityType, 'target.entityId': f.entityId },
          ]),
        })
        .exec();
      const next: Array<{ entityType: KgEntityType; entityId: string }> = [];
      for (const edge of edges) {
        allEdges.push(edge);
        for (const ep of [edge.source, edge.target]) {
          const key = `${ep.entityType}:${ep.entityId}`;
          if (!visited.has(key)) {
            visited.set(key, { depth: d, label: ep.label });
            next.push({ entityType: ep.entityType, entityId: ep.entityId });
          }
        }
      }
      frontier = next;
    }

    const reachable = Array.from(visited.entries())
      .filter(([key]) => key !== focalKey)
      .map(([key, v]) => {
        const [t, idStr] = key.split(':', 2);
        return { entityType: t as KgEntityType, entityId: idStr, label: v.label, depth: v.depth };
      });

    // Dedup edges (same edge may have been added twice when both endpoints were in frontier)
    const seenEdgeIds = new Set<string>();
    const dedupEdges = allEdges.filter((e) => {
      const id = e._id.toString();
      if (seenEdgeIds.has(id)) return false;
      seenEdgeIds.add(id);
      return true;
    });

    return { focal: { entityType, entityId }, reachable, edges: dedupEdges };
  }

  // ---- Discovery ----------------------------------------------------------

  @OnEvent(PROJECT_CHANGED)
  async handleProjectChange(event: ProjectChangeEvent): Promise<void> {
    if (event.action === 'deleted' && event.entity === 'project' && event.entityId) {
      await this.removeByProject(event.entityId);
      return;
    }
    if (!event.projectId) return;
    if (!REBUILD_ENTITIES.includes(event.entity)) return;
    this.scheduleRebuild(event.projectId);
  }

  /** Coalesce many rapid events into one rebuild per project. */
  private scheduleRebuild(projectId: string): void {
    const existing = this.debouncedProjects.get(projectId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.debouncedProjects.delete(projectId);
      this.discoverForProject(projectId).catch((err) => {
        this.logger.warn(`Graph rebuild failed for project ${projectId}: ${errorMessage(err)}`);
      });
    }, 1500);
    this.debouncedProjects.set(projectId, timer);
  }

  async discoverForProject(projectId: string): Promise<{
    discovered: number;
    inserted: number;
    pruned: number;
  }> {
    if (!Types.ObjectId.isValid(projectId)) {
      throw new BadRequestException(`Invalid projectId: ${projectId}`);
    }
    const projectOid = new Types.ObjectId(projectId);
    const edges = new Map<string, DiscoveredEdge>();
    const push = (e: DiscoveredEdge) => {
      if (
        e.source.entityType === e.target.entityType &&
        e.source.entityId === e.target.entityId
      ) {
        return;
      }
      edges.set(edgeKeyOf(e), e);
    };

    const projectFilter = projectIdFilter(projectId);
    const [todos, milestones, knowledge, manuals, validationReports, docProposals, commits] =
      await Promise.all([
        this.todoModel.find({ projectId: projectFilter }).select('title displayNumber tags milestoneId blockedBy number').exec(),
        this.milestoneModel.find({ projectId: projectFilter }).select('name displayNumber changelogId').exec(),
        this.knowledgeModel.find({ projectId: projectFilter }).select('topic tags category').exec(),
        this.manualModel.find({ projectId: projectFilter }).select('title category').exec(),
        this.validationReportModel.find({ projectId: projectFilter }).select('name todoId status').exec(),
        this.docProposalModel.find({ projectId: projectFilter }).select('source target reason').exec(),
        this.commitModel.find({ projectId: projectFilter }).select('message sha').exec(),
      ]);

    // todo → milestone
    for (const t of todos) {
      const label = t.displayNumber ? `${t.displayNumber}: ${t.title}` : t.title;
      if (t.milestoneId) {
        const mid = t.milestoneId.toString();
        const ms = milestones.find((m) => m._id.toString() === mid);
        push({
          source: { entityType: 'todo', entityId: t._id.toString(), label },
          target: {
            entityType: 'milestone',
            entityId: mid,
            label: ms ? (ms.displayNumber ? `${ms.displayNumber}: ${ms.name}` : ms.name) : undefined,
          },
          relation: 'belongs_to',
          weight: 5,
          confidence: 1,
        });
      }
      // todo → todo (blockedBy)
      for (const blocker of t.blockedBy ?? []) {
        const blockerId = blocker.toString();
        const target = todos.find((other) => other._id.toString() === blockerId);
        push({
          source: { entityType: 'todo', entityId: t._id.toString(), label },
          target: {
            entityType: 'todo',
            entityId: blockerId,
            label: target ? (target.displayNumber ? `${target.displayNumber}: ${target.title}` : target.title) : undefined,
          },
          relation: 'blocked_by',
          weight: 5,
          confidence: 1,
        });
      }
    }

    // milestone → changelog
    for (const m of milestones) {
      if (m.changelogId) {
        push({
          source: {
            entityType: 'milestone',
            entityId: m._id.toString(),
            label: m.displayNumber ? `${m.displayNumber}: ${m.name}` : m.name,
          },
          target: { entityType: 'changelog', entityId: m.changelogId.toString() },
          relation: 'completed_by',
          weight: 5,
          confidence: 1,
        });
      }
    }

    // todo ↔ knowledge by shared tag(s)
    const knowledgeByTag = new Map<string, KnowledgeDocument[]>();
    for (const k of knowledge) {
      for (const tag of k.tags ?? []) {
        const key = tag.toLowerCase();
        if (!knowledgeByTag.has(key)) knowledgeByTag.set(key, []);
        knowledgeByTag.get(key)!.push(k);
      }
    }
    for (const t of todos) {
      const label = t.displayNumber ? `${t.displayNumber}: ${t.title}` : t.title;
      const todoTags = (t.tags ?? []).map((x) => x.toLowerCase());
      const seenK = new Set<string>();
      for (const tag of todoTags) {
        for (const k of knowledgeByTag.get(tag) ?? []) {
          const kid = k._id.toString();
          if (seenK.has(kid)) continue;
          seenK.add(kid);
          push({
            source: { entityType: 'todo', entityId: t._id.toString(), label },
            target: { entityType: 'knowledge', entityId: kid, label: k.topic },
            relation: 'tagged_overlap',
            weight: 3,
            confidence: 0.6,
            metadata: { sharedTag: tag },
          });
        }
      }
    }

    // todo ↔ manual by category-match against todo tags
    for (const m of manuals) {
      if (!m.category) continue;
      const cat = m.category.toLowerCase();
      for (const t of todos) {
        if (!(t.tags ?? []).some((tag) => tag.toLowerCase() === cat)) continue;
        const label = t.displayNumber ? `${t.displayNumber}: ${t.title}` : t.title;
        push({
          source: { entityType: 'todo', entityId: t._id.toString(), label },
          target: { entityType: 'manual', entityId: m._id.toString(), label: m.title },
          relation: 'category_match',
          weight: 3,
          confidence: 0.5,
          metadata: { category: m.category },
        });
      }
    }

    // validation_report → todo
    for (const vr of validationReports) {
      if (!vr.todoId) continue;
      const todoId = vr.todoId.toString();
      const t = todos.find((x) => x._id.toString() === todoId);
      push({
        source: { entityType: 'validation_report', entityId: vr._id.toString(), label: vr.name },
        target: {
          entityType: 'todo',
          entityId: todoId,
          label: t ? (t.displayNumber ? `${t.displayNumber}: ${t.title}` : t.title) : undefined,
        },
        relation: 'validates',
        weight: 4,
        confidence: 1,
      });
    }

    // doc_update_proposal source/target
    for (const p of docProposals) {
      // Use source as origin todo/commit/etc., target as manual/knowledge
      push({
        source: { entityType: 'doc_update_proposal', entityId: p._id.toString(), label: p.target.title },
        target: {
          entityType: p.target.type as KgEntityType,
          entityId: p.target.id ? p.target.id.toString() : p._id.toString(),
          label: p.target.title,
        },
        relation: 'proposes_update',
        weight: 3,
        confidence: 0.7,
      });
      // And the source (todo/commit/etc.) → doc_update_proposal
      const srcType = (p.source.type === 'workflow_run' ? 'workflow' : p.source.type) as KgEntityType;
      push({
        source: { entityType: srcType, entityId: p.source.id, label: p.source.title },
        target: { entityType: 'doc_update_proposal', entityId: p._id.toString(), label: p.target.title },
        relation: 'references',
        weight: 2,
        confidence: 0.7,
      });
    }

    // commit → todo (T-N mentions)
    const todoByDisplayNumber = new Map<string, TodoDocument>();
    for (const t of todos) {
      if (t.displayNumber) todoByDisplayNumber.set(t.displayNumber.toUpperCase(), t);
    }
    const mentionPattern = /\bT-\d+\b/gi;
    for (const c of commits) {
      const msg = (c.message ?? '').toString();
      const hits = msg.match(mentionPattern);
      if (!hits) continue;
      const shortSha = (c.sha ?? '').slice(0, 7);
      const cidLabel = shortSha ? `${shortSha}: ${msg.slice(0, 60)}` : msg.slice(0, 60);
      for (const hit of new Set(hits.map((h) => h.toUpperCase()))) {
        const t = todoByDisplayNumber.get(hit);
        if (!t) continue;
        push({
          source: { entityType: 'commit', entityId: c._id.toString(), label: cidLabel },
          target: {
            entityType: 'todo',
            entityId: t._id.toString(),
            label: t.displayNumber ? `${t.displayNumber}: ${t.title}` : t.title,
          },
          relation: 'mentions',
          weight: 4,
          confidence: 0.9,
        });
      }
    }

    // Persist: upsert each discovered edge; remove any system-generated edges that no longer match
    let inserted = 0;
    for (const e of edges.values()) {
      try {
        const res = await this.edgeModel.updateOne(
          {
            projectId: projectOid,
            'source.entityType': e.source.entityType,
            'source.entityId': e.source.entityId,
            'target.entityType': e.target.entityType,
            'target.entityId': e.target.entityId,
            relation: e.relation,
          },
          {
            $setOnInsert: {
              createdBy: 'system',
              userConfirmed: false,
            },
            $set: {
              'source.label': e.source.label,
              'target.label': e.target.label,
              weight: e.weight,
              confidence: e.confidence,
              metadata: e.metadata,
              direction: 'directed',
            },
          },
          { upsert: true },
        );
        if (res.upsertedCount && res.upsertedCount > 0) inserted++;
      } catch (err) {
        // Race condition on unique index can produce duplicate-key errors that are safe to ignore.
        if (!isDuplicateKeyError(err)) {
          this.logger.warn(`Failed to upsert edge: ${errorMessage(err)}`);
        }
      }
    }

    // Prune stale system-generated edges (not user-confirmed and not in current discovery set)
    const existing = await this.edgeModel
      .find({ projectId: projectOid, createdBy: 'system', userConfirmed: false })
      .exec();
    const keepKeys = new Set(edges.keys());
    let pruned = 0;
    for (const e of existing) {
      const key = edgeKeyOf({
        source: { entityType: e.source.entityType, entityId: e.source.entityId },
        target: { entityType: e.target.entityType, entityId: e.target.entityId },
        relation: e.relation,
      });
      if (!keepKeys.has(key)) {
        await this.edgeModel.deleteOne({ _id: e._id }).exec();
        pruned++;
      }
    }

    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId,
      entity: 'knowledge-graph',
      action: 'updated',
      summary: `Wissensgraph aktualisiert: ${edges.size} Kanten, ${inserted} neu, ${pruned} entfernt`,
    });

    return { discovered: edges.size, inserted, pruned };
  }
}
