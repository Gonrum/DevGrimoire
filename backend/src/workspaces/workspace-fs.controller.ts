import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UsePipes,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { posix } from 'node:path';
import { WorkspacesService } from './workspaces.service';
import { WorkspaceDocument } from './schemas/workspace.schema';
import { FsMoveDto, FsPathDto, FsSearchDto, FsWriteDto, isRelativeWorkspacePath } from './dto/workspace-fs.dto';
import { WorkspaceFsBackends } from './fs/workspace-fs-backends.service';
import type { FsLimits, WorkspaceFsBackend } from './fs/workspace-fs-backend';
import { LogsService } from '../logs/logs.service';
import { WorkspaceLimitsService } from './workspace-limits.service';
import { DownloadTicketService } from '../common/download-ticket.service';
import { DownloadActorService } from './download-actor.service';
import { AcceptsDownloadTicket } from '../auth/decorators/accepts-download-ticket.decorator';
import { RequestContext } from '../common/request-context';
import { ScalarQueryPipe } from '../common/scalar-query.pipe';
import { SshWorkspaceAccess } from './ssh-workspace-access.service';
import { logWorkspaceIde, openWorkspaceFs } from './workspace-fs-gate';
import { errorMessage } from '../common/narrow';

const PATH_MAX = 4096;

/**
 * Query-parameter path: same rules as the DTO paths (the ValidationPipe does
 * not look at single scalar query parameters).
 */
function queryPath(value: string | undefined, name: string, fallback?: string): string {
  const v = value ?? fallback;
  if (v === undefined || v === '' || v.length > PATH_MAX || !isRelativeWorkspacePath(v)) {
    throw new BadRequestException(`${name} must be a non-empty relative path`);
  }
  return v;
}

/** A plain file name: no separators, no dot names, no NUL. */
function plainFileName(value: string | undefined): string {
  if (
    !value || value.length > 255 || value === '.' || value === '..'
    || value.includes('/') || value.includes('\\') || value.includes('\0')
  ) {
    throw new BadRequestException('fileName must be a plain file name');
  }
  return value;
}

/**
 * REST file access for the browser IDE ("Werkstatt"). Every route, GET
 * included, goes through `gate()`: the PermissionGateGuard lets GETs through
 * unchecked, and an interactive file API is a content write in effect (same
 * rule as the terminal proxy in main.ts). Deliberately without
 * @McpToolEquivalent: an API key with a tool allowlist is an MCP-only key.
 */
@Controller('workspaces/:id/fs')
@UsePipes(new ScalarQueryPipe())
// The global 100/min (app.module, unnamed = "default" throttler) is far too
// low for an interactive IDE: expanding folders and multi-file uploads issue
// one request each. Raised, not skipped, so a runaway client is still capped.
@Throttle({ default: { limit: 1200, ttl: 60_000 } })
export class WorkspaceFsController {
  constructor(
    private readonly workspaces: WorkspacesService,
    private readonly backends: WorkspaceFsBackends,
    private readonly logs: LogsService,
    private readonly limits: WorkspaceLimitsService,
    private readonly tickets: DownloadTicketService,
    private readonly downloadActors: DownloadActorService,
    private readonly sshAccess: SshWorkspaceAccess,
  ) {}

  /**
   * Permission -> load workspace (403/404) -> must be active -> SSH: the
   * connection must still exist, be usable by the actor and for the project
   * (409/403, on every request) -> file backend. Shared with the IDE agent's
   * ws_* tools (`openWorkspaceFs`). One place for all routes.
   */
  private async gate(id: string): Promise<{ ws: WorkspaceDocument; backend: WorkspaceFsBackend }> {
    const { ws, backend } = await openWorkspaceFs(
      { workspaces: this.workspaces, backends: this.backends, sshAccess: this.sshAccess },
      id,
    );
    return { ws, backend };
  }

  /** Limits in force for this request. Upload cap stays with the sidecar for containers. */
  private async fsLimits(): Promise<FsLimits> {
    const { editorMaxBytes, downloadMaxBytes } = await this.limits.get();
    return { editorMaxBytes, downloadMaxBytes };
  }

