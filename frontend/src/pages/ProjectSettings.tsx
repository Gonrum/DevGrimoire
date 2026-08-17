import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, Project, GitRepository } from '../api/client';
import Button from '../components/ui/Button';
import ConfirmButton from '../components/ui/ConfirmButton';
import { FormInput, FormTextarea } from '../components/ui/FormField';
import { LoadingText } from '../components/ui/LoadingSpinner';
import { SettingsSection, SettingsShell } from '../components/ui/SettingsShell';
import ProjectGitRepositorySettings from '../components/settings/ProjectGitRepositorySettings';
import TagInput from '../components/ui/TagInput';
import { errorMessage } from '../lib/narrow';

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
  const [tags, setTags] = useState<string[]>([]);
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([]);
  const [active, setActive] = useState(true);
  const [instructions, setInstructions] = useState('');
  const [todoNumberFormat, setTodoNumberFormat] = useState('{type}-{n}');
  const [milestoneNumberFormat, setMilestoneNumberFormat] = useState('{type}-{n}');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [includeSecrets, setIncludeSecrets] = useState(false);
  type ProjectSettingsTab = 'general' | 'instructions' | 'git' | 'export' | 'danger';
  const [tab, setTab] = useState<ProjectSettingsTab>('general');
  const [gitRepos, setGitRepos] = useState<GitRepository[]>([]);

  /*
   * Cleanup markiert einen laufenden Ladevorgang als veraltet: bei einem
   * Projektwechsel überschrieb sonst die spätere Antwort des alten Projekts das
   * Formular des neuen — inklusive einer bereits begonnenen Eingabe.
   */
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    async function run(projectId: string) {
      setLoading(true);
      try {
        const p = await api.projects.get(projectId);
        if (cancelled) return;
        setProject(p);
        setName(p.name);
        setDescription(p.description || '');
        setPath(p.path || '');
        setRepository(p.repository || '');
        setTechStack(p.techStack.join(', '));
        setTags(p.tags ?? []);
        setActive(p.active);
        setInstructions(p.instructions || '');
        setTodoNumberFormat(p.todoNumberFormat || '{type}-{n}');
        setMilestoneNumberFormat(p.milestoneNumberFormat || '{type}-{n}');
        setGitRepos(p.gitRepositories || []);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void run(id);
    api.projects
      .listTags()
      .then((rows) => { if (!cancelled) setTagSuggestions(rows.map((r) => r.name)); })
      .catch(() => { if (!cancelled) setTagSuggestions([]); });
    return () => { cancelled = true; };
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
        tags,
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

  const handleExport = async () => {
    if (!id) return;
    try {
      await api.transfer.export(id, includeSecrets);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('projectSettings.exportFailed'));
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

  const projectTabs: { key: ProjectSettingsTab; label: string; group?: string }[] = [
    { key: 'general', label: t('projectSettings.tabGeneral') },
    { key: 'instructions', label: t('projectSettings.tabInstructions') },
    { key: 'git', label: t('projectSettings.tabGit') },
    { key: 'export', label: t('projectSettings.tabExport'), group: t('projectSettings.groupAdvanced') },
    { key: 'danger', label: t('projectSettings.tabDanger'), group: t('projectSettings.groupAdvanced') },
  ];

  const showSaveBar = tab === 'general' || tab === 'instructions' || tab === 'git';

  return (
    <SettingsShell
      title={t('projectSettings.title')}
      tabs={projectTabs}
      activeTab={tab}
      onTabChange={setTab}
    >
      <Link
        to={`/projects/${id}`}
        className="text-sm text-gray-500 hover:text-gray-300 mb-4 inline-block"
      >
        &larr; {project.name}
      </Link>

      <p className="mb-6 text-sm text-gray-400">{project.name}</p>

      {tab === 'general' && (<>
      <section className="mb-8 space-y-4">
        <h2 className="text-lg font-semibold text-cyan-400">{t('projectSettings.projectData')}</h2>

        <FormInput
          label={t('common.name')}
          required
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        <FormTextarea
          label={t('common.description')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
        />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <FormInput
            label={t('projects.path')}
            type="text"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/home/user/project"
          />
          <FormInput
            label={t('projectSettings.repository')}
            type="text"
            value={repository}
            onChange={(e) => setRepository(e.target.value)}
            placeholder="https://github.com/..."
          />
        </div>

        <FormInput
          label={t('projectSettings.techStack')}
          type="text"
          value={techStack}
          onChange={(e) => setTechStack(e.target.value)}
          placeholder="React, Node.js, MongoDB"
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
            <FormInput
              label={t('projectSettings.taskFormat')}
              type="text"
              value={todoNumberFormat}
              onChange={(e) => setTodoNumberFormat(e.target.value)}
              placeholder="{type}-{n}"
              className="font-mono"
            />
            <p className="text-xs text-gray-600 mt-1">
              {t('projectSettings.preview')}: {todoNumberFormat.replace(/\{n\}/g, '42').replace(/\{type\}/g, 'T').replace(/\{prefix\}/g, name).replace(/\{date\}/g, new Date().toISOString().slice(0, 10))}
            </p>
          </div>
          <div>
            <FormInput
              label={t('projectSettings.milestoneFormat')}
              type="text"
              value={milestoneNumberFormat}
              onChange={(e) => setMilestoneNumberFormat(e.target.value)}
              placeholder="{type}-{n}"
              className="font-mono"
            />
            <p className="text-xs text-gray-600 mt-1">
              {t('projectSettings.preview')}: {milestoneNumberFormat.replace(/\{n\}/g, '5').replace(/\{type\}/g, 'M').replace(/\{prefix\}/g, name).replace(/\{date\}/g, new Date().toISOString().slice(0, 10))}
            </p>
          </div>
        </div>
      </section>
      </>)}

      {tab === 'instructions' && (
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
      )}

      {tab === 'git' && id && (
        <ProjectGitRepositorySettings projectId={id} gitRepos={gitRepos} onChange={setGitRepos} />
      )}

      {showSaveBar && tab !== 'git' && (
        <div className="sticky bottom-0 z-10 -mx-4 mb-8 flex items-center gap-3 border-t border-gray-800 bg-gray-950/95 px-4 py-3 backdrop-blur md:-mx-0 md:rounded-lg md:border md:bg-gray-900/80">
          <Button type="button" variant="primary" size="lg" onClick={() => { void handleSave(); }} disabled={saving || !name.trim()}>
            {saving ? t('common.saving') : t('projectSettings.saveAll')}
          </Button>
          {saved && (
            <span className="text-sm text-green-400">{t('common.saved')}</span>
          )}
        </div>
      )}

      {tab === 'export' && <>
      <SettingsSection
        tone="accent"
        title={t('projectSettings.dataExport')}
        description={t('projectSettings.dataExportHelp')}
        className="mb-8"
      >
        <label className="mb-3 flex items-start gap-2 cursor-pointer text-sm text-gray-300">
          <input
            type="checkbox"
            checked={includeSecrets}
            onChange={(e) => setIncludeSecrets(e.target.checked)}
            className="mt-0.5 rounded border-gray-600 bg-gray-800 text-violet-500 focus:ring-violet-500"
          />
          <span>{t('projectSettings.includeSecrets')}</span>
        </label>
        {includeSecrets && (
          <div className="mb-3 rounded-lg border-2 border-amber-700 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
            ⚠ {t('projectSettings.includeSecretsWarning')}
          </div>
        )}
        <Button
          variant="primary"
          onClick={() => { void handleExport(); }}
        >
          {t('projectSettings.exportProject')}
        </Button>
      </SettingsSection>

      <SettingsSection title={t('projectSettings.instructionsInfoTitle')}>
        <p className="text-gray-500 text-sm leading-relaxed">
          {t('projectSettings.instructionsInfoText', { tool: 'project_get', file: 'CLAUDE.md' })}
        </p>
      </SettingsSection>
      </>}

      {tab === 'danger' && (
        <SettingsSection
          tone="danger"
          title={t('projectSettings.dangerZone')}
          description={t('projectSettings.dangerZoneHelp')}
          className="mb-8"
        >
          <div className="mb-3 rounded-lg border-2 border-red-800/60 bg-red-950/40 px-3 py-2 text-xs text-red-200">
            ⚠ {t('projectSettings.deleteProjectWarning', { name: project.name })}
          </div>
          <ConfirmButton
            onConfirm={async () => { if (id) { await api.projects.delete(id); void navigate('/'); } }}
            label={t('projectSettings.deleteProject')}
            confirmLabel={t('projectSettings.confirmDeleteProjectFor', { name: project.name })}
            variant="danger-solid"
            size="lg"
          />
        </SettingsSection>
      )}
    </SettingsShell>
  );
}
