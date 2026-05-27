import {
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { FilterQuery, Model, Types } from 'mongoose';
import {
  Question,
  QuestionDirection,
  QuestionDocument,
  QuestionStatus,
} from './schemas/question.schema';
import { CreateQuestionDto } from './dto/create-question.dto';
import { ConvertToKnowledgeDto } from './dto/convert-to-knowledge.dto';
import { TodosService } from '../todos/todos.service';
import { NotificationsService } from '../notifications/notifications.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { KnowledgeDocument } from '../knowledge/schemas/knowledge.schema';
import { AuthService } from '../auth/auth.service';
import { PROJECT_CHANGED, ProjectChangeEvent } from '../events/project-event';

export const QUESTION_CREATED = 'question.created';
export const QUESTION_ANSWERED = 'question.answered';

export interface QuestionsByTodoSummary {
  todoId: string;
  pendingAgentToUser: number;
  expiredAgentToUser: number;
  pendingUserToAgent: number;
  total: number;
  lastUpdatedAt: Date;
}

@Injectable()
export class QuestionsService implements OnModuleInit {
  private readonly logger = new Logger(QuestionsService.name);

  constructor(
    @InjectModel(Question.name)
    private questionModel: Model<QuestionDocument>,
    private eventEmitter: EventEmitter2,
    @Inject(forwardRef(() => TodosService))
    private todosService: TodosService,
    private notificationsService: NotificationsService,
    private knowledgeService: KnowledgeService,
    @Inject(forwardRef(() => AuthService))
    private authService: AuthService,
  ) {}

  /**
   * Drop the legacy TTL index on `expiresAt` (M-30): with TTL, expired
   * questions get auto-removed and the user can never respond after timeout.
   * Recreated as a regular index further down via the schema definition.
   */
  async onModuleInit(): Promise<void> {
    try {
      const indexes = await this.questionModel.collection.indexes();
      let droppedTtl = false;
      for (const idx of indexes) {
        if ((idx as { expireAfterSeconds?: number }).expireAfterSeconds !== undefined) {
          await this.questionModel.collection.dropIndex(idx.name as string);
          this.logger.log(`Dropped legacy TTL index on questions: ${idx.name}`);
          droppedTtl = true;
        }
      }
      // After dropping the TTL index, force a re-sync so the new compound
      // index ({ status: 1, expiresAt: 1 }) actually gets created — Mongoose's
      // initial autoIndex run may have skipped it because the TTL index on
      // the same field already existed.
      if (droppedTtl) {
        await this.questionModel.ensureIndexes();
      }
    } catch (err) {
      this.logger.warn(`Could not normalise question indexes: ${(err as Error).message}`);
    }
  }

  async create(
    dto: CreateQuestionDto,
    userId?: string,
  ): Promise<QuestionDocument> {
    const direction: QuestionDirection = dto.direction ?? 'agent_to_user';

    let projectId = dto.projectId;
    if (dto.todoId && !projectId) {
      const todo = await this.todosService.findById(dto.todoId);
      projectId = todo.projectId?.toString();
    }

    const isAgentAsking = direction === 'agent_to_user';
    const timeoutMs = isAgentAsking ? (dto.timeoutSeconds || 300) * 1000 : 0;
    const expiresAt = isAgentAsking ? new Date(Date.now() + timeoutMs) : undefined;

    // T-393: resolve initial targets so findPending and notifications know
    // exactly who is on the hook. Empty array = implicit broadcast.
    let resolvedTargetUserIds: Types.ObjectId[] = [];
    if (isAgentAsking) {
      const resolved = await this.authService.resolveQuestionTargets({
        targetUserId: dto.targetUserId,
        targetRole: dto.targetRole,
        broadcast: dto.broadcast,
        projectId,
      });
      resolvedTargetUserIds = resolved.userIds.map((id) => new Types.ObjectId(id));
    }

    const entry = await this.questionModel.create({
      question: dto.question,
      options: dto.options || [],
      context: dto.context,
      todoId: dto.todoId ? new Types.ObjectId(dto.todoId) : undefined,
      projectId: projectId ? new Types.ObjectId(projectId) : undefined,
      targetUserId: dto.targetUserId ? new Types.ObjectId(dto.targetUserId) : undefined,
      targetRole: dto.targetRole,
      broadcast: dto.broadcast ?? false,
      resolvedTargetUserIds,
      createdByUserId: userId ? new Types.ObjectId(userId) : undefined,
      direction,
      agentRunId: dto.agentRunId,
      agentName: dto.agentName,
      timeoutMs,
      expiresAt,
      escalationChain: dto.escalationChain ?? [],
      escalationStep: 0,
      escalationHistory: [],
      responses: [],
    });

    if (dto.todoId) {
      await this.todosService
        .linkQuestion(dto.todoId, entry._id.toString())
        .catch(() => {
          /* todo might have been deleted — ignore */
        });
    }

    this.eventEmitter.emit(QUESTION_CREATED, {
      questionId: entry._id.toString(),
      direction,
      question: entry.question,
      options: entry.options,
      context: entry.context,
      todoId: entry.todoId?.toString() || null,
      projectId: entry.projectId?.toString() || null,
      targetUserId: entry.targetUserId?.toString() || null,
      targetRole: entry.targetRole ?? null,
      broadcast: entry.broadcast,
      resolvedTargetUserIds: resolvedTargetUserIds.map((id) => id.toString()),
      expiresAt: entry.expiresAt?.toISOString() ?? null,
    });

    if (isAgentAsking) {
      const title = 'Agent hat eine Frage';
      const body =
        entry.question.length > 100
          ? entry.question.slice(0, 97) + '...'
          : entry.question;
      const url = entry.todoId
        ? `/projects/${projectId}/todos/${entry.todoId}`
        : undefined;
      await this.notificationsService
        .create(title, body, url, 'ask_user')
        .catch(() => {
          /* push not available — ignore */
        });
    }

    return entry;
  }

  /**
   * Answer a question. Allowed even on `expired` ones (M-30): timeouts only
   * stop the agent from blocking, but the user retains the right to respond
   * later from the todo detail view.
   *
   * Multi-target behaviour (T-393): when the question has more than one
   * resolved target (role/broadcast) additional users may still respond after
   * the first answer landed. The first response wins (`answer`/`answeredByUserId`
   * stay frozen); every additional reply is appended to `responses` for audit.
   */
  async answer(
    id: string,
    answer: string,
    options: { userId?: string; byAgent?: boolean } = {},
  ): Promise<QuestionDocument> {
    const entry = await this.questionModel.findById(id).exec();
    if (!entry) throw new NotFoundException(`Question ${id} not found`);

    if (options.byAgent && entry.direction !== 'user_to_agent') {
      // Agents may only answer follow-up questions the user asked them.
      // The reverse direction (agent_to_user) is reserved for human responses
      // and must not be marked as "agent-answered" in the audit trail.
      throw new BadRequestException('Agents may only answer user_to_agent questions');
    }

    if (entry.options.length > 0 && !entry.options.includes(answer)) {
      throw new BadRequestException(
        `Answer must be one of: ${entry.options.join(', ')}`,
      );
    }

    const targets = entry.resolvedTargetUserIds ?? [];
    const isMultiTarget = targets.length > 1 || entry.broadcast === true || !!entry.targetRole;

    // T-393 permission check (only for human responses): the user must be in
    // the resolved-target list or the question must be legacy (no targets).
    if (!options.byAgent && options.userId && targets.length > 0) {
      const userIdStr = options.userId;
      const eligible = targets.some((t) => t.toString() === userIdStr);
      if (!eligible) {
        throw new BadRequestException(
          'You are not addressed by this question and cannot answer it.',
        );
      }
    }

    const alreadyAnswered = entry.status === 'answered';
    if (alreadyAnswered && !isMultiTarget) {
      throw new BadRequestException('Question already answered');
    }

    // Prevent the same user from answering twice on a multi-target question.
    if (alreadyAnswered && options.userId && (entry.responses ?? []).some((r) => r.userId === options.userId)) {
      throw new BadRequestException('You have already answered this question.');
    }

    let username: string | undefined;
    if (options.userId) {
      const u = await this.authService.findUserById(options.userId).catch(() => null);
      username = u?.username;
    }

    const response = {
      userId: options.userId,
      username,
      byAgent: options.byAgent === true,
      answer,
      at: new Date(),
    };
    entry.responses = [...(entry.responses ?? []), response];

    if (!alreadyAnswered) {
      // First response wins — freeze the legacy answer fields.
      entry.answer = answer;
      entry.status = 'answered';
      entry.answeredAt = response.at;
      entry.answeredByAgent = options.byAgent === true;
      if (options.userId) {
        entry.answeredByUserId = new Types.ObjectId(options.userId);
      }
    }

    await entry.save();

    if (entry.todoId) {
      const heading = entry.direction === 'user_to_agent'
        ? '**User-Folgefrage:**'
        : '**Agent-Rückfrage:**';
      const author = options.byAgent ? 'agent' : 'user';
      const attribution = !options.byAgent && username
        ? ` _(${username})_`
        : '';
      const commentText = alreadyAnswered
        ? `${heading} ${entry.question}\n**Zusätzliche Antwort${attribution}:** ${answer}`
        : `${heading} ${entry.question}\n**Antwort${attribution}:** ${answer}`;
      await this.todosService
        .addComment(entry.todoId.toString(), commentText, author)
        .catch(() => {
          /* todo might have been deleted — ignore */
        });
    }

    this.eventEmitter.emit(QUESTION_ANSWERED, {
      questionId: id,
      answer,
      direction: entry.direction,
      todoId: entry.todoId?.toString() || null,
      projectId: entry.projectId?.toString() || null,
      answeredByUserId: options.userId || null,
      byAgent: options.byAgent === true,
      additional: alreadyAnswered,
    });

    return entry;
  }

  async findById(id: string): Promise<QuestionDocument> {
    const entry = await this.questionModel.findById(id).exec();
    if (!entry) throw new NotFoundException(`Question ${id} not found`);
    return entry;
  }

  /**
   * Pending (not yet expired) questions — used by SSE / agent-side UI and by
   * the global QuestionDialog modal.
   *
   * Permission filter (T-393): a user only sees questions they are on the hook
   * for — either a snapshot resolved target (explicit user, role-match, or
   * broadcast in their project scope) or a legacy question without resolved
   * targets (visible to everyone, as before).
   */
  async findPending(userId?: string, direction?: QuestionDirection): Promise<QuestionDocument[]> {
    const filter: FilterQuery<QuestionDocument> = { status: 'pending' };
    if (direction) filter.direction = direction;
    if (userId) {
      filter.$or = [
        { resolvedTargetUserIds: new Types.ObjectId(userId) },
        { resolvedTargetUserIds: { $size: 0 } },
        // Pre-T-393 documents have neither resolvedTargetUserIds nor the new
        // broadcast flag — keep them visible to every authenticated user.
        { resolvedTargetUserIds: { $exists: false } },
      ];
    }
    const now = new Date();
    filter.$and = [
      ...(Array.isArray(filter.$and) ? filter.$and : []),
      { $or: [{ expiresAt: { $exists: false } }, { expiresAt: null }, { expiresAt: { $gt: now } }] },
    ];
    return this.questionModel.find(filter).sort({ createdAt: -1 }).exec();
  }

  /**
   * "Open" questions = not yet answered. Includes `pending` and
   * `expired`-but-still-answerable rows. Used by the dashboard widget and the
   * todo lila-marking aggregate.
   */
  async findOpen(filter: {
    projectId?: string;
    direction?: QuestionDirection;
    todoId?: string;
    limit?: number;
    offset?: number;
    includeAnswered?: boolean;
  } = {}): Promise<{ items: QuestionDocument[]; total: number }> {
    const q: FilterQuery<QuestionDocument> = filter.includeAnswered
      ? {}
      : { status: { $in: ['pending', 'expired'] } };
    if (filter.projectId) q.projectId = new Types.ObjectId(filter.projectId);
    if (filter.direction) q.direction = filter.direction;
    if (filter.todoId) q.todoId = new Types.ObjectId(filter.todoId);

    const limit = Math.max(1, Math.min(filter.limit ?? 100, 500));
    const offset = Math.max(0, filter.offset ?? 0);

    const [items, total] = await Promise.all([
      this.questionModel.find(q).sort({ createdAt: -1 }).skip(offset).limit(limit).exec(),
      this.questionModel.countDocuments(q).exec(),
    ]);
    return { items, total };
  }

  /**
   * Aggregate map of open-question counts per todo. Used by the frontend to
   * paint todos with pending questions in violet without N+1 queries.
   */
  async findOpenForTodos(todoIds: string[]): Promise<Record<string, QuestionsByTodoSummary>> {
    if (todoIds.length === 0) return {};
    const objectIds = todoIds
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));
    if (objectIds.length === 0) return {};

    const docs = await this.questionModel
      .find({ todoId: { $in: objectIds }, status: { $in: ['pending', 'expired'] } })
      .lean()
      .exec();

    const map: Record<string, QuestionsByTodoSummary> = {};
    for (const d of docs) {
      const key = d.todoId!.toString();
      const updatedAt = (d as unknown as { updatedAt?: Date }).updatedAt ?? new Date();
      const cur = map[key] ?? {
        todoId: key,
        pendingAgentToUser: 0,
        expiredAgentToUser: 0,
        pendingUserToAgent: 0,
        total: 0,
        lastUpdatedAt: updatedAt,
      };
      if (d.direction === 'user_to_agent') {
        cur.pendingUserToAgent++;
      } else if (d.status === 'pending') {
        cur.pendingAgentToUser++;
      } else {
        cur.expiredAgentToUser++;
      }
      cur.total++;
      if (updatedAt && (!cur.lastUpdatedAt || updatedAt > cur.lastUpdatedAt)) {
        cur.lastUpdatedAt = updatedAt;
      }
      map[key] = cur;
    }
    return map;
  }

  /**
   * Returns the count and list of open (pending/expired) questions for a
   * single todo. Used by TodosService to block the review → done transition.
   *
   * Short-circuits via `exists()` on the happy path (no open questions) to
   * avoid the full find+countDocuments round-trip.
   */
  async countOpenForTodo(todoId: string): Promise<{
    count: number;
    items: Array<{ id: string; question: string; status: QuestionStatus }>;
  }> {
    if (!Types.ObjectId.isValid(todoId)) {
      return { count: 0, items: [] };
    }
    const filter = {
      todoId: new Types.ObjectId(todoId),
      status: { $in: ['pending', 'expired'] as QuestionStatus[] },
    };
    const hasAny = await this.questionModel.exists(filter);
    if (!hasAny) return { count: 0, items: [] };

    const docs = await this.questionModel
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(100)
      .lean()
      .exec();
    return {
      count: docs.length,
      items: docs.map((d) => ({
        id: d._id.toString(),
        question: d.question,
        status: d.status,
      })),
    };
  }

  /**
   * Full question history for one todo (open + answered). Used by the todo
   * detail page to render question log + answer form.
   */
  async findByTodo(todoId: string, includeAnswered = true): Promise<QuestionDocument[]> {
    if (!Types.ObjectId.isValid(todoId)) return [];
    const filter: FilterQuery<QuestionDocument> = { todoId: new Types.ObjectId(todoId) };
    if (!includeAnswered) {
      filter.status = { $in: ['pending', 'expired'] };
    }
    return this.questionModel.find(filter).sort({ createdAt: -1 }).exec();
  }

  async waitForAnswer(
    id: string,
    timeoutMs: number,
  ): Promise<{ answered: boolean; answer?: string; answeredBy?: string; questionId: string }> {
    const pollInterval = 2000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const entry = await this.questionModel.findById(id).exec();
      if (!entry) {
        return { answered: false, questionId: id };
      }
      if (entry.status === 'answered' && entry.answer != null) {
        return {
          answered: true,
          answer: entry.answer,
          answeredBy: entry.answeredByUserId?.toString(),
          questionId: id,
        };
      }
      if (entry.status === 'expired' || (entry.expiresAt && entry.expiresAt < new Date())) {
        return { answered: false, questionId: id };
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    // Soft-flag as expired but DO NOT delete (M-30: user must still be able
    // to answer post-hoc from the todo detail view).
    await this.questionModel
      .findByIdAndUpdate(id, { status: 'expired' as QuestionStatus })
      .exec();
    return { answered: false, questionId: id };
  }

  /**
   * Convert an answered Question into a Knowledge entry (T-400).
   *
   * Idempotency: if the question already has a knowledgeId set, a 400 is
   * thrown immediately — the caller should use knowledge_get / knowledge_update
   * to work with the existing entry instead of duplicating it.
   *
   * Scope resolution: if the Question has a projectId, scope defaults to
   * 'project'; otherwise it falls back to 'global'. The caller may override
   * this via dto.scope.
   */
  async convertToKnowledge(
    questionId: string,
    dto: ConvertToKnowledgeDto,
  ): Promise<KnowledgeDocument> {
    const question = await this.questionModel.findById(questionId).exec();
    if (!question) throw new NotFoundException(`Question ${questionId} not found`);

    if (question.status !== 'answered') {
      throw new BadRequestException(
        `Question must be answered before converting to knowledge (current status: ${question.status})`,
      );
    }

    if (question.knowledgeId) {
      throw new BadRequestException({
        message: `Question ${questionId} has already been converted to knowledge`,
        code: 'QUESTION_ALREADY_CONVERTED',
        knowledgeId: question.knowledgeId.toString(),
      });
    }

    const defaultContent =
      `**Frage:** ${question.question}\n\n**Antwort:** ${question.answer ?? ''}`;

    const projectIdStr = question.projectId?.toString();
    const resolvedScope: 'global' | 'project' =
      dto.scope ?? (projectIdStr ? 'project' : 'global');

    const knowledge = await this.knowledgeService.create({
      topic: dto.topic,
      content: dto.content ?? defaultContent,
      tags: dto.tags,
      category: dto.category,
      scope: resolvedScope,
      projectId: projectIdStr,
      sourceQuestionId: questionId,
    });

    // Bidirectional link: stamp the question with the new knowledge entry's ID
    question.knowledgeId = knowledge._id as Types.ObjectId;
    await question.save();

    return knowledge;
  }

  /**
   * Walk all due agent_to_user questions one escalation step forward. Called
   * by QuestionsScheduler every minute. Returns a summary of what happened
   * so the scheduler can log it.
   *
   * Steps:
   *   1. Find all pending agent_to_user questions with expiresAt <= now.
   *   2. If there is a next escalation step → re-resolve targets, reset the
   *      deadline, append to escalationHistory, send notifications, and
   *      emit a `question.escalated` event.
   *   3. Otherwise → mark the question as expired (same as the legacy
   *      waitForAnswer path, but unblocks role/broadcast questions that did
   *      not go through a wait loop).
   */
  async escalateDueQuestions(): Promise<{
    checked: number;
    escalated: number;
    expired: number;
  }> {
    const now = new Date();
    const due = await this.questionModel
      .find({
        status: 'pending',
        direction: 'agent_to_user',
        expiresAt: { $lte: now },
      })
      .limit(50)
      .exec();

    let escalated = 0;
    let expired = 0;
    for (const entry of due) {
      const chain = entry.escalationChain ?? [];
      const nextStepIdx = (entry.escalationStep ?? 0) + 1;
      const stepConfig = chain[nextStepIdx - 1];
      if (!stepConfig) {
        entry.status = 'expired';
        await entry.save();
        expired += 1;
        continue;
      }

      const resolved = await this.authService.resolveQuestionTargets({
        targetUserId: stepConfig.kind === 'user' ? stepConfig.userId : undefined,
        targetRole: stepConfig.kind === 'role' ? stepConfig.role : undefined,
        broadcast: stepConfig.kind === 'broadcast',
        projectId: entry.projectId?.toString(),
      });
      const newTargetIds = resolved.userIds.map((id) => new Types.ObjectId(id));

      entry.resolvedTargetUserIds = newTargetIds;
      entry.targetUserId = stepConfig.kind === 'user' && stepConfig.userId
        ? new Types.ObjectId(stepConfig.userId)
        : undefined;
      entry.targetRole = stepConfig.kind === 'role' ? stepConfig.role : undefined;
      entry.broadcast = stepConfig.kind === 'broadcast';
      entry.escalationStep = nextStepIdx;
      entry.expiresAt = new Date(Date.now() + stepConfig.afterMs);
      entry.timeoutMs = stepConfig.afterMs;
      entry.escalationHistory = [
        ...(entry.escalationHistory ?? []),
        {
          step: nextStepIdx,
          appliedAt: now,
          resolvedTargetUserIds: resolved.userIds,
        },
      ];
      await entry.save();
      escalated += 1;

      const title = 'Agent-Rückfrage (eskaliert)';
      const body = entry.question.length > 100 ? entry.question.slice(0, 97) + '...' : entry.question;
      const url = entry.todoId
        ? `/projects/${entry.projectId?.toString()}/todos/${entry.todoId}`
        : undefined;
      await this.notificationsService
        .create(title, body, url, 'ask_user')
        .catch(() => {
          /* push not available — ignore */
        });

      this.eventEmitter.emit('question.escalated', {
        questionId: entry._id.toString(),
        step: nextStepIdx,
        kind: stepConfig.kind,
        resolvedTargetUserIds: resolved.userIds,
        expiresAt: entry.expiresAt?.toISOString() ?? null,
      });
    }

    return { checked: due.length, escalated, expired };
  }

  /**
   * Wenn ein Knowledge-Eintrag gelöscht wird, klemmt sonst die Question im
   * "Wissen anzeigen"-Button mit einer toten Referenz fest. Listener clearet
   * den Verweis, damit eine erneute Konversion möglich ist und das UI nicht
   * ins Leere verlinkt.
   */
  @OnEvent(PROJECT_CHANGED)
  async handleProjectChange(event: ProjectChangeEvent): Promise<void> {
    if (event.entity !== 'knowledge' || event.action !== 'deleted') return;
    if (!event.entityId || !Types.ObjectId.isValid(event.entityId)) return;

    const knowledgeObjectId = new Types.ObjectId(event.entityId);
    const result = await this.questionModel
      .updateMany(
        { knowledgeId: knowledgeObjectId },
        { $unset: { knowledgeId: '' } },
      )
      .exec();

    if (result.modifiedCount > 0) {
      this.logger.log(
        `Cleared knowledgeId on ${result.modifiedCount} question(s) after knowledge ${event.entityId} was deleted`,
      );
    }
  }
}
