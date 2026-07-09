import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ResearchTopic, ResearchTopicSchema } from './schemas/research-topic.schema';
import { ResearchArtifact, ResearchArtifactSchema } from './schemas/research-artifact.schema';
import {
  ResearchArtifactVersion,
  ResearchArtifactVersionSchema,
} from './schemas/research-artifact-version.schema';
import { ResearchRun, ResearchRunSchema } from './schemas/research-run.schema';
import { ResearchTopicService } from './research-topic.service';
import { ResearchArtifactService } from './research-artifact.service';
import { ResearchRunService } from './research-run.service';
import { ResearchAgentService } from './research-agent.service';
import { ResearchScheduler } from './research-scheduler';
import { ResearchAgentController } from './research-agent.controller';
import { CountersModule } from '../counters/counters.module';
import { SettingsModule } from '../settings/settings.module';
import { BalancerModule } from '../balancer/balancer.module';
import { RagModule } from '../rag/rag.module';
import { WebSearchModule } from '../web-search/web-search.module';
import { CustomersModule } from '../customers/customers.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ChatLlmService } from '../chat/chat-llm.service';
import { EncryptionService } from '../common/encryption.service';

// `AuthService` (background agent's RequestContext build) and
// `ProjectsService` (scope 'all' expansion) are NOT imported here on
// purpose — `AuthModule`/`ProjectsModule` are both `@Global()`, so their
// exports are already available in this module's DI container (same
// pattern already used by chat/chat-context.service.ts and
// customers/customers.service.ts, which inject `ProjectsService` without
// their own modules importing `ProjectsModule`).
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ResearchTopic.name, schema: ResearchTopicSchema },
      { name: ResearchArtifact.name, schema: ResearchArtifactSchema },
      { name: ResearchArtifactVersion.name, schema: ResearchArtifactVersionSchema },
      { name: ResearchRun.name, schema: ResearchRunSchema },
    ]),
    CountersModule,
    SettingsModule,
    BalancerModule,
    RagModule,
    WebSearchModule,
    CustomersModule,
    NotificationsModule,
  ],
  controllers: [ResearchAgentController],
  providers: [
    ResearchTopicService,
    ResearchArtifactService,
    ResearchRunService,
    ResearchAgentService,
    // `ScheduleModule.forRoot()` is registered app-wide (app.module.ts) — no
    // module-local import needed for `@Cron` to be picked up here.
    ResearchScheduler,
    // Registered here directly (its own instance, not ChatModule's) —
    // mirrors how RagModule/BalancerModule each provide their own
    // `EncryptionService` rather than importing a shared module for it.
    // Pulling in the full `ChatModule` would drag in its large import graph
    // (forwardRef cycles with MilestonesModule/RecurringTasksModule) for a
    // dependency that only needs SettingsService/EncryptionService/
    // BalancerGateway.
    ChatLlmService,
    EncryptionService,
  ],
  exports: [ResearchTopicService, ResearchArtifactService, ResearchRunService, ResearchAgentService],
})
export class ResearchAgentModule {}
