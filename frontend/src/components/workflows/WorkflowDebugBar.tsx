import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bug, FastForward, FlaskConical, Play, RotateCcw, Square, X } from 'lucide-react';
import { ApiError } from '../../api/client';
import { workflowsApi, WorkflowEdge, WorkflowNode, WorkflowNodeRun, WorkflowRun, WorkflowRunStatus } from '../../api/workflows';
import { errorMessage } from '../../lib/narrow';
import { canStep, isTerminalRunStatus, issueLines, latestNodeRun, parseDebugInput } from '../../lib/debug-view';

interface Props {
  workflowId: string;
  /** Aktueller Editor-Graph wie im Speichern-DTO — auch ungespeichert. */
  getGraph: () => { nodes: WorkflowNode[]; edges: WorkflowEdge[] };
  runId: string | null;
  run: WorkflowRun | null;
  nodeRuns: WorkflowNodeRun[];
  loadError: string | null;
  /** Node, auf den sich die Schritt-Knöpfe beziehen (Default: der aktuelle). */
  markedNodeId: string | null;
  onStarted: (runId: string) => void;
  /** Nach angenommenem Schritt: Markierung zurück auf den jeweils aktuellen Node. */
  onStepped: () => void;
  onClose: () => void;
}

/** Statische Map statt dynamischem Schlüssel — auffindbar und vollständig geprüft. */
const STATUS_KEY: Record<WorkflowRunStatus, string> = {
  queued: 'workflows.debug.status.queued',
  running: 'workflows.debug.status.running',
  waiting_for_user: 'workflows.debug.status.waiting_for_user',
  waiting_for_timer: 'workflows.debug.status.waiting_for_timer',
  waiting_for_step: 'workflows.debug.status.waiting_for_step',
  succeeded: 'workflows.debug.status.succeeded',
  failed: 'workflows.debug.status.failed',
  cancelled: 'workflows.debug.status.cancelled',
};

const STATUS_TONE: Record<WorkflowRunStatus, string> = {
  queued: 'text-gray-300',
  running: 'text-yellow-300',
  waiting_for_user: 'text-violet-300',
  waiting_for_timer: 'text-violet-300',
  waiting_for_step: 'text-cyan-300',
  succeeded: 'text-green-300',
  failed: 'text-red-300',
  cancelled: 'text-gray-400',
};

const BTN = 'inline-flex items-center gap-1 rounded-sm px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40';

/**
 * Debug-Leiste über dem Canvas: vor dem Start Eingabe-JSON und „Start",
 * danach Schritt / Trockenlauf / Wiederholen / Beenden für den markierten
 * Node, am Ende das Ergebnis. Jeder Aufruf schickt den aktuellen Graphen —
 * der Server nimmt ihn, nicht den Stand vom Start.
 */
