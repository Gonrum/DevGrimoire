import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { KnowledgeGraphController } from './knowledge-graph.controller';
import { KnowledgeGraphService } from './knowledge-graph.service';
import {
  KnowledgeGraphEdge,
  KnowledgeGraphEdgeSchema,
} from './schemas/knowledge-graph-edge.schema';
import { Todo, TodoSchema } from '../todos/schemas/todo.schema';
import { Milestone, MilestoneSchema } from '../milestones/schemas/milestone.schema';
import { Knowledge, KnowledgeSchema } from '../knowledge/schemas/knowledge.schema';
import { Manual, ManualSchema } from '../manuals/schemas/manual.schema';
import { Changelog, ChangelogSchema } from '../changelog/schemas/changelog.schema';
import {
  ValidationReport,
  ValidationReportSchema,
} from '../validation-reports/schemas/validation-report.schema';
import {
  DocUpdateProposal,
  DocUpdateProposalSchema,
} from '../doc-update-proposals/schemas/doc-update-proposal.schema';
import { Commit, CommitSchema } from '../commits/schemas/commit.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: KnowledgeGraphEdge.name, schema: KnowledgeGraphEdgeSchema },
      { name: Todo.name, schema: TodoSchema },
      { name: Milestone.name, schema: MilestoneSchema },
      { name: Knowledge.name, schema: KnowledgeSchema },
      { name: Manual.name, schema: ManualSchema },
      { name: Changelog.name, schema: ChangelogSchema },
      { name: ValidationReport.name, schema: ValidationReportSchema },
      { name: DocUpdateProposal.name, schema: DocUpdateProposalSchema },
      { name: Commit.name, schema: CommitSchema },
    ]),
  ],
  controllers: [KnowledgeGraphController],
  providers: [KnowledgeGraphService],
  exports: [KnowledgeGraphService],
})
export class KnowledgeGraphModule {}
