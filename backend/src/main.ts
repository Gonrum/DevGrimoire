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
import { registerMcpTools, McpServices } from './mcp-tools';
import { ApiKeysService } from './api-keys/api-keys.service';
import { AuthService } from './auth/auth.service';
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
    logsService: app.get(LogsService),
    releasesService: app.get(ReleasesService),
    chatService: app.get(ChatService),
    chatLlmService: app.get(ChatLlmService),
    chatContextService: app.get(ChatContextService),
    webSearchService: app.get(WebSearchService),
    readabilityService: app.get(ReadabilityService),
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
    req.user = {
      userId: validated.userId.toString(),
      username: 'api-key',
      role: 'user',
    } satisfies RequestUser;

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

      await RequestContext.run(req.user, () => transport.handleRequest(req, res, req.body));
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
      await RequestContext.run(req.user, () => transport.handlePostMessage(req, res, req.body));
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

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`DevGrimoire API running on port ${port}`);
  console.log(`MCP HTTP transport available at /mcp (Streamable HTTP) and /sse (Legacy SSE)`);
}
bootstrap();
