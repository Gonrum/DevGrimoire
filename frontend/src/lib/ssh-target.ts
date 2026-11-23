import type { Workspace } from '../api/client';

/** `user@host[:port]:/path` — the port only shows when it is not the default. */
export function sshTarget(ws: Pick<Workspace, 'ssh' | 'remotePath'>): string {
  const ssh = ws.ssh;
  if (!ssh) return ws.remotePath ?? '';
  const port = ssh.port === 22 ? '' : `:${ssh.port}`;
  return `${ssh.username}@${ssh.host}${port}:${ws.remotePath ?? ''}`;
}
