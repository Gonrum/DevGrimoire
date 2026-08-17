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
import { errorMessage } from '../workflow-narrow';

/**
 * Ein Filterfeld der Trigger-Konfiguration gegen den Event-Wert.
 *
 * Verhalten identisch zum vorherigen `(config.entity as string) ?? '*'`:
 * fehlt das Feld, gilt Wildcard; steht `'*'` drin, gilt Wildcard; ein String
 * muss gleich sein. Ein Nicht-String (z.B. eine Zahl aus einem handgeschriebenen
 * Config-JSON) fällt durch den Vergleich und matcht nicht — er wird bewusst
 * **nicht** zur Wildcard, das würde den Trigger aufweiten.
 *
 * Bewusst eine Modul-Funktion und keine Methode: `matches` wird in
 * `scripts/workflow-nodes-units-check.cjs` vom Prototyp gelöst und mit
 * `matches.call({}, …)` aufgerufen. Eine `this.`-Delegation wäre dort
 * `undefined`.
 */
function matchesFilter(want: unknown, actual: string): boolean {
  if (want === undefined || want === null || want === '*') return true;
  return want === actual;
}

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
            definitionId: def._id.toString(),
            triggeredBy: { type: 'event' },
            input: { event: payload, matchedNodeId: node.id },
          });
        } catch (err: unknown) {
          this.logger.warn(`event-trigger failed for ${def.name}: ${errorMessage(err)}`);
        }
      }
    }
  }

  private matches(config: Record<string, unknown>, ev: ProjectChangeEvent): boolean {
    return matchesFilter(config.entity, ev.entity) && matchesFilter(config.action, ev.action);
  }
}
