import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, Customer, CustomerStatus } from '../api/client';
import { useToast } from '../components/Toast';
import Button from '../components/ui/Button';
import { FormInput, FormSelect, FormTextarea } from '../components/ui/FormField';
import { WorkflowPageShell } from '../components/ui/WorkflowShell';
import { LoadingText } from '../components/ui/LoadingSpinner';

export default function CustomerEditPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { showError } = useToast();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<CustomerStatus>('active');
  const [tags, setTags] = useState('');
  const [primaryContactName, setPrimaryContactName] = useState('');
  const [primaryContactEmail, setPrimaryContactEmail] = useState('');
  const [primaryContactPhone, setPrimaryContactPhone] = useState('');
  const [website, setWebsite] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!id) return;
    api.customers
      .get(id)
      .then((data) => {
        setCustomer(data);
        setName(data.name);
        setDescription(data.description ?? '');
        setStatus(data.status);
        setTags(data.tags.join(', '));
        setPrimaryContactName(data.primaryContactName ?? '');
        setPrimaryContactEmail(data.primaryContactEmail ?? '');
        setPrimaryContactPhone(data.primaryContactPhone ?? '');
        setWebsite(data.website ?? '');
        setNotes(data.notes ?? '');
      })
      .catch((err) => showError(err.message))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <LoadingText />;
  if (!customer || !id) return <p className="text-red-400">{t('customers.notFound')}</p>;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      await api.customers.update(id, {
        name: name.trim(),
        description: description.trim() || undefined,
        status,
        tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
        primaryContactName: primaryContactName.trim() || undefined,
        primaryContactEmail: primaryContactEmail.trim() || undefined,
        primaryContactPhone: primaryContactPhone.trim() || undefined,
        website: website.trim() || undefined,
        notes: notes.trim() || undefined,
      });
      navigate(`/customers/${id}`);
    } catch (err: any) {
      showError(err.message || t('customers.updateFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <WorkflowPageShell
      backTo={`/customers/${id}`}
      backLabel={customer.name}
      title={t('customers.editCustomer')}
    >
      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <FormInput
            label={t('customers.customerName')}
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            fieldClassName="sm:col-span-2"
          />
          <FormSelect label={t('common.status')} value={status} onChange={(e) => setStatus(e.target.value as CustomerStatus)}>
            <option value="lead">{t('customers.status.lead')}</option>
            <option value="onboarding">{t('customers.status.onboarding')}</option>
            <option value="active">{t('customers.status.active')}</option>
            <option value="paused">{t('customers.status.paused')}</option>
            <option value="offboarding">{t('customers.status.offboarding')}</option>
            <option value="cancelled">{t('customers.status.cancelled')}</option>
            <option value="archived">{t('customers.status.archived')}</option>
          </FormSelect>
          <FormInput
            label={t('common.tags')}
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder={t('customers.tagsHint')}
          />
        </div>

        <FormTextarea
          label={t('common.description')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          placeholder={t('customers.descriptionOptional')}
        />

        <div>
          <h2 className="text-sm font-medium text-gray-400 mb-3">{t('customers.contactData')}</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <FormInput
              label={t('customers.primaryContact')}
              value={primaryContactName}
              onChange={(e) => setPrimaryContactName(e.target.value)}
            />
            <FormInput
              label={t('customers.primaryContactEmail')}
              type="email"
              value={primaryContactEmail}
              onChange={(e) => setPrimaryContactEmail(e.target.value)}
            />
            <FormInput
              label={t('customers.primaryContactPhone')}
              value={primaryContactPhone}
              onChange={(e) => setPrimaryContactPhone(e.target.value)}
            />
            <FormInput
              label={t('customers.website')}
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              placeholder="https://example.com"
            />
          </div>
        </div>

        <FormTextarea
          label={t('customers.customerFile')}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={5}
          placeholder={t('customers.notesPlaceholder')}
        />

        <div className="flex gap-2 pt-2">
          <Button type="submit" variant="primary" size="lg" disabled={saving || !name.trim()}>
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
