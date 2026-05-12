import { WorkflowDefinition } from '../../api/workflows';

interface Props {
  workflow: WorkflowDefinition;
  onActivate: () => void;
  onRun: () => void;
}

export function WorkflowEditorMobileFallback({ workflow, onActivate, onRun }: Props) {
  return (
    <div className="mx-auto max-w-md p-4 space-y-4">
      <div className="rounded-lg border border-amber-700 bg-amber-900/20 p-3 text-sm text-amber-200">
        Der Workflow-Editor benötigt mindestens 768px Breite. Lesemodus aktiv — Änderungen nur am Desktop oder Tablet.
      </div>
      <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
        <div className="text-xs text-gray-500">Name</div>
        <div className="mb-3 text-lg text-gray-200">{workflow.name}</div>
        <div className="text-xs text-gray-500">Status / Scope / Version</div>
        <div className="mb-3 text-gray-200">{workflow.status} · {workflow.scope} · v{workflow.version}</div>
        <div className="text-xs text-gray-500">Trigger</div>
        <pre className="rounded bg-gray-950 p-2 text-xs text-gray-300">{JSON.stringify(workflow.trigger, null, 2)}</pre>
      </div>
      <details className="rounded-lg border border-gray-800 bg-gray-900 p-2">
        <summary className="cursor-pointer text-sm text-gray-300">Definition (JSON)</summary>
        <pre className="mt-2 max-h-96 overflow-y-auto rounded bg-gray-950 p-2 text-xs text-gray-300">{JSON.stringify({ nodes: workflow.nodes, edges: workflow.edges }, null, 2)}</pre>
      </details>
      <div className="flex gap-2">
        {workflow.status === 'draft' && (
          <button onClick={onActivate} className="flex-1 rounded bg-cyan-600 px-3 py-2 text-sm text-white hover:bg-cyan-500">Aktivieren</button>
        )}
        {workflow.status === 'active' && (
          <button onClick={onRun} className="flex-1 rounded bg-green-600 px-3 py-2 text-sm text-white hover:bg-green-500">Run starten</button>
        )}
      </div>
    </div>
  );
}
