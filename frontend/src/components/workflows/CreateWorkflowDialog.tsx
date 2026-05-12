import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { workflowsApi, WorkflowScope } from '../../api/workflows';
import { api } from '../../api/client';
import { useToast } from '../Toast';

interface Props {
  open: boolean;
  defaultScope?: WorkflowScope;
  defaultProjectId?: string;
  defaultCustomerId?: string;
  onClose: () => void;
}

interface ProjectOption { _id: string; name: string }
interface CustomerOption { _id: string; name: string }

export function CreateWorkflowDialog({ open, defaultScope, defaultProjectId, defaultCustomerId, onClose }: Props) {
  const [name, setName] = useState('');
  const [scope, setScope] = useState<WorkflowScope>(defaultScope ?? 'project');
  const [projectId, setProjectId] = useState(defaultProjectId ?? '');
  const [customerId, setCustomerId] = useState(defaultCustomerId ?? '');
  const [triggerType, setTriggerType] = useState<'manual' | 'schedule'>('manual');
  const [submitting, setSubmitting] = useState(false);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [loadingCustomers, setLoadingCustomers] = useState(false);
  const navigate = useNavigate();
  const toast = useToast();

  // Reset scope/project/customer when dialog re-opens with new defaults
  useEffect(() => {
    if (!open) return;
    setScope(defaultScope ?? 'project');
    setProjectId(defaultProjectId ?? '');
    setCustomerId(defaultCustomerId ?? '');
    setName('');
    setTriggerType('manual');
  }, [open, defaultScope, defaultProjectId, defaultCustomerId]);

  // Fetch projects when scope=project and no defaultProjectId is pre-filled
  useEffect(() => {
    if (!open || scope !== 'project') return;
    setLoadingProjects(true);
    api.projects.list({ active: true })
      .then((list) => setProjects(list.map((p) => ({ _id: p._id, name: p.name }))))
      .catch(() => setProjects([]))
      .finally(() => setLoadingProjects(false));
  }, [open, scope]);

  // Fetch customers when scope=customer
  useEffect(() => {
    if (!open || scope !== 'customer') return;
    setLoadingCustomers(true);
    api.customers.list()
      .then((list) => setCustomers(list.map((c) => ({ _id: c._id, name: c.name }))))
      .catch(() => setCustomers([]))
      .finally(() => setLoadingCustomers(false));
  }, [open, scope]);

  if (!open) return null;

  const canSubmit =
    !!name.trim() &&
    (scope === 'system' ||
      (scope === 'project' && !!projectId) ||
      (scope === 'customer' && !!customerId));

  const handleCreate = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const wf = await workflowsApi.create({
        scope,
        projectId: scope === 'project' ? projectId : undefined,
        customerId: scope === 'customer' ? customerId : undefined,
        name: name.trim(),
        trigger: { type: triggerType },
        nodes: [
          { id: 't', type: `trigger.${triggerType}`, position: { x: 100, y: 100 }, config: {}, secretRefs: [] },
        ],
        edges: [],
      });
      toast.showSuccess('Workflow erstellt');
      onClose();
      navigate(`/workflows/${wf._id}`);
    } catch (err) {
      toast.showError(`Erstellen fehlgeschlagen: ${(err as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="mx-4 w-full max-w-md rounded-xl border border-gray-700 bg-gray-900 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-gray-800 px-5 py-4">
          <h2 className="text-lg font-semibold text-gray-200">Neuer Workflow</h2>
        </div>
        <div className="px-5 py-4 space-y-3">
          <Labeled label="Name">
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200" />
          </Labeled>
          <Labeled label="Scope">
            <select value={scope} onChange={(e) => setScope(e.target.value as WorkflowScope)} className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200">
              <option value="system">System</option>
              <option value="project">Project</option>
              <option value="customer">Customer</option>
            </select>
          </Labeled>
          {scope === 'project' && (
            <Labeled label="Projekt">
              <select
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                disabled={loadingProjects}
                className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200 disabled:opacity-50"
              >
                <option value="">{loadingProjects ? 'Lade Projekte…' : '— Projekt wählen —'}</option>
                {projects.map((p) => (
                  <option key={p._id} value={p._id}>{p.name}</option>
                ))}
              </select>
            </Labeled>
          )}
          {scope === 'customer' && (
            <Labeled label="Kunde">
              <select
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
                disabled={loadingCustomers}
                className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200 disabled:opacity-50"
              >
                <option value="">{loadingCustomers ? 'Lade Kunden…' : '— Kunde wählen —'}</option>
                {customers.map((c) => (
                  <option key={c._id} value={c._id}>{c.name}</option>
                ))}
              </select>
            </Labeled>
          )}
          <Labeled label="Trigger">
            <select value={triggerType} onChange={(e) => setTriggerType(e.target.value as 'manual' | 'schedule')} className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200">
              <option value="manual">Manual</option>
              <option value="schedule">Schedule</option>
            </select>
          </Labeled>
        </div>
        <div className="flex justify-end gap-2 border-t border-gray-800 px-5 py-3">
          <button onClick={onClose} className="rounded bg-gray-800 px-3 py-1 text-sm text-gray-200 hover:bg-gray-700">Abbrechen</button>
          <button onClick={handleCreate} disabled={submitting || !canSubmit} className="rounded bg-cyan-600 px-3 py-1 text-sm text-white hover:bg-cyan-500 disabled:opacity-50">Erstellen</button>
        </div>
      </div>
    </div>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs uppercase tracking-wide text-gray-500">{label}</label>
      {children}
    </div>
  );
}
