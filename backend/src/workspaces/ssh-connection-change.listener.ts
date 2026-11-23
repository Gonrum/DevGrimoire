import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { isRecord } from '../common/narrow';
import { SSH_CONNECTION_CHANGED } from '../ssh/ssh-events';
import { SshWorkspaceAccess } from './ssh-workspace-access.service';
import { SshWorkspaceSessions } from './fs/ssh-workspace-sessions.service';

/**
 * Drops held workspace sessions and cached access results when a connection
 * changes. Event-based so SshModule needs no import of WorkspacesModule.
 */
@Injectable()
export class SshConnectionChangeListener {
  constructor(
    private readonly sessions: SshWorkspaceSessions,
    private readonly access: SshWorkspaceAccess,
  ) {}

  @OnEvent(SSH_CONNECTION_CHANGED)
  onConnectionChanged(payload: unknown): void {
    const id = isRecord(payload) && typeof payload.connectionId === 'string'
      ? payload.connectionId
      : undefined;
    if (id) this.sessions.dropByConnection(id);
    this.access.invalidate(id);
  }
}
