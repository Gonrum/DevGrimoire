import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import helmet from 'helmet';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { json } = require('express');
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { AppModule } from './app.module';
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
import { ResearchSessionsService } from './research-sessions/research-sessions.service';
import { SettingsService } from './settings/settings.service';
import { NotificationsService } from './notifications/notifications.service';
import { SchemasService } from './schemas/schemas.service';
import { DependenciesService } from './dependencies/dependencies.service';
import { FeaturesService } from './features/features.service';
import { SoulsService } from './souls/souls.service';
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
import { WorkspaceClient } from './workspaces/workspace-client.service';
import { WorkspaceGitTokensService } from './workspaces/workspace-git-tokens.service';
import { WorkspaceCliTokenService } from './workspaces/workspace-cli-token.service';
import { SshSessionService } from './ssh/ssh-session.service';
import { Types as MongoTypes } from 'mongoose';
import { CustomersService } from './customers/customers.service';
import { ContactsService } from './contacts/contacts.service';
import { MonitoringService } from './monitoring/monitoring.service';
import { getToolCatalog, registerMcpTools, McpServices } from './mcp-tools';
import { ApiKey } from './api-keys/schemas/api-key.schema';
import { ApiKeysService } from './api-keys/api-keys.service';
import { AuthService } from './auth/auth.service';
import { JwtService } from '@nestjs/jwt';
import WebSocket, { WebSocketServer } from 'ws';
import { RequestContext, RequestUser } from './common/request-context';
import { EventsBusService, QuestionEvent } from './events/events-bus.service';
import { ProjectChangeEvent } from './events/project-event';
import { Subscription } from 'rxjs';

