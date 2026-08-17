import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, Customer, CustomerProjectLink, Environment, Project } from '../api/client';
import { useToast } from '../components/Toast';
import Button from '../components/ui/Button';
import { FormInput, FormSelect, FormTextarea } from '../components/ui/FormField';
import { WorkflowPageShell } from '../components/ui/WorkflowShell';
import { LoadingText } from '../components/ui/LoadingSpinner';
import { errorMessage } from '../lib/narrow';

export default function CustomerProjectLinkCreatePage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { showError } = useToast();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [existingLinks, setExistingLinks] = useState<CustomerProjectLink[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [projectId, setProjectId] = useState('');
  const [role, setRole] = useState('');
  const [notes, setNotes] = useState('');
  const [selectedEnvironmentIds, setSelectedEnvironmentIds] = useState<string[]>([]);

  useEffect(() => {
    if (!id) return;
    Promise.all([
      api.customers.get(id),
      api.customers.listProjectLinks(id),
      api.projects.list({ active: true }),
    ])
      .then(([customerData, linkData, projectData]) => {
        setCustomer(customerData);
        setExistingLinks(linkData);
        setProjects(projectData);
      })
      .catch((err: unknown) => showError(errorMessage(err)))
      .finally(() => setLoading(false));
  }, [id, showError]);

  const linkedProjectIds = useMemo(
    () => new Set(existingLinks.map((link) => link.projectId)),
    [existingLinks],
  );

  const availableProjects = useMemo(
    () => projects.filter((project) => !linkedProjectIds.has(project._id)),
    [projects, linkedProjectIds],
  );

  /*
   * Die Vorauswahl war ein Effekt, der `projectId` nachtraeglich setzte, sobald
   * die Projektliste eintraf — abgeleiteter Zustand, doppelt gehalten und einen
   * Render zu spaet. Sie ist jetzt berechnet: leerer State heisst "noch nichts
   * gewaehlt", und dann gilt das erste verfuegbare Projekt.
   */
  const effectiveProjectId = projectId || availableProjects[0]?._id || '';

  useEffect(() => {
    let cancelled = false;
    async function run() {
      setSelectedEnvironmentIds([]);
      if (!effectiveProjectId) {
        setEnvironments([]);
        return;
      }
      try {
        const envs = await api.environments.list(effectiveProjectId);
        if (!cancelled) setEnvironments(envs);
      } catch (err) {
        /*
         * Vorher `.catch(() => setEnvironments([]))`: der Nutzer sah "keine
         * Umgebungen" und verknuepfte das Projekt ohne Umgebungen, obwohl nur
         * der Request gescheitert war. Der `cancelled`-Guard verhindert
         * zusaetzlich, dass beim schnellen Umschalten die Antwort des vorher
         * gewaehlten Projekts die aktuelle Liste ueberschreibt.
         */
        if (!cancelled) {
          setEnvironments([]);
          showError(errorMessage(err));
        }
      }
    }
    void run();
    return () => { cancelled = true; };
  }, [effectiveProjectId, showError]);

  if (loading) return <LoadingText />;
  if (!customer || !id) return <p className="text-red-400">{t('customers.notFound')}</p>;

  const toggleEnvironment = (envId: string) => {
    setSelectedEnvironmentIds((current) =>
      current.includes(envId) ? current.filter((x) => x !== envId) : [...current, envId],
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!effectiveProjectId) return;
    setSaving(true);
    try {
      await api.customers.createProjectLink(id, {
        projectId: effectiveProjectId,
        role: role.trim() || undefined,
        notes: notes.trim() || undefined,
        environmentIds: selectedEnvironmentIds,
      });
      await navigate(`/customers/${id}`);
    } catch (err) {
      showError(errorMessage(err) || t('customers.linkFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <WorkflowPageShell
      backTo={`/customers/${id}`}
      backLabel={customer.name}
      title={t('customers.linkProjectTitle')}
    >
      {availableProjects.length === 0 ? (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 text-center">
          <p className="text-gray-400">{t('customers.allProjectsLinked')}</p>
          <Button type="button" size="lg" className="mt-4" onClick={() => { void navigate(`/customers/${id}`); }}>
            {t('common.back')}
          </Button>
        </div>
      ) : (
        <form onSubmit={(e) => { void handleSubmit(e); }} className="space-y-6">
          <FormSelect label={t('customers.project')} value={effectiveProjectId} onChange={(e) => setProjectId(e.target.value)}>
            {availableProjects.map((project) => (
              <option key={project._id} value={project._id}>{project.name}</option>
            ))}
          </FormSelect>

          <FormInput
            label={t('customers.projectRole')}
            value={role}
            onChange={(e) => setRole(e.target.value)}
          />

          <FormTextarea
            label={t('customers.projectNotes')}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
          />

          <div>
            <label className="block text-sm font-medium text-gray-400 mb-2">
              {t('customers.environmentsLink')}
            </label>
            {environments.length === 0 ? (
              <p className="text-sm text-gray-600">{t('customers.noEnvironments')}</p>
            ) : (
              <div className="space-y-1.5">
                {environments.map((env) => (
                  <label key={env._id} className="flex items-center gap-2 p-2 bg-gray-900 border border-gray-800 rounded cursor-pointer hover:border-violet-700">
                    <input
                      type="checkbox"
                      checked={selectedEnvironmentIds.includes(env._id)}
                      onChange={() => toggleEnvironment(env._id)}
                      className="accent-violet-500"
                    />
                    <span className="text-sm text-gray-200">{env.name}</span>
                    {env.description && <span className="text-xs text-gray-500">— {env.description}</span>}
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="flex gap-2 pt-2">
            <Button type="submit" variant="primary" size="lg" disabled={saving || !effectiveProjectId}>
              {saving ? t('common.saving') : t('customers.linkProjectAction')}
            </Button>
            <Button type="button" size="lg" onClick={() => { void navigate(`/customers/${id}`); }}>
              {t('common.cancel')}
            </Button>
          </div>
        </form>
      )}
    </WorkflowPageShell>
  );
}
