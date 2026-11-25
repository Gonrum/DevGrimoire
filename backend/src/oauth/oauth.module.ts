import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ApiKey, ApiKeySchema } from '../api-keys/schemas/api-key.schema';
import {
  CustomerProjectLink,
  CustomerProjectLinkSchema,
} from '../customers/schemas/customer-project-link.schema';
import { OAuthClient, OAuthClientSchema } from './schemas/oauth-client.schema';
import { OAuthAuthRequest, OAuthAuthRequestSchema } from './schemas/oauth-auth-request.schema';
import { OAuthCode, OAuthCodeSchema } from './schemas/oauth-code.schema';
import { OAuthToken, OAuthTokenSchema } from './schemas/oauth-token.schema';
import { OAUTH_OPTIONS, OAuthCoreOptions, OAuthService } from './oauth.service';
import { oauthConfig } from './oauth-config';

/**
 * MCP OAuth core. No HTTP routes here; the SDK router (main.ts, via
 * `createOAuthRouter`) and the consent endpoint are wired on top of
 * `OAuthService`. `ApiKeysService` comes from
 * the global `ApiKeysModule`.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: OAuthClient.name, schema: OAuthClientSchema },
      { name: OAuthAuthRequest.name, schema: OAuthAuthRequestSchema },
      { name: OAuthCode.name, schema: OAuthCodeSchema },
      { name: OAuthToken.name, schema: OAuthTokenSchema },
      // Idempotent to ApiKeysModule: the service checks/deactivates connection keys directly.
      { name: ApiKey.name, schema: ApiKeySchema },
      // Read-only: customers linked to the projects a consent is restricted to.
      { name: CustomerProjectLink.name, schema: CustomerProjectLinkSchema },
    ]),
  ],
  providers: [
    {
      provide: OAUTH_OPTIONS,
      useFactory: (): OAuthCoreOptions => ({
        // Same switch as the router in main.ts: no valid config, no valid token.
        resource: oauthConfig().resourceUrl?.href ?? null,
        now: () => Date.now(),
      }),
    },
    OAuthService,
  ],
  exports: [OAuthService],
})
export class OAuthModule {}
