import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  ResearchSession,
  ResearchSessionDocument,
  ResearchSessionStatus,
} from './schemas/research-session.schema';
import {
  ResearchStep,
  ResearchStepDocument,
  ResearchStepStatus,
} from './schemas/research-step.schema';
import { CreateResearchSessionDto } from './dto/create-research-session.dto';
import { UpdateResearchSessionDto } from './dto/update-research-session.dto';
import { CreateResearchStepDto } from './dto/create-research-step.dto';
import { UpdateResearchStepDto } from './dto/update-research-step.dto';
import { CountersService } from '../counters/counters.service';
import { PROJECT_CHANGED, ProjectChangeEvent } from '../events/project-event';
import { OnEvent } from '@nestjs/event-emitter';
import { RequestContext } from '../common/request-context';
import { ChatContextService } from '../chat/chat-context.service';
import { ChatLlmService, LlmMessage } from '../chat/chat-llm.service';
import { ChatContextRef } from '../chat/schemas/chat-session.schema';
import { ResearchService } from '../research/research.service';
import { Logger } from '@nestjs/common';

const STATUS_ORDER: Record<ResearchSessionStatus, number> = {
  [ResearchSessionStatus.OPEN]: 0,
  [ResearchSessionStatus.IN_PROGRESS]: 1,
  [ResearchSessionStatus.DONE]: 2,
};

function validateTransition(
  current: ResearchSessionStatus | ResearchStepStatus,
  next: ResearchSessionStatus | ResearchStepStatus,
): void {
  if (current === next) return;
  const diff = STATUS_ORDER[next as ResearchSessionStatus] - STATUS_ORDER[current as ResearchSessionStatus];
  if (Math.abs(diff) !== 1) {
    throw new BadRequestException(
      `Invalid status transition ${current} → ${next}. Allowed: open → in_progress → done (one step at a time).`,
    );
  }
}

@Injectable()
export class ResearchSessionsService {
  private readonly logger = new Logger(ResearchSessionsService.name);

  constructor(
    @InjectModel(ResearchSession.name)
    private readonly sessionModel: Model<ResearchSessionDocument>,
    @InjectModel(ResearchStep.name)
    private readonly stepModel: Model<ResearchStepDocument>,
    private readonly counters: CountersService,
    private readonly eventEmitter: EventEmitter2,
    private readonly chatContext: ChatContextService,
    private readonly chatLlm: ChatLlmService,
    private readonly research: ResearchService,
  ) {}

  private actorVisibleProjectIds(): Set<string> | null {
    const actor = RequestContext.getUser();
    if (!actor || !actor.projectScopeMode || actor.projectScopeMode === 'all') return null;
    if (actor.projectScopeMode === 'none') return new Set();
    return new Set((actor.allowedProjectIds || []).map(String));
  }

  private filterVisibleSession(session: ResearchSessionDocument): ResearchSessionDocument {
    const allowed = this.actorVisibleProjectIds();
    if (!allowed) return session;
    const sessionPids = session.projectIds.map((p) => p.toString());
    const hasOverlap = sessionPids.some((p) => allowed.has(p));
    if (!hasOverlap) {
      throw new ForbiddenException(`ResearchSession ${session._id} is out of scope`);
    }
    return session;
  }

