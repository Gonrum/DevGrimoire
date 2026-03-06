import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Todo, TodoDocument, TodoStatus } from './schemas/todo.schema';
import { CreateTodoDto } from './dto/create-todo.dto';
import { UpdateTodoDto } from './dto/update-todo.dto';

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
  ) {}

  private validateStatusTransition(current: TodoStatus, next: TodoStatus): void {
    const currentIdx = STATUS_ORDER.indexOf(current);
    const nextIdx = STATUS_ORDER.indexOf(next);
    const diff = nextIdx - currentIdx;

    if (diff === 0) return;
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

  async create(dto: CreateTodoDto): Promise<TodoDocument> {
    return this.todoModel.create(dto);
  }

  async findAll(filters: {
    projectId?: string;
    status?: TodoStatus;
  }): Promise<TodoDocument[]> {
    const query: Record<string, unknown> = {};
    if (filters.projectId) query.projectId = filters.projectId;
    if (filters.status) query.status = filters.status;
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
    return todo;
  }

  async remove(id: string): Promise<void> {
    const result = await this.todoModel.findByIdAndDelete(id).exec();
    if (!result) throw new NotFoundException(`Todo ${id} not found`);
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
    return todo;
  }

  async removeByProject(projectId: string): Promise<void> {
    await this.todoModel.deleteMany({ projectId }).exec();
  }
}
