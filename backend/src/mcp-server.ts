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
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

bootstrap();
