import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AuditLogService } from '../audit-log/audit-log.service';
import {
  CustomerProjectLink,
  CustomerProjectLinkDocument,
  CustomerProjectLinkStatus,
} from '../customers/schemas/customer-project-link.schema';
import { WorkflowRun } from './schemas/workflow-run.schema';
import { NodeResult } from './engine/types';

export interface AllowedOwners {
  projectIds: string[];
  customerIds: string[];
}

type RunOwner = Pick<WorkflowRun, 'projectId' | 'customerId'>;

/**
 * Hinter dem Akteur-Kontext (RequestContext) ist das die zweite Schranke: der
 * Akteur darf ein Todo ggf. sehen, der *Lauf* gehört aber zu einem Projekt oder
 * Kunden und darf nur dort wirken. Sonst könnte ein Workflow im Projekt P1 über
 * eine frei konfigurierbare `todoId` Todos aus P2 beschreiben, sobald der
 * Akteur dort Zugriff hat.
 */
@Injectable()
export class WorkflowScopeGuard {
  constructor(
    @InjectModel(CustomerProjectLink.name)
    private readonly linkModel: Model<CustomerProjectLinkDocument>,
    private readonly auditLog: AuditLogService,
  ) {}

  /** Kunden bzw. Projekte, die der Lauf über aktive/pausierte Verlinkungen erreicht. */
  async allowedOwners(run: RunOwner): Promise<AllowedOwners> {
    const projectId = idString(run.projectId);
    const customerId = idString(run.customerId);
    // Nur geprüfte ObjectIds gehen in den Filter: Mongoose entfernt
    // `undefined`-Schlüssel, die Abfrage träfe dann alle Verlinkungen.
    const statusIn = [CustomerProjectLinkStatus.ACTIVE, CustomerProjectLinkStatus.PAUSED];
    if (projectId && Types.ObjectId.isValid(projectId)) {
      const links = await this.linkModel
        .find({ projectId: new Types.ObjectId(projectId), status: { $in: statusIn } })
        .select('customerId')
        .lean()
        .exec();
      return { projectIds: [projectId], customerIds: links.map((l) => l.customerId.toString()) };
    }
    if (customerId && Types.ObjectId.isValid(customerId)) {
      const links = await this.linkModel
        .find({ customerId: new Types.ObjectId(customerId), status: { $in: statusIn } })
        .select('projectId')
        .lean()
        .exec();
      return { projectIds: links.map((l) => l.projectId.toString()), customerIds: [customerId] };
    }
    // System-Scope: kein Besitzer, also auch keine erreichbare Entität.
    return { projectIds: [], customerIds: [] };
  }

  async check(run: RunOwner, entity: { projectId?: unknown; customerId?: unknown }): Promise<boolean> {
    const entityProject = idString(entity.projectId);
    const entityCustomer = idString(entity.customerId);
    if (!entityProject && !entityCustomer) return false;
    const owners = await this.allowedOwners(run);
    return (
      (entityProject !== undefined && owners.projectIds.includes(entityProject)) ||
      (entityCustomer !== undefined && owners.customerIds.includes(entityCustomer))
    );
  }

  /**
   * Schreibt das Audit-Ereignis und liefert das Node-Ergebnis. Die Meldung
   * nennt bewusst nicht die fremde Projekt-/Kunden-ID.
   */
  deny(
    run: WorkflowRun & { _id: Types.ObjectId },
    nodeId: string,
    entity: { type: string; id: string },
  ): NodeResult {
    void this.auditLog.record({
      action: 'workflow.permission.denied',
      entityType: 'workflow-run',
      entityId: run._id.toString(),
      meta: { runId: run._id.toString(), nodeId, entity, code: 'scope_violation' },
    });
    return {
      status: 'failed',
      error: {
        code: 'scope_violation',
        message: `${entity.type} liegt außerhalb des Scopes dieses Workflow-Laufs`,
      },
    };
  }
}

function idString(value: unknown): string | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  if (value instanceof Types.ObjectId) return value.toString();
  return undefined;
}
