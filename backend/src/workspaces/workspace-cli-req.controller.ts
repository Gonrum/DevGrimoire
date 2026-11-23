import { posix } from 'node:path';
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpException,
  NotFoundException,
  PayloadTooLargeException,
  Post,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { IsBoolean, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import type { Request } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { WorkspaceCliAuthGuard } from './workspace-cli.guard';
import { WorkspacesService } from './workspaces.service';
import { assertContainerWorkspace } from './container-only';
import { WorkspaceClient } from './workspace-client.service';
import { WorkspaceCliClaim } from './workspace-cli-token.service';
import { HttpRequestsService } from '../http-requests/http-requests.service';
import { EnvironmentsService } from '../environments/environments.service';
import { SavedRequestDocument } from '../http-requests/schemas/saved-request.schema';
import { RequestCollectionDocument } from '../http-requests/schemas/request-collection.schema';
import { EnvironmentDocument } from '../environments/schemas/environment.schema';
import { errorMessage } from '../common/narrow';

const OBJECT_ID = /^[a-f0-9]{24}$/i;
/** Names are free text; only control characters are rejected. */
const SAFE_REF = /^\P{Cc}+$/u;
const SAFE_PATH = /^[^\0\r\n]*$/;

class DgReqListDto {
  /** Collection name or id; omitted lists every collection of the project. */
  @IsOptional() @IsString() @MaxLength(300) @Matches(SAFE_REF)
  collection?: string;
}

class DgReqRefDto {
  /** Request id, `name`, or `collection/name`. */
  @IsString() @MaxLength(600) @Matches(SAFE_REF)
  request!: string;
}

class DgReqSendDto extends DgReqRefDto {
  /** Environment name or id — only environments of the project itself. */
  @IsOptional() @IsString() @MaxLength(300) @Matches(SAFE_REF)
  environment?: string;

  /** Workspace-relative target file: the body is streamed there instead of returned. */
  @IsOptional() @IsString() @MaxLength(2048) @Matches(SAFE_PATH)
  output?: string;

  @IsOptional() @IsBoolean()
  createDirs?: boolean;
}

class DgReqHistoryDto extends DgReqRefDto {
  @IsOptional() @IsInt() @Min(1) @Max(100)
  limit?: number;
}

function mapStreamError(err: unknown): never {
  if (err instanceof HttpException) throw err;
  const msg = errorMessage(err);
  if (/too large|max_bytes|maxBytes/i.test(msg)) throw new PayloadTooLargeException(msg);
  if (/^sidecar 4\d\d /.test(msg)) throw new BadRequestException(msg);
  throw new ServiceUnavailableException(msg);
}

/**
 * `dg req` — saved requests of the API workbench from the workspace terminal.
 *
 * The backend sends the request, so templates and secrets are resolved
 * server-side and never reach the workspace. Output to the terminal comes
 * from the history entry, i.e. with secret values masked, exactly as the
 * workbench's history shows it.
 *
 * As with `dg ssh`, the token carries no user: `RequestContext` is empty and
 * `HttpRequestsService` / `EnvironmentsService` check no actor. The only
 * boundary is the resolution below — requests and environments of the
 * token's project only. Customer-bound environments are excluded for the
 * same reason as inherited SSH connections: the customer axis cannot be
 * checked without a user. Neither check may be removed.
 */
@Controller('internal/dg/req')
@Public()
@UseGuards(WorkspaceCliAuthGuard)
export class WorkspaceCliReqController {
  constructor(
    private readonly workspaces: WorkspacesService,
    private readonly workspaceClient: WorkspaceClient,
    private readonly requests: HttpRequestsService,
    private readonly environments: EnvironmentsService,
  ) {}

  @Post('list')
  async list(@Req() req: Request, @Body() dto: DgReqListDto) {
    const claim = await this.claim(req);
    let collections = await this.requests.listCollections(claim.projectId);
    if (dto.collection) {
      collections = [pickOne(collections, dto.collection, (c) => c.name, 'Collection', 'dg req list')];
    }
    const wanted = new Set(collections.map((c) => c._id.toString()));
    const reqs = (await this.ownRequests(claim.projectId))
      .filter((r) => wanted.has(r.collectionId?.toString()));
    const envs = await this.projectEnvironments(claim.projectId);
    return {
      collections: collections.map((c) => ({
        collectionId: c._id.toString(),
        name: c.name,
        requests: reqs
          .filter((r) => r.collectionId?.toString() === c._id.toString())
          // Deliberately no auth/headers/body: the saved auth is plaintext.
          .map((r) => ({ requestId: r._id.toString(), name: r.name, method: r.method, url: r.url })),
      })),
      environments: envs.map((e) => ({ environmentId: e._id.toString(), name: e.name })),
    };
  }

  @Post('send')
  async send(@Req() req: Request, @Body() dto: DgReqSendDto) {
    const claim = await this.claim(req);
    const saved = await this.resolveRequest(claim.projectId, dto.request);
    const env = dto.environment ? await this.resolveEnvironment(claim.projectId, dto.environment) : undefined;
    const environmentId = env?._id.toString();

    if (dto.output !== undefined) {
      const result = await this.download(claim, saved, environmentId, dto.output, dto.createDirs);
      await this.workspaces.touch(claim.workspaceId);
      return result;
    }

    const result = await this.requests.send(saved._id.toString(), { environmentId });
    await this.workspaces.touch(claim.workspaceId);
    // The live result carries the UNMASKED body; the history entry is the
    // masked copy of the same response.
    const entry = await this.requests.getHistoryEntry(result.historyId);
    return {
      request: saved.name,
      method: entry.method,
      url: entry.url,
      environment: entry.environmentName,
      ok: entry.ok,
      status: entry.status,
      statusText: entry.statusText,
      durationMs: entry.durationMs,
      contentType: entry.contentType,
      responseHeaders: entry.responseHeaders.map((h) => ({ name: h.name, value: h.value })),
      body: entry.bodyText,
      truncated: entry.truncated,
      bodySize: entry.bodySize,
      error: entry.error,
      unresolvedVariables: result.unresolvedVariables,
      historyId: result.historyId,
    };
  }

  @Post('history')
  async history(@Req() req: Request, @Body() dto: DgReqHistoryDto) {
    const claim = await this.claim(req);
    const saved = await this.resolveRequest(claim.projectId, dto.request);
    const entries = await this.requests.listHistory(saved._id.toString(), dto.limit ?? 10);
    return entries.map((e) => ({
      historyId: e._id.toString(),
      sentAt: e.sentAt,
      method: e.method,
      url: e.url,
      environment: e.environmentName,
      ok: e.ok,
      status: e.status,
      durationMs: e.durationMs,
      bodySize: e.bodySize,
      error: e.error,
    }));
  }

  /**
   * `-o file`: stream the raw body into the workspace (binary-safe, no 1 MB
   * cap). Not recorded in the history — same as the workbench's download
   * button. A non-2xx response writes no file.
   */
  private async download(
    claim: WorkspaceCliClaim,
    saved: SavedRequestDocument,
    environmentId: string | undefined,
    output: string,
    createDirs: boolean | undefined,
  ) {
    const started = Date.now();
    let opened: Awaited<ReturnType<HttpRequestsService['openStream']>>;
    try {
      opened = await this.requests.openStream(saved._id.toString(), { environmentId });
    } catch (err) {
      if (err instanceof HttpException) throw err;
      throw new ServiceUnavailableException(`request failed: ${errorMessage(err)}`);
    }
    const { upstream, body, filename } = opened;
    if (!upstream.ok || !body) {
      // The error body is not shown: unlike the history copy it is unmasked.
      body?.destroy();
      return {
        request: saved.name,
        ok: false,
        status: upstream.status,
        statusText: upstream.statusText,
        durationMs: Date.now() - started,
        error: 'no file written (dg req send without -o shows the masked response)',
      };
    }
    // No `size`: fetch decodes gzip/br, so Content-Length (when present at
    // all) describes the encoded bytes, not what reaches the file.
    try {
      const written = await this.workspaceClient.writeStream(claim.workspaceId, output || '.', body, {
        fileName: posix.basename(filename) || 'download',
        createDirs,
      });
      return {
        request: saved.name,
        ok: true,
        status: upstream.status,
        statusText: upstream.statusText,
        durationMs: Date.now() - started,
        contentType: upstream.headers.get('content-type') ?? undefined,
        output: written.path,
        bytes: written.size,
      };
    } catch (err) {
      mapStreamError(err);
    }
  }

  /** Re-checks the project on every document: the service filters nothing without an actor. */
  private async ownRequests(projectId: string): Promise<SavedRequestDocument[]> {
    const reqs = await this.requests.listRequests({ projectId });
    return reqs.filter((r) => r.projectId?.toString() === projectId);
  }

  /** Only environments owned by the project itself (see class comment). */
  private async projectEnvironments(projectId: string): Promise<EnvironmentDocument[]> {
    const envs = await this.environments.findByProject(projectId);
    return envs.filter((e) => e.projectId?.toString() === projectId);
  }

  private async resolveEnvironment(projectId: string, ref: string): Promise<EnvironmentDocument> {
    const envs = await this.projectEnvironments(projectId);
    return pickOne(envs, ref, (e) => e.name, 'Environment', 'dg req list');
  }

  /**
   * Request by id, `name` or `collection/name`. Unknown and foreign ids are
   * both "not found": the answer must not reveal that a request exists.
   */
  private async resolveRequest(projectId: string, ref: string): Promise<SavedRequestDocument> {
    const own = await this.ownRequests(projectId);
    if (OBJECT_ID.test(ref)) {
      const byId = own.find((r) => r._id.toString() === ref.toLowerCase());
      if (byId) return byId;
    }
    const slash = ref.indexOf('/');
    if (slash > 0) {
      const collections = await this.requests.listCollections(projectId);
      const colName = ref.slice(0, slash).trim();
      const reqName = ref.slice(slash + 1).trim();
      const cols = matchName(collections, colName, (c: RequestCollectionDocument) => c.name);
      if (cols.length === 1) {
        const colId = cols[0]._id.toString();
        const inCol = own.filter((r) => r.collectionId?.toString() === colId);
        const hits = matchName(inCol, reqName, (r) => r.name);
        if (hits.length === 1) return hits[0];
      }
      // A request name may itself contain "/": fall through to a plain lookup.
    }
    return pickOne(own, ref, (r) => r.name, 'Request', 'dg req list');
  }

  /** As with `dg ssh`: a token of a workspace that moved projects may do nothing. */
  private async claim(req: Request): Promise<WorkspaceCliClaim> {
    const claim = req.workspaceCli!;
    const ws = await this.workspaces.findById(claim.workspaceId);
    if (ws.projectId?.toString() !== claim.projectId) {
      throw new ForbiddenException('workspace/project mismatch');
    }
    assertContainerWorkspace(ws);
    return claim;
  }
}

/** Exact name first, then case-insensitive — never a prefix or fuzzy match. */
function matchName<T>(items: T[], name: string, nameOf: (item: T) => string): T[] {
  const exact = items.filter((i) => nameOf(i) === name);
  if (exact.length) return exact;
  const lower = name.toLowerCase();
  return items.filter((i) => (nameOf(i) ?? '').toLowerCase() === lower);
}

function pickOne<T extends { _id: { toString(): string } }>(
  items: T[],
  ref: string,
  nameOf: (item: T) => string,
  what: string,
  hint: string,
): T {
  if (OBJECT_ID.test(ref)) {
    const byId = items.find((i) => i._id.toString() === ref.toLowerCase());
    if (byId) return byId;
  }
  const hits = matchName(items, ref, nameOf);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    throw new BadRequestException(
      `Mehrdeutig: ${what} "${ref}" gibt es mehrfach, bitte die Id oder collection/name angeben (${hint}): ${hits.map((h) => h._id.toString()).join(', ')}`,
    );
  }
  throw new NotFoundException(`${what} "${ref}" nicht gefunden (${hint} zeigt die verfügbaren)`);
}
