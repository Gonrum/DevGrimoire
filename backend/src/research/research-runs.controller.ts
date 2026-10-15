import {
  BadRequestException, Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query, Req, Res, UploadedFiles, UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { ResearchControlService } from './research-control.service';
import { ResearchLiveService, type LiveEvent } from './research-live.service';
import { extractUploadText, type UploadedFile } from './research-files';
import { DeepenDto, MoveDto, StartResearchDto } from './dto/research-run.dto';

const UPLOAD_LIMIT_BYTES = 20 * 1024 * 1024;
const HEARTBEAT_MS = 15_000;

/**
 * Steuerung und Live-Strom. Muss im Modul VOR dem Legacy-`ResearchController`
 * stehen, sonst fängt dessen `GET :id` die statischen Routen `queue` ab.
 */
@Controller('research')
export class ResearchRunsController {
  constructor(
    private readonly control: ResearchControlService,
    private readonly liveRuns: ResearchLiveService,
  ) {}

  @Post('start')
  @UseInterceptors(FilesInterceptor('files', 10, { limits: { fileSize: UPLOAD_LIMIT_BYTES } }))
  async start(@Body() dto: StartResearchDto, @UploadedFiles() uploaded?: UploadedFile[]): Promise<{ ids: string[] }> {
    const files: Array<{ name: string; text: string }> = [];
    for (const f of uploaded ?? []) files.push({ name: f.originalname, text: await extractUploadText(f) });
    const ids = await this.control.start({
      topics: dto.topics,
      focus: dto.focus,
      depth: dto.depth ?? 'normal',
      files,
      moveTargetHint: dto.moveTargetHint,
    });
    return { ids };
  }

  @Get('queue')
  async queue(): Promise<{ positions: Array<{ id: string; position: number }> }> {
    return { positions: await this.control.queuePositions() };
  }

  @Post(':id/cancel') @HttpCode(204)
  cancel(@Param('id') id: string): Promise<void> { return this.control.cancel(id); }

  @Post(':id/pause') @HttpCode(204)
  pause(@Param('id') id: string): Promise<void> { return this.control.pause(id); }

  @Post(':id/resume') @HttpCode(204)
  resume(@Param('id') id: string): Promise<void> { return this.control.resume(id); }

  @Post(':id/retry') @HttpCode(204)
  retry(@Param('id') id: string): Promise<void> { return this.control.retry(id); }

  @Post(':id/deepen') @HttpCode(204)
  deepen(@Param('id') id: string, @Body() dto: DeepenDto): Promise<void> { return this.control.deepen(id, dto.question); }

  @Post(':id/move') @HttpCode(204)
  move(@Param('id') id: string, @Body() dto: MoveDto): Promise<void> {
    return this.control.move(id, { projectId: dto.projectId, customerId: dto.customerId });
  }

  @Get(':id/steps')
  async steps(@Param('id') id: string, @Query('limit', new ParseIntPipe({ optional: true })) limit?: number) {
    if (limit !== undefined && limit < 1) throw new BadRequestException('limit muss positiv sein');
    return { steps: await this.control.listSteps(id, limit) };
  }

  @Get(':id/live')
  async live(@Param('id') id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    // Sichtbarkeit VOR dem ersten Header: sonst ginge ein 404 als SSE-Strom hinaus.
    const status = await this.control.statusOf(id);

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (event: LiveEvent): void => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    let heartbeat: NodeJS.Timeout | undefined;
    let unsubscribe: (() => void) | undefined;
    const close = (): void => {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = undefined;
      unsubscribe?.();
      unsubscribe = undefined;
      if (!res.writableEnded) res.end();
    };

    send(this.liveRuns.snapshot(id));
    if (status !== 'running' && status !== 'queued') {
      send({ type: 'end' });
      close();
      return;
    }
    heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, HEARTBEAT_MS);
    req.on('close', close);
    unsubscribe = this.liveRuns.subscribe(id, (ev) => {
      send(ev);
      if (ev.type === 'end') close();
    });
  }
}
