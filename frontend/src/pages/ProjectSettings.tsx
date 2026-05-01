import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, Project, GitRepository } from '../api/client';
import Button from '../components/ui/Button';
import ConfirmButton from '../components/ui/ConfirmButton';
import { LoadingText } from '../components/ui/LoadingSpinner';
import Badge from '../components/ui/Badge';
import { SettingsSection, SettingsShell } from '../components/ui/SettingsShell';

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
  const [gitRepos, setGitRepos] = useState<GitRepository[]>([]);
  const [showAddRepo, setShowAddRepo] = useState(false);
  const [newRepoProvider, setNewRepoProvider] = useState<'github' | 'gitlab'>('github');
  const [newRepoUrl, setNewRepoUrl] = useState('');
  const [newRepoToken, setNewRepoToken] = useState('');
  const [newRepoBranch, setNewRepoBranch] = useState('main');
  const [newRepoBaseUrl, setNewRepoBaseUrl] = useState('');
  const [newRepoLabel, setNewRepoLabel] = useState('');
  const [validating, setValidating] = useState(false);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [editingBranch, setEditingBranch] = useState<number | null>(null);
  const [branchOptions, setBranchOptions] = useState<{ name: string; isDefault: boolean }[]>([]);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [editingRepoIndex, setEditingRepoIndex] = useState<number | null>(null);
  const [editRepoUrl, setEditRepoUrl] = useState('');
  const [editRepoToken, setEditRepoToken] = useState('');
  const [editRepoBranch, setEditRepoBranch] = useState('main');
  const [editRepoBaseUrl, setEditRepoBaseUrl] = useState('');
  const [editRepoLabel, setEditRepoLabel] = useState('');
  const [editRepoProvider, setEditRepoProvider] = useState<'github' | 'gitlab'>('github');
  const [editValidating, setEditValidating] = useState(false);
  const [editRepoError, setEditRepoError] = useState<string | null>(null);

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
        setGitRepos(p.gitRepositories || []);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [id]);

  const parseRepoUrl = (url: string, provider: 'github' | 'gitlab'): { owner: string; repo: string; gitlabProjectId: string } => {
    const cleaned = url.replace(/\.git$/, '').replace(/\/$/, '');
    const match = cleaned.match(/(?:https?:\/\/[^/]+)\/(.+)/);
    const pathPart = match ? match[1] : url;
    if (provider === 'github') {
      const parts = pathPart.split('/');
      return { owner: parts[0] || '', repo: parts[1] || '', gitlabProjectId: '' };
    }
    return { owner: '', repo: '', gitlabProjectId: pathPart };
  };

  const handleAddRepo = async () => {
    if (!newRepoUrl.trim() || !newRepoToken.trim()) return;
    setRepoError(null);
    setValidating(true);

    let createdSecretId: string | null = null;
    try {
      const parsed = parseRepoUrl(newRepoUrl, newRepoProvider);

      // Validate token
      const { valid } = await api.commits.validateToken({
        provider: newRepoProvider,
        baseUrl: newRepoBaseUrl || undefined,
        owner: parsed.owner,
        repo: parsed.repo,
        gitlabProjectId: parsed.gitlabProjectId,
        token: newRepoToken,
      });

      if (!valid) {
        setRepoError('Token-Validierung fehlgeschlagen. Bitte Token und URL prüfen.');
        return;
      }

      // Store token as secret
      const secret = await api.secrets.create({
        projectId: id!,
        key: `git-token-${newRepoProvider}-${Date.now()}`,
        value: newRepoToken,
        description: `Git ${newRepoProvider} token for ${newRepoUrl}`,
        type: 'token',
      });
      createdSecretId = secret._id;

      const newRepo: GitRepository = {
        provider: newRepoProvider,
        label: newRepoLabel.trim() || undefined,
        baseUrl: newRepoBaseUrl || undefined,
        owner: parsed.owner,
        repo: parsed.repo,
        gitlabProjectId: parsed.gitlabProjectId,
        defaultBranch: newRepoBranch || 'main',
        tokenSecretId: secret._id,
        syncEnabled: true,
      };

      const updated = [...gitRepos, newRepo];

      // Save to project first, only update local state on success
      await api.projects.update(id!, { gitRepositories: updated } as any);
      setGitRepos(updated);

      // Reset form
      setNewRepoUrl('');
      setNewRepoToken('');
      setNewRepoBranch('main');
      setNewRepoBaseUrl('');
      setNewRepoLabel('');
      setShowAddRepo(false);
    } catch (err) {
      setRepoError(err instanceof Error ? err.message : 'Fehler beim Hinzufügen');
      // Cleanup orphan secret if project update failed after secret creation
      if (createdSecretId) {
        try {
          await api.secrets.delete(createdSecretId);
        } catch {
          // Ignore cleanup failure — surfacing it would mask the original error
        }
      }
    } finally {
      setValidating(false);
    }
  };

  const handleRemoveRepo = async (index: number) => {
    const updated = gitRepos.filter((_, i) => i !== index);
    try {
      await api.projects.update(id!, { gitRepositories: updated } as any);
      setGitRepos(updated);
    } catch (err) {
      setRepoError(err instanceof Error ? err.message : 'Fehler beim Entfernen');
    }
  };

  const handleStartEditBranch = async (index: number) => {
    setEditingBranch(index);
    setBranchOptions([]);
    setLoadingBranches(true);
    try {
      const branches = await api.commits.branches(id!, index);
      setBranchOptions(branches.sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0) || a.name.localeCompare(b.name)));
    } catch {
      setBranchOptions([]);
    } finally {
      setLoadingBranches(false);
    }
  };

  const handleUpdateBranch = async (index: number, branch: string) => {
    const trimmed = branch.trim();
    if (!trimmed) return;
    const updated = gitRepos.map((r, i) =>
      i === index ? { ...r, defaultBranch: trimmed } : r,
    );
    setEditingBranch(null);
    setBranchOptions([]);
    try {
      await api.projects.update(id!, { gitRepositories: updated } as any);
      setGitRepos(updated);
    } catch (err) {
      setRepoError(err instanceof Error ? err.message : 'Fehler beim Branch-Wechsel');
    }
  };

  const handleStartEditRepo = (index: number) => {
    const repo = gitRepos[index];
    setEditingRepoIndex(index);
    setEditRepoProvider(repo.provider as 'github' | 'gitlab');
    setEditRepoUrl(
      repo.provider === 'github'
        ? `${repo.owner}/${repo.repo}`
        : repo.gitlabProjectId || `${repo.owner}/${repo.repo}`,
    );
    setEditRepoToken('');
    setEditRepoBranch(repo.defaultBranch || 'main');
    setEditRepoBaseUrl(repo.baseUrl || '');
    setEditRepoLabel(repo.label || '');
    setEditRepoError(null);
  };

  const handleCancelEditRepo = () => {
    setEditingRepoIndex(null);
    setEditRepoError(null);
  };

  const handleSaveEditRepo = async () => {
    if (editingRepoIndex === null || !editRepoUrl.trim()) return;
    setEditRepoError(null);
    setEditValidating(true);

    let createdSecretId: string | null = null;
    try {
      const parsed = parseRepoUrl(editRepoUrl, editRepoProvider);
      const oldRepo = gitRepos[editingRepoIndex];
      const hasNewToken = editRepoToken.trim().length > 0;

      if (hasNewToken) {
        const { valid } = await api.commits.validateToken({
          provider: editRepoProvider,
          baseUrl: editRepoBaseUrl || undefined,
          owner: parsed.owner,
          repo: parsed.repo,
          gitlabProjectId: parsed.gitlabProjectId,
          token: editRepoToken,
        });
        if (!valid) {
          setEditRepoError('Token-Validierung fehlgeschlagen. Bitte Token und URL prüfen.');
          return;
        }
      }

      let tokenSecretId = oldRepo.tokenSecretId;
      if (hasNewToken) {
        const secret = await api.secrets.create({
          projectId: id!,
          key: `git-token-${editRepoProvider}-${Date.now()}`,
          value: editRepoToken,
          description: `Git ${editRepoProvider} token for ${editRepoUrl}`,
          type: 'token',
        });
        tokenSecretId = secret._id;
        createdSecretId = secret._id;
      }

      const updatedRepo: GitRepository = {
        ...oldRepo,
        provider: editRepoProvider,
        label: editRepoLabel.trim() || undefined,
        baseUrl: editRepoBaseUrl || undefined,
        owner: parsed.owner,
        repo: parsed.repo,
        gitlabProjectId: parsed.gitlabProjectId,
        defaultBranch: editRepoBranch || 'main',
        tokenSecretId,
      };

      const updated = gitRepos.map((r, i) => (i === editingRepoIndex ? updatedRepo : r));
      await api.projects.update(id!, { gitRepositories: updated } as any);
      setGitRepos(updated);
      setEditingRepoIndex(null);
    } catch (err) {
      setEditRepoError(err instanceof Error ? err.message : 'Fehler beim Speichern');
      if (createdSecretId) {
        try {
          await api.secrets.delete(createdSecretId);
        } catch {
          // Ignore cleanup failure — surfacing it would mask the original error
        }
      }
    } finally {
      setEditValidating(false);
    }
  };

  const handleToggleSync = async (index: number) => {
    const updated = gitRepos.map((r, i) =>
      i === index ? { ...r, syncEnabled: !r.syncEnabled } : r,
    );
    try {
      await api.projects.update(id!, { gitRepositories: updated } as any);
      setGitRepos(updated);
    } catch (err) {
      setRepoError(err instanceof Error ? err.message : 'Fehler beim Umschalten');
    }
  };

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
    <SettingsShell
      title={t('projectSettings.title')}
      maxWidth="max-w-4xl"
    >
      <Link
        to={`/projects/${id}`}
        className="text-sm text-gray-500 hover:text-gray-300 mb-4 inline-block"
      >
        &larr; {project.name}
      </Link>

      <p className="mb-8 text-sm text-gray-400">{project.name}</p>

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

      <section className="mb-8 space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-cyan-400">Git Repositories</h2>
          <p className="text-gray-500 text-sm mt-1">
            GitHub- oder GitLab-Repositories verbinden um Commits zu synchronisieren.
          </p>
        </div>

        {gitRepos.length > 0 && (
          <div className="space-y-2">
            {gitRepos.map((repo, i) => (
              editingRepoIndex === i ? (
                <div key={i} className="border border-violet-500/50 rounded-lg p-4 space-y-3 bg-gray-900/80">
                  <div className="flex gap-2">
                    <button type="button" onClick={() => setEditRepoProvider('github')}
                      className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${editRepoProvider === 'github' ? 'bg-violet-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>
                      GitHub
                    </button>
                    <button type="button" onClick={() => setEditRepoProvider('gitlab')}
                      className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${editRepoProvider === 'gitlab' ? 'bg-violet-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>
                      GitLab
                    </button>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Repository URL *</label>
                    <input type="text" value={editRepoUrl} onChange={(e) => setEditRepoUrl(e.target.value)}
                      placeholder={editRepoProvider === 'github' ? 'https://github.com/owner/repo' : 'https://gitlab.com/group/project'}
                      className="w-full bg-gray-900 border border-gray-800 rounded-lg px-4 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500" />
                  </div>
                  {editRepoProvider === 'gitlab' && (
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Base URL (nur für Self-Hosted)</label>
                      <input type="text" value={editRepoBaseUrl} onChange={(e) => setEditRepoBaseUrl(e.target.value)}
                        placeholder="https://gitlab.example.com"
                        className="w-full bg-gray-900 border border-gray-800 rounded-lg px-4 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500" />
                    </div>
                  )}
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Label (z.B. "API", "Frontend", "App")</label>
                    <input type="text" value={editRepoLabel} onChange={(e) => setEditRepoLabel(e.target.value)}
                      placeholder="Optional: Name zur Identifikation"
                      className="w-full bg-gray-900 border border-gray-800 rounded-lg px-4 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500" />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">
                        {editRepoProvider === 'github' ? 'Personal Access Token' : 'Access Token (read_api)'}
                        <span className="text-gray-600 ml-1">(leer = beibehalten)</span>
                      </label>
                      <input type="password" value={editRepoToken} onChange={(e) => setEditRepoToken(e.target.value)}
                        placeholder="Neuer Token oder leer lassen"
                        className="w-full bg-gray-900 border border-gray-800 rounded-lg px-4 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500" />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Default Branch</label>
                      <input type="text" value={editRepoBranch} onChange={(e) => setEditRepoBranch(e.target.value)}
                        placeholder="main"
                        className="w-full bg-gray-900 border border-gray-800 rounded-lg px-4 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500" />
                    </div>
                  </div>
                  {editRepoError && <p className="text-sm text-red-400">{editRepoError}</p>}
                  <div className="flex gap-2">
                    <Button type="button" variant="primary" size="sm" onClick={handleSaveEditRepo}
                      disabled={editValidating || !editRepoUrl.trim()}>
                      {editValidating ? 'Prüfe...' : t('common.save')}
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={handleCancelEditRepo}>
                      {t('common.cancel')}
                    </Button>
                  </div>
                </div>
              ) : (
                <div key={i} className="flex items-center gap-3 bg-gray-900 border border-gray-800 rounded-lg px-4 py-3">
                  <Badge color={repo.provider === 'github' ? 'bg-gray-700 text-white' : 'bg-orange-900/60 text-orange-300'} rounded="full">
                    {repo.provider === 'github' ? 'GH' : 'GL'}
                  </Badge>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      {repo.label && (
                        <span className="text-xs font-medium text-violet-400 bg-violet-500/10 px-1.5 py-0.5 rounded">
                          {repo.label}
                        </span>
                      )}
                      <p className="text-sm text-gray-200 truncate">
                        {repo.provider === 'github'
                          ? `${repo.owner}/${repo.repo}`
                          : repo.gitlabProjectId || `${repo.owner}/${repo.repo}`
                        }
                      </p>
                    </div>
                    <div className="text-xs text-gray-500 flex items-center gap-1">
                      {editingBranch === i ? (
                        loadingBranches ? (
                          <span className="text-xs text-gray-500 animate-pulse">Branches laden…</span>
                        ) : (
                          <select
                            value={repo.defaultBranch || 'main'}
                            onChange={(e) => handleUpdateBranch(i, e.target.value)}
                            onBlur={() => { setEditingBranch(null); setBranchOptions([]); }}
                            autoFocus
                            className="bg-gray-800 border border-violet-500 rounded px-1.5 py-0.5 text-xs text-gray-200 focus:outline-none"
                          >
                            {!branchOptions.some((b) => b.name === (repo.defaultBranch || 'main')) && (
                              <option value={repo.defaultBranch || 'main'}>{repo.defaultBranch || 'main'}</option>
                            )}
                            {branchOptions.map((b) => (
                              <option key={b.name} value={b.name}>
                                {b.name}{b.isDefault ? ' (default)' : ''}
                              </option>
                            ))}
                          </select>
                        )
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleStartEditBranch(i)}
                          className="hover:text-violet-400 transition-colors cursor-pointer"
                          title="Branch ändern"
                        >
                          {repo.defaultBranch || 'main'}
                        </button>
                      )}
                      {repo.lastSyncAt && <span>· Letzter Sync: {new Date(repo.lastSyncAt).toLocaleString('de-DE')}</span>}
                    </div>
                  </div>
                  <button type="button" onClick={() => handleStartEditRepo(i)}
                    className="text-xs text-violet-400 hover:text-violet-300 px-2 py-1">
                    {t('common.edit')}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleToggleSync(i)}
                    className={`text-xs px-2 py-1 rounded-full transition-colors ${
                      repo.syncEnabled !== false
                        ? 'bg-green-900/50 text-green-300 hover:bg-green-800/50'
                        : 'bg-gray-800 text-gray-500 hover:bg-gray-700'
                    }`}
                  >
                    {repo.syncEnabled !== false ? 'Aktiv' : 'Pausiert'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRemoveRepo(i)}
                    className="text-xs text-red-400 hover:text-red-300 px-2 py-1"
                  >
                    Entfernen
                  </button>
                </div>
              )
            ))}
          </div>
        )}

        {showAddRepo ? (
          <div className="border border-gray-800 rounded-lg p-4 space-y-3">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setNewRepoProvider('github')}
                className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
                  newRepoProvider === 'github'
                    ? 'bg-violet-600 text-white'
                    : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                }`}
              >
                GitHub
              </button>
              <button
                type="button"
                onClick={() => setNewRepoProvider('gitlab')}
                className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
                  newRepoProvider === 'gitlab'
                    ? 'bg-violet-600 text-white'
                    : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                }`}
              >
                GitLab
              </button>
            </div>

            <div>
              <label className="block text-xs text-gray-500 mb-1">
                Repository URL *
              </label>
              <input
                type="text"
                value={newRepoUrl}
                onChange={(e) => setNewRepoUrl(e.target.value)}
                placeholder={newRepoProvider === 'github'
                  ? 'https://github.com/owner/repo'
                  : 'https://gitlab.com/group/project'
                }
                className="w-full bg-gray-900 border border-gray-800 rounded-lg px-4 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500"
              />
            </div>

            {newRepoProvider === 'gitlab' && (
              <div>
                <label className="block text-xs text-gray-500 mb-1">
                  Base URL (nur für Self-Hosted)
                </label>
                <input
                  type="text"
                  value={newRepoBaseUrl}
                  onChange={(e) => setNewRepoBaseUrl(e.target.value)}
                  placeholder="https://gitlab.example.com"
                  className="w-full bg-gray-900 border border-gray-800 rounded-lg px-4 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500"
                />
              </div>
            )}

            <div>
              <label className="block text-xs text-gray-500 mb-1">
                Label (z.B. "API", "Frontend", "App")
              </label>
              <input
                type="text"
                value={newRepoLabel}
                onChange={(e) => setNewRepoLabel(e.target.value)}
                placeholder="Optional: Name zur Identifikation"
                className="w-full bg-gray-900 border border-gray-800 rounded-lg px-4 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">
                  {newRepoProvider === 'github' ? 'Personal Access Token *' : 'Access Token (read_api) *'}
                </label>
                <input
                  type="password"
                  value={newRepoToken}
                  onChange={(e) => setNewRepoToken(e.target.value)}
                  placeholder={newRepoProvider === 'github' ? 'ghp_...' : 'glpat-...'}
                  className="w-full bg-gray-900 border border-gray-800 rounded-lg px-4 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Default Branch</label>
                <input
                  type="text"
                  value={newRepoBranch}
                  onChange={(e) => setNewRepoBranch(e.target.value)}
                  placeholder="main"
                  className="w-full bg-gray-900 border border-gray-800 rounded-lg px-4 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500"
                />
              </div>
            </div>

            {repoError && (
              <p className="text-sm text-red-400">{repoError}</p>
            )}

            <div className="flex gap-2">
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={handleAddRepo}
                disabled={validating || !newRepoUrl.trim() || !newRepoToken.trim()}
              >
                {validating ? 'Prüfe...' : 'Verbinden'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => { setShowAddRepo(false); setRepoError(null); }}
              >
                Abbrechen
              </Button>
            </div>
          </div>
        ) : (
          <Button type="button" variant="secondary" size="sm" onClick={() => setShowAddRepo(true)}>
            + Repository hinzufügen
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

      <SettingsSection
        tone="accent"
        title={t('projectSettings.dataExport')}
        description={t('projectSettings.dataExportHelp')}
        className="mb-8"
      >
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
      </SettingsSection>

      <SettingsSection
        tone="danger"
        title={t('projectSettings.dangerZone')}
        description={t('projectSettings.dangerZoneHelp')}
        className="mb-8"
      >
        <ConfirmButton onConfirm={async () => { if (id) { await api.projects.delete(id); navigate('/'); } }} label={t('projectSettings.deleteProject')} confirmLabel={t('projectSettings.confirmDeleteProject')} size="lg" />
      </SettingsSection>

      <SettingsSection title={t('projectSettings.instructionsInfoTitle')}>
        <p className="text-gray-500 text-sm leading-relaxed">
          {t('projectSettings.instructionsInfoText', { tool: 'project_get', file: 'CLAUDE.md' })}
        </p>
      </SettingsSection>
    </SettingsShell>
  );
}
