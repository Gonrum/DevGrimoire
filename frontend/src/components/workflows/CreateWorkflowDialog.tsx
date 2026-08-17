import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { workflowsApi, WorkflowScope } from '../../api/workflows';
import { api } from '../../api/client';
import { errorMessage, optionOr } from '../../lib/narrow';
import { useToast } from '../Toast';

const SCOPES: WorkflowScope[] = ['system', 'project', 'customer'];
const TRIGGER_TYPES = ['manual', 'schedule'] as const;
type TriggerType = (typeof TRIGGER_TYPES)[number];

interface Props {
  open: boolean;
  defaultScope?: WorkflowScope;
  defaultProjectId?: string;
  defaultCustomerId?: string;
  onClose: () => void;
}

interface ProjectOption { _id: string; name: string }
interface CustomerOption { _id: string; name: string }
interface TemplateOption {
  id: string;
  name: string;
  description: string;
  category: string;
  supportedScopes: WorkflowScope[];
  triggerType: TriggerType;
  nodeCount: number;
}

/** Alles, was der Nutzer im Dialog eingeben kann — als ein Wert, damit „nichts eingegeben" ein einziges `null` ist. */
interface Draft {
  name: string;
  scope: WorkflowScope;
  projectId: string;
  customerId: string;
  triggerType: TriggerType;
  templateId: string;
}

