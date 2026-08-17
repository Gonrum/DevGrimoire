import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { errorMessage, isRecord } from '../common/narrow';
import { RequestContext, RequestUser } from '../common/request-context';
import { ChatLlmService, LlmMessageWithTools, OpenAiToolDef } from '../chat/chat-llm.service';
import { RagService } from '../rag/rag.service';
import { WebSearchService } from '../web-search/services/web-search.service';
import { ReadabilityService } from '../web-search/services/readability.service';
import { ProjectsService } from '../projects/projects.service';
import { CustomersService } from '../customers/customers.service';
import { AuthService } from '../auth/auth.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ResearchTopicService } from './research-topic.service';
import { ResearchArtifactService } from './research-artifact.service';
import { ResearchRunService, FinalizeRunPatch } from './research-run.service';
import { ResearchTopicDocument } from './schemas/research-topic.schema';
import { ResearchRunDocument, ResearchRunStatus, RunStep } from './schemas/research-run.schema';
import { buildResearchTools, ResearchToolContext } from './research-agent.tools';
import { resolveRequestScope, scopeFrom, VisibleIds, RagScope } from './research-scope.util';

// ---------------------------------------------------------------------------
// runToolLoop: the pure, injectable tool-calling loop core.
//
// Deliberately dependency-free (no Nest DI, no HTTP, no Mongo) so it is
// unit-testable in isolation — see `scripts/research-agent-loop-check.cjs`.
// `ResearchAgentService.run` is the only caller that wires it up with the
// real `ChatLlmService`-backed `llm` adapter and Task 12's guarded
// `dispatch`.
// ---------------------------------------------------------------------------

export interface ToolLoopToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface ToolLoopTurn {
  text: string;
  toolCalls: ToolLoopToolCall[];
}

export interface ToolLoopToolResult {
  id: string;
  name: string;
  result: string;
}

export interface ToolLoopLlm {
  /**
   * Drives exactly one LLM turn. `priorResults` is empty on the very first
   * call; on every subsequent call it carries `dispatch()`'s output for each
   * tool call THIS function itself returned in the immediately preceding
   * call (matched by `id`). The adapter is expected to fold both its own
   * previous turn (assistant message + tool_calls) and these results into
   * whatever conversation state it holds before making the next request.
   */
  next: (priorResults: ToolLoopToolResult[]) => Promise<ToolLoopTurn>;
}

export interface RunToolLoopOptions {
  llm: ToolLoopLlm;
  /** Task 12's guarded `buildResearchTools(ctx).dispatch` (or an equivalent
   * mock) — assumed to already be "safe" (never throws; guardrail refusals
   * and errors come back as plain result strings) and to own its OWN
   * tool_call/tool_result step emission via a closed-over `onStep`. */
  dispatch: (name: string, args: unknown) => Promise<string>;
  maxIterations: number;
  /**
   * Loop-LEVEL audit steps only (currently: the maxIterations cutoff note).
   * NOT used for tool_call/tool_result — those already come from `dispatch`
   * (Task 12's `buildResearchTools` closes over the SAME `onStep` this
   * receives when building the run's real context in `run()`, so wiring
   * both to the same sink does not duplicate anything: dispatch owns
   * tool_call/tool_result, the loop owns its own 'note' events).
   */
  onStep?: (step: RunStep) => Promise<void> | void;
  /**
   * Optional externally-owned accumulator. When provided, the loop collects
   * `artifact_write` slugs into THESE sets instead of private ones — so a
   * caller racing this function's returned promise against a timeout/abort
   * (see `ResearchAgentService.raceGuardrails`) can still read whatever the
   * loop accumulated so far even if this promise itself never resolves in
   * time to matter. The returned `artifactsCreated`/`artifactsUpdated`
   * arrays and these sets always reflect the same underlying data.
   */
  partialArtifacts?: { created: Set<string>; updated: Set<string> };
}

export interface RunToolLoopResult {
  summary: string;
  iterations: number;
  artifactsCreated: string[];
  artifactsUpdated: string[];
  hitMaxIterations: boolean;
}

/** Parses an `artifact_write` dispatch result (`{slug,version,action}`, per
 * `execArtifactWrite` in research-agent.tools.ts) and records the slug under
 * the right bucket. Non-JSON results (guardrail refusals, "Fehler: ..."
 * strings) are silently ignored — there is nothing to collect from them. */