export function WorkflowDebugBar(p: Props) {
  const { t } = useTranslation();
  const [inputText, setInputText] = useState('{}');
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<string[]>([]);

  const input = parseDebugInput(inputText);

  /** 400 = Prüfungsfehler als Liste; 409 (Doppelklick, Lauf schon weiter) still. */
  const showError = (err: unknown) => {
    if (err instanceof ApiError && err.status === 409) return;
    if (err instanceof ApiError && err.status === 400) {
      setIssues(issueLines(err.message));
      return;
    }
    setIssues([errorMessage(err)]);
  };

  const start = async () => {
    if (input === null || busy) return;
    setBusy(true);
    setIssues([]);
    try {
      const run = await workflowsApi.startDebug(p.workflowId, { input, ...p.getGraph() });
      p.onStarted(run._id);
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  };

  const step = async (nodeId: string, mode: 'execute' | 'dry') => {
    if (p.runId === null || busy) return;
    setBusy(true);
    setIssues([]);
    try {
      await workflowsApi.debugStep(p.runId, { nodeId, mode, ...p.getGraph() });
      p.onStepped();
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (p.runId === null || busy) return;
    setBusy(true);
    try {
      await workflowsApi.cancelRun(p.runId, t('workflows.debug.stopReason'));
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  };

  const issueList = issues.length > 0 && (
    <div className="mt-1 rounded-sm border border-red-900/60 bg-red-950/40 px-2 py-1 text-[11px] text-red-200">
      <div className="font-semibold">{t('workflows.debug.issuesTitle')}</div>
      <ul className="list-disc pl-4">
        {issues.map((line, i) => <li key={i}>{line}</li>)}
      </ul>
    </div>
  );

  const shell = (children: React.ReactNode) => (
    <div className="border-b border-gray-800 bg-gray-900/90 px-3 py-2 text-xs text-gray-200">
      {children}
      {issueList}
    </div>
  );

  // Vor dem Start: Eingabe frei wählbar, unabhängig vom Trigger-Typ.
  if (p.runId === null) {
    return shell(
      <div className="flex flex-wrap items-start gap-2">
        <span className="inline-flex items-center gap-1 pt-1 font-semibold text-cyan-300"><Bug size={12} /> {t('workflows.debug.title')}</span>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-wide text-gray-500">{t('workflows.debug.input')}</span>
          <textarea
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            rows={2}
            spellCheck={false}
            className={`w-80 rounded-sm border bg-gray-950 px-2 py-1 font-mono text-[11px] text-gray-200 ${input === null ? 'border-red-700' : 'border-gray-700'}`}
          />
          {input === null && <span className="text-[11px] text-red-300">{t('workflows.debug.inputInvalid')}</span>}
        </label>
        <button
          type="button"
          onClick={() => { void start(); }}
          disabled={input === null || busy}
          className={`${BTN} mt-4 bg-cyan-700 text-white hover:bg-cyan-600`}
        ><Play size={12} /> {t('workflows.debug.start')}</button>
        <button type="button" onClick={p.onClose} className={`${BTN} mt-4 bg-gray-800 text-gray-200 hover:bg-gray-700`}>
          <X size={12} /> {t('workflows.debug.close')}
        </button>
      </div>,
    );
  }

  const run = p.run;
  if (run === null) {
    return shell(
      <div className="flex items-center gap-2">
        <span className="text-gray-400">{p.loadError ?? t('workflows.debug.loading')}</span>
        <button type="button" onClick={p.onClose} className={`${BTN} ml-auto bg-gray-800 text-gray-200 hover:bg-gray-700`}>
          <X size={12} /> {t('workflows.debug.close')}
        </button>
      </div>,
    );
  }

  const notices = run.debug?.notices ?? [];
  const noticeList = notices.length > 0 && (
    <ul className="mt-1 space-y-0.5 text-[11px] text-amber-300">
      {notices.map((line, i) => <li key={i}>{line}</li>)}
    </ul>
  );
  const statusLabel = <span className={`font-semibold ${STATUS_TONE[run.status]}`}>{t(STATUS_KEY[run.status])}</span>;

  if (isTerminalRunStatus(run.status)) {
    return shell(
      <>
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 font-semibold text-cyan-300"><Bug size={12} /> {t('workflows.debug.result')}</span>
          {statusLabel}
          {run.error && <span className="truncate text-red-300">{run.error.message}</span>}
          <button type="button" onClick={p.onClose} className={`${BTN} ml-auto bg-gray-800 text-gray-200 hover:bg-gray-700`}>
            <X size={12} /> {t('workflows.debug.close')}
          </button>
        </div>
        {noticeList}
      </>,
    );
  }

  const pending = run.debug?.pendingNodeIds ?? [];
  const marked = p.markedNodeId;
  const markedRun = latestNodeRun(p.nodeRuns, marked);
  const stepping = canStep(run.status) && !busy;
  // Der Server nimmt nur den nächsten Node oder einen schon gelaufenen.
  const markedSteppable = marked !== null && (pending.includes(marked) || markedRun !== undefined);

  return shell(
    <>
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 font-semibold text-cyan-300"><Bug size={12} /> {t('workflows.debug.title')}</span>
        {statusLabel}
        {run.status === 'waiting_for_user' && <span className="text-violet-300">{t('workflows.debug.waitingForUser')}</span>}
        <span className="text-gray-400">
          {marked !== null
            ? t('workflows.debug.marked', { id: marked })
            : t('workflows.debug.noMarked')}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-1">
          <button
            type="button"
            onClick={() => { if (marked !== null) void step(marked, 'execute'); }}
            disabled={!stepping || !markedSteppable}
            className={`${BTN} bg-green-700 text-white hover:bg-green-600`}
          ><FastForward size={12} /> {t('workflows.debug.step')}</button>
          <button
            type="button"
            onClick={() => { if (marked !== null) void step(marked, 'dry'); }}
            disabled={!stepping || !markedSteppable}
            className={`${BTN} bg-amber-700 text-white hover:bg-amber-600`}
          ><FlaskConical size={12} /> {t('workflows.debug.dry')}</button>
          <button
            type="button"
            // Wiederholen in derselben Art wie der letzte Versuch (echt oder trocken).
            onClick={() => { if (marked !== null && markedRun) void step(marked, markedRun.dryRun === true ? 'dry' : 'execute'); }}
            disabled={!stepping || markedRun === undefined}
            className={`${BTN} bg-gray-700 text-gray-100 hover:bg-gray-600`}
          ><RotateCcw size={12} /> {t('workflows.debug.repeat')}</button>
          <button
            type="button"
            onClick={() => { void stop(); }}
            disabled={busy}
            className={`${BTN} bg-red-900/70 text-red-100 hover:bg-red-900`}
          ><Square size={12} /> {t('workflows.debug.stop')}</button>
        </div>
      </div>
      <div className="mt-0.5 text-[10px] text-gray-500">{t('workflows.debug.clickHint')}</div>
      {noticeList}
    </>,
  );
}
