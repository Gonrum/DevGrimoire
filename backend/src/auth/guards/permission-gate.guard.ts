import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSION_GATE_KEY } from '../decorators/permission-gate.decorator';
import { httpAccessClass } from '../../common/permission-gate';
import { actorMayWriteContent } from '../../common/scope-guard';
import { Permission } from '../../common/permissions';
import type { AuthRequest } from '../../common/request-context';

/**
 * Enforces `project:write` / `customer:write` for content writes by actors
 * with a permission allowlist. Without it a key limited to
 * `project:todo:read` could still create milestones, run workflows or execute
 * SSH commands — the allowlist would only cover the handful of catalog
 * resources. Catalog resources (`@PermissionGate('service')`) are checked
 * precisely in their services instead.
 */
@Injectable()
export class PermissionGateGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const request = context.switchToHttp().getRequest<AuthRequest & { method?: string }>();
    const gate = this.reflector.getAllAndOverride<'service' | 'write' | undefined>(PERMISSION_GATE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const cls = httpAccessClass(request.method ?? 'GET', gate);
    if (cls !== 'write') return true;
    if (!actorMayWriteContent(request.user)) {
      throw new ForbiddenException(
        `This request requires the permission ${Permission.PROJECT_WRITE} or ${Permission.CUSTOMER_WRITE}`,
      );
    }
    return true;
  }
}
