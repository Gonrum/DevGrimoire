import { useTranslation } from 'react-i18next';
import { WorkflowDefinition } from '../../api/workflows';

interface Props {
  workflow: WorkflowDefinition;
  onActivate: () => void;
  onRun: () => void;
}

export function WorkflowEditorMobileFallback({ workflow, onActivate, onRun }: Props) {
  const { t } = useTranslation();
  return (
    <div className="mx-auto max-w-md p-4 space-y-4">
      <div className="rounded-lg border border-amber-700 bg-amber-900/20 p-3 text-sm text-amber-200">
        {t('workflows.mobileFallback')}
      </div>
      <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
        <div className="text-xs text-gray-500">{t('common.name')}</div>
        <div className="mb-3 text-lg text-gray-200">{workflow.name}</div>
        <div className="text-xs text-gray-500">{t('workflows.mobile.statusScopeVersion')}</div>
        <div className="mb-3 text-gray-200">{workflow.status} · {workflow.scope} · v{workflow.version}</div>
        <div className="text-xs text-gray-500">{t('workflows.create.trigger')}</div>
        <pre className="rounded-sm bg-gray-950 p-2 text-xs text-gray-300">{JSON.stringify(workflow.trigger, null, 2)}</pre>
      </div>
      <details className="rounded-lg border border-gray-800 bg-gray-900 p-2">
        <summary className="cursor-pointer text-sm text-gray-300">{t('workflows.mobile.definition')}</summary>
        <pre className="mt-2 max-h-96 overflow-y-auto rounded-sm bg-gray-950 p-2 text-xs text-gray-300">{JSON.stringify({ nodes: workflow.nodes, edges: workflow.edges }, null, 2)}</pre>
      </details>
      <div className="flex gap-2">
        {workflow.status === 'draft' && (
          <button onClick={onActivate} className="flex-1 rounded-sm bg-cyan-600 px-3 py-2 text-sm text-white hover:bg-cyan-500">{t('workflows.editor.activate')}</button>
        )}
        {workflow.status === 'active' && (
          <button onClick={onRun} className="flex-1 rounded-sm bg-green-600 px-3 py-2 text-sm text-white hover:bg-green-500">{t('workflows.mobile.startRun')}</button>
        )}
      </div>
    </div>
  );
}
