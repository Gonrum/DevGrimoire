import { posix as pathPosix } from 'node:path';
import { WorkspaceDocument } from './schemas/workspace.schema';

export interface McpRootLike {
  uri: string;
  name?: string;
}

export interface WorkspaceRootsGuardOptions {
  /** Relative path inside the workspace, when the operation targets a file/subtree. */
  relativePath?: string;
}

function normalizeWorkspacePath(path: string): string {
  const normalized = pathPosix.normalize(`/${path.replace(/^\/+/, '')}`);
  return normalized.endsWith('/') && normalized !== '/' ? normalized.slice(0, -1) : normalized;
}

function fileUriToPath(uri: string): string | undefined {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'file:') return undefined;
    return normalizeWorkspacePath(decodeURIComponent(parsed.pathname));
  } catch {
    return undefined;
  }
}

function isSameOrChildPath(candidate: string, root: string): boolean {
  const c = normalizeWorkspacePath(candidate);
  const r = normalizeWorkspacePath(root);
  return r === '/' || c === r || c.startsWith(`${r}/`);
}

function isSameOrChildUri(candidate: string, root: string): boolean {
  const c = candidate.replace(/\/+$/, '');
  const r = root.replace(/\/+$/, '');
  return c === r || c.startsWith(`${r}/`);
}

function workspaceTargetPath(ws: WorkspaceDocument, relativePath?: string): string {
  const base = normalizeWorkspacePath(ws.path || `/workspaces/${ws._id.toString()}`);
  if (!relativePath) return base;
  return normalizeWorkspacePath(pathPosix.join(base, relativePath));
}

/**
 * Enforces MCP client roots as an additional workspace boundary.
 *
 * Roots are deliberately restrictive: they can only narrow existing
 * project/API-key/workspace permissions, never expand them. When no roots are
 * available (older clients or stdio setups without the roots capability), this
 * guard is a no-op for backwards compatibility.
 */
export function assertWorkspaceWithinClientRoots(
  ws: WorkspaceDocument,
  roots: McpRootLike[] | undefined,
  options: WorkspaceRootsGuardOptions = {},
): void {
  if (!roots || roots.length === 0) return;

  const targetPath = workspaceTargetPath(ws, options.relativePath);
  const repoUrl = ws.repoUrl?.trim();

  const allowed = roots.some((root) => {
    const rootPath = fileUriToPath(root.uri);
    if (rootPath && isSameOrChildPath(targetPath, rootPath)) return true;
    if (repoUrl && isSameOrChildUri(repoUrl, root.uri)) return true;
    return false;
  });

  if (!allowed) {
    throw new Error(
      'Workspace access blocked by MCP client roots: target is outside the client-declared allowed roots.',
    );
  }
}

export const workspaceRootsGuardTestInternals = {
  normalizeWorkspacePath,
  fileUriToPath,
  isSameOrChildPath,
  workspaceTargetPath,
};
