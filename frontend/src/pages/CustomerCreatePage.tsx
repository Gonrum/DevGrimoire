import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, CustomerStatus } from '../api/client';
import { useToast } from '../components/Toast';
import Button from '../components/ui/Button';
import { FormInput, FormSelect, FormTextarea } from '../components/ui/FormField';
import { WorkflowPageShell } from '../components/ui/WorkflowShell';
import { errorMessage, optionOr } from '../lib/narrow';

/**
 * Die Statuswerte als Laufzeit-Liste. `CustomerStatus` allein ist nur ein Typ;
 * `e.target.value as CustomerStatus` hätte behauptet, was `HTMLSelectElement`
 * nicht garantiert (`value` ist `string`). Mit der Liste wird geprüft.
 */
const CUSTOMER_STATUSES: readonly CustomerStatus[] = [
  'lead', 'onboarding', 'active', 'paused', 'offboarding', 'cancelled', 'archived',
];

export default function CustomerCreatePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { showError } = useToast();
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      const customer = await api.customers.create({
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
      await navigate(`/customers/${customer._id}`);
    } catch (err) {
      showError(errorMessage(err) || t('customers.createFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <WorkflowPageShell backTo="/customers" backLabel={t('customers.allCustomers')} title={t('customers.createCustomer')}>
      <form onSubmit={(e) => { void handleSubmit(e); }} className="space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <FormInput
            label={t('customers.customerName')}
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            fieldClassName="sm:col-span-2"
          />
          <FormSelect label={t('common.status')} value={status} onChange={(e) => setStatus(optionOr(e.target.value, CUSTOMER_STATUSES, 'active'))}>
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
            {saving ? t('common.creating') : t('customers.createCustomerAction')}
          </Button>
          <Button type="button" size="lg" onClick={() => { void navigate('/customers'); }}>
            {t('common.cancel')}
          </Button>
        </div>
      </form>
    </WorkflowPageShell>
  );
}
