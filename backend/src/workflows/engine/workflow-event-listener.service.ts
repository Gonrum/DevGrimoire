import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  WorkflowDefinition,
  WorkflowDefinitionDocument,
  WorkflowScope,
  WorkflowStatus,
} from '../schemas/workflow-definition.schema';
import { WorkflowsService } from '../workflows.service';
import { PROJECT_CHANGED, ProjectChangeEvent } from '../../events/project-event';

@Injectable()
export class WorkflowEventListener {
  private readonly logger = new Logger(WorkflowEventListener.name);

  constructor(
    @InjectModel(WorkflowDefinition.name)
    private readonly definitionModel: Model<WorkflowDefinitionDocument>,
    private readonly workflowsService: WorkflowsService,
  ) {}

  @OnEvent(PROJECT_CHANGED)
  async handleProjectChange(payload: ProjectChangeEvent): Promise<void> {
    if (!payload.projectId && !payload.customerId) return;
    const isProject = !!payload.projectId;
    const scope = isProject ? WorkflowScope.PROJECT : WorkflowScope.CUSTOMER;
    const triggerType = isProject ? 'trigger.project_event' : 'trigger.customer_event';

    const filter: Record<string, unknown> = {
      scope,
      status: WorkflowStatus.ACTIVE,
      'nodes.type': triggerType,
    };
    if (isProject) filter.projectId = new Types.ObjectId(payload.projectId!);
    else filter.customerId = new Types.ObjectId(payload.customerId!);

    const candidates = await this.definitionModel.find(filter).exec();
    for (const def of candidates) {
      for (const node of def.nodes) {
        if (node.type !== triggerType) continue;
        if (!this.matches(node.config, payload)) continue;
        try {
          await this.workflowsService.startRun({
            definitionId: (def._id as { toString(): string }).toString(),
            triggeredBy: { type: 'event' },
            input: { event: payload, matchedNodeId: node.id },
          } as never);
        } catch (err) {
          this.logger.warn(`event-trigger failed for ${def.name}: ${(err as Error).message}`);
        }
      }
    }
  }

  private matches(config: Record<string, unknown>, ev: ProjectChangeEvent): boolean {
    const wantEntity = (config.entity as string) ?? '*';
    const wantAction = (config.action as string) ?? '*';
    if (wantEntity !== '*' && wantEntity !== ev.entity) return false;
    if (wantAction !== '*' && wantAction !== ev.action) return false;
    return true;
  }
}
