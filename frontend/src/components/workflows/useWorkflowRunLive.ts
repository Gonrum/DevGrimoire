import { useCallback, useEffect, useRef, useState } from 'react';
import i18n from '../../i18n';
import { workflowsApi, WorkflowRun, WorkflowNodeRun } from '../../api/workflows';
import { wsEventBus, isProjectChangeEvent } from '../../api/wsEventBus';
import { errorMessage } from '../../lib/narrow';

const EMPTY: WorkflowNodeRun[] = [];

/**
 * T-353: Live-Updates über WS statt 1s-Polling. Backend emittet bei
 * jedem Node-Start/Node-Ende/Run-Start/Run-Ende ein `workflow-run`-Event
 * mit entityId=runId. Wir filtern darauf und re-fetchen mit 250ms-Throttle.
 * Fallback: visibilitychange → einmaliger fetch beim Tab-Re-Focus
 * (fängt verpasste Events nach WS-Reconnect-Gap ab).
 *
 * Aus dem Lauf-Inspektor herausgelöst, damit das Debug-Panel denselben
 * Mechanismus nutzt. `runId === null` = nichts laden (Debug-Lauf noch nicht gestartet).
 */
export function useWorkflowRunLive(runId: string | null): {
  run: WorkflowRun | null;
  nodeRuns: WorkflowNodeRun[];
  error: string | null;
  refetch: () => Promise<void>;
} {
  // Der Zustand trägt seine runId: beim Wechsel auf einen anderen Lauf wird
  // der alte nicht gezeigt, ohne im Effekt synchron zurückzusetzen.
  const [state, setState] = useState<{
    runId: string;
    run: WorkflowRun;
    nodeRuns: WorkflowNodeRun[];
  } | null>(null);
  const [errorState, setErrorState] = useState<{ runId: string; message: string } | null>(null);
  const refetchTimer = useRef<number | null>(null);
  // Der Effekt legt hier seine aktuelle Abruf-Funktion ab; `refetch` bleibt stabil.
  const fetchRef = useRef<() => Promise<void>>(() => Promise.resolve());

  useEffect(() => {
    if (runId === null) {
      fetchRef.current = () => Promise.resolve();
      return;
    }
    let cancelled = false;

    const refetch = async () => {
      try {
        const [r, nrs] = await Promise.all([
          workflowsApi.getRun(runId),
          workflowsApi.listNodeRuns(runId),
        ]);
        if (cancelled) return;
        setState({ runId, run: r, nodeRuns: nrs });
        setErrorState(null);
      } catch (err) {
        if (!cancelled) setErrorState({ runId, message: errorMessage(err, i18n.t('workflows.run.loadFailed')) });
      }
    };
    fetchRef.current = refetch;

    const scheduleRefetch = () => {
      if (refetchTimer.current !== null) return;
      refetchTimer.current = window.setTimeout(() => {
        refetchTimer.current = null;
        void refetch();
      }, 250);
    };

    // Initialload sofort
    void refetch();

    const unsub = wsEventBus.subscribe({ kind: 'global' }, (event) => {
      if (!isProjectChangeEvent(event)) return;
      if (event.entity !== 'workflow-run' || event.entityId !== runId) return;
      scheduleRefetch();
    });

    const onVisible = () => {
      if (document.visibilityState === 'visible') void refetch();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      unsub();
      document.removeEventListener('visibilitychange', onVisible);
      if (refetchTimer.current !== null) {
        window.clearTimeout(refetchTimer.current);
        refetchTimer.current = null;
      }
    };
  }, [runId]);

  const refetch = useCallback(() => fetchRef.current(), []);
  const current = state !== null && state.runId === runId ? state : null;
  const error = errorState !== null && errorState.runId === runId ? errorState.message : null;
  return { run: current?.run ?? null, nodeRuns: current?.nodeRuns ?? EMPTY, error, refetch };
}
