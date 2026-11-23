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
import {
  IsBoolean, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min,
} from 'class-validator';
import type { Request } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { WorkspaceCliAuthGuard } from './workspace-cli.guard';
import { WorkspacesService } from './workspaces.service';
import { assertContainerWorkspace } from './container-only';
import { WorkspaceClient } from './workspace-client.service';
import { WorkspaceCliClaim } from './workspace-cli-token.service';
import { SshService, SshConnectionWithInheritance } from '../ssh/ssh.service';
import { SshSessionService } from '../ssh/ssh-session.service';
import { errorMessage } from '../common/narrow';

/** Slug or 24-hex id, like `dg kube --cluster`. */
const CONNECTION_REF = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const OBJECT_ID = /^[a-f0-9]{24}$/i;
/** No NUL and no line breaks — SFTP paths are byte strings, the audit line is not. */
const SAFE_PATH = /^[^\0\r\n]*$/;

class DgSshConnectionRef {
  @IsString() @Matches(CONNECTION_REF)
  connection!: string;
}

class DgScpUploadDto extends DgSshConnectionRef {
  /** Workspace-relative path of the source file. */
  @IsString() @MaxLength(2048) @Matches(SAFE_PATH)
  source!: string;

  /** Empty or ending in `/`: the source's basename is appended. */
  @IsString() @MaxLength(4096) @Matches(SAFE_PATH)
  remotePath!: string;

  @IsOptional() @IsInt() @Min(0) @Max(0o777)
  mode?: number;

  @IsOptional() @IsBoolean()
  createDirs?: boolean;
}

class DgScpDownloadDto extends DgSshConnectionRef {
  @IsString() @MaxLength(4096) @Matches(SAFE_PATH)
  remotePath!: string;

  /** Workspace-relative target; empty, `.` or ending in `/`: a directory. */
  @IsString() @MaxLength(2048) @Matches(SAFE_PATH)
  target!: string;

  @IsOptional() @IsInt() @Min(0) @Max(0o777)
  mode?: number;

  @IsOptional() @IsBoolean()
  createDirs?: boolean;
}

/**
 * Pass SSH-path errors on to `dg` in readable form. The service layer throws
 * plain-text codes (`upload_too_large: …`, `tofu_not_accepted`, …); without
 * this mapping they would arrive as a meaningless 500.
 */
function mapTransferError(err: unknown): never {
  if (err instanceof HttpException) throw err;
  const msg = errorMessage(err);
  if (/^(upload|download)_too_large\b/.test(msg) || /file too large/.test(msg)) {
    throw new PayloadTooLargeException(msg);
  }
  if (/^remote_not_found\b/.test(msg) || /\b404\b.*file not found/.test(msg) || /No such file/i.test(msg)) {
    throw new NotFoundException(msg);
  }
  if (/^remote_not_a_file\b/.test(msg) || /^sidecar 4\d\d /.test(msg)) {
    throw new BadRequestException(msg);
  }
  if (/^(tofu_not_accepted|host_key_mismatch|credential_missing)\b/.test(msg)) {
    throw new ForbiddenException(msg);
  }
  if (/Permission denied/i.test(msg)) {
    throw new ForbiddenException(msg);
  }
  throw new ServiceUnavailableException(msg);
}

/**
 * `dg ssh list` and `dg scp` from the workspace terminal.
 *
 * Credentials stay in the backend — the workspace never sees a key or
 * password, it only names the connection. As with `dg kube`, the token
 * carries no user: `RequestContext` is empty, so `SshService.findById` checks
 * no actor. The only boundary is therefore `resolveConnection()`: the
 * project's own connections only. It must not be removed.
 */
@Controller('internal/dg/ssh')
@Public()
@UseGuards(WorkspaceCliAuthGuard)
export class WorkspaceCliSshController {
  constructor(
    private readonly workspaces: WorkspacesService,
    private readonly workspaceClient: WorkspaceClient,
    private readonly ssh: SshService,
    private readonly sshSession: SshSessionService,
  ) {}

  @Post('list')
  async list(@Req() req: Request) {
    const claim = await this.claim(req);
    const docs = await this.projectConnections(claim.projectId);
    return docs.map((d) => ({
      connectionId: d._id.toString(),
      slug: d.slug,
      label: d.label,
      host: d.host,
      port: d.port,
      username: d.username,
    }));
  }