function collectArtifactAction(
  toolName: string,
  resultText: string,
  created: Set<string>,
  updated: Set<string>,
): void {
  if (toolName !== 'artifact_write') return;
  try {
    const parsed: unknown = JSON.parse(resultText);
    if (!isRecord(parsed) || typeof parsed.slug !== 'string') return;
    if (parsed.action === 'created') created.add(parsed.slug);
    else if (parsed.action === 'updated') updated.add(parsed.slug);
  } catch {
    // Not JSON — nothing to collect (see doc comment above).
  }
}

export async function runToolLoop(opts: RunToolLoopOptions): Promise<RunToolLoopResult> {
  const { llm, dispatch, maxIterations, onStep, partialArtifacts } = opts;
  const artifactsCreated = partialArtifacts?.created ?? new Set<string>();
  const artifactsUpdated = partialArtifacts?.updated ?? new Set<string>();
  let priorResults: ToolLoopToolResult[] = [];
  let lastText = '';
  let iterations = 0;

  for (let iter = 0; iter < maxIterations; iter++) {
    iterations = iter + 1;
    const turn = await llm.next(priorResults);
    lastText = turn.text ?? '';

    if (!turn.toolCalls || turn.toolCalls.length === 0) {
      return {
        summary: lastText,
        iterations,
        artifactsCreated: [...artifactsCreated],
        artifactsUpdated: [...artifactsUpdated],
        hitMaxIterations: false,
      };
    }

    const results: ToolLoopToolResult[] = [];
    for (const call of turn.toolCalls) {
      const resultText = await dispatch(call.name, call.args);
      results.push({ id: call.id, name: call.name, result: resultText });
      collectArtifactAction(call.name, resultText, artifactsCreated, artifactsUpdated);
    }
    priorResults = results;
  }

  const note = `Recherche-Lauf abgebrochen: maximale Iterationen (${maxIterations}) erreicht.`;
  if (onStep) await onStep({ type: 'note', resultSummary: note, ts: new Date() });

  return {
    summary: lastText || note,
    iterations,
    artifactsCreated: [...artifactsCreated],
    artifactsUpdated: [...artifactsUpdated],
    hitMaxIterations: true,
  };
}

