import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Todo, TodoDocument, TodoStatus } from './schemas/todo.schema';
import { CreateTodoDto } from './dto/create-todo.dto';
import { UpdateTodoDto } from './dto/update-todo.dto';

@Injectable()
export class TodosService {
  constructor(
    @InjectModel(Todo.name) private todoModel: Model<TodoDocument>,
  ) {}

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
