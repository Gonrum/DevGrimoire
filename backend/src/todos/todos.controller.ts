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
} from '@nestjs/common';
import { TodosService } from './todos.service';
import { CreateTodoDto } from './dto/create-todo.dto';
import { UpdateTodoDto } from './dto/update-todo.dto';
import { TodoStatus } from './schemas/todo.schema';
import { ValidateProjectIdPipe } from '../common/pipes/validate-project-id.pipe';

@Controller('todos')
export class TodosController {
  constructor(private readonly todosService: TodosService) {}

  @Post()
  @HttpCode(201)
  create(@Body(ValidateProjectIdPipe) dto: CreateTodoDto) {
    return this.todosService.create(dto);
  }

  @Get()
  findAll(
    @Query('projectId') projectId?: string,
    @Query('status') status?: string,
  ) {
    // Support comma-separated status values: ?status=in_progress,review
    const statusFilter = status
      ? (status.split(',') as TodoStatus[])
      : [];
    return this.todosService.findAll({
      projectId,
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

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string) {
    return this.todosService.remove(id);
  }
}
