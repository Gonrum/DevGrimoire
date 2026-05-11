import {
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

const DEFAULT_TIMEOUT_MS = 30_000;
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
  ) {}

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

  private buildContext(run: WorkflowRunDocument, nodeRun: WorkflowNodeRunDocument, node: WorkflowNode) {
    const logs: Array<Record<string, unknown>> = nodeRun.logs;
    const append = (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => {
      logs.push({ at: new Date().toISOString(), level, msg, ...(data ?? {}) });
      while (logs.length > NODE_LOG_CAP) logs.shift();
    };
    return {
      run: run.toObject() as never,
      nodeRun: nodeRun.toObject() as never,
      node,
      config: (node.config as Record<string, unknown>) ?? {},
      secretRefs: node.secretRefs ?? [],
      runContext: run.context ?? { nodes: {} },
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
      const ctx = (run.context as { nodes: Record<string, unknown> }) ?? { nodes: {} };
      ctx.nodes = ctx.nodes ?? {};
      ctx.nodes[node.id] = result.output ?? {};
      run.context = ctx;
      await run.save();

      const snapshot = run.definitionSnapshot as { nodes: WorkflowNode[]; edges: unknown[] };
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
      run.status = WorkflowRunStatus.WAITING_FOR_USER;
      await run.save();
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
    nodeRun.outputSnapshot = result.output;
    if (result.error) nodeRun.error = result.error;
    nodeRun.finishedAt = new Date();
    if (nodeRun.startedAt)
      nodeRun.durationMs = nodeRun.finishedAt.getTime() - nodeRun.startedAt.getTime();
    await nodeRun.save();
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
    run.status = WorkflowRunStatus.SUCCEEDED;
    run.finishedAt = new Date();
    await run.save();
    this.eventEmitter.emit('workflow.run.finished', { runId: (run._id as Types.ObjectId).toString(), status: run.status });
  }

  private async failRun(run: WorkflowRunDocument, error: { code: string; message: string }): Promise<void> {
    this.queue.removeRun((run._id as Types.ObjectId).toString());
    run.status = WorkflowRunStatus.FAILED;
    run.error = error;
    run.finishedAt = new Date();
    await run.save();
    this.eventEmitter.emit('workflow.run.finished', { runId: (run._id as Types.ObjectId).toString(), status: run.status });
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
    run.status = WorkflowRunStatus.RUNNING;
    await run.save();
    await this.applyResult(run, nodeRun, node, {
      status: 'success',
      output: { answer: payload.answer },
    });
  }

  async retryRun(runId: string, fromNodeId?: string): Promise<void> {
    const run = await this.runModel.findById(runId).exec();
    if (!run) throw new Error(`run ${runId} not found`);
    if (run.status !== WorkflowRunStatus.FAILED && run.status !== WorkflowRunStatus.CANCELLED) {
      throw new Error(`retryRun only allowed on failed/cancelled (got ${run.status})`);
    }
    await this.nodeRunModel
      .deleteMany({
        runId: run._id,
        status: { $in: [WorkflowNodeRunStatus.QUEUED, WorkflowNodeRunStatus.RUNNING] },
      })
      .exec();

    const snapshot = run.definitionSnapshot as { nodes: WorkflowNode[]; edges: unknown[] };
    let nodeToStart: WorkflowNode | undefined;
    if (fromNodeId) nodeToStart = snapshot.nodes.find((n) => n.id === fromNodeId);
    if (!nodeToStart) {
      const failed = await this.nodeRunModel
        .findOne({ runId: run._id, status: WorkflowNodeRunStatus.FAILED })
        .sort({ createdAt: 1 })
        .exec();
      if (failed) nodeToStart = snapshot.nodes.find((n) => n.id === failed.nodeId);
    }
    if (!nodeToStart) nodeToStart = findTriggerNodes({ nodes: snapshot.nodes, edges: snapshot.edges as never })[0];

    run.status = WorkflowRunStatus.QUEUED;
    run.error = undefined;
    run.finishedAt = undefined;
    await run.save();
    if (nodeToStart) await this.enqueueNode(run, nodeToStart, 1);
    this.eventEmitter.emit('workflow.run.queued', { runId: (run._id as Types.ObjectId).toString() });
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
