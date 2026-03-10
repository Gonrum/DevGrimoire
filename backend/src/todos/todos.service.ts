import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import { Todo, TodoDocument, TodoStatus } from './schemas/todo.schema';
import { Project, ProjectDocument } from '../projects/schemas/project.schema';
import { CreateTodoDto } from './dto/create-todo.dto';
import { UpdateTodoDto } from './dto/update-todo.dto';
import { PROJECT_CHANGED } from '../events/project-event';
import { CountersService } from '../counters/counters.service';
import { formatEntityNumber } from '../common/number-format';

const STATUS_ORDER: TodoStatus[] = [
  TodoStatus.OPEN,
  TodoStatus.IN_PROGRESS,
  TodoStatus.REVIEW,
  TodoStatus.DONE,
];

@Injectable()
export class TodosService {
  constructor(
    @InjectModel(Todo.name) private todoModel: Model<TodoDocument>,
    @InjectModel(Project.name) private projectModel: Model<ProjectDocument>,
    private countersService: CountersService,
    private eventEmitter: EventEmitter2,
  ) {}

  private validateStatusTransition(current: TodoStatus, next: TodoStatus): void {
    const currentIdx = STATUS_ORDER.indexOf(current);
    const nextIdx = STATUS_ORDER.indexOf(next);
    const diff = nextIdx - currentIdx;

    if (diff === 0) return;
    // Allow reopening: done -> open
    if (current === TodoStatus.DONE && next === TodoStatus.OPEN) return;
    if (diff !== 1 && diff !== -1) {
      const arrow = STATUS_ORDER.join(' -> ');
      throw new BadRequestException(
        `Invalid status transition: "${current}" -> "${next}". ` +
        `Status can only move one step at a time: ${arrow}. ` +
        `Current status is "${current}", next valid status(es): ` +
        [
          currentIdx > 0 ? STATUS_ORDER[currentIdx - 1] : null,
          currentIdx < STATUS_ORDER.length - 1 ? STATUS_ORDER[currentIdx + 1] : null,
        ].filter(Boolean).map(s => `"${s}"`).join(' or ') + '.',
      );
    }
  }

  async findByNumber(projectId: string, number: number): Promise<TodoDocument> {
    const todo = await this.todoModel.findOne({ projectId, number }).exec();
    if (!todo) throw new NotFoundException(`Todo #${number} not found in project ${projectId}`);
    return todo;
  }

  async findByDisplayNumber(projectId: string, displayNumber: string): Promise<TodoDocument> {
    const todo = await this.todoModel.findOne({ projectId, displayNumber }).exec();
    if (!todo) throw new NotFoundException(`Todo "${displayNumber}" not found in project ${projectId}`);
    return todo;
  }

  async resolveId(args: { id?: string; projectId?: string; number?: string }): Promise<string> {
    if (args.id) return args.id;
    if (!args.number || !args.projectId) {
      throw new BadRequestException('Either id or number+projectId must be provided');
    }
    const num = parseInt(args.number, 10);
    const todo = isNaN(num)
      ? await this.findByDisplayNumber(args.projectId, args.number)
      : await this.findByNumber(args.projectId, num);
    return todo._id.toString();
  }

  async create(dto: CreateTodoDto): Promise<TodoDocument> {
    const project = await this.projectModel.findById(dto.projectId).exec();
    if (!project) throw new NotFoundException(`Project ${dto.projectId} not found`);
    const seq = await this.countersService.getNextSequence(dto.projectId, 'todo');
    const displayNumber = formatEntityNumber(
      project.todoNumberFormat || '{type}-{n}',
      seq,
      project.name,
      'T',
    );
    const todo = await this.todoModel.create({ ...dto, number: seq, displayNumber });
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: todo.projectId.toString(),
      entity: 'todo',
      action: 'created',
      entityId: todo._id.toString(),
      summary: `Todo "${todo.title}" erstellt`,
    });
    return todo;
  }

  async findAll(filters: {
    projectId?: string;
    status?: TodoStatus;
    statuses?: TodoStatus[];
    priority?: string;
    milestoneId?: string;
    tag?: string;
    includeArchived?: boolean;
  }): Promise<TodoDocument[]> {
    const query: Record<string, unknown> = {};
    if (filters.projectId) query.projectId = filters.projectId;
    if (filters.statuses?.length) query.status = { $in: filters.statuses };
    else if (filters.status) query.status = filters.status;
    if (filters.priority) query.priority = filters.priority;
    if (filters.milestoneId) query.milestoneId = filters.milestoneId;
    if (filters.tag) query.tags = filters.tag;
    if (!filters.includeArchived) query.archived = { $ne: true };
    return this.todoModel.find(query).sort({ priority: 1, createdAt: -1 }).exec();
  }

  async findById(id: string): Promise<TodoDocument> {
    const todo = await this.todoModel.findById(id).exec();
    if (!todo) throw new NotFoundException(`Todo ${id} not found`);
    return todo;
  }

  async update(id: string, dto: UpdateTodoDto): Promise<TodoDocument> {
    if (dto.status) {
      const existing = await this.todoModel.findById(id).exec();
      if (!existing) throw new NotFoundException(`Todo ${id} not found`);
      this.validateStatusTransition(existing.status, dto.status);
    }

    const todo = await this.todoModel
      .findByIdAndUpdate(id, dto, { new: true })
      .exec();
    if (!todo) throw new NotFoundException(`Todo ${id} not found`);
    const changes: string[] = [];
    if (dto.status) changes.push(`Status → ${dto.status}`);
    if (dto.priority) changes.push(`Priorität → ${dto.priority}`);
    if (dto.title) changes.push(`Titel geändert`);
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: todo.projectId.toString(),
      entity: 'todo',
      action: 'updated',
      entityId: id,
      summary: `Todo "${todo.title}" aktualisiert${changes.length ? ': ' + changes.join(', ') : ''}`,
    });
    return todo;
  }

  async remove(id: string): Promise<void> {
    const result = await this.todoModel.findByIdAndDelete(id).exec();
    if (!result) throw new NotFoundException(`Todo ${id} not found`);
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: result.projectId.toString(),
      entity: 'todo',
      action: 'deleted',
      entityId: id,
      summary: `Todo "${result.title}" gelöscht`,
    });
  }

  async addComment(id: string, text: string, author = 'user'): Promise<TodoDocument> {
    const todo = await this.todoModel
      .findByIdAndUpdate(
        id,
        { $push: { comments: { text, author, createdAt: new Date() } } },
        { new: true },
      )
      .exec();
    if (!todo) throw new NotFoundException(`Todo ${id} not found`);
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: todo.projectId.toString(),
      entity: 'todo',
      action: 'updated',
      entityId: id,
      summary: `Kommentar von ${author} zu "${todo.title}"`,
    });
    return todo;
  }

  async removeByProject(projectId: string): Promise<void> {
    await this.todoModel.deleteMany({ projectId }).exec();
  }
}
