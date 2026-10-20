import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Logger,
  OnModuleInit,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, isValidObjectId } from 'mongoose';
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
import { failureSuccessors, findTriggerNodes, hasBranchEdges, nextNodes } from './graph-walker';
import { readGraph } from './snapshot';
import { OPEN_NODE_RUN_STATUSES, TERMINAL_RUN_STATUSES, WORKFLOW_RUN_CANCELLED } from './run-status';
import { NodeBranch } from './node-metadata';
import { QuestionsService, QUESTION_ANSWERED, QUESTION_EXPIRED } from '../../questions/questions.service';
import {
  DebugStepDto,
  PreviewWorkflowNodeDto,
  TestWorkflowNodeDto,
  workflowNodeFromDto,
} from '../dto/workflow.dto';
import { WorkflowScope } from '../schemas/workflow-definition.schema';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { WORKFLOW_RUN_PROGRESS } from '../../events/project-event';
import { redact, redactLogs, redactRecord } from '../workflow-redaction';
import { NodePreview, preflightNode, previewFromContext, redactPlaceholders } from './node-preflight';
import { findSecretKeys, maskSecrets, PlaceholderTrace } from '../nodes/template-resolver';
import { secretPlaceholderIssues, WorkflowSecretsResolver } from './workflow-secrets.resolver';
import { dropMissing, dryPlaceholder, dryStrategy, DryStrategy, nextPending, withoutUndefined } from './debug-step';
import { capSnapshot, inputView, SNAPSHOT_REDACT_OPTIONS, structuredSnapshot } from './snapshot-cap';
import { asNumber, asStringArray, errorMessage, errorName, isRecord } from '../workflow-narrow';
import {
  checkRunBudget,
  checkRuntimeNode,
  WORKFLOW_RUNTIME_LIMITS,
} from '../workflow-security.runtime';
import { getWorkflowNodePolicy, requiresAccountableUser, WorkflowNodeRisk } from '../workflow-security.policy';
import { RequestContext, RequestUser } from '../../common/request-context';
import { AccountableActor, WorkflowAccountabilityService } from './workflow-accountability.service';
import { assertActorCanAccessWorkflow } from '../workflow-actor-access';
import { SshExecExecutor } from '../nodes/ssh-exec.executor';

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

/**
 * Update-Pipeline für `run.context` (M-12): setzt `context.nodes[nodeId]` und
 * `context.fromEdges[edgeId]` atomar, ohne den Rest des Kontexts anzufassen.
 * `$setField` + `$literal` statt Punkt-Pfaden, weil Node- und Edge-Ids frei
 * wählbar sind (Punkte, `$`) — als Pfad wären sie Struktur, hier bleiben sie
 * Schlüssel. `$literal` verhindert, dass Werte mit `$` als Ausdruck gelesen
 * werden.
 */
export function contextUpdatePipeline(
  nodeId: string,
  output: Record<string, unknown>,
  edges: Array<{ edgeId: string; mapped: Record<string, unknown> }>,
): Record<string, unknown>[] {
  const stages: Record<string, unknown>[] = [
    { $set: { context: { $ifNull: ['$context', {}] } } },
    {
      $set: {
        'context.nodes': {
          $setField: {
            field: { $literal: nodeId },
            input: { $ifNull: ['$context.nodes', {}] },
            value: { $literal: output },
          },
        },
      },
    },
  ];
  for (const { edgeId, mapped } of edges) {
    stages.push({
      $set: {
        'context.fromEdges': {
          $setField: {
            field: { $literal: edgeId },
            input: { $ifNull: ['$context.fromEdges', {}] },
            value: { $literal: mapped },
          },
        },
      },
    });
  }
  return stages;
}

/** Kontext-Eintrag eines gescheiterten Nodes mit Fehlerzweig: Ausgabe plus `error`. */
export function failureContextEntry(result: NodeResult): Record<string, unknown> {
  return {
    ...(result.output ?? {}),
    error: { code: result.error?.code ?? 'failed', message: result.error?.message ?? 'node failed' },
  };
}

/**
 * T-325: payloadMapping der ausgehenden Edges gegen die (redigierte) Ausgabe
 * auswerten; gemeinsam für Erfolgs- und Fehlerpfad, damit Korrekturen nicht
 * nur an einer Stelle landen.
 */
function buildEdgeValues(
  graph: ReturnType<typeof readGraph>,
  nodeId: string,
  redacted: Record<string, unknown>,
): Array<{ edgeId: string; mapped: Record<string, unknown> }> {
  const out: Array<{ edgeId: string; mapped: Record<string, unknown> }> = [];
  for (const edge of graph.edges) {
    if (edge.source !== nodeId) continue;
    const mapping = edge.payloadMapping;
    if (!mapping || Object.keys(mapping).length === 0) continue;
    const mapped: Record<string, unknown> = {};
    for (const [targetKey, sourcePath] of Object.entries(mapping)) {
      mapped[targetKey] = lookupPath(sourcePath, redacted);
    }
    out.push({ edgeId: edge.id, mapped });
  }
  return out;
}

/**
 * Verweigert einen Node, dessen Risiko einen zurechenbaren Nutzer verlangt,
 * wenn der Lauf keinen hat. Das Ergebnis ist ein normales Fehlschlagen — ein
 * failure-Zweig im Graphen greift wie bei jedem anderen Fehler.
 */
export function accountabilityRefusal(nodeType: string, hasActor: boolean): NodeResult | undefined {
  if (hasActor) return undefined;
  const risk = getWorkflowNodePolicy(nodeType)?.risk;
  if (!risk || !requiresAccountableUser(risk)) return undefined;
  return {
    status: 'failed',
    error: {
      code: 'no_accountable_user',
      message: `Node "${nodeType}" (${risk}) braucht einen zurechenbaren, aktiven Nutzer — der Lauf hat keinen`,
    },
  };
}

/**
 * Fehlercodes, die bei einer Wiederholung garantiert wieder auftreten: kein
 * Akteur, Scope-Verstoß, unauflösbares Template, ungültige Konfiguration.
 * Ein Node-Retry würde nur Zeit kosten (und Audit-Einträge vervielfachen) —
 * solche Fehler gehen direkt in die Fehlerbehandlung (failure-Edge bzw. Lauf
 * scheitert).
 */
const DETERMINISTIC_FAILURE_CODES: ReadonlySet<string> = new Set([
  'no_accountable_user',
  'scope_violation',
  'template_unresolved',
  'secret_not_allowed',
  'invalid_config',
]);

export function isDeterministicFailure(result: NodeResult): boolean {
  const code = result.error?.code;
  return typeof code === 'string' && DETERMINISTIC_FAILURE_CODES.has(code);
}

