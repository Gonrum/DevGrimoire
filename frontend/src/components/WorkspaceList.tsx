import { useEffect, useMemo, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Archive, Code2, Copy, SquareTerminal, Trash2 } from 'lucide-react';
import {
  api, ApiError, Workspace, WorkspaceLocation, WorkspaceStatus, GitRepository, SshConnectionListItem,
} from '../api/client';
import { optionOr } from '../lib/narrow';
import { useToast } from './Toast';
import Card from './ui/Card';
import EmptyState from './ui/EmptyState';
import Badge from './ui/Badge';
import Button from './ui/Button';
import ConfirmButton from './ui/ConfirmButton';
import { FormInput, FormTextarea } from './ui/FormField';
import { Dialog, Portal } from './ui/Dialog';
import { sshTarget } from '../lib/ssh-target';
import { openInTerminalDock } from './ssh/terminalDockEvents';

/** Square icon button of a workspace card. */
const ICON_BUTTON = 'inline-flex h-8 w-8 items-center justify-center';
/** Same footprint while idle; grows to fit the confirm text on the second step. */
const CONFIRM_ICON_BUTTON = 'inline-flex h-8 min-w-8 items-center justify-center px-2 text-xs';

interface CreateForm {
  name: string;
  description: string;
  repoUrl: string;
  branch: string;
  gitRepoId: string;
  location: WorkspaceLocation;
  sshConnectionId: string;
  remotePath: string;
}

