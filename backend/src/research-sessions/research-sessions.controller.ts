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
  Req,
  Res,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ResearchSessionsService } from './research-sessions.service';
import { CreateResearchSessionDto } from './dto/create-research-session.dto';
import { UpdateResearchSessionDto } from './dto/update-research-session.dto';
import { CreateResearchStepDto } from './dto/create-research-step.dto';
import { UpdateResearchStepDto } from './dto/update-research-step.dto';
import { ResearchSessionStatus } from './schemas/research-session.schema';

interface SendMessageDto {
  content: string;
}

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

  @Post('sessions/:id/steps/:stepId/save-research')
  saveStepAsResearch(@Param('stepId') stepId: string) {
    return this.service.saveStepAsResearch(stepId);
  }

  @Post('sessions/:id/steps/:stepId/messages')
  async sendMessage(
    @Param('stepId') stepId: string,
    @Body() dto: SendMessageDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    const flushHeaders = (res as Response & { flushHeaders?: () => void }).flushHeaders;
    if (typeof flushHeaders === 'function') flushHeaders.call(res);

    const send = (event: Record<string, unknown>): void => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 15000);

    const abort = new AbortController();
    req.on('close', () => abort.abort());

    try {
      await this.service.streamStepAnswer(stepId, dto.content, {
        onContext: (refs) => send({ type: 'context', refs }),
        onToken: (delta) => send({ type: 'token', content: delta }),
        onDone: () => send({ type: 'done' }),
        onError: (message) => send({ type: 'error', message }),
        signal: abort.signal,
      });
    } catch (err) {
      send({ type: 'error', message: (err as Error).message || 'unknown error' });
    } finally {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    }
  }
}
