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
 * Enforces MCP client roots as an additional workspace boundary, plus a
 * server-side path-traversal guard.
 *
 * Two independent checks:
 *
 * 1. **Escape protection (always on).** The resolved target must stay inside
 *    the workspace base. This is a pure server-side invariant and runs even
 *    when the client has not declared any roots, so older/stdio clients are
 *    still protected against `..` traversal.
 *
 * 2. **Client-roots narrowing.** Workspaces live in a server-owned namespace
 *    (`/workspaces/<id>` on the sidecar volume). MCP clients typically
 *    declare roots that describe THEIR OWN filesystem (e.g. Claude Code on
 *    Windows declaring `file:///D:/Projects/foo`). Such roots speak about a
 *    namespace we do not manage and therefore cannot meaningfully narrow our
 *    workspaces. To avoid blanket-denying every workspace operation, a
 *    `file://` root is only treated as relevant when it shares a hierarchical
 *    relationship with the workspace base. Non-file URI roots are evaluated
 *    against the workspace's `repoUrl`, preserving repo-level narrowing.
 *
 * Roots are deliberately restrictive: when relevant, they can only narrow
 * existing project/API-key/workspace permissions, never expand them. When no
 * relevant root is provided (e.g. only disjoint client-side filesystem roots,
 * or no roots at all), the client has not spoken about this workspace and
 * the guard is a no-op for backwards compatibility.
 */
export function assertWorkspaceWithinClientRoots(
  ws: WorkspaceDocument,
  roots: McpRootLike[] | undefined,
  options: WorkspaceRootsGuardOptions = {},
): void {
  const base = normalizeWorkspacePath(ws.path || `/workspaces/${ws._id.toString()}`);
  const targetPath = workspaceTargetPath(ws, options.relativePath);

  if (!isSameOrChildPath(targetPath, base)) {
    throw new Error(
      'Workspace access blocked: relative path escapes workspace base.',
    );
  }

  if (!roots || roots.length === 0) return;

  const repoUrl = ws.repoUrl?.trim();

  const fileRoots: string[] = [];
  const uriRoots: string[] = [];
  for (const root of roots) {
    const filePath = fileUriToPath(root.uri);
    if (filePath) fileRoots.push(filePath);
    else uriRoots.push(root.uri);
  }

  let pathRootRelevant = false;
  for (const rootPath of fileRoots) {
    const overlaps =
      isSameOrChildPath(base, rootPath) || isSameOrChildPath(rootPath, base);
    if (!overlaps) continue;
    pathRootRelevant = true;
    if (isSameOrChildPath(targetPath, rootPath)) return;
  }

  if (uriRoots.length > 0 && repoUrl) {
    if (uriRoots.some((root) => isSameOrChildUri(repoUrl, root))) return;
  }

  const uriRootsConstrainWorkspace = uriRoots.length > 0 && Boolean(repoUrl);
  if (!pathRootRelevant && !uriRootsConstrainWorkspace) return;

  throw new Error(
    'Workspace access blocked by MCP client roots: target is outside the client-declared allowed roots.',
  );
}

export const workspaceRootsGuardTestInternals = {
  normalizeWorkspacePath,
  fileUriToPath,
  isSameOrChildPath,
  workspaceTargetPath,
};
