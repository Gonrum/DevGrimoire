import { Module, OnModuleInit } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { WorkflowsController } from './workflows.controller';
import { WorkflowsService } from './workflows.service';
import { WorkflowDefinition, WorkflowDefinitionSchema } from './schemas/workflow-definition.schema';
import { WorkflowRun, WorkflowRunSchema } from './schemas/workflow-run.schema';
import { WorkflowNodeRun, WorkflowNodeRunSchema } from './schemas/workflow-node-run.schema';
import { WorkflowEngineService } from './engine/workflow-engine.service';
import { WorkflowQueueService } from './engine/workflow-queue.service';
import { WorkflowWorkerPool } from './engine/workflow-worker.pool';
import { WorkflowSchedulerService } from './engine/workflow-scheduler.service';
import { NodeRegistry } from './engine/node-registry';
import { TriggerManualExecutor } from './nodes/trigger-manual.executor';
import { TriggerScheduleExecutor } from './nodes/trigger-schedule.executor';
import { ActionLogExecutor } from './nodes/action-log.executor';
import { ActionTodoCreateExecutor } from './nodes/action-todo-create.executor';
import { ActionNotifyExecutor } from './nodes/action-notify.executor';
import { ActionUserQuestionExecutor } from './nodes/action-user-question.executor';
import { TodosModule } from '../todos/todos.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { QuestionsModule } from '../questions/questions.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: WorkflowDefinition.name, schema: WorkflowDefinitionSchema },
      { name: WorkflowRun.name, schema: WorkflowRunSchema },
      { name: WorkflowNodeRun.name, schema: WorkflowNodeRunSchema },
    ]),
    TodosModule,
    NotificationsModule,
    QuestionsModule,
  ],
  controllers: [WorkflowsController],
  providers: [
    WorkflowsService,
    WorkflowEngineService,
    WorkflowQueueService,
    WorkflowWorkerPool,
    WorkflowSchedulerService,
    NodeRegistry,
    TriggerManualExecutor,
    TriggerScheduleExecutor,
    ActionLogExecutor,
    ActionTodoCreateExecutor,
    ActionNotifyExecutor,
    ActionUserQuestionExecutor,
  ],
  exports: [WorkflowsService, WorkflowEngineService],
})
export class WorkflowsModule implements OnModuleInit {
  constructor(
    private readonly registry: NodeRegistry,
    private readonly triggerManual: TriggerManualExecutor,
    private readonly triggerSchedule: TriggerScheduleExecutor,
    private readonly actionLog: ActionLogExecutor,
    private readonly actionTodo: ActionTodoCreateExecutor,
    private readonly actionNotify: ActionNotifyExecutor,
    private readonly actionUserQuestion: ActionUserQuestionExecutor,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.triggerManual);
    this.registry.register(this.triggerSchedule);
    this.registry.register(this.actionLog);
    this.registry.register(this.actionTodo);
    this.registry.register(this.actionNotify);
    this.registry.register(this.actionUserQuestion);
  }
}
