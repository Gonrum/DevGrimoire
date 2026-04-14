import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  HttpCode,
} from '@nestjs/common';
import { LogsService } from './logs.service';
import { CreateLogDto } from './dto/create-log.dto';
import { QueryLogsDto } from './dto/query-logs.dto';

@Controller('logs')
export class LogsController {
  constructor(private readonly logsService: LogsService) {}

  @Post()
  @HttpCode(201)
  create(@Body() dto: CreateLogDto) {
    return this.logsService.create(dto);
  }

  @Post('batch')
  @HttpCode(201)
  async createBatch(@Body() body: { logs: CreateLogDto[] }) {
    const inserted = await this.logsService.createBatch(body.logs);
    return { inserted };
  }

  @Get()
  findAll(@Query() query: QueryLogsDto) {
    return this.logsService.findByProject(query.projectId, {
      level: query.level,
      service: query.service,
      search: query.search,
      startDate: query.startDate,
      endDate: query.endDate,
      limit: query.limit ? parseInt(query.limit) : undefined,
      offset: query.offset ? parseInt(query.offset) : undefined,
    });
  }

  @Get('stats')
  stats(@Query('projectId') projectId: string) {
    return this.logsService.stats(projectId);
  }
}
