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
import { NodeExecutionContext, NodeJob, NodeResult, RetryConfig } from './types';
import { findTriggerNodes, nextNodes } from './graph-walker';
import { readGraph } from './snapshot';
import { NodeBranch } from './node-metadata';
import { QuestionsService, QUESTION_ANSWERED } from '../../questions/questions.service';
import { TestWorkflowNodeDto, workflowNodeFromDto } from '../dto/workflow.dto';
import { WorkflowScope } from '../schemas/workflow-definition.schema';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { WORKFLOW_RUN_PROGRESS } from '../../events/project-event';
import { redact, redactLogs, redactRecord } from '../workflow-redaction';
import { asNumber, asStringArray, errorMessage, errorName, isRecord } from '../workflow-narrow';
import {
  checkRunBudget,
  checkRuntimeNode,
  WORKFLOW_RUNTIME_LIMITS,
} from '../workflow-security.runtime';

const DEFAULT_TIMEOUT_MS = WORKFLOW_RUNTIME_LIMITS.defaultNodeTimeoutMs;
/**
 * Erlaubte Branch-Namen als Laufzeitliste. `find()` darauf liefert den
 * Union-Typ ohne Assertion — ein `branchMap`-Wert aus der Node-Konfiguration
 * ist ungeprüftes JSON und war vorher als Branch nur behauptet.
 */