function createMcpServer(services: McpServices): Server {
  const server = new Server(
    { name: 'DevGrimoire', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  registerMcpTools(server, services);
  return server;
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });

  const expressApp = app.getHttpAdapter().getInstance();

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
    researchSessionsService: app.get(ResearchSessionsService),
    settingsService: app.get(SettingsService),
    notificationsService: app.get(NotificationsService),
    schemasService: app.get(SchemasService),
    dependenciesService: app.get(DependenciesService),
    featuresService: app.get(FeaturesService),
    soulsService: app.get(SoulsService),
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
  };

  const transports: Record<string, SSEServerTransport | StreamableHTTPServerTransport> = {};
  // Cache the user AND api-key for SSE sessions — /messages must restore both
  // to the RequestContext so apiKey.allowedTools is honored on tool calls.
  const authenticatedSessions = new Map<string, { user: RequestUser; apiKey?: ApiKey }>();
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

  const getPublicOrigin = (req: any) => {
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
        schemes: ['devgrimoire-api-key'],
        headerName: 'Authorization',
        headerScheme: 'Bearer',
        apiKeyPrefix: 'cv_',
        queryParameter: 'apiKey',
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

  const mcpDiscoveryHandler = (_req: any, res: any) => {
    res.json(getMcpDiscoveryPayload());
  };

  const mcpRegistryManifestHandler = (req: any, res: any) => {
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

  const mcpAuthMiddleware = async (req: any, res: any, next: any) => {
    // Skip auth if auth is not enabled — still set a default user so per-user
    // scoped tools (chat_*) can resolve an owner.
    if (!authService.isAuthEnabled()) {
      req.user = { userId: 'system', username: 'system', role: 'admin' } satisfies RequestUser;
      return next();
    }

    // Extract API key from Authorization header (Bearer cv_...) or query param
    let apiKey: string | undefined;
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer cv_')) {
      apiKey = authHeader.slice(7);
    } else if (req.query?.apiKey) {
      apiKey = req.query.apiKey as string;
    }

    if (!apiKey) {
      res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized: API key required. Pass via Authorization: Bearer cv_... header or ?apiKey= query param.' },
        id: null,
      });
      return;
    }

    const validated = await apiKeysService.validate(apiKey);
    if (!validated) {
      res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized: Invalid or expired API key.' },
        id: null,
      });
      return;
    }

    // Mirror JwtAuthGuard pattern so RequestContext + per-user scoped tools work.
    const owner = await authService.findUserById(validated.userId.toString());
    if (!owner) {
      res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized: API key owner no longer exists.' },
        id: null,
      });
      return;
    }
    req.user = {
      userId: validated.userId.toString(),
      username: owner.username,
      role: owner.role,
    } satisfies RequestUser;
    req.apiKey = validated;

    next();
  };

  expressApp.use('/mcp', mcpAuthMiddleware);
  expressApp.use('/sse', mcpAuthMiddleware);
  expressApp.use('/messages', async (req: any, res: any, next: any) => {
    // Skip auth if not enabled but still attach a default user
    if (!authService.isAuthEnabled()) {
      req.user = { userId: 'system', username: 'system', role: 'admin' } satisfies RequestUser;
      return next();
    }
    // /messages requests belong to an SSE session authenticated on /sse — restore
    // both user AND apiKey so per-key tool allowlists keep being enforced.
    const sessionId = req.query?.sessionId as string | undefined;
    const cached = sessionId ? authenticatedSessions.get(sessionId) : undefined;
    if (cached) {
      req.user = cached.user;
      req.apiKey = cached.apiKey;
      return next();
    }
    // Fallback: check API key directly
    return mcpAuthMiddleware(req, res, next);
  });

  // Streamable HTTP endpoint (protocol version 2025-11-25)
  expressApp.all('/mcp', async (req: any, res: any) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        const existing = transports[sessionId];
        if (existing instanceof StreamableHTTPServerTransport) {
          transport = existing;
        } else {
          res.status(400).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Session uses a different transport protocol' },
            id: null,
          });
          return;
        }
      } else if (!sessionId && req.method === 'POST' && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports[sid] = transport;
            mcpLogger.log(`streamable-http session opened (${sid.slice(0, 8)}…, total=${Object.keys(transports).length})`);
          },
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) {
            delete transports[sid];
            mcpLogger.log(`streamable-http session closed (${sid.slice(0, 8)}…, total=${Object.keys(transports).length})`);
          }
        };
        const server = createMcpServer(services);
        await server.connect(transport);
      } else {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
          id: null,
        });
        return;
      }

      await RequestContext.run(req.user, req.apiKey, () => transport.handleRequest(req, res, req.body));
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  // Legacy SSE endpoint (protocol version 2024-11-05)
  expressApp.get('/sse', async (req: any, res: any) => {
    const transport = new SSEServerTransport('/messages', res);
    transports[transport.sessionId] = transport;
    if (req.user) {
      authenticatedSessions.set(transport.sessionId, {
        user: req.user as RequestUser,
        apiKey: req.apiKey as ApiKey | undefined,
      });
    }
    mcpLogger.log(`sse session opened (${transport.sessionId.slice(0, 8)}…, total=${Object.keys(transports).length})`);
    res.on('close', () => {
      delete transports[transport.sessionId];
      authenticatedSessions.delete(transport.sessionId);
      recentlyClosedSessions.set(transport.sessionId, Date.now());
      pruneRecentlyClosed();
      mcpLogger.log(`sse session closed (${transport.sessionId.slice(0, 8)}…, total=${Object.keys(transports).length})`);
    });
    const server = createMcpServer(services);
    await server.connect(transport);
  });

  expressApp.post('/messages', async (req: any, res: any) => {
    const sessionId = req.query.sessionId as string;
    const requestId = req.body?.id;

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

    let transport: SSEServerTransport | StreamableHTTPServerTransport | undefined =
      transports[sessionId];
    // Grace window: cover the race where a POST hits while the close handler
    // hasn't finished deleting the transport yet.
    if (!transport) {
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
      const closedAt = recentlyClosedSessions.get(sessionId);
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
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // ─── WebSocket terminal proxy ────────────────────────────────────────
  // Browsers can't set Authorization headers on the WS upgrade, so the JWT
  // arrives in the ?token= query param. We validate, look up the workspace,
  // then open an upstream WS to the sidecar (using the shared bearer that
  // never leaves the server-to-server hop) and pipe frames in both
  // directions. /api/workspaces/:id/exec/stream stays for one-shot agent
  // calls — this WS is for the interactive PTY only.
  const jwt = app.get(JwtService);
  const workspacesService = app.get(WorkspacesService);
  const SIDECAR_URL = (process.env.WORKSPACE_API_URL || 'http://workspace:9000').replace(/\/$/, '');
  const SIDECAR_TOKEN = process.env.WORKSPACE_API_TOKEN || '';
  const SIDECAR_WS_URL = SIDECAR_URL.replace(/^http/i, 'ws') + '/term';
  const proxyWss = new WebSocketServer({ noServer: true });
  const TERMINAL_ROUTE = /^\/api\/workspaces\/([a-f0-9]{24})\/terminal\/?$/i;

  const httpServer = app.getHttpServer();
  httpServer.on('upgrade', async (req: import('http').IncomingMessage, socket: import('net').Socket, head: Buffer) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const match = TERMINAL_ROUTE.exec(url.pathname);
    if (!match) return; // let other upgrades fall through to whatever else listens

    const reject = (status: number, msg: string) => {
      socket.write(`HTTP/1.1 ${status} ${msg}\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };

    if (!SIDECAR_TOKEN) return reject(503, 'Sidecar Not Configured');
    const token = url.searchParams.get('token');
    if (!token) return reject(401, 'Unauthorized');

    let userId: string | undefined;
    try {
      const payload = jwt.verify(token) as { sub?: string; userId?: string };
      // Auth signs JWTs with the standard `sub` claim (user id) plus a
      // legacy `userId` field on some paths — accept either.
      userId = payload.sub || payload.userId;
    } catch {
      return reject(401, 'Unauthorized');
    }
    if (!userId) return reject(401, 'Unauthorized');

    const workspaceId = match[1];
    try {
      await workspacesService.findById(workspaceId);
    } catch {
      return reject(404, 'Not Found');
    }

    const sessionId = url.searchParams.get('sessionId') || '';
    const upstreamUrl = new URL(SIDECAR_WS_URL);
    upstreamUrl.searchParams.set('workspaceId', workspaceId);
    if (sessionId) upstreamUrl.searchParams.set('sessionId', sessionId);

    const upstream = new WebSocket(upstreamUrl.toString(), {
      headers: { Authorization: `Bearer ${SIDECAR_TOKEN}` },
    });

    upstream.on('open', () => {
      proxyWss.handleUpgrade(req, socket, head, (clientWs) => {
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
        clientWs.on('close', (code) => close(code));
        upstream.on('close', (code) => close(code));
        clientWs.on('error', () => close(1011, 'client error'));
        upstream.on('error', () => close(1011, 'upstream error'));
      });
    });

    upstream.on('error', () => reject(502, 'Bad Gateway'));
  });

  // ─── WebSocket SSH terminal ──────────────────────────────────────────
  // Same JWT-via-query-param pattern as the workspace terminal above. We
  // diverge only at the upstream end: instead of proxying to a sidecar WS
  // we open an ssh2 client locally via SshSessionService.connect(), then
  // request an interactive shell channel and pipe both directions on it.
  //
  // Control-frame protocol mirrors the workspace terminal exactly so the
  // frontend can share a hook (planned, Schritt 5/8): JSON `{type:'resize',
  // cols, rows}` from client → server, JSON `{type:'exit', exitCode}` from
  // server → client. All other frames are stdin/stdout bytes.
  //
  // Close-code mapping for SSH connect/auth failures (Spec §4.3):
  //   host_key_mismatch    → 4001 (spec-mandated)
  //   tofu_not_accepted    → 4002
  //   credential_missing   → 4003
  //   auth_failed          → 4004
  //   timeout / network    → 4008
  //   anything else        → 1011 (internal server error)
  // The reason string is the raw error code so the frontend can also
  // disambiguate without depending on the numeric mapping.
  const sshConnectErrorToCloseCode = (reason: string): number => {
    // Match prefix-style (some errors include extra context after the code,
    // e.g. "upload_too_large: 12345 > 10485760").
    const head = reason.split(/[:\s]/, 1)[0] || reason;
    switch (head) {
      case 'host_key_mismatch':
        return 4001;
      case 'tofu_not_accepted':
        return 4002;
      case 'credential_missing':
        return 4003;
      case 'auth_failed':
        return 4004;
      case 'timeout':
      case 'ETIMEDOUT':
      case 'ECONNREFUSED':
      case 'ENOTFOUND':
      case 'EHOSTUNREACH':
      case 'ENETUNREACH':
      case 'ECONNRESET':
        return 4008;
      default:
        return 1011;
    }
  };

  const sshSessionService = app.get(SshSessionService);
  const sshTerminalWss = new WebSocketServer({ noServer: true });
  const SSH_TERMINAL_ROUTE = /^\/api\/ssh\/([a-f0-9]{24})\/terminal\/?$/i;

  httpServer.on('upgrade', async (req: import('http').IncomingMessage, socket: import('net').Socket, head: Buffer) => {
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
      const payload = jwt.verify(token) as { sub?: string; userId?: string };
      userId = payload.sub || payload.userId;
    } catch {
      return rejectUpgrade(401, 'Unauthorized');
    }
    if (!userId) return rejectUpgrade(401, 'Unauthorized');

    const connectionId = match[1];

    // Parse optional initial PTY size from query string for the very first
    // shell allocation; the frontend will follow up with explicit resize
    // frames anyway, but starting with the right viewport avoids a flash
    // of misformatted output.
    const initialCols = Number.parseInt(url.searchParams.get('cols') || '', 10) || 80;
    const initialRows = Number.parseInt(url.searchParams.get('rows') || '', 10) || 24;

    // ssh2 client setup happens AFTER the WS upgrade so we can surface
    // ssh errors as close-frames (with a reason the UI can render),
    // rather than as raw HTTP rejects with cryptic codes.
    sshTerminalWss.handleUpgrade(req, socket, head, async (clientWs) => {
      const startedAt = Date.now();
      let sshClient: import('ssh2').Client | null = null;
      let channel: import('ssh2').ClientChannel | null = null;
      let closed = false;
      let connectionObjectId: MongoTypes.ObjectId | null = null;

      const closeAll = (code = 1000, reason = '') => {
        if (closed) return;
        closed = true;
        try { clientWs.close(code, reason); } catch { /* noop */ }
        try { channel?.close(); } catch { /* noop */ }
        try { sshClient?.end(); } catch { /* noop */ }
        try { sshClient?.destroy(); } catch { /* noop */ }
        if (connectionObjectId && userId) {
          // Fire-and-forget audit close row. Duration is end-to-end WS
          // lifetime, which is the only "session duration" the user
          // cares about — channel-only timing would be misleading.
          void sshSessionService.writeAudit({
            connectionId: connectionObjectId,
            action: 'terminal_close',
            sourceContext: 'terminal',
            userId,
            durationMs: Date.now() - startedAt,
          });
        }
      };

      try {
        sshClient = await sshSessionService.connect(connectionId, {
          ptyCols: initialCols,
          ptyRows: initialRows,
        });
      } catch (err) {
        const reason = (err as Error).message || 'ssh_connect_failed';
        // WS close codes 4000-4999 are reserved for application-defined
        // semantics. The spec (§4.3) mandates 4001 for host_key_mismatch;
        // we extend the mapping so the frontend can distinguish the
        // different SSH failure modes without parsing reason strings.
        // Anything we don't recognise falls back to 1011 (internal err).
        const code = sshConnectErrorToCloseCode(reason);
        try { clientWs.close(code, reason); } catch { /* noop */ }
        return;
      }

      // We have a ready client → log the open. Best-effort; never block
      // the user-facing data path.
      if (MongoTypes.ObjectId.isValid(connectionId)) {
        connectionObjectId = new MongoTypes.ObjectId(connectionId);
        void sshSessionService.writeAudit({
          connectionId: connectionObjectId,
          action: 'terminal_open',
          sourceContext: 'terminal',
          userId,
        });
      }

      sshClient.shell(
        { term: 'xterm-256color', cols: initialCols, rows: initialRows },
        (err, stream) => {
          if (err) {
            // Post-connect failure → 1011 (internal). Spec §4.3's 4xxx codes
            // are reserved for connect/auth-phase errors; future work could
            // extend the mapping if shell-open distinguishes further.
            closeAll(1011, `shell_failed: ${err.message}`);
            return;
          }
          channel = stream;

          // SSH → WS: ship both stdout and stderr as binary frames. ssh2
          // separates them on the channel but xterm-js handles ANSI on a
          // single byte stream just fine.
          stream.on('data', (chunk: Buffer) => {
            if (clientWs.readyState === WebSocket.OPEN) {
              try { clientWs.send(chunk, { binary: true }); } catch { /* noop */ }
            }
          });
          stream.stderr.on('data', (chunk: Buffer) => {
            if (clientWs.readyState === WebSocket.OPEN) {
              try { clientWs.send(chunk, { binary: true }); } catch { /* noop */ }
            }
          });

          // Mirror the workspace-terminal protocol on exit so the frontend
          // can share a single hook later: JSON text-frame, NOT binary.
          stream.on('exit', (code: number | null) => {
            if (clientWs.readyState === WebSocket.OPEN) {
              try {
                clientWs.send(
                  JSON.stringify({ type: 'exit', exitCode: code ?? null }),
                );
              } catch { /* noop */ }
            }
          });
          stream.on('close', () => closeAll());
        },
      );

      // WS → SSH: text JSON frames are control (only `resize` defined);
      // anything else gets piped to stdin as bytes. Mirrors the
      // workspace-terminal direction for protocol symmetry.
      clientWs.on('message', (data, isBinary) => {
        if (!channel) {
          // Pre-shell stdin gets dropped; the user is typing before the
          // channel is alive. Cheaper than buffering.
          return;
        }
        if (!isBinary) {
          const text = data.toString();
          // Tolerate either a stringified Buffer or a real text frame.
          try {
            const msg = JSON.parse(text);
            if (msg && msg.type === 'resize') {
              const cols = Number(msg.cols);
              const rows = Number(msg.rows);
              if (Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0) {
                try { channel.setWindow(rows, cols, 0, 0); } catch { /* noop */ }
              }
              return;
            }
            // Unknown control frame — fall through and treat as stdin.
          } catch {
            // Not JSON — fall through to stdin.
          }
          try { channel.write(text); } catch { /* noop */ }
          return;
        }
        try { channel.write(data as Buffer); } catch { /* noop */ }
      });

      clientWs.on('close', () => closeAll());
      clientWs.on('error', () => closeAll(1011, 'ws_error'));
      sshClient.on('end', () => closeAll());
      sshClient.on('close', () => closeAll());
      sshClient.on('error', (err) => closeAll(1011, err.message || 'ssh_error'));
    });
  });

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

  httpServer.on('upgrade', (req: import('http').IncomingMessage, socket: import('net').Socket, head: Buffer) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (!EVENTS_ROUTE.test(url.pathname)) return;

    const reject = (status: number, msg: string) => {
      socket.write(`HTTP/1.1 ${status} ${msg}\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };

    let userId: string | undefined;
    if (authService.isAuthEnabled()) {
      const token = url.searchParams.get('token');
      if (!token) return reject(401, 'Unauthorized');
      try {
        const payload = jwt.verify(token) as { sub?: string; userId?: string };
        userId = payload.sub || payload.userId;
      } catch {
        return reject(401, 'Unauthorized');
      }
      if (!userId) return reject(401, 'Unauthorized');
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
        // Privacy filter first — userId-scoped events never leak across users.
        if (event.userId && event.userId !== userId) return [];
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
        // questions (no targetUserId) flow to every subscription.
        if (event.targetUserId && event.targetUserId !== userId) return [];
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
        let msg: { type?: string; id?: string; scope?: string; projectId?: string };
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (!msg || typeof msg !== 'object') return;
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
  });

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`DevGrimoire API running on port ${port}`);
  console.log(`MCP HTTP transport available at /mcp (Streamable HTTP) and /sse (Legacy SSE)`);
}
bootstrap();
