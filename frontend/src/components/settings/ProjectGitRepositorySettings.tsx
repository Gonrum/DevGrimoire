import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, GitRepository } from '../../api/client';
import Button from '../ui/Button';
import { FormInput, SecretInput } from '../ui/FormField';
import { ProviderBadge, type GitProvider } from '../icons/ProviderIcon';

type Provider = 'github' | 'gitlab' | 'gitea';

interface Props {
  projectId: string;
  gitRepos: GitRepository[];
  onChange: (next: GitRepository[]) => void;
}

function parseRepoUrl(url: string, provider: Provider): { owner: string; repo: string; gitlabProjectId: string } {
  const cleaned = url.replace(/\.git$/, '').replace(/\/$/, '');
  const match = cleaned.match(/(?:https?:\/\/[^/]+)\/(.+)/);
  const pathPart = match ? match[1] : url;
  if (provider === 'github' || provider === 'gitea') {
    const parts = pathPart.split('/');
    return { owner: parts[0] || '', repo: parts[1] || '', gitlabProjectId: '' };
  }
  return { owner: '', repo: '', gitlabProjectId: pathPart };
}

function ProviderSegmented({ value, onChange }: { value: Provider; onChange: (next: Provider) => void }) {
  const labels: Record<Provider, string> = { github: 'GitHub', gitlab: 'GitLab', gitea: 'Gitea' };
  return (
    <div className="flex gap-2">
      {(['github', 'gitlab', 'gitea'] as const).map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onChange(p)}
          className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${
            value === p ? 'bg-violet-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
          }`}
        >
          {labels[p]}
        </button>
      ))}
    </div>
  );
}

export default function ProjectGitRepositorySettings({ projectId, gitRepos, onChange }: Props) {
  const { t, i18n } = useTranslation();
  const dateLocale = i18n.language === 'de' ? 'de-DE' : 'en-US';

  const [showAddRepo, setShowAddRepo] = useState(false);
  const [newRepoProvider, setNewRepoProvider] = useState<Provider>('github');
  const [newRepoUrl, setNewRepoUrl] = useState('');
  const [newRepoToken, setNewRepoToken] = useState('');
  const [newRepoBranch, setNewRepoBranch] = useState('main');
  const [newRepoBaseUrl, setNewRepoBaseUrl] = useState('');
  const [newRepoLabel, setNewRepoLabel] = useState('');
  const [newAllowPrivateHost, setNewAllowPrivateHost] = useState(false);
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
  const [editRepoProvider, setEditRepoProvider] = useState<Provider>('github');
  const [editAllowPrivateHost, setEditAllowPrivateHost] = useState(false);
  const [editValidating, setEditValidating] = useState(false);
  const [editRepoError, setEditRepoError] = useState<string | null>(null);

  const isPrivateLike = (url: string): boolean => {
    try {
      const h = new URL(url).hostname.toLowerCase();
      return (
        h === 'localhost' ||
        /^127\./.test(h) ||
        /^10\./.test(h) ||
        /^192\.168\./.test(h) ||
        h.endsWith('.local') ||
        h.endsWith('.internal')
      );
    } catch { return false; }
  };

  const persist = async (next: GitRepository[]) => {
    await api.projects.update(projectId, { gitRepositories: next } as any);
    onChange(next);
  };

  const handleAddRepo = async () => {
    if (!newRepoUrl.trim() || !newRepoToken.trim()) return;
    setRepoError(null);
    setValidating(true);

    let createdSecretId: string | null = null;
    try {
      const parsed = parseRepoUrl(newRepoUrl, newRepoProvider);
      const { valid } = await api.commits.validateToken({
        provider: newRepoProvider,
        baseUrl: newRepoBaseUrl || undefined,
        owner: parsed.owner,
        repo: parsed.repo,
        gitlabProjectId: parsed.gitlabProjectId,
        token: newRepoToken,
      });
      if (!valid) {
        setRepoError(t('projectGit.tokenValidationFailed'));
        return;
      }

      const secret = await api.secrets.create({
        projectId,
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
        allowPrivateHost: newAllowPrivateHost || undefined,
      };

      await persist([...gitRepos, newRepo]);
      setNewRepoUrl('');
      setNewRepoToken('');
      setNewRepoBranch('main');
      setNewRepoBaseUrl('');
      setNewRepoLabel('');
      setNewAllowPrivateHost(false);
      setShowAddRepo(false);
    } catch (err) {
      setRepoError(err instanceof Error ? err.message : t('projectGit.addFailed'));
      if (createdSecretId) {
        try { await api.secrets.delete(createdSecretId); } catch { /* ignore */ }
      }
    } finally {
      setValidating(false);
    }
  };

  const handleRemoveRepo = async (index: number) => {
    try {
      await persist(gitRepos.filter((_, i) => i !== index));
    } catch (err) {
      setRepoError(err instanceof Error ? err.message : t('projectGit.removeFailed'));
    }
  };

  const handleStartEditBranch = async (index: number) => {
    setEditingBranch(index);
    setBranchOptions([]);
    setLoadingBranches(true);
    try {
      const branches = await api.commits.branches(projectId, index);
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
    const updated = gitRepos.map((r, i) => (i === index ? { ...r, defaultBranch: trimmed } : r));
    setEditingBranch(null);
    setBranchOptions([]);
    try {
      await persist(updated);
    } catch (err) {
      setRepoError(err instanceof Error ? err.message : t('projectGit.branchSwitchFailed'));
    }
  };

  const handleStartEditRepo = (index: number) => {
    const repo = gitRepos[index];
    setEditingRepoIndex(index);
    setEditRepoProvider(repo.provider as Provider);
    setEditRepoUrl(
      repo.provider === 'github' || repo.provider === 'gitea'
        ? `${repo.owner}/${repo.repo}`
        : repo.gitlabProjectId || `${repo.owner}/${repo.repo}`,
    );
    setEditRepoToken('');
    setEditRepoBranch(repo.defaultBranch || 'main');
    setEditRepoBaseUrl(repo.baseUrl || '');
    setEditRepoLabel(repo.label || '');
    setEditAllowPrivateHost(repo.allowPrivateHost ?? false);
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
          setEditRepoError(t('projectGit.tokenValidationFailed'));
          return;
        }
      }

      let tokenSecretId = oldRepo.tokenSecretId;
      if (hasNewToken) {
        const secret = await api.secrets.create({
          projectId,
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
        allowPrivateHost: editAllowPrivateHost || undefined,
      };

      const updated = gitRepos.map((r, i) => (i === editingRepoIndex ? updatedRepo : r));
      await persist(updated);
      setEditingRepoIndex(null);
    } catch (err) {
      setEditRepoError(err instanceof Error ? err.message : t('projectGit.saveFailed'));
      if (createdSecretId) {
        try { await api.secrets.delete(createdSecretId); } catch { /* ignore */ }
      }
    } finally {
      setEditValidating(false);
    }
  };

  const handleToggleSync = async (index: number) => {
    const updated = gitRepos.map((r, i) => (i === index ? { ...r, syncEnabled: !r.syncEnabled } : r));
    try {
      await persist(updated);
    } catch (err) {
      setRepoError(err instanceof Error ? err.message : t('projectGit.toggleFailed'));
    }
  };

  return (
    <section className="mb-8 space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-cyan-400">{t('projectGit.title')}</h2>
        <p className="text-gray-500 text-sm mt-1">{t('projectGit.description')}</p>
      </div>

      {gitRepos.length > 0 && (
        <div className="space-y-2">
          {gitRepos.map((repo, i) => (
            editingRepoIndex === i ? (
              <div key={i} className="border border-violet-500/50 rounded-lg p-4 space-y-3 bg-gray-900/80">
                <ProviderSegmented value={editRepoProvider} onChange={setEditRepoProvider} />
                <FormInput
                  label={t('projectGit.repoUrl')}
                  required
                  type="text"
                  value={editRepoUrl}
                  onChange={(e) => setEditRepoUrl(e.target.value)}
                  placeholder={
                    editRepoProvider === 'github' ? 'https://github.com/owner/repo' :
                    editRepoProvider === 'gitea' ? 'https://gitea.example.com/owner/repo' :
                    'https://gitlab.com/group/project'
                  }
                />
                {(editRepoProvider === 'gitlab' || editRepoProvider === 'gitea') && (
                  <div>
                    <FormInput
                      label={t('projectGit.baseUrl')}
                      type="text"
                      value={editRepoBaseUrl}
                      onChange={(e) => setEditRepoBaseUrl(e.target.value)}
                      placeholder={editRepoProvider === 'gitea' ? 'https://gitea.example.com' : 'https://gitlab.example.com'}
                    />
                    {editRepoProvider === 'gitea' && (
                      <small className="text-amber-300">Gitea hat keinen Default — Base-URL ist Pflicht.</small>
                    )}
                    {editRepoBaseUrl && isPrivateLike(editRepoBaseUrl) && (
                      <label className="flex items-center gap-2 mt-2">
                        <input
                          type="checkbox"
                          checked={editAllowPrivateHost}
                          onChange={(e) => {
                            if (e.target.checked) {
                              const ok = window.confirm(
                                'Mit dieser Option wird der SSRF-Schutz für DIESES Repository vollständig deaktiviert. '
                                + 'Eine baseUrl, die auf 127.0.0.1, 169.254.169.254 (Cloud-Metadata) oder vergleichbare interne '
                                + 'Endpoints zeigt, wird dann zugelassen. Settings-Schreiber könnten so Cloud-Credentials abgreifen.\n\n'
                                + 'Wirklich aktivieren?',
                              );
                              if (!ok) return;
                            }
                            setEditAllowPrivateHost(e.target.checked);
                          }}
                        />
                        <span className="text-xs text-amber-300">Private/interne Adresse erlauben (deaktiviert SSRF-Schutz für dieses Repo)</span>
                      </label>
                    )}
                  </div>
                )}
                <FormInput
                  label={t('projectGit.label')}
                  type="text"
                  value={editRepoLabel}
                  onChange={(e) => setEditRepoLabel(e.target.value)}
                  placeholder={t('projectGit.labelPlaceholder')}
                />
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <SecretInput
                    label={editRepoProvider === 'github' ? t('projectGit.tokenGithub') : t('projectGit.tokenGitlab')}
                    value={editRepoToken}
                    onChange={(e) => setEditRepoToken(e.target.value)}
                    placeholder={t('projectGit.tokenKeepPlaceholder')}
                    helpText={t('projectGit.tokenKeepHint')}
                  />
                  <FormInput
                    label={t('projectGit.defaultBranch')}
                    type="text"
                    value={editRepoBranch}
                    onChange={(e) => setEditRepoBranch(e.target.value)}
                    placeholder="main"
                  />
                </div>
                {editRepoError && <p className="text-sm text-red-400">{editRepoError}</p>}
                <div className="flex gap-2">
                  <Button type="button" variant="primary" size="sm" onClick={handleSaveEditRepo} disabled={editValidating || !editRepoUrl.trim()}>
                    {editValidating ? t('projectGit.validating') : t('common.save')}
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={handleCancelEditRepo}>
                    {t('common.cancel')}
                  </Button>
                </div>
              </div>
            ) : (
              <div key={i} className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3 bg-gray-900 border border-gray-800 rounded-lg px-4 py-3">
                <ProviderBadge provider={repo.provider as GitProvider} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    {repo.label && (
                      <span className="text-xs font-medium text-violet-400 bg-violet-500/10 px-1.5 py-0.5 rounded">
                        {repo.label}
                      </span>
                    )}
                    <p className="text-sm text-gray-200 truncate">
                      {repo.provider === 'github' || repo.provider === 'gitea'
                        ? `${repo.owner}/${repo.repo}`
                        : repo.gitlabProjectId || `${repo.owner}/${repo.repo}`}
                    </p>
                  </div>
                  <div className="text-xs text-gray-500 flex items-center gap-1">
                    {editingBranch === i ? (
                      loadingBranches ? (
                        <span className="text-xs text-gray-500 animate-pulse">{t('projectGit.loadingBranches')}</span>
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
                        title={t('projectGit.changeBranch')}
                      >
                        {repo.defaultBranch || 'main'}
                      </button>
                    )}
                    {repo.lastSyncAt && <span>· {t('projectGit.lastSync')}: {new Date(repo.lastSyncAt).toLocaleString(dateLocale)}</span>}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 sm:flex-nowrap">
                  <button type="button" onClick={() => handleStartEditRepo(i)} className="text-xs text-violet-400 hover:text-violet-300 px-2 py-1">
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
                    {repo.syncEnabled !== false ? t('projectGit.statusActive') : t('projectGit.statusPaused')}
                  </button>
                  <button type="button" onClick={() => handleRemoveRepo(i)} className="text-xs text-red-400 hover:text-red-300 px-2 py-1">
                    {t('common.remove')}
                  </button>
                </div>
              </div>
            )
          ))}
        </div>
      )}

      {showAddRepo ? (
        <div className="border border-gray-800 rounded-lg p-4 space-y-3">
          <ProviderSegmented value={newRepoProvider} onChange={setNewRepoProvider} />
          <FormInput
            label={t('projectGit.repoUrl')}
            required
            type="text"
            value={newRepoUrl}
            onChange={(e) => setNewRepoUrl(e.target.value)}
            placeholder={
              newRepoProvider === 'github' ? 'https://github.com/owner/repo' :
              newRepoProvider === 'gitea' ? 'https://gitea.example.com/owner/repo' :
              'https://gitlab.com/group/project'
            }
          />
          {(newRepoProvider === 'gitlab' || newRepoProvider === 'gitea') && (
            <div>
              <FormInput
                label={t('projectGit.baseUrl')}
                type="text"
                value={newRepoBaseUrl}
                onChange={(e) => setNewRepoBaseUrl(e.target.value)}
                placeholder={newRepoProvider === 'gitea' ? 'https://gitea.example.com' : 'https://gitlab.example.com'}
              />
              {newRepoProvider === 'gitea' && (
                <small className="text-amber-300">Gitea hat keinen Default — Base-URL ist Pflicht.</small>
              )}
              {newRepoBaseUrl && isPrivateLike(newRepoBaseUrl) && (
                <label className="flex items-center gap-2 mt-2">
                  <input
                    type="checkbox"
                    checked={newAllowPrivateHost}
                    onChange={(e) => {
                      if (e.target.checked) {
                        const ok = window.confirm(
                          'Mit dieser Option wird der SSRF-Schutz für DIESES Repository vollständig deaktiviert. '
                          + 'Eine baseUrl, die auf 127.0.0.1, 169.254.169.254 (Cloud-Metadata) oder vergleichbare interne '
                          + 'Endpoints zeigt, wird dann zugelassen. Settings-Schreiber könnten so Cloud-Credentials abgreifen.\n\n'
                          + 'Wirklich aktivieren?',
                        );
                        if (!ok) return;
                      }
                      setNewAllowPrivateHost(e.target.checked);
                    }}
                  />
                  <span className="text-xs text-amber-300">Private/interne Adresse erlauben (deaktiviert SSRF-Schutz für dieses Repo)</span>
                </label>
              )}
            </div>
          )}
          <FormInput
            label={t('projectGit.label')}
            type="text"
            value={newRepoLabel}
            onChange={(e) => setNewRepoLabel(e.target.value)}
            placeholder={t('projectGit.labelPlaceholder')}
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <SecretInput
              label={newRepoProvider === 'github' ? t('projectGit.tokenGithubRequired') : t('projectGit.tokenGitlabRequired')}
              required
              value={newRepoToken}
              onChange={(e) => setNewRepoToken(e.target.value)}
              placeholder={newRepoProvider === 'github' ? 'ghp_...' : newRepoProvider === 'gitea' ? 'gitea-token' : 'glpat-...'}
            />
            <FormInput
              label={t('projectGit.defaultBranch')}
              type="text"
              value={newRepoBranch}
              onChange={(e) => setNewRepoBranch(e.target.value)}
              placeholder="main"
            />
          </div>
          {repoError && <p className="text-sm text-red-400">{repoError}</p>}
          <div className="flex gap-2">
            <Button type="button" variant="primary" size="sm" onClick={handleAddRepo} disabled={validating || !newRepoUrl.trim() || !newRepoToken.trim()}>
              {validating ? t('projectGit.validating') : t('projectGit.connect')}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => { setShowAddRepo(false); setRepoError(null); }}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <Button type="button" variant="secondary" size="sm" onClick={() => setShowAddRepo(true)}>
          + {t('projectGit.addRepo')}
        </Button>
      )}
    </section>
  );
}