@Injectable()
export class WorkflowEngineService implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(WorkflowEngineService.name);
  /** runId -> AbortController der gerade laufenden Knoten (M-20). */
  private readonly inFlight = new Map<string, Set<AbortController>>();

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
    private readonly accountability: WorkflowAccountabilityService,
    private readonly secretsResolver: WorkflowSecretsResolver,
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
    // Atomarer Claim (H-18). Vorher Lesen -> Status prüfen -> Speichern: bei
    // mehreren Instanzen oder doppelt emittiertem Event startete derselbe Run
    // mehrfach — mit jeweils allen Trigger-Nodes.
    const run = await this.runModel
      .findOneAndUpdate(
        { _id: payload.runId, status: WorkflowRunStatus.QUEUED },
        { $set: { status: WorkflowRunStatus.RUNNING } },
        { new: true },
      )
      .exec();
    if (!run) return;
    if (!run.startedAt) {
      run.startedAt = new Date();
      await run.save();
    }
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
    if (run.status !== WorkflowRunStatus.RUNNING) {
      // Ein Job für einen beendeten Run (abgebrochen, während er in der
      // Queue lag) — vorher blieb sein NodeRun für immer `queued`.
      if (TERMINAL_RUN_STATUSES.includes(run.status) && OPEN_NODE_RUN_STATUSES.includes(nodeRun.status)) {
        await this.interruptNodeRun(nodeRun, run.status);
      }
      return;
    }

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
    // Nicht im Debug-Lauf: jeder Schritt wird einzeln angestoßen, und die
    // Laufzeit misst dort vor allem die Pausen des Nutzers.
    const debug = run.mode === 'debug';
    const budget = debug
      ? { ok: true as const, code: undefined, message: undefined }
      : checkRunBudget({
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
    const abort = new AbortController();
    const runKey = run._id.toString();
    // M-20: ein Abbruch des Runs bricht auch die laufenden Executoren ab.
    let inFlight = this.inFlight.get(runKey);
    if (!inFlight) { inFlight = new Set(); this.inFlight.set(runKey, inFlight); }
    inFlight.add(abort);
    // Einmal pro Node-Ausführung auflösen: zwischen zwei Nodes kann der Nutzer
    // deaktiviert worden sein, und das soll den nächsten Node bereits stoppen.
    const accountable = await this.resolveAccountable(run);
    const ctx = this.buildContext(run, nodeRun, node, abort.signal);
    if (accountable) ctx.accountableUserId = accountable.userId;
    // Secrets nur für Node-Typen, die sie einsetzen dürfen — und nur, wenn der
    // Akteur sie lesen darf. Alle anderen sehen `{{secrets.…}}` als
    // `secret_not_allowed` (Preflight), ohne dass je ein Wert geladen wurde.
    // `?.`: Executor-Attrappen ohne Metadaten gelten als nicht Secret-fähig.
    const secretsAllowed = executor.metadata?.secretPlaceholders === true;
    const secretKeys = findSecretKeys(node.config ?? {});
    // Debug-Lauf: die Strategie entscheidet, ob der Node wirklich läuft. Was
    // nur eine Vorschau liefert, entschlüsselt kein Secret — verfügbare KEYs
    // erscheinen als ••••(KEY) wie in der Node-Vorschau.
    const strategy: DryStrategy = debug
      ? dryStrategy(
          node.type,
          policyCheck.policy?.risk ?? 'destructive',
          executor.metadata?.category ?? 'action',
          job.debugDry === true,
        )
      : 'execute';
    const previewOnly = strategy !== 'execute' && strategy !== 'agent_dry';
    const secrets = !secretsAllowed || secretKeys.length === 0
      ? {}
      : previewOnly
        ? await this.availableSecretTokens(run, secretKeys)
        : await this.resolveSecrets(run, secretKeys, accountable);
    // Vorprüfung vor jeder Ausführung: fehlende Platzhalter lassen den Node
    // scheitern, und der NodeRun hält fest, was er bekam und was eingesetzt
    // wurde (redigiert, gekappt — nie Secret-Klartext: `display` zeigt ••••(KEY)).
    const preflight = preflightNode(node.config ?? {}, ctx.runContext, {
      secrets,
      secretsAllowed,
      nodeType: node.type,
    });
    nodeRun.inputSnapshot = capSnapshot(redactRecord(inputView(ctx.runContext), SNAPSHOT_REDACT_OPTIONS));
    nodeRun.resolvedConfig = capSnapshot(redactRecord(preflight.resolved.display, SNAPSHOT_REDACT_OPTIONS));
    nodeRun.placeholders = redactPlaceholders(preflight.resolved.placeholders);
    const secretValues = Object.values(secrets);
    if (!previewOnly && !preflight.failure && secretValues.length > 0) {
      // Nur im Speicher: `inputView` übernimmt `secrets` nicht in den Snapshot,
      // und `contextUpdatePipeline` schreibt nur `nodes`/`fromEdges` zurück.
      ctx.runContext.secrets = secrets;
      ctx.secretValues = secretValues;
    }
    let result: NodeResult;
    try {
      const refused =
        preflight.failure
        ?? this.dryInputRefusal(debug, strategy, policyCheck.policy?.risk, preflight.resolved.placeholders)
        ?? accountabilityRefusal(node.type, accountable !== null);
      if (refused) {
        result = refused;
      } else if (strategy === 'placeholder') {
        // Trockenlauf eines schreibenden Nodes: die eingesetzte Config steht
        // schon am NodeRun, ausgeführt wird nichts.
        result = { status: 'success', branch: 'success', output: dryPlaceholder(executor.metadata?.outputs ?? {}) };
      } else if (strategy === 'skip_delay') {
        result = { status: 'success', output: { skipped: true, reason: 'Verzögerung im Debug übersprungen' } };
      } else {
        // agent.task läuft im Trockenlauf mit Read-only-Tools (wie der Modal-Test).
        if (strategy === 'agent_dry') ctx.dryRun = true;
        // Ein `ssh_preview` ohne den echten SSH-Executor fällt auf den
        // Platzhalter zurück — ein Trockenlauf darf nie doch ausführen.
        const invoke = (): Promise<NodeResult> =>
          strategy !== 'ssh_preview'
            ? executor.execute(ctx)
            : executor instanceof SshExecExecutor
              ? executor.dryRunPreview(ctx)
              : Promise.resolve({
                  status: 'success',
                  branch: 'success',
                  output: dryPlaceholder(executor.metadata?.outputs ?? {}),
                });
        const execution = accountable
          ? RequestContext.run(accountable.actor, undefined, invoke)
          : invoke();
        result = await this.withTimeout(execution, timeoutMs, abort);
      }
    } catch (err: unknown) {
      result = {
        status: 'failed',
        error: {
          code: errorName(err) === 'TimeoutError' ? 'timeout' : 'executor_threw',
          message: errorMessage(err),
        },
      };
    } finally {
      inFlight.delete(abort);
      if (inFlight.size === 0) this.inFlight.delete(runKey);
    }

    if (ctx.secretValues?.length) {
      // Vor applyResult: dort wird redigiert und gespeichert — Ausgabe, Fehler
      // und Kontext-Eintrag dürfen den Klartext nie zu sehen bekommen. Die
      // Logs maskiert schon der Logger beim Schreiben; hier noch einmal für
      // alles, was am Logger vorbei in `nodeRun.logs` landete.
      result = maskSecrets(result, ctx.secretValues);
      if (nodeRun.logs?.length) nodeRun.logs = maskSecrets(nodeRun.logs, ctx.secretValues);
    }
    await this.applyResult(run, nodeRun, node, result);
  }

  /**
   * Ein Lookup-Fehler (DB weg) macht die Secrets nur „fehlend" — der Preflight
   * lässt den Node dann mit `template_unresolved` scheitern, statt dass er als
   * `executor_threw` erscheint.
   */
  private async resolveSecrets(
    run: WorkflowRunDocument,
    keys: string[],
    accountable: AccountableActor | null,
  ): Promise<Record<string, string>> {
    try {
      return (await this.secretsResolver.resolve(run, keys, accountable)).values;
    } catch (err: unknown) {
      this.logger.warn(`Secrets für Lauf ${run._id.toString()} nicht auflösbar: ${errorMessage(err)}`);
      return {};
    }
  }

  /**
   * Debug-Lauf: ein **echter** Schritt eines verändernden Nodes, dessen
   * Platzhalter auf Ausgaben eines Trockenlaufs zeigen (`unknown`), liefe mit
   * `null`/leer statt mit dem echten Wert — ein Todo-Titel „null", ein
   * SSH-Befehl mit `'null'`. Das ist keine Vorschau mehr; der Schritt
   * scheitert, bis der Vorgänger echt lief oder dieser Schritt trocken läuft.
   * Lesende Nodes und Trockenläufe dürfen mit unbekannten Werten weiter.
   */
  private dryInputRefusal(
    debug: boolean,
    strategy: DryStrategy,
    risk: WorkflowNodeRisk | undefined,
    placeholders: PlaceholderTrace[],
  ): NodeResult | undefined {
    if (!debug || strategy !== 'execute' || risk === 'safe-read') return undefined;
    const unknown = [...new Set(placeholders.filter((p) => p.status === 'unknown').map((p) => p.expr))];
    if (unknown.length === 0) return undefined;
    return {
      status: 'failed',
      error: {
        code: 'template_unresolved',
        message: `Platzhalter mit unbekanntem Wert aus einem Trockenlauf: ${unknown.join(', ')} — Vorgänger echt ausführen oder diesen Schritt trocken laufen lassen`,
      },
    };
  }

  /**
   * Für Vorschau-Schritte im Debug-Lauf: verfügbare KEYs mit leerem Wert, wie
   * `previewFromContext` — der Preflight zeigt sie als ••••(KEY), ohne dass ein
   * Secret entschlüsselt wird. Fehlt ein KEY, bleibt er `missing`.
   */
  private async availableSecretTokens(run: WorkflowRunDocument, keys: string[]): Promise<Record<string, string>> {
    try {
      const infos = await this.secretsResolver.available({
        projectId: run.projectId?.toString(),
        customerId: run.customerId?.toString(),
      });
      const available = new Set(infos.map((s) => s.key));
      const tokens: Record<string, string> = {};
      for (const key of keys) if (available.has(key)) tokens[key] = '';
      return tokens;
    } catch (err: unknown) {
      this.logger.warn(`Secrets für Lauf ${run._id.toString()} nicht abfragbar: ${errorMessage(err)}`);
      return {};
    }
  }

  /**
   * Ein Lookup-Fehler (DB weg) darf den Node nicht als `executor_threw`
   * erscheinen lassen: ohne Akteur laufen Nodes ohne Akteurpflicht wie bisher,
   * die übrigen scheitern sichtbar mit `no_accountable_user`.
   */
  private async resolveAccountable(run: WorkflowRunDocument): Promise<AccountableActor | null> {
    try {
      return await this.accountability.resolve(run);
    } catch (err: unknown) {
      this.logger.warn(`Akteur für Lauf ${run._id.toString()} nicht auflösbar: ${errorMessage(err)}`);
      return null;
    }
  }

  private async withTimeout<T>(p: Promise<T>, ms: number, abort?: AbortController): Promise<T> {
    let timer: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        p,
        new Promise<T>((_, rej) => {
          timer = setTimeout(() => {
            const e = new Error(`node exceeded ${ms}ms`);
            e.name = 'TimeoutError';
            // M-13: den Executor tatsächlich abbrechen, nicht nur aufhören zu
            // warten — sonst läuft er neben dem Retry weiter.
            abort?.abort(e);
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
    // Mit `workflowId` gelten Scope, Projekt und Kunde der gespeicherten
    // Definition — ein Request kann sich so kein fremdes Projekt erschleichen.
    let scope = dto.scope ?? WorkflowScope.PROJECT;
    let projectId: Types.ObjectId | undefined;
    let customerId: Types.ObjectId | undefined;
    let definitionId = new Types.ObjectId();
    if (dto.workflowId !== undefined) {
      // Der MCP-Pfad läuft ohne DTO-Validierung — die Id wird hier geprüft.
      if (!isValidObjectId(dto.workflowId)) throw new BadRequestException('Invalid workflowId');
      const def = await this.definitionModel.findById(dto.workflowId).exec();
      if (!def) throw new NotFoundException(`Workflow ${dto.workflowId} not found`);
      // Der Test läuft im Scope der Definition — der Aufrufer muss dort
      // zugreifen dürfen (ssh.exec baut sonst eine Verbindung in fremdem Scope auf).
      assertActorCanAccessWorkflow(RequestContext.getUser(), def);
      scope = def.scope;
      projectId = def.projectId;
      customerId = def.customerId;
      definitionId = def._id;
    }
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

    // Node test mode must never perform writes or external side effects.
    // Action nodes get config validation plus an explicit safety explanation.
    // Agent nodes run as a dry run: the executor sees `dryRun` and restricts
    // its tools to `_get`/`_list`/`_search` — but only with a workflow behind
    // it, otherwise the tools would run without project/customer scope.
    const validationOnly = (reason: string) => ({
      ok: true,
      executable: false,
      mode: 'validation_only',
      reason,
      outputSchema: metadata.outputs,
      branches: metadata.branches ?? ['success', 'failure'],
    });
    // ssh.exec ist eine Aktion, bekommt im Test aber eine echte
    // Verbindungsprüfung — ohne den Befehl zu senden. Der Lauf-Scope dafür
    // kommt nur aus einer gespeicherten Definition, nie aus dem Request.
    if (executor instanceof SshExecExecutor) {
      if (dto.workflowId === undefined) {
        return validationOnly('ssh.exec braucht eine workflowId für die Verbindungsprüfung (Projekt-/Kunden-Scope)');
      }
      return executor.connectionCheck(
        { projectId, customerId },
        parsedConfig,
        dto.runContext ?? { nodes: {}, input: dto.input ?? {} },
        RequestContext.getUser()?.userId,
      );
    }
    if (metadata.category === 'action') {
      return validationOnly(`node category action may have side effects and is not executed in test mode`);
    }
    const dryRun = metadata.category === 'agent';
    if (dryRun && dto.workflowId === undefined) {
      return validationOnly('agent nodes need a workflowId for a dry run (project/customer scope)');
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
    const testAbort = new AbortController();
    // Timeout oder Wurf des Executors ist ein Testergebnis, kein 500 — wie im
    // echten Lauf (dort als `timeout`/`executor_threw` am NodeRun).
    let result: NodeResult;
    try {
      result = await this.withTimeout(
        executor.execute({
          run: {
            _id: runId,
            definitionId,
            definitionVersion: 0,
            definitionSnapshot: { nodes: [testNodeShape], edges: [] },
            scope,
            ...(projectId ? { projectId } : {}),
            ...(customerId ? { customerId } : {}),
            trigger: { type: 'manual', input },
            mode: 'normal',
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
            definitionId,
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
          signal: testAbort.signal,
          dryRun,
        }),
        Number(parsedConfig.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        testAbort,
      );
    } catch (err: unknown) {
      result = {
        status: 'failed',
        error: {
          code: errorName(err) === 'TimeoutError' ? 'timeout' : 'executor_threw',
          message: errorMessage(err),
        },
      };
    }

    return {
      ok: result.status !== 'failed',
      executable: true,
      mode: dryRun ? 'dry_run' : 'safe_execute',
      nodeType: node.type,
      status: result.status,
      branch: result.branch,
      outputPreview: this.safeTestPreview(result.output),
      waitingForPreview: this.safeTestPreview(result.waitingFor),
      errorPreview: this.safeTestPreview(result.error),
      logPreview: this.safeTestPreview(logs),
    };
  }

  /**
   * Vorschau der eingesetzten Config für den Node-Dialog. Zugriff wie
   * `testNode`; Scope kommt aus der gespeicherten Definition. Secrets werden
   * nicht entschlüsselt, nur ihre Verfügbarkeit (Metadaten) fließt ein.
   */
  async previewNode(dto: PreviewWorkflowNodeDto): Promise<NodePreview> {
    const node = dto.node;
    if (!node?.type) throw new BadRequestException('node.type is required');
    if (!isValidObjectId(dto.workflowId)) throw new BadRequestException('Invalid workflowId');
    const def = await this.definitionModel.findById(dto.workflowId).exec();
    if (!def) throw new NotFoundException(`Workflow ${dto.workflowId} not found`);
    assertActorCanAccessWorkflow(RequestContext.getUser(), def);
    const metadata = this.registry.get(node.type).metadata;
    const secretsAllowed = metadata.secretPlaceholders === true;
    const available = secretsAllowed
      ? await this.secretsResolver.available({
          projectId: def.projectId?.toString(),
          customerId: def.customerId?.toString(),
        })
      : [];
    return previewFromContext(
      node.config ?? {},
      dto.runContext ?? { nodes: {}, input: dto.input ?? {} },
      available.map((s) => s.key),
      secretsAllowed,
      node.type,
    );
  }

  private safeTestPreview(value: unknown): unknown {
    return redact(value, { maxDepth: 5, maxStringLength: 500 }).value;
  }

  private buildContext(
    run: WorkflowRunDocument,
    nodeRun: WorkflowNodeRunDocument,
    node: WorkflowNode,
    signal: AbortSignal = new AbortController().signal,
  ): NodeExecutionContext {
    const logs: Array<Record<string, unknown>> = nodeRun.logs;
    const append = (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => {
      // Redact per-entry on push so a crash mid-execute can't leave a raw
      // secret in the unsaved buffer either. Secret-Werte vor der Redaction
      // maskieren: deren Kürzung könnte einen Wert sonst zerteilen.
      const entry = redactRecord(
        // `ctx.secretValues` setzt `runJob` erst nach dem Aufbau — gelesen
        // wird es beim Schreiben eines Eintrags.
        maskSecrets({ at: new Date().toISOString(), level, msg, ...(data ?? {}) }, ctx.secretValues ?? []),
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

    const ctx: NodeExecutionContext = {
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
      askUser: async (q: string, options?: string[], opts?: { timeoutSeconds?: number }) => {
        const projectId =
          run.projectId instanceof Types.ObjectId ? run.projectId.toString() : undefined;
        const question = await this.questionsService.create({
          question: q,
          options: options ?? [],
          projectId,
          direction: 'agent_to_user',
          agentName: 'workflow',
          agentRunId: run._id.toString(),
          timeoutSeconds: opts?.timeoutSeconds,
        });
        return { refId: question._id };
      },
      signal,
    };
    return ctx;
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
    // M-20: Der Run kann während der Ausführung abgebrochen (oder von einem
    // parallelen Zweig fehlgeschlagen) sein. Dann wird nur noch dieser Knoten
    // abgeschlossen — keine Nachfolger, kein Retry, kein Statuswechsel am Run.
    const live = await this.runModel.findById(run._id).select('status').exec();
    if (live && TERMINAL_RUN_STATUSES.includes(live.status)) {
      // Das Ergebnis wird verworfen (kein Kontext, keine Nachfolger) — also
      // `interrupted`, nicht `succeeded`, auch wenn der Executor durchkam.
      await this.interruptNodeRun(nodeRun, live.status);
      return;
    }

    // Debug-Lauf: Nachfolger werden gesammelt statt eingereiht. Wartet der
    // Node auf eine Antwort, geht es wie gehabt nach `waiting_for_user`; die
    // Antwort kommt über `handleQuestionAnswered` wieder hier an.
    if (run.mode === 'debug' && result.status !== 'waiting') {
      await this.applyDebugResult(run, nodeRun, node, result);
      return;
    }

    if (result.status === 'success') {
      await this.completeNodeRun(nodeRun, result);
      // Persist redacted output to run.context so downstream nodes can read
      // upstream output without re-leaking secrets via the context object.
      const redactedOutput = structuredSnapshot(result.output ?? {});
      const graph = readGraph(run.definitionSnapshot);

      // T-325: evaluate payloadMapping for outgoing edges and persist the
      // mapped value per edge. Target nodes pick it up in buildContext.
      const edgeValues = buildEdgeValues(graph, node.id, redactedOutput);

      // M-12: atomar NUR die eigenen Einträge setzen, statt das ganze
      // context-Objekt aus einem bis zu 10 min alten Dokument zurückzuschreiben.
      // resumeDelayedNode und handleQuestionAnswered laufen ohne den
      // Definitions-Lock; zwei Pfade überschrieben sich gegenseitig den
      // nodes[]-Eintrag, und im nächsten Prompt stand `{{nodes.X.field}}`
      // wörtlich.
      const fresh = await this.runModel
        .findByIdAndUpdate(run._id, contextUpdatePipeline(node.id, redactedOutput, edgeValues), { new: true })
        .exec();
      const current = fresh ?? run;
      if (current.status !== WorkflowRunStatus.RUNNING) return;

      const succs = nextNodes(node.id, result.branch ?? 'success', graph);
      for (const succ of succs) await this.enqueueNode(current, succ, 1);
      await this.maybeFinishRun(current);
      return;
    }

    if (result.status === 'waiting') {
      nodeRun.status = WorkflowNodeRunStatus.WAITING;
      nodeRun.waitingFor = result.waitingFor;
      await nodeRun.save();
      const isTimer = result.waitingFor?.type === 'delay';
      const waitingStatus = isTimer ? WorkflowRunStatus.WAITING_FOR_TIMER : WorkflowRunStatus.WAITING_FOR_USER;
      // Bedingt: ein zwischenzeitlicher Abbruch darf nicht zurück auf
      // „wartet" gesetzt werden.
      const moved = await this.runModel.findOneAndUpdate(
        { _id: run._id, status: { $nin: TERMINAL_RUN_STATUSES } },
        { $set: { status: waitingStatus } },
        { new: true },
      ).exec();
      if (!moved) {
        await this.interruptNodeRun(nodeRun, WorkflowRunStatus.CANCELLED);
        return;
      }
      run.status = waitingStatus;
      this.eventEmitter.emit(WORKFLOW_RUN_PROGRESS, { runId: run._id.toString() });
      return;
    }

    // failed
    const retry = this.readRetryConfig(node.config.retry);
    const max = retry.maxAttempts;
    if (nodeRun.attempt < max + 1 && !isDeterministicFailure(result)) {
      const delay = retry.backoffMs * Math.pow(retry.backoffMultiplier ?? 1, nodeRun.attempt - 1);
      await this.completeNodeRun(nodeRun, { ...result, status: 'failed' });
      await this.enqueueNode(run, node, nodeRun.attempt + 1, delay);
      return;
    }

    // Fehlerzweig: hängt am Node eine `failure`-Edge, ist der Fehler behandelt —
    // der Lauf geht dort weiter, statt abgebrochen zu werden. maybeFinishRun
    // zählt nur offene NodeRuns, ein `failed` NodeRun lässt den Run also
    // `succeeded` enden.
    const failGraph = readGraph(run.definitionSnapshot);
    if (hasBranchEdges(node.id, 'failure', failGraph)) {
      await this.completeNodeRun(nodeRun, result);
      // Wie auf dem Erfolgspfad redigiert; der Fehler steht zusätzlich als
      // `error` im Kontext, damit Folge-Nodes ihn auswerten können.
      const redactedFailure = structuredSnapshot(failureContextEntry(result));
      const failEdgeValues = buildEdgeValues(failGraph, node.id, redactedFailure);
      const fresh = await this.runModel
        .findByIdAndUpdate(run._id, contextUpdatePipeline(node.id, redactedFailure, failEdgeValues), { new: true })
        .exec();
      const current = fresh ?? run;
      if (current.status !== WorkflowRunStatus.RUNNING) return;
      // Nur ausdrücklich beschriftete failure-Edges — eine `always`-Edge des
      // gescheiterten Nodes führt sonst den Erfolgspfad trotzdem aus.
      for (const succ of failureSuccessors(node.id, failGraph)) await this.enqueueNode(current, succ, 1);
      await this.maybeFinishRun(current);
      return;
    }
    await this.completeNodeRun(nodeRun, result);
    await this.failRun(run, result.error ?? { code: 'failed', message: 'node failed' });
  }

  /**
   * Ergebnis eines Debug-Schritts. Gleiche Zweig-Regeln wie im normalen Lauf
   * (success/custom/failure-Kanten), aber kein Retry und kein Einreihen: die
   * Nachfolger landen in `debug.pendingNodeIds`, der Lauf wartet auf den
   * nächsten Schritt. Ein Fehlschlag ohne failure-Kante lässt den Lauf nicht
   * scheitern — der Node bleibt vorne in der Liste, damit er nach einer
   * Korrektur wiederholt werden kann. Erfolgreich endet der Lauf erst, wenn
   * nichts mehr wartet und der letzte Schritt gelang oder behandelt war.
   */
  private async applyDebugResult(
    run: WorkflowRunDocument,
    nodeRun: WorkflowNodeRunDocument,
    node: WorkflowNode,
    result: NodeResult,
  ): Promise<void> {
    const graph = readGraph(run.definitionSnapshot);
    // Wiederholung: die Nachfolger des vorigen Laufs werden ersetzt. Welcher
    // Zweig damals galt, steht am NodeRun nicht — also alle direkten Ziele.
    const previousSuccessors =
      nodeRun.attempt > 1 ? [...new Set(graph.edges.filter((e) => e.source === node.id).map((e) => e.target))] : [];
    let successors: string[] = [];
    let handled = true;
    if (result.status === 'success') {
      await this.completeNodeRun(nodeRun, result);
      const redactedOutput = structuredSnapshot(result.output ?? {});
      const edgeValues = buildEdgeValues(graph, node.id, redactedOutput);
      await this.runModel
        .findByIdAndUpdate(run._id, contextUpdatePipeline(node.id, redactedOutput, edgeValues))
        .exec();
      successors = nextNodes(node.id, result.branch ?? 'success', graph).map((n) => n.id);
    } else if (hasBranchEdges(node.id, 'failure', graph)) {
      await this.completeNodeRun(nodeRun, result);
      const redactedFailure = structuredSnapshot(failureContextEntry(result));
      const failEdgeValues = buildEdgeValues(graph, node.id, redactedFailure);
      await this.runModel
        .findByIdAndUpdate(run._id, contextUpdatePipeline(node.id, redactedFailure, failEdgeValues))
        .exec();
      successors = failureSuccessors(node.id, graph).map((n) => n.id);
    } else {
      await this.completeNodeRun(nodeRun, result);
      handled = false;
    }

    // Nur ein Schritt zur Zeit (atomarer Claim in `debugStep`) — die Liste
    // ändert sich zwischen Lesen und Schreiben nicht.
    const current = await this.runModel.findById(run._id).select('debug').exec();
    let pending = nextPending(current?.debug?.pendingNodeIds ?? [], node.id, successors, previousSuccessors);
    if (!handled) pending = [node.id, ...pending];
    const finish = handled && pending.length === 0;
    const moved = await this.runModel
      .findOneAndUpdate(
        { _id: run._id, status: WorkflowRunStatus.RUNNING },
        {
          $set: {
            'debug.pendingNodeIds': pending,
            'debug.lastActivityAt': new Date(),
            ...(finish ? {} : { status: WorkflowRunStatus.WAITING_FOR_STEP }),
          },
        },
        { new: true },
      )
      .exec();
    // Inzwischen abgebrochen: nichts mehr umstellen.
    if (!moved) return;
    if (finish) {
      await this.maybeFinishRun(moved);
      // Kann nur ausbleiben, wenn noch ein NodeRun offen ist — dann wartet der
      // Lauf lieber auf einen Schritt, als für immer `running` zu bleiben.
      if (moved.status !== WorkflowRunStatus.SUCCEEDED) {
        await this.runModel
          .updateOne({ _id: run._id, status: WorkflowRunStatus.RUNNING }, { $set: { status: WorkflowRunStatus.WAITING_FOR_STEP } })
          .exec();
      }
    }
    this.eventEmitter.emit(WORKFLOW_RUN_PROGRESS, { runId: run._id.toString() });
  }

  /**
   * Ein Schritt eines Debug-Laufs. Der Graph kommt bei jedem Schritt aus dem
   * Editor (auch ungespeichert) und ersetzt den Snapshot des Laufs; der
   * ausgeführte Node wird wie bei der Aktivierung geprüft, aber ohne
   * Freigabe-Eintrag und Versionssprung. Antwortet sofort mit dem Lauf
   * (`running`) — das Ergebnis kommt über den Fortschritts-Stream.
   */
  async debugStep(runId: string, dto: DebugStepDto, actor?: RequestUser): Promise<WorkflowRunDocument> {
    if (!isValidObjectId(runId)) throw new BadRequestException('Invalid run id');
    const run = await this.runModel.findById(runId).exec();
    if (!run) throw new NotFoundException(`Workflow run ${runId} not found`);
    if (run.mode !== 'debug' || !run.debug) throw new BadRequestException('Lauf ist kein Debug-Lauf');
    if (run.status !== WorkflowRunStatus.WAITING_FOR_STEP) {
      throw new ConflictException('Debug-Lauf wartet nicht auf einen Schritt');
    }
    // Der Debuggende ist der zurechenbare Nutzer — weiterschalten darf nur er.
    if (!actor?.userId || actor.userId !== run.triggeredBy?.userId) {
      throw new ForbiddenException('Nur wer den Debug-Lauf gestartet hat, darf ihn weiterschalten');
    }
    assertActorCanAccessWorkflow(actor, run);

    const nodes = (dto.nodes ?? []).map(workflowNodeFromDto);
    const edges = dto.edges ?? [];
    if (nodes.length > WORKFLOW_RUNTIME_LIMITS.maxNodesPerDefinition) {
      throw new BadRequestException(`Workflow exceeds ${WORKFLOW_RUNTIME_LIMITS.maxNodesPerDefinition} nodes`);
    }
    const matches = nodes.filter((n) => n.id === dto.nodeId);
    if (matches.length !== 1) {
      throw new BadRequestException(
        matches.length === 0 ? `Node ${dto.nodeId} ist nicht im Graphen` : `Node-Id ${dto.nodeId} ist doppelt vergeben`,
      );
    }
    const node = matches[0];

    const { pending, dropped } = dropMissing(run.debug.pendingNodeIds ?? [], nodes.map((n) => n.id));
    const notices = dropped.map((id) => `Node ${id} wurde entfernt und übersprungen`);
    const previousRuns = await this.nodeRunModel.countDocuments({ runId: run._id, nodeId: node.id }).exec();
    if (!pending.includes(node.id) && previousRuns === 0) {
      throw new BadRequestException(`Node ${node.id} ist nicht an der Reihe`);
    }
    const issues = this.debugNodeIssues(run.scope, node);
    if (issues.length > 0) {
      throw new BadRequestException({ statusCode: 400, error: 'Bad Request', message: issues });
    }

    // Atomar: von zwei gleichzeitigen Schritten gewinnt einer, der andere
    // bekommt 409. `lastActivityAt` dient als Versionsmarke — ein Schritt, der
    // zwischen Lesen und Claim komplett durchlief, hat sie verändert.
    const now = new Date();
    const lastActivityAt = run.debug.lastActivityAt;
    const claimed = await this.runModel
      .findOneAndUpdate(
        {
          _id: run._id,
          status: WorkflowRunStatus.WAITING_FOR_STEP,
          ...(lastActivityAt instanceof Date ? { 'debug.lastActivityAt': lastActivityAt } : {}),
        },
        {
          $set: {
            status: WorkflowRunStatus.RUNNING,
            'definitionSnapshot.nodes': nodes.map(withoutUndefined),
            'definitionSnapshot.edges': edges.map(withoutUndefined),
            'debug.pendingNodeIds': pending,
            'debug.lastActivityAt': now,
          },
          ...(notices.length > 0 ? { $push: { 'debug.notices': { $each: notices } } } : {}),
        },
        { new: true },
      )
      .exec();
    if (!claimed) throw new ConflictException('Debug-Lauf wartet nicht auf einen Schritt');

    const dry = dto.mode === 'dry';
    const attempt = previousRuns + 1;
    const nodeRun = await this.nodeRunModel.create({
      runId: claimed._id,
      definitionId: claimed.definitionId,
      definitionVersion: claimed.definitionVersion,
      nodeId: node.id,
      nodeType: node.type,
      attempt,
      status: WorkflowNodeRunStatus.QUEUED,
      dryRun: dry,
      nodeSnapshot: withoutUndefined(node),
    });
    this.audit('workflow.debug.step', {
      runId: claimed._id.toString(),
      nodeId: node.id,
      nodeType: node.type,
      attempt,
      mode: dto.mode,
    });
    this.queue.enqueue({
      runId: claimed._id.toString(),
      nodeRunId: nodeRun._id.toString(),
      definitionId: claimed.definitionId.toString(),
      nodeId: node.id,
      nodeType: node.type,
      attempt,
      debugDry: dry,
    });
    this.eventEmitter.emit(WORKFLOW_RUN_PROGRESS, { runId: claimed._id.toString() });
    return claimed;
  }

  /**
   * Prüfung des auszuführenden Nodes wie bei der Aktivierung: Policy und
   * Scope, Config-Schema, Secret-Platzhalter nur in erlaubten Node-Typen.
   */
  private debugNodeIssues(scope: WorkflowScope, node: WorkflowNode): string[] {
    const issues: string[] = [];
    const policy = checkRuntimeNode({ scope, type: node.type, secretRefs: node.secretRefs });
    if (!policy.ok) issues.push(policy.message ?? `node "${node.id}" (${node.type}) blocked by policy`);
    if (!this.registry.has(node.type)) {
      issues.push(`node "${node.id}": kein Executor für "${node.type}"`);
      return issues;
    }
    const parsed = this.registry.getMetadata(node.type).configSchema.safeParse(node.config ?? {});
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        issues.push(`node "${node.id}" (${node.type}) config.${issue.path.join('.')}: ${issue.message}`);
      }
    }
    issues.push(
      ...secretPlaceholderIssues(
        [node],
        (t) => this.registry.has(t) && this.registry.getMetadata(t).secretPlaceholders === true,
      ),
    );
    return issues;
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
    // Eingang/eingesetzte Config sind Teil des Dokuments, das hier gespeichert wird.
    nodeRun.markModified('inputSnapshot');
    nodeRun.markModified('resolvedConfig');
    nodeRun.markModified('placeholders');
    if (result.output !== undefined) {
      nodeRun.outputSnapshot = structuredSnapshot(result.output);
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
    // M-20: nur ein laufender Run wird erfolgreich — vorher überschrieb das
    // hier einen inzwischen abgebrochenen Run mit `succeeded`.
    const finishedAt = new Date();
    const finished = await this.runModel.findOneAndUpdate(
      { _id: run._id, status: WorkflowRunStatus.RUNNING },
      { $set: { status: WorkflowRunStatus.SUCCEEDED, finishedAt } },
      { new: true },
    ).exec();
    if (!finished) return;
    run.status = WorkflowRunStatus.SUCCEEDED;
    run.finishedAt = finishedAt;
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

  /**
   * M-20: Aufräumen nach `WorkflowsService.cancelRun`. Wartende Jobs fliegen
   * aus der Queue (vorher nur in failRun), laufende Executoren bekommen ihr
   * Abort-Signal statt bis zum Timeout weiterzulaufen.
   */
  @OnEvent(WORKFLOW_RUN_CANCELLED)
  onRunCancelled(payload: { runId?: string }): void {
    if (!payload?.runId) return;
    const removed = this.queue.removeRun(payload.runId);
    const running = this.inFlight.get(payload.runId);
    for (const abort of running ?? []) abort.abort(new Error('workflow run cancelled'));
    this.logger.log(
      `Run ${payload.runId} abgebrochen: ${removed} Job(s) aus der Queue, ${running?.size ?? 0} laufende(r) Knoten abgebrochen`,
    );
  }

  /** NodeRun eines beendeten Runs abschliessen, ohne Ergebnis. */
  private async interruptNodeRun(nodeRun: WorkflowNodeRunDocument, runStatus: WorkflowRunStatus): Promise<void> {
    nodeRun.status = WorkflowNodeRunStatus.INTERRUPTED;
    nodeRun.finishedAt = new Date();
    nodeRun.error = { code: 'run_terminated', message: `Run ist bereits ${runStatus}` };
    await nodeRun.save();
  }

  private async failRun(run: WorkflowRunDocument, error: { code: string; message: string }): Promise<void> {
    this.queue.removeRun(run._id.toString());
    // M-20: bedingt — ein abgebrochener oder schon beendeter Run bleibt, wie
    // er ist, und bekommt keine zweite Fehlermeldung.
    const finishedAt = new Date();
    const redactedError = redactRecord(error);
    const failed = await this.runModel.findOneAndUpdate(
      { _id: run._id, status: { $nin: TERMINAL_RUN_STATUSES } },
      { $set: { status: WorkflowRunStatus.FAILED, error: redactedError, finishedAt } },
      { new: true },
    ).exec();
    if (!failed) return;
    run.status = WorkflowRunStatus.FAILED;
    run.error = redactedError;
    run.finishedAt = finishedAt;
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
    if (!Types.ObjectId.isValid(payload.questionId)) return;
    // Atomarer Claim (M-14): WAITING -> RUNNING in EINEM Schritt, damit eine
    // doppelt zugestellte Antwort den Node nicht zweimal fortsetzt.
    const nodeRun = await this.nodeRunModel
      .findOneAndUpdate(
        {
          'waitingFor.type': 'question',
          'waitingFor.refId': new Types.ObjectId(payload.questionId),
          status: WorkflowNodeRunStatus.WAITING,
        },
        { $set: { status: WorkflowNodeRunStatus.RUNNING }, $unset: { waitingFor: 1 } },
        { new: true },
      )
      .exec();
    if (!nodeRun) return;

    const run = await this.resumeRun(nodeRun);
    if (!run) return;
    const node = readGraph(run.definitionSnapshot).nodes.find((n) => n.id === nodeRun.nodeId);
    if (!node) return;

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

  /**
   * M-31: Eine Workflow-Frage ist ohne Antwort abgelaufen. Der Knoten
   * scheitert mit `question_timeout` — Retry und Fehlerpfad greifen wie bei
   * jedem anderen Fehler. Eine spätere (nachträgliche) Antwort findet den
   * Knoten nicht mehr wartend und bleibt folgenlos.
   */
  @OnEvent(QUESTION_EXPIRED)
  async handleQuestionExpired(payload: { questionId: string }): Promise<void> {
    if (!Types.ObjectId.isValid(payload.questionId)) return;
    const nodeRun = await this.nodeRunModel
      .findOneAndUpdate(
        {
          'waitingFor.type': 'question',
          'waitingFor.refId': new Types.ObjectId(payload.questionId),
          status: WorkflowNodeRunStatus.WAITING,
        },
        { $set: { status: WorkflowNodeRunStatus.RUNNING }, $unset: { waitingFor: 1 } },
        { new: true },
      )
      .exec();
    if (!nodeRun) return;
    const run = await this.resumeRun(nodeRun);
    if (!run) return;
    const node = readGraph(run.definitionSnapshot).nodes.find((n) => n.id === nodeRun.nodeId);
    if (!node) return;
    await this.applyResult(run, nodeRun, node, {
      status: 'failed',
      error: { code: 'question_timeout', message: 'Rückfrage wurde nicht rechtzeitig beantwortet' },
    });
  }

  /**
   * Setzt den Run eines geweckten Knotens wieder auf RUNNING — bedingt
   * (M-20): ein inzwischen abgebrochener Run bleibt abgebrochen, der Knoten
   * wird `interrupted`. Vorher setzte `run.status = RUNNING; save()` einen
   * cancelled Run stillschweigend zurück auf running.
   */
  private async resumeRun(nodeRun: WorkflowNodeRunDocument): Promise<WorkflowRunDocument | null> {
    const run = await this.runModel.findOneAndUpdate(
      { _id: nodeRun.runId, status: { $nin: TERMINAL_RUN_STATUSES } },
      { $set: { status: WorkflowRunStatus.RUNNING } },
      { new: true },
    ).exec();
    if (run) return run;
    const current = await this.runModel.findById(nodeRun.runId).select('status').exec();
    await this.interruptNodeRun(nodeRun, current?.status ?? WorkflowRunStatus.CANCELLED);
    return null;
  }

  async resumeDelayedNode(nodeRunId: string | Types.ObjectId): Promise<void> {
    // Atomarer Claim (M-14). Vorher Status prüfen und in einem zweiten
    // Schritt RUNNING setzen: zwei überlappende Delay-Ticks (oder Instanzen)
    // setzten denselben Node doppelt fort.
    const nodeRun = await this.nodeRunModel
      .findOneAndUpdate(
        { _id: nodeRunId, status: WorkflowNodeRunStatus.WAITING, 'waitingFor.type': 'delay' },
        { $set: { status: WorkflowNodeRunStatus.RUNNING }, $unset: { waitingFor: 1 } },
        { new: true },
      )
      .exec();
    if (!nodeRun) return;

    const run = await this.resumeRun(nodeRun);
    if (!run) return;
    const node = readGraph(run.definitionSnapshot).nodes.find((n) => n.id === nodeRun.nodeId);
    if (!node) return;

    const waitedMs = nodeRun.startedAt
      ? Date.now() - nodeRun.startedAt.getTime()
      : 0;

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
  async retryRun(runId: string, fromNodeId?: string, requestActor?: RequestUser): Promise<WorkflowRunDocument> {
    // Zugriff vor dem Claim prüfen — sonst bliebe ein abgelehnter Versuch als
    // `retryClaimedAt` am Elternlauf stehen und sperrte jeden weiteren Retry.
    if (!isValidObjectId(runId)) throw new BadRequestException('Invalid run id');
    const target = await this.runModel.findById(runId).select('projectId customerId mode').lean().exec();
    if (requestActor && target) assertActorCanAccessWorkflow(requestActor, target);
    // Ein Debug-Lauf wird im Editor wiederholt (Schritt wiederholen bzw. neu
    // debuggen) — ein Retry liefe als normaler Lauf ohne Halt vor den Nodes.
    if (target?.mode === 'debug') throw new BadRequestException('Debug-Läufe können nicht per Retry neu gestartet werden');
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

    // Wer den Retry auslöst, verantwortet ihn (samt API-Key-Verengung). Ohne
    // Request-Akteur bleibt zuständig, wem der Elternlauf zuzurechnen war —
    // aufgelöst, nicht nur `triggeredBy.userId`: ein Zeitplan-/Event-Lauf
    // trägt dort keinen Nutzer, sein Akteur kommt aus der Approval.
    const parentActor = requestActor ? null : await this.resolveAccountable(parent);
    const retryStarter = requestActor
      ? { userId: requestActor.userId, ...(requestActor.apiKeyId ? { apiKeyId: requestActor.apiKeyId } : {}) }
      : { userId: parentActor?.userId, ...(parentActor?.apiKeyId ? { apiKeyId: parentActor.apiKeyId } : {}) };

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
      triggeredBy: { type: 'manual', ...retryStarter },
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
    // Debug-Läufe ohne Alters-Grenze: ihr Schritt hängt an der Queue im
    // Speicher, nach dem Neustart käme er nie an — der Lauf bliebe sonst
    // dauerhaft `running` und jeder weitere Schritt würde abgewiesen.
    const stale = await this.runModel
      .find({
        status: WorkflowRunStatus.RUNNING,
        $or: [{ mode: 'debug' }, { updatedAt: { $lt: cutoff } }],
      })
      .exec();
    // H-18: Vorher wurde jeder unterbrochene Run auf QUEUED gesetzt und
    // startete am TRIGGER neu — jeder bereits erfolgreiche Node lief noch
    // einmal: doppelte Todos, Changelogs, Notifications. Jetzt werden nur die
    // Nodes neu eingereiht, die beim Absturz QUEUED oder RUNNING waren; was
    // SUCCEEDED ist, bleibt erledigt. Für einen RUNNING-Node bleibt es bei
    // „mindestens einmal": ob seine Seiteneffekte vor dem Absturz geschahen,
    // ist nicht feststellbar.
    for (const run of stale) {
      if (run.mode === 'debug') {
        await this.recoverDebugRun(run);
        continue;
      }
      const interrupted = await this.nodeRunModel
        .find({ runId: run._id, status: { $in: [WorkflowNodeRunStatus.RUNNING, WorkflowNodeRunStatus.QUEUED] } })
        .exec();
      await this.nodeRunModel
        .updateMany(
          { _id: { $in: interrupted.map((n) => n._id) } },
          { $set: { status: WorkflowNodeRunStatus.INTERRUPTED, finishedAt: new Date() } },
        )
        .exec();
      const graph = readGraph(run.definitionSnapshot);
      const resumable: Array<{ attempt: number; node: WorkflowNode }> = [];
      for (const nr of interrupted) {
        const node = graph.nodes.find((n) => n.id === nr.nodeId);
        if (node) resumable.push({ attempt: nr.attempt, node });
      }
      if (resumable.length === 0) {
        // Kein Anknüpfungspunkt (z. B. Absturz zwischen dem Speichern eines
        // Ergebnisses und dem Einreihen der Nachfolger). Lieber sichtbar
        // scheitern als blind am Trigger neu starten.
        await this.failRun(run, { code: 'interrupted', message: 'Run beim Neustart unterbrochen, kein fortsetzbarer Node' });
        this.logger.warn(`Interrupted run ${run._id.toString()} failed: nothing resumable`);
        continue;
      }
      for (const { attempt, node } of resumable) {
        await this.enqueueNode(run, node, attempt + 1);
      }
      this.logger.warn(`Resumed interrupted run ${run._id.toString()} at ${resumable.map((x) => x.node.id).join(', ')}`);
    }

    const queued = await this.runModel.find({ status: WorkflowRunStatus.QUEUED }).exec();
    for (const run of queued) {
      this.eventEmitter.emit('workflow.run.queued', { runId: run._id.toString() });
    }
  }

  /**
   * Ein beim Neustart unterbrochener Debug-Schritt wird nicht neu eingereiht:
   * der Job trug `debugDry`, ein erneutes Einreihen ohne ihn liefe echt statt
   * trocken. Der NodeRun wird `interrupted`, der Lauf wartet wieder auf einen
   * Schritt — der Nutzer kann ihn wiederholen.
   */
  private async recoverDebugRun(run: WorkflowRunDocument): Promise<void> {
    const now = new Date();
    await this.nodeRunModel
      .updateMany(
        { runId: run._id, status: { $in: [WorkflowNodeRunStatus.RUNNING, WorkflowNodeRunStatus.QUEUED] } },
        { $set: { status: WorkflowNodeRunStatus.INTERRUPTED, finishedAt: now } },
      )
      .exec();
    await this.runModel
      .updateOne(
        { _id: run._id, status: WorkflowRunStatus.RUNNING },
        {
          $set: { status: WorkflowRunStatus.WAITING_FOR_STEP, 'debug.lastActivityAt': now },
          $push: { 'debug.notices': 'Schritt durch Neustart unterbrochen — bitte wiederholen' },
        },
      )
      .exec();
    this.logger.warn(`Debug-Lauf ${run._id.toString()} nach Neustart wieder auf waiting_for_step`);
  }
}
