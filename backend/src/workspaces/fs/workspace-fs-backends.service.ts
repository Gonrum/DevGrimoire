import { ConflictException, HttpException, Injectable, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { WorkspaceClient } from '../workspace-client.service';
import type { WorkspaceDocument } from '../schemas/workspace.schema';
import { SshWorkspaceAccess, isSshWorkspace } from '../ssh-workspace-access.service';
import { WorkspacesService } from '../workspaces.service';
import { SshSessionService } from '../../ssh/ssh-session.service';
import type { SshConnectionDocument } from '../../ssh/schemas/ssh-connection.schema';
import type { SshAuditAction } from '../../ssh/schemas/ssh-audit.schema';
import { RequestContext } from '../../common/request-context';
import { errorMessage } from '../../common/narrow';
import { ContainerFsBackend } from './container-fs-backend';
import { SshFsBackend } from './ssh-fs-backend';
import type { SshFsRun } from './ssh-fs-backend';
import { SshWorkspaceSessions } from './ssh-workspace-sessions.service';
import { isRemoteError } from './remote-session';
import type { WorkspaceFsBackend } from './workspace-fs-backend';

const ENSURE_TTL_MS = 60_000;

/** Picks the file backend for a workspace: container sidecar or SSH (SFTP). */
@Injectable()
export class WorkspaceFsBackends implements OnModuleInit {
  /** Workspace id -> time of the last successful `ensureDir`. */
  private readonly ensuredAt = new Map<string, number>();

  constructor(
    private readonly client: WorkspaceClient,
    private readonly sessions: SshWorkspaceSessions,
    private readonly connector: SshSessionService,
    private readonly access: SshWorkspaceAccess,
    private readonly workspaces: WorkspacesService,
  ) {}

  /** Registers the "directory exists" check used when an SSH workspace is created. */
  onModuleInit(): void {
    this.workspaces.verifyRemoteDir = (connection, remotePath) => this.verifyRemoteDir(connection, remotePath);
  }

  /**
   * Call only after every permission/status check passed: for a container a
   * workspace without repoUrl has no directory until now, and the sidecar must
   * never create one for an unknown, forbidden or inactive workspace.
   * Failures propagate and are not memoised, so the next request retries.
   *
   * SSH: `connection` is what `SshWorkspaceAccess.resolve` returned in the
   * gate; without it the access check runs here.
   */
  async for(ws: WorkspaceDocument, connection?: SshConnectionDocument): Promise<WorkspaceFsBackend> {
    if (isSshWorkspace(ws)) return this.forSsh(ws, connection ?? (await this.access.resolve(ws)));
    const id = ws._id.toString();
    const last = this.ensuredAt.get(id);
    if (last === undefined || Date.now() - last >= ENSURE_TTL_MS) {
      await this.client.ensureDir(id);
      this.ensuredAt.set(id, Date.now());
    }
    return new ContainerFsBackend(this.client, id);
  }

  private async forSsh(ws: WorkspaceDocument, connection: SshConnectionDocument): Promise<WorkspaceFsBackend> {
    const root = ws.remotePath;
    if (!root) throw new ConflictException('SSH-Werkstatt ohne Verzeichnis (remotePath fehlt)');
    const workspaceId = ws._id.toString();
    const connectionId = String(connection._id);
    // Captured in the request: audit rows name the user who caused them.
    const userId = RequestContext.getUser()?.userId;
    const audit = (
      action: SshAuditAction,
      remotePath: string,
      extra?: { bytes?: number; errorMsg?: string },
    ): void => {
      void this.connector.writeAudit({
        connectionId: connection._id,
        action,
        sourceContext: 'ide',
        userId,
        workspaceId,
        remotePath,
        ...(extra?.bytes !== undefined ? { bytes: extra.bytes } : {}),
        ...(extra?.errorMsg !== undefined ? { errorMsg: extra.errorMsg } : {}),
      });
    };
    const run: SshFsRun = (fn, opts) =>
      this.sessions.withSession(workspaceId, connectionId, fn, {
        retryable: opts?.retryable === true,
        onConnect: () => audit('connect', root),
      });
    const uploadMaxBytes = await this.connector.resolveUploadLimit(connection);
    return new SshFsBackend(root, run, audit, { uploadMaxBytes });
  }

  /**
   * Creating an SSH workspace (spec "Anlegen" 5): `remotePath` must exist and
   * be a directory; it is never created. Runs on a throw-away session key so
   * nothing stays open for a workspace that may never be created.
   */
  async verifyRemoteDir(connection: SshConnectionDocument, remotePath: string): Promise<void> {
    const key = `verify:${randomUUID()}`;
    const label = connection.label;
    try {
      const st = await this.sessions.withSession(key, String(connection._id), (s) => s.fs.stat(remotePath), {
        retryable: true,
      });
      if (!st.isDirectory) {
        throw new HttpException(
          { error: 'not_a_directory', message: `${remotePath} auf ${label} ist kein Verzeichnis` },
          400,
        );
      }
    } catch (err: unknown) {
      if (err instanceof HttpException) throw err;
      if (isRemoteError(err)) {
        if (err.code === 'not_found') {
          throw new HttpException(
            { error: 'directory_missing', message: `Verzeichnis ${remotePath} existiert auf ${label} nicht` },
            400,
          );
        }
        if (err.code === 'denied') {
          throw new HttpException(
            { error: 'denied', message: `Verzeichnis ${remotePath} auf ${label}: keine Berechtigung` },
            400,
          );
        }
        if (err.code === 'timeout') {
          throw new HttpException(
            { error: 'timeout', message: `SSH-Verbindung "${label}": Zeitüberschreitung beim Prüfen von ${remotePath}` },
            504,
          );
        }
      }
      throw new HttpException(
        { error: 'verify_failed', message: `SSH-Verbindung "${label}": ${remotePath} nicht prüfbar (${errorMessage(err)})` },
        502,
      );
    } finally {
      this.sessions.drop(key);
    }
  }
}
