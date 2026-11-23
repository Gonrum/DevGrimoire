import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { SshService } from '../ssh/ssh.service';
import { SshConnectionDocument } from '../ssh/schemas/ssh-connection.schema';
import { assertConnectionAccess } from '../ssh/ssh-access.guard';
import { RequestContext } from '../common/request-context';
import type { WorkspaceDocument } from './schemas/workspace.schema';

const USABLE_TTL_MS = 60_000;

export function isSshWorkspace(ws: { location?: string } | null | undefined): boolean {
  return ws?.location === 'ssh';
}

interface UsableEntry {
  ids: Set<string>;
  at: number;
}

/**
 * Per-request access resolution for SSH workspaces: the connection must still
 * exist, the actor must be allowed to use it, and it must still be usable for
 * the workspace's project (own or inherited customer connection). The
 * project-level result is cached for at most 60 s, per project, user and API
 * key (the connection list is filtered by the actor's scope, and two keys of
 * one user can have different scopes); the actor check itself runs on every
 * call.
 */
@Injectable()
export class SshWorkspaceAccess {
  private readonly usable = new Map<string, UsableEntry>();

  constructor(private readonly ssh: SshService) {}

  resolve(
    ws: Pick<WorkspaceDocument, 'projectId' | 'sshConnectionId'>,
  ): Promise<SshConnectionDocument> {
    return this.assertUsable(String(ws.sshConnectionId), String(ws.projectId));
  }

  async assertUsable(connectionId: string, projectId: string): Promise<SshConnectionDocument> {
    if (!Types.ObjectId.isValid(connectionId) || !Types.ObjectId.isValid(projectId)) {
      throw new ConflictException('SSH-Verbindung dieser Werkstatt existiert nicht mehr');
    }
    let connection: SshConnectionDocument;
    try {
      // Also enforces the actor's scope (403) when an actor is present.
      connection = await this.ssh.findById(connectionId);
    } catch (err: unknown) {
      if (err instanceof NotFoundException) {
        throw new ConflictException('SSH-Verbindung dieser Werkstatt existiert nicht mehr');
      }
      throw err;
    }
    const actor = RequestContext.getUser();
    if (actor) assertConnectionAccess(connection, actor);

    const ids = await this.usableIds(projectId, actor?.userId, actor?.apiKeyId);
    if (!ids.has(String(connection._id))) {
      throw new ConflictException(
        'SSH-Verbindung ist für das Projekt dieser Werkstatt nicht mehr nutzbar '
          + '(Kundenverknüpfung gelöst oder Verbindung einem anderen Projekt zugeordnet)',
      );
    }
    return connection;
  }

  /**
   * Drops all cached project results (a connection or link changed). Not per
   * connection: a new link can make a connection usable for projects whose
   * entry did not contain it.
   */
  invalidate(): void {
    this.usable.clear();
  }

  private async usableIds(
    projectId: string,
    userId: string | undefined,
    apiKeyId: string | undefined,
  ): Promise<Set<string>> {
    const key = `${projectId}:${userId ?? ''}:${apiKeyId ?? ''}`;
    const hit = this.usable.get(key);
    if (hit && Date.now() - hit.at < USABLE_TTL_MS) return hit.ids;
    const list = await this.ssh.findByProjectId(projectId);
    const ids = new Set(list.map((c) => String(c._id)));
    this.usable.set(key, { ids, at: Date.now() });
    return ids;
  }
}
