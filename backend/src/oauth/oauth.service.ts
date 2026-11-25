import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model, Types } from 'mongoose';
import type { ScopeMode } from '../common/permissions';
import type { AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidTargetError,
  InvalidTokenError,
  ServerError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type {
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { ApiKey, ApiKeyDocument } from '../api-keys/schemas/api-key.schema';
import { ApiKeysService } from '../api-keys/api-keys.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import {
  CustomerProjectLink,
  CustomerProjectLinkDocument,
  CustomerProjectLinkStatus,
} from '../customers/schemas/customer-project-link.schema';
import { OAuthClient, OAuthClientDocument } from './schemas/oauth-client.schema';
import {
  OAuthAuthRequest,
  OAuthAuthRequestDocument,
  OAuthDecisionKind,
} from './schemas/oauth-auth-request.schema';
import { OAuthCode, OAuthCodeDocument } from './schemas/oauth-code.schema';
import { OAuthToken, OAuthTokenDocument, OAuthTokenType } from './schemas/oauth-token.schema';
import {
  ACCESS_TOKEN_PREFIX,
  ACCESS_TOKEN_TTL_MS,
  AUTH_CODE_TTL_MS,
  AUTH_REQUEST_TTL_MS,
  CONNECTION_TTL_MS,
  DECISION_RETRY_WINDOW_MS,
  LAST_USED_WRITE_INTERVAL_MS,
  MAX_ECHO_LENGTH,
  MAX_REDIRECT_URIS,
  OAUTH_SCOPE,
  PENDING_CONNECTION_TTL_MS,
  REFRESH_REUSE_GRACE_MS,
  REFRESH_TOKEN_PREFIX,
  REFRESH_TOKEN_TTL_MS,
  UNUSED_CLIENT_TTL_MS,
  canonicalResource,
  clientNameProblem,
  hashSecret,
  isOwnOrigin,
  isValidPkceValue,
  newAccessToken,
  newAuthCode,
  newClientId,
  newRefreshToken,
  newRequestId,
  redirectUriMatches,
  redirectUriProblem,
  verifyPkce,
} from './oauth-tokens';

/** EventEmitter2 event, payload {@link OAuthConnectionRevokedEvent}. */
export const OAUTH_CONNECTION_REVOKED = 'oauth.connection.revoked';

/** Why a connection was revoked (event payload and audit trail). */
export type OAuthRevokeReason =
  | 'user'
  | 'admin'
  | 'account'
  | 'code_replay'
  | 'refresh_replay'
  | 'token_revocation'
  /** Superseded by a newer connection of the same user and client. */
  | 'replaced';

export interface OAuthConnectionRevokedEvent {
  apiKeyId: string;
  reason: OAuthRevokeReason;
}

/** Injection token for {@link OAuthCoreOptions}. */
export const OAUTH_OPTIONS = 'OAUTH_OPTIONS';

export interface OAuthCoreOptions {
  /** `<PUBLIC_BASE_URL>/mcp`, or null when OAuth is not configured. */
  resource: string | null;
  /** Clock in ms since epoch; injectable so expiry is testable without sleeping. */
  now: () => number;
}

export interface OAuthAuthRequestInfo {
  clientId: string;
  clientName: string | null;
  redirectUri: string;
  /** Host of the redirect URI — what the consent page must show prominently. */
  redirectHost: string;
  scopes: string[];
  expiresAt: Date;
}

/** One entry of the "connected apps" list. No secret material. */
export interface OAuthConnectionInfo {
  id: string;
  clientId: string;
  clientName: string;
  projectScopeMode: ScopeMode;
  allowedProjectIds: string[];
  createdAt?: Date;
  lastUsedAt?: Date;
  expiresAt?: Date;
}

/** Public switch for the UI: whether OAuth login is offered, and where. */
export type OAuthInfo = { enabled: false } | { enabled: true; mcpUrl: string };

export interface OAuthAccessTokenInfo {
  apiKeyId: string;
  clientId: string;
  /** Seconds since epoch. */
  expiresAt: number;
  resource: string;
}

const MAX_PROJECT_IDS = 200;
const MAX_SCOPES = 20;
/** Generated client ids are UUIDs; anything else cannot be ours. */
const CLIENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Our secrets are 43 base64url chars plus an optional prefix; cap before hashing. */
const MAX_SECRET_LENGTH = 200;

function isClientId(value: unknown): value is string {
  return typeof value === 'string' && CLIENT_ID.test(value);
}

function isSecretString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_SECRET_LENGTH;
}

