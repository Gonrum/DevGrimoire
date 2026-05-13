import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import { useToast } from '../components/Toast';
import Button from '../components/ui/Button';
import { FormInput, FormTextarea } from '../components/ui/FormField';
import { WorkflowPageShell } from '../components/ui/WorkflowShell';
import TagInput from '../components/ui/TagInput';

export default function ProjectCreatePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { showError } = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [path, setPath] = useState('');
  const [repository, setRepository] = useState('');
  const [techStack, setTechStack] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.projects
      .listTags()
      .then((rows) => setTagSuggestions(rows.map((r) => r.name)))
      .catch(() => setTagSuggestions([]));
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      const project = await api.projects.create({
        name: name.trim(),
        description: description.trim() || undefined,
        path: path.trim() || undefined,
        repository: repository.trim() || undefined,
        techStack: techStack.split(',').map((s) => s.trim()).filter(Boolean),
        tags,
      });
      navigate(`/projects/${project._id}`);
    } catch (err: any) {
      showError(err.message || t('projects.createFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <WorkflowPageShell backTo="/projects" backLabel={t('common.allProjects')} title={t('projects.createProject')}>
      <form onSubmit={handleSubmit} className="space-y-6">
        <FormInput
          label={t('projects.projectName')}
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
        <FormTextarea
          label={t('common.description')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          placeholder={t('projects.descriptionOptional')}
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <FormInput
            label={t('projects.path')}
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder={t('projects.pathOptional')}
            className="font-mono"
          />
          <FormInput
            label={t('projects.repo')}
            value={repository}
            onChange={(e) => setRepository(e.target.value)}
            placeholder={t('projects.repositoryOptional')}
          />
        </div>
        <FormInput
          label="Tech Stack"
          value={techStack}
          onChange={(e) => setTechStack(e.target.value)}
          placeholder={t('projects.techStackHint')}
        />
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1.5">{t('projects.tagsLabel')}</label>
          <TagInput
            value={tags}
            onChange={setTags}
            suggestions={tagSuggestions}
            placeholder={t('projects.tagsPlaceholder')}
          />
        </div>
        <div className="flex gap-2 pt-2">
          <Button type="submit" variant="primary" size="lg" disabled={saving || !name.trim()}>
            {saving ? t('common.creating') : t('projects.createProjectAction')}
          </Button>
          <Button type="button" size="lg" onClick={() => navigate('/projects')}>
            {t('common.cancel')}
          </Button>
        </div>
      </form>
    </WorkflowPageShell>
  );
}
