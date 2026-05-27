import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import {
  api,
  Project,
  ResearchSessionEntry,
  ResearchSessionStatus,
} from '../api/client';
import { useToast } from '../components/Toast';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import EmptyState from '../components/ui/EmptyState';
import { LoadingText } from '../components/ui/LoadingSpinner';

export default function ResearchOverview() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { showError, showSuccess } = useToast();
  const [sessions, setSessions] = useState<ResearchSessionEntry[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<ResearchSessionStatus | ''>('');
  const [q, setQ] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const projectsById = useMemo(() => new Map(projects.map((p) => [p._id, p])), [projects]);

  const load = async () => {
    setLoading(true);
    try {
      const [s, p] = await Promise.all([
        api.researchSessions.list({
          status: statusFilter || undefined,
          q: q.trim() || undefined,
        }),
        api.projects.list({ active: true }),
      ]);
      setSessions(s);
      setProjects(p);
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [statusFilter]);

  const handleDelete = async (session: ResearchSessionEntry) => {
    if (!window.confirm(t('researchSessions.deleteConfirm', { title: session.title }))) return;
    setDeletingId(session._id);
    try {
      await api.researchSessions.delete(session._id);
      setSessions((prev) => prev.filter((s) => s._id !== session._id));
      showSuccess(t('researchSessions.deleted'));
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : t('researchSessions.deleteFailed'));
    } finally {
      setDeletingId(null);
    }
  };

  if (loading) return <LoadingText />;

  return (
    <div>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <h1 className="text-xl sm:text-2xl font-bold font-grimoire">{t('researchSessions.overviewTitle')}</h1>
        <Button variant="primary" size="lg" onClick={() => setShowCreate(true)}>
          {t('researchSessions.newSession')}
        </Button>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-6">
        <input
          type="text"
          placeholder={t('researchSessions.searchPlaceholder')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') load();
          }}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500 w-full sm:w-64"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as ResearchSessionStatus | '')}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-violet-500"
        >
          <option value="">{t('researchSessions.statusAll')}</option>
          <option value="open">{t('researchSessions.statusOpen')}</option>
          <option value="in_progress">{t('researchSessions.statusInProgress')}</option>
          <option value="done">{t('researchSessions.statusDone')}</option>
        </select>
      </div>

      {sessions.length === 0 ? (
        <EmptyState message={t('researchSessions.noSessions')} />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {sessions.map((s) => (
            <div
              key={s._id}
              className="group relative bg-gray-900 border border-gray-800 rounded-lg hover:border-violet-500 transition-colors"
            >
              <Link to={`/research/${s._id}`} className="block p-5">
                <div className="flex items-center justify-between mb-2 pr-7">
                  <span className="text-xs text-gray-500 font-mono">{s.displayNumber}</span>
                  <Badge color={statusColor(s.status)} rounded="full">
                    {t(`researchSessions.status${capitalize(s.status)}` as never)}
                  </Badge>
                </div>
                <h2 className="text-lg font-semibold mb-3">{s.title}</h2>
                {s.projectIds.length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-2">
                    {s.projectIds.map((pid) => {
                      const p = projectsById.get(pid);
                      return (
                        <Badge key={pid} color="bg-violet-900/40 text-violet-300">
                          {p ? p.name : t('researchSessions.unknownProject')}
                        </Badge>
                      );
                    })}
                  </div>
                )}
                <p className="text-xs text-gray-600 mt-3">
                  {t('common.updated')}: {new Date(s.updatedAt).toLocaleString()}
                </p>
              </Link>
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  handleDelete(s);
                }}
                disabled={deletingId === s._id}
                aria-label={t('researchSessions.delete')}
                title={t('researchSessions.delete')}
                className="absolute top-3 right-3 p-1.5 rounded text-gray-500 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-red-500/10 hover:text-red-400 transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      {showCreate && (
        <CreateSessionDialog
          projects={projects}
          onCancel={() => setShowCreate(false)}
          onCreated={(id) => navigate(`/research/${id}`)}
        />
      )}
    </div>
  );
}

function statusColor(status: ResearchSessionStatus): string {
  switch (status) {
    case 'open':
      return 'bg-gray-800 text-gray-400';
    case 'in_progress':
      return 'bg-cyan-900/40 text-cyan-300';
    case 'done':
      return 'bg-green-900/40 text-green-300';
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/_./g, (m) => m[1].toUpperCase());
}

interface CreateSessionDialogProps {
  projects: Project[];
  onCancel: () => void;
  onCreated: (id: string) => void;
}

function CreateSessionDialog({ projects, onCancel, onCreated }: CreateSessionDialogProps) {
  const { t } = useTranslation();
  const { showError } = useToast();
  const [title, setTitle] = useState('');
  const [selectedProjects, setSelectedProjects] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const toggle = (id: string) => {
    setSelectedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleCreate = async () => {
    if (!title.trim()) return;
    setSaving(true);
    try {
      const session = await api.researchSessions.create({
        title: title.trim(),
        projectIds: [...selectedProjects],
      });
      onCreated(session._id);
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 w-full max-w-lg space-y-4">
        <h2 className="text-lg font-semibold text-gray-200">{t('researchSessions.createTitle')}</h2>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t('researchSessions.titlePlaceholder')}
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-violet-500"
          autoFocus
        />

        <div>
          <p className="text-xs font-medium text-gray-400 mb-2">{t('researchSessions.selectProjects')}</p>
          <div className="max-h-60 overflow-y-auto space-y-1 border border-gray-800 rounded-lg p-2">
            {projects.length === 0 ? (
              <p className="text-sm text-gray-500 px-2 py-1">{t('researchSessions.noProjects')}</p>
            ) : (
              projects.map((p) => (
                <label
                  key={p._id}
                  className="flex items-center gap-2 px-2 py-1 hover:bg-gray-800 rounded cursor-pointer text-sm text-gray-200"
                >
                  <input
                    type="checkbox"
                    checked={selectedProjects.has(p._id)}
                    onChange={() => toggle(p._id)}
                    className="rounded border-gray-600 bg-gray-800 text-violet-500 focus:ring-violet-500"
                  />
                  <span>{p.name}</span>
                </label>
              ))
            )}
          </div>
        </div>

        <div className="flex gap-2 justify-end">
          <Button type="button" onClick={onCancel} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={handleCreate}
            disabled={saving || !title.trim() || selectedProjects.size === 0}
          >
            {t('researchSessions.createAction')}
          </Button>
        </div>
      </div>
    </div>
  );
}
