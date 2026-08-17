import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, Customer } from '../api/client';
import { useToast } from '../components/Toast';
import Button from '../components/ui/Button';
import { FormInput, FormTextarea } from '../components/ui/FormField';
import { WorkflowPageShell } from '../components/ui/WorkflowShell';
import { LoadingText } from '../components/ui/LoadingSpinner';
import { errorMessage } from '../lib/narrow';

export default function ContactCreatePage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { showError } = useToast();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [isPrimary, setIsPrimary] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!id) return;
    api.customers
      .get(id)
      .then(setCustomer)
      .catch((err: unknown) => showError(errorMessage(err)))
      .finally(() => setLoading(false));
  }, [id, showError]);

  if (loading) return <LoadingText />;
  if (!customer || !id) return <p className="text-red-400">{t('customers.notFound')}</p>;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      await api.contacts.create(id, {
        name: name.trim(),
        role: role.trim() || undefined,
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
        notes: notes.trim() || undefined,
        isPrimary,
      });
      await navigate(`/customers/${id}`);
    } catch (err) {
      showError(errorMessage(err) || t('contacts.createFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <WorkflowPageShell
      backTo={`/customers/${id}`}
      backLabel={customer.name}
      title={t('contacts.createContact')}
    >
      <form onSubmit={(e) => { void handleSubmit(e); }} className="space-y-6">
        <FormInput
          label={t('contacts.name')}
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
        <FormInput
          label={t('contacts.role')}
          value={role}
          onChange={(e) => setRole(e.target.value)}
          placeholder={t('contacts.rolePlaceholder')}
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <FormInput
            label={t('contacts.email')}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <FormInput
            label={t('contacts.phone')}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </div>
        <FormTextarea
          label={t('contacts.notes')}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
        />
        <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
          <input
            type="checkbox"
            checked={isPrimary}
            onChange={(e) => setIsPrimary(e.target.checked)}
            className="accent-violet-500"
          />
          {t('contacts.markPrimary')}
        </label>
        <div className="flex gap-2 pt-2">
          <Button type="submit" variant="primary" size="lg" disabled={saving || !name.trim()}>
            {saving ? t('common.creating') : t('contacts.createContactAction')}
          </Button>
          <Button type="button" size="lg" onClick={() => { void navigate(`/customers/${id}`); }}>
            {t('common.cancel')}
          </Button>
        </div>
      </form>
    </WorkflowPageShell>
  );
}
