import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import { api, Todo, Milestone } from '../api/client';
import MarkdownEditor from '../components/MarkdownEditor';
import Button from '../components/ui/Button';
import { FormInput, FormSelect } from '../components/ui/FormField';

export default function TodoCreatePage() {
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<Todo['priority']>('medium');
  const [tags, setTags] = useState('');
  const [milestoneId, setMilestoneId] = useState(searchParams.get('milestoneId') || '');
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [saving, setSaving] = useState(false);
  const [newMilestoneName, setNewMilestoneName] = useState('');
  const [creatingMilestone, setCreatingMilestone] = useState(false);

  const loadMilestones = () => { if (id) api.milestones.list(id).then(setMilestones); };
  useEffect(() => { loadMilestones(); }, [id]);

  const handleCreateMilestone = async () => {
    if (!id || !newMilestoneName.trim()) return;
    const ms = await api.milestones.create({ projectId: id, name: newMilestoneName.trim() });
    setNewMilestoneName('');
    setCreatingMilestone(false);
    setMilestoneId(ms._id);
    loadMilestones();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id || !title.trim()) return;
    setSaving(true);
    try {
      await api.todos.create({
        projectId: id,
        title: title.trim(),
        description: description.trim() || undefined,
        priority,
        status: 'open',
        tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
        milestoneId: milestoneId || undefined,
      } as Partial<Todo> & { milestoneId?: string });
      navigate(`/projects/${id}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <Link to={`/projects/${id}`} className="text-sm text-gray-500 hover:text-gray-300 mb-6 inline-block">&larr; {t('todoDetail.backToProject')}</Link>

      <h1 className="text-xl font-bold mb-6">{t('todoCreate.title')}</h1>

      <form onSubmit={handleSubmit} className="max-w-3xl mx-auto space-y-4">
        <FormInput label={t('common.title')} required type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('common.title')} autoFocus />
        <div>
          <label className="block text-xs text-gray-500 mb-1">{t('common.description')}</label>
          <MarkdownEditor value={description} onChange={setDescription} rows={5} placeholder={t('todoCreate.descriptionPlaceholder')} />
        </div>
        <div className="flex flex-col sm:flex-row gap-4 items-start">
          <FormSelect label={t('common.priority')} value={priority} onChange={(e) => setPriority(e.target.value as Todo['priority'])}>
            <option value="low">{t('todoPriority.low')}</option>
            <option value="medium">{t('todoPriority.medium')}</option>
            <option value="high">{t('todoPriority.high')}</option>
            <option value="critical">{t('todoPriority.critical')}</option>
          </FormSelect>
          <div className="flex-1 w-full sm:w-auto">
            <label className="block text-xs text-gray-500 mb-1">{t('common.tags')}</label>
            <input type="text" value={tags} onChange={(e) => setTags(e.target.value)} placeholder={t('todoCreate.tagsPlaceholder')}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500" />
          </div>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">{t('todoCreate.milestone')}</label>
          <div className="flex flex-wrap items-center gap-2">
            <select value={milestoneId} onChange={(e) => setMilestoneId(e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500">
              <option value="">{t('todoCreate.noMilestone')}</option>
              {milestones.map((ms) => (
                <option key={ms._id} value={ms._id}>{ms.name}</option>
              ))}
            </select>
            {creatingMilestone ? (
              <div className="flex items-center gap-2">
                <input type="text" value={newMilestoneName} onChange={(e) => setNewMilestoneName(e.target.value)}
                  placeholder={t('common.name')} autoFocus onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), handleCreateMilestone())}
                  className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500" />
                <Button type="button" variant="primary" size="sm" disabled={!newMilestoneName.trim()} onClick={handleCreateMilestone}>
                  {t('common.create')}
                </Button>
                <Button type="button" size="sm" onClick={() => { setCreatingMilestone(false); setNewMilestoneName(''); }}>
                  {t('common.cancel')}
                </Button>
              </div>
            ) : (
              <Button type="button" size="sm" onClick={() => setCreatingMilestone(true)}>
                {t('todoCreate.newMilestone')}
              </Button>
            )}
          </div>
        </div>
        <div className="flex gap-2 pt-2">
          <Button type="submit" variant="primary" size="lg" disabled={saving || !title.trim()}>
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
