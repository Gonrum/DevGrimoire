import { ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AuthService } from '../auth.service';
import { ApiKeysService } from '../../api-keys/api-keys.service';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(
    private reflector: Reflector,
    private authService: AuthService,
    private apiKeysService: ApiKeysService,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext) {
    // Auth disabled → allow everything
    if (!this.authService.isAuthEnabled()) {
      return true;
    }

    // Public routes → allow
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();

    // API Key auth: Bearer cv_... header or ?apiKey= query param
    const authHeader = request.headers.authorization;
    const apiKeyFromQuery = request.query?.apiKey;
    let apiKeyPlain: string | undefined;

    if (authHeader?.startsWith('Bearer cv_')) {
      apiKeyPlain = authHeader.slice(7);
    } else if (typeof apiKeyFromQuery === 'string' && apiKeyFromQuery.startsWith('cv_')) {
      apiKeyPlain = apiKeyFromQuery;
    }

    if (apiKeyPlain) {
      const validated = await this.apiKeysService.validate(apiKeyPlain);
      if (!validated) {
        throw new UnauthorizedException('Invalid or expired API key');
      }
      // Inherit role from the owning user so @Roles()-guarded endpoints
      // (e.g. replication admin routes) work with API-key auth.
      const owner = await this.authService.findUserById(validated.userId.toString());
      if (!owner) {
        throw new UnauthorizedException('API key owner no longer exists');
      }
      // Scope on the request.user combines the api-key scope with the owning
      // user's scope so an api-key can never widen access beyond its owner.
      // Concretely: if the user has projectScopeMode='allowlist' with 5 ids,
      // and the key has projectScopeMode='all', the effective access is still
      // the user's 5 ids. See knowledge entry T-210 for the rationale.
      const keyAllowedProjectIds = (validated.allowedProjectIds || []).map((id: any) => id.toString());
      const keyAllowedCustomerIds = (validated.allowedCustomerIds || []).map((id: any) => id.toString());
      const ownerAllowedProjectIds = ((owner as any).allowedProjectIds || []).map((id: any) => id.toString());
      const ownerAllowedCustomerIds = ((owner as any).allowedCustomerIds || []).map((id: any) => id.toString());

      const intersect = (a: string[], b: string[]): string[] => a.filter((id) => b.includes(id));
      const narrow = (
        keyMode: any,
        keyIds: string[],
        ownerMode: any,
        ownerIds: string[],
      ): { mode: any; ids: string[] } => {
        const km = keyMode || 'all';
        const om = ownerMode || 'all';
        if (km === 'none' || om === 'none') return { mode: 'none', ids: [] };
        if (km === 'all' && om === 'all') return { mode: 'all', ids: [] };
        if (km === 'all') return { mode: 'allowlist', ids: ownerIds };
        if (om === 'all') return { mode: 'allowlist', ids: keyIds };
        return { mode: 'allowlist', ids: intersect(keyIds, ownerIds) };
      };

      const proj = narrow(
        validated.projectScopeMode,
        keyAllowedProjectIds,
        (owner as any).projectScopeMode,
        ownerAllowedProjectIds,
      );
      const cust = narrow(
        validated.customerScopeMode,
        keyAllowedCustomerIds,
        (owner as any).customerScopeMode,
        ownerAllowedCustomerIds,
      );
      const ownerPerms: string[] = ((owner as any).permissions || []) as string[];
      const keyPerms: string[] = (validated.permissions || []);
      // Permissions: admin role bypasses the list. For non-admin owners, the
      // effective permission set is the intersection of key + owner perms; an
      // empty key.permissions falls through to the owner's set (legacy keys).
      const effectivePerms = keyPerms.length === 0 ? ownerPerms : intersect(keyPerms, ownerPerms);

      request.user = {
        userId: validated.userId.toString(),
        username: owner.username,
        role: owner.role,
        apiKeyId: validated._id.toString(),
        permissions: effectivePerms,
        projectScopeMode: proj.mode,
        allowedProjectIds: proj.ids,
        customerScopeMode: cust.mode,
        allowedCustomerIds: cust.ids,
      };
      request.apiKey = validated;
      return true;
    }

    // SSE endpoint: accept token from query parameter
    if (!request.headers.authorization && request.query?.token) {
      request.headers.authorization = `Bearer ${request.query.token}`;
    }

    const passportResult = await (super.canActivate(context) as Promise<boolean>);
    if (passportResult && request.user?.userId) {
      // Enrich request.user with scope/permission info from DB so service-layer
      // helpers (actorCanAccessProject etc.) work for human-user requests too.
      // The JWT itself only carries sub/username/role — scope changes after
      // login take effect on the next request, not after token refresh.
      const fullUser = await this.authService.findUserById(request.user.userId);
      if (fullUser) {
        const u = fullUser as any;
        request.user = {
          ...request.user,
          permissions: (u.permissions || []) as string[],
          projectScopeMode: u.projectScopeMode || 'all',
          allowedProjectIds: (u.allowedProjectIds || []).map((id: any) => id.toString()),
          customerScopeMode: u.customerScopeMode || 'all',
          allowedCustomerIds: (u.allowedCustomerIds || []).map((id: any) => id.toString()),
        };
      }
    }
    return passportResult;
  }

  handleRequest(err: any, user: any) {
    if (err || !user) {
      throw err || new UnauthorizedException();
    }
    return user;
  }
}
