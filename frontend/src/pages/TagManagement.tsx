import { Fragment, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, Project, ProjectTag } from '../api/client';
import { useToast } from '../components/Toast';
import { LoadingText } from '../components/ui/LoadingSpinner';
import { SettingsShell } from '../components/ui/SettingsShell';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import { errorMessage } from '../lib/narrow';

type SortKey = 'name' | 'usage';
type DialogState =
  | { kind: 'none' }
  | { kind: 'rename'; tag: string }
  | { kind: 'merge'; tag: string }
  | { kind: 'delete'; tag: string };

export default function TagManagement() {
  const { t } = useTranslation();
  const { showError, showSuccess } = useToast();
  const [tags, setTags] = useState<ProjectTag[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>('usage');
  const [expandedTag, setExpandedTag] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>({ kind: 'none' });
  const [working, setWorking] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [tagRows, projectRows] = await Promise.all([
        api.projects.listTags(),
        api.projects.list(),
      ]);
      setTags(tagRows);
      setProjects(projectRows);
    } catch (err) {
      showError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [showError]);

  /*
   * `reload` wird auch von den Dialog-Aktionen aufgerufen und bleibt deshalb als
   * `useCallback` daneben stehen. Der Aufruf im Effekt liegt in einer eigenen
   * async-Funktion, damit der Effekt-Body selbst nichts synchron setzt.
   */
  useEffect(() => {
    void (async () => { await reload(); })();
  }, [reload]);

  const sortedTags = [...tags].sort((a, b) => {
    if (sortKey === 'usage') {
      if (b.usageCount !== a.usageCount) return b.usageCount - a.usageCount;
      return a.name.localeCompare(b.name);
    }
    return a.name.localeCompare(b.name);
  });

  const projectsForTag = (tag: string): Project[] =>
    projects.filter((p) => (p.tags ?? []).includes(tag));

  const closeDialog = () => setDialog({ kind: 'none' });

  const handleRename = async (to: string) => {
    if (dialog.kind !== 'rename') return;
    if (!to.trim()) return;
    setWorking(true);
    try {
      const { modified } = await api.projects.renameTag(dialog.tag, to.trim());
      closeDialog();
      await reload();
      showSuccess(t('tagManagement.renameSuccess', { count: modified }));
    } catch (err) {
      showError(errorMessage(err));
    } finally {
      setWorking(false);
    }
  };

  const handleMerge = async (target: string) => {
    if (dialog.kind !== 'merge') return;
    if (!target.trim() || target === dialog.tag) return;
    setWorking(true);
    try {
      const { modified } = await api.projects.mergeTags([dialog.tag], target.trim());
      closeDialog();
      await reload();
      showSuccess(t('tagManagement.mergeSuccess', { count: modified }));
    } catch (err) {
      showError(errorMessage(err));
    } finally {
      setWorking(false);
    }
  };

  const handleDelete = async () => {
    if (dialog.kind !== 'delete') return;
    setWorking(true);
    try {
      const { modified } = await api.projects.deleteTag(dialog.tag);
      closeDialog();
      await reload();
      showSuccess(t('tagManagement.deleteSuccess', { count: modified }));
    } catch (err) {
      showError(errorMessage(err));
    } finally {
      setWorking(false);
    }
  };

  if (loading) return <LoadingText />;

  return (
    <SettingsShell title={t('tagManagement.title')}>
      <Link to="/projects" className="text-sm text-gray-500 hover:text-gray-300 mb-4 inline-block">
        &larr; {t('common.allProjects')}
      </Link>
      <p className="mb-6 text-sm text-gray-400">{t('tagManagement.subtitle')}</p>

      {tags.length === 0 ? (
        <p className="text-gray-500 text-sm">{t('tagManagement.noTags')}</p>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-800/60 text-xs uppercase text-gray-500">
              <tr>
                <th className="text-left px-4 py-2">
                  <button
                    type="button"
                    onClick={() => setSortKey('name')}
                    className={sortKey === 'name' ? 'text-violet-300' : 'hover:text-gray-300'}
                  >
                    {t('tagManagement.col.tag')}
                  </button>
                </th>
                <th className="text-left px-4 py-2">
                  <button
                    type="button"
                    onClick={() => setSortKey('usage')}
                    className={sortKey === 'usage' ? 'text-violet-300' : 'hover:text-gray-300'}
                  >
                    {t('tagManagement.col.projects')}
                  </button>
                </th>
                <th className="text-right px-4 py-2">{t('tagManagement.col.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {sortedTags.map((tag) => {
                const expanded = expandedTag === tag.name;
                const tagProjects = expanded ? projectsForTag(tag.name) : [];
                return (
                  <Fragment key={tag.name}>
                    <tr className="border-t border-gray-800 hover:bg-gray-800/40">
                      <td className="px-4 py-2 font-medium text-gray-200">
                        <Badge color="bg-violet-900/40 text-violet-300">#{tag.name}</Badge>
                      </td>
                      <td className="px-4 py-2 text-gray-300">
                        <button
                          type="button"
                          onClick={() => setExpandedTag(expanded ? null : tag.name)}
                          className="text-violet-300 hover:text-violet-200"
                        >
                          {tag.usageCount}
                        </button>
                      </td>
                      <td className="px-4 py-2 text-right">
                        <div className="inline-flex gap-1">
                          <button
                            type="button"
                            onClick={() => setDialog({ kind: 'rename', tag: tag.name })}
                            className="text-xs px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-300"
                          >
                            {t('tagManagement.action.rename')}
                          </button>
                          <button
                            type="button"
                            onClick={() => setDialog({ kind: 'merge', tag: tag.name })}
                            className="text-xs px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-300"
                          >
                            {t('tagManagement.action.merge')}
                          </button>
                          <button
                            type="button"
                            onClick={() => setDialog({ kind: 'delete', tag: tag.name })}
                            className="text-xs px-2 py-1 rounded bg-red-900/40 hover:bg-red-900/70 text-red-300"
                          >
                            {t('tagManagement.action.delete')}
                          </button>
                        </div>
                      </td>
                    </tr>
                    {expanded && tagProjects.length > 0 && (
                      <tr className="bg-gray-950/50">
                        <td colSpan={3} className="px-4 py-2">
                          <ul className="flex flex-wrap gap-2">
                            {tagProjects.map((p) => (
                              <li key={p._id}>
                                <Link
                                  to={`/projects/${p._id}`}
                                  className="text-xs px-2 py-0.5 rounded-full bg-gray-800 hover:bg-violet-900/60 text-gray-300 hover:text-violet-200"
                                >
                                  {p.name}
                                </Link>
                              </li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {dialog.kind !== 'none' && (
        <TagDialog
          dialog={dialog}
          tags={tags}
          projectsCount={projectsForTag(dialog.tag).length}
          onCancel={closeDialog}
          onRename={(to) => { void handleRename(to); }}
          onMerge={(target) => { void handleMerge(target); }}
          onDelete={() => { void handleDelete(); }}
          working={working}
        />
      )}
    </SettingsShell>
  );
}

interface TagDialogProps {
  dialog: Exclude<DialogState, { kind: 'none' }>;
  tags: ProjectTag[];
  projectsCount: number;
  onCancel: () => void;
  onRename: (to: string) => void;
  onMerge: (target: string) => void;
  onDelete: () => void;
  working: boolean;
}

function TagDialog({ dialog, tags, projectsCount, onCancel, onRename, onMerge, onDelete, working }: TagDialogProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  const existingTags = tags.map((t) => t.name).filter((n) => n !== dialog.tag);
  const isImpliedMerge = dialog.kind === 'rename' && existingTags.includes(value.trim());

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 w-full max-w-md space-y-4">
        <h2 className="text-lg font-semibold text-gray-200">
          {dialog.kind === 'rename' && t('tagManagement.dialog.renameTitle', { tag: dialog.tag })}
          {dialog.kind === 'merge' && t('tagManagement.dialog.mergeTitle', { tag: dialog.tag })}
          {dialog.kind === 'delete' && t('tagManagement.dialog.deleteTitle', { tag: dialog.tag })}
        </h2>
        <p className="text-sm text-gray-400">
          {t('tagManagement.dialog.affectedProjects', { count: projectsCount })}
        </p>

        {dialog.kind === 'rename' && (
          <>
            <input
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={t('tagManagement.dialog.newName')}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-violet-500"
              autoFocus
            />
            {isImpliedMerge && (
              <p className="text-xs text-amber-300">
                ⚠ {t('tagManagement.dialog.impliedMerge', { target: value.trim() })}
              </p>
            )}
          </>
        )}

        {dialog.kind === 'merge' && (
          <select
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-violet-500"
            autoFocus
          >
            <option value="">{t('tagManagement.dialog.chooseTarget')}</option>
            {existingTags.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        )}

        {dialog.kind === 'delete' && (
          <p className="text-sm text-red-300">
            {t('tagManagement.dialog.deleteConfirm', { tag: dialog.tag })}
          </p>
        )}

        <div className="flex gap-2 justify-end">
          <Button type="button" onClick={onCancel} disabled={working}>
            {t('common.cancel')}
          </Button>
          {dialog.kind === 'rename' && (
            <Button
              type="button"
              variant="primary"
              onClick={() => onRename(value)}
              disabled={working || !value.trim() || value.trim() === dialog.tag}
            >
              {t('tagManagement.action.rename')}
            </Button>
          )}
          {dialog.kind === 'merge' && (
            <Button
              type="button"
              variant="primary"
              onClick={() => onMerge(value)}
              disabled={working || !value.trim()}
            >
              {t('tagManagement.action.merge')}
            </Button>
          )}
          {dialog.kind === 'delete' && (
            <Button type="button" variant="danger" onClick={onDelete} disabled={working}>
              {t('tagManagement.action.delete')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