  private audit(
    ws: WorkspaceDocument,
    id: string,
    message: string,
    metadata: Record<string, unknown>,
    level: 'info' | 'warn' = 'info',
  ): void {
    logWorkspaceIde(this.logs, ws, id, message, metadata, level);
  }

  @Get('tree')
  async tree(@Param('id') id: string, @Query('path') path?: string) {
    const { backend } = await this.gate(id);
    const res = await backend.listDir(queryPath(path, 'path', '.'));
    this.workspaces.touchThrottled(id);
    const entries = res.entries.map((e) => ({
      name: posix.basename(e.path),
      path: e.path,
      type: e.type,
      ...(e.size !== undefined ? { size: e.size } : {}),
    }));
    entries.sort((a, b) => {
      const da = a.type === 'dir' ? 0 : 1;
      const db = b.type === 'dir' ? 0 : 1;
      return da - db || a.name.localeCompare(b.name);
    });
    return { entries, truncated: res.truncated };
  }

  @Get('file')
  async readFile(@Param('id') id: string, @Query('path') path?: string) {
    const { backend } = await this.gate(id);
    const target = queryPath(path, 'path');
    const res = await backend.readText(target, await this.fsLimits());
    this.workspaces.touchThrottled(id);
    return { path: target, content: res.content, hash: res.hash, size: res.size };
  }

  /**
   * Starts a browser download: checks the file the same way the download will
   * (so 404/413 surface here, in the IDE) and hands out a one-time URL. The
   * browser then downloads natively, without buffering the file in the page.
   */
  @Post('download-ticket')
  @HttpCode(200)
  async downloadTicket(@Param('id') id: string, @Body() dto: FsPathDto) {
    const { backend } = await this.gate(id);
    const { stream } = await backend.readStream(dto.path, await this.fsLimits());
    stream.destroy();
    const actor = RequestContext.getUser();
    const ticket = this.tickets.issue(
      { workspaceId: id, path: dto.path },
      { userId: actor?.userId ?? null, ...(actor?.apiKeyId ? { apiKeyId: actor.apiKeyId } : {}) },
    );
    return {
      url: `/api/workspaces/${id}/fs/raw?path=${encodeURIComponent(dto.path)}&ticket=${ticket}`,
    };
  }

  /**
   * Download. Normal Bearer auth, or `?ticket=` from `download-ticket` (the
   * guard let the request through only for a valid ticket; here it is used up
   * and the user is re-checked, then the rest runs as that user).
   */
  @Get('raw')
  @AcceptsDownloadTicket()
  async raw(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
    @Query('path') path?: string,
    @Query('ticket') ticket?: string,
  ): Promise<void> {
    const target = queryPath(path, 'path');
    if (ticket === undefined || req.headers.authorization) {
      await this.rawStream(id, target, res);
      return;
    }
    const identity = this.tickets.consume(ticket, { workspaceId: id, path: target });
    if (!identity) throw new UnauthorizedException('Invalid or expired download ticket');
    const actor = await this.downloadActors.resolve(identity);
    await RequestContext.run(actor, undefined, () => this.rawStream(id, target, res));
  }

