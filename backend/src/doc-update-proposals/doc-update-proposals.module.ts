import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DocUpdateProposalsController } from './doc-update-proposals.controller';
import { DocUpdateProposalsService } from './doc-update-proposals.service';
import {
  DocUpdateProposal,
  DocUpdateProposalSchema,
} from './schemas/doc-update-proposal.schema';
import { TodosModule } from '../todos/todos.module';
import { Manual, ManualSchema } from '../manuals/schemas/manual.schema';
import { Knowledge, KnowledgeSchema } from '../knowledge/schemas/knowledge.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: DocUpdateProposal.name, schema: DocUpdateProposalSchema },
      { name: Manual.name, schema: ManualSchema },
      { name: Knowledge.name, schema: KnowledgeSchema },
    ]),
    TodosModule,
  ],
  controllers: [DocUpdateProposalsController],
  providers: [DocUpdateProposalsService],
  exports: [DocUpdateProposalsService],
})
export class DocUpdateProposalsModule {}
