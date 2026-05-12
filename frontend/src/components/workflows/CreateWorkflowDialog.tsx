import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { workflowsApi, WorkflowScope } from '../../api/workflows';
import { useToast } from '../Toast';

interface Props {
  open: boolean;
  defaultScope?: WorkflowScope;
  defaultProjectId?: string;
  defaultCustomerId?: string;
  onClose: () => void;
}

export function CreateWorkflowDialog({ open, defaultScope, defaultProjectId, defaultCustomerId, onClose }: Props) {
  const [name, setName] = useState('');
  const [scope, setScope] = useState<WorkflowScope>(defaultScope ?? 'project');
  const [projectId, setProjectId] = useState(defaultProjectId ?? '');
  const [customerId, setCustomerId] = useState(defaultCustomerId ?? '');
  const [triggerType, setTriggerType] = useState<'manual' | 'schedule'>('manual');
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();
  const toast = useToast();

  if (!open) return null;

  const handleCreate = async () => {
    if (!name.trim()) return;
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
            <Labeled label="Project ID">
              <input type="text" value={projectId} onChange={(e) => setProjectId(e.target.value)} className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200 font-mono" />
            </Labeled>
          )}
          {scope === 'customer' && (
            <Labeled label="Customer ID">
              <input type="text" value={customerId} onChange={(e) => setCustomerId(e.target.value)} className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200 font-mono" />
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
          <button onClick={handleCreate} disabled={submitting || !name.trim()} className="rounded bg-cyan-600 px-3 py-1 text-sm text-white hover:bg-cyan-500 disabled:opacity-50">Erstellen</button>
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
