import { NestFactory } from '@nestjs/core';
import { HttpException, Logger, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { json } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { AppModule } from './app.module';
import { MongooseErrorFilter } from './common/mongoose-error.filter';
import { runObjectIdMigrationOnce } from './common/objectid-migration.boot';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { ProjectsService } from './projects/projects.service';
import { TodosService } from './todos/todos.service';
import { SessionsService } from './sessions/sessions.service';
import { KnowledgeService } from './knowledge/knowledge.service';
import { ChangelogService } from './changelog/changelog.service';
import { MilestonesService } from './milestones/milestones.service';
import { ActivitiesService } from './activities/activities.service';
import { PushService } from './push/push.service';
import { EnvironmentsService } from './environments/environments.service';
import { SecretsService } from './secrets/secrets.service';
import { ManualsService } from './manuals/manuals.service';
import { ResearchService } from './research/research.service';
import { ResearchControlService } from './research/research-control.service';
import { ResearchTopicService } from './research-agent/research-topic.service';
import { ResearchRunService } from './research-agent/research-run.service';
import { ResearchArtifactService } from './research-agent/research-artifact.service';
import { ResearchAgentService } from './research-agent/research-agent.service';
import { SettingsService } from './settings/settings.service';
import { NotificationsService } from './notifications/notifications.service';
import { SchemasService } from './schemas/schemas.service';
import { DependenciesService } from './dependencies/dependencies.service';
import { FeaturesService } from './features/features.service';
import { SoulsService } from './souls/souls.service';
import { HarnessService } from './harness/harness.service';
import { CommitsService } from './commits/commits.service';
import { RagService } from './rag/rag.service';
import { RecurringTasksService } from './recurring-tasks/recurring-tasks.service';
import { WorkflowsService } from './workflows/workflows.service';
import { WorkflowEngineService } from './workflows/engine/workflow-engine.service';
import { NodeRegistry } from './workflows/engine/node-registry';
import { CustomerTemplatesService } from './customer-templates/customer-templates.service';
import { ValidationReportsService } from './validation-reports/validation-reports.service';
import { DocUpdateProposalsService } from './doc-update-proposals/doc-update-proposals.service';
import { KnowledgeGraphService } from './knowledge-graph/knowledge-graph.service';
import { OracleService } from './oracle/oracle.service';
import { SnippetsService } from './snippets/snippets.service';
import { AttachmentsService } from './attachments/attachments.service';
import { QuestionsService } from './questions/questions.service';
import { LogsService } from './logs/logs.service';
import { ReleasesService } from './releases/releases.service';
import { ChatService } from './chat/chat.service';
import { ChatLlmService } from './chat/chat-llm.service';
import { ChatContextService } from './chat/chat-context.service';
import { WebSearchService } from './web-search/services/web-search.service';
import { ReadabilityService } from './web-search/services/readability.service';
import { WorkspacesService } from './workspaces/workspaces.service';
import { TERMINAL_TOKEN_TTL, WorkspaceCliTokenService } from './workspaces/workspace-cli-token.service';
import { WorkspaceClient } from './workspaces/workspace-client.service';
import { FS_FILE_BODY_LIMIT_BYTES, WorkspaceLimitsService } from './workspaces/workspace-limits.service';
import { createFsFileBodyMiddleware } from './workspaces/fs-file-body.middleware';
import { WorkspaceGitTokensService } from './workspaces/workspace-git-tokens.service';
import { SshService } from './ssh/ssh.service';
import { SshSessionService } from './ssh/ssh-session.service';
import { bridgeSshTerminal, rawDataToString, toPtySize } from './ssh/ssh-terminal-bridge';
import { SshWorkspaceAccess, isSshWorkspace } from './workspaces/ssh-workspace-access.service';
import { StacksService } from './stacks/stacks.service';
import { KubeClustersService } from './kube/kube-clusters.service';
import { KubeResourcesService } from './kube/kube-resources.service';
import { KubeLogsService } from './kube/kube-logs.service';
import { KubeClientService } from './kube/kube-client.service';
import { KubeAuditService } from './kube/kube-audit.service';
import { KubeWritesService } from './kube/kube-writes.service';
import { Types as MongoTypes } from 'mongoose';
import { CustomersService } from './customers/customers.service';
import { ContactsService } from './contacts/contacts.service';
import { MonitoringService } from './monitoring/monitoring.service';
import { HttpRequestsService } from './http-requests/http-requests.service';
import { getToolCatalog, registerMcpTools, McpServices } from './mcp-tools';
import { ApiKey } from './api-keys/schemas/api-key.schema';
import { ApiKeysService } from './api-keys/api-keys.service';
import { AuthService } from './auth/auth.service';
import { isProjectEventVisible, isQuestionEventVisible } from './events/event-visibility';
import { JwtService } from '@nestjs/jwt';
import WebSocket, { WebSocketServer } from 'ws';
import { isRecord } from './common/narrow';
import { RequestContext, RequestUser } from './common/request-context';
import { actorFromApiKey, actorFromUser } from './common/actor-scope';
import { actorMayWriteContent } from './common/scope-guard';
import { actorCanAccessProject } from './common/permissions';
import { resolveTrustProxy } from './common/trust-proxy';
import { EventsBusService, QuestionEvent } from './events/events-bus.service';
import { ProjectChangeEvent } from './events/project-event';
import { Subscription } from 'rxjs';
import { ScalarQueryPipe } from './common/scalar-query.pipe';
import { accessTokenUserId } from './common/access-token';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OAUTH_CONNECTION_REVOKED, OAuthService } from './oauth/oauth.service';
import { oauthConfig } from './oauth/oauth-config';
import { mcpServerInfo } from './mcp-server-info';
import { createOAuthRouter } from './oauth/oauth-provider';
import {
  McpRequest,
  McpSessionOwners,
  closeSessionsOnRevoke,
  createMcpAuthMiddleware,
  createStreamableHttpHandler,
  singleValue,
} from './mcp-http-auth';

function createMcpServer(services: McpServices): Server {
  const server = new Server(
    mcpServerInfo(),
    // M-35: declare `resources` capability so registerMcpTools can install
    // the ListResources/ReadResource handlers for the MCP Apps extension
    // (io.modelcontextprotocol/ui). Without this the SDK throws
    // "Server does not support resources" at handler-registration time
    // and the per-session SSE bootstrap dies with HTTP 500.
    { capabilities: { tools: {}, resources: {} } },
  );
  registerMcpTools(server, services);
  return server;
}

/** How often /messages re-checks the API key behind an open SSE session. */
const MCP_SESSION_REVALIDATE_MS = 60_000;