/** Whether a repeated approval asks for the same project scope as the connection has. */
function sameProjectSelection(key: ApiKey, projectIds: string[] | undefined): boolean {
  if (projectIds === undefined) return key.projectScopeMode === 'all';
  if (key.projectScopeMode !== 'allowlist') return false;
  const have = new Set((key.allowedProjectIds ?? []).map(String));
  return have.size === projectIds.length && projectIds.every((id) => have.has(id));
}

interface TokenGrant {
  clientId: string;
  apiKeyId: Types.ObjectId;
  userId: Types.ObjectId;
  resource: string;
}

type GrantType = 'authorization_code' | 'refresh_token';

/**
 * MCP OAuth authorization server core: clients, consent requests, codes and
 * tokens. One approved consent = one hidden API key (`kind: 'oauth'`, the
 * "connection"); every token points at it, so the existing API-key
 * permission path applies and revoking = deactivating that key.
 *
 * Secrets (request ids, codes, tokens) are 32 random bytes, handed out once
 * and stored only as SHA-256 hashes. They are never logged.
 *
 * Errors use the SDK's OAuth error classes, so the SDK handlers turn them
 * into the right protocol responses. `decide` is called by the consent REST
 * endpoint and throws Nest HTTP exceptions instead.
 */
@Injectable()
export class OAuthService {
  private readonly logger = new Logger(OAuthService.name);

  constructor(
    @InjectModel(OAuthClient.name) private readonly clientModel: Model<OAuthClientDocument>,
    @InjectModel(OAuthAuthRequest.name) private readonly requestModel: Model<OAuthAuthRequestDocument>,
    @InjectModel(OAuthCode.name) private readonly codeModel: Model<OAuthCodeDocument>,
    @InjectModel(OAuthToken.name) private readonly tokenModel: Model<OAuthTokenDocument>,
    @InjectModel(ApiKey.name) private readonly apiKeyModel: Model<ApiKeyDocument>,
    @InjectModel(CustomerProjectLink.name) private readonly linkModel: Model<CustomerProjectLinkDocument>,
    private readonly apiKeys: ApiKeysService,
    private readonly events: EventEmitter2,
    private readonly auditLog: AuditLogService,
    @Inject(OAUTH_OPTIONS) private readonly options: OAuthCoreOptions,
  ) {}

  private now(): number {
    return this.options.now();
  }

  /** Whether OAuth login is offered; safe to expose without authentication. */
  info(): OAuthInfo {
    const resource = this.options.resource;
    return resource ? { enabled: true, mcpUrl: resource } : { enabled: false };
  }

  private requireResource(): string {
    if (!this.options.resource) throw new ServerError('OAuth is not configured');
    return this.options.resource;
  }

  // ------------------------------------------------------------------ clients

  /**
   * Dynamic client registration (RFC 7591), validated against our rules.
   * Every client is public: a requested secret-based auth method is
   * overridden with `none` (RFC 7591 §3.2.1 lets the server do that), so no
   * client secret exists that would have to be stored. A `client_id` the
   * caller brings is ignored; we generate our own.
   */
  async registerClient(meta: OAuthClientMetadata): Promise<OAuthClientInformationFull> {
    const uris: unknown = meta.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0) {
      throw new InvalidClientMetadataError('redirect_uris must contain at least one URI');
    }
    if (uris.length > MAX_REDIRECT_URIS) {
      throw new InvalidClientMetadataError(`at most ${MAX_REDIRECT_URIS} redirect_uris are allowed`);
    }
    const redirectUris: string[] = [];
    for (const uri of uris) {
      const problem = redirectUriProblem(uri);
      if (problem !== null || typeof uri !== 'string') {
        throw new InvalidClientMetadataError(problem ?? 'invalid redirect_uri');
      }
      if (isOwnOrigin(uri, this.options.resource)) {
        throw new InvalidClientMetadataError('redirect_uri must not point at this server');
      }
      redirectUris.push(uri);
    }
    const nameProblem = clientNameProblem(meta.client_name);
    if (nameProblem) throw new InvalidClientMetadataError(nameProblem);

