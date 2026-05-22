import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  NotFoundException,
} from '@nestjs/common';
import { isValidObjectId } from 'mongoose';
import { TodosService } from './todos.service';
import { QuestionsService } from '../questions/questions.service';
import { CreateTodoDto } from './dto/create-todo.dto';
import { UpdateTodoDto } from './dto/update-todo.dto';
import { CreateTodoQuestionDto } from './dto/create-todo-question.dto';
import { TodoStatus } from './schemas/todo.schema';
import { ValidateProjectIdPipe } from '../common/pipes/validate-project-id.pipe';

@Controller('todos')
export class TodosController {
  constructor(
    private readonly todosService: TodosService,
    private readonly questionsService: QuestionsService,
  ) {}

  @Post()
  @HttpCode(201)
  create(@Body(ValidateProjectIdPipe) dto: CreateTodoDto) {
    return this.todosService.create(dto);
  }

  @Get()
  findAll(
    @Query('projectId') projectId?: string,
    @Query('customerId') customerId?: string,
    @Query('status') status?: string,
  ) {
    // Support comma-separated status values: ?status=in_progress,review
    const statusFilter = status
      ? (status.split(',') as TodoStatus[])
      : [];
    return this.todosService.findAll({
      projectId,
      customerId,
      status: statusFilter.length === 1 ? statusFilter[0] : undefined,
      statuses: statusFilter.length > 1 ? statusFilter : undefined,
    });
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.todosService.findById(id);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() dto: UpdateTodoDto) {
    return this.todosService.update(id, dto);
  }

  @Post(':id/comments')
  addComment(
    @Param('id') id: string,
    @Body() body: { text: string; author?: string },
  ) {
    return this.todosService.addComment(id, body.text, body.author);
  }

  @Post(':id/questions')
  @HttpCode(201)
  async createQuestion(
    @Param('id') id: string,
    @Body() dto: CreateTodoQuestionDto,
  ) {
    if (!isValidObjectId(id)) {
      throw new NotFoundException(`Todo ${id} not found`);
    }
    // Validates the todo exists (throws 404 if not)
    await this.todosService.findById(id);
    return this.questionsService.create({
      ...dto,
      todoId: id,
      direction: 'agent_to_user',
    });
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string) {
    return this.todosService.remove(id);
  }
}
