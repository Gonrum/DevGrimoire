import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
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

@Module({
  imports: [
    BalancerModule,
    WebSearchModule,
    MongooseModule.forFeature([
      { name: Research.name, schema: ResearchSchema },
      { name: ResearchStep.name, schema: ResearchStepSchema },
    ]),
  ],
  controllers: [ResearchController],
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
  ],
  exports: [ResearchService, ResearchStepsService, ResearchLiveService, ResearchLlmService, ResearchWeb],
})
export class ResearchModule {}