  private async rawStream(id: string, target: string, res: Response): Promise<void> {
    const { backend } = await this.gate(id);
    const { stream, size } = await backend.readStream(target, await this.fsLimits());
    this.workspaces.touchThrottled(id);
    const name = posix.basename(target) || 'download';
    const ascii = name.replace(/[^\x20-\x7e]|["\\;]/g, '_');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    );
    if (size > 0) res.setHeader('Content-Length', String(size));
    res.on('close', () => { if (!res.writableFinished) stream.destroy(); });
    stream.on('error', () => { if (!res.writableEnded) res.destroy(); });
    stream.pipe(res);
  }

  @Put('file')
  async writeFile(@Param('id') id: string, @Body() dto: FsWriteDto) {
    const { backend } = await this.gate(id);
    const fsLimits = await this.fsLimits();
    const { editorMaxBytes } = fsLimits;
    // Checked here as well as in the sidecar: an over-limit save never travels
    // to the sidecar, and the answer carries the limit in force.
    const bytes = Buffer.byteLength(dto.content, 'utf8');
    if (bytes > editorMaxBytes) {
      throw new HttpException(
        {
          error: `content too large (>${editorMaxBytes} bytes)`,
          message: `content too large (>${editorMaxBytes} bytes)`,
          size: bytes,
          limit: editorMaxBytes,
        },
        413,
      );
    }
    const res = await backend.writeText(
      dto.path,
      dto.content,
      { baseHash: dto.baseHash, force: dto.force === true },
      fsLimits,
    );
    this.workspaces.touchThrottled(id);
    return { hash: res.hash };
  }

  @Post('mkdir')
  @HttpCode(200)
  async mkdir(@Param('id') id: string, @Body() dto: FsPathDto) {
    const { backend } = await this.gate(id);
    const res = await backend.mkdir(dto.path);
    this.workspaces.touchThrottled(id);
    return { path: res.path };
  }

  @Post('move')
  @HttpCode(200)
  async move(@Param('id') id: string, @Body() dto: FsMoveDto) {
    const { ws, backend } = await this.gate(id);
    const res = await backend.move(dto.from, dto.to);
    this.workspaces.touchThrottled(id);
    this.audit(ws, id, `workspace_ide move: ${dto.from} -> ${dto.to}`.slice(0, 500), { from: dto.from, to: dto.to });
    return { from: res.from, to: res.to };
  }

  @Post('delete')
  @HttpCode(204)
  async remove(@Param('id') id: string, @Body() dto: FsPathDto): Promise<void> {
    const { ws, backend } = await this.gate(id);
    try {
      await backend.remove(dto.path);
    } catch (err: unknown) {
      // A failed or timed-out recursive delete may have removed part of the
      // tree (or still be running on an SSH server): it is logged as well.
      const status = err instanceof HttpException ? err.getStatus() : 500;
      this.audit(ws, id, `workspace_ide delete failed (${status}): ${dto.path}`.slice(0, 500), {
        path: dto.path,
        status,
        error: errorMessage(err).slice(0, 500),
      }, 'warn');
      throw err;
    }
    this.workspaces.touchThrottled(id);
    this.audit(ws, id, `workspace_ide delete: ${dto.path}`.slice(0, 500), { path: dto.path });
  }

  @Post('upload')
  @HttpCode(200)
  async upload(
    @Param('id') id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Query('dir') dir?: string,
    @Query('fileName') fileName?: string,
    @Query('overwrite') overwrite?: string,
  ) {
    const { ws, backend } = await this.gate(id);
    const targetDir = queryPath(dir, 'dir', '.');
    const name = plainFileName(fileName);
    const length = /^\d+$/.test(req.headers['content-length'] ?? '') ? Number(req.headers['content-length']) : undefined;
    // Client aborted mid-upload: drop the source so the sidecar discards the partial file.
    res.on('close', () => { if (!res.writableFinished) req.destroy(); });
    const result = await backend.upload(targetDir, name, req, { size: length, overwrite: overwrite === '1' });
    this.workspaces.touchThrottled(id);
    this.audit(ws, id, `workspace_ide upload: ${result.path}`.slice(0, 500), { path: result.path, size: result.size });
    return { path: result.path, size: result.size };
  }

  @Post('search')
  @HttpCode(200)
  async search(@Param('id') id: string, @Body() dto: FsSearchDto) {
    const { backend } = await this.gate(id);
    const res = await backend.search({
      query: dto.query,
      regex: dto.regex === true,
      caseSensitive: dto.caseSensitive === true,
      include: dto.include,
      exclude: dto.exclude,
    });
    this.workspaces.touchThrottled(id);
    return res;
  }

  @Get('status')
  async status(@Param('id') id: string) {
    const { backend } = await this.gate(id);
    const res = await backend.status();
    this.workspaces.touchThrottled(id);
    return res;
  }
}
