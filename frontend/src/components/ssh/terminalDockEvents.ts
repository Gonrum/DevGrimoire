import { SshConnectionListItem, Workspace } from '../../api/client';

/** What a dock tab is attached to: a remote host via SSH, or a workspace's bash. */
export type DockSource =
  | { kind: 'ssh'; connection: SshConnectionListItem }
  | { kind: 'workspace'; workspace: Workspace };

const OPEN_EVENT = 'dg:terminal-dock:open';

/**
 * Opens a new session tab in the floating terminal dock (`SshDock`), which
 * is mounted once in `App`. Pages use this instead of rendering their own
 * terminal modal, so every terminal lives in the same dock and survives
 * navigation.
 */
export function openInTerminalDock(source: DockSource): void {
  window.dispatchEvent(new CustomEvent<DockSource>(OPEN_EVENT, { detail: source }));
}

/** Subscribes the dock to open requests; returns the unsubscribe function. */
export function onTerminalDockOpen(handler: (source: DockSource) => void): () => void {
  const listener = (event: Event) => {
    if (event instanceof CustomEvent && isDockSource(event.detail)) handler(event.detail);
  };
  window.addEventListener(OPEN_EVENT, listener);
  return () => window.removeEventListener(OPEN_EVENT, listener);
}

function isDockSource(value: unknown): value is DockSource {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return false;
  if (value.kind === 'ssh') return 'connection' in value && typeof value.connection === 'object' && value.connection !== null;
  if (value.kind === 'workspace') return 'workspace' in value && typeof value.workspace === 'object' && value.workspace !== null;
  return false;
}
