import { useEffect, useMemo, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { api, Workspace, WorkspaceStatus, GitRepository } from '../api/client';
import { useToast } from './Toast';
import Card from './ui/Card';
import EmptyState from './ui/EmptyState';
import Badge from './ui/Badge';
import Button from './ui/Button';
import ConfirmButton from './ui/ConfirmButton';
import { FormInput, FormTextarea } from './ui/FormField';
import { Dialog, Portal } from './ui/Dialog';
import WorkspaceTerminal from './WorkspaceTerminal';

interface CreateForm {
  name: string;
  description: string;
  repoUrl: string;
  branch: string;
  gitRepoId: string;
}

const emptyCreate = (): CreateForm => ({
  name: '',
  description: '',
  repoUrl: '',
  branch: '',
  gitRepoId: '',
});

function gitRepoLabel(repo: GitRepository): string {
  if (repo.label) return repo.label;
  if (repo.provider === 'gitlab' && repo.gitlabProjectId) return repo.gitlabProjectId;
  if (repo.provider === 'gitea') return `${repo.owner}/${repo.repo}`;
  if (repo.owner && repo.repo) return `${repo.owner}/${repo.repo}`;
  return repo._id ?? repo.provider;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function relativeTime(iso: string, lang: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  if (!Number.isFinite(diff)) return '—';
  const units: Array<[string, number]> = [
    ['s', 1000], ['min', 60_000], ['h', 3_600_000],
    ['d', 86_400_000], ['w', 604_800_000], ['mo', 2_592_000_000],
  ];
  let label = '0 s';
  for (const [u, ms] of units) {
    if (diff < ms * (u === 'mo' ? 13 : 100)) {
      const v = Math.max(1, Math.floor(diff / ms));
      label = `${v} ${u}`;
      break;
    }
  }
  return lang === 'de' ? `vor ${label}` : `${label} ago`;
}

function statusBadgeColor(status: WorkspaceStatus): string {
  if (status === 'active') return 'bg-green-900/40 text-green-300 border border-green-700/40';
  if (status === 'cleaning') return 'bg-amber-900/40 text-amber-300 border border-amber-700/40';
  return 'bg-gray-800 text-gray-400 border border-gray-700/40';
}

function shortenRepo(url?: string): string {
  if (!url) return '—';
  return url.replace(/^https?:\/\//, '').replace(/\.git$/, '');
}

interface Props {
  projectId: string;
}

export default function WorkspaceList({ projectId }: Props) {
  const { t, i18n } = useTranslation();
  const { showSuccess, showError } = useToast();
  const [items, setItems] = useState<Workspace[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<WorkspaceStatus | 'all'>('active');
  const [showCreate, setShowCreate] = useState(false);
  const [terminalFor, setTerminalFor] = useState<Workspace | null>(null);
  const [gitRepos, setGitRepos] = useState<GitRepository[]>([]);

  const reload = useCallback(async () => {
    try {
      const [list, project] = await Promise.all([
        api.workspaces.list(projectId),
        api.projects.get(projectId).catch(() => null),
      ]);
      setItems(list);
      setGitRepos(project?.gitRepositories ?? []);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [projectId]);

  useEffect(() => { reload(); }, [reload]);

  const visible = useMemo(() => {
    if (!items) return [];
    const filtered = filter === 'all' ? items : items.filter((w) => w.status === filter);
    return [...filtered].sort(
      (a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
    );
  }, [items, filter]);

  const handleArchive = async (id: string) => {
    try {
      await api.workspaces.archive(id);
      showSuccess(t('workspaces.archived'));
      reload();
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.workspaces.delete(id);
      showSuccess(t('workspaces.deleted'));
      reload();
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    }
  };

  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      showSuccess(t('workspaces.pathCopied'));
    } catch {
      showError(t('workspaces.copyFailed'));
    }
  };

  if (loadError) {
    return (
      <Card padding="md">
        <p className="text-sm text-red-400">{loadError}</p>
      </Card>
    );
  }

  if (items === null) {
    return <p className="text-gray-500 text-sm">{t('common.loading')}</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-100">{t('workspaces.title')}</h2>
          <p className="text-xs text-gray-500 mt-0.5">{t('workspaces.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as WorkspaceStatus | 'all')}
            className="bg-gray-800 border border-gray-700 text-gray-200 text-xs rounded px-2 py-1.5"
          >
            <option value="active">{t('workspaces.filterActive')}</option>
            <option value="archived">{t('workspaces.filterArchived')}</option>
            <option value="cleaning">{t('workspaces.filterCleaning')}</option>
            <option value="all">{t('workspaces.filterAll')}</option>
          </select>
          <Button variant="primary" size="sm" onClick={() => setShowCreate(true)}>
            + {t('workspaces.create')}
          </Button>
        </div>
      </div>

      {visible.length === 0 ? (
        <EmptyState message={t('workspaces.emptyMessage')}>
          <div className="mt-3">
            <Button variant="primary" size="sm" onClick={() => setShowCreate(true)}>
              {t('workspaces.createFirst')}
            </Button>
          </div>
        </EmptyState>
      ) : (
        <div className="space-y-2">
          {visible.map((ws) => (
            <Card key={ws._id} padding="md">
              <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-mono text-gray-100 truncate">{ws.name}</span>
                    <Badge color={statusBadgeColor(ws.status)}>{ws.status}</Badge>
                  </div>
                  {ws.description && (
                    <p className="text-xs text-gray-400 mb-2">{ws.description}</p>
                  )}
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-1 text-xs text-gray-500">
                    <div>
                      <span className="text-gray-600">{t('workspaces.repo')}: </span>
                      <span className="text-gray-300 font-mono">{shortenRepo(ws.repoUrl)}</span>
                    </div>
                    <div>
                      <span className="text-gray-600">{t('workspaces.branch')}: </span>
                      <span className="text-gray-300 font-mono">{ws.branch}</span>
                    </div>
                    <div>
                      <span className="text-gray-600">{t('workspaces.size')}: </span>
                      <span className="text-gray-300">{humanBytes(ws.sizeBytes)}</span>
                    </div>
                    <div>
                      <span className="text-gray-600">{t('workspaces.lastActivity')}: </span>
                      <span className="text-gray-300">{relativeTime(ws.lastActivityAt, i18n.language)}</span>
                    </div>
                  </div>
                  <div className="mt-2">
                    <button
                      type="button"
                      onClick={() => copyPath(ws.path)}
                      className="text-[10px] text-cyan-400 hover:text-cyan-300 font-mono"
                      title={ws.path}
                    >
                      {ws.path} ⎘
                    </button>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 sm:flex-col sm:items-end">
                  <Button
                    size="xs"
                    variant="secondary"
                    onClick={() => setTerminalFor(ws)}
                    disabled={ws.status === 'archived'}
                    title={ws.status === 'archived' ? t('workspaces.archivedNoTerminal') : undefined}
                  >
                    {t('workspaces.openTerminal')}
                  </Button>
                  {ws.status !== 'archived' && (
                    <ConfirmButton
                      variant="secondary"
                      size="xs"
                      label={t('workspaces.archive')}
                      confirmLabel={t('workspaces.confirmArchive')}
                      onConfirm={() => handleArchive(ws._id)}
                    />
                  )}
                  <ConfirmButton
                    variant="danger"
                    size="xs"
                    label={t('workspaces.delete')}
                    confirmLabel={t('workspaces.confirmDelete', { name: ws.name })}
                    onConfirm={() => handleDelete(ws._id)}
                  />
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {showCreate && (
        <Portal>
          <Dialog onClose={() => setShowCreate(false)} title={t('workspaces.create')}>
            <div className="p-5">
              <CreateWorkspaceForm
                gitRepos={gitRepos}
                projectId={projectId}
                onCancel={() => setShowCreate(false)}
                onCreated={() => {
                  setShowCreate(false);
                  reload();
                }}
              />
            </div>
          </Dialog>
        </Portal>
      )}

      {terminalFor && (
        <Portal>
          <div className="bg-gray-900 border border-violet-500/50 rounded-xl shadow-2xl shadow-violet-500/10 max-w-4xl w-full mx-4 overflow-hidden">
            <WorkspaceTerminal workspace={terminalFor} onClose={() => setTerminalFor(null)} />
          </div>
        </Portal>
      )}
    </div>
  );
}

function CreateWorkspaceForm({
  projectId,
  gitRepos,
  onCancel,
  onCreated,
}: {
  projectId: string;
  gitRepos: GitRepository[];
  onCancel: () => void;
  onCreated: () => void;
}) {
  const { t } = useTranslation();
  const { showSuccess, showError } = useToast();
  const [form, setForm] = useState<CreateForm>(emptyCreate());
  const [saving, setSaving] = useState(false);

  const update = (patch: Partial<CreateForm>) => setForm((f) => ({ ...f, ...patch }));
  const validName = NAME_PATTERN.test(form.name);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validName) return;
    setSaving(true);
    try {
      await api.workspaces.create({
        projectId,
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        repoUrl: form.repoUrl.trim() || undefined,
        branch: form.branch.trim() || undefined,
        gitRepoId: form.gitRepoId || undefined,
      });
      showSuccess(t('workspaces.created'));
      onCreated();
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <FormInput
        label={t('workspaces.formName')}
        value={form.name}
        onChange={(e) => update({ name: e.target.value })}
        placeholder="my-feature-branch"
        required
        autoFocus
      />
      {form.name && !validName && (
        <p className="text-[11px] text-amber-300">{t('workspaces.nameHint')}</p>
      )}
      <FormTextarea
        label={t('workspaces.formDescription')}
        value={form.description}
        onChange={(e) => update({ description: e.target.value })}
        rows={2}
      />
      <FormInput
        label={t('workspaces.formRepoUrl')}
        value={form.repoUrl}
        onChange={(e) => update({ repoUrl: e.target.value })}
        placeholder="https://github.com/foo/bar.git"
      />
      <FormInput
        label={t('workspaces.formBranch')}
        value={form.branch}
        onChange={(e) => update({ branch: e.target.value })}
        placeholder="main"
      />
      {gitRepos.length >= 1 && (
        <div>
          <label className="block text-xs text-gray-500 mb-1">{t('workspaces.formGitRepo')}</label>
          <select
            value={form.gitRepoId}
            onChange={(e) => update({ gitRepoId: e.target.value })}
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-violet-500"
          >
            <option value="">{t('workspaces.formGitRepoDefault')}</option>
            {gitRepos.map((r) => (
              // NOTE: ProviderBadge (SVG) cannot render inside <option>; text abbreviation is intentional.
              <option key={r._id} value={r._id ?? ''}>
                [{r.provider === 'gitlab' ? 'GL' : r.provider === 'gitea' ? 'GT' : 'GH'}] {gitRepoLabel(r)}
              </option>
            ))}
          </select>
          <p className="text-[11px] text-gray-500 mt-1">{t('workspaces.formGitRepoHint')}</p>
        </div>
      )}
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="secondary" type="button" onClick={onCancel} disabled={saving}>
          {t('common.cancel')}
        </Button>
        <Button variant="primary" type="submit" disabled={saving || !validName}>
          {saving ? t('common.saving') : t('common.save')}
        </Button>
      </div>
    </form>
  );
}
