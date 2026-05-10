import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { MonitoringService } from './monitoring.service';
import { CreateHealthcheckDto } from './dto/create-healthcheck.dto';
import { UpdateHealthcheckDto } from './dto/update-healthcheck.dto';

@Controller()
export class MonitoringController {
  constructor(private readonly monitoringService: MonitoringService) {}

  @Get('customers/:customerId/healthchecks')
  listForCustomer(@Param('customerId') customerId: string) {
    return this.monitoringService.findByCustomer(customerId);
  }

  @Get('customers/:customerId/healthchecks/summary')
  summary(@Param('customerId') customerId: string) {
    return this.monitoringService.getCustomerSummary(customerId);
  }

  @Post('customers/:customerId/healthchecks')
  @HttpCode(201)
  create(@Param('customerId') customerId: string, @Body() dto: CreateHealthcheckDto) {
    return this.monitoringService.create({ ...dto, customerId });
  }

  @Get('healthchecks/:id')
  findOne(@Param('id') id: string) {
    return this.monitoringService.findById(id);
  }

  @Put('healthchecks/:id')
  update(@Param('id') id: string, @Body() dto: UpdateHealthcheckDto) {
    return this.monitoringService.update(id, dto);
  }

  @Delete('healthchecks/:id')
  @HttpCode(204)
  remove(@Param('id') id: string) {
    return this.monitoringService.remove(id);
  }

  @Post('healthchecks/:id/run')
  run(@Param('id') id: string) {
    return this.monitoringService.runOnce(id);
  }

  @Get('healthchecks/:id/history')
  history(
    @Param('id') id: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.monitoringService.listHistory(
      id,
      limit ? Number(limit) : undefined,
      offset ? Number(offset) : undefined,
    );
  }
}
