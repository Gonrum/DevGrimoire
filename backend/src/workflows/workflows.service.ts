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
  ) {}

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

    if (existing.status === WorkflowStatus.ACTIVE) {
      const validation = this.validateGraph({
        scope: existing.scope,
        projectId: existing.projectId?.toString(),
        customerId: existing.customerId?.toString(),
        nodes: existing.nodes as never,
        edges: existing.edges as never,
      });
      if (!validation.valid) {
        throw new BadRequestException(`Workflow cannot be activated: ${validation.issues.join('; ')}`);
      }
      const secIssues = workflowSecurityIssues({
        scope: existing.scope,
        nodes: existing.nodes as never,
      });
      if (secIssues.length > 0) {
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
        throw new BadRequestException(`Workflow cannot be activated: ${schemaIssues.join('; ')}`);
      }
    }

    if (willBump) existing.version += 1;

    const saved = await existing.save();
    this.emitDefinition('updated', saved);
    return saved;
  }

  async deleteDefinition(id: string): Promise<void> {
    const def = await this.getDefinition(id);
    await this.runModel.deleteMany({ definitionId: def._id }).exec();
    await this.nodeRunModel.deleteMany({ definitionId: def._id }).exec();
    await def.deleteOne();
    this.emitDefinition('deleted', def);
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
    const maskedPaths: string[] = [];
    const seen = new WeakSet<object>();
    let truncated = false;
    const sensitiveKey = /(authorization|api[-_]?key|secret|token|password|passwd|credential|private[-_]?key|cookie)/i;
    const redactString = (input: string): string =>
      input
        .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [MASKED]')
        .replace(/(api[-_]?key|secret|token|password|passwd)\s*[:=]\s*[^\s,;]+/gi, '$1=[MASKED]');
    const visit = (current: unknown, path: string, depth: number): unknown => {
      if (current === null || current === undefined) return current;
      if (typeof current === 'string') {
        const redacted = redactString(current);
        if (redacted !== current) maskedPaths.push(path || '$');
        if (redacted.length > 500) {
          truncated = true;
          return `${redacted.slice(0, 500)}…`;
        }
        return redacted;
      }
      if (typeof current !== 'object') return current;
      if (seen.has(current)) return '[Circular]';
      seen.add(current);
      if (depth >= 6) {
        truncated = true;
        return '[Truncated: max depth]';
      }
      if (Array.isArray(current)) {
        if (current.length > 25) truncated = true;
        return current.slice(0, 25).map((item, idx) => visit(item, `${path}[${idx}]`, depth + 1));
      }
      const out: Record<string, unknown> = {};
      const entries = Object.entries(current as Record<string, unknown>);
      if (entries.length > 50) truncated = true;
      for (const [key, child] of entries.slice(0, 50)) {
        const childPath = path ? `${path}.${key}` : key;
        if (sensitiveKey.test(key)) {
          out[key] = '[MASKED]';
          maskedPaths.push(childPath);
          continue;
        }
        out[key] = visit(child, childPath, depth + 1);
      }
      return out;
    };

    const preview = visit(value, '', 0);
    const json = JSON.stringify(preview);
    if (json && json.length > maxChars) {
      truncated = true;
      return { value: `${json.slice(0, maxChars)}…`, truncated, maskedPaths };
    }
    return { value: preview, truncated, maskedPaths };
  }
}
