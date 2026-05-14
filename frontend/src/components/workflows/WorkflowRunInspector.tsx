import { useEffect, useState } from 'react';
import { workflowsApi, WorkflowRun, WorkflowNodeRun, WorkflowRunStatus } from '../../api/workflows';
import { runStatusStyles } from './runStatusStyles';

interface Props {
  runId: string;
  onClose: () => void;
  onNavigate?: (runId: string) => void;
}

const TERMINAL: WorkflowRunStatus[] = ['succeeded', 'failed', 'cancelled'];

export function WorkflowRunInspector({ runId, onClose, onNavigate }: Props) {
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [nodeRuns, setNodeRuns] = useState<WorkflowNodeRun[]>([]);
  const [selected, setSelected] = useState<WorkflowNodeRun | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const [r, nrs] = await Promise.all([
          workflowsApi.getRun(runId),
          workflowsApi.listNodeRuns(runId),
        ]);
        if (cancelled) return;
        setRun(r);
        setNodeRuns(nrs);
        if (TERMINAL.includes(r.status)) return;
        setTimeout(tick, 1000);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    };
    void tick();
    return () => { cancelled = true; };
  }, [runId]);

  const onCancel = async () => {
    try {
      await workflowsApi.cancelRun(runId);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const onRetry = async () => {
    try {
      const result = await workflowsApi.retryRun(runId);
      // Retry now spawns a new run — navigate to it so the user sees the live
      // re-execution rather than the unchanged parent.
      if (onNavigate && result.runId) onNavigate(result.runId);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="mx-4 max-h-[90vh] w-full max-w-4xl overflow-hidden rounded-xl border border-gray-700 bg-gray-900 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-gray-800 px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-200">Run-Verlauf</h2>
            <div className="font-mono text-xs text-gray-500">{runId}</div>
          </div>
          <button onClick={onClose} className="text-2xl leading-none text-gray-500 hover:text-gray-300">×</button>
        </div>

        {error && <div className="m-4 rounded bg-red-900/30 px-3 py-2 text-sm text-red-300">{error}</div>}

        {run && (
          <>
            <div className="border-b border-gray-800 px-5 py-3 text-xs">
              <span className={`inline-block rounded px-2 py-0.5 ${badge(run.status)}`}>{run.status}</span>
              <span className="ml-3 text-gray-500">started: {run.startedAt ?? '—'}</span>
              <span className="ml-3 text-gray-500">finished: {run.finishedAt ?? '—'}</span>
              <span className="ml-3 text-gray-500">trigger: {run.triggeredBy?.type ?? '—'}</span>
              {run.parentRunId && (
                <div className="mt-2 flex items-center gap-2 text-violet-300">
                  <span>Retry von</span>
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
                    <span className="text-gray-500">· ab Node <code className="text-cyan-300">{run.retryFromNodeId}</code></span>
                  )}
                </div>
              )}
              {run.error && <div className="mt-2 text-red-300">Fehler: {run.error.code} — {run.error.message}</div>}
            </div>

            <div className="flex h-[60vh]">
              <div className="w-1/2 overflow-y-auto border-r border-gray-800">
                <table className="w-full text-xs">
                  <thead className="bg-gray-950 text-gray-500">
                    <tr>
                      <th className="px-3 py-2 text-left">nodeId</th>
                      <th className="px-3 py-2 text-left">type</th>
                      <th className="px-3 py-2 text-left">status</th>
                      <th className="px-3 py-2 text-left">attempt</th>
                      <th className="px-3 py-2 text-left">duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {nodeRuns.map((nr) => {
                      const sty = runStatusStyles[nr.status];
                      return (
                        <tr
                          key={nr._id}
                          onClick={() => setSelected(nr)}
                          className={`cursor-pointer border-t border-gray-800 hover:bg-gray-800/50 ${selected?._id === nr._id ? 'bg-gray-800' : ''}`}
                        >
                          <td className="px-3 py-1 font-mono text-gray-300">{nr.nodeId}</td>
                          <td className="px-3 py-1 text-gray-400">{nr.nodeType}</td>
                          <td className="px-3 py-1"><span className={`rounded px-1.5 py-0.5 text-[10px] ${sty.dotBg}`}>{nr.status}</span></td>
                          <td className="px-3 py-1 text-gray-400">{nr.attempt}</td>
                          <td className="px-3 py-1 text-gray-400">{nr.durationMs ? `${nr.durationMs}ms` : '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="w-1/2 overflow-y-auto p-4">
                {selected ? (
                  <>
                    <SnapshotBlock
                      title="Input (was in den Node ging)"
                      data={selected.inputSnapshot}
                      tone="neutral"
                      defaultOpen={!!selected.error}
                      emptyText="(kein inputSnapshot erfasst)"
                    />
                    <SnapshotBlock
                      title="Output (was an nächste Nodes weitergegeben wurde)"
                      data={selected.outputSnapshot}
                      tone="success"
                      defaultOpen
                      emptyText="(kein outputSnapshot — z.B. weil der Node fehlschlug oder kein Output schreibt)"
                    />
                    {selected.error && (
                      <>
                        <h4 className="mb-2 text-xs uppercase tracking-wide text-red-400">Fehler</h4>
                        <pre className="mb-4 rounded bg-red-900/20 p-2 text-xs text-red-300">{JSON.stringify(selected.error, null, 2)}</pre>
                      </>
                    )}
                    {Array.isArray(selected.logs) && selected.logs.length > 0 && (
                      <>
                        <h4 className="mb-2 text-xs uppercase tracking-wide text-gray-500">Logs ({selected.logs.length})</h4>
                        <ul className="max-h-40 overflow-y-auto rounded bg-gray-950 p-2 text-xs font-mono text-gray-300">
                          {selected.logs.map((l, i) => <li key={i}>{JSON.stringify(l)}</li>)}
                        </ul>
                      </>
                    )}
                  </>
                ) : (
                  <div className="text-xs text-gray-500">Wähle einen Node-Run aus.</div>
                )}
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-gray-800 px-5 py-3">
              {!TERMINAL.includes(run.status) && (
                <button onClick={onCancel} className="rounded bg-amber-900/50 px-3 py-1 text-xs text-amber-200 hover:bg-amber-900">Cancel</button>
              )}
              {(run.status === 'failed' || run.status === 'cancelled') && (
                <button onClick={onRetry} className="rounded bg-cyan-900/50 px-3 py-1 text-xs text-cyan-200 hover:bg-cyan-900">Retry</button>
              )}
              <button onClick={onClose} className="rounded bg-gray-800 px-3 py-1 text-xs text-gray-200 hover:bg-gray-700">Schließen</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function SnapshotBlock({
  title,
  data,
  tone,
  defaultOpen = false,
  emptyText,
}: {
  title: string;
  data: Record<string, unknown> | undefined;
  tone: 'neutral' | 'success';
  defaultOpen?: boolean;
  emptyText: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const hasData = data && Object.keys(data).length > 0;
  const headerColor = tone === 'success' ? 'text-cyan-300' : 'text-gray-400';
  return (
    <div className="mb-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`flex w-full items-center justify-between rounded px-1 py-1 text-xs uppercase tracking-wide hover:bg-gray-800 ${headerColor}`}
      >
        <span>{open ? '▾' : '▸'} {title}</span>
        {hasData && (
          <span className="text-gray-500 normal-case">{Object.keys(data!).length} Felder</span>
        )}
      </button>
      {open && (
        <pre className="mt-1 max-h-48 overflow-y-auto rounded bg-gray-950 p-2 text-xs text-gray-300">
          {hasData ? JSON.stringify(data, null, 2) : emptyText}
        </pre>
      )}
    </div>
  );
}

function badge(s: WorkflowRunStatus): string {
  const map: Record<WorkflowRunStatus, string> = {
    queued: 'bg-gray-700 text-gray-200',
    running: 'bg-yellow-900/60 text-yellow-200',
    waiting_for_user: 'bg-violet-900/60 text-violet-200',
    waiting_for_timer: 'bg-violet-900/60 text-violet-200',
    succeeded: 'bg-green-900/60 text-green-200',
    failed: 'bg-red-900/60 text-red-200',
    cancelled: 'bg-gray-700 text-gray-300',
  };
  return map[s] ?? 'bg-gray-700 text-gray-300';
}
