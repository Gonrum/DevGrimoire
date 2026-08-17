import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, ValidationReport, ValidationReportStatus } from '../../api/client';
import { errorMessage } from '../../lib/narrow';
import Badge from '../ui/Badge';
import Button from '../ui/Button';
import DetailSection from '../ui/DetailSection';

interface Props {
  todoId: string;
  projectId?: string;
  basePath: string;
  onError: (message: string) => void;
}

const STATUS_COLORS: Record<ValidationReportStatus, string> = {
  passed: 'bg-green-900/40 text-green-300',
  failed: 'bg-red-900/40 text-red-300',
  error: 'bg-red-900/40 text-red-300',
  skipped: 'bg-gray-800 text-gray-400',
};

function formatDuration(ms?: number): string | null {
  if (typeof ms !== 'number' || ms < 0) return null;
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 1000)} s`;
}

function ReportCard({
  report,
  basePath,
  bugTodoId,
  bugTodoDisplay,
  onProposeBugTodo,
  proposing,
  t,
}: {
  report: ValidationReport;
  basePath: string;
  bugTodoId?: string;
  bugTodoDisplay?: string;
  onProposeBugTodo?: () => void;
  proposing?: boolean;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const duration = formatDuration(report.durationMs);
  const isFailure = report.status === 'failed' || report.status === 'error';

  return (
    <div className="bg-gray-900 border border-gray-800 rounded p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge color={STATUS_COLORS[report.status]} rounded="full">
          {t(`validation.status.${report.status}`)}
        </Badge>
        <span className="text-sm text-gray-200 font-medium">{report.name}</span>
        <span className="text-xs text-gray-600 ml-auto">
          {new Date(report.createdAt).toLocaleString()}
        </span>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
        {typeof report.exitCode === 'number' && (
          <span>
            {t('validation.exitCode')}: <span className="text-gray-300">{report.exitCode}</span>
          </span>
        )}
        {duration && (
          <span>
            {t('validation.duration')}: <span className="text-gray-300">{duration}</span>
          </span>
        )}
      </div>

      {report.command && (
        <div className="text-xs">
          <span className="text-gray-500">{t('validation.command')}: </span>
          <code className="text-gray-300 bg-gray-950 px-1 py-0.5 rounded">{report.command}</code>
        </div>
      )}

      {report.summary && (
        <div className="text-xs">
          <div className="text-gray-500 mb-0.5">{t('validation.summary')}</div>
          <pre className="text-gray-300 whitespace-pre-wrap break-words bg-gray-950 rounded p-2 max-h-40 overflow-auto">
            {report.summary}
          </pre>
        </div>
      )}

      {report.outputSnippet && (
        <details className="text-xs">
          <summary className="text-gray-500 cursor-pointer select-none">
            {t('validation.logExcerpt')}
          </summary>
          <pre className="mt-1 text-gray-400 whitespace-pre-wrap break-words bg-gray-950 rounded p-2 max-h-60 overflow-auto">
            {report.outputSnippet}
          </pre>
        </details>
      )}

      {report.truncated && (
        <p className="text-[11px] text-amber-500/80 italic">{t('validation.truncated')}</p>
      )}

      {isFailure && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {bugTodoId ? (
            <>
              <span className="text-xs text-gray-500">
                {t('validation.bugTodoReused', { displayNumber: bugTodoDisplay || bugTodoId.slice(-6) })}
              </span>
              <Link
                to={`${basePath}/todos/${bugTodoId}`}
                className="text-xs text-cyan-400 hover:underline"
              >
                {t('validation.openBugTodo')}
              </Link>
            </>
          ) : onProposeBugTodo ? (
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={onProposeBugTodo}
              disabled={proposing}
            >
              {proposing ? t('validation.proposingBugTodo') : t('validation.proposeBugTodo')}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}

export default function TodoValidationSection({ todoId, projectId, basePath, onError }: Props) {
  const { t } = useTranslation();
  /*
   * Bericht, Historie und die Nummer des angelegten Bug-Todos gehören alle zu
   * *einer* `todoId`. Vorher setzte ein Effect sie beim Wechsel zurück
   * (setState im Effect-Body → Kaskaden-Render), und zwischen Wechsel und
   * Antwort stand noch der Bericht des vorigen Todos auf dem Schirm. Jetzt
   * trägt jeder dieser Zustände seine `todoId` mit sich und wird beim Lesen
   * verglichen: kein Reset-Effect, kein Fremdbericht, und eine verspätete
   * Antwort des Vorgängers kann den aktuellen Stand nicht überschreiben.
   */
  const [loadedLatest, setLoadedLatest] = useState<{ todoId: string; report: ValidationReport | null } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [loadedHistory, setLoadedHistory] = useState<{ todoId: string; reports: ValidationReport[] } | null>(null);
  const [proposing, setProposing] = useState(false);
  const [bugTodo, setBugTodo] = useState<{ todoId: string; displayNumber: string | undefined } | null>(null);

  const latest = loadedLatest?.todoId === todoId ? loadedLatest.report : undefined;
  const history = loadedHistory?.todoId === todoId ? loadedHistory.reports : null;
  const bugTodoNumber = bugTodo?.todoId === todoId ? bugTodo.displayNumber : undefined;

  /*
   * `isStale` statt `AbortSignal`: die typisierten `api.*`-Methoden nehmen kein
   * Signal. Der Effect gibt sein Cancel-Flag herein, der Klick-Pfad (Bug-Todo
   * anlegen → neu laden) ruft ohne Argument auf.
   */
  const fetchLatest = useCallback(async (isStale?: () => boolean) => {
    try {
      const report = await api.validationReports.latestForTodo(todoId);
      if (!isStale?.()) setLoadedLatest({ todoId, report });
    } catch {
      if (!isStale?.()) setLoadedLatest({ todoId, report: null });
    }
  }, [todoId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await fetchLatest(() => cancelled);
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchLatest]);

  // Die Historie wird geladen, wenn sie offen ist und für dieses Todo fehlt.
  // Damit braucht weder der Toggle noch das Anlegen eines Bug-Todos einen
  // eigenen Ladeaufruf: `setLoadedHistory(null)` genügt als Nachlade-Signal.
  useEffect(() => {
    if (!historyOpen || history !== null) return;
    let cancelled = false;
    void (async () => {
      try {
        const reports = await api.validationReports.list({ todoId, limit: 20 });
        if (!cancelled) setLoadedHistory({ todoId, reports });
      } catch (err) {
        if (!cancelled) onError(errorMessage(err, 'Failed to load validation history'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [historyOpen, history, todoId, onError]);

  const handleProposeBugTodo = async () => {
    if (!latest) return;
    setProposing(true);
    try {
      const res = await api.validationReports.proposeBugTodo(latest._id);
      setBugTodo({ todoId, displayNumber: res.todo.displayNumber });
      setLoadedHistory(null);
      await fetchLatest();
    } catch (err) {
      onError(errorMessage(err, t('validation.proposeFailed')));
    } finally {
      setProposing(false);
    }
  };

  if (latest === undefined) return null;

  const bugTodoIdFromMeta = (latest?.metadata?.bugTodoId) || undefined;

  return (
    <DetailSection title={t('validation.sectionTitle')} className="mb-5">
      {latest === null ? (
        <p className="text-xs text-gray-700 italic">{t('validation.noReports')}</p>
      ) : (
        <div className="space-y-3">
          <div>
            <div className="text-xs text-gray-500 mb-1">{t('validation.latest')}</div>
            <ReportCard
              report={latest}
              basePath={basePath}
              bugTodoId={bugTodoIdFromMeta}
              bugTodoDisplay={bugTodoNumber}
              onProposeBugTodo={projectId ? () => { void handleProposeBugTodo(); } : undefined}
              proposing={proposing}
              t={t}
            />
          </div>

          <div>
            <button
              type="button"
              onClick={() => setHistoryOpen((v) => !v)}
              className="text-xs text-gray-500 hover:text-gray-300"
            >
              {historyOpen ? t('validation.hideHistory') : t('validation.showHistory')}
            </button>
            {historyOpen && history && history.length > 1 && (
              <div className="mt-2 space-y-2">
                {history.slice(1).map((r) => (
                  <ReportCard key={r._id} report={r} basePath={basePath} t={t} />
                ))}
              </div>
            )}
            {historyOpen && history && history.length <= 1 && (
              <p className="text-xs text-gray-700 italic mt-2">—</p>
            )}
          </div>
        </div>
      )}
    </DetailSection>
  );
}