  async createSession(dto: CreateResearchSessionDto): Promise<ResearchSessionDocument> {
    const seq = await this.counters.getNextSequence({}, 'research');
    const displayNumber = `R-${seq}`;
    const projectIds = (dto.projectIds || []).map((id) => new Types.ObjectId(id));
    const session = await this.sessionModel.create({
      title: dto.title,
      projectIds,
      number: seq,
      displayNumber,
    });
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: projectIds[0]?.toString() ?? '',
      entity: 'research_session',
      action: 'created',
      entityId: session._id.toString(),
      summary: `Recherche "${session.title}" gestartet`,
    });
    return session;
  }

  async listSessions(args: { status?: ResearchSessionStatus; q?: string }): Promise<ResearchSessionDocument[]> {
    const filter: Record<string, unknown> = {};
    if (args.status) filter.status = args.status;
    if (args.q) filter.title = { $regex: args.q, $options: 'i' };
    const allowed = this.actorVisibleProjectIds();
    if (allowed) {
      if (allowed.size === 0) return [];
      filter.projectIds = { $in: [...allowed].map((id) => new Types.ObjectId(id)) };
    }
    return this.sessionModel.find(filter).sort({ updatedAt: -1 }).exec();
  }

  async getSession(id: string): Promise<ResearchSessionDocument> {
    const session = await this.sessionModel.findById(id).exec();
    if (!session) throw new NotFoundException(`ResearchSession ${id} not found`);
    return this.filterVisibleSession(session);
  }

  async getSessionWithSteps(id: string): Promise<{
    session: ResearchSessionDocument;
    steps: ResearchStepDocument[];
  }> {
    const session = await this.getSession(id);
    const steps = await this.stepModel.find({ sessionId: session._id }).sort({ order: 1 }).exec();
    return { session, steps };
  }

  async updateSession(id: string, dto: UpdateResearchSessionDto): Promise<ResearchSessionDocument> {
    const session = await this.getSession(id);

    if (dto.status && dto.status !== session.status) {
      validateTransition(session.status, dto.status);
      if (dto.status === ResearchSessionStatus.DONE) {
        const openSteps = await this.stepModel.countDocuments({
          sessionId: session._id,
          status: { $ne: ResearchStepStatus.DONE },
        });
        if (openSteps > 0) {
          throw new BadRequestException(
            `Cannot mark session done: ${openSteps} step(s) are not yet done.`,
          );
        }
      }
      session.status = dto.status;
    }
    if (dto.title !== undefined) session.title = dto.title;
    if (dto.projectIds) session.projectIds = dto.projectIds.map((p) => new Types.ObjectId(p));
    await session.save();

    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: session.projectIds[0]?.toString() ?? '',
      entity: 'research_session',
      action: 'updated',
      entityId: session._id.toString(),
      summary: `Recherche "${session.title}" aktualisiert`,
    });
    return session;
  }

  async deleteSession(id: string): Promise<void> {
    const session = await this.getSession(id);
    await this.stepModel.deleteMany({ sessionId: session._id });
    await this.sessionModel.deleteOne({ _id: session._id });
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: session.projectIds[0]?.toString() ?? '',
      entity: 'research_session',
      action: 'deleted',
      entityId: session._id.toString(),
    });
  }

  // --- Steps ---

  async createStep(sessionId: string, dto: CreateResearchStepDto): Promise<ResearchStepDocument> {
    await this.getSession(sessionId);
    const order =
      dto.order !== undefined
        ? dto.order
        : ((await this.stepModel
            .find({ sessionId: new Types.ObjectId(sessionId) })
            .sort({ order: -1 })
            .limit(1)
            .exec())[0]?.order ?? -1) + 1;
    const step = await this.stepModel.create({
      sessionId: new Types.ObjectId(sessionId),
      title: dto.title,
      order,
    });
    return step;
  }

  async getStep(id: string): Promise<ResearchStepDocument> {
    const step = await this.stepModel.findById(id).exec();
    if (!step) throw new NotFoundException(`ResearchStep ${id} not found`);
    // Scope check via parent session.
    await this.getSession(step.sessionId.toString());
    return step;
  }

  async updateStep(id: string, dto: UpdateResearchStepDto): Promise<ResearchStepDocument> {
    const step = await this.getStep(id);

    const transitionedToDone =
      dto.status === ResearchStepStatus.DONE && step.status !== ResearchStepStatus.DONE;

    if (dto.status && dto.status !== step.status) {
      validateTransition(step.status, dto.status);
      step.status = dto.status;
    }
    if (dto.title !== undefined) step.title = dto.title;
    if (dto.order !== undefined) step.order = dto.order;
    await step.save();

    // Auto-convert to research_* entry on transition → done.
    if (transitionedToDone && step.messages.length > 0 && !step.researchEntryId) {
      try {
        await this.autoSaveResearchEntry(step);
      } catch (err) {
        // Roll back status so user can retry.
        this.logger.warn(`Auto-save failed for step ${id}: ${(err as Error).message}`);
        step.status = ResearchStepStatus.IN_PROGRESS;
        await step.save();
        throw new BadRequestException(
          `Auto-Summary fehlgeschlagen: ${(err as Error).message}. Step bleibt auf in_progress.`,
        );
      }
    }
    return step;
  }

  /** Manual save without status transition. */
  async saveStepAsResearch(stepId: string): Promise<{ researchEntryId: string }> {
    const step = await this.getStep(stepId);
    if (step.messages.length === 0) {
      throw new BadRequestException('Step has no messages to summarize');
    }
    await this.autoSaveResearchEntry(step);
    if (!step.researchEntryId) {
      throw new Error('Save completed but researchEntryId missing');
    }
    return { researchEntryId: step.researchEntryId.toString() };
  }

  private async autoSaveResearchEntry(step: ResearchStepDocument): Promise<void> {
    const session = await this.getSession(step.sessionId.toString());
    if (session.projectIds.length === 0) {
      throw new Error('Session has no projectIds — cannot save research entry');
    }

    // Collect all RAG context refs that ever flowed into this step (from
    // assistant messages persisted with contextUsed).
    const sourceIds = new Set<string>();
    for (const msg of step.messages) {
      if (msg.contextUsed) {
        for (const ref of msg.contextUsed) {
          if (ref.entityId) sourceIds.add(`${ref.entity}:${ref.entityId}`);
        }
      }
    }

    const conversationText = step.messages
      .map((m) => `**${m.role.toUpperCase()}**\n${m.content}`)
      .join('\n\n');

    const prompt: LlmMessage[] = [
      {
        role: 'system',
        content: `Du bist ein Recherche-Assistent. Fasse die folgende Q&A-Konversation als strukturierten Research-Eintrag zusammen.

Antwort-Format (ausschließlich Markdown, keine zusätzlichen Erklärungen):

# {Step-Titel als Überschrift}

## Antwort
{Klare, zusammenfassende Antwort auf die ursprüngliche Frage, 2-6 Sätze}

## Wichtigste Quellen
- {Quelle 1 mit kurzer Begründung}
- {Quelle 2 mit kurzer Begründung}
- ...

## Tags
{3-5 relevante Tags als kommagetrennte Liste}`,
      },
      {
        role: 'user',
        content: `# Step-Titel\n${step.title}\n\n# Konversation\n${conversationText}\n\n# Verwendete Quellen-IDs\n${[...sourceIds].join(', ') || '(keine)'}`,
      },
    ];

    let summary = '';
    for await (const token of this.chatLlm.streamChat(prompt, {})) {
      summary += token;
    }

    // Parse tags from the "## Tags" section heuristically.
    const tagsMatch = summary.match(/##\s*Tags\s*\n([^\n]+)/i);
    const tags = tagsMatch
      ? tagsMatch[1]
          .split(',')
          .map((t) => t.trim().replace(/^#/, ''))
          .filter(Boolean)
          .slice(0, 8)
      : [];

    const entry = await this.research.create({
      projectId: session.projectIds[0].toString(),
      title: step.title,
      content: summary,
      sources: [...sourceIds],
      tags,
    });

    step.researchEntryId = entry._id as Types.ObjectId;
    await step.save();
  }

  async deleteStep(id: string): Promise<void> {
    const step = await this.getStep(id);
    await this.stepModel.deleteOne({ _id: step._id });
  }

  /**
   * Append a user message to the step, build research context (multi-project
   * RAG), stream the LLM response token-by-token via callbacks, persist the
   * assistant reply when done. The callback shape matches the SSE event names
   * used in the chat controller (context, token, done, error).
   */
  async streamStepAnswer(
    stepId: string,
    content: string,
    callbacks: {
      onContext: (refs: ChatContextRef[]) => void;
      onToken: (delta: string) => void;
      onDone: (full: string) => void;
      onError: (message: string) => void;
      signal?: AbortSignal;
    },
  ): Promise<void> {
    const step = await this.getStep(stepId);
    if (step.status === ResearchStepStatus.DONE) {
      throw new BadRequestException('Cannot send messages to a finished step');
    }
    const session = await this.getSession(step.sessionId.toString());
    const projectIds = session.projectIds.map((p) => p.toString());
    if (projectIds.length === 0) {
      throw new BadRequestException('Research session has no projects in scope');
    }

    // Append the user message immediately so the next history-read sees it.
    step.messages.push({
      role: 'user',
      content,
      timestamp: new Date(),
    } as never);
    await step.save();

    // Auto-advance status open → in_progress on first message.
    if (session.status === ResearchSessionStatus.OPEN) {
      session.status = ResearchSessionStatus.IN_PROGRESS;
      await session.save();
    }
    if (step.status === ResearchStepStatus.OPEN) {
      step.status = ResearchStepStatus.IN_PROGRESS;
      await step.save();
    }

    let built;
    try {
      built = await this.chatContext.buildResearch(projectIds, content, step.messages.slice(0, -1));
    } catch (err) {
      callbacks.onError((err as Error).message || 'context build failed');
      return;
    }

    callbacks.onContext(built.contextRefs);

    let full = '';
    try {
      for await (const token of this.chatLlm.streamChat(built.messages, {
        signal: callbacks.signal,
      })) {
        if (callbacks.signal?.aborted) break;
        full += token;
        callbacks.onToken(token);
      }
    } catch (err) {
      callbacks.onError((err as Error).message || 'LLM stream failed');
      return;
    }

    if (callbacks.signal?.aborted) return;

    // Persist assistant message with contextRefs for the kontext-pane.
    step.messages.push({
      role: 'assistant',
      content: full,
      timestamp: new Date(),
      contextUsed: built.contextRefs,
    } as never);
    await step.save();

    callbacks.onDone(full);
  }

  /**
   * Synchronous variant of streamStepAnswer for MCP/agent use. Collects the
   * stream internally and returns the final answer + sources.
   */
  async askStep(stepId: string, question: string): Promise<{
    answer: string;
    sources: ChatContextRef[];
  }> {
    let answer = '';
    let sources: ChatContextRef[] = [];
    let error: string | null = null;
    await this.streamStepAnswer(stepId, question, {
      onContext: (refs) => {
        sources = refs;
      },
      onToken: (delta) => {
        answer += delta;
      },
      onDone: () => {
        /* nothing */
      },
      onError: (msg) => {
        error = msg;
      },
    });
    if (error) throw new Error(error);
    return { answer, sources };
  }

  /**
   * On project delete: drop the projectId from all sessions referencing it.
   * Sessions with no remaining projects are kept but become "context-less".
   */
  @OnEvent(PROJECT_CHANGED)
  async onProjectChange(event: ProjectChangeEvent): Promise<void> {
    if (event.entity !== 'project' || event.action !== 'deleted' || !event.projectId) return;
    if (!Types.ObjectId.isValid(event.projectId)) return;
    const pid = new Types.ObjectId(event.projectId);
    await this.sessionModel
      .updateMany({ projectIds: pid }, { $pull: { projectIds: pid } })
      .exec();
  }
}
