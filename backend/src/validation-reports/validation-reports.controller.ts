import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { CreateValidationReportDto, ListValidationReportsDto } from './dto/validation-report.dto';
import { ValidationReportsService } from './validation-reports.service';

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
}
