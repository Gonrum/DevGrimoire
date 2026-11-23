import { ConflictException, Injectable } from '@nestjs/common';
import { WorkspaceClient } from '../workspace-client.service';
import type { WorkspaceDocument } from '../schemas/workspace.schema';
import { ContainerFsBackend } from './container-fs-backend';
import type { WorkspaceFsBackend } from './workspace-fs-backend';

const ENSURE_TTL_MS = 60_000;

/** Picks the file backend for a workspace (container sidecar; SSH follows). */
@Injectable()
export class WorkspaceFsBackends {
  /** Workspace id -> time of the last successful `ensureDir`. */
  private readonly ensuredAt = new Map<string, number>();

  constructor(private readonly client: WorkspaceClient) {}

  /**
   * Call only after every permission/status check passed: for a container a
   * workspace without repoUrl has no directory until now, and the sidecar must
   * never create one for an unknown, forbidden or inactive workspace.
   * Failures propagate and are not memoised, so the next request retries.
   */
  async for(ws: WorkspaceDocument): Promise<WorkspaceFsBackend> {
    if (ws.location === 'ssh') {
      throw new ConflictException('SSH workspaces are not available yet');
    }
    const id = ws._id.toString();
    const last = this.ensuredAt.get(id);
    if (last === undefined || Date.now() - last >= ENSURE_TTL_MS) {
      await this.client.ensureDir(id);
      this.ensuredAt.set(id, Date.now());
    }
    return new ContainerFsBackend(this.client, id);
  }
}
