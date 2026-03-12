import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import Button from '../components/ui/Button';
import { FormInput, FormTextarea } from '../components/ui/FormField';

export default function MilestoneCreatePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id || !name.trim()) return;
    setSaving(true);
    try {
      await api.milestones.create({
        projectId: id,
        name: name.trim(),
        description: description.trim() || undefined,
        dueDate: dueDate || undefined,
      });
      navigate(`/projects/${id}?tab=milestones`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <Link to={`/projects/${id}`} className="text-sm text-gray-500 hover:text-gray-300 mb-6 inline-block">&larr; {t('milestoneCreate.backToProject')}</Link>

      <h1 className="text-xl font-bold mb-6">{t('milestoneCreate.title')}</h1>

      <form onSubmit={handleSubmit} className="max-w-3xl mx-auto space-y-4">
        <FormInput label={t('common.name')} required type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('common.name')} autoFocus />
        <FormTextarea label={t('common.description')} value={description} onChange={(e) => setDescription(e.target.value)} rows={4} placeholder={t('common.description')} />
        <FormInput label={t('milestoneCreate.dueDate')} type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        <div className="flex gap-2 pt-2">
          <Button type="submit" variant="primary" size="lg" disabled={saving || !name.trim()}>
            {saving ? t('common.creating') : t('common.create')}
          </Button>
          <Button type="button" size="lg" onClick={() => navigate(`/projects/${id}`)}>
            {t('common.cancel')}
          </Button>
        </div>
      </form>
    </div>
  );
}
