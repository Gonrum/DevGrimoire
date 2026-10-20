import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { workflowsApi, WorkflowRunStatus } from '../../api/workflows';
import { errorMessage } from '../../lib/narrow';
import { runStatusStyles } from './runStatusStyles';
import { useWorkflowRunLive } from './useWorkflowRunLive';
import { NodeRunTriple } from './NodeRunTriple';

interface Props {
  runId: string;
  onClose: () => void;
  onNavigate?: (runId: string) => void;
}

const TERMINAL: WorkflowRunStatus[] = ['succeeded', 'failed', 'cancelled'];

export function WorkflowRunInspector({ runId, onClose, onNavigate }: Props) {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Live-Updates (WS + Throttle + visibilitychange) stecken im Hook.
  const { run, nodeRuns, error: loadError } = useWorkflowRunLive(runId);
  const error = actionError ?? loadError;
  const selected = nodeRuns.find((nr) => nr._id === selectedId);

  const onCancel = async () => {
    try {
      await workflowsApi.cancelRun(runId);
    } catch (err) {
      setActionError(errorMessage(err, t('workflows.run.cancelFailed')));
    }
  };
  const onRetry = async () => {
    try {
      const result = await workflowsApi.retryRun(runId);
      // Retry now spawns a new run — navigate to it so the user sees the live
      // re-execution rather than the unchanged parent.
      if (onNavigate && result.runId) onNavigate(result.runId);
    } catch (err) {
      setActionError(errorMessage(err, t('workflows.run.retryFailed')));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs" onClick={onClose}>
      <div className="mx-4 max-h-[90vh] w-full max-w-6xl overflow-hidden rounded-xl border border-gray-700 bg-gray-900 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-gray-800 px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-200">{t('workflows.run.title')}</h2>
            <div className="font-mono text-xs text-gray-500">{runId}</div>
          </div>
          <button onClick={onClose} className="text-2xl leading-none text-gray-500 hover:text-gray-300">×</button>
        </div>

        {error && <div className="m-4 rounded-sm bg-red-900/30 px-3 py-2 text-sm text-red-300">{error}</div>}

        {run && (
          <>
            <div className="border-b border-gray-800 px-5 py-3 text-xs">
              <span className={`inline-block rounded-sm px-2 py-0.5 ${badge(run.status)}`}>{run.status === 'waiting_for_step' ? t('workflows.run.waitingForStep') : run.status}</span>
              <span className="ml-3 text-gray-500">{t('workflows.run.started', { value: run.startedAt ?? '—' })}</span>
              <span className="ml-3 text-gray-500">{t('workflows.run.finished', { value: run.finishedAt ?? '—' })}</span>
              <span className="ml-3 text-gray-500">{t('workflows.run.trigger', { value: run.triggeredBy?.type ?? '—' })}</span>
              {run.parentRunId && (
                <div className="mt-2 flex items-center gap-2 text-violet-300">
                  <span>{t('workflows.run.retryOf')}</span>
                  {onNavigate ? (
                    <button
                      onClick={() => onNavigate(run.parentRunId!)}
                      className="font-mono text-cyan-300 hover:underline"
                    >
                      {run.parentRunId.slice(-8)}
                    </button>
                  ) : (
                    <span className="font-mono">{run.parentRunId.slice(-8)}</span>
                  )}
                  {run.retryFromNodeId && (
                    <span className="text-gray-500">· {t('workflows.run.fromNode')} <code className="text-cyan-300">{run.retryFromNodeId}</code></span>
                  )}
                </div>
              )}
              {run.error && <div className="mt-2 text-red-300">{t('workflows.run.error', { code: run.error.code, message: run.error.message })}</div>}
            </div>

            <div className="flex h-[60vh]">
              <div className="w-1/2 overflow-y-auto border-r border-gray-800">
                <table className="w-full text-xs">
                  <thead className="bg-gray-950 text-gray-500">
                    <tr>
                      <th className="px-3 py-2 text-left">{t('workflows.run.colNodeId')}</th>
                      <th className="px-3 py-2 text-left">{t('workflows.run.colType')}</th>
                      <th className="px-3 py-2 text-left">{t('workflows.run.colStatus')}</th>
                      <th className="px-3 py-2 text-left">{t('workflows.run.colAttempt')}</th>
                      <th className="px-3 py-2 text-left">{t('workflows.run.colDuration')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {nodeRuns.map((nr) => {
                      const sty = runStatusStyles[nr.status];
                      return (
                        <tr
                          key={nr._id}
                          onClick={() => setSelectedId(nr._id)}
                          className={`cursor-pointer border-t border-gray-800 hover:bg-gray-800/50 ${selectedId === nr._id ? 'bg-gray-800' : ''}`}
                        >
                          <td className="px-3 py-1 font-mono text-gray-300">{nr.nodeId}</td>
                          <td className="px-3 py-1 text-gray-400">{nr.nodeType}</td>
                          <td className="px-3 py-1"><span className={`rounded-sm px-1.5 py-0.5 text-[10px] ${sty.dotBg}`}>{nr.status}</span></td>
                          <td className="px-3 py-1 text-gray-400">{nr.attempt}</td>
                          <td className="px-3 py-1 text-gray-400">{nr.durationMs ? `${nr.durationMs}ms` : '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="w-1/2 overflow-y-auto">
                <NodeRunTriple nodeRun={selected} emptyHint={t('workflows.run.selectNodeRun')} />
                {selected && Array.isArray(selected.logs) && selected.logs.length > 0 && (
                  <div className="px-4 pb-4">
                    <h4 className="mb-2 text-xs uppercase tracking-wide text-gray-500">{t('workflows.run.logs', { count: selected.logs.length })}</h4>
                    <ul className="max-h-40 overflow-y-auto rounded-sm bg-gray-950 p-2 text-xs font-mono text-gray-300">
                      {selected.logs.map((l, i) => <li key={i}>{JSON.stringify(l)}</li>)}
                    </ul>
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-gray-800 px-5 py-3">
              {!TERMINAL.includes(run.status) && (
                <button onClick={() => { void onCancel(); }} className="rounded-sm bg-amber-900/50 px-3 py-1 text-xs text-amber-200 hover:bg-amber-900">{t('common.cancel')}</button>
              )}
              {(run.status === 'failed' || run.status === 'cancelled') && (
                <button onClick={() => { void onRetry(); }} className="rounded-sm bg-cyan-900/50 px-3 py-1 text-xs text-cyan-200 hover:bg-cyan-900">{t('workflows.run.retry')}</button>
              )}
              <button onClick={onClose} className="rounded-sm bg-gray-800 px-3 py-1 text-xs text-gray-200 hover:bg-gray-700">{t('common.close')}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function badge(s: WorkflowRunStatus): string {
  const map: Record<WorkflowRunStatus, string> = {
    queued: 'bg-gray-700 text-gray-200',
    running: 'bg-yellow-900/60 text-yellow-200',
    waiting_for_user: 'bg-violet-900/60 text-violet-200',
    waiting_for_timer: 'bg-violet-900/60 text-violet-200',
    waiting_for_step: 'bg-violet-900/60 text-violet-200',
    succeeded: 'bg-green-900/60 text-green-200',
    failed: 'bg-red-900/60 text-red-200',
    cancelled: 'bg-gray-700 text-gray-300',
  };
  return map[s] ?? 'bg-gray-700 text-gray-300';
}
