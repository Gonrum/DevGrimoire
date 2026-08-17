import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { workflowsApi, WorkflowDefinition, WorkflowScope, WorkflowStatus } from '../api/workflows';
import { WorkflowCardGrid } from '../components/workflows/WorkflowCardGrid';
import { CreateWorkflowDialog } from '../components/workflows/CreateWorkflowDialog';
import { useToast } from '../components/Toast';
import { WorkflowRunInspector } from '../components/workflows/WorkflowRunInspector';
import { errorMessage, optionOr } from '../lib/narrow';

/*
 * Die Filterwerte der beiden `<select>` als Listen: `e.target.value` ist
 * `string`, und der frühere Cast auf die Union hätte einen umbenannten
 * Options-Wert stillschweigend durchgereicht — der Filter wäre dann an den
 * Server gegangen, ohne dass irgendwo etwas auffällt.
 */
const SCOPE_OPTIONS: readonly (WorkflowScope | 'all')[] = ['all', 'system', 'project', 'customer'];
const STATUS_OPTIONS: readonly (WorkflowStatus | 'all')[] = [
  'all',
  'draft',
  'active',
  'paused',
  'archived',
];

export default function WorkflowsListPage() {
  const [scope, setScope] = useState<WorkflowScope | 'all'>('all');
  const [status, setStatus] = useState<WorkflowStatus | 'all'>('all');
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  /*
   * Zähler statt einer von aussen aufrufbaren `load`-Funktion: das Neuladen nach
   * dem Schliessen des Dialogs ist ein Ereignis, kein zweiter Ladepfad. Der
   * Ladevorgang selbst liegt damit vollständig im Effekt und kann per Cleanup
   * als veraltet markiert werden.
   */
  const [reloadNonce, setReloadNonce] = useState(0);
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    async function run() {
      setLoading(true);
      setError(null);
      try {
        const filter: Record<string, unknown> = {};
        if (scope !== 'all') filter.scope = scope;
        if (status !== 'all') filter.status = status;
        const list = await workflowsApi.list(filter);
        if (!cancelled) setWorkflows(list);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void run();
    return () => { cancelled = true; };
  }, [scope, status, reloadNonce]);

  const onRun = async (id: string) => {
    try {
      const run = await workflowsApi.start(id);
      toast.showSuccess(`Run gestartet: ${run._id}`);
      setRunId(run._id);
    } catch (err) {
      toast.showError(`Run fehlgeschlagen: ${errorMessage(err)}`);
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
        <select value={scope} onChange={(e) => setScope(optionOr(e.target.value, SCOPE_OPTIONS, 'all'))} className="rounded border border-gray-700 bg-gray-900 px-3 py-1 text-sm text-gray-200">
          <option value="all">Alle Scopes</option>
          <option value="system">System</option>
          <option value="project">Project</option>
          <option value="customer">Customer</option>
        </select>
        <select value={status} onChange={(e) => setStatus(optionOr(e.target.value, STATUS_OPTIONS, 'all'))} className="rounded border border-gray-700 bg-gray-900 px-3 py-1 text-sm text-gray-200">
          <option value="all">Alle Status</option>
          <option value="draft">Draft</option>
          <option value="active">Active</option>
          <option value="paused">Paused</option>
          <option value="archived">Archived</option>
        </select>
      </div>

      {loading && <div className="text-sm text-gray-500">Lädt…</div>}
      {error && <div className="rounded bg-red-900/30 p-3 text-sm text-red-200">{error}</div>}
      {!loading && !error && <WorkflowCardGrid workflows={workflows} onRun={(id) => { void onRun(id); }} />}

      <CreateWorkflowDialog open={createOpen} onClose={() => { setCreateOpen(false); setReloadNonce((n) => n + 1); }} />
      {runId && <WorkflowRunInspector runId={runId} onClose={() => setRunId(null)} onNavigate={setRunId} />}
    </div>
  );
}
