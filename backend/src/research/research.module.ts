import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Research, ResearchSchema } from './schemas/research.schema';
import { ResearchStep, ResearchStepSchema } from './schemas/research-step.schema';
import { ResearchStepsService } from './research-steps.service';
import { ResearchService } from './research.service';
import { ResearchController } from './research.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Research.name, schema: ResearchSchema },
      { name: ResearchStep.name, schema: ResearchStepSchema },
    ]),
  ],
  controllers: [ResearchController],
  providers: [ResearchService, ResearchStepsService],
  exports: [ResearchService, ResearchStepsService],
})
export class ResearchModule {}
