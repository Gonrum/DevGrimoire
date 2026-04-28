import { Body, Controller, Delete, Get, HttpCode, Param, ParseEnumPipe, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { WorkspacesService } from './workspaces.service';
import { WorkspaceClient } from './workspace-client.service';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { UpdateWorkspaceDto } from './dto/update-workspace.dto';
import { ExecWorkspaceDto } from './dto/exec-workspace.dto';
import { WORKSPACE_STATUSES, WorkspaceStatus } from './schemas/workspace.schema';
import { LogsService } from '../logs/logs.service';

@Controller('workspaces')
export class WorkspacesController {
  constructor(
    private readonly workspacesService: WorkspacesService,
    private readonly workspaceClient: WorkspaceClient,
    private readonly logs: LogsService,
  ) {}

  @Post()
  @HttpCode(201)
  create(@Body() dto: CreateWorkspaceDto) {
    return this.workspacesService.create(dto);
  }

  @Get()
  findAll(
    @Query('projectId') projectId: string,
    @Query('status', new ParseEnumPipe(WORKSPACE_STATUSES, { optional: true }))
    status?: WorkspaceStatus,
  ) {
    return this.workspacesService.findByProject(projectId, status);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.workspacesService.findById(id);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() dto: UpdateWorkspaceDto) {
    return this.workspacesService.update(id, dto);
  }

  @Post(':id/archive')
  archive(@Param('id') id: string) {
    return this.workspacesService.archive(id);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string) {
    return this.workspacesService.remove(id);
  }

  /**
   * Streams a shell command's output as SSE for the manual terminal UI
   * (T-153). Wraps the sidecar's /exec/stream NDJSON in proper SSE frames
   * so the browser can read it via fetch+ReadableStream. Per-call audit
   * log on completion mirrors the MCP workspace_exec path.
   */
  @Post(':id/exec/stream')
  async execStream(
    @Param('id') id: string,
    @Body() dto: ExecWorkspaceDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    // findById throws 404 BEFORE we open the SSE channel — the browser then
    // gets a clean JSON error instead of a half-opened stream.
    const ws = await this.workspacesService.findById(id);

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    const flushHeaders = (res as Response & { flushHeaders?: () => void }).flushHeaders;
    if (typeof flushHeaders === 'function') flushHeaders.call(res);

    const abort = new AbortController();
    req.on('close', () => abort.abort());

    const send = (event: Record<string, unknown>) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    let lastDone: Record<string, unknown> | null = null;
    try {
      await this.workspaceClient.execStream(
        ws._id.toString(),
        dto.command,
        dto.timeout,
        dto.env,
        abort.signal,
        (event) => {
          send(event);
          if (event.type === 'done') lastDone = event;
        },
      );
    } catch (err) {
      send({ type: 'error', message: (err as Error).message });
    }
    if (!res.writableEnded) res.end();

    // Best-effort housekeeping after the stream — failures don't matter
    // because the response has already been delivered.
    this.workspacesService.touch(id).catch(() => undefined);
    if (lastDone) {
      const done = lastDone as { exitCode: number | null; signal?: string | null; timedOut?: boolean; killReason?: string | null; durationMs?: number; stdoutTruncated?: boolean; stderrTruncated?: boolean };
      this.logs
        .create({
          projectId: ws.projectId.toString(),
          level: done.exitCode === 0 ? 'info' : 'warn',
          message: `workspace_terminal ${done.timedOut ? 'TIMED OUT' : `exit=${done.exitCode}`} (${done.durationMs}ms): ${dto.command.slice(0, 200)}`,
          service: 'workspaces',
          area: 'terminal',
          tags: ['workspace_terminal', `ws:${id}`],
          metadata: {
            workspaceId: id,
            command: dto.command,
            exitCode: done.exitCode,
            signal: done.signal,
            timedOut: done.timedOut,
            killReason: done.killReason,
            durationMs: done.durationMs,
            stdoutTruncated: done.stdoutTruncated,
            stderrTruncated: done.stderrTruncated,
          },
        })
        .catch(() => undefined);
    }
  }
}
