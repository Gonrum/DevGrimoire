import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { workflowsApi, WorkflowDefinition, WorkflowScope, WorkflowStatus } from '../api/workflows';
import { WorkflowCardGrid } from '../components/workflows/WorkflowCardGrid';
import { CreateWorkflowDialog } from '../components/workflows/CreateWorkflowDialog';
import { useToast } from '../components/Toast';
import { WorkflowRunInspector } from '../components/workflows/WorkflowRunInspector';

export default function WorkflowsListPage() {
  const [scope, setScope] = useState<WorkflowScope | 'all'>('all');
  const [status, setStatus] = useState<WorkflowStatus | 'all'>('all');
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const toast = useToast();

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const filter: Record<string, unknown> = {};
      if (scope !== 'all') filter.scope = scope;
      if (status !== 'all') filter.status = status;
      const list = await workflowsApi.list(filter);
      setWorkflows(list);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [scope, status]);

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
    <div className="container mx-auto px-4 py-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold text-gray-200">Workflows</h1>
        <button onClick={() => setCreateOpen(true)} className="inline-flex items-center gap-1 rounded bg-cyan-600 px-3 py-2 text-sm text-white hover:bg-cyan-500">
          <Plus size={14} /> Neuer Workflow
        </button>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        <select value={scope} onChange={(e) => setScope(e.target.value as WorkflowScope | 'all')} className="rounded border border-gray-700 bg-gray-900 px-3 py-1 text-sm text-gray-200">
          <option value="all">Alle Scopes</option>
          <option value="system">System</option>
          <option value="project">Project</option>
          <option value="customer">Customer</option>
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value as WorkflowStatus | 'all')} className="rounded border border-gray-700 bg-gray-900 px-3 py-1 text-sm text-gray-200">
          <option value="all">Alle Status</option>
          <option value="draft">Draft</option>
          <option value="active">Active</option>
          <option value="paused">Paused</option>
          <option value="archived">Archived</option>
        </select>
      </div>

      {loading && <div className="text-sm text-gray-500">Lädt…</div>}
      {error && <div className="rounded bg-red-900/30 p-3 text-sm text-red-200">{error}</div>}
      {!loading && !error && <WorkflowCardGrid workflows={workflows} onRun={onRun} />}

      <CreateWorkflowDialog open={createOpen} onClose={() => { setCreateOpen(false); void load(); }} />
      {runId && <WorkflowRunInspector runId={runId} onClose={() => setRunId(null)} onNavigate={setRunId} />}
    </div>
  );
}
