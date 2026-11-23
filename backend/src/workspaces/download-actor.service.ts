import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ApiKeysService } from '../api-keys/api-keys.service';
import { AuthService } from '../auth/auth.service';
import { actorFromApiKey, actorFromUser } from '../common/actor-scope';
import type { DownloadTicketIdentity } from '../common/download-ticket.service';
import type { RequestUser } from '../common/request-context';
import { actorMayWriteContent } from '../common/scope-guard';

/**
 * Rebuilds the actor behind a download ticket at the moment it is used. The
 * ticket only remembers who asked; the user (still active?), the API key
 * (still valid?) and their scope are read again, like a fresh request would.
 */
@Injectable()
export class DownloadActorService {
  constructor(
    private readonly auth: AuthService,
    private readonly apiKeys: ApiKeysService,
  ) {}

  /** `undefined` when authentication is disabled (no actor, as for any request then). */
  async resolve(identity: DownloadTicketIdentity): Promise<RequestUser | undefined> {
    if (!this.auth.isAuthEnabled()) return undefined;
    if (!identity.userId) throw new UnauthorizedException('Invalid download ticket');
    const user = await this.auth.findUserById(identity.userId);
    if (!user || user.active === false) throw new UnauthorizedException('Invalid download ticket');
    let actor: RequestUser;
    if (identity.apiKeyId) {
      const key = await this.apiKeys.findActiveById(identity.apiKeyId);
      if (!key || key.userId.toString() !== identity.userId || Array.isArray(key.allowedTools)) {
        throw new UnauthorizedException('Invalid download ticket');
      }
      actor = actorFromApiKey(key, user);
    } else {
      actor = actorFromUser(user);
    }
    if (!actorMayWriteContent(actor)) {
      throw new ForbiddenException('Workspace IDE requires project:write or customer:write');
    }
    return actor;
  }
}
