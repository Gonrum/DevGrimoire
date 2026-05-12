import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model, Types, isValidObjectId } from 'mongoose';
import {
  WorkflowDefinition,
  WorkflowDefinitionDocument,
  WorkflowScope,
  WorkflowStatus,
} from './schemas/workflow-definition.schema';
import {
  WorkflowRun,
  WorkflowRunDocument,
  WorkflowRunStatus,
} from './schemas/workflow-run.schema';
import {
  WorkflowNodeRun,
  WorkflowNodeRunDocument,
} from './schemas/workflow-node-run.schema';
import {
  CancelWorkflowRunDto,
  CreateWorkflowDefinitionDto,
  ListWorkflowDefinitionsDto,
  ListWorkflowRunsDto,
  StartWorkflowRunDto,
  UpdateWorkflowDefinitionDto,
} from './dto/workflow.dto';
import { PROJECT_CHANGED } from '../events/project-event';
import { workflowSecurityIssues } from './workflow-security.policy';
import { NodeRegistry } from './engine/node-registry';
import { AuditLogService } from '../audit-log/audit-log.service';
import { RequestContext } from '../common/request-context';
import { redact } from './workflow-redaction';
import { summarizeRisk, WORKFLOW_RUNTIME_LIMITS } from './workflow-security.runtime';
import { getTemplate, listTemplatesPublic, WorkflowTemplate } from './workflow-templates';

const RUNTIME_FIELDS: Array<keyof UpdateWorkflowDefinitionDto> = ['nodes', 'edges', 'trigger'];

@Injectable()
export class WorkflowsService {
  private readonly logger = new Logger(WorkflowsService.name);

  constructor(
    @InjectModel(WorkflowDefinition.name)
    private readonly definitionModel: Model<WorkflowDefinitionDocument>,
    @InjectModel(WorkflowRun.name)
    private readonly runModel: Model<WorkflowRunDocument>,
    @InjectModel(WorkflowNodeRun.name)
    private readonly nodeRunModel: Model<WorkflowNodeRunDocument>,
    private readonly eventEmitter: EventEmitter2,
    private readonly nodeRegistry: NodeRegistry,
    private readonly auditLog: AuditLogService,
  ) {}

  private async audit(
    action: string,
    def?: WorkflowDefinitionDocument,
    run?: WorkflowRunDocument,
    extra?: Record<string, unknown>,
  ): Promise<void> {
    const target = run ?? def;
    if (!target) return;
    await this.auditLog.record({
      action,
      entityType: run ? 'workflow-run' : 'workflow-definition',
      entityId: target._id.toString(),
      meta: {
        ...(def ? { definitionId: def._id.toString(), version: def.version, scope: def.scope, status: def.status } : {}),
        ...(run
          ? {
              definitionId: run.definitionId?.toString(),
              definitionVersion: run.definitionVersion,
              scope: run.scope,
              status: run.status,
            }
          : {}),
        ...(def?.projectId ? { projectId: def.projectId.toString() } : {}),
        ...(def?.customerId ? { customerId: def.customerId.toString() } : {}),
        ...(run?.projectId ? { projectId: run.projectId.toString() } : {}),
        ...(run?.customerId ? { customerId: run.customerId.toString() } : {}),
        ...(extra ?? {}),
      },
    });
  }

