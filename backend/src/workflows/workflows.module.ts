import { forwardRef, Module, OnModuleInit } from '@nestjs/common';
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
import { WorkflowDelayScheduler } from './engine/workflow-delay-scheduler';
import { WorkflowEventListener } from './engine/workflow-event-listener.service';
import { NodeRegistry } from './engine/node-registry';
import { WorkflowNodeTypesController } from './workflow-node-types.controller';
import { WorkflowAgentService } from './workflow-agent.service';
import { WorkflowAgentController } from './workflow-agent.controller';
import { TriggerManualExecutor } from './nodes/trigger-manual.executor';
import { TriggerScheduleExecutor } from './nodes/trigger-schedule.executor';
import { TriggerProjectEventExecutor } from './nodes/trigger-project-event.executor';
import { TriggerCustomerEventExecutor } from './nodes/trigger-customer-event.executor';
import { ActionLogExecutor } from './nodes/action-log.executor';
import { ActionTodoCreateExecutor } from './nodes/action-todo-create.executor';
import { ActionTodoUpdateExecutor } from './nodes/action-todo-update.executor';
import { ActionTodoCommentExecutor } from './nodes/action-todo-comment.executor';
import { ActionTodoLinkMilestoneExecutor } from './nodes/action-todo-link-milestone.executor';
import { ActionKnowledgeCreateExecutor } from './nodes/action-knowledge-create.executor';
import { ActionManualCreateExecutor } from './nodes/action-manual-create.executor';
import { ActionChangelogAddExecutor } from './nodes/action-changelog-add.executor';
import { ActionNotifyExecutor } from './nodes/action-notify.executor';
import { ActionUserQuestionExecutor } from './nodes/action-user-question.executor';
import { ControlConditionExecutor } from './nodes/control-condition.executor';
import { ControlDelayExecutor } from './nodes/control-delay.executor';
import { AgentTaskExecutor } from './nodes/agent-task.executor';
import { TodosModule } from '../todos/todos.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { QuestionsModule } from '../questions/questions.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { ManualsModule } from '../manuals/manuals.module';
import { ChangelogModule } from '../changelog/changelog.module';
import { ChatModule } from '../chat/chat.module';
import { SettingsModule } from '../settings/settings.module';
import { CommonModule } from '../common/common.module';
import { BalancerModule } from '../balancer/balancer.module';

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
    KnowledgeModule,
    ManualsModule,
    ChangelogModule,
    forwardRef(() => ChatModule),
    SettingsModule,
    CommonModule,
    BalancerModule,
  ],
  controllers: [WorkflowsController, WorkflowNodeTypesController, WorkflowAgentController],
  providers: [
    WorkflowsService,
    WorkflowEngineService,
    WorkflowQueueService,
    WorkflowWorkerPool,
    WorkflowSchedulerService,
    WorkflowDelayScheduler,
    WorkflowEventListener,
    WorkflowAgentService,
    NodeRegistry,
    TriggerManualExecutor,
    TriggerScheduleExecutor,
    TriggerProjectEventExecutor,
    TriggerCustomerEventExecutor,
    ActionLogExecutor,
    ActionTodoCreateExecutor,
    ActionTodoUpdateExecutor,
    ActionTodoCommentExecutor,
    ActionTodoLinkMilestoneExecutor,
    ActionKnowledgeCreateExecutor,
    ActionManualCreateExecutor,
    ActionChangelogAddExecutor,
    ActionNotifyExecutor,
    ActionUserQuestionExecutor,
    ControlConditionExecutor,
    ControlDelayExecutor,
    AgentTaskExecutor,
  ],
  exports: [WorkflowsService, WorkflowEngineService, WorkflowAgentService, NodeRegistry],
})
export class WorkflowsModule implements OnModuleInit {
  constructor(
    private readonly registry: NodeRegistry,
    private readonly triggerManual: TriggerManualExecutor,
    private readonly triggerSchedule: TriggerScheduleExecutor,
    private readonly triggerProjectEvent: TriggerProjectEventExecutor,
    private readonly triggerCustomerEvent: TriggerCustomerEventExecutor,
    private readonly actionLog: ActionLogExecutor,
    private readonly actionTodoCreate: ActionTodoCreateExecutor,
    private readonly actionTodoUpdate: ActionTodoUpdateExecutor,
    private readonly actionTodoComment: ActionTodoCommentExecutor,
    private readonly actionTodoLinkMilestone: ActionTodoLinkMilestoneExecutor,
    private readonly actionKnowledgeCreate: ActionKnowledgeCreateExecutor,
    private readonly actionManualCreate: ActionManualCreateExecutor,
    private readonly actionChangelogAdd: ActionChangelogAddExecutor,
    private readonly actionNotify: ActionNotifyExecutor,
    private readonly actionUserQuestion: ActionUserQuestionExecutor,
    private readonly controlCondition: ControlConditionExecutor,
    private readonly controlDelay: ControlDelayExecutor,
    private readonly agentTask: AgentTaskExecutor,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.triggerManual);
    this.registry.register(this.triggerSchedule);
    this.registry.register(this.triggerProjectEvent);
    this.registry.register(this.triggerCustomerEvent);
    this.registry.register(this.actionLog);
    this.registry.register(this.actionTodoCreate);
    this.registry.register(this.actionTodoUpdate);
    this.registry.register(this.actionTodoComment);
    this.registry.register(this.actionTodoLinkMilestone);
    this.registry.register(this.actionKnowledgeCreate);
    this.registry.register(this.actionManualCreate);
    this.registry.register(this.actionChangelogAdd);
    this.registry.register(this.actionNotify);
    this.registry.register(this.actionUserQuestion);
    this.registry.register(this.controlCondition);
    this.registry.register(this.controlDelay);
    this.registry.register(this.agentTask);
  }
}
