import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  HttpCode,
  BadRequestException,
} from '@nestjs/common';
import { SessionsService } from './sessions.service';
import { CreateSessionDto } from './dto/create-session.dto';
import { ValidateProjectIdPipe } from '../common/pipes/validate-project-id.pipe';

@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessionsService: SessionsService) {}

  @Post()
  @HttpCode(201)
  create(@Body(ValidateProjectIdPipe) dto: CreateSessionDto) {
    return this.sessionsService.create(dto);
  }

  @Get()
  findByProject(
    @Query('projectId') projectId?: string,
    @Query('limit') limit?: string,
  ) {
    if (!projectId) {
      throw new BadRequestException('projectId query parameter is required');
    }
    const parsedLimit = limit ? parseInt(limit, 10) : undefined;
    if (limit && (isNaN(parsedLimit!) || parsedLimit! < 1 || parsedLimit! > 100)) {
      throw new BadRequestException('limit must be a number between 1 and 100');
    }
    return this.sessionsService.findByProject(projectId, parsedLimit);
  }

  @Get('latest/:projectId')
  findLatest(@Param('projectId') projectId: string) {
    return this.sessionsService.findLatest(projectId);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.sessionsService.findById(id);
  }
}
