import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { errorMessage } from '../common/narrow';

const TOKEN_TTL = '1h';
const TOKEN_SUBJECT = 'workspace-cli';

export interface WorkspaceCliClaim {
  workspaceId: string;
  projectId: string;
}

/**
 * Mints and verifies short-lived JWTs that the in-workspace `dg` CLI uses
 * to call the backend's `/internal/dg/*` endpoints. Scope is hard-coded to
 * the workspace's project — no cross-project writes possible.
 *
 * Tokens live 1h. Each `workspace_exec` call refreshes them, so a long
 * agent session never sees an expired token under normal usage.
 */
@Injectable()
export class WorkspaceCliTokenService {
  private readonly logger = new Logger(WorkspaceCliTokenService.name);

  constructor(private readonly jwt: JwtService) {}

  mint(workspaceId: string, projectId: string): string {
    return this.jwt.sign(
      { workspaceId, projectId },
      { subject: TOKEN_SUBJECT, expiresIn: TOKEN_TTL },
    );
  }

  /**
   * Build the DG_* env block for workspace_exec injection. Returns an empty
   * object if auth is disabled (we never mint tokens in dev-only mode where
   * the JWT secret is the placeholder default).
   */
  buildEnvFor(workspaceId: string, projectId: string): Record<string, string> {
    if (!process.env.JWT_SECRET) return {};
    const token = this.mint(workspaceId, projectId);
    return {
      DG_API_URL: process.env.DG_INTERNAL_API_URL || 'http://backend:3000/api/internal/dg',
      DG_API_TOKEN: token,
      DG_WORKSPACE_ID: workspaceId,
      DG_PROJECT_ID: projectId,
    };
  }

  verify(token: string): WorkspaceCliClaim | null {
    try {
      const payload = this.jwt.verify<{
        sub: string;
        workspaceId: string;
        projectId: string;
      }>(token);
      if (payload.sub !== TOKEN_SUBJECT) return null;
      if (typeof payload.workspaceId !== 'string' || typeof payload.projectId !== 'string') {
        return null;
      }
      return { workspaceId: payload.workspaceId, projectId: payload.projectId };
    } catch (err: unknown) {
      this.logger.debug(`dg token verify failed: ${errorMessage(err)}`);
      return null;
    }
  }
}
