import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, Project } from '../api/client';
import { useDashboardEvents } from '../hooks/useProjectEvents';
import { useToast } from '../components/Toast';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import EmptyState from '../components/ui/EmptyState';
import { LoadingText } from '../components/ui/LoadingSpinner';

function ProjectCreateForm({ onCreated }: { onCreated: () => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [path, setPath] = useState('');
  const [repository, setRepository] = useState('');
  const [techStack, setTechStack] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      await api.projects.create({
        name: name.trim(),
        description: description.trim() || undefined,
        path: path.trim() || undefined,
        repository: repository.trim() || undefined,
        techStack: techStack.split(',').map((s) => s.trim()).filter(Boolean),
      });
      setName('');
      setDescription('');
      setPath('');
      setRepository('');
      setTechStack('');
      setOpen(false);
      onCreated();
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <Button type="button" variant="primary" size="lg" onClick={() => setOpen(true)} className="mb-6">
        {t('projects.newProject')}
      </Button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mb-6 bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-3 max-w-xl">
      <h3 className="text-sm font-semibold text-gray-300">{t('projects.createProject')}</h3>
      <input
        type="text"
        placeholder={t('projects.projectName')}
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500"
        autoFocus
      />
      <textarea
        placeholder={t('projects.descriptionOptional')}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={2}
        className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500 resize-none"
      />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <input
          type="text"
          placeholder={t('projects.pathOptional')}
          value={path}
          onChange={(e) => setPath(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500"
        />
        <input
          type="text"
          placeholder={t('projects.repositoryOptional')}
          value={repository}
          onChange={(e) => setRepository(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500"
        />
      </div>
      <input
        type="text"
        placeholder={t('projects.techStackHint')}
        value={techStack}
        onChange={(e) => setTechStack(e.target.value)}
        className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500"
      />
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={saving || !name.trim()}>
          {saving ? t('common.saving') : t('common.create')}
        </Button>
        <Button type="button" onClick={() => setOpen(false)}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}

export default function ProjectsOverview() {
  const { t, i18n } = useTranslation();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [importing, setImporting] = useState(false);
  const { showError } = useToast();
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadProjects = () => {
    api.projects
      .list()
      .then(setProjects)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  const toggleFavorite = async (e: React.MouseEvent, project: Project) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await api.projects.update(project._id, { favorite: !project.favorite });
      loadProjects();
    } catch (err: any) {
      showError(err.message || t('dashboard.favoriteError'));
    }
  };

  const filteredProjects = [...projects]
    .filter((p) => {
      if (!search.trim()) return true;
      const q = search.toLowerCase();
      return (
        p.name.toLowerCase().includes(q) ||
        p.description?.toLowerCase().includes(q) ||
        p.techStack.some((s) => s.toLowerCase().includes(q))
      );
    })
    .sort((a, b) => {
      if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });

  useEffect(() => {
    loadProjects();
  }, []);

  useDashboardEvents(() => loadProjects());

  const dateLocale = i18n.language === 'de' ? 'de-DE' : 'en-US';

  if (loading) return <LoadingText />;
  if (error) {
    return (
      <div className="bg-red-900/20 border border-red-800 rounded-lg p-4">
        <p className="text-red-400">{t('common.errorLoading', { error })}</p>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6 font-grimoire">{t('projects.overview')}</h1>
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-6">
        <ProjectCreateForm onCreated={loadProjects} />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={importing}
          className="px-3 py-1.5 text-sm bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg transition-colors disabled:opacity-50 whitespace-nowrap"
        >
          {importing ? t('projects.importing') : t('projects.importJson')}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          className="hidden"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            setImporting(true);
            try {
              const result = await api.transfer.import(file);
              loadProjects();
              navigate(`/projects/${result.projectId}`);
            } catch (err: any) {
              showError(err.message || t('projects.importFailed'));
            } finally {
              setImporting(false);
              e.target.value = '';
            }
          }}
        />
        <input
          type="text"
          placeholder={t('projects.searchProjects')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500 w-full sm:w-64"
        />
      </div>
      {projects.length === 0 ? (
        <EmptyState message={t('projects.noProjects')} />
      ) : filteredProjects.length === 0 ? (
        <EmptyState message={t('projects.noProjectsFound', { search })} />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredProjects.map((p) => (
            <Link
              key={p._id}
              to={`/projects/${p._id}`}
              className="block bg-gray-900 border border-gray-800 rounded-lg p-5 hover:border-violet-500 transition-colors"
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={(e) => toggleFavorite(e, p)}
                    className={`text-lg leading-none transition-colors ${
                      p.favorite
                        ? 'text-yellow-400 hover:text-yellow-300'
                        : 'text-gray-700 hover:text-yellow-400'
                    }`}
                    title={p.favorite ? t('projects.removeFavorite') : t('projects.addFavorite')}
                    aria-label={p.favorite ? t('projects.removeFavorite') : t('projects.addFavorite')}
                  >
                    {p.favorite ? '\u2605' : '\u2606'}
                  </button>
                  <h2 className="text-lg font-semibold">{p.name}</h2>
                </div>
                <Badge color={p.active ? 'bg-green-900 text-green-300' : 'bg-gray-800 text-gray-500'} rounded="full">
                  {p.active ? t('common.active') : t('common.inactive')}
                </Badge>
              </div>
              {p.description && (
                <p className="text-sm text-gray-400 mb-3 line-clamp-2">
                  {p.description}
                </p>
              )}
              {p.techStack.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {p.techStack.map((tech) => (
                    <Badge key={tech} color="bg-gray-800 text-gray-300">
                      {tech}
                    </Badge>
                  ))}
                </div>
              )}
              <p className="text-xs text-gray-600 mt-3">
                {t('common.created')}: {new Date(p.createdAt).toLocaleDateString(dateLocale)}
                {' · '}
                {t('common.updated')}: {new Date(p.updatedAt).toLocaleDateString(dateLocale)}
              </p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
