import { ConflictException } from '@nestjs/common';
import { isSshWorkspace } from './ssh-workspace-access.service';
import type { WorkspaceDocument } from './schemas/workspace.schema';

type NamedWorkspace = Pick<WorkspaceDocument, 'location' | 'name'>;

/**
 * Guard for every code path that talks to the workspace sidecar (container).
 * SSH workspaces have no sidecar directory; letting a tool run there would
 * silently operate on an empty container dir. Existing documents without a
 * `location` field count as container workspaces.
 */
export function assertContainerWorkspace(ws: NamedWorkspace, connectionSlug?: string): void {
  if (!isSshWorkspace(ws)) return;
  throw new ConflictException(
    `SSH-Werkstatt "${ws.name}": dieses Werkzeug arbeitet nur mit Container-Werkstätten; nutze die ssh_*-Tools` +
      (connectionSlug ? ` mit Verbindung "${connectionSlug}"` : ''),
  );
}

/**
 * Same guard, but names the connection slug in the message when it can be
 * resolved. A failing lookup (connection deleted, no access) only omits the
 * slug — it never replaces the 409 with another error.
 */
export async function assertContainerWorkspaceWithSlug(
  ws: NamedWorkspace & Pick<WorkspaceDocument, 'sshConnectionId'>,
  lookup?: (connectionId: string) => Promise<{ slug?: string } | null | undefined>,
): Promise<void> {
  if (!isSshWorkspace(ws)) return;
  let slug: string | undefined;
  if (lookup && ws.sshConnectionId) {
    try {
      slug = (await lookup(String(ws.sshConnectionId)))?.slug || undefined;
    } catch {
      slug = undefined;
    }
  }
  assertContainerWorkspace(ws, slug);
}
