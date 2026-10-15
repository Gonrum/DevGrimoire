import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { actorFromUser } from '../common/actor-scope';
import { errorMessage } from '../common/narrow';
import { RequestContext } from '../common/request-context';
import { EndpointAllocator } from '../balancer/endpoint-allocator.service';
import { PROJECT_CHANGED, type ProjectChangeEvent } from '../events/project-event';
import { NotificationsService } from '../notifications/notifications.service';
import { RagService } from '../rag/rag.service';
import { DEEPEN, DEPTH, type StepKind } from './research-config';
import { runLeadAgent } from './research-lead-agent';
import { ResearchLiveService } from './research-live.service';
import { Interrupted, ResearchLlmService } from './research-llm.service';
import { ResearchOwnerLookup } from './research-owner';
import { digestFiles, orchestrate, runFixedTask, writeReport } from './research-pipeline';
import type { RoundResult } from './research-prompts';
import type { RunContext, RunFile } from './research-run-context';
import { ResearchRunStore, type RunDoc } from './research-run-store';
import { appendSourcesSection, SourceRegistry } from './research-sources';
import { ResearchStepsService } from './research-steps.service';
import { runTaskAgent, type TaskInput, type TaskOutcome } from './research-task-agent';
import { ResearchWeb } from './research-web';
import type { ResearchTask } from './schemas/research.schema';

export type MayStart = 'start' | 'wait' | 'drop';

const RELATED_MIN_SCORE = 0.86;
const RESTART_NOTE = 'Durch Neustart des Servers unterbrochen – „Fortsetzen" macht weiter';
const NO_SOURCES = 'Keine verwertbaren Quellen gefunden';
const MAX_ERROR = 500;
const NOTE_BODY = 200;

type Executor = (t: TaskInput) => Promise<TaskOutcome>;

function toResult(t: ResearchTask): RoundResult {
  return { n: t.n, question: t.question, status: t.status === 'done' ? 'done' : 'failed', summary: t.summary ?? '' };
}