  private emitDefinition(
    action: 'created' | 'updated' | 'deleted',
    def: WorkflowDefinitionDocument,
  ): void {
    if (!def.projectId && !def.customerId) return;
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: def.projectId?.toString() || null,
      customerId: def.customerId?.toString() || null,
      entity: 'workflow-definition',
      action,
      entityId: def._id.toString(),
      summary: `Workflow "${def.name}" ${
        action === 'created' ? 'angelegt' : action === 'updated' ? 'aktualisiert' : 'gelöscht'
      }`,
    });
  }

  private emitRun(
    action: 'created' | 'updated' | 'deleted',
    run: WorkflowRunDocument,
    summary: string,
  ): void {
    if (!run.projectId && !run.customerId) return;
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: run.projectId?.toString() || null,
      customerId: run.customerId?.toString() || null,
      entity: 'workflow-run',
      action,
      entityId: run._id.toString(),
      summary,
    });
  }

  private assertScope(dto: { scope: WorkflowScope; projectId?: string; customerId?: string }): void {
    if (dto.scope === WorkflowScope.PROJECT && !dto.projectId) {
      throw new BadRequestException('project scope requires projectId');
    }
    if (dto.scope === WorkflowScope.CUSTOMER && !dto.customerId) {
      throw new BadRequestException('customer scope requires customerId');
    }
    if (dto.scope === WorkflowScope.SYSTEM && (dto.projectId || dto.customerId)) {
      throw new BadRequestException('system scope must not carry projectId or customerId');
    }
    if (dto.projectId && dto.customerId) {
      throw new BadRequestException('Workflow can have either projectId or customerId, not both');
    }
  }

  async createDefinition(dto: CreateWorkflowDefinitionDto): Promise<WorkflowDefinitionDocument> {
    this.assertScope(dto);
    if ((dto.nodes?.length ?? 0) > WORKFLOW_RUNTIME_LIMITS.maxNodesPerDefinition) {
      throw new BadRequestException(
        `Workflow exceeds ${WORKFLOW_RUNTIME_LIMITS.maxNodesPerDefinition} nodes`,
      );
    }
    const created = await this.definitionModel.create({
      scope: dto.scope,
      projectId: dto.projectId ? new Types.ObjectId(dto.projectId) : undefined,
      customerId: dto.customerId ? new Types.ObjectId(dto.customerId) : undefined,
      name: dto.name,
      description: dto.description,
      tags: dto.tags ?? [],
      trigger: dto.trigger ?? { type: 'manual' },
      nodes: dto.nodes ?? [],
      edges: dto.edges ?? [],
      ui: dto.ui,
      version: 1,
      status: WorkflowStatus.DRAFT,
    });
    this.emitDefinition('created', created);
    await this.audit('workflow.definition.created', created);
    return created;
  }

  async listDefinitions(query: ListWorkflowDefinitionsDto): Promise<WorkflowDefinitionDocument[]> {
    const filter: Record<string, unknown> = {};
    if (query.scope) filter.scope = query.scope;
    if (query.projectId) filter.projectId = new Types.ObjectId(query.projectId);
    if (query.customerId) filter.customerId = new Types.ObjectId(query.customerId);
    if (query.status) filter.status = query.status;
    if (query.tag) filter.tags = query.tag;
    if (!query.includeArchived) {
      filter.status = filter.status ?? { $ne: WorkflowStatus.ARCHIVED };
    }
    return this.definitionModel
      .find(filter)
      .sort({ updatedAt: -1 })
      .limit(query.limit ?? 50)
      .skip(query.offset ?? 0)
      .exec();
  }

  async getDefinition(id: string): Promise<WorkflowDefinitionDocument> {
    if (!isValidObjectId(id)) throw new BadRequestException('Invalid workflow id');
    const def = await this.definitionModel.findById(id).exec();
    if (!def) throw new NotFoundException(`Workflow ${id} not found`);
    return def;
  }

  async updateDefinition(
    id: string,
    dto: UpdateWorkflowDefinitionDto,
  ): Promise<WorkflowDefinitionDocument> {
    const existing = await this.getDefinition(id);
    const previousStatus = existing.status;

    const touchesRuntime = RUNTIME_FIELDS.some((field) => dto[field] !== undefined);
    const willBump = dto.publish === true || (touchesRuntime && existing.status !== WorkflowStatus.DRAFT);

    if (dto.name !== undefined) existing.name = dto.name;
    if (dto.description !== undefined) existing.description = dto.description;
    if (dto.status !== undefined) existing.status = dto.status;
    if (dto.tags !== undefined) existing.tags = dto.tags;
    if (dto.trigger !== undefined) existing.trigger = dto.trigger;
    if (dto.nodes !== undefined) existing.nodes = dto.nodes as never;
    if (dto.edges !== undefined) existing.edges = dto.edges as never;
    if (dto.ui !== undefined) existing.ui = dto.ui;

    if ((existing.nodes?.length ?? 0) > WORKFLOW_RUNTIME_LIMITS.maxNodesPerDefinition) {
      throw new BadRequestException(
        `Workflow exceeds ${WORKFLOW_RUNTIME_LIMITS.maxNodesPerDefinition} nodes`,
      );
    }

    if (existing.status === WorkflowStatus.ACTIVE) {
      const validation = this.validateGraph({
        scope: existing.scope,
        projectId: existing.projectId?.toString(),
        customerId: existing.customerId?.toString(),
        nodes: existing.nodes as never,
        edges: existing.edges as never,
      });
      if (!validation.valid) {
        await this.audit('workflow.validation.failed', existing, undefined, {
          issues: validation.issues,
        });
        throw new BadRequestException(`Workflow cannot be activated: ${validation.issues.join('; ')}`);
      }
      const secIssues = workflowSecurityIssues({
        scope: existing.scope,
        nodes: existing.nodes as never,
      });
      if (secIssues.length > 0) {
        await this.audit('workflow.activation.denied', existing, undefined, {
          issues: secIssues,
        });
        throw new BadRequestException(`Workflow cannot be activated: ${secIssues.join('; ')}`);
      }
      const schemaIssues: string[] = [];
      for (const node of existing.nodes) {
        if (!this.nodeRegistry.has(node.type)) continue;
        const schema = this.nodeRegistry.getMetadata(node.type).configSchema;
        const parsed = schema.safeParse(node.config ?? {});
        if (!parsed.success) {
          for (const issue of parsed.error.issues) {
            schemaIssues.push(`node "${node.id}" (${node.type}) config.${issue.path.join('.')}: ${issue.message}`);
          }
        }
      }
      if (schemaIssues.length > 0) {
        await this.audit('workflow.validation.failed', existing, undefined, {
          issues: schemaIssues,
        });
        throw new BadRequestException(`Workflow cannot be activated: ${schemaIssues.join('; ')}`);
      }
    }

    if (willBump) existing.version += 1;

    // Append an approval entry on every activation event (DRAFT/PAUSED → ACTIVE,
    // or version bump while ACTIVE), so re-publishes leave an audit trail too.
    const becameActive =
      existing.status === WorkflowStatus.ACTIVE &&
      (previousStatus !== WorkflowStatus.ACTIVE || willBump);
    if (becameActive) {
      const actor = RequestContext.getUser();
      const risk = summarizeRisk(existing.nodes as never);
      existing.approvals = [
        ...(existing.approvals ?? []),
        {
          version: existing.version,
          approvedAt: new Date(),
          approvedByUserId:
            actor?.userId && isValidObjectId(actor.userId) ? new Types.ObjectId(actor.userId) : undefined,
          approvedByUsername: actor?.username,
          approvedByRole: actor?.role,
          riskSummary: risk,
        } as never,
      ];
    }

    const saved = await existing.save();
    this.emitDefinition('updated', saved);

    const lifecycleAction =
      previousStatus !== saved.status
        ? `workflow.definition.${saved.status}`
        : 'workflow.definition.updated';
    await this.audit(lifecycleAction, saved, undefined, {
      previousStatus,
      versionBumped: willBump,
    });
    if (becameActive) {
      await this.audit('workflow.activation.approved', saved, undefined, {
        version: saved.version,
        risk: saved.approvals[saved.approvals.length - 1]?.riskSummary,
      });
    }
    return saved;
  }

  async deleteDefinition(id: string): Promise<void> {
    const def = await this.getDefinition(id);
    await this.runModel.deleteMany({ definitionId: def._id }).exec();
    await this.nodeRunModel.deleteMany({ definitionId: def._id }).exec();
    await def.deleteOne();
    this.emitDefinition('deleted', def);
    await this.audit('workflow.definition.deleted', def);
  }

  async startRun(dto: StartWorkflowRunDto, userId?: string): Promise<WorkflowRunDocument> {
    const def = await this.getDefinition(dto.definitionId);
    if (def.status === WorkflowStatus.ARCHIVED) {
      throw new BadRequestException('Cannot start a run for an archived workflow');
    }
    if (def.status !== WorkflowStatus.ACTIVE) {
      throw new BadRequestException(`Cannot start a run for workflow in status ${def.status}; activate it after validation first`);
    }

    const snapshot = {
      name: def.name,
      description: def.description,
      scope: def.scope,
      trigger: def.trigger,
      nodes: def.nodes,
      edges: def.edges,
    };

    const run = await this.runModel.create({
      definitionId: def._id,
      definitionVersion: def.version,
      definitionSnapshot: snapshot,
      scope: def.scope,
      projectId: def.projectId,
      customerId: def.customerId,
      trigger: dto.trigger ?? { type: 'manual', input: dto.input ?? {} },
      status: WorkflowRunStatus.QUEUED,
      currentNodeIds: [],
      createdByUserId: userId && isValidObjectId(userId) ? new Types.ObjectId(userId) : undefined,
      triggeredBy: dto.triggeredBy
        ? {
            type: dto.triggeredBy.type,
            scheduleSlotAt: dto.triggeredBy.scheduleSlotAt
              ? new Date(dto.triggeredBy.scheduleSlotAt)
              : undefined,
            userId: dto.triggeredBy.userId,
          }
        : { type: 'manual' as const, userId },
      context: { nodes: {}, input: dto.input ?? {} },
    });

    this.emitRun('created', run, `Workflow-Run für "${def.name}" v${def.version} eingereiht`);
    this.eventEmitter.emit('workflow.run.queued', { runId: (run._id as { toString(): string }).toString() });
    await this.audit('workflow.run.queued', def, run, {
      trigger: run.trigger?.type,
    });
    return run;
  }

  async listRuns(query: ListWorkflowRunsDto): Promise<WorkflowRunDocument[]> {
    const filter: Record<string, unknown> = {};
    if (query.definitionId) filter.definitionId = new Types.ObjectId(query.definitionId);
    if (query.scope) filter.scope = query.scope;
    if (query.projectId) filter.projectId = new Types.ObjectId(query.projectId);
    if (query.customerId) filter.customerId = new Types.ObjectId(query.customerId);
    if (query.status) filter.status = query.status;
    return this.runModel
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(query.limit ?? 50)
      .skip(query.offset ?? 0)
      .exec();
  }

  async getRun(id: string): Promise<WorkflowRunDocument> {
    if (!isValidObjectId(id)) throw new BadRequestException('Invalid run id');
    const run = await this.runModel.findById(id).exec();
    if (!run) throw new NotFoundException(`Workflow run ${id} not found`);
    return run;
  }

  async inspectRun(id: string): Promise<Record<string, unknown>> {
    const run = await this.getRun(id);
    const nodeRuns = await this.listNodeRuns(id);
    const counts = nodeRuns.reduce<Record<string, number>>((acc, nr) => {
      acc[nr.status] = (acc[nr.status] ?? 0) + 1;
      return acc;
    }, {});
    const startedAt = run.startedAt ? new Date(run.startedAt).getTime() : undefined;
    const finishedAt = run.finishedAt ? new Date(run.finishedAt).getTime() : undefined;

    const childRuns = await this.runModel
      .find({ parentRunId: run._id })
      .select('_id status createdAt retryFromNodeId')
      .sort({ createdAt: 1 })
      .lean()
      .exec();

    return {
      run: {
        id: run._id.toString(),
        definitionId: run.definitionId?.toString(),
        definitionVersion: run.definitionVersion,
        scope: run.scope,
        projectId: run.projectId?.toString(),
        customerId: run.customerId?.toString(),
        status: run.status,
        trigger: this.safePreview(run.trigger),
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        durationMs: startedAt && finishedAt ? finishedAt - startedAt : undefined,
        currentNodeIds: run.currentNodeIds ?? [],
        error: this.safePreview(run.error),
        parentRunId: run.parentRunId?.toString(),
        retryFromNodeId: run.retryFromNodeId,
        retries: childRuns.map((c) => ({
          id: (c._id as Types.ObjectId).toString(),
          status: c.status,
          createdAt: c.createdAt,
          retryFromNodeId: (c as { retryFromNodeId?: string }).retryFromNodeId,
        })),
      },
      summary: {
        totalNodeRuns: nodeRuns.length,
        statusCounts: counts,
        failedNodeIds: nodeRuns.filter((nr) => nr.status === 'failed').map((nr) => nr.nodeId),
        waitingNodeIds: nodeRuns.filter((nr) => nr.status === 'waiting').map((nr) => nr.nodeId),
      },
      nodeRuns: nodeRuns.map((nr) => ({
        id: nr._id.toString(),
        nodeId: nr.nodeId,
        nodeType: nr.nodeType,
        status: nr.status,
        attempt: nr.attempt,
        startedAt: nr.startedAt,
        finishedAt: nr.finishedAt,
        durationMs: nr.durationMs,
        waitingFor: this.safePreview(nr.waitingFor),
        inputPreview: this.safePreview(nr.inputSnapshot),
        outputPreview: this.safePreview(nr.outputSnapshot),
        logPreview: this.safePreview(nr.logs),
        error: this.safePreview(nr.error),
        createdAt: (nr as unknown as { createdAt?: Date }).createdAt,
        updatedAt: (nr as unknown as { updatedAt?: Date }).updatedAt,
      })),
    };
  }

  async cancelRun(id: string, dto: CancelWorkflowRunDto = {}): Promise<WorkflowRunDocument> {
    const run = await this.getRun(id);
    if (
      run.status === WorkflowRunStatus.SUCCEEDED ||
      run.status === WorkflowRunStatus.FAILED ||
      run.status === WorkflowRunStatus.CANCELLED
    ) {
      throw new BadRequestException(`Run already in terminal status ${run.status}`);
    }
    run.status = WorkflowRunStatus.CANCELLED;
    run.finishedAt = new Date();
    run.error = { code: 'cancelled', message: dto.reason ?? 'Cancelled by user' };
    const saved = await run.save();
    this.emitRun('updated', saved, `Workflow-Run abgebrochen (${dto.reason ?? 'kein Grund'})`);
    await this.audit('workflow.run.cancelled', undefined, saved, { reason: dto.reason });
    return saved;
  }

  /**
   * Static graph validation: scope/owner consistency, orphan/dangling edges,
   * duplicate node ids, self-loops. Returns a list of human-readable issues.
   * Does NOT enforce type/config correctness — that belongs to the node-type
   * registry (T-252).
   */
  validateGraph(def: {
    scope?: WorkflowScope;
    projectId?: string;
    customerId?: string;
    nodes?: Array<{ id: string; type?: string; secretRefs?: string[] }>;
    edges?: Array<{ id: string; source: string; target: string }>;
  }): { valid: boolean; issues: string[] } {
    const issues: string[] = [];

    if (def.scope) {
      try {
        this.assertScope({ scope: def.scope, projectId: def.projectId, customerId: def.customerId });
      } catch (err) {
        issues.push((err as Error).message);
      }
    }

    const nodeIds = new Set<string>();
    for (const node of def.nodes ?? []) {
      if (!node.id) {
        issues.push('node without id');
        continue;
      }
      if (nodeIds.has(node.id)) {
        issues.push(`duplicate node id "${node.id}"`);
      }
      nodeIds.add(node.id);
      if (!node.type) {
        issues.push(`node "${node.id}" has no type`);
      }
    }

    const edgeIds = new Set<string>();

    for (const edge of def.edges ?? []) {
      if (!edge.id) {
        issues.push('edge without id');
      } else if (edgeIds.has(edge.id)) {
        issues.push(`duplicate edge id "${edge.id}"`);
      } else {
        edgeIds.add(edge.id);
      }
      if (edge.source === edge.target) {
        issues.push(`edge "${edge.id}" is a self-loop on "${edge.source}"`);
      }
      if (edge.source && !nodeIds.has(edge.source)) {
        issues.push(`edge "${edge.id}" references unknown source "${edge.source}"`);
      }
      if (edge.target && !nodeIds.has(edge.target)) {
        issues.push(`edge "${edge.id}" references unknown target "${edge.target}"`);
      }
    }

    return { valid: issues.length === 0, issues };
  }

  async listNodeRuns(runId: string): Promise<WorkflowNodeRunDocument[]> {
    if (!isValidObjectId(runId)) throw new BadRequestException('Invalid run id');
    return this.nodeRunModel.find({ runId: new Types.ObjectId(runId) }).sort({ createdAt: 1 }).exec();
  }

  async getNodeRun(id: string): Promise<WorkflowNodeRunDocument> {
    if (!isValidObjectId(id)) throw new BadRequestException('Invalid node run id');
    const nr = await this.nodeRunModel.findById(id).exec();
    if (!nr) throw new NotFoundException(`Node run ${id} not found`);
    return nr;
  }

  private safePreview(value: unknown, maxChars = 2000): { value: unknown; truncated: boolean; maskedPaths: string[] } {
    return redact(value, { maxChars });
  }

  listTemplates() {
    return listTemplatesPublic();
  }

  /**
   * Materialize a template into a fresh draft WorkflowDefinition. The user
   * supplies scope + name + owner; nodes/edges/trigger are copied from the
   * template registry. Returns the new definition (status=DRAFT) so the user
   * can immediately open it in the editor and tweak prompts/cron.
   */
  async instantiateTemplate(input: {
    templateId: string;
    name: string;
    scope: WorkflowScope;
    projectId?: string;
    customerId?: string;
  }): Promise<WorkflowDefinitionDocument> {
    const template = getTemplate(input.templateId);
    if (!template) throw new BadRequestException(`Unknown template "${input.templateId}"`);
    if (!template.supportedScopes.includes(input.scope)) {
      throw new BadRequestException(
        `Template "${template.id}" does not support ${input.scope} scope (allowed: ${template.supportedScopes.join(', ')})`,
      );
    }
    return this.createDefinition({
      scope: input.scope,
      projectId: input.projectId,
      customerId: input.customerId,
      name: input.name,
      description: template.description,
      tags: ['template', template.category],
      trigger: this.materializeTrigger(template),
      nodes: template.nodes.map((n) => ({
        id: n.id,
        type: n.type,
        label: n.label,
        position: n.position,
        config: n.config ?? {},
        secretRefs: n.secretRefs ?? [],
      })) as never,
      edges: template.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        branch: e.branch ?? 'success',
      })) as never,
    });
  }

  private materializeTrigger(template: WorkflowTemplate): Record<string, unknown> {
    if (template.trigger.type === 'schedule') {
      return {
        type: 'schedule',
        cron: template.trigger.cron,
        intervalMinutes: template.trigger.intervalMinutes,
      };
    }
    return { type: 'manual' };
  }
}
