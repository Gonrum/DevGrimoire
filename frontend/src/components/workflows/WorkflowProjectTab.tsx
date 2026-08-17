import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { workflowsApi, WorkflowDefinition, WorkflowScope } from '../../api/workflows';
import { WorkflowCardGrid } from './WorkflowCardGrid';
import { CreateWorkflowDialog } from './CreateWorkflowDialog';
import { useToast } from '../Toast';
import { errorMessage } from '../../lib/narrow';
import { WorkflowRunInspector } from './WorkflowRunInspector';

interface Props {
  scope: WorkflowScope;
  projectId?: string;
  customerId?: string;
}

export function WorkflowProjectTab({ scope, projectId, customerId }: Props) {
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  // Einzeln entnommen statt als `toast`-Objekt: der Context-Value ist ein
  // Objektliteral und damit bei jedem Toast neu — als Effect-Dependency würde
  // er eine Schleife bauen (Ladefehler → Toast → Effect → Ladefehler). Die
  // beiden Funktionen selbst sind `useCallback`-stabil.
  const { showError, showSuccess } = useToast();

  // Der Fetch gehört dem Effect; der Dialog stösst ihn über den Token neu an.
  const [reloadToken, setReloadToken] = useState(0);
  const reload = () => setReloadToken((n) => n + 1);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const list = await workflowsApi.list({ scope, projectId, customerId });
        if (!cancelled) setWorkflows(list);
      } catch (err) {
        if (!cancelled) showError(errorMessage(err, 'Workflows konnten nicht geladen werden'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [scope, projectId, customerId, reloadToken, showError]);

  const onRun = async (id: string) => {
    try {
      const run = await workflowsApi.start(id);
      showSuccess(`Run gestartet: ${run._id}`);
      setRunId(run._id);
    } catch (err) {
      showError(`Run fehlgeschlagen: ${errorMessage(err, 'Unbekannter Fehler')}`);
    }
  };

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <button onClick={() => setCreateOpen(true)} className="inline-flex items-center gap-1 rounded bg-cyan-600 px-3 py-2 text-sm text-white hover:bg-cyan-500">
          <Plus size={14} /> Neuer Workflow
        </button>
      </div>
      {loading ? <div className="text-sm text-gray-500">Lädt…</div> : <WorkflowCardGrid workflows={workflows} onRun={(id) => { void onRun(id); }} />}
      <CreateWorkflowDialog
        open={createOpen}
        defaultScope={scope}
        defaultProjectId={projectId}
        defaultCustomerId={customerId}
        onClose={() => { setCreateOpen(false); reload(); }}
      />
      {runId && <WorkflowRunInspector runId={runId} onClose={() => setRunId(null)} onNavigate={setRunId} />}
    </div>
  );
}
