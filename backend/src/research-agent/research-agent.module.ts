import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ResearchTopic, ResearchTopicSchema } from './schemas/research-topic.schema';
import { ResearchArtifact, ResearchArtifactSchema } from './schemas/research-artifact.schema';
import {
  ResearchArtifactVersion,
  ResearchArtifactVersionSchema,
} from './schemas/research-artifact-version.schema';
import { ResearchRun, ResearchRunSchema } from './schemas/research-run.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ResearchTopic.name, schema: ResearchTopicSchema },
      { name: ResearchArtifact.name, schema: ResearchArtifactSchema },
      { name: ResearchArtifactVersion.name, schema: ResearchArtifactVersionSchema },
      { name: ResearchRun.name, schema: ResearchRunSchema },
    ]),
  ],
  controllers: [],
  providers: [],
  exports: [],
})
export class ResearchAgentModule {}
