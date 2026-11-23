import { ConflictException, NotFoundException } from '@nestjs/common';
import { assertContentWrite } from '../common/scope-guard';
import type { LogsService } from '../logs/logs.service';
import type { WorkspaceDocument } from './schemas/workspace.schema';
import type { WorkspacesService } from './workspaces.service';
import type { WorkspaceFsBackends } from './fs/workspace-fs-backends.service';
import type { WorkspaceFsBackend } from './fs/workspace-fs-backend';
import { isSshWorkspace, type SshWorkspaceAccess } from './ssh-workspace-access.service';
import type { SshConnectionDocument } from '../ssh/schemas/ssh-connection.schema';

export const WORKSPACE_ID_PATTERN = /^[a-f0-9]{24}$/;

export interface WorkspaceFsGateDeps {
  workspaces: Pick<WorkspacesService, 'findById'>;
  backends: Pick<WorkspaceFsBackends, 'for'>;
  /** Only needed for SSH workspaces. */
  sshAccess?: Pick<SshWorkspaceAccess, 'resolve'>;
}

export interface WorkspaceFsGateResult {
  ws: WorkspaceDocument;
  backend: WorkspaceFsBackend;
  /** Set for SSH workspaces: the connection `SshWorkspaceAccess.resolve` returned. */
  connection?: SshConnectionDocument;
}

/**
 * The checks of every IDE file access (the `/fs` routes and the IDE agent's
 * `ws_*` tools): content-write permission -> load workspace under the
 * current actor (403/404) -> must be active (409 `workspace_inactive`) ->
 * SSH: the connection must still exist and be usable by the actor and for
 * the project (409/403) -> file backend (a container gets its directory
 * ensured only here, after every check).
 */
export async function openWorkspaceFs(
  deps: WorkspaceFsGateDeps,
  id: string,
  opts?: { agent?: boolean },
): Promise<WorkspaceFsGateResult> {
  assertContentWrite('Workspace IDE');
  if (!WORKSPACE_ID_PATTERN.test(id)) throw new NotFoundException(`Workspace ${id} not found`);
  const ws = await deps.workspaces.findById(id);
  if (ws.status !== 'active') {
    // `error` is the stable code the IDE classifies on; the text stays as before.
    throw new ConflictException({
      error: 'workspace_inactive',
      message: `Workspace is ${ws.status}, not active`,
    });
  }
  const backendOpts = opts?.agent === true ? { agent: true } : undefined;
  if (isSshWorkspace(ws)) {
    if (!deps.sshAccess) throw new ConflictException('SSH access check unavailable');
    const connection = await deps.sshAccess.resolve(ws);
    return { ws, connection, backend: await deps.backends.for(ws, connection, backendOpts) };
  }
  return { ws, backend: await deps.backends.for(ws, undefined, backendOpts) };
}

/**
 * `workspace_ide` audit log entry (fire-and-forget). Agent actions carry the
 * extra tag `agent` and `metadata.agent: true`.
 */
export function logWorkspaceIde(
  logs: Pick<LogsService, 'create'>,
  ws: Pick<WorkspaceDocument, 'projectId'>,
  id: string,
  message: string,
  metadata: Record<string, unknown>,
  level: 'info' | 'warn' = 'info',
  agent = false,
): void {
  logs
    .create({
      projectId: ws.projectId.toString(),
      level,
      message,
      service: 'workspaces',
      area: 'ide',
      tags: ['workspace_ide', `ws:${id}`, ...(agent ? ['agent'] : [])],
      metadata: { workspaceId: id, ...metadata, ...(agent ? { agent: true } : {}) },
    })
    .catch(() => undefined);
}
