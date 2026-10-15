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

@Module({
  imports: [
    BalancerModule,
    MongooseModule.forFeature([
      { name: Research.name, schema: ResearchSchema },
      { name: ResearchStep.name, schema: ResearchStepSchema },
    ]),
  ],
  controllers: [ResearchController],
  providers: [ResearchService, ResearchStepsService, ResearchLiveService, ResearchLlmService],
  exports: [ResearchService, ResearchStepsService, ResearchLiveService, ResearchLlmService],
})
export class ResearchModule {}
