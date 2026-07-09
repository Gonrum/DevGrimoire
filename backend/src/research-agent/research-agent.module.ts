import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ResearchTopic, ResearchTopicSchema } from './schemas/research-topic.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ResearchTopic.name, schema: ResearchTopicSchema },
    ]),
  ],
  controllers: [],
  providers: [],
  exports: [],
})
export class ResearchAgentModule {}