/**
 * Adapter für einen async `upgrade`-Handler.
 *
 * EventEmitter-Handler dürfen kein Promise zurückgeben: eine Rejection bliebe
 * unbehandelt, und Node beendet dann standardmäßig den Prozess. Ein
 * fehlgeschlagener Terminal-Upgrade hätte also die gesamte API mitgenommen.
 * Jetzt wird der Socket geschlossen und der Fehler protokolliert.
 */
function onUpgradeAsync(
  handler: (
    req: import('http').IncomingMessage,
    socket: import('net').Socket,
    head: Buffer,
  ) => Promise<void>,
): (req: import('http').IncomingMessage, socket: import('net').Socket, head: Buffer) => void {
  return (req, socket, head) => {
    handler(req, socket, head).catch((err: unknown) => {
      console.error('WebSocket-Upgrade gescheitert:', err);
      socket.destroy();
    });
  };
}

/** Wie `onUpgradeAsync`, aber für beliebige void-erwartende Callbacks. */
function voidAsync<A extends unknown[]>(
  handler: (...args: A) => Promise<void>,
  onError?: (err: unknown, ...args: A) => void,
): (...args: A) => void {
  return (...args: A) => {
    handler(...args).catch((err: unknown) => {
      console.error('Asynchroner Handler gescheitert:', err);
      onError?.(err, ...args);
    });
  };
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });
  // T-510: vor allem, was abfragt (onModuleInit-Hooks laufen erst mit listen).
  await runObjectIdMigrationOnce(app.get<Connection>(getConnectionToken()));

  const expressApp = app.getHttpAdapter().getInstance();

  // Muss VOR allem anderen stehen: Express wertet `X-Forwarded-For`/`X-Real-IP`
  // nur aus, wenn `trust proxy` gesetzt ist, und `req.ip` hängt davon ab.
  // Ohne das war `req.ip` für jeden Request die Adresse des nginx-Containers —
  // damit war das Login-Throttling ein globaler Eimer (fünf Fehlversuche
  // irgendeines Clients sperrten die ganze Instanz), die IP-Bindung der
  // Refresh-Tokens toter Code und jedes `ipAddress` im Audit-Log wertlos.
  // Siehe common/trust-proxy.ts für die Herleitung und den Default.
  const trustProxy = resolveTrustProxy(process.env.TRUST_PROXY);
  expressApp.set('trust proxy', trustProxy);
  // Geloggt, weil die Einstellung sonst unsichtbar ist und ein falsch
  // gesetzter Wert zwei sehr verschiedene Fehlerbilder hat: `false` hinter
  // einem Proxy macht das Throttling wieder global, `1` ohne Proxy macht es
  // per Header umgehbar.
  new Logger('Bootstrap').log(
    `trust proxy = ${JSON.stringify(trustProxy)} (TRUST_PROXY=${process.env.TRUST_PROXY ?? 'unset → Default'})`,
  );

  // The IDE save route carries a whole file as JSON (editor hard max, escaped),
  // which is more than the global limit below. The raised limit applies to that
  // route only and only to an authenticated caller (this runs before the Nest
  // guards): see fs-file-body.middleware.ts.
  const fsAuthService = app.get(AuthService);
  const fsApiKeys = app.get(ApiKeysService);
  const fsJwt = app.get(JwtService);
  const fsLimits = app.get(WorkspaceLimitsService);
  expressApp.use(createFsFileBodyMiddleware({
    authenticate: async (req: Request) => {
      if (!fsAuthService.isAuthEnabled()) return true;
      const header = req.headers.authorization;
      if (!header?.startsWith('Bearer ')) return false;
      const token = header.slice(7);
      if (token.startsWith('cv_')) {
        const key = await fsApiKeys.validate(token);
        // A key with a tool allowlist is MCP-only and gets no REST access.
        if (!key || Array.isArray(key.allowedTools)) return false;
        const owner = await fsAuthService.findUserById(key.userId.toString());
        return !!owner && owner.active !== false;
      }
      let userId: string | null;
      try {
        userId = accessTokenUserId(fsJwt.verify<object>(token));
      } catch {
        return false;
      }
      if (!userId) return false;
      const user = await fsAuthService.findUserById(userId);
      return !!user && user.active !== false;
    },
    editorLimit: async () => (await fsLimits.get()).editorMaxBytes,
    bigLimitBytes: FS_FILE_BODY_LIMIT_BYTES,
    parser: json({ limit: FS_FILE_BODY_LIMIT_BYTES }),
  }));

  // MCP OAuth authorization server (/authorize, /token, /register, /revoke,
  // /.well-known/oauth-*). Mounted before the global 100 MB JSON parser so
  // the SDK handlers keep their own small body limits.
  const mcpOAuth = oauthConfig();
  const bootLogger = new Logger('Bootstrap');
  if (mcpOAuth.enabled && mcpOAuth.baseUrl && mcpOAuth.resourceUrl) {
    expressApp.use(createOAuthRouter(app.get(OAuthService), {
      baseUrl: mcpOAuth.baseUrl,
      resourceUrl: mcpOAuth.resourceUrl,
    }));
    bootLogger.log(`MCP OAuth on: issuer ${mcpOAuth.baseUrl.href}, resource ${mcpOAuth.resourceUrl.href}`);
  } else {
    bootLogger.log(`MCP OAuth off${mcpOAuth.problem ? ` (${mcpOAuth.problem})` : ' (PUBLIC_BASE_URL unset)'}`);
  }

  // JSON body parser for all routes (100MB limit for MCP + replication payloads with attachments)
  expressApp.use(json({ limit: '100mb' }));

  // =========================================================================
  // MCP HTTP Transport — registered BEFORE NestJS routes
  // =========================================================================
  const services: McpServices = {
    projectsService: app.get(ProjectsService),
    todosService: app.get(TodosService),
    sessionsService: app.get(SessionsService),
    knowledgeService: app.get(KnowledgeService),
    changelogService: app.get(ChangelogService),
    milestonesService: app.get(MilestonesService),
    activitiesService: app.get(ActivitiesService),
    pushService: app.get(PushService),
    environmentsService: app.get(EnvironmentsService),
    secretsService: app.get(SecretsService),
    manualsService: app.get(ManualsService),
    researchService: app.get(ResearchService),
    researchControlService: app.get(ResearchControlService),
    researchTopicService: app.get(ResearchTopicService),
    researchRunService: app.get(ResearchRunService),
    researchArtifactService: app.get(ResearchArtifactService),
    researchAgentService: app.get(ResearchAgentService),
    settingsService: app.get(SettingsService),
    notificationsService: app.get(NotificationsService),
    schemasService: app.get(SchemasService),
    dependenciesService: app.get(DependenciesService),
    featuresService: app.get(FeaturesService),
    soulsService: app.get(SoulsService),
    harnessService: app.get(HarnessService),
    commitsService: app.get(CommitsService),
    ragService: app.get(RagService),
    recurringTasksService: app.get(RecurringTasksService),
    workflowsService: app.get(WorkflowsService),
    workflowEngineService: app.get(WorkflowEngineService),
    nodeRegistry: app.get(NodeRegistry),
    customerTemplatesService: app.get(CustomerTemplatesService),
    validationReportsService: app.get(ValidationReportsService),
    docUpdateProposalsService: app.get(DocUpdateProposalsService),
    knowledgeGraphService: app.get(KnowledgeGraphService),
    oracleService: app.get(OracleService),
    snippetsService: app.get(SnippetsService),
    attachmentsService: app.get(AttachmentsService),
    questionsService: app.get(QuestionsService),
    authService: app.get(AuthService),
    customersService: app.get(CustomersService),
    contactsService: app.get(ContactsService),
    monitoringService: app.get(MonitoringService),
    httpRequestsService: app.get(HttpRequestsService),
    logsService: app.get(LogsService),
    releasesService: app.get(ReleasesService),
    chatService: app.get(ChatService),
    chatLlmService: app.get(ChatLlmService),
    chatContextService: app.get(ChatContextService),
    webSearchService: app.get(WebSearchService),
    readabilityService: app.get(ReadabilityService),
    workspacesService: app.get(WorkspacesService),
    workspaceClient: app.get(WorkspaceClient),
    workspaceGitTokens: app.get(WorkspaceGitTokensService),
    workspaceCliToken: app.get(WorkspaceCliTokenService),
    sshService: app.get(SshService),
    sshSessionService: app.get(SshSessionService),
    stackService: app.get(StacksService),
    kubeClustersService: app.get(KubeClustersService),
    kubeResourcesService: app.get(KubeResourcesService),
    kubeLogsService: app.get(KubeLogsService),
    kubeClientService: app.get(KubeClientService),
    kubeAuditService: app.get(KubeAuditService),
    kubeWritesService: app.get(KubeWritesService),
  };

  const transports: Record<string, SSEServerTransport | StreamableHTTPServerTransport> = {};
  // Cache the user AND api-key for SSE sessions — /messages must restore both
  // to the RequestContext so apiKey.allowedTools is honored on tool calls.
  // `validatedAt`: last time the key/owner were re-checked (see /messages).
  const authenticatedSessions = new Map<string, { user: RequestUser; apiKey?: ApiKey; validatedAt: number }>();
  // Track sessions that closed recently so /messages can tell "never heard of
  // this id" from "this session lived but was just torn down" — useful both
  // for diagnostics on the transient 400 path and for a short grace window
  // when a POST raced the close handler.
  const recentlyClosedSessions = new Map<string, number>();
  const RECENT_CLOSED_TTL_MS = 60_000;
  // Idempotency guard against rapid duplicate retries: if the same
  // (sessionId, jsonrpc.id) lands twice in a short window, refuse to dispatch
  // the second time so we don't double-create write-side effects (e.g.
  // double manual_create when a client retried after a transient 400).
  const inFlightRequests = new Map<string, number>();
  const IN_FLIGHT_TTL_MS = 30_000;
  const mcpLogger = new Logger('McpTransport');

  const pruneRecentlyClosed = () => {
    const cutoff = Date.now() - RECENT_CLOSED_TTL_MS;
    for (const [sid, ts] of recentlyClosedSessions) {
      if (ts < cutoff) recentlyClosedSessions.delete(sid);
    }
  };
  const pruneInFlight = () => {
    const cutoff = Date.now() - IN_FLIGHT_TTL_MS;
    for (const [key, ts] of inFlightRequests) {
      if (ts < cutoff) inFlightRequests.delete(key);
    }
  };

  // Wait briefly (up to ~1500ms) for a session to appear/recover. Covers the
  // race where a /messages POST hits between res.on('close') firing and the
  // client's reconnect (the reconnect creates a NEW sessionId, so we can't
  // resurrect the old one — but we *can* avoid the false 400 if the close
  // handler is still completing the delete).
  const waitForTransport = async (
    sessionId: string,
  ): Promise<SSEServerTransport | StreamableHTTPServerTransport | undefined> => {
    const direct = transports[sessionId];
    if (direct) return direct;
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 150));
      const t = transports[sessionId];
      if (t) return t;
    }
    return undefined;
  };

  // API Key auth middleware for MCP endpoints
  const apiKeysService = app.get(ApiKeysService);
  const authService = app.get(AuthService);

  const getPublicOrigin = (req: Request) => {
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const proto = forwardedProto || req.protocol || 'http';
    return `${proto}://${req.get('host')}`;
  };

  const getMcpDiscoveryPayload = () => {
    const toolCatalog = getToolCatalog();
    const toolsByGroup = toolCatalog.reduce<Record<string, number>>((acc, tool) => {
      acc[tool.group] = (acc[tool.group] || 0) + 1;
      return acc;
    }, {});

    return {
      schemaVersion: 'devgrimoire.mcp.discovery.v1',
      name: 'DevGrimoire',
      version: process.env.npm_package_version || '1.0.0',
      description: 'Persistent project memory and tool server for DevGrimoire via MCP.',
      transports: [
        {
          type: 'streamable-http',
          protocolVersion: '2025-11-25',
          endpoint: '/mcp',
          methods: ['POST', 'GET', 'DELETE'],
        },
        {
          type: 'sse',
          protocolVersion: '2024-11-05',
          endpoint: '/sse',
          messageEndpoint: '/messages',
        },
      ],
      auth: {
        required: authService.isAuthEnabled(),
        schemes: mcpOAuth.enabled ? ['devgrimoire-api-key', 'oauth2'] : ['devgrimoire-api-key'],
        headerName: 'Authorization',
        headerScheme: 'Bearer',
        apiKeyPrefix: 'cv_',
        queryParameter: 'apiKey',
        // OAuth (authorization code + PKCE) only on /mcp; the SSE paths stay API-key only.
        ...(mcpOAuth.enabled && mcpOAuth.resourceUrl
          ? {
            oauth: {
              endpoint: '/mcp',
              resource: mcpOAuth.resourceUrl.href,
              protectedResourceMetadata: '/.well-known/oauth-protected-resource/mcp',
              authorizationServerMetadata: '/.well-known/oauth-authorization-server',
            },
          }
          : {}),
      },
      capabilities: {
        tools: true,
        toolCount: toolCatalog.length,
        writeToolCount: toolCatalog.filter((tool) => tool.isWrite).length,
        groups: toolsByGroup,
      },
      links: {
        toolCatalog: '/api/mcp/tools',
        streamableHttp: '/mcp',
        sse: '/sse',
        registryManifest: '/server.json',
        documentation: '/docs',
      },
      privacy: {
        public: true,
        containsSecrets: false,
        note: 'Discovery exposes only static server metadata. Tool invocation, project data, user data, and secret values remain behind MCP/API authentication when auth is enabled.',
      },
    };
  };

  const mcpDiscoveryHandler = (_req: Request, res: Response) => {
    res.json(getMcpDiscoveryPayload());
  };

  const mcpRegistryManifestHandler = (req: McpRequest, res: Response) => {
    const discovery = getMcpDiscoveryPayload();
    const origin = getPublicOrigin(req);

    res.json({
      $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
      name: 'local.devgrimoire/devgrimoire',
      title: 'DevGrimoire',
      description: discovery.description,
      websiteUrl: origin,
      version: discovery.version,
      remotes: [
        {
          type: 'streamable-http',
          url: `${origin}/mcp`,
        },
        {
          type: 'sse',
          url: `${origin}/sse`,
        },
      ],
      _meta: {
        'io.modelcontextprotocol.registry/publisher-provided': {
          publication: 'private-instance-manifest',
          publicRegistryPublishing: false,
          security: 'No API keys, project IDs, user data, tool allowlists, or secret values are included. Authentication is still required for MCP calls when enabled.',
          toolCatalog: `${origin}/api/mcp/tools`,
        },
      },
    });
  };

  expressApp.get('/.well-known/mcp', mcpDiscoveryHandler);
  expressApp.get('/.well-known/mcp.json', mcpDiscoveryHandler);
  expressApp.get('/.well-known/mcp-server.json', mcpRegistryManifestHandler);
  expressApp.get('/server.json', mcpRegistryManifestHandler);

  const mcpOAuthService = mcpOAuth.enabled && mcpOAuth.resourceUrl ? app.get(OAuthService) : null;
  const mcpAuthDeps = {
    authEnabled: () => authService.isAuthEnabled(),
    apiKeys: apiKeysService,
    findUserById: (id: string) => authService.findUserById(id),
    oauth: mcpOAuthService && mcpOAuth.resourceUrl
      ? {
        verifyAccessToken: (token: string) => mcpOAuthService.verifyAccessToken(token),
        resourceUrl: mcpOAuth.resourceUrl,
      }
      : null,
  };
  // Both build the actor through actorFromApiKey (same as JwtAuthGuard), so a
  // key or connection narrowed to 'allowlist'/'none' stays narrowed on MCP.
  // /messages inherits it: it restores `cached.user` from the /sse auth.
  // OAuth access tokens only on /mcp; /sse and /messages stay API-key paths.
  const mcpAuthMiddleware = createMcpAuthMiddleware(mcpAuthDeps, { acceptOAuth: true });
  const legacyMcpAuthMiddleware = createMcpAuthMiddleware(mcpAuthDeps, { acceptOAuth: false });

  expressApp.use('/mcp', mcpAuthMiddleware);
  expressApp.use('/sse', legacyMcpAuthMiddleware);
  expressApp.use('/messages', async (req: McpRequest, res: Response, next: NextFunction) => {
    // Skip auth if not enabled but still attach a default user
    if (!authService.isAuthEnabled()) {
      req.user = { userId: 'system', username: 'system', role: 'admin' } satisfies RequestUser;
      return next();
    }
    // /messages requests belong to an SSE session authenticated on /sse — restore
    // both user AND apiKey so per-key tool allowlists keep being enforced.
    // OAuth tokens are not accepted on the SSE paths, not even next to a
    // valid session id.
    const presentedHeader = singleValue(req.headers.authorization);
    if (presentedHeader?.startsWith('Bearer dgo_') || singleValue(req.query?.apiKey)?.startsWith('dgo_')) {
      res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized: OAuth access tokens are accepted only on /mcp.' },
        id: null,
      });
      return;
    }
    const sessionId = singleValue(req.query?.sessionId);
    const cached = sessionId ? authenticatedSessions.get(sessionId) : undefined;
    if (cached && sessionId) {
      const unauthorized = (message: string) => {
        // Drop the session entirely: without the cache entry a later POST would
        // fall back to mcpAuthMiddleware and could ride the stream with another key.
        authenticatedSessions.delete(sessionId);
        const t = transports[sessionId];
        if (t) void t.close().catch(() => undefined);
        res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message }, id: null });
      };
      // A request that presents a key must present the session's key — a
      // leaked sessionId must not let a different key act as the session owner.
      let presented: string | undefined;
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith('Bearer cv_')) presented = authHeader.slice(7);
      else if (req.query?.apiKey) presented = singleValue(req.query.apiKey);
      if (presented && (!cached.apiKey || !apiKeysService.isSameKey(presented, cached.apiKey))) {
        res.status(401).json({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Unauthorized: API key does not match this session.' },
          id: null,
        });
        return;
      }
      // The /sse stream lives indefinitely. Re-validate key and owner at most
      // every 60 s, so revocation, expiry, owner deactivation and a narrowed
      // scope/allowlist take effect on open sessions too.
      const keyId = cached.user.apiKeyId;
      if (keyId && Date.now() - cached.validatedAt > MCP_SESSION_REVALIDATE_MS) {
        const freshKey = await apiKeysService.findActiveById(keyId);
        if (!freshKey) return unauthorized('Unauthorized: API key revoked or expired.');
        const owner = await authService.findUserById(freshKey.userId.toString());
        if (!owner || owner.active === false) {
          return unauthorized('Unauthorized: API key owner is deactivated or no longer exists.');
        }
        cached.user = actorFromApiKey(freshKey, owner);
        cached.apiKey = freshKey;
        cached.validatedAt = Date.now();
      }
      req.user = cached.user;
      req.apiKey = cached.apiKey;
      return next();
    }
    // Fallback: check API key directly
    return legacyMcpAuthMiddleware(req, res, next);
  });

  // Streamable HTTP endpoint (protocol version 2025-11-25). Each session
  // is bound to the credential that opened it (API key or OAuth connection).
  const streamableOwners = new McpSessionOwners();
  expressApp.all('/mcp', createStreamableHttpHandler({
    transports,
    owners: streamableOwners,
    createServer: () => createMcpServer(services),
    log: (message) => mcpLogger.log(message),
  }));
  // Revoking a connection ends its open sessions (each request is checked
  // anyway; this also cuts streams that are already open).
  closeSessionsOnRevoke(app.get(EventEmitter2), OAUTH_CONNECTION_REVOKED, streamableOwners, (m) => mcpLogger.warn(m));

  // Legacy SSE endpoint (protocol version 2024-11-05)
  expressApp.get('/sse', async (req: McpRequest, res: Response) => {
    const transport = new SSEServerTransport('/messages', res);
    transports[transport.sessionId] = transport;
    if (req.user) {
      authenticatedSessions.set(transport.sessionId, {
        user: req.user,
        apiKey: req.apiKey,
        validatedAt: Date.now(),
      });
    }
    mcpLogger.log(`sse session opened (${transport.sessionId.slice(0, 8)}…, total=${Object.keys(transports).length})`);
    // The SDK's SSEServerTransport never writes keepalives, so an idle MCP
    // session sends zero bytes between tool calls. Node-based clients kill the
    // response body after undici's 300s bodyTimeout (measured:
    // UND_ERR_BODY_TIMEOUT at 300.8s), which cost us ~80 session teardowns per
    // hour and dropped any tool call in flight at the cut. Same `: ping`
    // heartbeat the chat/research-agent/notes/workspaces streams already use.
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 15000);
    res.on('close', () => {
      clearInterval(heartbeat);
      delete transports[transport.sessionId];
      authenticatedSessions.delete(transport.sessionId);
      recentlyClosedSessions.set(transport.sessionId, Date.now());
      pruneRecentlyClosed();
      mcpLogger.log(`sse session closed (${transport.sessionId.slice(0, 8)}…, total=${Object.keys(transports).length})`);
    });
    const server = createMcpServer(services);
    try {
      await server.connect(transport);
    } catch (err) {
      // A bootstrap failure after start() wrote the SSE headers would strand the
      // stream open forever — the heartbeat is exactly what stops the client's
      // idle timeout from reaping it. End it so res.on('close') runs cleanup.
      mcpLogger.error(
        `sse bootstrap failed (${transport.sessionId.slice(0, 8)}…): ${err instanceof Error ? err.message : String(err)}`,
      );
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    }
  });

  expressApp.post('/messages', async (req: McpRequest, res: Response) => {
    const sessionId = singleValue(req.query.sessionId);
    // express typisiert `req.body` als `any`. JSON-RPC erlaubt als Id nur String
    // oder Number — alles andere wird verworfen. Das ist zugleich ein Fix: ein
    // Objekt als Id landete vorher per Stringifizierung als `[object Object]` im
    // Idempotenz-Key, wodurch *verschiedene* Requests fälschlich als Duplikat
    // abgewiesen wurden.
    const rawRequestId: unknown = isRecord(req.body) ? req.body.id : undefined;
    const requestId =
      typeof rawRequestId === 'string' || typeof rawRequestId === 'number'
        ? rawRequestId
        : undefined;

    // Idempotency: refuse to redispatch the same (session, jsonrpc.id) within
    // the in-flight window. Prevents double writes when a client retries after
    // a transient error (T-270).
    if (sessionId && requestId !== undefined && requestId !== null) {
      pruneInFlight();
      const key = `${sessionId}:${requestId}`;
      if (inFlightRequests.has(key)) {
        mcpLogger.warn(
          `duplicate request rejected (session=${sessionId.slice(0, 8)}…, id=${requestId})`,
        );
        res.status(409).json({
          jsonrpc: '2.0',
          error: { code: -32002, message: 'Duplicate request — original is still in flight' },
          id: requestId,
        });
        return;
      }
      inFlightRequests.set(key, Date.now());
    }

    // Ohne sessionId gibt es keinen Transport — zur Laufzeit war
    // `transports[undefined]` schon vorher `undefined`, das `as string` hat nur
    // verdeckt, dass der Fall auftreten kann. Der else-Zweig unten behandelt ihn
    // bereits korrekt und loggt „sessionId=missing".
    let transport: SSEServerTransport | StreamableHTTPServerTransport | undefined = sessionId
      ? transports[sessionId]
      : undefined;
    // Grace window: cover the race where a POST hits while the close handler
    // hasn't finished deleting the transport yet.
    if (!transport && sessionId) {
      transport = await waitForTransport(sessionId);
    }

    if (transport instanceof SSEServerTransport) {
      try {
        await RequestContext.run(req.user, req.apiKey, () => transport.handlePostMessage(req, res, req.body));
      } finally {
        if (sessionId && requestId !== undefined && requestId !== null) {
          inFlightRequests.delete(`${sessionId}:${requestId}`);
        }
      }
    } else {
      // Diagnostics so we can tell "unknown session" from "session was torn
      // down moments ago" the next time the transient bug surfaces.
      pruneRecentlyClosed();
      const closedAt = sessionId ? recentlyClosedSessions.get(sessionId) : undefined;
      const ageSec = closedAt ? Math.round((Date.now() - closedAt) / 1000) : null;
      mcpLogger.warn(
        `/messages rejected (sessionId=${sessionId ? sessionId.slice(0, 8) + '…' : 'missing'}, ` +
          `activeSessions=${Object.keys(transports).length}, ` +
          `recentlyClosed=${closedAt ? `${ageSec}s ago` : 'no'})`,
      );
      if (sessionId && requestId !== undefined && requestId !== null) {
        inFlightRequests.delete(`${sessionId}:${requestId}`);
      }
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: closedAt
            ? 'SSE session closed — open a new /sse stream and retry'
            : 'No valid SSE session found',
        },
        id: requestId ?? null,
      });
    }
  });

  // =========================================================================
  // NestJS REST API
  // =========================================================================
  app.setGlobalPrefix('api');
  app.use(helmet({
    contentSecurityPolicy: false, // Handled by nginx/frontend
    crossOriginEmbedderPolicy: false, // Allow SSE
  }));
  app.enableCors({
    origin: process.env.CORS_ORIGIN || 'http://localhost:8080',
  });
  app.useGlobalFilters(new MongooseErrorFilter());
  app.useGlobalPipes(
    // Vor der ValidationPipe: skalare String-Query-Parameter dürfen weder
    // Objekt noch Array sein (M-2).
    new ScalarQueryPipe(),
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // ─── WebSocket terminal proxy ────────────────────────────────────────
  // Browsers can't set Authorization headers on the WS upgrade, so the JWT
  // arrives in the ?token= query param. We validate, look up the workspace,
  // then either (container workspace) open an upstream WS to the sidecar
  // (using the shared bearer that never leaves the server-to-server hop) and
  // pipe frames in both directions, or (SSH workspace) open a login shell on
  // the server over SSH, starting in the workspace directory.
  // /api/workspaces/:id/exec/stream stays for one-shot agent calls — this WS
  // is for the interactive PTY only.
  const jwt = app.get(JwtService);
  const workspacesService = app.get(WorkspacesService);
  const workspaceCliToken = app.get(WorkspaceCliTokenService);
  const sshWorkspaceAccess = app.get(SshWorkspaceAccess);
  const sshSessionService = app.get(SshSessionService);
  const SIDECAR_URL = (process.env.WORKSPACE_API_URL || 'http://workspace:9000').replace(/\/$/, '');
  const SIDECAR_TOKEN = process.env.WORKSPACE_API_TOKEN || '';
  const SIDECAR_WS_URL = SIDECAR_URL.replace(/^http/i, 'ws') + '/term';
  const proxyWss = new WebSocketServer({ noServer: true });
  // Shared by the SSH-workspace branch below and the SSH connection terminal.
  const sshTerminalWss = new WebSocketServer({ noServer: true });
  const TERMINAL_ROUTE = /^\/api\/workspaces\/([a-f0-9]{24})\/terminal\/?$/i;

  /** Initial PTY size from `?cols=&rows=`; 80×24 when missing or invalid. */
  const initialPtySize = (url: URL): { cols: number; rows: number } =>
    toPtySize(url.searchParams.get('cols') ?? undefined, url.searchParams.get('rows') ?? undefined)
      ?? { cols: 80, rows: 24 };

  const httpServer = app.getHttpServer();
  httpServer.on('upgrade', onUpgradeAsync(async (req: import('http').IncomingMessage, socket: import('net').Socket, head: Buffer) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const match = TERMINAL_ROUTE.exec(url.pathname);
    if (!match) return; // let other upgrades fall through to whatever else listens

    const reject = (status: number, msg: string) => {
      socket.write(`HTTP/1.1 ${status} ${msg}\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };

    const token = url.searchParams.get('token');
    if (!token) return reject(401, 'Unauthorized');

    let userId: string | undefined;
    try {
      // Nur Access-Tokens (typ + ObjectId-sub); ein dg-CLI-Token ist mit
      // demselben Secret signiert und darf hier keine Shell öffnen.
      userId = accessTokenUserId(jwt.verify<object>(token)) ?? undefined;
    } catch {
      return reject(401, 'Unauthorized');
    }
    if (!userId) return reject(401, 'Unauthorized');

    // Der Upgrade läuft vollständig ausserhalb der Nest-Pipeline: JwtAuthGuard
    // greift hier nie, und RequestContext ist leer. `jwt.verify` oben prüft nur
    // die Signatur — das Token trägt sub/username/role, aber KEINEN Scope, der
    // steht in der Datenbank.
    //
    // Ohne den vollen Actor war die 24-Hex-Workspace-Id die einzige Hürde: jeder
    // Inhaber eines gültigen Access-Tokens bekam eine interaktive PTY-Session
    // in jedem Workspace-Container der Instanz. Zusätzlich lief alles darunter
    // ohne RequestContext, also hätten selbst vorhandene Scope-Prüfungen in den
    // Services nichts gesehen (`if (actor && …)` mit actor === undefined).
    //
    // `active` wird hier mitgeprüft: jwt.verify tut das nicht, ein deaktiviertes
    // Konto behielt damit bis zum Ablauf des Access-Tokens (15 min) Zugang.
    const fullUser = await authService.findUserById(userId);
    if (!fullUser || !fullUser.active) return reject(401, 'Unauthorized');
    const actor = actorFromUser(fullUser);
    // An interactive shell is a content write; a user with a permission
    // allowlist needs project:write or customer:write for it.
    if (!actorMayWriteContent(actor)) return reject(403, 'Forbidden');

    const workspaceId = match[1];
    let workspace: Awaited<ReturnType<typeof workspacesService.findById>>;
    try {
      workspace = await workspacesService.findById(workspaceId);
    } catch {
      return reject(404, 'Not Found');
    }
    if (!actorCanAccessProject(actor, workspace.projectId?.toString())) {
      return reject(403, 'Forbidden');
    }

    // Read at open: an open terminal keeps the limit it started with.
    const idleMs = await fsLimits.terminalIdleMs();

    if (isSshWorkspace(workspace)) {
      // SSH workspace: no sidecar, no X-Dg-Env, no CLI or git token (no
      // DevGrimoire credentials go to the target server); `sessionId` is
      // ignored (the shell ends with the socket, no re-attach).
      if (workspace.status !== 'active') return reject(409, 'Conflict');
      const remotePath = workspace.remotePath;
      if (!remotePath) return reject(409, 'Conflict');
      let connection: Awaited<ReturnType<typeof sshWorkspaceAccess.resolve>>;
      try {
        connection = await RequestContext.run(actor, undefined, () => sshWorkspaceAccess.resolve(workspace));
      } catch (err: unknown) {
        // Access errors go out as an HTTP status before the upgrade.
        if (err instanceof HttpException) {
          const status = err.getStatus();
          const labels: Record<number, string> = { 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict' };
          return reject(status, labels[status] ?? 'Error');
        }
        throw err;
      }
      const connectionId = String(connection._id);
      const size = initialPtySize(url);
      const audit = (action: 'terminal_open' | 'terminal_close', durationMs?: number) => {
        void sshSessionService.writeAudit({
          connectionId: connection._id,
          action,
          sourceContext: 'ide',
          userId,
          workspaceId,
          remotePath,
          ...(durationMs !== undefined ? { durationMs } : {}),
        });
      };
      RequestContext.run(actor, undefined, () => {
        sshTerminalWss.handleUpgrade(req, socket, head, voidAsync((clientWs: WebSocket) => bridgeSshTerminal({
          clientWs,
          connect: () => sshSessionService.connect(connectionId, { ptyCols: size.cols, ptyRows: size.rows }),
          start: { kind: 'cwd', path: remotePath },
          initial: size,
          idleMs,
          audit,
        })));
      });
      return;
    }

    if (!SIDECAR_TOKEN) return reject(503, 'Sidecar Not Configured');

    const sessionId = url.searchParams.get('sessionId') || '';
    const upstreamUrl = new URL(SIDECAR_WS_URL);
    upstreamUrl.searchParams.set('workspaceId', workspaceId);
    if (sessionId) upstreamUrl.searchParams.set('sessionId', sessionId);

    // dg-CLI im interaktiven Terminal: bisher bekam nur /exec die DG_*-Variablen,
    // im Terminal lief `dg` ins Leere. Seit `dg kube` (C-3) der einzige Weg zum
    // Cluster aus der Shell ist, braucht auch das Terminal sie. Als Header statt
    // Query-Parameter, damit das Token in keinem Access-Log landet.
    const dgEnv = workspace.projectId
      ? workspaceCliToken.buildEnvFor(workspace, TERMINAL_TOKEN_TTL)
      : {};
    const upstreamHeaders: Record<string, string> = {
      Authorization: `Bearer ${SIDECAR_TOKEN}`,
      // Per-terminal idle limit; the sidecar validates it and falls back to
      // its TERMINAL_IDLE_MS when the value is missing or out of range.
      'X-Dg-Idle-Ms': String(idleMs),
    };
    if (Object.keys(dgEnv).length > 0) {
      upstreamHeaders['X-Dg-Env'] = Buffer.from(JSON.stringify(dgEnv)).toString('base64');
    }

    // M-53: `ws` hat per Default KEIN Handshake-Timeout. Hing der Sidecar
    // (SYN-Blackhole, DROP statt REJECT, halbtoter Container), kam weder
    // `open` noch `error`, und der Browser-Socket blieb unbeantwortet offen —
    // pro Versuch ein FD-Paar, das nichts mehr aufräumte.
    const upstream = new WebSocket(upstreamUrl.toString(), {
      headers: upstreamHeaders,
      handshakeTimeout: 10_000,
    });
    // Bricht der Browser ab, bevor der Sidecar antwortet, den Upstream nicht
    // weiter offenhalten.
    const onEarlyClose = () => { try { upstream.terminate(); } catch { /* noop */ } };
    socket.once('close', onEarlyClose);
    socket.on('error', onEarlyClose);
    // Gilt NUR bis zum Upgrade: danach ist `socket` ein WebSocket, und ein
    // `HTTP/1.1 502` roh hineinzuschreiben (vorher der Fall) zerstört den
    // Frame-Strom. Nach dem Upgrade übernimmt der Handler im open-Zweig.
    const onUpstreamPreOpenError = () => reject(502, 'Bad Gateway');
    upstream.once('error', onUpstreamPreOpenError);

    upstream.on('open', () => {
      upstream.off('error', onUpstreamPreOpenError);
      socket.off('close', onEarlyClose);
      // Lückenlos ein Listener: zwischen `open` und dem Upgrade-Callback gäbe
      // es sonst keinen, und ein 'error'-Event ohne Abnehmer beendet node.
      upstream.on('error', () => { try { upstream.terminate(); } catch { /* noop */ } });
      // RequestContext um den Callback: die hier registrierten Listener erben
      // den Kontext über die AsyncLocalStorage, und jeder künftige Service-
      // Aufruf in diesem Pfad sieht denselben Actor wie die Prüfung oben.
      proxyWss.handleUpgrade(req, socket, head, (clientWs) => RequestContext.run(actor, undefined, () => {
        const close = (code = 1000, reason = '') => {
          try { clientWs.close(code, reason); } catch { /* noop */ }
          try { upstream.close(code, reason); } catch { /* noop */ }
        };
        clientWs.on('message', (data, isBinary) => {
          if (upstream.readyState === WebSocket.OPEN) {
            try { upstream.send(data, { binary: isBinary }); } catch { /* noop */ }
          }
        });
        upstream.on('message', (data, isBinary) => {
          if (clientWs.readyState === WebSocket.OPEN) {
            try { clientWs.send(data, { binary: isBinary }); } catch { /* noop */ }
          }
        });
        // The reason travels along: the sidecar's idle close (4010
        // `idle_timeout`) must reach the browser intact.
        clientWs.on('close', (code, reason) => close(code, reason.toString()));
        upstream.on('close', (code, reason) => close(code, reason.toString()));
        clientWs.on('error', () => close(1011, 'client error'));
        upstream.on('error', () => close(1011, 'upstream error'));
      }));
    });
  }));

  // ─── WebSocket SSH terminal ──────────────────────────────────────────
  // Same JWT-via-query-param pattern as the workspace terminal above. We
  // diverge only at the upstream end: instead of proxying to a sidecar WS
  // we open an ssh2 client locally via SshSessionService.connect(), then
  // request an interactive shell channel and pipe both directions on it
  // (`bridgeSshTerminal`, shared with the SSH-workspace branch above; the
  // close-code mapping lives next to it).
  const SSH_TERMINAL_ROUTE = /^\/api\/ssh\/([a-f0-9]{24})\/terminal\/?$/i;

  httpServer.on('upgrade', onUpgradeAsync(async (req: import('http').IncomingMessage, socket: import('net').Socket, head: Buffer) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const match = SSH_TERMINAL_ROUTE.exec(url.pathname);
    if (!match) return;

    const rejectUpgrade = (status: number, msg: string) => {
      socket.write(`HTTP/1.1 ${status} ${msg}\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };

    const token = url.searchParams.get('token');
    if (!token) return rejectUpgrade(401, 'Unauthorized');

    let userId: string | undefined;
    try {
      userId = accessTokenUserId(jwt.verify<object>(token)) ?? undefined;
    } catch {
      return rejectUpgrade(401, 'Unauthorized');
    }
    if (!userId) return rejectUpgrade(401, 'Unauthorized');

    // Wie beim Workspace-Terminal oben: `jwt.verify` prüft nur die Signatur,
    // das Token trägt keinen Scope. Der Nutzer wird nachgeladen, `active`
    // mitgeprüft (ein deaktiviertes Konto behielt sonst bis zum Ablauf des
    // Access-Tokens eine interaktive Shell), und der volle Actor wandert in den
    // RequestContext — damit die Scope-Prüfung, die das SSH-Modul noch braucht,
    // einen Actor vorfindet. Ohne RequestContext wäre `RequestContext.getUser()`
    // hier undefined und jede `if (actor && …)`-Prüfung darunter wirkungslos.
    //
    // Der Handler ist dafür async geworden (onUpgradeAsync): die Ablehnung muss
    // VOR dem Upgrade als HTTP-Status raus, nicht als Close-Frame danach.
    const sshUser = await authService.findUserById(userId);
    if (!sshUser || !sshUser.active) return rejectUpgrade(401, 'Unauthorized');
    const actor = actorFromUser(sshUser);
    // An interactive shell is a content write; a user with a permission
    // allowlist needs project:write or customer:write for it.
    if (!actorMayWriteContent(actor)) return rejectUpgrade(403, 'Forbidden');

    const connectionId = match[1];
    // The route regex guarantees 24 hex chars, so this is a valid ObjectId.
    const connectionObjectId = new MongoTypes.ObjectId(connectionId);

    // Initial PTY size for the very first shell allocation; the frontend
    // follows up with explicit resize frames anyway, but starting with the
    // right viewport avoids a flash of misformatted output.
    const size = initialPtySize(url);
    // Read at open: an open terminal keeps the limit it started with.
    const idleMs = await fsLimits.terminalIdleMs();

    // ssh2 client setup happens AFTER the WS upgrade so we can surface
    // ssh errors as close-frames (with a reason the UI can render),
    // rather than as raw HTTP rejects with cryptic codes.
    RequestContext.run(actor, undefined, () => {
      sshTerminalWss.handleUpgrade(req, socket, head, voidAsync((clientWs: WebSocket) => bridgeSshTerminal({
        clientWs,
        connect: () => sshSessionService.connect(connectionId, { ptyCols: size.cols, ptyRows: size.rows }),
        start: { kind: 'shell' },
        initial: size,
        idleMs,
        // Best-effort audit rows; never block the user-facing data path.
        audit: (action, durationMs) => {
          void sshSessionService.writeAudit({
            connectionId: connectionObjectId,
            action,
            sourceContext: 'terminal',
            userId,
            ...(durationMs !== undefined ? { durationMs } : {}),
          });
        },
      })));
    });
  }));

  // ─── WebSocket multiplex bus for live events ─────────────────────────
  // Replaces the long-lived /api/events SSE stream that, multiplied by 3
  // EventSources per tab (ConnectionStatus, NotificationBell, project
  // events), starved the HTTP/1.1 6-connections-per-origin pool at 2+ tabs.
  // One WS per tab carries N filtered subscriptions; WS connections live in
  // their own browser pool (~200+ per origin) and don't contend with normal
  // HTTP requests.
  //
  // Protocol (JSON over text frames):
  //   client → server:
  //     {type:'subscribe', id, scope:'global'|'project', projectId?}
  //     {type:'unsubscribe', id}
  //   server → client:
  //     {type:'hello', userId}
  //     {type:'subscribed', id}
  //     {type:'event', subIds, payload: ProjectChangeEvent}
  //     {type:'question', subIds, payload: QuestionEvent}
  //
  // Heartbeat: server pings every 25s; misses 1 pong → terminate(). Browsers
  // auto-respond to pings, so no client timer is needed (which means
  // background-tab throttling can't break liveness).
  const eventsBus = app.get(EventsBusService);
  const eventsWss = new WebSocketServer({ noServer: true });
  const EVENTS_ROUTE = /^\/api\/ws\/events\/?$/i;
  const HEARTBEAT_INTERVAL_MS = 25_000;

  interface WsSubscription {
    id: string;
    scope: 'global' | 'project';
    projectId?: string;
  }

  httpServer.on('upgrade', onUpgradeAsync(async (req: import('http').IncomingMessage, socket: import('net').Socket, head: Buffer) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (!EVENTS_ROUTE.test(url.pathname)) return;

    const reject = (status: number, msg: string) => {
      socket.write(`HTTP/1.1 ${status} ${msg}\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };

    let userId: string | undefined;
    let actor: RequestUser | undefined;
    if (authService.isAuthEnabled()) {
      const token = url.searchParams.get('token');
      if (!token) return reject(401, 'Unauthorized');
      try {
        userId = accessTokenUserId(jwt.verify<object>(token)) ?? undefined;
      } catch {
        return reject(401, 'Unauthorized');
      }
      if (!userId) return reject(401, 'Unauthorized');
      // Voller Actor aus der DB: das JWT trägt nur sub/username/role, der Scope
      // steht nicht drin. Wird unten in matchProjectEvent() gebraucht.
      const wsUser = await authService.findUserById(userId);
      if (!wsUser || !wsUser.active) return reject(401, 'Unauthorized');
      actor = actorFromUser(wsUser);
    }

    eventsWss.handleUpgrade(req, socket, head, (ws) => {
      const subs = new Map<string, WsSubscription>();
      let isAlive = true;
      const send = (msg: unknown) => {
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.send(JSON.stringify(msg)); } catch { /* noop */ }
        }
      };

      const matchProjectEvent = (event: ProjectChangeEvent): string[] => {
        // Privacy- und Projekt-Filter: siehe events/event-visibility.ts, dort
        // teilt sich die Regel mit der Legacy-SSE-Route.
        //
        // Projekt-Scope (Review-Fund H-13, WebSocket-Variante). `projectId`
        // kommt bei einer Projekt-Subscription aus der Client-Nachricht, und
        // eine Global-Subscription bekam per Design ALLE nicht-privaten Events
        // („global-scope subscription receives all non-private events"). Beides
        // zusammen war ein dauerhafter Abhörkanal: Entitätsnamen, Ids und
        // Zusammenfassungen aus jedem Projekt der Instanz, an den
        // Scope-Filtern der Lese-Endpunkte vorbei.
        //
        // Die Prüfung sitzt hier und nicht beim `subscribe`, weil sie sonst nur
        // den Projekt-Fall abdecken würde — die Global-Subscription ist der
        // breitere Weg. `actor === undefined` nur bei deaktivierter Auth; dann
        // ist die Instanz ohnehin offen.
        if (!isProjectEventVisible(event, userId, actor)) return [];
        const hits: string[] = [];
        for (const sub of subs.values()) {
          // Notifications and global (projectId === null) events broadcast to
          // every subscription on this connection regardless of scope.
          if (event.entity === 'notification' || event.projectId === null) {
            hits.push(sub.id);
            continue;
          }
          if (sub.scope === 'project') {
            if (event.projectId === sub.projectId) hits.push(sub.id);
          } else {
            // global-scope subscription receives all non-private events
            hits.push(sub.id);
          }
        }
        return hits;
      };

      const matchQuestionEvent = (event: QuestionEvent): string[] => {
        // Targeted questions only flow to the addressed user. Broadcast
        // questions flow to every subscription — sofern ihr Projekt im Scope
        // des Actors liegt (fehlte bisher auch hier).
        if (!isQuestionEventVisible(event, userId, actor)) return [];
        return Array.from(subs.keys());
      };

      const projectRxSub: Subscription = eventsBus.events$.subscribe((event) => {
        const subIds = matchProjectEvent(event);
        if (subIds.length > 0) send({ type: 'event', subIds, payload: event });
      });
      const questionRxSub: Subscription = eventsBus.questionEvents$.subscribe((event) => {
        const subIds = matchQuestionEvent(event);
        if (subIds.length > 0) send({ type: 'question', subIds, payload: event });
      });

      ws.on('pong', () => { isAlive = true; });
      const heartbeat = setInterval(() => {
        if (!isAlive) {
          try { ws.terminate(); } catch { /* noop */ }
          return;
        }
        isAlive = false;
        try { ws.ping(); } catch { /* noop */ }
      }, HEARTBEAT_INTERVAL_MS);

      ws.on('message', (data) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(rawDataToString(data));
        } catch {
          return;
        }
        if (parsed === null || typeof parsed !== 'object') return;
        const msg = parsed as { type?: string; id?: string; scope?: string; projectId?: string };
        if (msg.type === 'subscribe' && typeof msg.id === 'string') {
          subs.set(msg.id, {
            id: msg.id,
            scope: msg.scope === 'project' ? 'project' : 'global',
            projectId: typeof msg.projectId === 'string' ? msg.projectId : undefined,
          });
          send({ type: 'subscribed', id: msg.id });
        } else if (msg.type === 'unsubscribe' && typeof msg.id === 'string') {
          subs.delete(msg.id);
        }
      });

      const cleanup = () => {
        clearInterval(heartbeat);
        projectRxSub.unsubscribe();
        questionRxSub.unsubscribe();
      };
      ws.on('close', cleanup);
      ws.on('error', cleanup);

      send({ type: 'hello', userId: userId ?? null });
    });
  }));

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`DevGrimoire API running on port ${port}`);
  console.log(`MCP HTTP transport available at /mcp (Streamable HTTP) and /sse (Legacy SSE)`);
}
bootstrap().catch((err: unknown) => {
  // Vorher ein unbehandelter Promise: ein Startfehler kam als nackte
  // UnhandledRejection heraus, ohne Hinweis worauf.
  console.error('DevGrimoire konnte nicht starten:', err);
  process.exit(1);
});
