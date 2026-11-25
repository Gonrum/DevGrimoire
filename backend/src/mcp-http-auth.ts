import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { ApiKey, ApiKeyDocument } from './api-keys/schemas/api-key.schema';
import type { UserDocument } from './auth/schemas/user.schema';
import { RequestContext, RequestUser } from './common/request-context';
import { actorFromApiKey } from './common/actor-scope';
import { errorMessage, isRecord } from './common/narrow';
import { ACCESS_TOKEN_PREFIX } from './oauth/oauth-tokens';
import type { OAuthAccessTokenInfo } from './oauth/oauth.service';

/** Express request as the MCP auth middleware enriches it. */
export interface McpRequest extends Request {
  user?: RequestUser;
  apiKey?: ApiKey;
}

/** Prefix shared by every OAuth token we issue; never valid as an API key. */
const OAUTH_TOKEN_PREFIX = 'dgo_';

/**
 * A single string value from query or header; arrays (`?apiKey=a&apiKey=b`)
 * and nested objects (`?apiKey[x]=y`) count as "not set".
 */
export function singleValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export interface McpAuthDeps {
  authEnabled: () => boolean;
  apiKeys: {
    validate(plainKey: string): Promise<ApiKeyDocument | null>;
    findActiveById(id: string): Promise<ApiKeyDocument | null>;
  };
  findUserById(id: string): Promise<UserDocument | null>;
  /**
   * OAuth on `/mcp`: verifies `dgo_at_` access tokens and names the
   * metadata URL for `WWW-Authenticate`. Null when OAuth is off.
   */
  oauth: {
    verifyAccessToken(token: string): Promise<OAuthAccessTokenInfo>;
    resourceUrl: URL;
  } | null;
}

function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

/**
 * Auth for the MCP transports. `cv_` API keys (header or `?apiKey=`) work
 * everywhere. With `acceptOAuth` (only `/mcp`) and OAuth configured, a
 * `Bearer dgo_at_…` header is accepted too and every 401 carries
 * `WWW-Authenticate: Bearer resource_metadata="…"` so clients can discover
 * the authorization server. OAuth tokens in the query are always refused:
 * they would end up in logs and browser history.
 *
 * Both paths end in the same actor: the key (for OAuth the hidden
 * connection key) and its owner are loaded on every request, a missing or
 * deactivated owner is a 401, and `actorFromApiKey` narrows the owner's
 * rights by the key's scope.
 */
