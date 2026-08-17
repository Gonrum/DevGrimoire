import { FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, Milestone } from '../api/client';
import { errorMessage } from '../lib/narrow';
import MarkdownEditor from './MarkdownEditor';
import Button from './ui/Button';
import { FormInput } from './ui/FormField';

interface MilestoneFormProps {
  projectId: string;
  milestone?: Milestone;
  submitLabel?: string;
  savingLabel?: string;
  submitSize?: 'md' | 'lg';
  className?: string;
  onSaved: (milestone: Milestone) => void;
  onCancel: () => void;
}

export default function MilestoneForm({
  projectId,
  milestone,
  submitLabel,
  savingLabel,
  submitSize = 'lg',
  className = '',
  onSaved,
  onCancel,
}: MilestoneFormProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(milestone?.name || '');
  const [description, setDescription] = useState(milestone?.description || '');
  const [dueDate, setDueDate] = useState(milestone?.dueDate ? milestone.dueDate.slice(0, 10) : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Vorher lief der Fehlerfall komplett ins Leere: nur ein `finally`, kein
   * `catch`. Ein abgelehntes `api.milestones.create` (Validierung, 403, Netz)
   * setzte `saving` zurück und sonst nichts — für den Nutzer sah das aus wie
   * „Button gedrückt, nichts passiert".
   */
  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: name.trim(),
        description: description.trim() || undefined,
        dueDate: dueDate || undefined,
      };
      const saved = milestone
        ? await api.milestones.update(milestone._id, payload)
        : await api.milestones.create({ projectId, ...payload });
      onSaved(saved);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        void handleSubmit(e);
      }}
      className={`space-y-5 ${className}`}
    >
      {error && (
        <div className="bg-red-900/20 border border-red-800 rounded px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      )}
      <FormInput label={t('common.name')} required type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('common.name')} autoFocus />
      <div>
        <label className="block text-xs text-gray-500 mb-1">{t('common.description')}</label>
        <MarkdownEditor value={description} onChange={setDescription} rows={4} placeholder={t('common.description')} />
      </div>
      <FormInput fieldClassName="max-w-xs" label={t('milestoneCreate.dueDate')} type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
      <div className="flex flex-wrap gap-2 pt-2">
        <Button type="submit" variant="primary" size={submitSize} disabled={saving || !name.trim()}>
          {saving ? (savingLabel || t('common.saving')) : (submitLabel || t('common.save'))}
        </Button>
        <Button type="button" size={submitSize} onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}