    const now = this.now();
    const doc = await this.clientModel.create({
      clientId: newClientId(),
      ...(meta.client_name !== undefined ? { clientName: meta.client_name } : {}),
      redirectUris,
      issuedAt: Math.floor(now / 1000),
      expiresAt: new Date(now + UNUSED_CLIENT_TTL_MS),
    });
    return this.toClientInfo(doc);
  }

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const doc = await this.findLiveClient(clientId);
    return doc ? this.toClientInfo(doc) : undefined;
  }

  private async findLiveClient(clientId: unknown): Promise<OAuthClient | null> {
    if (!isClientId(clientId)) return null;
    const doc = await this.clientModel.findOne({ clientId }).lean<OAuthClient>().exec();
    if (!doc) return null;
    // The TTL monitor runs about once a minute; do not rely on it.
    if (doc.expiresAt && doc.expiresAt.getTime() <= this.now()) return null;
    return doc;
  }

  private toClientInfo(doc: OAuthClient): OAuthClientInformationFull {
    return {
      client_id: doc.clientId,
      client_id_issued_at: doc.issuedAt,
      ...(doc.clientName !== undefined ? { client_name: doc.clientName } : {}),
      redirect_uris: [...doc.redirectUris],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  // ------------------------------------------------------------------ consent

  /**
   * Stores a validated /authorize request and returns its one-time id for
   * the consent page. Re-checks redirect URI and PKCE challenge against the
   * stored client instead of trusting the caller, and binds the request to
   * our resource.
   */
  async createAuthRequest(client: OAuthClientInformationFull, params: AuthorizationParams): Promise<string> {
    const resource = this.requireResource();
    const stored = await this.findLiveClient(client.client_id);
    if (!stored) throw new InvalidRequestError('Unknown client');

    const redirectUri = params.redirectUri;
    if (
      typeof redirectUri !== 'string' ||
      redirectUriProblem(redirectUri) !== null ||
      !stored.redirectUris.some((registered) => redirectUriMatches(redirectUri, registered))
    ) {
      throw new InvalidRequestError('Unregistered redirect_uri');
    }
    if (!isValidPkceValue(params.codeChallenge)) {
      throw new InvalidRequestError('code_challenge (S256) is required');
    }
    if (params.state !== undefined && (typeof params.state !== 'string' || params.state.length > MAX_ECHO_LENGTH)) {
      throw new InvalidRequestError('state is too long');
    }
    const scopes = params.scopes ?? [];
    if (
      scopes.length > MAX_SCOPES ||
      scopes.some((s) => typeof s !== 'string') ||
      scopes.join(' ').length > MAX_ECHO_LENGTH
    ) {
      throw new InvalidRequestError('scope is too long');
    }
    if (params.resource !== undefined && canonicalResource(params.resource) !== resource) {
      throw new InvalidTargetError('Unknown resource');
    }

    const requestId = newRequestId();
    await this.requestModel.create({
      requestHash: hashSecret(requestId),
      clientId: stored.clientId,
      ...(stored.clientName !== undefined ? { clientName: stored.clientName } : {}),
      redirectUri,
      codeChallenge: params.codeChallenge,
      ...(params.state !== undefined ? { state: params.state } : {}),
      // Only our single scope exists; anything else the client asked for is
      // dropped here and never echoed back in a token response.
      scopes: [OAUTH_SCOPE],
      resource,
      expiresAt: new Date(this.now() + AUTH_REQUEST_TTL_MS),
    });
    return requestId;
  }

  /** What the consent page shows; null for unknown, used or expired requests. */
  async getAuthRequest(requestId: string): Promise<OAuthAuthRequestInfo | null> {
    if (!isSecretString(requestId)) return null;
    const doc = await this.requestModel
      .findOne({ requestHash: hashSecret(requestId) })
      .lean<OAuthAuthRequest>()
      .exec();
    if (!doc || doc.usedAt || doc.expiresAt.getTime() <= this.now()) return null;
    return {
      clientId: doc.clientId,
      clientName: doc.clientName ?? null,
      redirectUri: doc.redirectUri,
      redirectHost: new URL(doc.redirectUri).host,
      scopes: [...doc.scopes],
      expiresAt: doc.expiresAt,
    };
  }

  /**
   * The user's decision on a consent request. Consumes the request (single
   * use, atomically) and returns where the browser goes next: the client's
   * redirect URI with a code, or with `error=access_denied`.
   *
   * On approval this creates the connection (hidden API key owned by
   * `userId`) and a 60 s code bound to it. `projectIds` restricts the
   * connection to those projects and to the customers linked to them; it
   * must be omitted (not empty) for an unrestricted connection.
   *
   * A used request can be decided again only as a repeat of a lost
   * response: same user, same decision, same project selection, within
   * {@link DECISION_RETRY_WINDOW_MS}, and (approval) the connection still
   * waiting for its first redemption. See {@link repeatDecision}.
   */
  async decide(
    requestId: string,
    userId: string,
    d: { approve: boolean; projectIds?: string[] },
  ): Promise<{ redirectUrl: string }> {
    // Validate everything before consuming, so bad input does not burn the request.
    if (!isSecretString(requestId)) throw new NotFoundException('Authorization request not found');
    if (typeof userId !== 'string' || !Types.ObjectId.isValid(userId)) {
      throw new BadRequestException('Invalid userId');
    }
    const projectIds = d.approve ? this.validateProjectIds(d.projectIds) : undefined;
    const decision: OAuthDecisionKind = d.approve ? 'approve' : 'deny';
    const userOid = new Types.ObjectId(userId);
    const requestHash = hashSecret(requestId);

    const now = this.now();
    const req = await this.requestModel
      .findOneAndUpdate(
        { requestHash, usedAt: { $exists: false }, expiresAt: { $gt: new Date(now) } },
        {
          $set: {
            usedAt: new Date(now),
            decidedBy: userOid,
            decision,
            // A used request is only kept for the repeat window.
            expiresAt: new Date(now + DECISION_RETRY_WINDOW_MS),
          },
        },
      )
      .lean<OAuthAuthRequest>()
      .exec();
    if (!req) return this.repeatDecision(requestHash, userOid, decision, projectIds);

    const redirect = new URL(req.redirectUri);
    const consentMeta = { clientId: req.clientId, clientName: req.clientName, redirectHost: redirect.host };
    if (!d.approve) {
      await this.auditLog.record({
        action: 'oauth.consent.denied',
        entityType: 'oauth_client',
        meta: consentMeta,
        actor: { userId },
      });
      return { redirectUrl: this.denyRedirect(req) };
    }

    const client = await this.findLiveClient(req.clientId);
    if (!client) throw new NotFoundException('OAuth client no longer registered');

    const customerIds = projectIds ? await this.customersLinkedTo(projectIds) : undefined;
    const key = await this.apiKeys.createOAuthConnection({
      userId,
      clientId: client.clientId,
      clientName: client.clientName ?? client.clientId,
      // Provisional until the code is redeemed (see exchangeCode).
      expiresAt: new Date(now + PENDING_CONNECTION_TTL_MS),
      ...(projectIds ? { projectIds, customerIds } : {}),
    });
    await this.requestModel.updateOne({ requestHash }, { $set: { apiKeyId: key._id } }).exec();
    await this.auditLog.record({
      action: 'oauth.consent.approved',
      entityType: 'apikey',
      entityId: key._id.toString(),
      meta: { ...consentMeta, projectIds: projectIds ?? 'all', customerIds: customerIds ?? 'all' },
      actor: { userId },
    });
    // An approved client no longer expires as "never used".
    await this.clientModel.updateOne({ clientId: client.clientId }, { $unset: { expiresAt: '' } }).exec();

    return { redirectUrl: await this.issueCode(req, key._id, userOid) };
  }

  /**
   * Repeat of a decision whose response never reached the browser (seen
   * live: the POST ended as nginx 499 after the backend had approved). The
   * same user may repeat the same decision within the window; an approval
   * gets a fresh code for the SAME pending connection (no second key) and
   * all earlier unredeemed codes of it are deleted. Everything else is the
   * usual 404. Not audited again: the decision itself was recorded once.
   */
  private async repeatDecision(
    requestHash: string,
    userId: Types.ObjectId,
    decision: OAuthDecisionKind,
    projectIds: string[] | undefined,
  ): Promise<{ redirectUrl: string }> {
    const notFound = new NotFoundException('Authorization request not found, expired or already used');
    const now = this.now();
    const req = await this.requestModel
      .findOne({ requestHash, usedAt: { $exists: true } })
      .lean<OAuthAuthRequest & { _id: Types.ObjectId }>()
      .exec();
    if (!req || !req.usedAt || !req.decidedBy || !req.decision) throw notFound;
    if (!req.decidedBy.equals(userId) || req.decision !== decision) throw notFound;
    if (now - req.usedAt.getTime() > DECISION_RETRY_WINDOW_MS) throw notFound;

    if (decision === 'approve') {
      if (!req.apiKeyId) throw notFound;
      const key = await this.apiKeyModel
        .findOne({ _id: req.apiKeyId, userId, kind: 'oauth', active: true, oauthPending: true })
        .lean<ApiKey>()
        .exec();
      if (!key || (key.expiresAt && key.expiresAt.getTime() <= now)) throw notFound;
      if (!sameProjectSelection(key, projectIds)) throw notFound;
      if (!(await this.findLiveClient(req.clientId))) throw notFound;
    }

    // Compare-and-set, so two parallel repeats cannot both mint a code.
    const claimed = await this.requestModel
      .findOneAndUpdate(
        { _id: req._id, retriedAt: req.retriedAt ?? { $exists: false } },
        { $set: { retriedAt: new Date(now) } },
      )
      .lean<OAuthAuthRequest>()
      .exec();
    if (!claimed) throw notFound;

    if (decision === 'deny' || !req.apiKeyId) return { redirectUrl: this.denyRedirect(req) };
    await this.codeModel.deleteMany({ apiKeyId: req.apiKeyId, usedAt: { $exists: false } }).exec();
    return { redirectUrl: await this.issueCode(req, req.apiKeyId, userId) };
  }

  private denyRedirect(req: OAuthAuthRequest): string {
    const redirect = new URL(req.redirectUri);
    redirect.searchParams.set('error', 'access_denied');
    if (req.state !== undefined) redirect.searchParams.set('state', req.state);
    return redirect.href;
  }

  /** Mints a 60 s code for the connection and returns the client redirect carrying it. */
  private async issueCode(req: OAuthAuthRequest, apiKeyId: Types.ObjectId, userId: Types.ObjectId): Promise<string> {
    const code = newAuthCode();
    await this.codeModel.create({
      codeHash: hashSecret(code),
      clientId: req.clientId,
      apiKeyId,
      userId,
      redirectUri: req.redirectUri,
      codeChallenge: req.codeChallenge,
      scopes: req.scopes,
      resource: req.resource,
      expiresAt: new Date(this.now() + AUTH_CODE_TTL_MS),
    });
    const redirect = new URL(req.redirectUri);
    redirect.searchParams.set('code', code);
    if (req.state !== undefined) redirect.searchParams.set('state', req.state);
    return redirect.href;
  }

  private validateProjectIds(projectIds: unknown): string[] | undefined {
    if (projectIds === undefined) return undefined;
    if (!Array.isArray(projectIds) || projectIds.length === 0) {
      throw new BadRequestException('projectIds must be a non-empty list; omit it for an unrestricted connection');
    }
    if (projectIds.length > MAX_PROJECT_IDS) {
      throw new BadRequestException(`at most ${MAX_PROJECT_IDS} projectIds are allowed`);
    }
    const ids = new Set<string>();
    for (const id of projectIds) {
      if (typeof id !== 'string' || !Types.ObjectId.isValid(id)) {
        throw new BadRequestException('Invalid projectId');
      }
      ids.add(new Types.ObjectId(id).toString());
    }
    return [...ids];
  }

  /** Customers linked (active or paused, not archived) to any of the projects. */
  private async customersLinkedTo(projectIds: string[]): Promise<string[]> {
    const links = await this.linkModel
      .find({
        projectId: { $in: projectIds.map((id) => new Types.ObjectId(id)) },
        status: { $ne: CustomerProjectLinkStatus.ARCHIVED },
      })
      .lean<CustomerProjectLink[]>()
      .exec();
    return [...new Set(links.map((l) => l.customerId.toString()))];
  }

  // ------------------------------------------------------------------ codes

  /**
   * Loads a code for redemption. A code that was already redeemed is a
   * replay: per RFC 6749 §4.1.2 everything issued from it is revoked. This
   * check runs here too because the SDK's token handler asks for the PKCE
   * challenge before it calls `exchangeCode`.
   */
  private async loadCode(clientId: string, code: string): Promise<OAuthCode & { _id: Types.ObjectId }> {
    if (!isSecretString(code)) throw new InvalidGrantError('Invalid authorization code');
    const doc = await this.codeModel
      .findOne({ codeHash: hashSecret(code) })
      .lean<OAuthCode & { _id: Types.ObjectId }>()
      .exec();
    if (!doc) throw new InvalidGrantError('Invalid authorization code');
    if (doc.usedAt) {
      this.logger.warn(`OAuth authorization code replayed; revoking connection ${doc.apiKeyId.toString()}`);
      await this.revokeConnection(doc.apiKeyId.toString(), 'code_replay');
      throw new InvalidGrantError('Authorization code already used');
    }
    if (doc.clientId !== clientId) throw new InvalidGrantError('Invalid authorization code');
    if (doc.expiresAt.getTime() <= this.now()) throw new InvalidGrantError('Authorization code expired');
    return doc;
  }

  async challengeForCode(clientId: string, code: string): Promise<string> {
    const doc = await this.loadCode(clientId, code);
    return doc.codeChallenge;
  }

  /**
   * Redeems a code. PKCE is checked here and is mandatory: a missing
   * verifier fails closed. The SDK token handler forwards the verifier
   * because the provider sets `skipLocalPkceValidation`.
   * `redirectUri` must equal the one of the authorization request when sent.
   */
  async exchangeCode(
    clientId: string,
    code: string,
    verifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const doc = await this.loadCode(clientId, code);
    if (typeof verifier !== 'string' || !verifyPkce(verifier, doc.codeChallenge)) {
      throw new InvalidGrantError('code_verifier does not match the challenge');
    }
    if (redirectUri !== undefined && redirectUri !== doc.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match the authorization request');
    }
    if (resource !== undefined && canonicalResource(resource) !== doc.resource) {
      throw new InvalidTargetError('resource does not match the authorization request');
    }

    const consumed = await this.codeModel
      .findOneAndUpdate({ _id: doc._id, usedAt: { $exists: false } }, { $set: { usedAt: new Date(this.now()) } })
      .lean<OAuthCode>()
      .exec();
    if (!consumed) {
      // Lost a race against a parallel redemption of the same code: also a replay.
      await this.revokeConnection(doc.apiKeyId.toString(), 'code_replay');
      throw new InvalidGrantError('Authorization code already used');
    }
    if (!(await this.findActiveConnection(doc.apiKeyId))) {
      throw new InvalidGrantError('Connection was revoked');
    }
    // First redemption: the provisional connection becomes a real one.
    // Returns the document as it was before, so `oauthPending` tells whether
    // this was the first redemption.
    const activated = await this.apiKeyModel
      .findOneAndUpdate(
        { _id: doc.apiKeyId, kind: 'oauth', active: true },
        { $set: { expiresAt: new Date(this.now() + CONNECTION_TTL_MS) }, $unset: { oauthPending: '' } },
      )
      .lean<ApiKey>()
      .exec();
    // Revoked between the check above and here: mint no orphan tokens.
    if (!activated) throw new InvalidGrantError('Connection was revoked');
    if (activated.oauthPending) await this.revokeReplaced(doc.apiKeyId, activated);
    return this.issueTokens(
      { clientId: doc.clientId, apiKeyId: doc.apiKeyId, userId: doc.userId, resource: doc.resource },
      'authorization_code',
    );
  }

  /**
   * Re-authorizing a client (new login after a lost session, reconnect)
   * creates a new connection; the user's older connections to the SAME
   * client are revoked so they do not pile up in "connected apps". Other
   * clients and other users are untouched.
   */
  private async revokeReplaced(current: Types.ObjectId, key: ApiKey): Promise<void> {
    if (typeof key.oauthClientId !== 'string' || !key.oauthClientId) return;
    const others = await this.apiKeyModel
      .find({
        userId: key.userId,
        kind: 'oauth',
        active: true,
        oauthClientId: key.oauthClientId,
        _id: { $ne: current },
      })
      .select('_id')
      .lean<{ _id: Types.ObjectId }[]>()
      .exec();
    for (const other of others) {
      await this.revokeConnection(other._id.toString(), 'replaced');
    }
  }

  // ------------------------------------------------------------------ tokens

  private async issueTokens(grant: TokenGrant, grantType: GrantType): Promise<OAuthTokens> {
    const now = this.now();
    const accessToken = newAccessToken();
    const refreshToken = newRefreshToken();
    const base = {
      clientId: grant.clientId,
      apiKeyId: grant.apiKeyId,
      userId: grant.userId,
      resource: grant.resource,
      scopes: [OAUTH_SCOPE],
    };
    await this.tokenModel.create({
      ...base,
      tokenHash: hashSecret(accessToken),
      type: 'access',
      expiresAt: new Date(now + ACCESS_TOKEN_TTL_MS),
    });
    await this.tokenModel.create({
      ...base,
      tokenHash: hashSecret(refreshToken),
      type: 'refresh',
      expiresAt: new Date(now + REFRESH_TOKEN_TTL_MS),
    });
    // Only the first issuance per connection: routine hourly refreshes would
    // flood the trail (refresh misuse and revocations are audited separately).
    // Never the tokens themselves, not even a prefix of them.
    if (grantType === 'authorization_code') {
      await this.auditLog.record({
        action: 'oauth.token.issued',
        entityType: 'apikey',
        entityId: grant.apiKeyId.toString(),
        meta: { clientId: grant.clientId, grant: grantType },
        actor: { userId: grant.userId.toString(), apiKeyId: grant.apiKeyId.toString() },
      });
    }
    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: refreshToken,
      scope: OAUTH_SCOPE,
    };
  }

  private async findToken(
    token: unknown,
    type: OAuthTokenType,
  ): Promise<(OAuthToken & { _id: Types.ObjectId }) | null> {
    const prefix = type === 'access' ? ACCESS_TOKEN_PREFIX : REFRESH_TOKEN_PREFIX;
    if (!isSecretString(token) || !token.startsWith(prefix)) return null;
    return this.tokenModel
      .findOne({ tokenHash: hashSecret(token), type })
      .lean<OAuthToken & { _id: Types.ObjectId }>()
      .exec();
  }

  /**
   * Rotating refresh (each refresh token works once). A rotated token
   * presented again within {@link REFRESH_REUSE_GRACE_MS} is treated as a
   * race or retry (`invalid_grant`, connection stays); later it is treated
   * as theft and the whole connection is revoked.
   */
  async exchangeRefresh(clientId: string, refreshToken: string, resource?: URL): Promise<OAuthTokens> {
    const doc = await this.findToken(refreshToken, 'refresh');
    if (!doc || doc.clientId !== clientId) throw new InvalidGrantError('Invalid refresh token');
    const now = this.now();
    if (doc.replacedAt) {
      if (now - doc.replacedAt.getTime() > REFRESH_REUSE_GRACE_MS) {
        this.logger.warn(`OAuth refresh token reused; revoking connection ${doc.apiKeyId.toString()}`);
        await this.auditLog.record({
          action: 'oauth.refresh.reused',
          entityType: 'apikey',
          entityId: doc.apiKeyId.toString(),
          meta: { clientId: doc.clientId, replacedAt: doc.replacedAt },
          actor: { userId: doc.userId.toString(), apiKeyId: doc.apiKeyId.toString() },
        });
        await this.revokeConnection(doc.apiKeyId.toString(), 'refresh_replay');
      }
      throw new InvalidGrantError('Refresh token already used');
    }
    if (doc.expiresAt.getTime() <= now) throw new InvalidGrantError('Refresh token expired');
    if (resource !== undefined && canonicalResource(resource) !== doc.resource) {
      throw new InvalidTargetError('resource does not match the grant');
    }
    if (!(await this.findActiveConnection(doc.apiKeyId))) {
      throw new InvalidGrantError('Connection was revoked');
    }

    const rotated = await this.tokenModel
      .findOneAndUpdate({ _id: doc._id, replacedAt: { $exists: false } }, { $set: { replacedAt: new Date(now) } })
      .lean<OAuthToken>()
      .exec();
    // A parallel refresh with the same token won; it got the new pair.
    if (!rotated) throw new InvalidGrantError('Refresh token already used');
    // A connection in use stays alive: another year from the last refresh.
    await this.apiKeyModel
      .updateOne(
        { _id: doc.apiKeyId, kind: 'oauth', active: true, oauthPending: { $ne: true } },
        { $set: { expiresAt: new Date(now + CONNECTION_TTL_MS) } },
      )
      .exec();

    return this.issueTokens(
      { clientId: doc.clientId, apiKeyId: doc.apiKeyId, userId: doc.userId, resource: doc.resource },
      'refresh_token',
    );
  }

  /**
   * Checked on every MCP request, so revocation takes effect immediately.
   * The token must be bound to our resource (audience check); with OAuth
   * unconfigured no token is valid.
   */
  async verifyAccessToken(token: string): Promise<OAuthAccessTokenInfo> {
    const resource = this.options.resource;
    const doc = await this.findToken(token, 'access');
    if (!doc || doc.expiresAt.getTime() <= this.now()) throw new InvalidTokenError('Invalid or expired access token');
    if (!resource || doc.resource !== resource) throw new InvalidTokenError('Invalid or expired access token');
    const connection = await this.findActiveConnection(doc.apiKeyId);
    if (!connection) throw new InvalidTokenError('Invalid or expired access token');
    await this.touchConnection(doc.apiKeyId, connection.lastUsedAt);
    return {
      apiKeyId: doc.apiKeyId.toString(),
      clientId: doc.clientId,
      expiresAt: Math.floor(doc.expiresAt.getTime() / 1000),
      resource: doc.resource,
    };
  }

  /** "Last used" for the connected-apps list, written at most once a minute. */
  private async touchConnection(apiKeyId: Types.ObjectId, lastUsedAt: Date | undefined): Promise<void> {
    const now = this.now();
    if (lastUsedAt && now - lastUsedAt.getTime() < LAST_USED_WRITE_INTERVAL_MS) return;
    await this.apiKeyModel.updateOne({ _id: apiKeyId }, { $set: { lastUsedAt: new Date(now) } }).exec();
  }

  private async findActiveConnection(apiKeyId: Types.ObjectId): Promise<ApiKey | null> {
    const key = await this.apiKeyModel
      .findOne({ _id: apiKeyId, kind: 'oauth', active: true })
      .lean<ApiKey>()
      .exec();
    if (!key) return null;
    if (key.expiresAt && key.expiresAt.getTime() <= this.now()) return null;
    return key;
  }

  // ------------------------------------------------------------------ revocation

  /**
   * Revokes a connection: hidden key inactive, all its tokens and codes
   * deleted, {@link OAUTH_CONNECTION_REVOKED} emitted so open MCP sessions of
   * the connection can be closed. Unknown ids are ignored.
   */
  async revokeConnection(apiKeyId: string, reason: OAuthRevokeReason = 'user'): Promise<void> {
    if (typeof apiKeyId !== 'string' || !Types.ObjectId.isValid(apiKeyId)) return;
    const id = new Types.ObjectId(apiKeyId);
    // Only an active connection is switched off (and reported); tokens and
    // codes are cleared either way.
    const before = await this.apiKeyModel
      .findOneAndUpdate({ _id: id, kind: 'oauth', active: true }, { $set: { active: false } })
      .lean<ApiKey>()
      .exec();
    await this.tokenModel.deleteMany({ apiKeyId: id }).exec();
    await this.codeModel.deleteMany({ apiKeyId: id }).exec();
    if (before) {
      const payload: OAuthConnectionRevokedEvent = { apiKeyId: id.toString(), reason };
      this.events.emit(OAUTH_CONNECTION_REVOKED, payload);
      await this.auditLog.record({
        action: 'oauth.connection.revoked',
        entityType: 'apikey',
        entityId: id.toString(),
        meta: {
          reason,
          clientId: before.oauthClientId,
          clientName: before.oauthClientName,
          ownerUserId: before.userId.toString(),
        },
      });
    }
  }

  // ------------------------------------------------------------------ connected apps

  /**
   * The user's connections that currently grant access ("connected apps"):
   * active, not expired, and redeemed (pending approvals are left out).
   */
  async listConnections(userId: string): Promise<OAuthConnectionInfo[]> {
    if (typeof userId !== 'string' || !Types.ObjectId.isValid(userId)) return [];
    const keys = await this.apiKeyModel
      .find({ userId: new Types.ObjectId(userId), kind: 'oauth', active: true, oauthPending: { $ne: true } })
      .select('-keyHash')
      .sort({ createdAt: -1 })
      .lean<(ApiKey & { _id: Types.ObjectId })[]>()
      .exec();
    const now = this.now();
    return keys
      .filter((k) => !k.expiresAt || k.expiresAt.getTime() > now)
      .map((k) => ({
        id: k._id.toString(),
        clientId: k.oauthClientId ?? '',
        clientName: k.oauthClientName ?? k.name,
        projectScopeMode: k.projectScopeMode,
        allowedProjectIds: (k.allowedProjectIds ?? []).map(String),
        createdAt: k.createdAt,
        lastUsedAt: k.lastUsedAt,
        expiresAt: k.expiresAt,
      }));
  }

  /** Revokes one of the user's own connections; anything else is 404. */
  async revokeOwnConnection(userId: string, apiKeyId: string): Promise<void> {
    if (typeof userId !== 'string' || !Types.ObjectId.isValid(userId)) {
      throw new NotFoundException('Connection not found');
    }
    await this.revokeMatching({ userId: new Types.ObjectId(userId) }, apiKeyId, 'user');
  }

  /** Admin: revokes any user's connection; standard API keys are 404. */
  async revokeAnyConnection(apiKeyId: string): Promise<void> {
    await this.revokeMatching({}, apiKeyId, 'admin');
  }

  private async revokeMatching(
    owner: { userId?: Types.ObjectId },
    apiKeyId: string,
    reason: OAuthRevokeReason,
  ): Promise<void> {
    if (typeof apiKeyId !== 'string' || !Types.ObjectId.isValid(apiKeyId)) {
      throw new NotFoundException('Connection not found');
    }
    const id = new Types.ObjectId(apiKeyId);
    const key = await this.apiKeyModel
      .findOne({ _id: id, kind: 'oauth', active: true, ...owner })
      .select('_id')
      .lean()
      .exec();
    if (!key) throw new NotFoundException('Connection not found');
    await this.revokeConnection(id.toString(), reason);
  }

  /** Revokes every active OAuth connection of a user; returns how many. */
  async revokeAllForUser(userId: string): Promise<number> {
    if (typeof userId !== 'string' || !Types.ObjectId.isValid(userId)) return 0;
    const keys = await this.apiKeyModel
      .find({ userId: new Types.ObjectId(userId), kind: 'oauth', active: true })
      .select('_id')
      .lean<{ _id: Types.ObjectId }[]>()
      .exec();
    for (const key of keys) {
      await this.revokeConnection(key._id.toString(), 'account');
    }
    return keys.length;
  }

  /**
   * RFC 7009 token revocation. Unknown tokens and tokens of other clients
   * are ignored silently. Revoking a refresh token ends the whole grant
   * (connection); revoking an access token removes only that token.
   */
  async revokeToken(clientId: string, token: string): Promise<void> {
    if (!isSecretString(token)) return;
    const type: OAuthTokenType | null = token.startsWith(ACCESS_TOKEN_PREFIX)
      ? 'access'
      : token.startsWith(REFRESH_TOKEN_PREFIX)
        ? 'refresh'
        : null;
    if (!type) return;
    const doc = await this.findToken(token, type);
    if (!doc || doc.clientId !== clientId) return;
    if (type === 'access') {
      await this.tokenModel.deleteOne({ _id: doc._id }).exec();
      return;
    }
    await this.revokeConnection(doc.apiKeyId.toString(), 'token_revocation');
  }
}