/** Erste Textzeile der Kurzfassung (sonst des Berichts), höchstens 200 Zeichen. */
export function firstSummaryLine(report: string): string {
  const lines = report.split('\n');
  const head = lines.findIndex((l) => /^#{1,3}\s*Kurzfassung\b/i.test(l.trim()));
  const rest = head >= 0 ? lines.slice(head + 1) : lines;
  const line = rest.find((l) => l.trim() !== '' && !l.trim().startsWith('#')) ?? '';
  return line.trim().slice(0, NOTE_BODY);
}

/**
 * Führt eine Recherche aus: Leitung als Agent, Rückfälle A (Bericht aus den
 * vorhandenen Ergebnissen) und B (fester Ablauf), Pause/Abbruch/Fortsetzen
 * und Vertiefen, Neustart-Erholung.
 */
@Injectable()
export class ResearchRunnerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ResearchRunnerService.name);
  private stopping = false;

  constructor(
    private readonly store: ResearchRunStore,
    private readonly live: ResearchLiveService,
    private readonly llm: ResearchLlmService,
    private readonly web: ResearchWeb,
    private readonly steps: ResearchStepsService,
    private readonly rag: RagService,
    private readonly notifications: NotificationsService,
    private readonly auth: ResearchOwnerLookup,
    private readonly allocator: EndpointAllocator,
    private readonly events: EventEmitter2,
  ) {}

  async onModuleInit(): Promise<void> {
    if (process.env.MCP_STDIO === 'true') return;
    try {
      const n = await this.store.pauseAllRunning(RESTART_NOTE);
      if (n > 0) this.logger.log(`${n} unterbrochene Recherche(n) pausiert`);
    } catch (err) {
      this.logger.error(`Neustart-Erholung fehlgeschlagen: ${errorMessage(err)}`);
    }
  }

  onModuleDestroy(): void {
    this.stopping = true;
    this.live.abortAll();
  }

  isStopping(): boolean { return this.stopping; }

  async mayStart(id: string): Promise<MayStart> {
    const doc = await this.store.get(id);
    if (!doc || doc.status !== 'queued') return 'drop';
    if (await this.store.olderQueuedExists(doc)) return 'wait';
    const capacity = await this.allocator.poolCapacity('workflow');
    if (capacity <= 0 || (await this.store.countRunning()) >= capacity) return 'wait';
    return (await this.store.claimQueued(id)) ? 'start' : 'drop';
  }

  /** Wartet das Dokument (wieder), z. B. weil es während des Laufs fortgesetzt wurde? */
  async isQueued(id: string): Promise<boolean> {
    return (await this.store.get(id))?.status === 'queued';
  }

  /** Wirft nie. */
  async run(id: string): Promise<void> {
    try {
      const doc = await this.store.get(id);
      if (!doc) return;
      const user = doc.ownerUserId ? await this.auth.findUserById(doc.ownerUserId) : null;
      if (!user || user.active === false) {
        await this.store.patch(id, { status: 'failed', error: 'Besitzer nicht gefunden', finishedAt: new Date() });
        return;
      }
      const owner = actorFromUser(user);
      await RequestContext.run(owner, undefined, () => this.execute(doc));
    } catch (err) {
      this.logger.error(`Recherche ${id}: ${errorMessage(err)}`);
    }
  }

  private step(id: string, kind: StepKind, text: string, lane?: string): void {
    void this.steps.record(id, { kind, text, lane });
  }

  private async execute(doc: RunDoc): Promise<void> {
    const id = doc.id;
    const ac = this.live.begin(id);
    const startedAt = new Date();
    try {
      await this.store.patch(id, { startedAt, error: null });
      this.step(id, 'info', `Recherche gestartet (${doc.mode}, ${doc.depth})`);
      await this.work(doc, ac.signal, startedAt);
    } catch (err) {
      try {
        if (err instanceof Interrupted) await this.onInterrupted(doc, startedAt);
        else await this.onFailed(doc, startedAt, err);
      } catch (inner) {
        this.logger.error(`Recherche ${id}: Abschluss nicht gespeichert: ${errorMessage(inner)}`);
      }
    } finally {
      this.live.end(id);
    }
  }

  private async work(doc: RunDoc, signal: AbortSignal, startedAt: Date): Promise<void> {
    const id = doc.id;
    const deepen = doc.mode === 'deepen';
    const registry = new SourceRegistry(doc.sourceList);
    const cfg = deepen ? DEEPEN : DEPTH[doc.depth];
    const files: RunFile[] = doc.files.map((f) => ({ ...f }));
    const step = (kind: StepKind, text: string, lane?: string): void => this.step(id, kind, text, lane);
    const ctx: RunContext = {
      researchId: id,
      topic: doc.title,
      focus: doc.focus,
      question: deepen ? doc.modeQuestion : undefined,
      cfg,
      registry,
      files,
      signal,
      llm: this.llm,
      web: this.web,
      usedQueries: new Set(doc.tasks.flatMap((t) => t.queries.map((q) => q.toLowerCase().trim()))),
      models: new Set(),
      step,
      onReroute: (lane) => (to) => step('info', `weiter auf ${to}`, lane),
    };

    // 4. Dateien
    if (files.some((f) => !registry.get(f.n)?.file)) {
      await digestFiles(ctx);
      await this.store.patch(id, { files, sourceList: registry.all() });
    }

    // 5. Bereits im Wissen
    let related = doc.relatedKnowledge;
    if (doc.mode === 'research' && doc.roundsDone === 0 && related.length === 0) {
      try {
        const hits = await this.rag.search(doc.title, undefined, 'knowledge', 5);
        const strong = hits
          .filter((h) => h.score >= RELATED_MIN_SCORE)
          .map((h) => ({ id: h.id, title: h.title, score: h.score }));
        if (strong.length > 0) {
          related = strong;
          await this.store.patch(id, { relatedKnowledge: strong });
          step('info', `Bereits im Wissen: ${strong.map((k) => k.title).join('; ')}`);
        }
      } catch (err) {
        if (err instanceof Interrupted) throw err;
        step('info', 'Wissenssuche nicht verfügbar');
      }
    }

    // 6. Runden-Buchhaltung
    const tasks: ResearchTask[] = doc.tasks.map((t) => ({ ...t, queries: [...t.queries], sources: [...t.sources] }));
    const roundsTotal = deepen ? 1 : cfg.rounds;
    // Vertiefen hat ein eigenes Budget; die Rundennummer der Teilaufträge läuft trotzdem weiter.
    const roundBase = deepen ? doc.roundsDone : 0;
    let counter = deepen ? 0 : doc.roundsDone;

    const execute = async (batch: ResearchTask[], exec: Executor): Promise<RoundResult[]> => {
      await this.store.patch(id, { tasks });
      const settled = await Promise.allSettled(batch.map((t) => exec({ n: t.n, question: t.question, queries: t.queries })));
      let interrupted: Interrupted | undefined;
      settled.forEach((res, i) => {
        const t = batch[i];
        if (res.status === 'fulfilled') {
          t.status = res.value.status;
          t.summary = res.value.summary;
          t.sources = res.value.sources;
        } else if (res.reason instanceof Interrupted) {
          interrupted ??= res.reason;
        } else {
          t.status = 'failed';
          t.summary = '';
          step('error', `T${t.n}: ${errorMessage(res.reason)}`, `t${t.n}`);
        }
      });
      if (interrupted) {
        await this.store.patch(id, { tasks, sourceList: registry.all() });
        throw interrupted;
      }
      counter += 1;
      await this.store.patch(id, { tasks, sourceList: registry.all(), ...(deepen ? {} : { roundsDone: counter }) });
      return batch.map(toResult);
    };

    const runRound = (input: Array<{ question: string; queries: string[] }>, exec: Executor): Promise<RoundResult[]> => {
      let maxN = tasks.reduce((m, t) => Math.max(m, t.n), 0);
      const fresh: ResearchTask[] = input.map((t) => ({
        n: ++maxN, round: roundBase + counter + 1, question: t.question, queries: [...t.queries], status: 'running', sources: [],
      }));
      tasks.push(...fresh);
      return execute(fresh, exec);
    };

    const agentExecutor: Executor = (t) => runTaskAgent(ctx, t);
    const fixedExecutor: Executor = (t) => runFixedTask(ctx, t);

    // 7. Fortsetzen: unterbrochene Teilaufträge zuerst, ohne neue Planung
    const unfinished = tasks.filter((t) => t.status === 'running');
    if (unfinished.length > 0) {
      step('info', `Fortsetzen: ${unfinished.map((t) => `T${t.n}`).join(', ')}`);
      await execute(unfinished, agentExecutor);
    }

    const done = (): RoundResult[] => tasks.filter((t) => t.status === 'done' || t.status === 'failed').map(toResult);
    const previous = tasks.filter((t) => t.status === 'done').map(toResult);
    const extras = { related, followUps: doc.followUps.map((f) => f.question) };
    const reportFrom = (results: RoundResult[]): Promise<string> => {
      if (!registry.all().some((s) => s.relevant)) throw new Error(NO_SOURCES);
      return writeReport(ctx, results, extras);
    };

    // 8. Leitung
    let report: string | null;
    try {
      const outcome = await runLeadAgent({
        ctx,
        roundsTotal,
        get roundsDone() { return counter; },
        previous,
        related,
        followUps: extras.followUps,
        runRound: (t) => runRound(t, agentExecutor),
      });
      report = outcome.report;
    } catch (err) {
      if (err instanceof Interrupted) throw err;
      if (!tasks.some((t) => t.status === 'done')) throw err;
      step('info', `Leitung gescheitert (${errorMessage(err)}) – Bericht aus den vorhandenen Ergebnissen`);
      report = await reportFrom(done());
    }
    if (report === null) {
      step('info', 'Leitung ohne Bericht – fester Ablauf');
      await orchestrate({
        ctx,
        roundsTotal,
        get roundsDone() { return counter; },
        previous,
        runRound: (t) => runRound(t, fixedExecutor),
      });
      report = await reportFrom(done());
    }

    // 9. Abschluss
    const final = appendSourcesSection(report, registry.all());
    if (final.cited.length === 0) throw new Error(NO_SOURCES);
    const finishedAt = new Date();
    await this.store.patch(id, {
      status: 'done',
      content: final.report,
      sourceList: registry.all(),
      sources: final.cited.flatMap((s) => (s.url ? [s.url] : [])),
      model: [...ctx.models],
      finishedAt,
      totalMs: doc.totalMs + (finishedAt.getTime() - startedAt.getTime()),
      mode: 'research',
      modeQuestion: undefined,
      cancelRequested: false,
      pauseRequested: false,
      error: null,
    });
    step('info', 'Recherche fertig');
    this.emitChanged(doc);
    await this.notify(doc, `Recherche fertig: ${doc.title}`, firstSummaryLine(final.report));
  }

  private emitChanged(doc: RunDoc): void {
    if (!doc.projectId && !doc.customerId) return;
    const ev: ProjectChangeEvent = {
      entity: 'research', action: 'updated', entityId: doc.id, projectId: doc.projectId, customerId: doc.customerId,
    };
    this.events.emit(PROJECT_CHANGED, ev);
  }

  private async notify(doc: RunDoc, title: string, body: string): Promise<void> {
    if (!doc.ownerUserId) return;
    try {
      await this.notifications.create(title, body, `/research/${doc.id}`, 'research_done', { userId: doc.ownerUserId });
    } catch (err) {
      this.logger.warn(`Benachrichtigung nicht gesendet: ${errorMessage(err)}`);
    }
  }

  // 10. Unterbrochen
  private async onInterrupted(doc: RunDoc, startedAt: Date): Promise<void> {
    const id = doc.id;
    const totalMs = doc.totalMs + (Date.now() - startedAt.getTime());
    if (this.stopping) {
      // Status bleibt running; die Neustart-Erholung macht daraus paused.
      await this.store.patch(id, { totalMs });
      return;
    }
    const fresh = await this.store.get(id);
    if (!fresh) return; // gelöscht
    const flags = { cancelRequested: false, pauseRequested: false };
    if (!fresh.pauseRequested && fresh.cancelRequested) {
      // Abgebrochene Teilaufträge dürfen ein späteres Vertiefen nicht als „fortzusetzen" fehlleiten.
      const failed: ResearchTask['status'] = 'failed';
      const tasks = fresh.tasks.map((t) => (t.status === 'running' ? { ...t, status: failed } : t));
      if (fresh.content) {
        await this.store.patch(id, { ...flags, status: 'done', tasks, totalMs, mode: 'research', modeQuestion: undefined, finishedAt: new Date() });
      } else {
        await this.store.patch(id, { ...flags, status: 'cancelled', tasks, totalMs, finishedAt: new Date() });
      }
      this.step(id, 'info', 'abgebrochen');
      return;
    }
    // pauseRequested (hat Vorrang) — oder ein Abbruch ohne Flag: lieber fortsetzbar als verloren.
    await this.store.patch(id, { ...flags, status: 'paused', totalMs });
    this.step(id, 'info', 'pausiert');
  }

  // 11. Fehler
  private async onFailed(doc: RunDoc, startedAt: Date, err: unknown): Promise<void> {
    const id = doc.id;
    const msg = errorMessage(err).slice(0, MAX_ERROR);
    const finishedAt = new Date();
    const totalMs = doc.totalMs + (finishedAt.getTime() - startedAt.getTime());
    const flags = { cancelRequested: false, pauseRequested: false };
    if (doc.mode === 'deepen' && doc.content) {
      await this.store.patch(id, { ...flags, status: 'done', error: msg, finishedAt, totalMs, mode: 'research', modeQuestion: undefined });
      this.step(id, 'error', `Vertiefen fehlgeschlagen: ${msg}`);
      return;
    }
    await this.store.patch(id, { ...flags, status: 'failed', error: msg, finishedAt, totalMs });
    this.step(id, 'error', msg);
    await this.notify(doc, `Recherche fehlgeschlagen: ${doc.title}`, msg.slice(0, NOTE_BODY));
  }
}
