import {
  BadRequestException,
  ForbiddenException,
  forwardRef,
  Inject,
  Injectable,
  NotFoundException,
  Logger,
} from '@nestjs/common';
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
import { TodoPriority } from '../todos/schemas/todo.schema';
import { NotificationsService } from '../notifications/notifications.service';
import { CustomersService } from '../customers/customers.service';
import { ChatService } from '../chat/chat.service';
import { WorkflowAgentService } from '../workflows/workflow-agent.service';
import { redactValue } from '../workflows/workflow-redaction';
import { PROJECT_CHANGED } from '../events/project-event';
import { projectIdFilter } from '../common/project-id-filter';
import { RequestContext, RequestUser } from '../common/request-context';
import { actorFromUser } from '../common/actor-scope';
import { User, UserDocument } from '../auth/schemas/user.schema';
import {
  assertAdmin,
  assertCustomerInScope,
  assertOwnerInScope,
  assertOwnerParamsInScope,
  assertProjectInScope,
  scopeFilter,
} from '../common/scope-guard';
import { errorMessage } from '../common/narrow';
import { assertSafeCascadeId } from '../common/cascade-guard';

/**
 * Wie oft `computeNextRunFromDate` höchstens einen Zyklus nachlegt, um `from` zu
 * überholen. Bei jeder gültigen Frequenz reicht der erste Schritt; die Grenze
 * ersetzt die frühere Endrekursion, die bei einem Zyklus ohne Fortschritt bis
 * zum Stack-Overflow lief.
 */
const MAX_CYCLE_STEPS = 3;

