import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpException,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UsePipes,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { posix } from 'node:path';
import { WorkspacesService } from './workspaces.service';
import { WorkspaceClient } from './workspace-client.service';
import { WorkspaceDocument } from './schemas/workspace.schema';
import { FsMoveDto, FsPathDto, FsSearchDto, FsWriteDto, isRelativeWorkspacePath } from './dto/workspace-fs.dto';
import { parseGitStatus, parseRipgrepJson } from './workspace-search-parse';
import { LogsService } from '../logs/logs.service';
import { ScalarQueryPipe } from '../common/scalar-query.pipe';
import { assertContentWrite } from '../common/scope-guard';

const SEARCH_LIMIT = 2000;
const WORKSPACE_ID_PATTERN = /^[a-f0-9]{24}$/;
const PATH_MAX = 4096;
const ENSURE_TTL_MS = 60_000;

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
    private readonly client: WorkspaceClient,
    private readonly logs: LogsService,
  ) {}

  /** Workspace id -> time of the last successful `ensureDir`. */
  private readonly ensuredAt = new Map<string, number>();

  /** Permission -> load workspace (403/404) -> must be active. One place for all routes. */
  private async gate(id: string): Promise<WorkspaceDocument> {
    assertContentWrite('Workspace IDE');
    if (!WORKSPACE_ID_PATTERN.test(id)) throw new NotFoundException(`Workspace ${id} not found`);
    const ws = await this.workspaces.findById(id);
    if (ws.status !== 'active') {
      throw new ConflictException(`Workspace is ${ws.status}, not active`);
    }
    // SSH workspaces have no sidecar directory. Until the SSH file backend
    // exists they are refused here — after the permission/status checks and
    // before any sidecar call.
    if (ws.location === 'ssh') {
      throw new ConflictException('SSH workspaces are not available yet');
    }
    // Only after every check passed: the sidecar must never create a
    // directory for an unknown, forbidden or inactive workspace. A workspace
    // without repoUrl has no directory until now. Failures propagate and are
    // not memoised, so the next request retries.
    const last = this.ensuredAt.get(id);
    if (last === undefined || Date.now() - last >= ENSURE_TTL_MS) {
      await this.client.ensureDir(id);
      this.ensuredAt.set(id, Date.now());
    }
    return ws;
  }

  private audit(ws: WorkspaceDocument, id: string, message: string, metadata: Record<string, unknown>): void {
    this.logs
      .create({
        projectId: ws.projectId.toString(),
        level: 'info',
        message,
        service: 'workspaces',
        area: 'ide',
        tags: ['workspace_ide', `ws:${id}`],
        metadata: { workspaceId: id, ...metadata },
      })
      .catch(() => undefined);
  }

  @Get('tree')
  async tree(@Param('id') id: string, @Query('path') path?: string) {
    await this.gate(id);
    const res = await this.client.listDir(id, queryPath(path, 'path', '.'));
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
    await this.gate(id);
    const target = queryPath(path, 'path');
    const res = await this.client.readText(id, target);
    this.workspaces.touchThrottled(id);
    return { path: target, content: res.content, hash: res.hash, size: res.size };
  }

  @Get('raw')
  async raw(@Param('id') id: string, @Res() res: Response, @Query('path') path?: string): Promise<void> {
    await this.gate(id);
    const target = queryPath(path, 'path');
    const { stream, size } = await this.client.readStream(id, target, { httpErrors: true });
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
    await this.gate(id);
    const res = await this.client.writeText(id, dto.path, dto.content, {
      baseHash: dto.baseHash,
      force: dto.force === true,
    });
    this.workspaces.touchThrottled(id);
    return { hash: res.hash };
  }

  @Post('mkdir')
  @HttpCode(200)
  async mkdir(@Param('id') id: string, @Body() dto: FsPathDto) {
    await this.gate(id);
    const res = await this.client.mkdir(id, dto.path);
    this.workspaces.touchThrottled(id);
    return { path: res.path };
  }

  @Post('move')
  @HttpCode(200)
  async move(@Param('id') id: string, @Body() dto: FsMoveDto) {
    const ws = await this.gate(id);
    const res = await this.client.move(id, dto.from, dto.to);
    this.workspaces.touchThrottled(id);
    this.audit(ws, id, `workspace_ide move: ${dto.from} -> ${dto.to}`.slice(0, 500), { from: dto.from, to: dto.to });
    return { from: res.from, to: res.to };
  }

  @Post('delete')
  @HttpCode(204)
  async remove(@Param('id') id: string, @Body() dto: FsPathDto): Promise<void> {
    const ws = await this.gate(id);
    await this.client.remove(id, dto.path);
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
    const ws = await this.gate(id);
    const targetDir = queryPath(dir, 'dir', '.');
    const name = plainFileName(fileName);
    // A trailing slash makes the sidecar treat the path as a directory target.
    const dirTarget = `${targetDir.replace(/\/+$/, '') || '.'}/`;
    const length = /^\d+$/.test(req.headers['content-length'] ?? '') ? Number(req.headers['content-length']) : undefined;
    // Client aborted mid-upload: drop the source so the sidecar discards the partial file.
    res.on('close', () => { if (!res.writableFinished) req.destroy(); });
    const result = await this.client.writeStream(id, dirTarget, req, {
      fileName: name,
      size: length,
      noOverwrite: overwrite !== '1',
      httpErrors: true,
    });
    this.workspaces.touchThrottled(id);
    this.audit(ws, id, `workspace_ide upload: ${result.path}`.slice(0, 500), { path: result.path, size: result.size });
    return { path: result.path, size: result.size };
  }

  @Post('search')
  @HttpCode(200)
  async search(@Param('id') id: string, @Body() dto: FsSearchDto) {
    await this.gate(id);
    const res = await this.client.searchJson(id, {
      query: dto.query,
      fixedStrings: dto.regex !== true,
      caseSensitive: dto.caseSensitive === true,
      include: dto.include,
      exclude: dto.exclude,
    });
    this.workspaces.touchThrottled(id);
    const parsed = parseRipgrepJson(res.matches, SEARCH_LIMIT);
    return { matches: parsed.matches, truncated: parsed.truncated || res.truncated === true };
  }

  @Get('status')
  async status(@Param('id') id: string) {
    await this.gate(id);
    try {
      const res = await this.client.statusFs(id);
      this.workspaces.touchThrottled(id);
      return parseGitStatus(res.status);
    } catch (err: unknown) {
      // The sidecar answers 409 for a workspace without a git repository.
      if (err instanceof HttpException && err.getStatus() === 409) return { branch: null, changed: [] };
      throw err;
    }
  }
}
