import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { Todo, TodoSchema } from '../todos/schemas/todo.schema';
import { Knowledge, KnowledgeSchema } from '../knowledge/schemas/knowledge.schema';
import { Changelog, ChangelogSchema } from '../changelog/schemas/changelog.schema';
import { Research, ResearchSchema } from '../research/schemas/research.schema';
import { Milestone, MilestoneSchema } from '../milestones/schemas/milestone.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Todo.name, schema: TodoSchema },
      { name: Knowledge.name, schema: KnowledgeSchema },
      { name: Changelog.name, schema: ChangelogSchema },
      { name: Research.name, schema: ResearchSchema },
      { name: Milestone.name, schema: MilestoneSchema },
    ]),
  ],
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}
