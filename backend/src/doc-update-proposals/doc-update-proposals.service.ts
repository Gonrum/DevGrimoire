import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { errorMessage, pickAllowed } from '../common/narrow';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Model, Types } from 'mongoose';
import {
  CreateDocUpdateProposalDto,
  ListDocUpdateProposalsDto,
  ConvertDocProposalToTodoDto,
} from './dto/doc-update-proposal.dto';
import {
  DocProposalChangeMode,
  DocProposalSourceType,
  DocProposalStatus,
  DocProposalTargetType,
  DocUpdateProposal,
  DocUpdateProposalDocument,
} from './schemas/doc-update-proposal.schema';
import { PROJECT_CHANGED, ProjectChangeEvent } from '../events/project-event';
import { TodosService } from '../todos/todos.service';
import { TodoDocument, TodoPriority, TodoStatus } from '../todos/schemas/todo.schema';
import { Manual, ManualDocument } from '../manuals/schemas/manual.schema';
import { Knowledge, KnowledgeDocument } from '../knowledge/schemas/knowledge.schema';

const ALLOWED_TRANSITIONS: Record<DocProposalStatus, DocProposalStatus[]> = {
  [DocProposalStatus.OPEN]: [
    DocProposalStatus.ACCEPTED,
    DocProposalStatus.EDITED,
    DocProposalStatus.CONVERTED_TO_TODO,
    DocProposalStatus.DISMISSED,
    DocProposalStatus.SUPERSEDED,
  ],
  [DocProposalStatus.ACCEPTED]: [DocProposalStatus.EDITED],
  [DocProposalStatus.EDITED]: [DocProposalStatus.ACCEPTED, DocProposalStatus.DISMISSED],
  [DocProposalStatus.CONVERTED_TO_TODO]: [],
  [DocProposalStatus.DISMISSED]: [DocProposalStatus.OPEN],
  [DocProposalStatus.SUPERSEDED]: [],
};

const STOPWORDS = new Set([
  'der', 'die', 'das', 'und', 'oder', 'mit', 'für', 'fuer', 'auf', 'zur', 'zum',
  'ein', 'eine', 'einen', 'einem', 'einer', 'eines', 'ist', 'nicht', 'aber',
  'the', 'and', 'for', 'with', 'into', 'this', 'that', 'from', 'have', 'will',
  'must', 'should', 'when', 'what', 'todo', 'task', 'fix', 'add', 'new',
]);

