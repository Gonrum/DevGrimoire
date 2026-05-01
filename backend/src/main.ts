import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
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
import { SettingsService } from './settings/settings.service';
import { NotificationsService } from './notifications/notifications.service';
import { SchemasService } from './schemas/schemas.service';
import { DependenciesService } from './dependencies/dependencies.service';
import { FeaturesService } from './features/features.service';
import { SoulsService } from './souls/souls.service';
import { CommitsService } from './commits/commits.service';
import { RagService } from './rag/rag.service';
import { RecurringTasksService } from './recurring-tasks/recurring-tasks.service';
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
import { registerMcpTools, McpServices } from './mcp-tools';
import { ApiKeysService } from './api-keys/api-keys.service';
import { AuthService } from './auth/auth.service';
import { JwtService } from '@nestjs/jwt';
import WebSocket, { WebSocketServer } from 'ws';
import { RequestContext, RequestUser } from './common/request-context';

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
    settingsService: app.get(SettingsService),
    notificationsService: app.get(NotificationsService),
    schemasService: app.get(SchemasService),
    dependenciesService: app.get(DependenciesService),
    featuresService: app.get(FeaturesService),
    soulsService: app.get(SoulsService),
    commitsService: app.get(CommitsService),
    ragService: app.get(RagService),
    recurringTasksService: app.get(RecurringTasksService),
    snippetsService: app.get(SnippetsService),
    attachmentsService: app.get(AttachmentsService),
    questionsService: app.get(QuestionsService),
    authService: app.get(AuthService),
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
  // Track authenticated SSE sessions and the user that owns them.
  const authenticatedSessions = new Map<string, RequestUser>();

  // API Key auth middleware for MCP endpoints
  const apiKeysService = app.get(ApiKeysService);
  const authService = app.get(AuthService);

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
    // /messages requests belong to an SSE session that was already authenticated on /sse
    const sessionId = req.query?.sessionId as string | undefined;
    const cachedUser = sessionId ? authenticatedSessions.get(sessionId) : undefined;
    if (cachedUser) {
      req.user = cachedUser;
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
          },
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) delete transports[sid];
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
      authenticatedSessions.set(transport.sessionId, req.user as RequestUser);
    }
    res.on('close', () => {
      delete transports[transport.sessionId];
      authenticatedSessions.delete(transport.sessionId);
    });
    const server = createMcpServer(services);
    await server.connect(transport);
  });

  expressApp.post('/messages', async (req: any, res: any) => {
    const sessionId = req.query.sessionId as string;
    const transport = transports[sessionId];
    if (transport instanceof SSEServerTransport) {
      await RequestContext.run(req.user, undefined, () => transport.handlePostMessage(req, res, req.body));
    } else {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'No valid SSE session found' },
        id: null,
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

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`DevGrimoire API running on port ${port}`);
  console.log(`MCP HTTP transport available at /mcp (Streamable HTTP) and /sse (Legacy SSE)`);
}
bootstrap();
