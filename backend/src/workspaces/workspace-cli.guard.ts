import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { WorkspaceCliClaim, WorkspaceCliTokenService } from './workspace-cli-token.service';

declare module 'express-serve-static-core' {
  interface Request {
    workspaceCli?: WorkspaceCliClaim;
  }
}

/**
 * Validates the dg-CLI bearer token on `/internal/dg/*` endpoints. The
 * controller is decorated with `@Public()` to bypass JwtAuthGuard, then this
 * guard runs and populates `req.workspaceCli` with the verified claim. All
 * write operations downstream MUST scope to `req.workspaceCli.projectId` —
 * the token authorises only that project.
 */
@Injectable()
export class WorkspaceCliAuthGuard implements CanActivate {
  constructor(private readonly tokenService: WorkspaceCliTokenService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      throw new UnauthorizedException('dg-CLI token required (Bearer header)');
    }
    const token = auth.slice(7);
    const claim = this.tokenService.verify(token);
    if (!claim) {
      throw new UnauthorizedException('invalid or expired dg-CLI token');
    }
    req.workspaceCli = claim;
    return true;
  }
}
