import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  api,
  Customer,
  CustomerProjectLink,
  CustomerProjectLinkStatus,
  Environment,
  Project,
} from '../api/client';
import { useToast } from '../components/Toast';
import Button from '../components/ui/Button';
import { FormInput, FormSelect, FormTextarea } from '../components/ui/FormField';
import { WorkflowPageShell } from '../components/ui/WorkflowShell';
import { LoadingText } from '../components/ui/LoadingSpinner';

export default function CustomerProjectLinkEditPage() {
  const { t } = useTranslation();
  const { id, linkId } = useParams<{ id: string; linkId: string }>();
  const navigate = useNavigate();
  const { showError } = useToast();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [link, setLink] = useState<CustomerProjectLink | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<CustomerProjectLinkStatus>('active');
  const [role, setRole] = useState('');
  const [notes, setNotes] = useState('');
  const [selectedEnvIds, setSelectedEnvIds] = useState<string[]>([]);

  useEffect(() => {
    if (!id || !linkId) return;
    api.customers
      .listProjectLinks(id)
      .then(async (links) => {
        const found = links.find((l) => l._id === linkId);
        if (!found) throw new Error('Link not found');
        const [customerData, projectData, envData] = await Promise.all([
          api.customers.get(id),
          api.projects.get(found.projectId),
          api.environments.list(found.projectId),
        ]);
        setCustomer(customerData);
        setLink(found);
        setProject(projectData);
        setEnvironments(envData);
        setStatus(found.status);
        setRole(found.role ?? '');
        setNotes(found.notes ?? '');
        setSelectedEnvIds(found.environmentIds);
      })
      .catch((err) => showError(err.message))
      .finally(() => setLoading(false));
  }, [id, linkId]);

  if (loading) return <LoadingText />;
  if (!customer || !link || !project || !id || !linkId) {
    return <p className="text-red-400">{t('customers.notFound')}</p>;
  }

  const toggleEnv = (envId: string) => {
    setSelectedEnvIds((current) =>
      current.includes(envId) ? current.filter((x) => x !== envId) : [...current, envId],
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.customers.updateProjectLink(id, linkId, {
        status,
        role: role.trim() || undefined,
        notes: notes.trim() || undefined,
        environmentIds: selectedEnvIds,
      });
      navigate(`/customers/${id}`);
    } catch (err: any) {
      showError(err.message || t('customers.linkSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <WorkflowPageShell
      backTo={`/customers/${id}`}
      backLabel={customer.name}
      title={`${t('customers.editLink')} — ${project.name}`}
    >
      <form onSubmit={handleSubmit} className="space-y-6">
        <FormSelect
          label={t('common.status')}
          value={status}
          onChange={(e) => setStatus(e.target.value as CustomerProjectLinkStatus)}
        >
          <option value="active">active</option>
          <option value="paused">paused</option>
          <option value="archived">archived</option>
        </FormSelect>

        <FormInput label={t('customers.projectRole')} value={role} onChange={(e) => setRole(e.target.value)} />

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
                <label
                  key={env._id}
                  className="flex items-center gap-2 p-2 bg-gray-900 border border-gray-800 rounded cursor-pointer hover:border-violet-700"
                >
                  <input
                    type="checkbox"
                    checked={selectedEnvIds.includes(env._id)}
                    onChange={() => toggleEnv(env._id)}
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
          <Button type="submit" variant="primary" size="lg" disabled={saving}>
            {saving ? t('common.saving') : t('common.save')}
          </Button>
          <Button type="button" size="lg" onClick={() => navigate(`/customers/${id}`)}>
            {t('common.cancel')}
          </Button>
        </div>
      </form>
    </WorkflowPageShell>
  );
}
