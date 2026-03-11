import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
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
import { registerMcpTools, McpServices } from './mcp-tools';
import { ApiKeysService } from './api-keys/api-keys.service';
import { AuthService } from './auth/auth.service';

function createMcpServer(services: McpServices): Server {
  const server = new Server(
    { name: 'ClaudeVault', version: '1.0.0' },
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

  // JSON body parser for all routes
  expressApp.use(json());

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
  };

  const transports: Record<string, SSEServerTransport | StreamableHTTPServerTransport> = {};

  // API Key auth middleware for MCP endpoints
  const apiKeysService = app.get(ApiKeysService);
  const authService = app.get(AuthService);

  const mcpAuthMiddleware = async (req: any, res: any, next: any) => {
    // Skip auth if auth is not enabled
    if (!authService.isAuthEnabled()) return next();

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

    next();
  };

  expressApp.use('/mcp', mcpAuthMiddleware);
  expressApp.use('/sse', mcpAuthMiddleware);
  expressApp.use('/messages', mcpAuthMiddleware);

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

      await transport.handleRequest(req, res, req.body);
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
    res.on('close', () => {
      delete transports[transport.sessionId];
    });
    const server = createMcpServer(services);
    await server.connect(transport);
  });

  expressApp.post('/messages', async (req: any, res: any) => {
    const sessionId = req.query.sessionId as string;
    const transport = transports[sessionId];
    if (transport instanceof SSEServerTransport) {
      await transport.handlePostMessage(req, res, req.body);
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
  console.log(`ClaudeVault API running on port ${port}`);
  console.log(`MCP HTTP transport available at /mcp (Streamable HTTP) and /sse (Legacy SSE)`);
}
bootstrap();
