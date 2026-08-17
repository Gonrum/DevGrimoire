import { BadRequestException, forwardRef, Inject, Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, isValidObjectId } from 'mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  RecurringAction,
  RecurringRunStatus,
  RecurringTask,
  RecurringTaskDocument,
  RecurringFrequency,
} from './schemas/recurring-task.schema';
import { CreateRecurringTaskDto } from './dto/create-recurring-task.dto';
import { UpdateRecurringTaskDto } from './dto/update-recurring-task.dto';
import { TodosService } from '../todos/todos.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CustomersService } from '../customers/customers.service';
import { ChatService } from '../chat/chat.service';
import { WorkflowAgentService } from '../workflows/workflow-agent.service';
import { redactValue } from '../workflows/workflow-redaction';
import { PROJECT_CHANGED } from '../events/project-event';
import { projectIdFilter } from '../common/project-id-filter';
import { RequestContext } from '../common/request-context';

@Injectable()
export class RecurringTasksService {
  private readonly logger = new Logger(RecurringTasksService.name);

  constructor(
    @InjectModel(RecurringTask.name) private recurringTaskModel: Model<RecurringTaskDocument>,
    private readonly todosService: TodosService,
    private readonly notificationsService: NotificationsService,
    private readonly customersService: CustomersService,
    @Inject(forwardRef(() => ChatService)) private readonly chatService: ChatService,
    @Inject(forwardRef(() => WorkflowAgentService)) private readonly workflowAgent: WorkflowAgentService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  private emit(action: 'created' | 'updated' | 'deleted', task: RecurringTaskDocument): void {
    if (!task.projectId && !task.customerId) return;
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: task.projectId?.toString() || null,
      customerId: task.customerId?.toString() || null,
      entity: 'recurring-task',
      action,
      entityId: task._id.toString(),
      summary: `Wiederkehrende Aufgabe "${task.title}" ${action === 'created' ? 'erstellt' : action === 'updated' ? 'aktualisiert' : 'entfernt'}`,
    });
  }

  async create(dto: CreateRecurringTaskDto): Promise<RecurringTaskDocument> {
    if (dto.projectId && dto.customerId) {
      throw new BadRequestException('Recurring task can have either projectId or customerId, not both');
    }
    if (dto.customerId) {
      await this.customersService.findById(dto.customerId);
    }
    const action = dto.action ?? RecurringAction.TODO;
    if (action === RecurringAction.CHAT) {
      this.assertChatConfig(dto);
    }
    // Chat actions need an owning user — the chat session is per-user. Prefer
    // the explicit DTO field, fall back to the request context.
    const requestUserId = RequestContext.getUser()?.userId;
    const ownerUserId = dto.createdByUserId ?? requestUserId;
    const createdByUserId =
      ownerUserId && isValidObjectId(ownerUserId) ? new Types.ObjectId(ownerUserId) : undefined;
    if (action === RecurringAction.CHAT && !createdByUserId) {
      throw new BadRequestException('chat action requires an authenticated user (createdByUserId)');
    }
    if (action === RecurringAction.CHAT && !(dto.projectId || dto.customerId)) {
      throw new BadRequestException('chat action requires projectId or customerId — chat sessions cannot be system-scoped');
    }
    const nextRun = this.computeNextRun(
      dto.frequency,
      dto.hour ?? 9,
      dto.dayOfWeek,
      dto.dayOfMonth,
      dto.month,
    );
    const task = await this.recurringTaskModel.create({
      ...dto,
      action,
      createdByUserId,
      nextRun,
    });
    this.emit('created', task);
    return task;
  }

  private assertChatConfig(dto: { chat?: { prompt?: string } }): void {
    if (!dto.chat?.prompt || dto.chat.prompt.trim().length === 0) {
      throw new BadRequestException('chat action requires chat.prompt');
    }
  }

  async findAll(filters?: { projectId?: string; customerId?: string; systemOnly?: boolean; active?: boolean }): Promise<RecurringTaskDocument[]> {
    const query: Record<string, unknown> = {};
    if (filters?.projectId) query.projectId = projectIdFilter(filters.projectId);
    if (filters?.customerId) query.customerId = projectIdFilter(filters.customerId);
    if (filters?.systemOnly) {
      query.projectId = { $exists: false };
      query.customerId = { $exists: false };
    }
    if (filters?.active !== undefined) query.active = filters.active;
    return this.recurringTaskModel.find(query).sort({ createdAt: -1 }).exec();
  }

  async findByProject(projectId: string, active?: boolean): Promise<RecurringTaskDocument[]> {
    return this.findAll({ projectId, active });
  }

  async findByCustomer(customerId: string, active?: boolean): Promise<RecurringTaskDocument[]> {
    return this.findAll({ customerId, active });
  }

  async findById(id: string): Promise<RecurringTaskDocument> {
    const task = await this.recurringTaskModel.findById(id).exec();
    if (!task) throw new NotFoundException(`RecurringTask ${id} not found`);
    return task;
  }

  async update(id: string, dto: UpdateRecurringTaskDto): Promise<RecurringTaskDocument> {
    // If frequency or scheduling fields changed, recompute nextRun
    const existing = await this.findById(id);
    const frequency = dto.frequency ?? existing.frequency;
    const hour = dto.hour ?? existing.hour;
    const dayOfWeek = dto.dayOfWeek !== undefined ? dto.dayOfWeek : existing.dayOfWeek;
    const dayOfMonth = dto.dayOfMonth !== undefined ? dto.dayOfMonth : existing.dayOfMonth;
    const month = dto.month !== undefined ? dto.month : existing.month;

    const effectiveAction = dto.action ?? existing.action ?? RecurringAction.TODO;
    if (effectiveAction === RecurringAction.CHAT) {
      const chat = dto.chat ?? existing.chat;
      if (!chat?.prompt || chat.prompt.trim().length === 0) {
        throw new BadRequestException('chat action requires chat.prompt');
      }
      if (!existing.createdByUserId) {
        throw new BadRequestException('chat action requires an owning user — recreate the task instead');
      }
      if (!existing.projectId && !existing.customerId) {
        throw new BadRequestException('chat action requires projectId or customerId');
      }
    }

    const updateData: Record<string, unknown> = { ...dto };
    if (dto.frequency !== undefined || dto.hour !== undefined || dto.dayOfWeek !== undefined || dto.dayOfMonth !== undefined || dto.month !== undefined) {
      updateData.nextRun = this.computeNextRun(frequency, hour, dayOfWeek, dayOfMonth, month);
    }

    const task = await this.recurringTaskModel.findByIdAndUpdate(id, updateData, { new: true }).exec();
    if (!task) throw new NotFoundException(`RecurringTask ${id} not found`);
    this.emit('updated', task);
    return task;
  }

  async remove(id: string): Promise<void> {
    const result = await this.recurringTaskModel.findByIdAndDelete(id).exec();
    if (!result) throw new NotFoundException(`RecurringTask ${id} not found`);
    this.emit('deleted', result);
  }

  async removeByProject(projectId: string): Promise<void> {
    await this.recurringTaskModel.deleteMany({ projectId }).exec();
  }

  async removeByCustomer(customerId: string): Promise<void> {
    await this.recurringTaskModel.deleteMany({ customerId }).exec();
  }

  async trigger(id: string): Promise<RecurringTaskDocument> {
    const task = await this.findById(id);
    await this.executeTask(task);
    return this.recurringTaskModel.findById(id).exec() as Promise<RecurringTaskDocument>;
  }

  async processDueTasks(): Promise<number> {
    const now = new Date();
    const dueTasks = await this.recurringTaskModel.find({
      active: true,
      nextRun: { $lte: now },
    }).exec();

    let count = 0;
    for (const task of dueTasks) {
      // Compute next nextRun up-front so a thrown executeTask doesn't leave the
      // task stuck due and re-fire on every scheduler tick.
      const nextRun = this.computeNextRun(task.frequency, task.hour, task.dayOfWeek, task.dayOfMonth, task.month);
      try {
        let runs = 0;
        const maxRuns = task.maxCatchUp || 3;
        let currentNext = new Date(task.nextRun);
        while (currentNext <= now && runs < maxRuns) {
          runs++;
          currentNext = this.computeNextRunFromDate(currentNext, task.frequency, task.hour, task.dayOfWeek, task.dayOfMonth, task.month);
        }
        for (let i = 0; i < runs; i++) {
          // Re-load the task between iterations so `executeChatAction` sees
          // the latest `chatSessionIds`/`lastRunStatus` written by the
          // previous catch-up iteration. Without this, `sessionStrategy:
          // 'reuse'` would create a fresh session each time instead of
          // appending to the one just created.
          const fresh = i === 0 ? task : await this.recurringTaskModel.findById(task._id).exec();
          if (!fresh) break;
          await this.executeTask(fresh);
          count++;
        }
      } catch (err) {
        this.logger.error(`Failed to process recurring task ${task._id}: ${err}`);
      } finally {
        await this.recurringTaskModel
          .findByIdAndUpdate(task._id, { lastRun: now, nextRun })
          .exec();
      }
    }

    return count;
  }

  private async executeTask(task: RecurringTaskDocument): Promise<void> {
    try {
      if ((task.action ?? RecurringAction.TODO) === RecurringAction.CHAT) {
        await this.executeChatAction(task);
      } else {
        await this.executeTodoAction(task);
      }
      await this.recurringTaskModel
        .findByIdAndUpdate(task._id, {
          lastRunStatus: RecurringRunStatus.SUCCEEDED,
          $unset: { lastRunError: '' },
        })
        .exec();
    } catch (err) {
      const msg = this.sanitizeError((err as Error).message ?? 'recurring_task_failed');
      this.logger.error(`Recurring task ${task._id} failed: ${msg}`);
      await this.recurringTaskModel
        .findByIdAndUpdate(task._id, {
          lastRunStatus: RecurringRunStatus.FAILED,
          lastRunError: msg,
        })
        .exec();
      throw err;
    }
  }

  private async executeTodoAction(task: RecurringTaskDocument): Promise<void> {
    if (task.projectId) {
      const todo = await this.todosService.create({
        projectId: task.projectId.toString(),
        title: task.title,
        description: task.description,
        priority: task.priority as any,
        tags: [...task.tags],
        milestoneId: task.milestoneId?.toString(),
        repoLabel: task.repoLabel,
      });
      await this.recurringTaskModel.findByIdAndUpdate(task._id, {
        $push: { createdTodoIds: todo._id },
      }).exec();
    } else if (task.customerId) {
      const todo = await this.todosService.create({
        customerId: task.customerId.toString(),
        title: task.title,
        description: task.description,
        priority: task.priority as any,
        tags: [...task.tags],
      });
      await this.recurringTaskModel.findByIdAndUpdate(task._id, {
        $push: { createdTodoIds: todo._id },
      }).exec();
    } else {
      const url = `/recurring-tasks/${task._id.toString()}`;
      await this.notificationsService.create(
        task.title,
        task.description || task.title,
        url,
        'recurring',
      );
    }
  }

  private async executeChatAction(task: RecurringTaskDocument): Promise<void> {
    const chat = task.chat;
    if (!chat?.prompt) {
      throw new Error('chat action missing prompt');
    }
    if (!task.createdByUserId) {
      throw new Error('chat action missing owning user');
    }
    const projectId = task.projectId?.toString();
    const customerId = task.customerId?.toString();
    if (!projectId && !customerId) {
      throw new Error('chat action requires project or customer scope');
    }
    const userId = task.createdByUserId.toString();

    // Resolve (or create) the chat session that will hold this run's exchange.
    let sessionId: string | undefined;
    if (chat.sessionStrategy === 'reuse' && task.chatSessionIds.length > 0) {
      sessionId = task.chatSessionIds[task.chatSessionIds.length - 1].toString();
    }
    if (!sessionId) {
      const created = await this.chatService.createSession(
        { projectId, customerId },
        userId,
        `${task.title} — ${new Date().toISOString().slice(0, 10)}`,
      );
      sessionId = created._id.toString();
      await this.recurringTaskModel
        .findByIdAndUpdate(task._id, { $push: { chatSessionIds: created._id } })
        .exec();
    }

    // Persist the user-facing prompt so the chat UI shows what triggered the run.
    await this.chatService.appendMessage(
      sessionId,
      { role: 'user', content: chat.prompt },
      userId,
    );

    // Run the workflow agent (handles tools allowlist, anthropic/openai split,
    // timeout, tool-iteration cap). The recurring-task scheduler runs outside
    // any request context, so we pass scope explicitly.
    const result = await this.workflowAgent.run({
      prompt: chat.prompt,
      systemPrompt: chat.systemPrompt,
      runContext: {
        nodes: {},
        input: { recurringTaskId: task._id.toString(), trigger: 'recurring' },
      },
      allowedTools: chat.allowedTools ?? [],
      callerScope: { projectId, customerId },
      timeoutMs: chat.timeoutMs ?? 60_000,
      maxToolIterations: chat.maxToolIterations,
    });

    // Redact LLM output + tool args/results before persistence. The agent may
    // echo back values returned by tools (e.g. an API key surfaced via a read
    // tool) — masking here is the last line of defense before the data lands
    // in MongoDB and the RAG index.
    const redactedResponse = redactValue(result.response);
    const toolCalls = (result.toolCalls ?? []).map((tc) => {
      const argsStr = typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args ?? null);
      const resultStr = typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result ?? null);
      return {
        id: '',
        name: tc.tool,
        arguments: redactValue(argsStr),
        result: redactValue(resultStr),
        success: true,
      };
    });

    await this.chatService.appendMessage(
      sessionId,
      {
        role: 'assistant',
        content: redactedResponse,
        toolCalls,
      },
      userId,
    );
  }

  /** Strip Bearer/api-key style content out of error messages before persisting. */
  private sanitizeError(msg: string): string {
    return msg
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [MASKED]')
      .replace(/(api[-_]?key|secret|token|password|passwd)\s*[:=]\s*[^\s,;]+/gi, '$1=[MASKED]')
      .slice(0, 500);
  }

  computeNextRun(
    frequency: RecurringFrequency | string,
    hour: number,
    dayOfWeek?: number,
    dayOfMonth?: number,
    month?: number,
  ): Date {
    const now = new Date();
    return this.computeNextRunFromDate(now, frequency, hour, dayOfWeek, dayOfMonth, month);
  }

  private computeNextRunFromDate(
    from: Date,
    frequency: RecurringFrequency | string,
    hour: number,
    dayOfWeek?: number,
    dayOfMonth?: number,
    month?: number,
  ): Date {
    const next = new Date(from);
    next.setMinutes(0, 0, 0);
    next.setHours(hour);

    switch (frequency) {
      case RecurringFrequency.DAILY:
        // Next day at specified hour
        next.setDate(next.getDate() + 1);
        break;

      case RecurringFrequency.WEEKLY: {
        const targetDay = dayOfWeek ?? 1; // default Monday
        next.setDate(next.getDate() + 1); // at least tomorrow
        while (next.getDay() !== targetDay) {
          next.setDate(next.getDate() + 1);
        }
        break;
      }

      case RecurringFrequency.BIWEEKLY: {
        const targetDay2 = dayOfWeek ?? 1;
        next.setDate(next.getDate() + 1);
        while (next.getDay() !== targetDay2) {
          next.setDate(next.getDate() + 1);
        }
        // Skip one more week
        next.setDate(next.getDate() + 7);
        break;
      }

      case RecurringFrequency.MONTHLY: {
        const targetDom = dayOfMonth ?? 1;
        next.setMonth(next.getMonth() + 1);
        next.setDate(Math.min(targetDom, new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate()));
        break;
      }

      case RecurringFrequency.QUARTERLY: {
        const targetDomQ = dayOfMonth ?? 1;
        next.setMonth(next.getMonth() + 3);
        next.setDate(Math.min(targetDomQ, new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate()));
        break;
      }

      case RecurringFrequency.YEARLY: {
        const targetMonth = (month ?? 1) - 1; // month is 1-indexed
        const targetDomY = dayOfMonth ?? 1;
        next.setFullYear(next.getFullYear() + 1);
        next.setMonth(targetMonth);
        next.setDate(Math.min(targetDomY, new Date(next.getFullYear(), targetMonth + 1, 0).getDate()));
        break;
      }
    }

    // If computed time is still in the past, add one more cycle
    if (next <= from) {
      return this.computeNextRunFromDate(next, frequency, hour, dayOfWeek, dayOfMonth, month);
    }

    return next;
  }
}
