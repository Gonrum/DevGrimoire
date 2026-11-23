/**
 * Emitted when an SSH connection's host, user, credentials or fingerprint may
 * have changed, or the connection was deleted. Holders of long-lived sessions
 * (SSH workspaces) drop them. Not emitted for status stamps such as
 * `recordConnectSuccess`, which every connect writes.
 */
export const SSH_CONNECTION_CHANGED = 'ssh.connection.changed';

export interface SshConnectionChangedEvent {
  connectionId: string;
}
