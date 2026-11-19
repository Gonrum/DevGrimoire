import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { ADMIN_PERMISSION_KEY } from '../decorators/permission-gate.decorator';
import { actorMay, Permission, PermissionId } from '../../common/permissions';
import { UserRole } from '../schemas/user.schema';
import type { AuthRequest } from '../../common/request-context';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredRoles) return true;

    const { user } = context.switchToHttp().getRequest<AuthRequest>();
    if (!user?.role) return false;
    // `RequestUser.role` ist ein `string` (er kommt aus JWT bzw. DB, nicht aus
    // dem TS-Enum), `requiredRoles` ist `UserRole[]`. Die Zuweisung auf
    // `string[]` ist eine Verbreiterung — keine Behauptung — und lässt den
    // `includes`-Vergleich unverändert: gleiche Werte, gleiche Semantik.
    const allowedRoles: string[] = requiredRoles;
    if (!allowedRoles.includes(user.role)) return false;
    // An admin holding a permission allowlist only reaches admin routes whose
    // `admin:*` permission is on that list; `actorMay` is a no-op for admins
    // without a list.
    if (requiredRoles.every((r) => r === UserRole.ADMIN)) {
      const perm = this.reflector.getAllAndOverride<PermissionId | undefined>(ADMIN_PERMISSION_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? Permission.ADMIN_SETTINGS_MANAGE;
      if (!actorMay(user, perm)) return false;
    }
    return true;
  }
}
