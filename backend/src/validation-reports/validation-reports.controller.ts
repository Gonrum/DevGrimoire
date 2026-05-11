import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { IsArray, IsEnum, IsMongoId, IsOptional, IsString, MaxLength } from 'class-validator';
import { CreateValidationReportDto, ListValidationReportsDto } from './dto/validation-report.dto';
import { ValidationReportsService } from './validation-reports.service';
import { TodoPriority } from '../todos/schemas/todo.schema';

class ProposeBugTodoDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsEnum(TodoPriority)
  priority?: TodoPriority;

  @IsOptional()
  @IsMongoId()
  milestoneId?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}

@Controller('validation-reports')
export class ValidationReportsController {
  constructor(private readonly reports: ValidationReportsService) {}

  @Post()
  @HttpCode(201)
  create(@Body() dto: CreateValidationReportDto) {
    return this.reports.create(dto);
  }

  @Get()
  list(@Query() query: ListValidationReportsDto) {
    return this.reports.list(query);
  }

  @Get('todo/:todoId/latest')
  latestForTodo(@Param('todoId') todoId: string) {
    return this.reports.latestForTodo(todoId);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.reports.findById(id);
  }

  @Post(':id/propose-bug-todo')
  proposeBugTodo(@Param('id') id: string, @Body() dto: ProposeBugTodoDto) {
    return this.reports.proposeBugTodo(id, dto);
  }
}