  /**
   * Only the project's OWN connections, like `dg kube` with its clusters.
   * Connections inherited from a linked customer are customer-scoped: over
   * REST, `canAccessConnection` checks the customer axis, and access to a
   * project does not grant access to its customers' servers. The dg token
   * carries no user, so that check cannot run here — including inherited
   * connections let a user without access to the customer upload to (or
   * download from) the customer's servers.
   */
  private async projectConnections(projectId: string): Promise<SshConnectionWithInheritance[]> {
    const docs = await this.ssh.findByProjectId(projectId);
    return docs.filter((d) => !d.inheritedFromCustomerId);
  }

  @Post('upload')
  async upload(@Req() req: Request, @Body() dto: DgScpUploadDto) {
    const claim = await this.claim(req);
    const conn = await this.resolveConnection(claim, dto.connection);
    const sourceName = posix.basename(dto.source.replace(/\/+$/, ''));
    if (!sourceName || sourceName === '.' || sourceName === '..') {
      throw new BadRequestException('source must name a file');
    }
    const remotePath = !dto.remotePath || dto.remotePath.endsWith('/')
      ? `${dto.remotePath}${sourceName}`
      : dto.remotePath;

    try {
      const { stream, size } = await this.workspaceClient.readStream(claim.workspaceId, dto.source);
      const result = await this.sshSession.sftpUploadStream(conn._id.toString(), remotePath, stream, {
        mode: dto.mode,
        createDirs: dto.createDirs,
        fileNameIfDir: sourceName,
        sourceContext: 'dg',
        workspaceId: claim.workspaceId,
        expectedSize: size || undefined,
      });
      await this.workspaces.touch(claim.workspaceId);
      return {
        direction: 'upload',
        connection: conn.slug,
        source: dto.source,
        remotePath: result.remotePath,
        bytes: result.bytesWritten,
      };
    } catch (err) {
      mapTransferError(err);
    }
  }

  @Post('download')
  async download(@Req() req: Request, @Body() dto: DgScpDownloadDto) {
    const claim = await this.claim(req);
    const conn = await this.resolveConnection(claim, dto.connection);
    const remoteName = posix.basename(dto.remotePath);
    if (!dto.remotePath || dto.remotePath.endsWith('/') || !remoteName || remoteName === '.' || remoteName === '..') {
      throw new BadRequestException('remotePath must name a file (directories are not supported)');
    }
    const target = dto.target || '.';

    try {
      const result = await this.sshSession.sftpDownloadStream(
        conn._id.toString(),
        dto.remotePath,
        (source, size) => this.workspaceClient.writeStream(claim.workspaceId, target, source, {
          fileName: remoteName,
          size,
          mode: dto.mode,
          createDirs: dto.createDirs,
        }),
        { sourceContext: 'dg', workspaceId: claim.workspaceId },
      );
      await this.workspaces.touch(claim.workspaceId);
      return {
        direction: 'download',
        connection: conn.slug,
        remotePath: result.remotePath,
        target: result.sinkResult.path,
        bytes: result.sinkResult.size,
      };
    } catch (err) {
      mapTransferError(err);
    }
  }

  /** As with `dg kube`: a token of a workspace that moved projects may do nothing. */
  private async claim(req: Request): Promise<WorkspaceCliClaim> {
    const claim = req.workspaceCli!;
    const ws = await this.workspaces.findById(claim.workspaceId);
    if (ws.projectId?.toString() !== claim.projectId) {
      throw new ForbiddenException('workspace/project mismatch');
    }
    assertContainerWorkspace(ws);
    return claim;
  }

  /**
   * Connection by slug or id — only from the project's own connections. A
   * foreign connection is "not found", not "forbidden": the response must not
   * reveal that it exists.
   */
  private async resolveConnection(
    claim: WorkspaceCliClaim,
    ref: string,
  ): Promise<SshConnectionWithInheritance> {
    const docs = await this.projectConnections(claim.projectId);
    if (OBJECT_ID.test(ref)) {
      const byId = docs.find((d) => d._id.toString() === ref.toLowerCase());
      if (byId) return byId;
    }
    const bySlug = docs.filter((d) => d.slug === ref);
    if (bySlug.length === 1) return bySlug[0];
    if (bySlug.length > 1) {
      throw new BadRequestException(
        `Mehrdeutig: "${ref}" gibt es mehrfach, bitte die Id angeben (dg ssh list): ${bySlug.map((d) => d._id.toString()).join(', ')}`,
      );
    }
    throw new NotFoundException(`SSH-Verbindung "${ref}" nicht gefunden (dg ssh list zeigt die verfügbaren)`);
  }
}
