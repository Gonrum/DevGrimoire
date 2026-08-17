import { ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import type { Request } from 'express';
import { firstValueFrom, isObservable } from 'rxjs';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AuthService } from '../auth.service';
import { ApiKeysService } from '../../api-keys/api-keys.service';
import type { ScopeMode } from '../../common/permissions';
import type { AuthRequest, RequestUser } from '../../common/request-context';

/**
 * The Express request as it looks once an actor has been authenticated.
 *
 * `AuthRequest` (`{ user?: RequestUser; apiKey?: ApiKey }`) is the canonical
 * declaration in `common/request-context` — the same shape `RequestContext`
 * and the `ActorScope` helpers consume downstream. Only the Express half is
 * added here, because this guard is the one place that also touches transport
 * details (`headers`, `query`).
 */
type GuardRequest = Request & AuthRequest;

/** Effective scope after intersecting an api-key scope with its owner's. */
interface NarrowedScope {
  mode: ScopeMode;
  ids: string[];
}

const intersect = (a: string[], b: string[]): string[] => a.filter((id) => b.includes(id));

/**
 * Combines an api-key scope with the owning user's scope. A key can only ever
 * narrow, never widen: `mode` falls back to `'all'` for legacy documents that
 * predate the scope fields, and any `'none'` on either side wins.
 */
const narrow = (
  keyMode: ScopeMode | undefined,
  keyIds: string[],
  ownerMode: ScopeMode | undefined,
  ownerIds: string[],
): NarrowedScope => {
  const km = keyMode || 'all';
  const om = ownerMode || 'all';
  if (km === 'none' || om === 'none') return { mode: 'none', ids: [] };
  if (km === 'all' && om === 'all') return { mode: 'all', ids: [] };
  if (km === 'all') return { mode: 'allowlist', ids: ownerIds };
  if (om === 'all') return { mode: 'allowlist', ids: keyIds };
  return { mode: 'allowlist', ids: intersect(keyIds, ownerIds) };
};

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

    const request = context.switchToHttp().getRequest<GuardRequest>();

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
      const keyAllowedProjectIds = (validated.allowedProjectIds || []).map((id) => id.toString());
      const keyAllowedCustomerIds = (validated.allowedCustomerIds || []).map((id) => id.toString());
      const ownerAllowedProjectIds = (owner.allowedProjectIds || []).map((id) => id.toString());
      const ownerAllowedCustomerIds = (owner.allowedCustomerIds || []).map((id) => id.toString());

      const proj = narrow(
        validated.projectScopeMode,
        keyAllowedProjectIds,
        owner.projectScopeMode,
        ownerAllowedProjectIds,
      );
      const cust = narrow(
        validated.customerScopeMode,
        keyAllowedCustomerIds,
        owner.customerScopeMode,
        ownerAllowedCustomerIds,
      );
      const ownerPerms: string[] = owner.permissions || [];
      const keyPerms: string[] = validated.permissions || [];
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

    // SSE endpoint: accept token from query parameter. Only a single string
    // value is accepted — a repeated (`?token=a&token=b`) or nested query
    // param is not a JWT and previously only produced a header that passport
    // was bound to reject, so ignoring it leads to the same 401.
    const tokenFromQuery = request.query?.token;
    if (
      !request.headers.authorization &&
      typeof tokenFromQuery === 'string' &&
      tokenFromQuery.length > 0
    ) {
      request.headers.authorization = `Bearer ${tokenFromQuery}`;
    }

    // `CanActivate.canActivate` darf laut Interface `boolean`, `Promise` oder
    // `Observable` liefern. Vorher stand hier ein `as Promise<boolean>` — eine
    // Behauptung, die im Observable-Fall stillschweigend das *Observable-Objekt*
    // als Ergebnis durchgereicht hätte (truthy → Zugriff erlaubt, ohne dass
    // jemals ein User geprüft wurde). Statt der Behauptung jetzt eine echte
    // Laufzeit-Unterscheidung; `@nestjs/passport` liefert praktisch immer ein
    // Promise, dieser Pfad ändert daran nichts.
    const passportOutcome = super.canActivate(context);
    const passportResult = isObservable(passportOutcome)
      ? await firstValueFrom(passportOutcome)
      : await passportOutcome;
    const jwtUser = request.user;
    if (passportResult && jwtUser?.userId) {
      // Enrich request.user with scope/permission info from DB so service-layer
      // helpers (actorCanAccessProject etc.) work for human-user requests too.
      // The JWT itself only carries sub/username/role — scope changes after
      // login take effect on the next request, not after token refresh.
      const fullUser = await this.authService.findUserById(jwtUser.userId);
      if (fullUser) {
        request.user = {
          ...jwtUser,
          permissions: fullUser.permissions || [],
          projectScopeMode: fullUser.projectScopeMode || 'all',
          allowedProjectIds: (fullUser.allowedProjectIds || []).map((id) => id.toString()),
          customerScopeMode: fullUser.customerScopeMode || 'all',
          allowedCustomerIds: (fullUser.allowedCustomerIds || []).map((id) => id.toString()),
        };
      }
    }
    return passportResult;
  }

  /**
   * Passport hands us `(err, user)` from the strategy: `err` is the Error a
   * strategy raised (or null), `user` is `false` when the strategy failed to
   * authenticate. Either case results in a 401 — the strategy's own error is
   * rethrown unchanged so its status/message survives.
   */
  handleRequest<TUser = RequestUser>(
    err: Error | null | undefined,
    user: TUser | false | null | undefined,
  ): TUser {
    if (err) {
      throw err;
    }
    if (!user) {
      throw new UnauthorizedException();
    }
    return user;
  }
}
