import type { WorkspaceDocument } from './schemas/workspace.schema';
import type { WorkspaceCliTokenService } from './workspace-cli-token.service';
import type { WorkspaceGitTokensService } from './workspace-git-tokens.service';

/**
 * Env for a command in a container workspace, as `workspace_exec` and the
 * terminal stream pass it to the sidecar: GH_TOKEN/GITLAB_TOKEN/GITLAB_HOST
 * (and Gitea) from the project's git repositories, so `gh`/`glab` work
 * without a manual login, plus DG_* so the in-workspace `dg` CLI reaches the
 * backend with a project-scoped token (T-168). Caller env wins. `undefined`
 * when there is nothing to pass. Both services refuse SSH workspaces: no
 * DevGrimoire credentials go to a remote server.
 */
export async function buildWorkspaceExecEnv(
  gitTokens: Pick<WorkspaceGitTokensService, 'resolveForWorkspace'>,
  cliToken: Pick<WorkspaceCliTokenService, 'buildEnvFor'>,
  ws: WorkspaceDocument,
  callerEnv?: Record<string, string>,
): Promise<Record<string, string> | undefined> {
  const gitEnv = await gitTokens.resolveForWorkspace(ws);
  const dgEnv = cliToken.buildEnvFor(ws);
  return Object.keys(gitEnv).length || Object.keys(dgEnv).length || callerEnv
    ? { ...gitEnv, ...dgEnv, ...(callerEnv ?? {}) }
    : undefined;
}
