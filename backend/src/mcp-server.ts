import { readFileSync } from 'fs';
import { resolve } from 'path';
import { NestFactory } from '@nestjs/core';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
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
import { AuthService } from './auth/auth.service';
import { CustomersService } from './customers/customers.service';
import { UserRole } from './auth/schemas/user.schema';
import { registerMcpTools } from './mcp-tools';

// Load .env from project root (parent of backend/)
try {
  const envPath = resolve(__dirname, '../../.env');
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    // Don't override existing env vars (CLI config takes precedence)
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
} catch {
  // .env not found — use defaults
}

async function bootstrap() {
  // Signal to RagService that we're in stdio mode (skip background indexing)
  process.env.MCP_STDIO = 'true';

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  // Resolve a default user for stdio MCP — per-user scoped tools (chat_*) need
  // an owner. Honor explicit MCP_STDIO_USER_ID env, else fall back to the first
  // admin in the database.
  if (!process.env.MCP_STDIO_USER_ID) {
    try {
      const authService = app.get(AuthService);
      const users = await authService.findAllUsers();
      const admin = users.find((u) => u.role === UserRole.ADMIN) ?? users[0];
      if (admin) {
        process.env.MCP_STDIO_USER_ID = admin._id.toString();
      }
    } catch {
      // No users yet (auth disabled) — chat tools will throw if called
    }
  }

  const server = new Server(
    { name: 'DevGrimoire', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  registerMcpTools(server, {
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
    customersService: app.get(CustomersService),
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
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

bootstrap();
