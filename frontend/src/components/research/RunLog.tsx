import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Loader2, Play } from 'lucide-react';
import { api, getCurrentAccessToken, ResearchRun, ResearchRunStatus, RunStep } from '../../api/client';
import { parseJsonText, readErrorMessage } from '../../api/http-boundary';
import { errorMessage, isRecord } from '../../lib/narrow';
import { useToast } from '../Toast';
import Badge from '../ui/Badge';
import Button from '../ui/Button';
import EmptyState from '../ui/EmptyState';
import { LoadingText } from '../ui/LoadingSpinner';

const RUN_STATUS_COLORS: Record<ResearchRunStatus, string> = {
  queued: 'bg-gray-800 text-gray-400',
  running: 'bg-cyan-900/40 text-cyan-300',
  done: 'bg-green-900/40 text-green-300',
  error: 'bg-red-900/40 text-red-400',
  cancelled: 'bg-gray-800 text-gray-500',
};

type LiveStatus = 'idle' | 'connecting' | 'running' | 'done' | 'error';

interface LiveState {
  runId: string | null;
  status: LiveStatus;
  steps: RunStep[];
  summary?: string;
  error?: string;
}

const IDLE_LIVE: LiveState = { runId: null, status: 'idle', steps: [] };

/**
 * Ein SSE-Frame, so wie er über die Leitung kommt: ein Objekt mit unbekannten
 * Feldern. Vorher stand hier ein `interface SseEvent { type?: string; … }` und
 * `JSON.parse(data) as SseEvent` — die Behauptung, das Fremdformat sei schon
 * geprüft. Sie war an vier Stellen die Wurzel weiterer Casts (`evt.step as
 * RunStep`, `evt.summary as string | undefined`). Jetzt lesen die `read*`-Helfer
 * jedes Feld einzeln und prüfen dabei.
 */
type SseFrame = Record<string, unknown>;

/** Feld als String, oder `undefined` wenn es fehlt/kein String ist. */
function readString(frame: SseFrame, key: string): string | undefined {
  const value = frame[key];
  return typeof value === 'string' ? value : undefined;
}

const RUN_STEP_TYPES: readonly RunStep['type'][] = ['tool_call', 'tool_result', 'note'];

function isRunStepType(value: unknown): value is RunStep['type'] {
  return RUN_STEP_TYPES.some((known) => known === value);
}

/**
 * Baut einen `RunStep` aus einem SSE-Frame-Feld — konstruieren statt behaupten.
 *
 * `ts` ist im Frontend-Typ verpflichtend, im Frame aber nicht garantiert (das
 * Backend fächert bei `attach` die persistierten Schritte aus, bei einem Live-Run
 * das gerade gebaute Objekt). Ein Prädikat müsste einen Schritt ohne `ts`
 * verwerfen und damit eine Zeile aus dem Log schlucken, die der Nutzer sehen
 * soll — deshalb ein Fallback-Zeitstempel statt eines Verwurfs. Verworfen wird
 * nur, was gar keinen bekannten `type` hat: dafür hat die Liste keine Darstellung.
 */
function readRunStep(value: unknown): RunStep | null {
  if (!isRecord(value)) return null;
  const type = value.type;
  if (!isRunStepType(type)) return null;
  return {
    type,
    ts: typeof value.ts === 'string' ? value.ts : new Date().toISOString(),
    tool: typeof value.tool === 'string' ? value.tool : undefined,
    argsSummary: typeof value.argsSummary === 'string' ? value.argsSummary : undefined,
    resultSummary: typeof value.resultSummary === 'string' ? value.resultSummary : undefined,
  };
}

