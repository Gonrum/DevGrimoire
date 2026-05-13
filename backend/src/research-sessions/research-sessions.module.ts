import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  ResearchSession,
  ResearchSessionSchema,
} from './schemas/research-session.schema';
import {
  ResearchStep,
  ResearchStepSchema,
} from './schemas/research-step.schema';
import { ResearchSessionsService } from './research-sessions.service';
import { ResearchSessionsController } from './research-sessions.controller';
import { CountersModule } from '../counters/counters.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ResearchSession.name, schema: ResearchSessionSchema },
      { name: ResearchStep.name, schema: ResearchStepSchema },
    ]),
    CountersModule,
  ],
  controllers: [ResearchSessionsController],
  providers: [ResearchSessionsService],
  exports: [ResearchSessionsService],
})
export class ResearchSessionsModule {}