export function createMcpAuthMiddleware(
  deps: McpAuthDeps,
  opts: { acceptOAuth: boolean },
): (req: McpRequest, res: Response, next: NextFunction) => void {
  const oauth = opts.acceptOAuth ? deps.oauth : null;
  const resourceMetadata = oauth ? getOAuthProtectedResourceMetadataUrl(oauth.resourceUrl) : null;
  // On the legacy transports (/sse, /messages) with OAuth configured: point
  // clients at the endpoint that does accept a browser login.
  const oauthElsewhere = !opts.acceptOAuth && deps.oauth ? deps.oauth.resourceUrl.href : null;
  const oauthHint = oauthElsewhere
    ? ` Browser login (OAuth) works only on ${oauthElsewhere} — reconnect with: claude mcp add --transport http devgrimoire ${oauthElsewhere}`
    : '';

  const unauthorized = (res: Response, message: string, tokenError?: string) => {
    if (resourceMetadata) {
      const parts = [`resource_metadata="${resourceMetadata}"`];
      if (tokenError) parts.unshift(`error="${tokenError}"`);
      res.setHeader('WWW-Authenticate', `Bearer ${parts.join(', ')}`);
    }
    jsonRpcError(res, 401, -32001, message);
  };

  const finish = async (
    req: McpRequest,
    res: Response,
    next: NextFunction,
    key: ApiKeyDocument,
    what: 'API key' | 'OAuth connection',
  ) => {
    const owner = await deps.findUserById(key.userId.toString());
    if (!owner) return unauthorized(res, `Unauthorized: ${what} owner no longer exists.`);
    // Like JwtAuthGuard: a deactivated owner's credentials open nothing.
    if (owner.active === false) return unauthorized(res, `Unauthorized: ${what} owner is deactivated.`);
    req.user = actorFromApiKey(key, owner);
    req.apiKey = key;
    next();
  };

  const handle = async (req: McpRequest, res: Response, next: NextFunction): Promise<void> => {
    // Without auth every caller is the system user, so per-user scoped
    // tools (chat_*) can still resolve an owner.
    if (!deps.authEnabled()) {
      req.user = { userId: 'system', username: 'system', role: 'admin' } satisfies RequestUser;
      return next();
    }

    const authHeader = singleValue(req.headers.authorization);
    const queryKey = singleValue(req.query?.apiKey);
    if (queryKey?.startsWith(OAUTH_TOKEN_PREFIX)) {
      return unauthorized(res, 'Unauthorized: OAuth tokens are accepted only in the Authorization header.');
    }

    if (authHeader?.startsWith(`Bearer ${OAUTH_TOKEN_PREFIX}`)) {
      const token = authHeader.slice(7);
      if (oauthElsewhere) {
        // 400, not 401: a 401 makes OAuth clients refresh and retry the same
        // transport in a loop. This is a wrong endpoint, not a bad token.
        return jsonRpcError(
          res,
          400,
          -32001,
          `OAuth access tokens are not accepted on this transport.${oauthHint}`,
        );
      }
      if (!oauth || !token.startsWith(ACCESS_TOKEN_PREFIX)) {
        return unauthorized(res, 'Unauthorized: OAuth access tokens are accepted only on /mcp.', 'invalid_token');
      }
      let info: OAuthAccessTokenInfo;
      try {
        info = await oauth.verifyAccessToken(token);
      } catch {
        return unauthorized(res, 'Unauthorized: Invalid or expired access token.', 'invalid_token');
      }
      // The service checked the connection already; load it again through
      // the API-key path so revocation between the two reads still counts.
      const key = await deps.apiKeys.findActiveById(info.apiKeyId);
      if (!key || key.kind !== 'oauth') {
        return unauthorized(res, 'Unauthorized: OAuth connection revoked.', 'invalid_token');
      }
      return finish(req, res, next, key, 'OAuth connection');
    }

    let apiKey: string | undefined;
    if (authHeader?.startsWith('Bearer cv_')) apiKey = authHeader.slice(7);
    else if (queryKey) apiKey = queryKey;
    if (!apiKey) {
      return unauthorized(
        res,
        `Unauthorized: API key required. Pass via Authorization: Bearer cv_... header or ?apiKey= query param.${oauthHint}`,
      );
    }
    const validated = await deps.apiKeys.validate(apiKey);
    if (!validated) return unauthorized(res, 'Unauthorized: Invalid or expired API key.');
    return finish(req, res, next, validated, 'API key');
  };

  return (req: McpRequest, res: Response, next: NextFunction) => {
    handle(req, res, next).catch((err: unknown) => {
      if (!res.headersSent) jsonRpcError(res, 500, -32603, 'Internal server error');
      console.error('MCP auth failed:', errorMessage(err));
    });
  };
}

/**
 * Which credential (API key id, for OAuth the connection key id) opened a
 * Streamable-HTTP session. A session id that leaks must not let another
 * credential ride the session, and revoking a connection closes the
 * sessions it opened. `null` = auth off (system user).
 */
export class McpSessionOwners {
  private readonly owners = new Map<string, { apiKeyId: string | null; close: () => Promise<void> }>();

  bind(sessionId: string, apiKeyId: string | null, close: () => Promise<void>): void {
    this.owners.set(sessionId, { apiKeyId, close });
  }

  unbind(sessionId: string): void {
    this.owners.delete(sessionId);
  }