export function CreateWorkflowDialog({ open, defaultScope, defaultProjectId, defaultCustomerId, onClose }: Props) {
  // `null` = im laufenden Öffnen-Vorgang wurde nichts eingegeben; die
  // angezeigten Werte folgen dann den Props. Vorher kopierte ein Effect die
  // Props beim Öffnen in State — mit dem Nebeneffekt, dass jede spätere
  // Änderung an `defaultProjectId` & Co. das bereits ausgefüllte Formular
  // zurücksetzte, auch mitten im Tippen.
  const [draft, setDraft] = useState<Draft | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [loadingCustomers, setLoadingCustomers] = useState(false);
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const navigate = useNavigate();
  const toast = useToast();

  const { name, scope, projectId, customerId, triggerType, templateId }: Draft = draft ?? {
    name: '',
    scope: defaultScope ?? 'project',
    projectId: defaultProjectId ?? '',
    customerId: defaultCustomerId ?? '',
    triggerType: 'manual',
    templateId: '',
  };

  const patch = (changes: Partial<Draft>) => {
    setDraft({ name, scope, projectId, customerId, triggerType, templateId, ...changes });
  };

  /** Schliesst und verwirft die Eingaben, damit das nächste Öffnen leer startet. */
  const close = () => {
    setDraft(null);
    onClose();
  };

  // Load templates once per open — small list, no pagination needed.
  useEffect(() => {
    if (!open) return;
    void workflowsApi.listTemplates()
      .then(setTemplates)
      .catch(() => setTemplates([]));
  }, [open]);

  const selectedTemplate = templates.find((t) => t.id === templateId);

  // Fetch projects when scope=project and no defaultProjectId is pre-filled
  useEffect(() => {
    if (!open || scope !== 'project') return;
    void (async () => {
      setLoadingProjects(true);
      try {
        const list = await api.projects.list({ active: true });
        setProjects(list.map((p) => ({ _id: p._id, name: p.name })));
      } catch {
        setProjects([]);
      } finally {
        setLoadingProjects(false);
      }
    })();
  }, [open, scope]);

  // Fetch customers when scope=customer
  useEffect(() => {
    if (!open || scope !== 'customer') return;
    void (async () => {
      setLoadingCustomers(true);
      try {
        const list = await api.customers.list();
        setCustomers(list.map((c) => ({ _id: c._id, name: c.name })));
      } catch {
        setCustomers([]);
      } finally {
        setLoadingCustomers(false);
      }
    })();
  }, [open, scope]);

  if (!open) return null;

  const scopeAllowedByTemplate =
    !selectedTemplate || selectedTemplate.supportedScopes.includes(scope);
  const canSubmit =
    !!name.trim() &&
    scopeAllowedByTemplate &&
    (scope === 'system' ||
      (scope === 'project' && !!projectId) ||
      (scope === 'customer' && !!customerId));

  const handleCreate = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const wf = templateId
        ? await workflowsApi.instantiateTemplate({
            templateId,
            name: name.trim(),
            scope,
            projectId: scope === 'project' ? projectId : undefined,
            customerId: scope === 'customer' ? customerId : undefined,
          })
        : await workflowsApi.create({
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
      toast.showSuccess(templateId ? 'Workflow aus Template erstellt' : 'Workflow erstellt');
      close();
      void navigate(`/workflows/${wf._id}`);
    } catch (err) {
      toast.showError(`Erstellen fehlgeschlagen: ${errorMessage(err, 'Unbekannter Fehler')}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={close}>
      <div className="mx-4 w-full max-w-md rounded-xl border border-gray-700 bg-gray-900 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-gray-800 px-5 py-4">
          <h2 className="text-lg font-semibold text-gray-200">Neuer Workflow</h2>
        </div>
        <div className="max-h-[80vh] overflow-y-auto px-5 py-4 space-y-3">
          {templates.length > 0 && (
            <Labeled label="Template (optional)">
              <select
                value={templateId}
                onChange={(e) => {
                  const changes: Partial<Draft> = { templateId: e.target.value };
                  const tpl = templates.find((t) => t.id === e.target.value);
                  if (tpl) {
                    changes.triggerType = tpl.triggerType;
                    // Force scope to a supported one if the current isn't.
                    if (!tpl.supportedScopes.includes(scope)) {
                      changes.scope = tpl.supportedScopes[0] ?? 'project';
                    }
                    if (!name) changes.name = tpl.name;
                  }
                  patch(changes);
                }}
                className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200"
              >
                <option value="">— Leerer Canvas —</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
              {selectedTemplate && (
                <p className="mt-1 text-xs text-gray-500">
                  {selectedTemplate.description} ({selectedTemplate.nodeCount} Nodes, Trigger: {selectedTemplate.triggerType})
                </p>
              )}
              {selectedTemplate && !scopeAllowedByTemplate && (
                <p className="mt-1 text-xs text-red-300">
                  Template unterstützt nur: {selectedTemplate.supportedScopes.join(', ')}
                </p>
              )}
            </Labeled>
          )}
          <Labeled label="Name">
            <input type="text" value={name} onChange={(e) => patch({ name: e.target.value })} className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200" />
          </Labeled>
          <Labeled label="Scope">
            <select value={scope} onChange={(e) => patch({ scope: optionOr(e.target.value, SCOPES, scope) })} className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200">
              <option value="system">System</option>
              <option value="project">Project</option>
              <option value="customer">Customer</option>
            </select>
          </Labeled>
          {scope === 'project' && (
            <Labeled label="Projekt">
              <select
                value={projectId}
                onChange={(e) => patch({ projectId: e.target.value })}
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
                onChange={(e) => patch({ customerId: e.target.value })}
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
            <select
              value={triggerType}
              onChange={(e) => patch({ triggerType: optionOr(e.target.value, TRIGGER_TYPES, triggerType) })}
              disabled={!!templateId}
              className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200 disabled:opacity-50"
            >
              <option value="manual">Manual</option>
              <option value="schedule">Schedule</option>
            </select>
            {templateId && (
              <p className="mt-1 text-xs text-gray-500">Vom Template vorgegeben — im Editor anpassbar.</p>
            )}
          </Labeled>
        </div>
        <div className="flex justify-end gap-2 border-t border-gray-800 px-5 py-3">
          <button onClick={close} className="rounded bg-gray-800 px-3 py-1 text-sm text-gray-200 hover:bg-gray-700">Abbrechen</button>
          <button onClick={() => { void handleCreate(); }} disabled={submitting || !canSubmit} className="rounded bg-cyan-600 px-3 py-1 text-sm text-white hover:bg-cyan-500 disabled:opacity-50">Erstellen</button>
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
