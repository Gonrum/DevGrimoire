import {
  BadRequestException,
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

/** String-Wert → Enum-Mitglied, für die Filter-Query `?status=a,b`. */
const TODO_STATUS_BY_VALUE: ReadonlyMap<string, TodoStatus> = new Map(
  Object.values(TodoStatus).map((value) => [String(value), value]),
);

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
    //
    // Der Cast auf TodoStatus[] war eine Behauptung über Nutzereingabe:
    // `?status=nonsense` lief ungeprüft in den Service-Filter und traf dort
    // nichts, ohne dass der Aufrufer erfuhr warum. `find` über die Enum-Werte
    // liefert den engen Typ aus einer echten Prüfung.
    const statusFilter = (status ?? '')
      .split(',')
      .map((raw) => raw.trim())
      .filter((raw) => raw !== '')
      .map((raw) => {
        // Nachschlagen statt vergleichen: `candidate === raw` stellt einen
        // echten TS-Enum gegen einen String und wird von
        // `no-unsafe-enum-comparison` zu Recht beanstandet. Die Map liefert
        // `TodoStatus | undefined` direkt aus einem String-Schlüssel.
        const match = TODO_STATUS_BY_VALUE.get(raw);
        if (!match) {
          throw new BadRequestException(
            `status must be one of: ${[...TODO_STATUS_BY_VALUE.keys()].join(', ')} (got "${raw}")`,
          );
        }
        return match;
      });
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
