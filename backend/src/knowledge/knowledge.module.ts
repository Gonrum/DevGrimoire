import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Knowledge, KnowledgeSchema } from './schemas/knowledge.schema';
import { KnowledgeService } from './knowledge.service';
import { KnowledgeController } from './knowledge.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Knowledge.name, schema: KnowledgeSchema },
    ]),
  ],
  controllers: [KnowledgeController],
  providers: [KnowledgeService],
  exports: [KnowledgeService],
})
export class KnowledgeModule {}
