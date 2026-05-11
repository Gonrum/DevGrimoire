import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { WorkflowsController } from './workflows.controller';
import { WorkflowsService } from './workflows.service';
import { WorkflowDefinition, WorkflowDefinitionSchema } from './schemas/workflow-definition.schema';
import { WorkflowRun, WorkflowRunSchema } from './schemas/workflow-run.schema';
import { WorkflowNodeRun, WorkflowNodeRunSchema } from './schemas/workflow-node-run.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: WorkflowDefinition.name, schema: WorkflowDefinitionSchema },
      { name: WorkflowRun.name, schema: WorkflowRunSchema },
      { name: WorkflowNodeRun.name, schema: WorkflowNodeRunSchema },
    ]),
  ],
  controllers: [WorkflowsController],
  providers: [WorkflowsService],
  exports: [WorkflowsService],
})
export class WorkflowsModule {}
