import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { AuthRequest } from '../../common/request-context';

/**
 * Requires an actor whose project AND customer scope is unrestricted.
 *
 * For controllers whose effect is instance-wide by nature, where the admin
 * role alone is not enough: an admin may deliberately hold a key narrowed to
 * one project, and that key keeps the admin role. Without this guard such a
 * key could, for example, pull the raw documents of every replicated project.
 *
 * Runs after the global `JwtAuthGuard`, so `request.user` is populated.
 */
@Injectable()
export class UnrestrictedScopeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const actor = request.user;
    // No actor only happens with authentication disabled — the global guard
    // already allowed everything in that mode.
    if (!actor) return true;
    const proj = actor.projectScopeMode ?? 'all';
    const cust = actor.customerScopeMode ?? 'all';
    if (proj !== 'all' || cust !== 'all') {
      throw new ForbiddenException('This endpoint requires unrestricted project and customer scope');
    }
    return true;
  }
}
