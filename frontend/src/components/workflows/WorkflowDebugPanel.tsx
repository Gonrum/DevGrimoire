import { useTranslation } from 'react-i18next';
import type { WorkflowNodeRun, WorkflowNodeRunStatus } from '../../api/workflows';
import { latestNodeRun } from '../../lib/debug-view';
import { NodeRunTriple } from './NodeRunTriple';

/** Statische Map statt dynamischem Schlüssel; gleiche Wörter wie der Lauf-Status, wo es sie gibt. */
const NODE_STATUS_KEY: Record<WorkflowNodeRunStatus, string> = {
  queued: 'workflows.debug.status.queued',
  running: 'workflows.debug.status.running',
  waiting: 'workflows.debug.nodeStatus.waiting',
  succeeded: 'workflows.debug.status.succeeded',
  failed: 'workflows.debug.status.failed',
  skipped: 'workflows.debug.nodeStatus.skipped',
  retrying: 'workflows.debug.nodeStatus.retrying',
  interrupted: 'workflows.debug.nodeStatus.interrupted',
};

interface Props {
  markedNodeId: string | null;
  nodeRuns: WorkflowNodeRun[];
}

/**
 * Panel unter dem Canvas: Bekommen / Eingesetzt / Ergebnis des markierten
 * Nodes — immer sein jüngster Versuch, ein wiederholter Schritt ersetzt also
 * die Anzeige des alten.
 */
export function WorkflowDebugPanel({ markedNodeId, nodeRuns }: Props) {
  const { t } = useTranslation();
  const nodeRun = latestNodeRun(nodeRuns, markedNodeId);
  return (
    <section className="max-h-[40vh] min-h-[8rem] overflow-auto border-t border-gray-800 bg-gray-900">
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-gray-800 bg-gray-900 px-3 py-1 text-[11px] text-gray-400">
        <span className="font-mono text-gray-200">{markedNodeId ?? '—'}</span>
        {nodeRun && (
          <>
            <span>{t('workflows.debug.attempt', { attempt: nodeRun.attempt })}</span>
            <span>{t(NODE_STATUS_KEY[nodeRun.status])}</span>
          </>
        )}
      </header>
      <NodeRunTriple
        nodeRun={nodeRun}
        emptyHint={markedNodeId === null ? t('workflows.debug.noMarked') : t('workflows.debug.notYetRun')}
      />
    </section>
  );
}
