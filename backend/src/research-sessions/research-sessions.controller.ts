import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ResearchSessionsService } from './research-sessions.service';
import { CreateResearchSessionDto } from './dto/create-research-session.dto';
import { UpdateResearchSessionDto } from './dto/update-research-session.dto';
import { CreateResearchStepDto } from './dto/create-research-step.dto';
import { UpdateResearchStepDto } from './dto/update-research-step.dto';
import { ResearchSessionStatus } from './schemas/research-session.schema';

@Controller('research')
export class ResearchSessionsController {
  constructor(private readonly service: ResearchSessionsService) {}

  @Get('sessions')
  listSessions(@Query('status') status?: ResearchSessionStatus, @Query('q') q?: string) {
    return this.service.listSessions({ status, q });
  }

  @Post('sessions')
  @HttpCode(201)
  createSession(@Body() dto: CreateResearchSessionDto) {
    return this.service.createSession(dto);
  }

  @Get('sessions/:id')
  getSession(@Param('id') id: string) {
    return this.service.getSessionWithSteps(id);
  }

  @Patch('sessions/:id')
  updateSession(@Param('id') id: string, @Body() dto: UpdateResearchSessionDto) {
    return this.service.updateSession(id, dto);
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  async deleteSession(@Param('id') id: string) {
    await this.service.deleteSession(id);
  }

  @Post('sessions/:id/steps')
  @HttpCode(201)
  createStep(@Param('id') sessionId: string, @Body() dto: CreateResearchStepDto) {
    return this.service.createStep(sessionId, dto);
  }

  @Patch('sessions/:id/steps/:stepId')
  updateStep(@Param('stepId') stepId: string, @Body() dto: UpdateResearchStepDto) {
    return this.service.updateStep(stepId, dto);
  }

  @Delete('sessions/:id/steps/:stepId')
  @HttpCode(204)
  async deleteStep(@Param('stepId') stepId: string) {
    await this.service.deleteStep(stepId);
  }
}