const emptyCreate = (): CreateForm => ({
  name: '',
  description: '',
  repoUrl: '',
  branch: '',
  gitRepoId: '',
  location: 'container',
  sshConnectionId: '',
  remotePath: '',
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

/** Error codes of the backend that mean "confirm the host key on the connection page". */
const FINGERPRINT_ERRORS: readonly string[] = ['tofu_not_accepted', 'host_key_mismatch'];

function shortenRepo(url?: string): string {
  if (!url) return '—';
  return url.replace(/^https?:\/\//, '').replace(/\.git$/, '');
}

interface Props {
  projectId: string;
}

/** Ergebnis eines Ladevorgangs — bewusst als Wert statt als State-Seiteneffekt. */
type LoadResult =
  | { ok: true; items: Workspace[]; repos: GitRepository[] }
  | { ok: false; error: string };

const FILTER_OPTIONS: readonly (WorkspaceStatus | 'all')[] = [
  'active',
  'archived',
  'cleaning',
  'all',
];

export default function WorkspaceList({ projectId }: Props) {
  const { t, i18n } = useTranslation();
  const { showSuccess, showError } = useToast();
  const [items, setItems] = useState<Workspace[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<WorkspaceStatus | 'all'>('active');
  const [showCreate, setShowCreate] = useState(false);
  const [gitRepos, setGitRepos] = useState<GitRepository[]>([]);

  /** Holt Liste + Repos und gibt sie zurück, ohne State anzufassen. */
  const fetchState = useCallback(async (): Promise<LoadResult> => {
    try {
      const [list, project] = await Promise.all([
        api.workspaces.list(projectId),
        api.projects.get(projectId).catch(() => null),
      ]);
      return { ok: true, items: list, repos: project?.gitRepositories ?? [] };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }, [projectId]);

  const applyState = useCallback((result: LoadResult) => {
    if (!result.ok) {
      setLoadError(result.error);
      return;
    }
    setItems(result.items);
    setGitRepos(result.repos);
    setLoadError(null);
  }, []);

  /** Nie rejected: `fetchState` verpackt den Fehler in `LoadResult`. */
  const reload = useCallback(() => fetchState().then(applyState), [fetchState, applyState]);

  useEffect(() => { void reload(); }, [reload]);

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
      void reload();
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.workspaces.delete(id);
      showSuccess(t('workspaces.deleted'));
      void reload();
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
            onChange={(e) => setFilter(optionOr(e.target.value, FILTER_OPTIONS, 'all'))}
            className="bg-gray-800 border border-gray-700 text-gray-200 text-xs rounded-sm px-2 py-1.5"
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
          {visible.map((ws) => {
            const isSsh = ws.location === 'ssh';
            const sshMissing = isSsh && !ws.ssh;
            return (
            <Card key={ws._id} padding="md">
              <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-mono text-gray-100 truncate">{ws.name}</span>
                    <Badge color={statusBadgeColor(ws.status)}>{ws.status}</Badge>
                    {isSsh && (
                      <Badge color="bg-amber-900/40 text-amber-300 border border-amber-700/40">SSH</Badge>
                    )}
                  </div>
                  {ws.description && (
                    <p className="text-xs text-gray-400 mb-2">{ws.description}</p>
                  )}
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-1 text-xs text-gray-500">
                    {!isSsh && (
                      <>
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
                      </>
                    )}
                    <div>
                      <span className="text-gray-600">{t('workspaces.lastActivity')}: </span>
                      <span className="text-gray-300">{relativeTime(ws.lastActivityAt, i18n.language)}</span>
                    </div>
                  </div>
                  <div className="mt-2">
                    {sshMissing ? (
                      <p className="text-[11px] text-amber-300">
                        {t('workspaces.sshMissing')}
                        {ws.remotePath ? <span className="font-mono text-gray-500"> {ws.remotePath}</span> : null}
                      </p>
                    ) : (
                      <button
                        type="button"
                        onClick={() => { void copyPath(isSsh ? (ws.remotePath ?? ws.path) : ws.path); }}
                        className="inline-flex max-w-full items-center gap-1 text-[10px] text-cyan-400 hover:text-cyan-300 font-mono"
                        title={isSsh ? sshTarget(ws) : ws.path}
                      >
                        <span className="truncate">{isSsh ? sshTarget(ws) : ws.path}</span>
                        <Copy className="h-3 w-3 shrink-0" aria-hidden />
                      </button>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                  <Button
                    size="none"
                    variant="secondary"
                    className={ICON_BUTTON}
                    onClick={() => openInTerminalDock({ kind: 'workspace', workspace: ws })}
                    disabled={ws.status === 'archived' || sshMissing}
                    title={
                      sshMissing
                        ? t('workspaces.sshMissing')
                        : ws.status === 'archived' ? t('workspaces.archivedNoTerminal') : t('workspaces.openTerminal')
                    }
                    aria-label={t('workspaces.openTerminal')}
                  >
                    <SquareTerminal className="h-4 w-4" aria-hidden />
                  </Button>
                  <Button
                    size="none"
                    variant="edit"
                    className={ICON_BUTTON}
                    onClick={() => window.open(`/ide/${ws._id}`, '_blank', 'noopener')}
                    disabled={ws.status !== 'active' || sshMissing}
                    title={
                      sshMissing
                        ? t('workspaces.sshMissing')
                        : ws.status === 'archived' ? t('workspaces.archivedNoIde') : t('workspaces.openIde')
                    }
                    aria-label={t('workspaces.openIde')}
                  >
                    <Code2 className="h-4 w-4" aria-hidden />
                  </Button>
                  <span className="mx-0.5 h-5 w-px bg-gray-800" aria-hidden />
                  {ws.status !== 'archived' && (
                    <ConfirmButton
                      variant="secondary"
                      size="none"
                      className={CONFIRM_ICON_BUTTON}
                      icon={<Archive className="h-4 w-4" aria-hidden />}
                      label={t('workspaces.archive')}
                      confirmLabel={t('workspaces.confirmArchive')}
                      onConfirm={() => handleArchive(ws._id)}
                    />
                  )}
                  <ConfirmButton
                    variant="danger"
                    size="none"
                    className={CONFIRM_ICON_BUTTON}
                    icon={<Trash2 className="h-4 w-4" aria-hidden />}
                    label={isSsh ? t('workspaces.deleteSshEntry') : t('workspaces.delete')}
                    confirmLabel={
                      isSsh
                        ? t('workspaces.confirmDeleteSsh', { name: ws.name })
                        : t('workspaces.confirmDelete', { name: ws.name })
                    }
                    onConfirm={() => handleDelete(ws._id)}
                  />
                </div>
              </div>
            </Card>
            );
          })}
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
                  void reload();
                }}
              />
            </div>
          </Dialog>
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
  const { showSuccess } = useToast();
  const [form, setForm] = useState<CreateForm>(emptyCreate());
  const [saving, setSaving] = useState(false);
  const [connections, setConnections] = useState<SshConnectionListItem[] | null>(null);
  const [submitError, setSubmitError] = useState<{ message: string; fingerprint: boolean } | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.ssh.listForProject(projectId)
      .then((list) => { if (!cancelled) setConnections(list); })
      .catch(() => { if (!cancelled) setConnections([]); });
    return () => { cancelled = true; };
  }, [projectId]);

  const isSsh = form.location === 'ssh';
  const sshAvailable = connections !== null && connections.length > 0;
  const validSsh = form.sshConnectionId !== '' && form.remotePath.trim().startsWith('/');

  const update = (patch: Partial<CreateForm>) => {
    setSubmitError(null);
    setForm((f) => ({ ...f, ...patch }));
  };
  const validName = NAME_PATTERN.test(form.name);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validName || (isSsh && !validSsh)) return;
    setSaving(true);
    setSubmitError(null);
    try {
      await api.workspaces.create(
        isSsh
          ? {
              projectId,
              name: form.name.trim(),
              description: form.description.trim() || undefined,
              location: 'ssh',
              sshConnectionId: form.sshConnectionId,
              remotePath: form.remotePath.trim(),
            }
          : {
              projectId,
              name: form.name.trim(),
              description: form.description.trim() || undefined,
              repoUrl: form.repoUrl.trim() || undefined,
              branch: form.branch.trim() || undefined,
              gitRepoId: form.gitRepoId || undefined,
            },
      );
      showSuccess(t('workspaces.created'));
      onCreated();
    } catch (err) {
      setSubmitError({
        message: err instanceof Error ? err.message : String(err),
        fingerprint: err instanceof ApiError && err.code !== undefined && FINGERPRINT_ERRORS.includes(err.code),
      });
    } finally {
      setSaving(false);
    }
  };

  const segmentClass = (active: boolean) =>
    active
      ? 'flex-1 px-3 py-1.5 text-sm bg-violet-600 text-white'
      : 'flex-1 px-3 py-1.5 text-sm bg-gray-800 text-gray-300 hover:bg-gray-700 disabled:opacity-50 disabled:hover:bg-gray-800';

  return (
    <form onSubmit={(e) => { void submit(e); }} className="space-y-3">
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
      <div>
        <span id="ws-location-label" className="block text-xs text-gray-500 mb-1">{t('workspaces.formLocation')}</span>
        <div
          role="radiogroup"
          aria-labelledby="ws-location-label"
          className="flex overflow-hidden rounded-sm border border-gray-700 divide-x divide-gray-700"
        >
          <button
            type="button"
            role="radio"
            aria-checked={!isSsh}
            className={segmentClass(!isSsh)}
            onClick={() => update({ location: 'container' })}
          >
            {t('workspaces.locationContainer')}
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={isSsh}
            disabled={!sshAvailable}
            className={segmentClass(isSsh)}
            onClick={() => update({ location: 'ssh' })}
          >
            {t('workspaces.locationSsh')}
          </button>
        </div>
        {connections !== null && connections.length === 0 && (
          <p className="text-[11px] text-gray-500 mt-1">
            {t('workspaces.noSshConnections')}{' '}
            <Link to={`/projects/${projectId}?tab=ssh`} className="text-cyan-400 hover:text-cyan-300 underline">
              {t('workspaces.sshConnectionsLink')}
            </Link>
          </p>
        )}
      </div>
      {isSsh && connections !== null && (
        <>
          <div>
            <label htmlFor="ws-ssh-connection" className="block text-xs text-gray-500 mb-1">
              {t('workspaces.formSshConnection')}
            </label>
            <select
              id="ws-ssh-connection"
              value={form.sshConnectionId}
              onChange={(e) => update({ sshConnectionId: e.target.value })}
              required
              className="w-full bg-gray-800 border border-gray-700 rounded-sm px-3 py-2 text-sm text-gray-200 focus:outline-hidden focus:border-violet-500"
            >
              <option value="">{t('workspaces.formSshConnectionPlaceholder')}</option>
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label} ({c.username}@{c.host})
                </option>
              ))}
            </select>
          </div>
          <FormInput
            label={t('workspaces.formRemotePath')}
            value={form.remotePath}
            onChange={(e) => update({ remotePath: e.target.value })}
            placeholder="/srv/app"
            required
          />
          {form.remotePath && !form.remotePath.trim().startsWith('/') && (
            <p className="text-[11px] text-amber-300">{t('workspaces.remotePathHint')}</p>
          )}
        </>
      )}
      {!isSsh && (
      <>
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
            className="w-full bg-gray-800 border border-gray-700 rounded-sm px-3 py-2 text-sm text-gray-200 focus:outline-hidden focus:border-violet-500"
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
      </>
      )}
      {submitError && (
        <div role="alert" className="text-sm text-red-400">
          <p>{submitError.message}</p>
          {submitError.fingerprint && (
            <Link to={`/projects/${projectId}?tab=ssh`} className="text-cyan-400 hover:text-cyan-300 underline text-xs">
              {t('workspaces.sshConnectionsLink')}
            </Link>
          )}
        </div>
      )}
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="secondary" type="button" onClick={onCancel} disabled={saving}>
          {t('common.cancel')}
        </Button>
        <Button variant="primary" type="submit" disabled={saving || !validName || (isSsh && !validSsh)}>
          {saving ? t('common.saving') : t('common.save')}
        </Button>
      </div>
    </form>
  );
}
