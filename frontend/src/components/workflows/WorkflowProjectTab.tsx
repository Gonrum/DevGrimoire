import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { workflowsApi, WorkflowDefinition, WorkflowScope } from '../../api/workflows';
import { WorkflowCardGrid } from './WorkflowCardGrid';
import { CreateWorkflowDialog } from './CreateWorkflowDialog';
import { useToast } from '../Toast';
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
  const toast = useToast();

  const load = async () => {
    setLoading(true);
    try {
      const list = await workflowsApi.list({ scope, projectId, customerId });
      setWorkflows(list);
    } catch (err) {
      toast.showError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [scope, projectId, customerId]);

  const onRun = async (id: string) => {
    try {
      const run = await workflowsApi.start(id);
      toast.showSuccess(`Run gestartet: ${run._id}`);
      setRunId(run._id);
    } catch (err) {
      toast.showError(`Run fehlgeschlagen: ${(err as Error).message}`);
    }
  };

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <button onClick={() => setCreateOpen(true)} className="inline-flex items-center gap-1 rounded bg-cyan-600 px-3 py-2 text-sm text-white hover:bg-cyan-500">
          <Plus size={14} /> Neuer Workflow
        </button>
      </div>
      {loading ? <div className="text-sm text-gray-500">Lädt…</div> : <WorkflowCardGrid workflows={workflows} onRun={onRun} />}
      <CreateWorkflowDialog
        open={createOpen}
        defaultScope={scope}
        defaultProjectId={projectId}
        defaultCustomerId={customerId}
        onClose={() => { setCreateOpen(false); void load(); }}
      />
      {runId && <WorkflowRunInspector runId={runId} onClose={() => setRunId(null)} />}
    </div>
  );
}
