import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, Contact, Customer } from '../api/client';
import { useToast } from '../components/Toast';
import Button from '../components/ui/Button';
import { FormInput, FormTextarea } from '../components/ui/FormField';
import { WorkflowPageShell } from '../components/ui/WorkflowShell';
import { LoadingText } from '../components/ui/LoadingSpinner';

export default function ContactEditPage() {
  const { t } = useTranslation();
  const { id, contactId } = useParams<{ id: string; contactId: string }>();
  const navigate = useNavigate();
  const { showError } = useToast();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [contact, setContact] = useState<Contact | null>(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [isPrimary, setIsPrimary] = useState(false);
  const [sortOrder, setSortOrder] = useState('0');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!id || !contactId) return;
    Promise.all([api.customers.get(id), api.contacts.get(id, contactId)])
      .then(([customerData, contactData]) => {
        setCustomer(customerData);
        setContact(contactData);
        setName(contactData.name);
        setRole(contactData.role ?? '');
        setEmail(contactData.email ?? '');
        setPhone(contactData.phone ?? '');
        setNotes(contactData.notes ?? '');
        setIsPrimary(contactData.isPrimary);
        setSortOrder(String(contactData.sortOrder ?? 0));
      })
      .catch((err) => showError(err.message))
      .finally(() => setLoading(false));
  }, [id, contactId]);

  if (loading) return <LoadingText />;
  if (!customer || !contact || !id || !contactId) {
    return <p className="text-red-400">{t('contacts.notFound')}</p>;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      await api.contacts.update(id, contactId, {
        name: name.trim(),
        role: role.trim() || undefined,
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
        notes: notes.trim() || undefined,
        isPrimary,
        sortOrder: Number.parseInt(sortOrder, 10) || 0,
      });
      navigate(`/customers/${id}`);
    } catch (err: any) {
      showError(err.message || t('contacts.updateFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <WorkflowPageShell
      backTo={`/customers/${id}`}
      backLabel={customer.name}
      title={`${t('contacts.editContact')} — ${contact.name}`}
    >
      <form onSubmit={handleSubmit} className="space-y-6">
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
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
            <input
              type="checkbox"
              checked={isPrimary}
              onChange={(e) => setIsPrimary(e.target.checked)}
              className="accent-violet-500"
            />
            {t('contacts.markPrimary')}
          </label>
          <FormInput
            label={t('contacts.sortOrder')}
            type="number"
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value)}
            fieldClassName="sm:max-w-[10rem]"
          />
        </div>
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
