import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule } from '@nestjs/bullmq';
import { Research, ResearchSchema } from './schemas/research.schema';
import { ResearchStep, ResearchStepSchema } from './schemas/research-step.schema';
import { ResearchStepsService } from './research-steps.service';
import { ResearchService } from './research.service';
import { ResearchController } from './research.controller';
import { BalancerModule } from '../balancer/balancer.module';
import { ResearchLiveService } from './research-live.service';
import { ResearchLlmService } from './research-llm.service';
import { WebSearchModule } from '../web-search/web-search.module';
import { WebSearchService } from '../web-search/services/web-search.service';
import { ReadabilityService } from '../web-search/services/readability.service';
import { ResearchWeb } from './research-web';
import { RagModule } from '../rag/rag.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { User, UserSchema } from '../auth/schemas/user.schema';
import { ResearchRunStore } from './research-run-store';
import { ResearchOwnerLookup } from './research-owner';
import { RESEARCH_QUEUE, ResearchQueueService } from './research-queue';
import { ResearchRunnerService } from './research-runner.service';
import { ResearchProcessor } from './research.processor';
import { ResearchControlService } from './research-control.service';
import { ResearchRunsController } from './research-runs.controller';
import { ResearchCustomerLookup, ResearchProjectLookup } from './research-targets';
import { Project, ProjectSchema } from '../projects/schemas/project.schema';
import { Customer, CustomerSchema } from '../customers/schemas/customer.schema';

@Module({
  imports: [
    BalancerModule,
    WebSearchModule,
    RagModule,
    NotificationsModule,
    BullModule.registerQueue({ name: RESEARCH_QUEUE }),
    MongooseModule.forFeature([
      { name: Research.name, schema: ResearchSchema },
      { name: ResearchStep.name, schema: ResearchStepSchema },
      // Nur lesend: Besitzer eines Laufs (Scope). Direkt das Modell statt
      // AuthService, um keinen Modul-Zyklus zu bauen (Muster aus PushModule).
      { name: User.name, schema: UserSchema },
      // Nur für die Existenzprüfung beim Verschieben (ProjectsModule importiert dieses Modul).
      { name: Project.name, schema: ProjectSchema },
      { name: Customer.name, schema: CustomerSchema },
    ]),
  ],
  // Reihenfolge ist Pflicht: statische Routen (queue, start) vor dem Legacy-`GET :id`.
  controllers: [ResearchRunsController, ResearchController],
  providers: [
    ResearchService,
    ResearchStepsService,
    ResearchLiveService,
    ResearchLlmService,
    {
      provide: ResearchWeb,
      useFactory: (search: WebSearchService, readability: ReadabilityService) => new ResearchWeb(search, readability),
      inject: [WebSearchService, ReadabilityService],
    },
    ResearchRunStore,
    ResearchOwnerLookup,
    ResearchQueueService,
    ResearchRunnerService,
    ResearchProcessor,
    ResearchProjectLookup,
    ResearchCustomerLookup,
    ResearchControlService,
  ],
  exports: [
    ResearchService, ResearchStepsService, ResearchLiveService, ResearchLlmService, ResearchWeb,
    ResearchRunStore, ResearchQueueService, ResearchRunnerService, ResearchControlService,
  ],
})
export class ResearchModule {}