/** Letzter Tag des Monats, in dem `d` liegt. */
function daysInMonth(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

/**
 * String → Enum-Mitglied, oder `undefined`.
 *
 * Der `find`-Vergleich muss in einer generischen Funktion stehen: `T extends
 * string` vergleicht String mit String, während ein direktes
 * `TodoPriority === string` genau das ist, was `no-unsafe-enum-comparison`
 * anmerkt. Derselbe Kniff wie in `common/tool-args.ts` (`optionalEnum`) — hier
 * aber ohne Wurf, weil ein unbekannter Wert die Aufgabe nicht scheitern lassen
 * soll (siehe `todoPriority`).
 */
function asEnumValue<T extends string>(allowed: readonly T[], value: string): T | undefined {
  return allowed.find((candidate) => candidate === value);
}

@Injectable()
export class RecurringTasksService {
  private readonly logger = new Logger(RecurringTasksService.name);

  constructor(
    @InjectModel(RecurringTask.name) private recurringTaskModel: Model<RecurringTaskDocument>,
    @InjectModel(User.name) private userModel: Model<UserDocument>,
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
    if (dto.projectId && !isValidObjectId(dto.projectId)) {
      throw new BadRequestException(`Invalid projectId: ${dto.projectId}`);
    }
    if (dto.customerId && !isValidObjectId(dto.customerId)) {
      throw new BadRequestException(`Invalid customerId: ${dto.customerId}`);
    }
    // The task later creates todos / chat runs in its owner — a narrowed actor
    // must not schedule work into foreign projects or customers.
    assertOwnerParamsInScope({ projectId: dto.projectId, customerId: dto.customerId });
    if (!dto.projectId && !dto.customerId) {
      // System tasks broadcast a notification to every user.
      assertAdmin('System recurring task');
    }
    if (dto.customerId) {
      await this.customersService.findById(dto.customerId);
    }
    const action = dto.action ?? RecurringAction.TODO;
    if (action === RecurringAction.CHAT) {
      this.assertChatConfig(dto);
    }
    // The owner is always the calling actor (never a body field): the
    // scheduler runs the task with this user's scope and, for chat actions,
    // in this user's chat sessions.
    const ownerUserId = RequestContext.getUser()?.userId;
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
    if (filters?.projectId && !isValidObjectId(filters.projectId)) {
      throw new BadRequestException(`Invalid projectId: ${filters.projectId}`);
    }
    if (filters?.customerId && !isValidObjectId(filters.customerId)) {
      throw new BadRequestException(`Invalid customerId: ${filters.customerId}`);
    }
    assertProjectInScope(filters?.projectId);
    assertCustomerInScope(filters?.customerId);
    // Never list every task of the instance for a narrowed actor; tasks
    // without an owner axis (system tasks) stay visible.
    Object.assign(query, scopeFilter());
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

  /**
   * Load + 404 + scope check. Every by-id path (get, update, delete, trigger)
   * goes through here before anything is mutated or executed.
   */
  private async findScoped(id: string): Promise<RecurringTaskDocument> {
    if (!isValidObjectId(id)) throw new NotFoundException(`RecurringTask ${id} not found`);
    const task = await this.recurringTaskModel.findById(id).exec();
    if (!task) throw new NotFoundException(`RecurringTask ${id} not found`);
    assertOwnerInScope({ projectId: task.projectId, customerId: task.customerId }, `RecurringTask ${id}`);
    return task;
  }

  /**
   * Mutations (update, delete, trigger) on top of the scope check:
   * - system tasks (no project/customer) notify every user → admin only;
   * - chat tasks run as their owner, so only the owner (or an admin) may
   *   change or fire them — otherwise a co-worker in the same project could
   *   rewrite the prompt/tool allowlist and have it executed with the owner's
   *   (possibly broader) scope.
   */
  private assertMayMutate(task: RecurringTaskDocument, nextAction?: RecurringAction): void {
    if (!task.projectId && !task.customerId) assertAdmin('System recurring task');
    const action = nextAction ?? task.action ?? RecurringAction.TODO;
    const actor = RequestContext.getUser();
    if (!actor || actor.role === 'admin') return;
    if (action === RecurringAction.CHAT && task.createdByUserId?.toString() !== actor.userId) {
      throw new ForbiddenException(`RecurringTask ${task._id.toString()} is a chat task of another user`);
    }
  }

  async findById(id: string): Promise<RecurringTaskDocument> {
    return this.findScoped(id);
  }

  async update(id: string, dto: UpdateRecurringTaskDto): Promise<RecurringTaskDocument> {
    // If frequency or scheduling fields changed, recompute nextRun
    const existing = await this.findScoped(id);
    this.assertMayMutate(existing, dto.action);
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
    // Check BEFORE deleting — findByIdAndDelete would already have removed it.
    const existing = await this.findScoped(id);
    // Same rule as update/trigger: covers system tasks (admin) and another
    // user's chat task, which a project colleague must not delete either.
    this.assertMayMutate(existing);
    const result = await this.recurringTaskModel.findByIdAndDelete(id).exec();
    if (!result) throw new NotFoundException(`RecurringTask ${id} not found`);
    this.emit('deleted', result);
  }

  async removeByProject(projectId: string): Promise<void> {
    assertSafeCascadeId(projectId, 'projectId');
    await this.recurringTaskModel.deleteMany({ projectId }).exec();
  }

  async removeByCustomer(customerId: string): Promise<void> {
    assertSafeCascadeId(customerId, 'customerId');
    await this.recurringTaskModel.deleteMany({ customerId }).exec();
  }

  async trigger(id: string): Promise<RecurringTaskDocument> {
    const task = await this.findScoped(id);
    this.assertMayMutate(task);
    await this.executeTask(task);
    // Vorher `… .exec() as Promise<RecurringTaskDocument>`: die Behauptung hat
    // das `null` weggelogen, das `findById` sehr wohl liefern kann — etwa wenn
    // die Aufgabe während des Laufs gelöscht wurde. Der Aufrufer bekam dann
    // `null` in einem Feld, das `RecurringTaskDocument` verspricht.
    const refreshed = await this.recurringTaskModel.findById(id).exec();
    if (!refreshed) throw new NotFoundException(`RecurringTask ${id} not found`);
    return refreshed;
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
      let nextRun: Date;
      try {
        nextRun = this.computeNextRun(task.frequency, task.hour, task.dayOfWeek, task.dayOfMonth, task.month);
      } catch (err: unknown) {
        // Unbrauchbarer Zeitplan (Frequenz, die der switch nicht kennt; Stunde
        // außerhalb 0–23). Über create/update kommt das nicht herein, über
        // Import/Replikation schon. Früher endete das in einer Endrekursion bzw.
        // einem CastError und nahm alle übrigen fälligen Aufgaben dieser Runde
        // mit — jetzt bleibt es bei dieser einen.
        this.logger.error(
          `Recurring task ${task._id.toString()} has an unusable schedule: ${errorMessage(err)}`,
        );
        continue;
      }
      // Atomarer Claim VOR der Ausführung (H-17). Vorher wurde nextRun erst
      // im finally geschrieben: lief ein Task (z. B. ein LLM-Agent-Loop)
      // länger als der Minuten-Tick, fand der nächste Tick ihn weiter fällig
      // und führte ihn erneut aus — doppelte Todos, doppelte Chat-Nachrichten,
      // doppelte LLM-Kosten, mit maxCatchUp multipliziert. Der Filter auf den
      // gelesenen nextRun-Wert macht den Claim exklusiv: wer ihn verliert
      // (überlappender Tick, zweite Instanz), überspringt den Task.
      const claimed = await this.recurringTaskModel
        .findOneAndUpdate(
          { _id: task._id, active: true, nextRun: task.nextRun },
          { $set: { lastRun: now, nextRun } },
        )
        .exec();
      if (!claimed) continue;
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
      } catch (err: unknown) {
        this.logger.error(
          `Failed to process recurring task ${task._id.toString()}: ${errorMessage(err)}`,
        );
      }
    }

    return count;
  }

  /**
   * Actor under which a task runs: its owning user. The scheduler has no
   * request context, and without an actor every `if (actor)` scope check in
   * TodosService, chat tools etc. is skipped — a task would act with
   * unrestricted rights. Returns `undefined` only for legacy owner-less todo
   * tasks (they could only be created by internal callers). Throws when the
   * owner is required but missing or inactive, so the run is skipped and the
   * reason lands in `lastRunError`.
   */
  private async resolveOwnerActor(task: RecurringTaskDocument): Promise<RequestUser | undefined> {
    const isChat = (task.action ?? RecurringAction.TODO) === RecurringAction.CHAT;
    if (!task.createdByUserId) {
      if (isChat) throw new Error('chat action missing owning user');
      return undefined;
    }
    const owner = await this.userModel.findById(task.createdByUserId).exec();
    if (!owner || !owner.active) {
      throw new Error('owning user is missing or inactive — task skipped');
    }
    return actorFromUser(owner);
  }

  private async executeTask(task: RecurringTaskDocument): Promise<void> {
    try {
      const actor = await this.resolveOwnerActor(task);
      const run = async (): Promise<void> => {
        if ((task.action ?? RecurringAction.TODO) === RecurringAction.CHAT) {
          await this.executeChatAction(task);
        } else {
          await this.executeTodoAction(task);
        }
      };
      if (actor) {
        await RequestContext.run(actor, undefined, run);
      } else {
        await run();
      }
      await this.recurringTaskModel
        .findByIdAndUpdate(task._id, {
          lastRunStatus: RecurringRunStatus.SUCCEEDED,
          $unset: { lastRunError: '' },
        })
        .exec();
    } catch (err: unknown) {
      // `errorMessage` statt `(err as Error).message ?? …`: bei allem, was kein
      // Error ist, war `.message` undefined — der Nutzer sah in `lastRunError`
      // dann nur „recurring_task_failed" statt des geworfenen Strings.
      const msg = this.sanitizeError(errorMessage(err));
      this.logger.error(`Recurring task ${task._id.toString()} failed: ${msg}`);
      await this.recurringTaskModel
        .findByIdAndUpdate(task._id, {
          lastRunStatus: RecurringRunStatus.FAILED,
          lastRunError: msg,
        })
        .exec();
      throw err;
    }
  }

  /**
   * Gespeicherte Priorität → `TodoPriority`.
   *
   * Beide Seiten kennen dieselben vier Werte, das Schema hält sie als blanken
   * String. `find` liefert den Enum-Typ aus einer echten Prüfung — vorher stand
   * hier `task.priority as any`, was jeden Wert (auch einen per Import oder
   * Replikation eingeschleusten) unbesehen in die Todo-Erzeugung ließ.
   */
  private todoPriority(value?: string): TodoPriority | undefined {
    if (!value) return undefined;
    const match = asEnumValue(Object.values(TodoPriority), value);
    if (match === undefined) {
      this.logger.warn(`Unknown recurring-task priority "${value}" — todo created without one`);
    }
    return match;
  }

  private async executeTodoAction(task: RecurringTaskDocument): Promise<void> {
    if (task.projectId) {
      const base = {
        projectId: task.projectId.toString(),
        title: task.title,
        description: task.description,
        priority: this.todoPriority(task.priority),
        tags: [...task.tags],
        repoLabel: task.repoLabel,
      };
      const milestoneId = task.milestoneId?.toString();
      let todo;
      try {
        todo = await this.todosService.create({ ...base, milestoneId });
      } catch (err: unknown) {
        // TodosService now rejects a milestone outside the todo's project —
        // which includes one deleted since the task was configured. Losing
        // the milestone link is better than the task silently producing
        // nothing on every run; any other error still propagates.
        if (!milestoneId || !(err instanceof BadRequestException) || !/Milestone/.test(errorMessage(err))) throw err;
        this.logger.warn(
          `Recurring task ${task._id.toString()}: milestone ${milestoneId} is no longer valid — todo created without it`,
        );
        todo = await this.todosService.create(base);
      }
      await this.recurringTaskModel.findByIdAndUpdate(task._id, {
        $push: { createdTodoIds: todo._id },
      }).exec();
    } else if (task.customerId) {
      const todo = await this.todosService.create({
        customerId: task.customerId.toString(),
        title: task.title,
        description: task.description,
        priority: this.todoPriority(task.priority),
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
    // timeout, tool-iteration cap). executeTask runs this inside the owner's
    // RequestContext, so tool calls are scope-checked as that user; the
    // explicit callerScope additionally pins the run to the task's owner.
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
    frequency: RecurringFrequency,
    hour: number,
    dayOfWeek?: number,
    dayOfMonth?: number,
    month?: number,
  ): Date {
    const now = new Date();
    return this.computeNextRunFromDate(now, frequency, hour, dayOfWeek, dayOfMonth, month);
  }

  /**
   * Der Parameter war `RecurringFrequency | string`. Das war nicht nur
   * ungenauer, es hat den `switch` unten faktisch entwertet: `string` teilt
   * keinen Enum-Typ mit den `case`-Labels (genau das meldete
   * `no-unsafe-enum-comparison` sechsmal), und ein Wert, den kein `case` trifft,
   * fällt durch — `next` bleibt dann auf „heute, `hour` Uhr" stehen und der
   * frühere Endrekursions-Schritt lief endlos.
   */
  private computeNextRunFromDate(
    from: Date,
    frequency: RecurringFrequency,
    hour: number,
    dayOfWeek?: number,
    dayOfMonth?: number,
    month?: number,
    step = 0,
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

      // `setDate(1)` vor jeder Monats-/Jahres-Arithmetik: `setMonth(+1)` auf dem
      // 31. rollt in den Folgemonat (31.01. + 1 Monat = 03.03.), und die
      // anschließende Korrektur auf `dayOfMonth` bezog sich dann schon auf den
      // *falschen* Monat — eine monatliche Aufgabe, die am 31. angelegt wurde,
      // sprang von Januar direkt auf den 1. März und übersprang den Februar.
      case RecurringFrequency.MONTHLY: {
        const targetDom = dayOfMonth ?? 1;
        next.setDate(1);
        next.setMonth(next.getMonth() + 1);
        next.setDate(Math.min(targetDom, daysInMonth(next)));
        break;
      }

      case RecurringFrequency.QUARTERLY: {
        const targetDomQ = dayOfMonth ?? 1;
        next.setDate(1);
        next.setMonth(next.getMonth() + 3);
        next.setDate(Math.min(targetDomQ, daysInMonth(next)));
        break;
      }

      case RecurringFrequency.YEARLY: {
        const targetMonth = (month ?? 1) - 1; // month is 1-indexed
        const targetDomY = dayOfMonth ?? 1;
        next.setDate(1);
        next.setFullYear(next.getFullYear() + 1);
        next.setMonth(targetMonth);
        next.setDate(Math.min(targetDomY, daysInMonth(next)));
        break;
      }
    }

    // Ein `Invalid Date` (etwa aus `setHours(NaN)`, wenn `hour` nicht gesetzt
    // ist) ist in *jedem* Vergleich `false`. Es käme also unbemerkt durch die
    // Zukunftsprüfung unten und würde als `nextRun` entweder einen CastError
    // beim Speichern oder — schlimmer — eine Aufgabe erzeugen, die nie wieder
    // fällig wird. Deshalb hier abbrechen, wo die Ursache noch benennbar ist.
    if (Number.isNaN(next.getTime())) {
      throw new BadRequestException(
        `Cannot compute nextRun: invalid schedule (frequency=${frequency}, hour=${hour})`,
      );
    }

    // If computed time is still in the past, add one more cycle. Begrenzt statt
    // endrekursiv: jede gültige Frequenz liegt schon im ersten Schritt hinter
    // `from`, ein Zyklus ohne Fortschritt lief hier vorher bis zum Stack-Overflow.
    if (next <= from) {
      if (step >= MAX_CYCLE_STEPS) {
        throw new BadRequestException(
          `Cannot compute nextRun: frequency "${frequency}" does not advance past ${from.toISOString()}`,
        );
      }
      return this.computeNextRunFromDate(
        next,
        frequency,
        hour,
        dayOfWeek,
        dayOfMonth,
        month,
        step + 1,
      );
    }

    return next;
  }
}