function safeParseJsonArgs(raw: string): unknown {
  if (!raw || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

type GuardrailFailure = 'timeout' | 'cancelled' | 'error';

// ---------------------------------------------------------------------------
// ResearchAgentService — real wiring: RequestContext, scope resolution,
// ChatLlmService-backed LLM adapter, timeout/abort guardrails, finalize.
// ---------------------------------------------------------------------------

@Injectable()
export class ResearchAgentService {
  private readonly logger = new Logger(ResearchAgentService.name);

  constructor(
    private readonly topicService: ResearchTopicService,
    private readonly artifactService: ResearchArtifactService,
    private readonly runService: ResearchRunService,
    private readonly chatLlm: ChatLlmService,
    private readonly rag: RagService,
    private readonly webSearchService: WebSearchService,
    private readonly readabilityService: ReadabilityService,
    private readonly projectsService: ProjectsService,
    private readonly customersService: CustomersService,
    private readonly authService: AuthService,
    private readonly notificationsService: NotificationsService,
  ) {}

  /**
   * Runs one autonomous research pass for `topicId`. Loads the topic, builds
   * a `RequestContext` from `topic.ownerUserId` (mirrors
   * `JwtAuthGuard.canActivate`'s user-scope enrichment — see
   * `buildOwnerRequestUser`), creates the run, drives the tool-calling loop
   * over `chatLlm.streamChatWithTools`, and finalizes with a terminal
   * status. Never throws for a run-local failure — those are recorded on
   * the run itself (`status: 'error'`/`'cancelled'`) and returned normally;
   * only a failure to even LOAD the topic/owner propagates as a rejection
   * (there is no run to attribute it to yet).
   *
   * `onRunCreated`, if given, is invoked SYNCHRONOUSLY with the new run's id
   * the instant `runService.createRun` resolves — strictly before
   * `resolveScope`/the first `appendStep` (see `runInContext`). This lets a
   * caller (`ResearchAgentController.startRun`) subscribe to
   * `runService.subscribe(runId, ...)` before this function itself has any
   * chance to publish a `step`/`artifact` event, closing the "discover the
   * run id, then subscribe late" race that could otherwise drop early steps
   * (notably the scope-truncation note) or — with two concurrent runs for
   * one topic — subscribe to the wrong run entirely.
   */
  async run(
    topicId: string,
    trigger: 'scheduled' | 'manual',
    signal?: AbortSignal,
    onRunCreated?: (runId: string) => void,
  ): Promise<ResearchRunDocument> {
    const topic = await this.topicService.get(topicId);
    const ownerUser = await this.buildOwnerRequestUser(topic.ownerUserId.toString());

    return RequestContext.run(ownerUser, undefined, () =>
      this.runInContext(topic, trigger, signal, onRunCreated),
    );
  }

  /** Builds a full `RequestUser` (permissions + project/customer scope) from
   * a plain userId — the background agent has no HTTP request to piggyback
   * on, so this replicates `JwtAuthGuard`'s "enrich from DB" step directly. */
  private async buildOwnerRequestUser(ownerUserId: string): Promise<RequestUser> {
    const owner = await this.authService.findUserById(ownerUserId);
    if (!owner) {
      throw new NotFoundException(`Research topic owner ${ownerUserId} not found`);
    }
    return {
      userId: owner._id.toString(),
      username: owner.username,
      role: owner.role,
      permissions: owner.permissions ?? [],
      projectScopeMode: owner.projectScopeMode ?? 'all',
      allowedProjectIds: (owner.allowedProjectIds ?? []).map((id) => id.toString()),
      customerScopeMode: owner.customerScopeMode ?? 'all',
      allowedCustomerIds: (owner.allowedCustomerIds ?? []).map((id) => id.toString()),
    };
  }

  private async runInContext(
    topic: ResearchTopicDocument,
    trigger: 'scheduled' | 'manual',
    signal?: AbortSignal,
    onRunCreated?: (runId: string) => void,
  ): Promise<ResearchRunDocument> {
    // If createRun itself throws, there is no run yet to finalize/attribute
    // the failure to — let it propagate.
    const run = await this.runService.createRun(topic._id.toString(), trigger);
    const runId = run._id.toString();

    // MUST fire synchronously here, before `resolveScope`/the scope-note
    // `onStep` call below — see the doc comment on `run()`.
    onRunCreated?.(runId);

    const onStep = async (step: RunStep): Promise<void> => {
      await this.runService.appendStep(runId, step);
    };
    const finalizeOnce = this.makeFinalizeGuard(runId);

    try {
      const { scope, note } = await this.resolveScope(topic);
      if (note) await onStep({ type: 'note', resultSummary: note, ts: new Date() });

      const ctx = this.buildToolContext(topic, runId, scope, onStep);
      const { defs, dispatch } = buildResearchTools(ctx);

      const controller = new AbortController();
      const llm = this.buildLlmAdapter(this.buildSystemPrompt(topic), topic.brief, defs, controller.signal);
      // Owned by THIS scope (not the loop) so it can still be read after a
      // timeout/abort races the loop promise away below — a run that wrote
      // artifacts before timing out should still report them (see the
      // failure branch's finalizeOnce call).
      const partialArtifacts = { created: new Set<string>(), updated: new Set<string>() };
      const loopPromise = runToolLoop({
        llm,
        dispatch,
        maxIterations: topic.guardrails.maxIterations,
        onStep,
        partialArtifacts,
      });

      const raced = await this.raceGuardrails(loopPromise, topic.guardrails.timeoutMs, controller, signal);

      if (raced.result) {
        await finalizeOnce({
          status: ResearchRunStatus.DONE,
          summary: raced.result.summary,
          artifactsCreated: raced.result.artifactsCreated,
          artifactsUpdated: raced.result.artifactsUpdated,
        });
      } else {
        const status = raced.failure === 'cancelled' ? ResearchRunStatus.CANCELLED : ResearchRunStatus.ERROR;
        await finalizeOnce({
          status,
          error: raced.error?.message ?? 'unknown error',
          artifactsCreated: [...partialArtifacts.created],
          artifactsUpdated: [...partialArtifacts.updated],
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Research run ${runId} failed: ${message}`);
      await finalizeOnce({ status: ResearchRunStatus.ERROR, error: message });
    }

    const finalRun = await this.runService.getRun(runId);

    if (topic.notifyOnComplete) {
      await this.sendCompletionNotification(topic, finalRun).catch((err) => {
        this.logger.warn(`notifyOnComplete failed for run ${runId}: ${errorMessage(err)}`);
      });
    }

    return finalRun;
  }

  /**
   * Guards `ResearchRunService.finalize` so it is only ever invoked with a
   * TERMINAL status (`done`/`error`/`cancelled` — never `running`/`queued`,
   * per the T10 review note) and at most once per run (a second call is
   * logged and ignored rather than double-writing/double-publishing).
   *
   * `called` is set only AFTER `runService.finalize` resolves successfully —
   * not before the `await`. If the DB write throws, the guard must NOT have
   * latched yet, or the fallback `finalizeOnce` call in `runInContext`'s
   * `catch` block would see `called === true` and silently no-op, leaving
   * the run stuck in `RUNNING` forever. The check at entry (`if (called)`)
   * still makes repeated SEQUENTIAL calls idempotent, which is the only
   * calling pattern `runInContext` actually has (never two concurrent
   * `finalizeOnce` calls in flight at once).
   */
  private makeFinalizeGuard(runId: string): (patch: FinalizeRunPatch) => Promise<void> {
    const TERMINAL = new Set<ResearchRunStatus>([
      ResearchRunStatus.DONE,
      ResearchRunStatus.ERROR,
      ResearchRunStatus.CANCELLED,
    ]);
    let called = false;
    return async (patch: FinalizeRunPatch): Promise<void> => {
      if (!TERMINAL.has(patch.status)) {
        throw new Error(`finalize() must only be called with a terminal status, got "${patch.status}"`);
      }
      if (called) {
        this.logger.warn(`finalize() called more than once for run ${runId} — ignoring status "${patch.status}"`);
        return;
      }
      await this.runService.finalize(runId, patch);
      called = true;
    };
  }

  /**
   * Resolves `topic.scope` into a concrete, cost-bounded `RagScope`. For
   * `mode==='all'`, lists the owner's visible projects/customers — these
   * calls run INSIDE `RequestContext.run(ownerUser, ...)` (see `run()`), so
   * `ProjectsService.findAll`/`CustomersService.findAll` are already
   * narrowed to what `topic.ownerUserId` can see; `resolveRequestScope` only
   * has to apply the `MAX_SCOPES` cost bound on top (see
   * research-scope.util.ts).
   */
  private async resolveScope(topic: ResearchTopicDocument): Promise<{ scope: RagScope; note?: string }> {
    if (topic.scope?.mode !== 'all') {
      return { scope: scopeFrom(topic) };
    }
    const [visibleProjects, visibleCustomers] = await Promise.all([
      this.projectsService.findAll(),
      this.customersService.findAll(),
    ]);
    const visible: VisibleIds = {
      projectIds: visibleProjects.map((p) => p._id.toString()),
      customerIds: visibleCustomers.map((c) => c._id.toString()),
    };
    return resolveRequestScope(topic, visible);
  }

  /**
   * Builds the `ResearchToolContext` Task 12's `buildResearchTools` expects.
   *
   * One deliberate wiring decision, called out in the task-13 brief's
   * review-note wire-ups:
   *  - `ResearchToolContext.rag.searchScopes` has NO scope parameter at all
   *    (see research-agent.tools.ts) — the pre-resolved + bounded `scope`
   *    (from `resolveScope`/`resolveRequestScope`) is baked into this
   *    closure instead. This is how the `MAX_SCOPES` cost bound actually and
   *    STRUCTURALLY reaches `RagService.searchScopes`: there is no scope
   *    argument at the tool→ctx boundary for a future caller to (re)supply,
   *    honor, or accidentally widen.
   *  - `artifacts.write` stamps the CURRENT run's `runId` onto every write —
   *    `artifact_write`'s tool schema intentionally does not accept a
   *    caller-supplied `runId` from the LLM, so it has to be added one layer
   *    below the tool, where the run's own id is in scope.
   */
  private buildToolContext(
    topic: ResearchTopicDocument,
    runId: string,
    scope: RagScope,
    onStep: (step: RunStep) => Promise<void>,
  ): ResearchToolContext {
    return {
      topic,
      rag: {
        searchScopes: (query, limit) => this.rag.searchScopes(query, scope, limit),
      },
      web: {
        search: async (query) => {
          const res = await this.webSearchService.search({ query });
          return res.results.map((r) => ({
            title: r.title,
            url: r.url,
            snippet: r.snippet,
            engine: r.engine,
            score: r.score,
            publishedDate: r.publishedDate,
          }));
        },
        fetch: async (url) => {
          const res = await this.readabilityService.fetch({ url });
          return { title: res.title, text: res.content };
        },
      },
      artifacts: {
        listByTopic: (id) => this.artifactService.listByTopic(id),
        getBySlug: (id, slug) => this.artifactService.getBySlug(id, slug),
        write: (tid, input, s) => this.artifactService.write(tid, { ...input, runId }, s),
        remove: (id, slug) => this.artifactService.remove(id, slug),
      },
      counters: { webSearches: 0, webFetches: 0 },
      guardrails: topic.guardrails,
      onStep,
    };
  }

  /**
   * German-language researcher/wiki-maintenance system prompt (task-13
   * brief §4): artifact_list first, prefer rag_search over web, update
   * (don't duplicate) existing artifacts, maintain an "offene Fragen"
   * artifact, cite sources — and explicitly warn that `artifact_write` is a
   * full-field overwrite, so `tags`/`sources` must be re-supplied on every
   * update or they get cleared (T9/T12 review note).
   */
  private buildSystemPrompt(topic: ResearchTopicDocument): string {
    const webNote = topic.webSearch?.enabled
      ? `Web-Suche ist aktiviert (max. ${topic.guardrails.maxWebSearches} Suchen / ${topic.guardrails.maxWebFetches} Abrufe pro Lauf) — nutze sie ergänzend zu rag_search, wenn internes Wissen nicht ausreicht.`
      : 'Web-Suche ist für dieses Thema deaktiviert — arbeite ausschließlich mit rag_search und den vorhandenen Artefakten.';

    return [
      `Du bist ein deutschsprachiger Rechercheur, der ein persistentes Wiki zum Thema "${topic.title}" pflegt.`,
      `Auftrag: ${topic.brief}`,
      '',
      'Arbeitsweise:',
      '1. Rufe zuerst artifact_list auf, um zu sehen, was zu diesem Thema bereits dokumentiert ist.',
      '2. Nutze rag_search (und, falls verfügbar, die Web-Tools) für neue Erkenntnisse. Bevorzuge internes Wissen (rag_search) gegenüber dem Web.',
      '3. Aktualisiere bestehende Artefakte statt Duplikate anzulegen — prüfe artifact_read vor größeren Änderungen an einem vorhandenen Slug.',
      '4. Pflege ein Artefakt "offene-fragen" mit ungeklärten Punkten, die weitere Recherche brauchen.',
      '5. Belege Aussagen mit Quellen (sources) — URLs oder interne Referenzen.',
      '',
      'WICHTIG zu artifact_write: Das ist ein VOLLSTÄNDIGES Überschreiben der Felder, kein Merge. ' +
        'Wenn du ein bestehendes Artefakt aktualisierst, MUSST du "tags" und "sources" bei JEDEM Aufruf erneut ' +
        'mitschicken (auch unverändert) — lässt du sie weg, werden sie geleert, nicht beibehalten.',
      '',
      webNote,
      '',
      `Iterationslimit: ${topic.guardrails.maxIterations}. Schließe den Lauf mit einem kurzen Fließtext ab ` +
        '(ohne weiteren Tool-Aufruf) — dieser Text wird als Zusammenfassung des Laufs gespeichert.',
    ].join('\n');
  }

  /**
   * Adapts `chatLlm.streamChatWithTools` (one-turn-at-a-time streaming
   * generator over `{content|tool_call|finish}` events — see
   * `chat.controller.ts` for the same accumulation pattern) into the
   * `ToolLoopLlm` interface `runToolLoop` consumes: each `next()` call folds
   * the previous turn's tool_calls + `priorResults` into the running
   * OpenAI-style conversation, then drives ONE more streamed turn.
   */
  private buildLlmAdapter(
    systemPrompt: string,
    userPrompt: string,
    toolDefs: OpenAiToolDef[],
    signal: AbortSignal,
  ): ToolLoopLlm {
    const conversation: LlmMessageWithTools[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];
    let pendingToolCalls: Array<{ id: string; name: string; arguments: string }> = [];

    return {
      next: async (priorResults: ToolLoopToolResult[]): Promise<ToolLoopTurn> => {
        if (pendingToolCalls.length > 0) {
          conversation.push({
            role: 'assistant',
            content: '',
            tool_calls: pendingToolCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.name, arguments: tc.arguments },
            })),
          });
          for (const r of priorResults) {
            conversation.push({ role: 'tool', tool_call_id: r.id, name: r.name, content: r.result });
          }
        }

        const turnToolCalls: Array<{ id: string; name: string; arguments: string }> = [];
        let text = '';
        for await (const event of this.chatLlm.streamChatWithTools(conversation, toolDefs, { signal })) {
          if (event.type === 'content') text += event.delta;
          else if (event.type === 'tool_call') turnToolCalls.push(event);
        }
        pendingToolCalls = turnToolCalls;

        return {
          text,
          toolCalls: turnToolCalls.map((tc) => ({
            id: tc.id,
            name: tc.name,
            args: safeParseJsonArgs(tc.arguments),
          })),
        };
      },
    };
  }

  /**
   * Enforces `guardrails.timeoutMs` (and the caller's optional abort
   * `signal`) via `Promise.race` against the tool loop. Aborts `controller`
   * on either trigger as a best-effort cancellation of the in-flight LLM
   * stream (via `LlmOptions.signal` in `buildLlmAdapter`) — a raced-away
   * loop iteration may still finish a step in the background, but no
   * further `streamChatWithTools` call will be attempted successfully once
   * the shared `controller` is aborted.
   */
  private async raceGuardrails(
    loopPromise: Promise<RunToolLoopResult>,
    timeoutMs: number,
    controller: AbortController,
    externalSignal?: AbortSignal,
  ): Promise<{ result?: RunToolLoopResult; failure?: GuardrailFailure; error?: Error }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onExternalAbort: (() => void) | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(Object.assign(new Error(`Zeitlimit überschritten (${timeoutMs}ms)`), { code: 'timeout' }));
      }, timeoutMs);
    });

    const abortPromise = new Promise<never>((_, reject) => {
      if (!externalSignal) return;
      onExternalAbort = () => {
        controller.abort();
        reject(Object.assign(new Error('Recherche-Lauf abgebrochen'), { code: 'cancelled' }));
      };
      if (externalSignal.aborted) onExternalAbort();
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    });

    try {
      const result = await Promise.race([loopPromise, timeoutPromise, abortPromise]);
      return { result };
    } catch (err: unknown) {
      // Die beiden Abbruchgründe werden oben als `Object.assign(new Error(…),
      // { code })` geworfen. Vorher stand hier `(err as { code?:
      // GuardrailFailure }).code ?? 'error'` — das behauptete für JEDEN Fehler
      // aus dem Tool-Loop, sein `code` sei einer der drei Guardrail-Werte, und
      // gab ihn unverändert weiter. Sichtbar wird das bei `raced.failure ===
      // 'cancelled'` (siehe `run`): ein fremdes `code: 'cancelled'` hätte den
      // Lauf als abgebrochen statt als fehlgeschlagen verbucht. Jetzt zählen
      // nur die beiden Werte, die diese Funktion selbst wirft.
      const rawCode = isRecord(err) ? err.code : undefined;
      const code: GuardrailFailure =
        rawCode === 'timeout' || rawCode === 'cancelled' ? rawCode : 'error';
      return { failure: code, error: err instanceof Error ? err : new Error(String(err)) };
    } finally {
      if (timer) clearTimeout(timer);
      if (externalSignal && onExternalAbort) externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }

  private async sendCompletionNotification(
    topic: ResearchTopicDocument,
    run: ResearchRunDocument,
  ): Promise<void> {
    const statusLabel =
      run.status === ResearchRunStatus.DONE
        ? 'abgeschlossen'
        : run.status === ResearchRunStatus.ERROR
          ? 'fehlgeschlagen'
          : 'abgebrochen';
    const title = `Recherche "${topic.title}" ${statusLabel}`;
    const body = run.summary || run.error || `Lauf #${run.number} beendet.`;
    await this.notificationsService.create(title, body, undefined, 'research_agent');
  }
}