function tokenize(text: string | undefined): Set<string> {
  if (!text) return new Set();
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9äöüß]+/)) {
    if (raw.length < 4) continue;
    if (STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

function intersectCount<T>(a: Set<T>, b: Set<T>): number {
  let n = 0;
  for (const v of a) if (b.has(v)) n++;
  return n;
}

@Injectable()
export class DocUpdateProposalsService {
  private readonly logger = new Logger(DocUpdateProposalsService.name);

  constructor(
    @InjectModel(DocUpdateProposal.name)
    private readonly proposalModel: Model<DocUpdateProposalDocument>,
    @InjectModel(Manual.name)
    private readonly manualModel: Model<ManualDocument>,
    @InjectModel(Knowledge.name)
    private readonly knowledgeModel: Model<KnowledgeDocument>,
    private readonly todosService: TodosService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async create(dto: CreateDocUpdateProposalDto): Promise<DocUpdateProposalDocument> {
    const dup = await this.proposalModel
      .findOne({
        projectId: new Types.ObjectId(dto.projectId),
        status: DocProposalStatus.OPEN,
        'source.type': dto.source.type,
        'source.id': dto.source.id,
        'target.type': dto.target.type,
        'target.title': dto.target.title,
      })
      .exec();
    if (dup) return dup;

    const proposal = await this.proposalModel.create({
      projectId: new Types.ObjectId(dto.projectId),
      status: DocProposalStatus.OPEN,
      source: {
        type: dto.source.type,
        id: dto.source.id,
        title: dto.source.title,
        summary: dto.source.summary,
        changedFiles: dto.source.changedFiles ?? [],
        tags: dto.source.tags ?? [],
      },
      target: {
        type: dto.target.type,
        id: dto.target.id ? new Types.ObjectId(dto.target.id) : undefined,
        path: dto.target.path,
        title: dto.target.title,
      },
      reason: dto.reason,
      confidence: dto.confidence,
      suggestedChange: dto.suggestedChange,
      createdBy: dto.createdBy ?? 'system',
      metadata: dto.metadata,
    });

    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: proposal.projectId.toString(),
      entity: 'doc-update-proposal',
      action: 'created',
      entityId: proposal._id.toString(),
      summary: `Doc-Update-Vorschlag für "${proposal.target.title}"`,
    });

    return proposal;
  }

  async list(query: ListDocUpdateProposalsDto): Promise<DocUpdateProposalDocument[]> {
    const filter: Record<string, unknown> = {};
    if (query.projectId) filter.projectId = new Types.ObjectId(query.projectId);
    if (query.status) filter.status = query.status;
    if (query.sourceType) filter['source.type'] = query.sourceType;
    if (query.sourceId) filter['source.id'] = query.sourceId;
    if (query.targetType) filter['target.type'] = query.targetType;
    if (query.targetId) filter['target.id'] = new Types.ObjectId(query.targetId);
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    return this.proposalModel.find(filter).sort({ createdAt: -1 }).limit(limit).exec();
  }

  async findById(id: string): Promise<DocUpdateProposalDocument> {
    const proposal = await this.proposalModel.findById(id).exec();
    if (!proposal) throw new NotFoundException(`DocUpdateProposal ${id} not found`);
    return proposal;
  }

  async updateStatus(
    id: string,
    nextStatus: DocProposalStatus,
    note?: string,
  ): Promise<DocUpdateProposalDocument> {
    const proposal = await this.findById(id);
    const allowed = ALLOWED_TRANSITIONS[proposal.status] ?? [];
    if (!allowed.includes(nextStatus)) {
      throw new BadRequestException(
        `Invalid status transition: ${proposal.status} → ${nextStatus}`,
      );
    }
    const update: Record<string, unknown> = { status: nextStatus };
    if (note) update['metadata.statusNote'] = note;
    await this.proposalModel.updateOne({ _id: proposal._id }, { $set: update }).exec();
    return this.findById(id);
  }

  async convertToTodo(
    id: string,
    overrides?: ConvertDocProposalToTodoDto,
  ): Promise<{ proposal: DocUpdateProposalDocument; todo: TodoDocument; reused: boolean }> {
    const proposal = await this.findById(id);
    if (proposal.status === DocProposalStatus.CONVERTED_TO_TODO) {
      const existingId = proposal.metadata?.todoId;
      if (typeof existingId === 'string' && Types.ObjectId.isValid(existingId)) {
        try {
          const existing = await this.todosService.findById(existingId);
          return { proposal, todo: existing, reused: true };
        } catch {
          // fall through, recreate
        }
      }
    }
    if (proposal.status !== DocProposalStatus.OPEN && proposal.status !== DocProposalStatus.CONVERTED_TO_TODO) {
      throw new BadRequestException(
        `Cannot convert proposal in status "${proposal.status}" to a todo`,
      );
    }

    const title = (overrides?.title ?? `Doc-Update: ${proposal.target.title}`).slice(0, 200);
    const targetRef = proposal.target.path
      ? `\`${proposal.target.path}\``
      : `${proposal.target.type} "${proposal.target.title}"`;
    const change = proposal.suggestedChange;
    const description =
      `Auto-generiert aus Doc-Update-Vorschlag \`${proposal._id.toString()}\`.\n\n` +
      `**Ziel:** ${targetRef}\n` +
      `**Quelle:** ${proposal.source.type} \`${proposal.source.id}\`${proposal.source.title ? ` — ${proposal.source.title}` : ''}\n` +
      `**Begründung:** ${proposal.reason}\n` +
      `**Confidence:** ${proposal.confidence}\n\n` +
      `**Vorschlag (${change.mode}):**\n\n${change.summary}` +
      (change.instructions ? `\n\n**Anleitung:**\n\n${change.instructions}` : '') +
      (change.diff ? `\n\n**Diff:**\n\n\`\`\`diff\n${change.diff}\n\`\`\`` : '');

    const todo = await this.todosService.create({
      projectId: proposal.projectId.toString(),
      title,
      description,
      status: TodoStatus.OPEN,
      priority: pickAllowed(Object.values(TodoPriority), overrides?.priority) ?? TodoPriority.MEDIUM,
      tags: overrides?.tags ?? ['documentation', 'living-doc'],
      milestoneId: overrides?.milestoneId,
    });

    await this.proposalModel
      .updateOne(
        { _id: proposal._id },
        {
          $set: {
            status: DocProposalStatus.CONVERTED_TO_TODO,
            'metadata.todoId': todo._id.toString(),
            'metadata.todoCreatedAt': new Date().toISOString(),
          },
        },
      )
      .exec();
    const refreshed = await this.findById(id);
    return { proposal: refreshed, todo, reused: false };
  }

  async removeByProject(projectId: string): Promise<void> {
    if (!Types.ObjectId.isValid(projectId)) return;
    await this.proposalModel.deleteMany({ projectId: new Types.ObjectId(projectId) }).exec();
  }

  // ---- Detection -----------------------------------------------------------

  @OnEvent(PROJECT_CHANGED)
  async handleTodoChange(event: ProjectChangeEvent): Promise<void> {
    if (event.entity === 'project' && event.action === 'deleted' && event.entityId) {
      await this.removeByProject(event.entityId);
      return;
    }
    if (event.entity !== 'todo' || event.action !== 'updated' || !event.entityId) return;
    if (!event.summary || !/Status → (review|done)/.test(event.summary)) return;
    if (!event.projectId) return;
    try {
      await this.detectForTodo(event.entityId);
    } catch (err) {
      this.logger.warn(`Doc detection failed for todo ${event.entityId}: ${errorMessage(err)}`);
    }
  }

  async detectForTodo(todoId: string): Promise<DocUpdateProposalDocument[]> {
    const todo = await this.todosService.findById(todoId);
    if (!todo.projectId) return [];
    if (todo.status !== TodoStatus.REVIEW && todo.status !== TodoStatus.DONE) return [];

    const projectId = todo.projectId.toString();
    const todoTags = new Set((todo.tags ?? []).map((t) => t.toLowerCase()));
    const todoTitleTokens = tokenize(todo.title);

    const [manuals, knowledge] = await Promise.all([
      this.manualModel.find({ projectId: new Types.ObjectId(projectId) }).select('title category').exec(),
      this.knowledgeModel
        .find({ projectId: new Types.ObjectId(projectId) })
        .select('topic tags category')
        .exec(),
    ]);

    const sourceMeta = {
      type: DocProposalSourceType.TODO,
      id: todo._id.toString(),
      title: todo.displayNumber ? `${todo.displayNumber}: ${todo.title}` : todo.title,
      summary: `${todo.title}${todo.description ? ` — ${todo.description.slice(0, 200)}` : ''}`,
      tags: Array.from(todoTags),
    };

    const candidates: Array<{ score: number; create: () => Promise<DocUpdateProposalDocument> }> = [];

    for (const m of manuals) {
      const titleTokens = tokenize(m.title);
      const keywordOverlap = intersectCount(todoTitleTokens, titleTokens);
      const categoryHit = m.category && todoTags.has(m.category.toLowerCase()) ? 1 : 0;
      let score = 0;
      if (keywordOverlap >= 1) score += 3;
      if (categoryHit) score += 2;
      if (score < 3) continue;

      const mode =
        score >= 7
          ? DocProposalChangeMode.INSTRUCTIONS
          : DocProposalChangeMode.REVIEW_ONLY;
      const reasonParts: string[] = [];
      if (keywordOverlap) reasonParts.push(`${keywordOverlap} gemeinsame Titel-Begriffe`);
      if (categoryHit) reasonParts.push(`Kategorie "${m.category}" matcht Todo-Tag`);

      candidates.push({
        score,
        create: () =>
          this.create({
            projectId,
            source: sourceMeta,
            target: {
              type: DocProposalTargetType.MANUAL,
              id: m._id.toString(),
              title: m.title,
            },
            reason: `Todo "${todo.title}" könnte Manual "${m.title}" betreffen (${reasonParts.join(', ')}).`,
            confidence: Math.min(score, 10),
            suggestedChange: {
              mode,
              summary:
                mode === DocProposalChangeMode.INSTRUCTIONS
                  ? `Prüfen, ob das Manual nach dem Abschluss von "${todo.displayNumber ?? todo.title}" angepasst werden muss. Relevante Begriffe: ${[...todoTitleTokens].slice(0, 6).join(', ')}.`
                  : `Manual könnte veraltet sein und benötigt eine Sichtung.`,
            },
          }),
      });
    }

    for (const k of knowledge) {
      const titleTokens = tokenize(k.topic);
      const keywordOverlap = intersectCount(todoTitleTokens, titleTokens);
      const tagOverlap = intersectCount(
        todoTags,
        new Set((k.tags ?? []).map((t) => t.toLowerCase())),
      );
      const categoryHit = k.category && todoTags.has(k.category.toLowerCase()) ? 1 : 0;
      let score = 0;
      if (tagOverlap >= 1) score += 3;
      if (keywordOverlap >= 1) score += 2;
      if (categoryHit) score += 1;
      if (score < 3) continue;

      const mode =
        score >= 7
          ? DocProposalChangeMode.INSTRUCTIONS
          : DocProposalChangeMode.REVIEW_ONLY;
      const reasonParts: string[] = [];
      if (tagOverlap) reasonParts.push(`${tagOverlap} gemeinsame Tags`);
      if (keywordOverlap) reasonParts.push(`${keywordOverlap} gemeinsame Begriffe`);
      if (categoryHit) reasonParts.push(`Kategorie matcht Todo-Tag`);

      candidates.push({
        score,
        create: () =>
          this.create({
            projectId,
            source: sourceMeta,
            target: {
              type: DocProposalTargetType.KNOWLEDGE,
              id: k._id.toString(),
              title: k.topic,
            },
            reason: `Todo "${todo.title}" könnte Wissens-Eintrag "${k.topic}" betreffen (${reasonParts.join(', ')}).`,
            confidence: Math.min(score, 10),
            suggestedChange: {
              mode,
              summary:
                mode === DocProposalChangeMode.INSTRUCTIONS
                  ? `Prüfen, ob "${k.topic}" nach Abschluss des Todos noch korrekt ist. Tags: ${(k.tags ?? []).slice(0, 5).join(', ') || '—'}.`
                  : `Knowledge-Eintrag könnte veraltet sein und benötigt eine Sichtung.`,
            },
          }),
      });
    }

    candidates.sort((a, b) => b.score - a.score);
    const top = candidates.slice(0, 5);
    const created: DocUpdateProposalDocument[] = [];
    for (const c of top) {
      try {
        created.push(await c.create());
      } catch (err) {
        this.logger.warn(`Failed to create proposal: ${errorMessage(err)}`);
      }
    }
    return created;
  }
}
