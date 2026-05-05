import { Controller, Get, Post, Put, Delete, Body, Param, Query, HttpCode } from '@nestjs/common';
import { RecurringTasksService } from './recurring-tasks.service';
import { CreateRecurringTaskDto } from './dto/create-recurring-task.dto';
import { UpdateRecurringTaskDto } from './dto/update-recurring-task.dto';

@Controller('recurring-tasks')
export class RecurringTasksController {
  constructor(private readonly recurringTasksService: RecurringTasksService) {}

  @Post()
  @HttpCode(201)
  create(@Body() dto: CreateRecurringTaskDto) {
    return this.recurringTasksService.create(dto);
  }

  @Get()
  findAll(
    @Query('projectId') projectId?: string,
    @Query('customerId') customerId?: string,
    @Query('active') active?: string,
    @Query('systemOnly') systemOnly?: string,
  ) {
    const activeBool = active !== undefined ? active === 'true' : undefined;
    const systemOnlyBool = systemOnly === 'true';
    return this.recurringTasksService.findAll({ projectId, customerId, systemOnly: systemOnlyBool, active: activeBool });
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.recurringTasksService.findById(id);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() dto: UpdateRecurringTaskDto) {
    return this.recurringTasksService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string) {
    return this.recurringTasksService.remove(id);
  }

  @Post(':id/trigger')
  trigger(@Param('id') id: string) {
    return this.recurringTasksService.trigger(id);
  }
}