const NODE_BRANCHES: readonly NodeBranch[] = ['success', 'failure', 'custom'];
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
      runId: run._id.toString(),
      definitionId: run.definitionId.toString(),
      definitionVersion: run.definitionVersion,
      scope: run.scope,
      projectId: run.projectId?.toString(),
      customerId: run.customerId?.toString(),
    });

    const triggers = findTriggerNodes(readGraph(run.definitionSnapshot));
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
      runId: run._id.toString(),
      nodeRunId: nodeRun._id.toString(),
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

    const node = readGraph(run.definitionSnapshot).nodes.find((n) => n.id === job.nodeId);
    if (!node) {
      // Denselben Fehler an beide Aufrufe geben, statt ihn über das Dokument
      // zurückzulesen: `completeNodeRun` schreibt eine *redigierte* Kopie, und
      // `nodeRun.error` ist im Schema ein offenes Objekt.
      const error = { code: 'node_missing', message: `Node ${job.nodeId} not in snapshot` };
      await this.completeNodeRun(nodeRun, { status: 'failed', error });
      await this.failRun(run, error);
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
        runId: run._id.toString(),
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
        runId: run._id.toString(),
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
      const error = { code: 'unknown_type', message: `No executor for "${node.type}"` };
      await this.completeNodeRun(nodeRun, { status: 'failed', error });
      await this.failRun(run, error);
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
      runId: run._id.toString(),
      nodeId: node.id,
      nodeType: node.type,
      attempt: nodeRun.attempt,
    });
    this.eventEmitter.emit(WORKFLOW_RUN_PROGRESS, { runId: run._id.toString() });

    const timeoutMs = Number(((node.config ?? {})).timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const ctx = this.buildContext(run, nodeRun, node);
    let result: NodeResult;
    try {
      result = await this.withTimeout(executor.execute(ctx), timeoutMs);
    } catch (err: unknown) {
      result = {
        status: 'failed',
        error: {
          code: errorName(err) === 'TimeoutError' ? 'timeout' : 'executor_threw',
          message: errorMessage(err),
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
    // `configSchema` ist ein `z.ZodTypeAny`, `parsed.data` damit `any`. Die
    // Form wird geprüft statt behauptet; ein Node-Schema, das kein Objekt
    // liefert, gibt es nicht (alle sind `z.object(...)`).
    const parsedConfig: Record<string, unknown> = isRecord(parsed.data) ? parsed.data : {};

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
    // Der DTO-Knoten hat `config`/`secretRefs` optional, `WorkflowNode` nicht —
    // die Defaults setzt `workflowNodeFromDto`, statt den Unterschied mit
    // `as never` zu überschreiben.
    const testNodeShape = workflowNodeFromDto(node);
    const result = await this.withTimeout(
      executor.execute({
        run: {
          _id: runId,
          definitionId: new Types.ObjectId(),
          definitionVersion: 0,
          definitionSnapshot: { nodes: [testNodeShape], edges: [] },
          scope,
          trigger: { type: 'manual', input },
          status: WorkflowRunStatus.RUNNING,
          currentNodeIds: [node.id],
          triggeredBy: { type: 'manual' },
          context: runContext,
          executedNodeCount: 0,
          createdAt: now,
          updatedAt: now,
        },
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
        },
        node: testNodeShape,
        config: parsedConfig,
        secretRefs: node.secretRefs ?? [],
        runContext,
        logger: {
          info: (msg: string, data?: Record<string, unknown>) => logs.push({ level: 'info', msg, ...(data ?? {}) }),
          warn: (msg: string, data?: Record<string, unknown>) => logs.push({ level: 'warn', msg, ...(data ?? {}) }),
          error: (msg: string, data?: Record<string, unknown>) => logs.push({ level: 'error', msg, ...(data ?? {}) }),
        },
        askUser: () => Promise.reject(new Error('askUser is disabled in node test mode')),
      }),
      Number(parsedConfig.timeoutMs ?? DEFAULT_TIMEOUT_MS),
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

  private buildContext(
    run: WorkflowRunDocument,
    nodeRun: WorkflowNodeRunDocument,
    node: WorkflowNode,
  ): NodeExecutionContext {
    const logs: Array<Record<string, unknown>> = nodeRun.logs;
    const append = (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => {
      // Redact per-entry on push so a crash mid-execute can't leave a raw
      // secret in the unsaved buffer either.
      const entry = redactRecord(
        { at: new Date().toISOString(), level, msg, ...(data ?? {}) },
        { maxStringLength: 1024 },
      );
      logs.push(entry);
      while (logs.length > NODE_LOG_CAP) logs.shift();
    };
    // T-325: build the per-target `incoming` bag from edges that landed on
    // this node and carry a payloadMapping. Templates can use
    // `{{incoming.foo}}` instead of (or alongside) `{{nodes.X.foo}}`.
    const baseContext = isRecord(run.context) ? run.context : {};
    const fromEdges = isRecord(baseContext.fromEdges) ? baseContext.fromEdges : undefined;
    const incoming: Record<string, unknown> = {};
    for (const edge of readGraph(run.definitionSnapshot).edges) {
      if (edge.target !== node.id) continue;
      const fromEdge = fromEdges?.[edge.id];
      if (isRecord(fromEdge)) Object.assign(incoming, fromEdge);
    }

    return {
      // `toObject<T>()` ist die von Mongoose vorgesehene Stelle, die POJO-Form
      // zu benennen; ohne Typargument liefert es `any` (DocType der
      // untypisierten `Document`-Basis) und das lief vorher in ein `as never`.
      run: run.toObject<WorkflowRun>(),
      nodeRun: nodeRun.toObject<WorkflowNodeRun>(),
      node,
      config: (node.config) ?? {},
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
          agentRunId: run._id.toString(),
        });
        return { refId: question._id };
      },
    };
  }

  /**
   * `config.retry` aus der offenen Node-Konfiguration.
   *
   * Vorher stand hier `(node.config as { retry?: RetryConfig }).retry` — eine
   * Behauptung über ungeprüftes JSON, und eine mit Folgen: bei einem
   * `maxAttempts: "3"` rechnete `attempt < max + 1` als `attempt < "31"`
   * (String-Konkatenation) und der Node lief bis zu 31 Mal statt 4 Mal.
   */
  private readRetryConfig(raw: unknown): RetryConfig {
    const cfg = isRecord(raw) ? raw : {};
    return {
      maxAttempts: asNumber(cfg.maxAttempts) ?? 0,
      backoffMs: asNumber(cfg.backoffMs) ?? 1000,
      backoffMultiplier: asNumber(cfg.backoffMultiplier),
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
      const ctx = isRecord(run.context) ? run.context : {};
      const ctxNodes = isRecord(ctx.nodes) ? ctx.nodes : {};
      // Persist redacted output to run.context so downstream nodes can read
      // upstream output without re-leaking secrets via the context object.
      const redactedOutput = redactRecord(result.output ?? {});
      ctxNodes[node.id] = redactedOutput;
      ctx.nodes = ctxNodes;

      const graph = readGraph(run.definitionSnapshot);

      // T-325: evaluate payloadMapping for outgoing edges and persist the
      // mapped value per edge. Target nodes pick it up in buildContext.
      for (const edge of graph.edges) {
        if (edge.source !== node.id) continue;
        const mapping = edge.payloadMapping;
        if (!mapping || Object.keys(mapping).length === 0) continue;
        const mapped: Record<string, unknown> = {};
        for (const [targetKey, sourcePath] of Object.entries(mapping)) {
          mapped[targetKey] = lookupPath(sourcePath, redactedOutput);
        }
        const fromEdges = isRecord(ctx.fromEdges) ? ctx.fromEdges : {};
        fromEdges[edge.id] = mapped;
        ctx.fromEdges = fromEdges;
      }

      run.context = ctx;
      run.markModified('context');
      await run.save();

      const succs = nextNodes(node.id, result.branch ?? 'success', graph);
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
      this.eventEmitter.emit(WORKFLOW_RUN_PROGRESS, { runId: run._id.toString() });
      return;
    }

    // failed
    const retry = this.readRetryConfig(node.config.retry);
    const max = retry.maxAttempts;
    if (nodeRun.attempt < max + 1) {
      const delay = retry.backoffMs * Math.pow(retry.backoffMultiplier ?? 1, nodeRun.attempt - 1);
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
      nodeRun.outputSnapshot = redactRecord(result.output);
    }
    if (result.error) {
      nodeRun.error = redactRecord(result.error);
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
    this.eventEmitter.emit('workflow.run.finished', { runId: run._id.toString(), status: run.status });
    this.audit('workflow.run.succeeded', {
      runId: run._id.toString(),
      definitionId: run.definitionId?.toString(),
      executedNodeCount: run.executedNodeCount,
      durationMs:
        run.startedAt && run.finishedAt
          ? run.finishedAt.getTime() - run.startedAt.getTime()
          : undefined,
    });
  }

  private async failRun(run: WorkflowRunDocument, error: { code: string; message: string }): Promise<void> {
    this.queue.removeRun(run._id.toString());
    run.status = WorkflowRunStatus.FAILED;
    run.error = redactRecord(error);
    run.finishedAt = new Date();
    await run.save();
    this.eventEmitter.emit('workflow.run.finished', { runId: run._id.toString(), status: run.status });
    this.audit('workflow.run.failed', {
      runId: run._id.toString(),
      definitionId: run.definitionId?.toString(),
      errorCode: run.error?.code,
      executedNodeCount: run.executedNodeCount,
    });
    // Fire-and-forget user-facing notification — never let dispatch errors
    // bubble back into the engine.
    const runId = run._id.toString();
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
    const node = readGraph(run.definitionSnapshot).nodes.find((n) => n.id === nodeRun.nodeId);
    if (!node) return;

    nodeRun.set('waitingFor', undefined);
    nodeRun.status = WorkflowNodeRunStatus.RUNNING;
    await nodeRun.save();
    run.status = WorkflowRunStatus.RUNNING;
    await run.save();
    const branchMap = isRecord(node.config.branchMap) ? node.config.branchMap : undefined;
    const branch = NODE_BRANCHES.find((candidate) => candidate === branchMap?.[payload.answer]);
    const options = asStringArray(node.config.options);
    const optionIndex = options ? options.indexOf(payload.answer) : -1;
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
    if (nodeRun.waitingFor?.type !== 'delay') return;

    const run = await this.runModel.findById(nodeRun.runId).exec();
    if (!run) return;
    const node = readGraph(run.definitionSnapshot).nodes.find((n) => n.id === nodeRun.nodeId);
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

    const graph = readGraph(parent.definitionSnapshot);
    let nodeToStart: WorkflowNode | undefined;
    let resolvedFromNodeId = fromNodeId;
    if (fromNodeId) nodeToStart = graph.nodes.find((n) => n.id === fromNodeId);
    if (!nodeToStart) {
      const failed = await this.nodeRunModel
        .findOne({ runId: parent._id, status: WorkflowNodeRunStatus.FAILED })
        .sort({ createdAt: 1 })
        .exec();
      if (failed) {
        nodeToStart = graph.nodes.find((n) => n.id === failed.nodeId);
        resolvedFromNodeId = failed.nodeId;
      }
    }
    if (!nodeToStart) {
      nodeToStart = findTriggerNodes(graph)[0];
      resolvedFromNodeId = nodeToStart?.id;
    }

    const child = await this.runModel.create({
      definitionId: parent.definitionId,
      definitionVersion: parent.definitionVersion,
      definitionSnapshot: parent.definitionSnapshot,
      scope: parent.scope,
      projectId: parent.projectId,
      customerId: parent.customerId,
      trigger: { type: 'retry', input: { parentRunId: parent._id.toString() } },
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
      runId: child._id.toString(),
      parentRunId: parent._id.toString(),
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
      this.eventEmitter.emit('workflow.run.queued', { runId: run._id.toString() });
      this.logger.warn(`Recovered interrupted run ${run._id.toString()}`);
    }

    const queued = await this.runModel.find({ status: WorkflowRunStatus.QUEUED }).exec();
    for (const run of queued) {
      this.eventEmitter.emit('workflow.run.queued', { runId: run._id.toString() });
    }
  }
}
