import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { ModuleRef } from '@nestjs/core';
import {
  WorkflowDefinition,
  WorkflowDefinitionDocument,
  WorkflowEdge,
  WorkflowNode,
} from '../schemas/workflow-definition.schema';
import { lookupPath } from '../nodes/template';
import {
  WorkflowRun,
  WorkflowRunDocument,
  WorkflowRunStatus,
} from '../schemas/workflow-run.schema';
import {
  WorkflowNodeRun,
  WorkflowNodeRunDocument,
  WorkflowNodeRunStatus,
} from '../schemas/workflow-node-run.schema';
import { WorkflowQueueService } from './workflow-queue.service';
import { WorkflowWorkerPool } from './workflow-worker.pool';
import { NodeRegistry } from './node-registry';
import { NodeJob, NodeResult, RetryConfig } from './types';
import { findTriggerNodes, nextNodes } from './graph-walker';
import { QuestionsService, QUESTION_ANSWERED } from '../../questions/questions.service';
import { TestWorkflowNodeDto } from '../dto/workflow.dto';
import { WorkflowScope } from '../schemas/workflow-definition.schema';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { WORKFLOW_RUN_PROGRESS } from '../../events/project-event';
import { redact, redactLogs, redactValue } from '../workflow-redaction';
import {
  checkRunBudget,
  checkRuntimeNode,
  WORKFLOW_RUNTIME_LIMITS,
} from '../workflow-security.runtime';

const DEFAULT_TIMEOUT_MS = WORKFLOW_RUNTIME_LIMITS.defaultNodeTimeoutMs;
const NODE_LOG_CAP = Number(process.env.WORKFLOW_NODE_LOG_CAP ?? 200);
const RECOVERY_AGE_MS = Number(process.env.WORKFLOW_RUN_RECOVERY_AGE_MS ?? 5 * 60_000);
const WORKER_CONCURRENCY = Number(process.env.WORKFLOW_WORKER_CONCURRENCY ?? 4);