/** Ein abgebrochenes `fetch` wirft eine `DOMException` mit diesem Namen. */
function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function authHeaders(): Record<string, string> {
  const token = getCurrentAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Reads one fetch `Response.body` as an SSE stream (`data: {...}\n\n`
 * frames), invoking `onEvent` for each parsed JSON payload. Mirrors the
 * fetch+ReadableStream parser in `notepad/PromotionDialog.tsx`, which the
 * API client explicitly documents as the reference pattern for these two
 * un-wrapped research-agent SSE endpoints: split on `\n\n`, find the
 * `data:` line, `JSON.parse` it, ignore anything that fails to parse
 * (`: ping` heartbeats included — they never start with `data:`).
 */
async function pumpSse(body: ReadableStream<Uint8Array>, signal: AbortSignal, onEvent: (evt: SseFrame) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() ?? '';
      for (const chunk of chunks) {
        const line = chunk.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        /*
         * Ein einzelner kaputter Frame darf verworfen werden — die Verbindung
         * aber nicht mitnehmen. Deshalb liegt das `try` **um den Frame** und
         * nicht um die Schleife: `parseJsonText` wirft bei ungültigem JSON, und
         * `onEvent` selbst darf hier nicht mit hineingezogen werden, sonst
         * würde ein Render-Fehler als „kaputter Frame" durchgehen.
         */
        let parsed: unknown;
        try {
          parsed = parseJsonText<unknown>(data);
        } catch {
          continue;
        }
        if (isRecord(parsed)) onEvent(parsed);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

interface ArtifactChange {
  slug: string;
  version: number;
  action: 'created' | 'updated';
}

/**
 * The backend never publishes a distinct `artifact` bus event (the
 * `RunEvent['type']` union reserves it, but nothing emits it today) —
 * artifact writes surface as a `tool_result` step for the `artifact_write`
 * tool, whose `resultSummary` is `JSON.stringify({slug,version,action})`
 * (possibly truncated to `STEP_SUMMARY_CHARS`, hence the guarded parse).
 */
function parseArtifactWrites(steps: RunStep[]): ArtifactChange[] {
  const out: ArtifactChange[] = [];
  for (const s of steps) {
    if (s.type !== 'tool_result' || s.tool !== 'artifact_write' || !s.resultSummary) continue;
    let parsed: unknown;
    try {
      parsed = parseJsonText<unknown>(s.resultSummary);
    } catch {
      // truncated/non-JSON summary — skip this one, not fatal
      continue;
    }
    if (!isRecord(parsed)) continue;
    const slug = parsed.slug;
    const version = parsed.version;
    const action = parsed.action;
    if (typeof slug === 'string' && slug.length > 0 && typeof version === 'number' && (action === 'created' || action === 'updated')) {
      out.push({ slug, version, action });
    }
  }
  return out;
}

function StepList({ steps }: { steps: RunStep[] }) {
  if (steps.length === 0) return null;
  return (
    <ul className="space-y-1 max-h-64 overflow-y-auto font-mono text-xs">
      {steps.map((s, i) => (
        <li key={i} className="text-gray-500 break-all">
          <span className="text-gray-700 mr-1">{s.type === 'tool_call' ? '→' : s.type === 'tool_result' ? '←' : '•'}</span>
          {s.tool && <span className="text-violet-300 mr-1">{s.tool}</span>}
          <span>{s.type === 'tool_call' ? s.argsSummary : s.resultSummary}</span>
        </li>
      ))}
    </ul>
  );
}

function RunRow({ run, expanded, onToggle }: { run: ResearchRun; expanded: boolean; onToggle: () => void }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language === 'de' ? 'de-DE' : 'en-US';

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg">
      <button type="button" onClick={onToggle} className="w-full flex items-center justify-between gap-2 px-4 py-2.5 text-left">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          {expanded ? <ChevronDown className="w-3.5 h-3.5 text-gray-500 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-gray-500 shrink-0" />}
          <span className="text-sm text-gray-300 shrink-0">{t('researchTopics.runNumberLabel', { number: run.number })}</span>
          <Badge color={RUN_STATUS_COLORS[run.status]} rounded="full">{t(`researchTopics.runStatus_${run.status}`)}</Badge>
          <Badge color="bg-gray-800 text-gray-500" rounded="full">{t(`researchTopics.runTrigger_${run.trigger}`)}</Badge>
        </div>
        <span className="text-xs text-gray-600 shrink-0">{run.startedAt ? new Date(run.startedAt).toLocaleString(locale) : ''}</span>
      </button>
      {expanded && (
        <div className="px-4 pb-3 border-t border-gray-800 pt-3 space-y-2">
          <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-gray-600">
            {run.startedAt && <span>{t('researchTopics.runStartedAt')}: {new Date(run.startedAt).toLocaleString(locale)}</span>}
            {run.finishedAt && <span>{t('researchTopics.runFinishedAt')}: {new Date(run.finishedAt).toLocaleString(locale)}</span>}
          </div>
          {(run.artifactsCreated.length > 0 || run.artifactsUpdated.length > 0) && (
            <div className="flex flex-wrap items-center gap-1.5">
              {run.artifactsCreated.length > 0 && <span className="text-xs text-gray-500">{t('researchTopics.artifactsCreatedLabel')}</span>}
              {run.artifactsCreated.map((slug) => (
                <Badge key={`c-${slug}`} color="bg-green-900/40 text-green-300" rounded="full">{slug}</Badge>
              ))}
              {run.artifactsUpdated.length > 0 && <span className="text-xs text-gray-500 ml-2">{t('researchTopics.artifactsUpdatedLabel')}</span>}
              {run.artifactsUpdated.map((slug) => (
                <Badge key={`u-${slug}`} color="bg-cyan-900/40 text-cyan-300" rounded="full">{slug}</Badge>
              ))}
            </div>
          )}
          {run.summary && <p className="text-xs text-gray-400">{run.summary}</p>}
          {run.error && <p className="text-xs text-red-400">{run.error}</p>}
          <StepList steps={run.steps} />
        </div>
      )}
    </div>
  );
}

export interface RunLogHandle {
  startRun: () => void;
}

interface RunLogProps {
  topicId: string;
  /** Fired once a run reaches a terminal state (done/error) — the parent
   * uses this to bump `ArtifactList`'s refresh token, since a run may have
   * created/updated artifacts. */
  onRunFinished?: () => void;
}

/**
 * Run history + live streaming panel. Kept mounted for the lifetime of the
 * topic page regardless of which tab is active (see `ResearchTopicPage`'s
 * CSS-hide tab strategy) so an in-flight SSE connection survives tab
 * switches instead of being torn down. Exposes `startRun` via ref so the
 * page header's "Jetzt ausführen" button can trigger the same start path.
 */
const RunLog = forwardRef<RunLogHandle, RunLogProps>(function RunLog({ topicId, onRunFinished }, ref) {
  const { t } = useTranslation();
  const { showError } = useToast();

  const [runs, setRuns] = useState<ResearchRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [live, setLive] = useState<LiveState>(IDLE_LIVE);

  const abortRef = useRef<AbortController | null>(null);
  // Tracks the run identity across the async SSE continuation without
  // depending on `live` state, which would be stale inside the closure
  // captured at stream-start time (state updates don't mutate old closures).
  const runIdRef = useRef<string | null>(null);

  /*
   * Reihenfolge der Callbacks ist bindend: `useCallback`-Dep-Listen werden beim
   * Render **sofort** ausgewertet. Vorher standen `handleEvent` und
   * `finalizeLive` in umgekehrter Reihenfolge — als reine Closures ging das
   * gut, mit Dep-Listen wäre `[finalizeLive]` ein Zugriff in der Temporal Dead
   * Zone und hätte beim ersten Render geworfen. Kette: load → finalizeLive →
   * handleEvent → attachToRun → startRun.
   */
  const load = useCallback(async (): Promise<ResearchRun[]> => {
    setLoading(true);
    try {
      const list = await api.researchTopics.runsList(topicId);
      setRuns(list);
      return list;
    } catch (err) {
      showError(errorMessage(err));
      return [];
    } finally {
      setLoading(false);
    }
  }, [topicId, showError]);

  const finalizeLive = useCallback(
    async (status: 'done' | 'error', summary?: string, error?: string) => {
      const finishedId = runIdRef.current;
      setLive((s) => ({ ...s, status, summary, error }));
      onRunFinished?.();
      await load();
      if (finishedId) setExpandedRunId(finishedId);
      runIdRef.current = null;
      setLive(IDLE_LIVE);
    },
    [load, onRunFinished],
  );

  const handleEvent = useCallback(
    (evt: SseFrame) => {
      switch (evt.type) {
        case 'run_started': {
          const runId = readString(evt, 'runId');
          if (!runId) return;
          runIdRef.current = runId;
          setLive({ runId, status: 'running', steps: [] });
          break;
        }
        case 'step': {
          const step = readRunStep(evt.step);
          if (!step) return;
          setLive((s) => ({ ...s, steps: [...s.steps, step] }));
          break;
        }
        case 'artifact':
          // Reserved event type — see `parseArtifactWrites` doc: not emitted
          // by the backend today, handled here only for forward-compat.
          break;
        case 'done':
          // `finalizeLive` fängt seine Fehler über `load` selbst und zeigt sie
          // als Toast — deshalb genügt `void`.
          void finalizeLive('done', readString(evt, 'summary'), undefined);
          break;
        case 'error':
          void finalizeLive(
            'error',
            readString(evt, 'summary'),
            readString(evt, 'error') ?? readString(evt, 'message'),
          );
          break;
        default:
          break;
      }
    },
    [finalizeLive],
  );

  const attachToRun = useCallback(async (runId: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    runIdRef.current = runId;
    setLive({ runId, status: 'running', steps: [] });
    try {
      const res = await fetch(`/api/research-runs/${runId}/stream`, {
        method: 'GET',
        headers: authHeaders(),
        signal: controller.signal,
      });
      /*
       * Vorher: `if (!res.ok || !res.body)` und dann `res.json()` auf beiden
       * Wegen. Bei einer *erfolgreichen* Antwort ohne Body scheiterte das
       * `res.json()`, der Fallback griff und der Nutzer sah als Fehlermeldung
       * das nackte `statusText` („OK"). Die beiden Fälle sind jetzt getrennt.
       */
      if (!res.ok) {
        throw new Error((await readErrorMessage(res)) || t('researchTopics.runStreamError'));
      }
      if (!res.body) throw new Error(t('researchTopics.runStreamError'));
      await pumpSse(res.body, controller.signal, handleEvent);
    } catch (err) {
      if (isAbortError(err)) return;
      const message = err instanceof Error ? err.message : t('researchTopics.runStreamError');
      showError(message);
      setLive((s) => (s.runId === runId ? { ...s, status: 'error', error: message } : s));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [handleEvent, showError, t]);

  const startRun = useCallback(async () => {
    if (live.status === 'connecting' || live.status === 'running') return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    runIdRef.current = null;
    setLive({ runId: null, status: 'connecting', steps: [] });
    try {
      const res = await fetch(`/api/research-topics/${topicId}/runs`, {
        method: 'POST',
        headers: authHeaders(),
        signal: controller.signal,
      });
      if (res.status === 409) {
        const body: unknown = await res.json().catch(() => null);
        showError(t('researchTopics.runAlreadyActive'));
        const activeRunId = isRecord(body) ? readString(body, 'runId') : undefined;
        if (activeRunId) {
          // `attachToRun` zeigt seine Fehler selbst als Toast.
          void attachToRun(activeRunId);
        } else {
          setLive(IDLE_LIVE);
        }
        return;
      }
      if (!res.ok) {
        throw new Error((await readErrorMessage(res)) || t('researchTopics.runStartFailed'));
      }
      if (!res.body) throw new Error(t('researchTopics.runStartFailed'));
      await pumpSse(res.body, controller.signal, handleEvent);
    } catch (err) {
      if (isAbortError(err)) return;
      const message = err instanceof Error ? err.message : t('researchTopics.runStartFailed');
      showError(message);
      // Functional update — preserves any steps already streamed in before
      // the connection failed, rather than wiping the in-progress log.
      setLive((s) => ({ ...s, status: 'error', error: message }));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [topicId, live.status, attachToRun, handleEvent, showError, t]);

  useImperativeHandle(
    ref,
    () => ({
      startRun: () => {
        // `startRun` zeigt seine Fehler selbst als Toast.
        void startRun();
      },
    }),
    [startRun],
  );

  /*
   * Bootstrap: Lauf-Historie holen und an einen noch laufenden Lauf andocken.
   * Soll **ausschliesslich** bei einem Themenwechsel passieren.
   *
   * `load`/`attachToRun` gehören deshalb nicht in die Dep-Liste, sondern über
   * Refs herein: `attachToRun` hängt (über `handleEvent` → `finalizeLive`) an
   * `onRunFinished`, und der Elternteil übergibt dort einen Inline-Arrow
   * (`ResearchTopicPage`: `onRunFinished={() => setArtifactsRefreshToken(…)}`).
   * Eine „vollständige" Dep-Liste würde den SSE-Stream also bei **jedem**
   * Render des Elternteils abbrechen und neu aufbauen — und weil ein neuer
   * Stream Schritte nachliefert, die wieder Render auslösen, wäre das eine
   * Schleife. Vorher versteckte ein `eslint-disable` genau das.
   */
  const loadRef = useRef(load);
  const attachToRunRef = useRef(attachToRun);
  useEffect(() => {
    loadRef.current = load;
    attachToRunRef.current = attachToRun;
  }, [load, attachToRun]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const list = await loadRef.current();
      if (cancelled) return;
      const active = list.find((r) => r.status === 'running' || r.status === 'queued');
      if (active) await attachToRunRef.current(active._id);
    })();
    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
  }, [topicId]);

  const liveArtifactChanges = parseArtifactWrites(live.steps);
  const runBusy = live.status === 'connecting' || live.status === 'running';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-gray-300">{t('researchTopics.tabRuns')}</h2>
        <Button type="button" variant="primary" size="sm" onClick={() => void startRun()} disabled={runBusy}>
          <Play className="w-3.5 h-3.5 inline -mt-0.5 mr-1" />
          {t('researchTopics.runNow')}
        </Button>
      </div>

      {live.status !== 'idle' && (
        <div className="bg-gray-900 border border-violet-800/50 rounded-lg p-4 space-y-3">
          <div className="flex items-center gap-2">
            {runBusy && <Loader2 className="w-4 h-4 animate-spin text-violet-400" />}
            <span className="text-sm font-medium text-violet-300">{t('researchTopics.liveRunTitle')}</span>
            {live.status === 'done' && <Badge color="bg-green-900/40 text-green-300" rounded="full">{t('researchTopics.runStatus_done')}</Badge>}
            {live.status === 'error' && <Badge color="bg-red-900/40 text-red-400" rounded="full">{t('researchTopics.runStatus_error')}</Badge>}
          </div>
          <StepList steps={live.steps} />
          {liveArtifactChanges.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-2 border-t border-gray-800">
              {liveArtifactChanges.map((c, i) => (
                <Badge
                  key={`${c.slug}-${c.version}-${i}`}
                  color={c.action === 'created' ? 'bg-green-900/40 text-green-300' : 'bg-cyan-900/40 text-cyan-300'}
                  rounded="full"
                >
                  {c.slug} (v{c.version})
                </Badge>
              ))}
            </div>
          )}
          {live.summary && <p className="text-xs text-gray-400">{live.summary}</p>}
          {live.error && <p className="text-xs text-red-400">{live.error}</p>}
        </div>
      )}

      {loading ? (
        <LoadingText />
      ) : runs.length === 0 ? (
        <EmptyState message={t('researchTopics.runsEmpty')} />
      ) : (
        <div className="space-y-2">
          {runs.map((run) => (
            <RunRow
              key={run._id}
              run={run}
              expanded={expandedRunId === run._id}
              onToggle={() => setExpandedRunId((cur) => (cur === run._id ? null : run._id))}
            />
          ))}
        </div>
      )}
    </div>
  );
});

export default RunLog;
