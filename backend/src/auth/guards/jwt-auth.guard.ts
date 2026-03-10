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
      // Set minimal user object for downstream handlers
      request.user = {
        userId: validated.userId.toString(),
        username: 'api-key',
        role: 'user',
        apiKeyId: validated._id.toString(),
      };
      return true;
    }

    // SSE endpoint: accept token from query parameter
    if (!request.headers.authorization && request.query?.token) {
      request.headers.authorization = `Bearer ${request.query.token}`;
    }

    return super.canActivate(context) as Promise<boolean>;
  }

  handleRequest(err: any, user: any) {
    if (err || !user) {
      throw err || new UnauthorizedException();
    }
    return user;
  }
}