  /** Fails closed: an unbound session matches nobody. */
  matches(sessionId: string, apiKeyId: string | null): boolean {
    const entry = this.owners.get(sessionId);
    return !!entry && entry.apiKeyId === apiKeyId;
  }

  /** Closes every session opened with `apiKeyId`; returns how many. */
  closeForApiKey(apiKeyId: string): number {
    let n = 0;
    for (const [sid, entry] of [...this.owners]) {
      if (entry.apiKeyId !== apiKeyId) continue;
      this.owners.delete(sid);
      n += 1;
      entry.close().catch(() => undefined);
    }
    return n;
  }

  get size(): number {
    return this.owners.size;
  }
}

export interface StreamableHandlerDeps {
  /** Shared with the SSE transport so a session id names one protocol only. */
  transports: Record<string, SSEServerTransport | StreamableHTTPServerTransport>;
  owners: McpSessionOwners;
  createServer: () => Server;
  log: (message: string) => void;
}

/** Same status, code and text as the SDK transport for an unknown session id. */
function sessionNotFound(res: Response): void {
  jsonRpcError(res, 404, -32001, 'Session not found');
}

/** `/mcp` (Streamable HTTP, protocol 2025-11-25); runs after the auth middleware. */
export function createStreamableHttpHandler(deps: StreamableHandlerDeps): (req: McpRequest, res: Response) => Promise<void> {
  const { transports, owners } = deps;
  return async (req, res) => {
    try {
      const sessionId = singleValue(req.headers['mcp-session-id']);
      const principal = req.user?.apiKeyId ?? null;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        const existing = transports[sessionId];
        if (!(existing instanceof StreamableHTTPServerTransport)) {
          jsonRpcError(res, 400, -32000, 'Session uses a different transport protocol');
          return;
        }
        // Same answer as an unknown session: it must not confirm that the id
        // exists, and a 404 makes the client re-initialize under its own
        // credential (it would get stuck on a 403).
        if (!owners.matches(sessionId, principal)) {
          sessionNotFound(res);
          return;
        }
        transport = existing;
      } else if (!sessionId && req.method === 'POST' && isInitializeRequest(req.body)) {
        const created = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports[sid] = created;
            owners.bind(sid, principal, () => created.close());
            deps.log(`streamable-http session opened (${sid.slice(0, 8)}…, total=${Object.keys(transports).length})`);
          },
        });
        created.onclose = () => {
          const sid = created.sessionId;
          if (sid) {
            delete transports[sid];
            owners.unbind(sid);
            deps.log(`streamable-http session closed (${sid.slice(0, 8)}…, total=${Object.keys(transports).length})`);
          }
        };
        await deps.createServer().connect(created);
        transport = created;
      } else if (sessionId) {
        // Unknown or closed (e.g. revoked) session: per the Streamable HTTP
        // spec 404, so the client starts a new session.
        sessionNotFound(res);
        return;
      } else {
        jsonRpcError(res, 400, -32000, 'Bad Request: No valid session ID provided');
        return;
      }

      await RequestContext.run(req.user, req.apiKey, () => transport.handleRequest(req, res, req.body));
    } catch {
      if (!res.headersSent) jsonRpcError(res, 500, -32603, 'Internal server error');
    }
  };
}

/** Closes the open Streamable-HTTP sessions of a revoked OAuth connection. */
export function closeSessionsOnRevoke(
  events: { on(event: string, listener: (payload: unknown) => void): unknown },
  eventName: string,
  owners: McpSessionOwners,
  log: (message: string) => void,
): void {
  events.on(eventName, (payload: unknown) => {
    const apiKeyId = isRecord(payload) ? payload.apiKeyId : undefined;
    if (typeof apiKeyId !== 'string') return;
    const n = owners.closeForApiKey(apiKeyId);
    if (n > 0) log(`closed ${n} MCP session(s) of revoked OAuth connection ${apiKeyId}`);
  });
}