@Injectable()
export class WorkflowEngineService implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(WorkflowEngineService.name);

  constructor(
    @InjectModel(WorkflowDefinition.name)
    private readonly definitionModel: Model<WorkflowDefinitionDocument>,
    @InjectModel(WorkflowRun.name)
    private readonly runModel: Model<WorkflowRunDocument>,
    @InjectModel(WorkflowNodeRun.name)
    private readonly nodeRunModel: Model<WorkflowNodeRunDocument>,
    private readonly queue: WorkflowQueueService,
    private readonly workerPool: WorkflowWorkerPool,
    private readonly registry: NodeRegistry,
    private readonly eventEmitter: EventEmitter2,
    private readonly questionsService: QuestionsService,
    private readonly moduleRef: ModuleRef,
    private readonly auditLog: AuditLogService,
    private readonly notificationsService: NotificationsService,
  ) {}

  private audit(action: string, meta: Record<string, unknown> & { runId?: string }): void {
    // Fire-and-forget; AuditLogService.record never throws.
    void this.auditLog.record({
      action,
      entityType: 'workflow-run',
      entityId: meta.runId,
      meta,
    });
  }

  onModuleInit(): void {
    this.workerPool.setRunner((job) => this.runJob(job));
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.recoverInterruptedRuns();
    this.workerPool.start(WORKER_CONCURRENCY);
  }

  @OnEvent('workflow.run.queued')
  async handleRunQueued(payload: { runId: string }): Promise<void> {
    const run = await this.runModel.findById(payload.runId).exec();
    if (!run) return;
    if (run.status !== WorkflowRunStatus.QUEUED) return;
    run.status = WorkflowRunStatus.RUNNING;
    run.startedAt ??= new Date();
    await run.save();
    this.audit('workflow.run.started', {
      runId: (run._id as Types.ObjectId).toString(),
      definitionId: run.definitionId.toString(),
      definitionVersion: run.definitionVersion,
      scope: run.scope,
      projectId: run.projectId?.toString(),
      customerId: run.customerId?.toString(),
    });

    const snapshot = run.definitionSnapshot as { nodes: WorkflowNode[]; edges: unknown[] };
    const triggers = findTriggerNodes({
      nodes: snapshot.nodes,
      edges: snapshot.edges as never,
    });
    if (triggers.length === 0) {
      await this.failRun(run, { code: 'no_trigger', message: 'No trigger node in graph' });
      return;
    }
    for (const t of triggers) {
      await this.enqueueNode(run, t, 1);
    }
  }

  private async enqueueNode(
    run: WorkflowRunDocument,
    node: WorkflowNode,
    attempt: number,
    delayMs = 0,
  ): Promise<void> {
    const nodeRun = await this.nodeRunModel.create({
      runId: run._id,
      definitionId: run.definitionId,
      definitionVersion: run.definitionVersion,
      nodeId: node.id,
      nodeType: node.type,
      attempt,
      status: WorkflowNodeRunStatus.QUEUED,
    });
    const job: NodeJob = {
      runId: (run._id as Types.ObjectId).toString(),
      nodeRunId: (nodeRun._id as Types.ObjectId).toString(),
      definitionId: run.definitionId.toString(),
      nodeId: node.id,
      nodeType: node.type,
      attempt,
    };
    this.queue.enqueue(job, delayMs);
  }

  async runJob(job: NodeJob): Promise<void> {
    const run = await this.runModel.findById(job.runId).exec();
    const nodeRun = await this.nodeRunModel.findById(job.nodeRunId).exec();
    if (!run || !nodeRun) return;
    if (run.status !== WorkflowRunStatus.RUNNING) return;

    const snapshot = run.definitionSnapshot as { nodes: WorkflowNode[]; edges: unknown[] };
    const node = snapshot.nodes.find((n) => n.id === job.nodeId);
    if (!node) {
      await this.completeNodeRun(nodeRun, {
        status: 'failed',
        error: { code: 'node_missing', message: `Node ${job.nodeId} not in snapshot` },
      });
      await this.failRun(run, nodeRun.error as { code: string; message: string });
      return;
    }

    // Defense-in-depth runtime policy check on the snapshot's node. The
    // activation gate already enforced this, but policy could have changed
    // since the snapshot was taken — fail closed if so.
    const policyCheck = checkRuntimeNode({
      scope: run.scope,
      type: node.type,
      secretRefs: node.secretRefs,
    });
    if (!policyCheck.ok) {
      this.audit('workflow.permission.denied', {
        runId: (run._id as Types.ObjectId).toString(),
        nodeId: node.id,
        nodeType: node.type,
        code: policyCheck.code,
        message: policyCheck.message,
      });
      await this.completeNodeRun(nodeRun, {
        status: 'failed',
        error: {
          code: policyCheck.code ?? 'policy_blocked',
          message: policyCheck.message ?? 'node blocked by policy',
        },
      });
      await this.failRun(run, {
        code: policyCheck.code ?? 'policy_blocked',
        message: policyCheck.message ?? 'node blocked by policy',
      });
      return;
    }

    // Run budget — hard cap on executed node count + total wall-clock time.
    const budget = checkRunBudget({
      startedAt: run.startedAt,
      executedNodeCount: run.executedNodeCount,
    });
    if (!budget.ok) {
      this.audit('workflow.run.budget_exceeded', {
        runId: (run._id as Types.ObjectId).toString(),
        nodeId: node.id,
        code: budget.code,
        message: budget.message,
        executedNodeCount: run.executedNodeCount,
      });
      await this.completeNodeRun(nodeRun, {
        status: 'failed',
        error: { code: budget.code ?? 'budget_exceeded', message: budget.message ?? 'run budget exceeded' },
      });
      await this.failRun(run, {
        code: budget.code ?? 'budget_exceeded',
        message: budget.message ?? 'run budget exceeded',
      });
      return;
    }

    let executor;
    try {
      executor = this.registry.get(node.type);
    } catch {
      await this.completeNodeRun(nodeRun, {
        status: 'failed',
        error: { code: 'unknown_type', message: `No executor for "${node.type}"` },
      });
      await this.failRun(run, nodeRun.error as { code: string; message: string });
      return;
    }

    nodeRun.status = WorkflowNodeRunStatus.RUNNING;
    nodeRun.startedAt = new Date();
    await nodeRun.save();
    // Count this execution atomically — multiple workers may run jobs for the
    // same run in parallel, so a read-modify-write on the document would race
    // and let the budget cap leak.
    const incremented = await this.runModel
      .findByIdAndUpdate(run._id, { $inc: { executedNodeCount: 1 } }, { new: true })
      .exec();
    if (incremented) run.executedNodeCount = incremented.executedNodeCount;
    this.audit('workflow.node.started', {
      runId: (run._id as Types.ObjectId).toString(),
      nodeId: node.id,
      nodeType: node.type,
      attempt: nodeRun.attempt,
    });
    this.eventEmitter.emit(WORKFLOW_RUN_PROGRESS, { runId: (run._id as Types.ObjectId).toString() });

    const timeoutMs = Number(((node.config ?? {}) as Record<string, unknown>).timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const ctx = this.buildContext(run, nodeRun, node);
    let result: NodeResult;
    try {
      result = await this.withTimeout(executor.execute(ctx), timeoutMs);
    } catch (err) {
      result = {
        status: 'failed',
        error: {
          code: (err as Error).name === 'TimeoutError' ? 'timeout' : 'executor_threw',
          message: (err as Error).message,
        },
      };
    }

    await this.applyResult(run, nodeRun, node, result);
  }

  private async withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        p,
        new Promise<T>((_, rej) => {
          timer = setTimeout(() => {
            const e = new Error(`node exceeded ${ms}ms`);
            e.name = 'TimeoutError';
            rej(e);
          }, ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async testNode(dto: TestWorkflowNodeDto): Promise<Record<string, unknown>> {
    const node = dto.node;
    if (!node?.type) throw new BadRequestException('node.type is required');

    const executor = this.registry.get(node.type);
    const metadata = executor.metadata;
    const scope = dto.scope ?? WorkflowScope.PROJECT;
    if (!metadata.allowedScopes.includes(scope)) {
      return {
        ok: false,
        executable: false,
        issues: [`node type ${node.type} is not allowed in ${scope} scope`],
      };
    }

    const parsed = metadata.configSchema.safeParse(node.config ?? {});
    if (!parsed.success) {
      return {
        ok: false,
        executable: false,
        issues: parsed.error.issues.map(
          (issue) => `config.${issue.path.join('.')}: ${issue.message}`,
        ),
      };
    }

    // Node test mode must never perform writes or external/agent side effects.
    // For the MVP we execute only trigger/control nodes; action and agent nodes
    // still get full config validation plus an explicit safety explanation.
    if (metadata.category === 'action' || metadata.category === 'agent') {
      return {
        ok: true,
        executable: false,
        mode: 'validation_only',
        reason: `node category ${metadata.category} may have side effects and is not executed in test mode`,
        outputSchema: metadata.outputs,
        branches: metadata.branches ?? ['success', 'failure'],
      };
    }

    const logs: Array<Record<string, unknown>> = [];
    const now = new Date();
    const runId = new Types.ObjectId();
    const nodeRunId = new Types.ObjectId();
    const input = dto.input ?? {};
    const runContext = dto.runContext ?? { nodes: {}, input };
    const result = await this.withTimeout(
      executor.execute({
        run: {
          _id: runId,
          definitionId: new Types.ObjectId(),
          definitionVersion: 0,
          definitionSnapshot: { nodes: [node], edges: [] },
          scope,
          trigger: { type: 'manual', input },
          status: WorkflowRunStatus.RUNNING,
          currentNodeIds: [node.id],
          triggeredBy: { type: 'manual' },
          context: runContext,
          createdAt: now,
          updatedAt: now,
        } as never,
        nodeRun: {
          _id: nodeRunId,
          runId,
          definitionId: new Types.ObjectId(),
          definitionVersion: 0,
          nodeId: node.id,
          nodeType: node.type,
          attempt: 1,
          status: WorkflowNodeRunStatus.RUNNING,
          startedAt: now,
          logs,
        } as never,
        node: node as never,
        config: parsed.data as Record<string, unknown>,
        secretRefs: node.secretRefs ?? [],
        runContext,
        logger: {
          info: (msg: string, data?: Record<string, unknown>) => logs.push({ level: 'info', msg, ...(data ?? {}) }),
          warn: (msg: string, data?: Record<string, unknown>) => logs.push({ level: 'warn', msg, ...(data ?? {}) }),
          error: (msg: string, data?: Record<string, unknown>) => logs.push({ level: 'error', msg, ...(data ?? {}) }),
        },
        askUser: async () => {
          throw new Error('askUser is disabled in node test mode');
        },
      }),
      Number((parsed.data as Record<string, unknown>).timeoutMs ?? DEFAULT_TIMEOUT_MS),
    );

    return {
      ok: result.status !== 'failed',
      executable: true,
      mode: 'safe_execute',
      nodeType: node.type,
      status: result.status,
      branch: result.branch,
      outputPreview: this.safeTestPreview(result.output),
      waitingForPreview: this.safeTestPreview(result.waitingFor),
      errorPreview: this.safeTestPreview(result.error),
      logPreview: this.safeTestPreview(logs),
    };
  }

  private safeTestPreview(value: unknown): unknown {
    return redact(value, { maxDepth: 5, maxStringLength: 500 }).value;
  }

  private buildContext(run: WorkflowRunDocument, nodeRun: WorkflowNodeRunDocument, node: WorkflowNode) {
    const logs: Array<Record<string, unknown>> = nodeRun.logs;
    const append = (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => {
      // Redact per-entry on push so a crash mid-execute can't leave a raw
      // secret in the unsaved buffer either.
      const entry = redactValue(
        { at: new Date().toISOString(), level, msg, ...(data ?? {}) },
        { maxStringLength: 1024 },
      ) as Record<string, unknown>;
      logs.push(entry);
      while (logs.length > NODE_LOG_CAP) logs.shift();
    };
    // T-325: build the per-target `incoming` bag from edges that landed on
    // this node and carry a payloadMapping. Templates can use
    // `{{incoming.foo}}` instead of (or alongside) `{{nodes.X.foo}}`.
    const baseContext = (run.context as {
      nodes?: Record<string, unknown>;
      fromEdges?: Record<string, Record<string, unknown>>;
    }) ?? { nodes: {} };
    const snapshot = run.definitionSnapshot as { edges?: WorkflowEdge[] };
    const incoming: Record<string, unknown> = {};
    for (const edge of snapshot.edges ?? []) {
      if (edge.target !== node.id) continue;
      const fromEdge = baseContext.fromEdges?.[edge.id];
      if (fromEdge) Object.assign(incoming, fromEdge);
    }

    return {
      run: run.toObject() as never,
      nodeRun: nodeRun.toObject() as never,
      node,
      config: (node.config as Record<string, unknown>) ?? {},
      secretRefs: node.secretRefs ?? [],
      runContext: { ...baseContext, incoming },
      logger: {
        info: (m: string, d?: Record<string, unknown>) => append('info', m, d),
        warn: (m: string, d?: Record<string, unknown>) => append('warn', m, d),
        error: (m: string, d?: Record<string, unknown>) => append('error', m, d),
      },
      askUser: async (q: string, options?: string[]) => {
        const projectId =
          run.projectId instanceof Types.ObjectId ? run.projectId.toString() : undefined;
        const question = await this.questionsService.create({
          question: q,
          options: options ?? [],
          projectId,
          direction: 'agent_to_user',
          agentName: 'workflow',
          agentRunId: (run._id as Types.ObjectId).toString(),
        });
        return { refId: question._id as Types.ObjectId };
      },
    };
  }

  private async applyResult(
    run: WorkflowRunDocument,
    nodeRun: WorkflowNodeRunDocument,
    node: WorkflowNode,
    result: NodeResult,
  ): Promise<void> {
    if (result.status === 'success') {
      await this.completeNodeRun(nodeRun, result);
      const ctx = (run.context as {
        nodes: Record<string, unknown>;
        fromEdges?: Record<string, Record<string, unknown>>;
      }) ?? { nodes: {} };
      ctx.nodes = ctx.nodes ?? {};
      // Persist redacted output to run.context so downstream nodes can read
      // upstream output without re-leaking secrets via the context object.
      const redactedOutput = redactValue(result.output ?? {}) as Record<string, unknown>;
      ctx.nodes[node.id] = redactedOutput;

      const snapshot = run.definitionSnapshot as { nodes: WorkflowNode[]; edges: WorkflowEdge[] };

      // T-325: evaluate payloadMapping for outgoing edges and persist the
      // mapped value per edge. Target nodes pick it up in buildContext.
      for (const edge of snapshot.edges ?? []) {
        if (edge.source !== node.id) continue;
        const mapping = edge.payloadMapping;
        if (!mapping || Object.keys(mapping).length === 0) continue;
        const mapped: Record<string, unknown> = {};
        for (const [targetKey, sourcePath] of Object.entries(mapping)) {
          mapped[targetKey] = lookupPath(sourcePath, redactedOutput);
        }
        ctx.fromEdges = ctx.fromEdges ?? {};
        ctx.fromEdges[edge.id] = mapped;
      }

      run.context = ctx;
      run.markModified('context');
      await run.save();

      const succs = nextNodes(
        node.id,
        result.branch ?? 'success',
        { nodes: snapshot.nodes, edges: snapshot.edges as never },
      );
      for (const succ of succs) await this.enqueueNode(run, succ, 1);
      await this.maybeFinishRun(run);
      return;
    }

    if (result.status === 'waiting') {
      nodeRun.status = WorkflowNodeRunStatus.WAITING;
      nodeRun.waitingFor = result.waitingFor;
      await nodeRun.save();
      const isTimer = result.waitingFor?.type === 'delay';
      run.status = isTimer ? WorkflowRunStatus.WAITING_FOR_TIMER : WorkflowRunStatus.WAITING_FOR_USER;
      await run.save();
      this.eventEmitter.emit(WORKFLOW_RUN_PROGRESS, { runId: (run._id as Types.ObjectId).toString() });
      return;
    }

    // failed
    const retry = ((node.config ?? {}) as { retry?: RetryConfig }).retry;
    const max = retry?.maxAttempts ?? 0;
    if (nodeRun.attempt < max + 1) {
      const base = retry?.backoffMs ?? 1000;
      const mult = retry?.backoffMultiplier ?? 1;
      const delay = base * Math.pow(mult, nodeRun.attempt - 1);
      await this.completeNodeRun(nodeRun, { ...result, status: 'failed' });
      await this.enqueueNode(run, node, nodeRun.attempt + 1, delay);
      return;
    }
    await this.completeNodeRun(nodeRun, result);
    await this.failRun(run, result.error ?? { code: 'failed', message: 'node failed' });
  }

  private async completeNodeRun(nodeRun: WorkflowNodeRunDocument, result: NodeResult): Promise<void> {
    nodeRun.status =
      result.status === 'success'
        ? WorkflowNodeRunStatus.SUCCEEDED
        : result.status === 'waiting'
          ? WorkflowNodeRunStatus.WAITING
          : WorkflowNodeRunStatus.FAILED;
    // Redact at WRITE time, not just on read: anyone reading the raw mongo
    // document (replication peer, db dump, RAG indexer) must never see secrets.
    if (result.output !== undefined) {
      nodeRun.outputSnapshot = redactValue(result.output) as Record<string, unknown>;
    }
    if (result.error) {
      nodeRun.error = redactValue(result.error) as Record<string, unknown>;
    }
    if (nodeRun.logs?.length) {
      nodeRun.logs = redactLogs(nodeRun.logs);
      nodeRun.markModified('logs');
    }
    nodeRun.finishedAt = new Date();
    if (nodeRun.startedAt)
      nodeRun.durationMs = nodeRun.finishedAt.getTime() - nodeRun.startedAt.getTime();
    await nodeRun.save();
    const auditAction =
      result.status === 'success'
        ? 'workflow.node.succeeded'
        : result.status === 'waiting'
          ? 'workflow.node.waiting'
          : 'workflow.node.failed';
    this.audit(auditAction, {
      runId: nodeRun.runId.toString(),
      nodeId: nodeRun.nodeId,
      nodeType: nodeRun.nodeType,
      attempt: nodeRun.attempt,
      durationMs: nodeRun.durationMs,
      ...(result.error ? { errorCode: result.error.code } : {}),
    });
    this.eventEmitter.emit(WORKFLOW_RUN_PROGRESS, { runId: nodeRun.runId.toString() });
  }

  private async maybeFinishRun(run: WorkflowRunDocument): Promise<void> {
    const openCount = await this.nodeRunModel
      .countDocuments({
        runId: run._id,
        status: { $in: [WorkflowNodeRunStatus.QUEUED, WorkflowNodeRunStatus.RUNNING, WorkflowNodeRunStatus.WAITING, WorkflowNodeRunStatus.RETRYING] },
      })
      .exec();
    if (openCount > 0) return;
    if (run.status === WorkflowRunStatus.WAITING_FOR_USER) return;
    if (run.status === WorkflowRunStatus.WAITING_FOR_TIMER) return;
    run.status = WorkflowRunStatus.SUCCEEDED;
    run.finishedAt = new Date();
    await run.save();
    this.eventEmitter.emit('workflow.run.finished', { runId: (run._id as Types.ObjectId).toString(), status: run.status });
    this.audit('workflow.run.succeeded', {
      runId: (run._id as Types.ObjectId).toString(),
      definitionId: run.definitionId?.toString(),
      executedNodeCount: run.executedNodeCount,
      durationMs:
        run.startedAt && run.finishedAt
          ? run.finishedAt.getTime() - run.startedAt.getTime()
          : undefined,
    });
  }

  private async failRun(run: WorkflowRunDocument, error: { code: string; message: string }): Promise<void> {
    this.queue.removeRun((run._id as Types.ObjectId).toString());
    run.status = WorkflowRunStatus.FAILED;
    run.error = redactValue(error) as { code: string; message: string };
    run.finishedAt = new Date();
    await run.save();
    this.eventEmitter.emit('workflow.run.finished', { runId: (run._id as Types.ObjectId).toString(), status: run.status });
    this.audit('workflow.run.failed', {
      runId: (run._id as Types.ObjectId).toString(),
      definitionId: run.definitionId?.toString(),
      errorCode: run.error?.code,
      executedNodeCount: run.executedNodeCount,
    });
    // Fire-and-forget user-facing notification — never let dispatch errors
    // bubble back into the engine.
    const runId = (run._id as Types.ObjectId).toString();
    const defId = run.definitionId?.toString();
    const errCode = typeof error?.code === 'string' ? error.code : 'unknown';
    const errMsgRaw = typeof error?.message === 'string' ? error.message : 'Workflow-Run fehlgeschlagen';
    const errMsg = errMsgRaw.length > 200 ? errMsgRaw.slice(0, 200) + '…' : errMsgRaw;
    void this.notificationsService
      .create(
        '⚠ Workflow-Run fehlgeschlagen',
        `${errCode}: ${errMsg}`,
        defId ? `/workflows/${defId}` : undefined,
        'workflow_failure',
      )
      .catch(() => {
        this.logger.warn(`Failed to dispatch workflow_failure notification for run ${runId}`);
      });
  }

  @OnEvent(QUESTION_ANSWERED)
  async handleQuestionAnswered(payload: { questionId: string; answer: string }): Promise<void> {
    const nodeRun = await this.nodeRunModel
      .findOne({
        'waitingFor.type': 'question',
        'waitingFor.refId': new Types.ObjectId(payload.questionId),
        status: WorkflowNodeRunStatus.WAITING,
      })
      .exec();
    if (!nodeRun) return;

    const run = await this.runModel.findById(nodeRun.runId).exec();
    if (!run) return;
    const snapshot = run.definitionSnapshot as { nodes: WorkflowNode[]; edges: unknown[] };
    const node = snapshot.nodes.find((n) => n.id === nodeRun.nodeId);
    if (!node) return;

    nodeRun.set('waitingFor', undefined);
    nodeRun.status = WorkflowNodeRunStatus.RUNNING;
    await nodeRun.save();
    run.status = WorkflowRunStatus.RUNNING;
    await run.save();
    const cfg = (node.config ?? {}) as {
      branchMap?: Record<string, 'success' | 'failure' | 'custom'>;
      options?: string[];
    };
    const branch = cfg.branchMap?.[payload.answer];
    const optionIndex = cfg.options ? cfg.options.indexOf(payload.answer) : -1;
    await this.applyResult(run, nodeRun, node, {
      status: 'success',
      output: { answer: payload.answer, optionIndex: optionIndex >= 0 ? optionIndex : null },
      branch,
    });
  }

  async resumeDelayedNode(nodeRunId: string | Types.ObjectId): Promise<void> {
    const nodeRun = await this.nodeRunModel.findById(nodeRunId).exec();
    if (!nodeRun) return;
    if (nodeRun.status !== WorkflowNodeRunStatus.WAITING) return;
    const wf = nodeRun.waitingFor as { type?: string; resumeAt?: Date } | undefined;
    if (wf?.type !== 'delay') return;

    const run = await this.runModel.findById(nodeRun.runId).exec();
    if (!run) return;
    const snapshot = run.definitionSnapshot as { nodes: WorkflowNode[]; edges: unknown[] };
    const node = snapshot.nodes.find((n) => n.id === nodeRun.nodeId);
    if (!node) return;

    const waitedMs = nodeRun.startedAt
      ? Date.now() - nodeRun.startedAt.getTime()
      : 0;

    nodeRun.set('waitingFor', undefined);
    nodeRun.status = WorkflowNodeRunStatus.RUNNING;
    await nodeRun.save();
    run.status = WorkflowRunStatus.RUNNING;
    await run.save();
    await this.applyResult(run, nodeRun, node, {
      status: 'success',
      output: { resumedAt: new Date().toISOString(), waitedMs },
    });
  }

  /**
   * Spawn a NEW run (`parentRunId` = original) instead of mutating the original.
   * The parent stays in its terminal FAILED/CANCELLED state — its log/output is
   * preserved. The child gets its own snapshot copy, its own audit trail, and
   * starts executing from `fromNodeId` (or the first failed node, or the
   * trigger if none).
   */
  async retryRun(runId: string, fromNodeId?: string): Promise<WorkflowRunDocument> {
    // Atomic guard: only allow ONE retry to win for a given parent run. We
    // briefly stamp a marker on the parent (re-set status to itself) so that
    // a second concurrent retryRun call returns null and bails out. Using
    // findOneAndUpdate with the status filter ensures the read-then-act is
    // a single round-trip.
    const claim = await this.runModel.findOneAndUpdate(
      {
        _id: new Types.ObjectId(runId),
        status: { $in: [WorkflowRunStatus.FAILED, WorkflowRunStatus.CANCELLED] },
        // Once a retry has been spawned we mark the parent (see end of method);
        // a second concurrent caller will fail the `retryClaimedAt: null` filter.
        $or: [{ retryClaimedAt: { $exists: false } }, { retryClaimedAt: null }],
      },
      { $set: { retryClaimedAt: new Date() } },
      { new: true },
    ).exec();
    if (!claim) {
      throw new Error(`retryRun: run ${runId} is not in failed/cancelled state or a retry is already in flight`);
    }
    const parent = claim;

    const snapshot = parent.definitionSnapshot as { nodes: WorkflowNode[]; edges: unknown[] };
    let nodeToStart: WorkflowNode | undefined;
    let resolvedFromNodeId = fromNodeId;
    if (fromNodeId) nodeToStart = snapshot.nodes.find((n) => n.id === fromNodeId);
    if (!nodeToStart) {
      const failed = await this.nodeRunModel
        .findOne({ runId: parent._id, status: WorkflowNodeRunStatus.FAILED })
        .sort({ createdAt: 1 })
        .exec();
      if (failed) {
        nodeToStart = snapshot.nodes.find((n) => n.id === failed.nodeId);
        resolvedFromNodeId = failed.nodeId;
      }
    }
    if (!nodeToStart) {
      nodeToStart = findTriggerNodes({ nodes: snapshot.nodes, edges: snapshot.edges as never })[0];
      resolvedFromNodeId = nodeToStart?.id;
    }

    const child = await this.runModel.create({
      definitionId: parent.definitionId,
      definitionVersion: parent.definitionVersion,
      definitionSnapshot: parent.definitionSnapshot,
      scope: parent.scope,
      projectId: parent.projectId,
      customerId: parent.customerId,
      trigger: { type: 'retry', input: { parentRunId: (parent._id as Types.ObjectId).toString() } },
      status: WorkflowRunStatus.RUNNING,
      currentNodeIds: [],
      startedAt: new Date(),
      // Fresh context — do NOT inherit upstream node outputs, since the user is
      // explicitly asking for a re-execution from a chosen point.
      context: { nodes: {}, input: {} },
      triggeredBy: { type: 'manual' },
      parentRunId: parent._id,
      retryFromNodeId: resolvedFromNodeId,
      executedNodeCount: 0,
    });

    this.audit('workflow.run.retry_started', {
      runId: (child._id as Types.ObjectId).toString(),
      parentRunId: (parent._id as Types.ObjectId).toString(),
      fromNodeId: resolvedFromNodeId,
      definitionId: parent.definitionId.toString(),
    });

    if (nodeToStart) await this.enqueueNode(child, nodeToStart, 1);
    return child;
  }

  private async recoverInterruptedRuns(): Promise<void> {
    const cutoff = new Date(Date.now() - RECOVERY_AGE_MS);
    const stale = await this.runModel
      .find({ status: WorkflowRunStatus.RUNNING, updatedAt: { $lt: cutoff } })
      .exec();
    for (const run of stale) {
      await this.nodeRunModel
        .updateMany(
          { runId: run._id, status: { $in: [WorkflowNodeRunStatus.RUNNING, WorkflowNodeRunStatus.QUEUED] } },
          { $set: { status: WorkflowNodeRunStatus.INTERRUPTED, finishedAt: new Date() } },
        )
        .exec();
      run.status = WorkflowRunStatus.QUEUED;
      await run.save();
      this.eventEmitter.emit('workflow.run.queued', { runId: (run._id as Types.ObjectId).toString() });
      this.logger.warn(`Recovered interrupted run ${(run._id as Types.ObjectId).toString()}`);
    }

    const queued = await this.runModel.find({ status: WorkflowRunStatus.QUEUED }).exec();
    for (const run of queued) {
      this.eventEmitter.emit('workflow.run.queued', { runId: (run._id as Types.ObjectId).toString() });
    }
  }
}
