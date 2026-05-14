import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { NotesService } from './notes.service';
import { NotesPromotionService } from './notes-promotion.service';
import { CreateNoteDto } from './dto/create-note.dto';
import { UpdateNoteDto } from './dto/update-note.dto';
import { ReorderDto } from './dto/reorder.dto';
import { PromoteCommitDto } from './dto/promote-commit.dto';

function getUserId(req: Request): string {
  const userId = (req as Request & { user?: { userId?: string } }).user?.userId;
  if (!userId) throw new BadRequestException('Authentication required');
  return userId;
}

@Controller('notes')
export class NotesController {
  constructor(
    private readonly notesService: NotesService,
    private readonly promotionService: NotesPromotionService,
  ) {}

  @Get()
  list(@Req() req: Request) {
    return this.notesService.listActive(getUserId(req));
  }

  @Get('archived')
  listArchived(@Req() req: Request) {
    return this.notesService.listArchived(getUserId(req));
  }

  @Post()
  @HttpCode(201)
  create(@Req() req: Request, @Body() dto: CreateNoteDto) {
    return this.notesService.create(getUserId(req), dto);
  }

  @Patch('reorder')
  @HttpCode(204)
  async reorder(@Req() req: Request, @Body() dto: ReorderDto): Promise<void> {
    await this.notesService.reorder(getUserId(req), dto.orderedIds);
  }

  @Put(':id')
  update(@Req() req: Request, @Param('id') id: string, @Body() dto: UpdateNoteDto) {
    return this.notesService.update(getUserId(req), id, dto);
  }

  @Post(':id/archive')
  archive(@Req() req: Request, @Param('id') id: string) {
    return this.notesService.archive(getUserId(req), id);
  }

  @Post(':id/snooze')
  snooze(@Req() req: Request, @Param('id') id: string) {
    return this.notesService.snooze(getUserId(req), id);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Req() req: Request, @Param('id') id: string): Promise<void> {
    await this.notesService.remove(getUserId(req), id);
  }

  // ---------- Promotion (Phase 1 = SSE stream, Phase 3 = commit) ----------

  @Post(':id/promote')
  async promote(
    @Req() req: Request,
    @Res() res: Response,
    @Param('id') id: string,
  ): Promise<void> {
    const userId = getUserId(req);

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    const flush = (res as Response & { flushHeaders?: () => void }).flushHeaders;
    if (typeof flush === 'function') flush.call(res);

    const send = (event: Record<string, unknown>) => {
      if (res.writableEnded) return;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 15000);

    const abort = new AbortController();
    req.on('close', () => abort.abort());

    try {
      for await (const event of this.promotionService.analyze(userId, id, abort.signal)) {
        send(event);
      }
    } catch (err: any) {
      send({ type: 'error', message: err?.message || 'unknown error' });
    } finally {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    }
  }

  @Post(':id/promote/commit')
  promoteCommit(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: PromoteCommitDto,
  ) {
    return this.promotionService.commit(getUserId(req), id, dto);
  }
}
