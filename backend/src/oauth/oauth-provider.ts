import type { RequestHandler, Response } from 'express';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthService } from './oauth.service';
import { OAUTH_SCOPE } from './oauth-tokens';

/** The part of {@link OAuthService} the HTTP layer uses (lets checks pass a fake). */
export type OAuthServicePort = Pick<
  OAuthService,
  | 'registerClient'
  | 'getClient'
  | 'createAuthRequest'
  | 'challengeForCode'
  | 'exchangeCode'
  | 'exchangeRefresh'
  | 'verifyAccessToken'
  | 'revokeToken'
>;

/** SPA route of the consent page; `?request=<id>` carries the one-time request id. */
export const OAUTH_CONSENT_PATH = '/oauth/consent';

/** Per-IP limits of the public OAuth endpoints (window in ms, max requests). */
export const OAUTH_RATE_LIMITS = {
  register: { windowMs: 60 * 60 * 1000, limit: 10 },
  token: { windowMs: 60 * 1000, limit: 60 },
  authorize: { windowMs: 60 * 1000, limit: 30 },
} as const;

/**
 * Adapter from the SDK's `OAuthServerProvider` to {@link OAuthService}.
 *
 * `skipLocalPkceValidation` is set so the SDK token handler forwards the
 * `code_verifier` and the service checks PKCE itself; the service rejects a
 * missing verifier, so PKCE stays mandatory (fail closed).
 */
export class DevGrimoireOAuthProvider implements OAuthServerProvider {
  readonly skipLocalPkceValidation = true;
  readonly clientsStore: OAuthRegisteredClientsStore;

  constructor(
    private readonly service: OAuthServicePort,
    private readonly baseUrl: URL,
  ) {
    this.clientsStore = {
      getClient: (clientId) => service.getClient(clientId),
      registerClient: (client) => service.registerClient(client),
    };
  }

  /** Stores the checked request and sends the browser to the consent page. */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const requestId = await this.service.createAuthRequest(client, params);
    const consent = new URL(OAUTH_CONSENT_PATH, this.baseUrl);
    consent.searchParams.set('request', requestId);
    res.redirect(302, consent.href);
  }

  challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return this.service.challengeForCode(client.client_id, code);
  }

  exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    return this.service.exchangeCode(client.client_id, code, codeVerifier, redirectUri, resource);
  }

  /** Requested scopes are ignored: a refresh never widens the grant. */
  exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    return this.service.exchangeRefresh(client.client_id, refreshToken, resource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const info = await this.service.verifyAccessToken(token);
    return {
      token,
      clientId: info.clientId,
      scopes: [OAUTH_SCOPE],
      expiresAt: info.expiresAt,
      resource: new URL(info.resource),
      extra: { apiKeyId: info.apiKeyId },
    };
  }

  revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    return this.service.revokeToken(client.client_id, request.token);
  }
}

/**
 * The SDK auth router: `/authorize`, `/token`, `/register`, `/revoke` and
 * the metadata documents under `/.well-known/oauth-*`, all at the root of
 * `baseUrl`. Must be mounted at the application root. The SDK's rate
 * limiters count per `req.ip`, so `trust proxy` must be right.
 */
export function createOAuthRouter(service: OAuthServicePort, urls: { baseUrl: URL; resourceUrl: URL }): RequestHandler {
  const provider = new DevGrimoireOAuthProvider(service, urls.baseUrl);
  return mcpAuthRouter({
    provider,
    issuerUrl: urls.baseUrl,
    baseUrl: urls.baseUrl,
    resourceServerUrl: urls.resourceUrl,
    scopesSupported: [OAUTH_SCOPE],
    resourceName: 'DevGrimoire',
    authorizationOptions: { rateLimit: OAUTH_RATE_LIMITS.authorize },
    tokenOptions: { rateLimit: OAUTH_RATE_LIMITS.token },
    // The service generates the client id (and every client is public).
    clientRegistrationOptions: { rateLimit: OAUTH_RATE_LIMITS.register, clientIdGeneration: false },
  });
}
