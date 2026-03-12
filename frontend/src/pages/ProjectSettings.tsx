import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, Project } from '../api/client';
import Button from '../components/ui/Button';
import ConfirmButton from '../components/ui/ConfirmButton';
import { LoadingText } from '../components/ui/LoadingSpinner';

const TEMPLATE_INSTRUCTIONS = `## Arbeitsweise
1. Immer erst Planen und einen Überblick verschaffen
2. Plan mit dem Nutzer abstimmen
3. Plan implementieren
4. Code Review durchführen
5. Tests schreiben/ausführen
6. Ergebnisse dokumentieren

## Konventionen
- Commit-Messages auf Deutsch
- TypeScript strict mode
- Keine \`any\` Typen
- JSDoc für öffentliche Methoden

## Prioritäten
- Sicherheit vor Features
- Lesbarkeit vor Kürze
- Einfachheit vor Abstraktion`;

export default function ProjectSettings() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [path, setPath] = useState('');
  const [repository, setRepository] = useState('');
  const [techStack, setTechStack] = useState('');
  const [active, setActive] = useState(true);
  const [instructions, setInstructions] = useState('');
  const [todoNumberFormat, setTodoNumberFormat] = useState('{type}-{n}');
  const [milestoneNumberFormat, setMilestoneNumberFormat] = useState('{type}-{n}');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [includeSecrets, setIncludeSecrets] = useState(false);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    api.projects
      .get(id)
      .then((p) => {
        setProject(p);
        setName(p.name);
        setDescription(p.description || '');
        setPath(p.path || '');
        setRepository(p.repository || '');
        setTechStack(p.techStack.join(', '));
        setActive(p.active);
        setInstructions(p.instructions || '');
        setTodoNumberFormat(p.todoNumberFormat || '{type}-{n}');
        setMilestoneNumberFormat(p.milestoneNumberFormat || '{type}-{n}');
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [id]);

  const handleSave = async () => {
    if (!id || !name.trim()) return;
    setSaving(true);
    setSaved(false);
    try {
      const updated = await api.projects.update(id, {
        name: name.trim(),
        description: description.trim() || undefined,
        path: path.trim() || undefined,
        repository: repository.trim() || undefined,
        techStack: techStack.split(',').map((t) => t.trim()).filter(Boolean),
        active,
        instructions,
        todoNumberFormat,
        milestoneNumberFormat,
      });
      setProject(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.errorSaving'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <LoadingText />;
  if (error) {
    return (
      <div>
        <Link to="/" className="text-sm text-gray-500 hover:text-gray-300 mb-4 inline-block">
          &larr; {t('common.allProjects')}
        </Link>
        <div className="bg-red-900/20 border border-red-800 rounded-lg p-4">
          <p className="text-red-400">{t('common.error')}: {error}</p>
        </div>
      </div>
    );
  }
  if (!project) return <p className="text-red-400">{t('projects.notFound')}</p>;

  return (
    <div className="max-w-4xl mx-auto">
      <Link
        to={`/projects/${id}`}
        className="text-sm text-gray-500 hover:text-gray-300 mb-4 inline-block"
      >
        &larr; {project.name}
      </Link>

      <div className="mb-8">
        <h1 className="text-2xl font-bold mb-1">{t('projectSettings.title')}</h1>
        <p className="text-gray-400 text-sm">{project.name}</p>
      </div>

      <section className="mb-8 space-y-4">
        <h2 className="text-lg font-semibold text-cyan-400">{t('projectSettings.projectData')}</h2>

        <div>
          <label className="block text-xs text-gray-500 mb-1">{t('common.name')} *</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full bg-gray-900 border border-gray-800 rounded-lg px-4 py-2 text-sm text-gray-200 focus:outline-none focus:border-violet-500"
          />
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-1">{t('common.description')}</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="w-full bg-gray-900 border border-gray-800 rounded-lg px-4 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500 resize-none"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-gray-500 mb-1">{t('projects.path')}</label>
            <input
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/home/user/project"
              className="w-full bg-gray-900 border border-gray-800 rounded-lg px-4 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">{t('projectSettings.repository')}</label>
            <input
              type="text"
              value={repository}
              onChange={(e) => setRepository(e.target.value)}
              placeholder="https://github.com/..."
              className="w-full bg-gray-900 border border-gray-800 rounded-lg px-4 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500"
            />
          </div>
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-1">{t('projectSettings.techStack')}</label>
          <input
            type="text"
            value={techStack}
            onChange={(e) => setTechStack(e.target.value)}
            placeholder="React, Node.js, MongoDB"
            className="w-full bg-gray-900 border border-gray-800 rounded-lg px-4 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500"
          />
        </div>

        <div className="flex items-center gap-3">
          <label className="text-xs text-gray-500">{t('common.status')}:</label>
          <button
            type="button"
            onClick={() => setActive(!active)}
            className={`text-xs px-3 py-1 rounded-full transition-colors ${
              active
                ? 'bg-green-900 text-green-300 hover:bg-green-800'
                : 'bg-gray-800 text-gray-500 hover:bg-gray-700'
            }`}
          >
            {active ? t('common.active') : t('common.inactive')}
          </button>
        </div>
      </section>

      <section className="mb-8 space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-cyan-400">{t('projectSettings.numbering')}</h2>
          <p className="text-gray-500 text-sm mt-1">
            {t('projectSettings.numberingHelp')}{' '}
            <code className="text-gray-400 bg-gray-800 px-1 py-0.5 rounded text-xs">{'{n}'}</code> {t('projectSettings.numberVar')},{' '}
            <code className="text-gray-400 bg-gray-800 px-1 py-0.5 rounded text-xs">{'{type}'}</code> {t('projectSettings.typeVar')},{' '}
            <code className="text-gray-400 bg-gray-800 px-1 py-0.5 rounded text-xs">{'{prefix}'}</code> {t('projectSettings.prefixVar')},{' '}
            <code className="text-gray-400 bg-gray-800 px-1 py-0.5 rounded text-xs">{'{date}'}</code> {t('projectSettings.dateVar')}
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-gray-500 mb-1">{t('projectSettings.taskFormat')}</label>
            <input
              type="text"
              value={todoNumberFormat}
              onChange={(e) => setTodoNumberFormat(e.target.value)}
              placeholder="{type}-{n}"
              className="w-full bg-gray-900 border border-gray-800 rounded-lg px-4 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500 font-mono"
            />
            <p className="text-xs text-gray-600 mt-1">
              {t('projectSettings.preview')}: {todoNumberFormat.replace(/\{n\}/g, '42').replace(/\{type\}/g, 'T').replace(/\{prefix\}/g, name).replace(/\{date\}/g, new Date().toISOString().slice(0, 10))}
            </p>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">{t('projectSettings.milestoneFormat')}</label>
            <input
              type="text"
              value={milestoneNumberFormat}
              onChange={(e) => setMilestoneNumberFormat(e.target.value)}
              placeholder="{type}-{n}"
              className="w-full bg-gray-900 border border-gray-800 rounded-lg px-4 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500 font-mono"
            />
            <p className="text-xs text-gray-600 mt-1">
              {t('projectSettings.preview')}: {milestoneNumberFormat.replace(/\{n\}/g, '5').replace(/\{type\}/g, 'M').replace(/\{prefix\}/g, name).replace(/\{date\}/g, new Date().toISOString().slice(0, 10))}
            </p>
          </div>
        </div>
      </section>

      <section className="mb-8">
        <div className="mb-3">
          <h2 className="text-lg font-semibold text-cyan-400">
            {t('projectSettings.instructions')}
          </h2>
          <p className="text-gray-500 text-sm mt-1">
            {t('projectSettings.instructionsHelp')}
          </p>
        </div>

        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          rows={16}
          placeholder={t('projectSettings.instructionsPlaceholder')}
          className="w-full bg-gray-900 border border-gray-800 rounded-lg px-4 py-3 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500 resize-y font-mono leading-relaxed"
        />

        {!instructions.trim() && (
          <Button type="button" className="mt-2" onClick={() => setInstructions(TEMPLATE_INSTRUCTIONS)}>
            {t('projectSettings.insertTemplate')}
          </Button>
        )}
      </section>

      <div className="flex items-center gap-3 mb-8">
        <Button type="button" variant="primary" size="lg" onClick={handleSave} disabled={saving || !name.trim()}>
          {saving ? t('common.saving') : t('projectSettings.saveAll')}
        </Button>
        {saved && (
          <span className="text-sm text-green-400">{t('common.saved')}</span>
        )}
      </div>

      <section className="border-t border-gray-800 pt-6 mb-8">
        <h2 className="text-lg font-semibold text-cyan-400 mb-2">{t('projectSettings.dataExport')}</h2>
        <p className="text-gray-500 text-sm mb-3">
          {t('projectSettings.dataExportHelp')}
        </p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={async () => {
              try {
                await api.transfer.export(id!, includeSecrets);
              } catch (err) {
                setError(err instanceof Error ? err.message : t('projectSettings.exportFailed'));
              }
            }}
            className="px-3 py-1.5 text-sm bg-violet-600 hover:bg-violet-500 text-white rounded-lg transition-colors"
          >
            {t('projectSettings.exportProject')}
          </button>
          <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
            <input
              type="checkbox"
              checked={includeSecrets}
              onChange={(e) => setIncludeSecrets(e.target.checked)}
              className="rounded border-gray-600 bg-gray-800 text-violet-500 focus:ring-violet-500"
            />
            {t('projectSettings.includeSecrets')}
          </label>
        </div>
      </section>

      <section className="border-t border-gray-800 pt-6 mb-8">
        <h2 className="text-lg font-semibold text-red-400 mb-2">{t('projectSettings.dangerZone')}</h2>
        <p className="text-gray-500 text-sm mb-3">
          {t('projectSettings.dangerZoneHelp')}
        </p>
        <ConfirmButton onConfirm={async () => { if (id) { await api.projects.delete(id); navigate('/'); } }} label={t('projectSettings.deleteProject')} confirmLabel={t('projectSettings.confirmDeleteProject')} size="lg" />
      </section>

      <section className="bg-gray-900/50 border border-gray-800 rounded-lg p-4">
        <h3 className="text-sm font-medium text-gray-300 mb-2">
          {t('projectSettings.instructionsInfoTitle')}
        </h3>
        <p className="text-gray-500 text-sm leading-relaxed">
          {t('projectSettings.instructionsInfoText', { tool: 'project_get', file: 'CLAUDE.md' })}
        </p>
      </section>
    </div>
  );
}
