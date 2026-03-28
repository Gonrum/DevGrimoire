import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RecurringTask, RecurringTaskDocument, RecurringFrequency } from './schemas/recurring-task.schema';
import { CreateRecurringTaskDto } from './dto/create-recurring-task.dto';
import { UpdateRecurringTaskDto } from './dto/update-recurring-task.dto';
import { TodosService } from '../todos/todos.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PROJECT_CHANGED } from '../events/project-event';

@Injectable()
export class RecurringTasksService {
  private readonly logger = new Logger(RecurringTasksService.name);

  constructor(
    @InjectModel(RecurringTask.name) private recurringTaskModel: Model<RecurringTaskDocument>,
    private readonly todosService: TodosService,
    private readonly notificationsService: NotificationsService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async create(dto: CreateRecurringTaskDto): Promise<RecurringTaskDocument> {
    const nextRun = this.computeNextRun(
      dto.frequency,
      dto.hour ?? 9,
      dto.dayOfWeek,
      dto.dayOfMonth,
      dto.month,
    );
    const task = await this.recurringTaskModel.create({ ...dto, nextRun });
    if (task.projectId) {
      this.eventEmitter.emit(PROJECT_CHANGED, {
        projectId: task.projectId.toString(),
        entity: 'recurring-task',
        action: 'created',
        entityId: task._id.toString(),
        summary: `Wiederkehrende Aufgabe "${task.title}" erstellt`,
      });
    }
    return task;
  }

  async findAll(filters?: { projectId?: string; systemOnly?: boolean; active?: boolean }): Promise<RecurringTaskDocument[]> {
    const query: Record<string, unknown> = {};
    if (filters?.projectId) query.projectId = filters.projectId;
    if (filters?.systemOnly) query.projectId = { $exists: false };
    if (filters?.active !== undefined) query.active = filters.active;
    return this.recurringTaskModel.find(query).sort({ createdAt: -1 }).exec();
  }

  async findByProject(projectId: string, active?: boolean): Promise<RecurringTaskDocument[]> {
    return this.findAll({ projectId, active });
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

    const updateData: Record<string, unknown> = { ...dto };
    if (dto.frequency !== undefined || dto.hour !== undefined || dto.dayOfWeek !== undefined || dto.dayOfMonth !== undefined || dto.month !== undefined) {
      updateData.nextRun = this.computeNextRun(frequency, hour, dayOfWeek, dayOfMonth, month);
    }

    const task = await this.recurringTaskModel.findByIdAndUpdate(id, updateData, { new: true }).exec();
    if (!task) throw new NotFoundException(`RecurringTask ${id} not found`);
    if (task.projectId) {
      this.eventEmitter.emit(PROJECT_CHANGED, {
        projectId: task.projectId.toString(),
        entity: 'recurring-task',
        action: 'updated',
        entityId: id,
        summary: `Wiederkehrende Aufgabe "${task.title}" aktualisiert`,
      });
    }
    return task;
  }

  async remove(id: string): Promise<void> {
    const result = await this.recurringTaskModel.findByIdAndDelete(id).exec();
    if (!result) throw new NotFoundException(`RecurringTask ${id} not found`);
    if (result.projectId) {
      this.eventEmitter.emit(PROJECT_CHANGED, {
        projectId: result.projectId.toString(),
        entity: 'recurring-task',
        action: 'deleted',
        entityId: id,
        summary: `Wiederkehrende Aufgabe "${result.title}" entfernt`,
      });
    }
  }

  async removeByProject(projectId: string): Promise<void> {
    await this.recurringTaskModel.deleteMany({ projectId }).exec();
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
      try {
        // Calculate how many runs were missed
        let runs = 0;
        const maxRuns = task.maxCatchUp || 3;
        let currentNext = new Date(task.nextRun);

        while (currentNext <= now && runs < maxRuns) {
          runs++;
          currentNext = this.computeNextRunFromDate(currentNext, task.frequency, task.hour, task.dayOfWeek, task.dayOfMonth, task.month);
        }

        // Execute for each missed run (up to maxCatchUp)
        for (let i = 0; i < runs; i++) {
          await this.executeTask(task);
          count++;
        }

        // Update nextRun and lastRun
        const nextRun = this.computeNextRun(task.frequency, task.hour, task.dayOfWeek, task.dayOfMonth, task.month);
        await this.recurringTaskModel.findByIdAndUpdate(task._id, {
          lastRun: now,
          nextRun,
        }).exec();
      } catch (err) {
        this.logger.error(`Failed to process recurring task ${task._id}: ${err}`);
      }
    }

    return count;
  }

  private async executeTask(task: RecurringTaskDocument): Promise<void> {
    if (task.projectId) {
      // Project-bound: create a todo
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
    } else {
      // System-wide: create a notification
      await this.notificationsService.create(
        task.title,
        task.description || task.title,
        undefined,
        'recurring',
      );
    }
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
