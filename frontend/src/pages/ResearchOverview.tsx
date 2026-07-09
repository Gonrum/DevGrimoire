import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import {
  api,
  Customer,
  Project,
  ResearchRunStatus,
  ResearchScope,
  ResearchTopic,
} from '../api/client';
import { useToast } from '../components/Toast';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import EmptyState from '../components/ui/EmptyState';
import { LoadingText } from '../components/ui/LoadingSpinner';
import Switch from '../components/ui/Switch';
import { SCOPE_GLOBAL_BADGE, SCOPE_PROJECT_BADGE } from '../components/ui/badge-tokens';
import CreateTopicDialog from '../components/research/CreateTopicDialog';

const RUN_STATUS_COLORS: Record<ResearchRunStatus, string> = {
  queued: 'bg-gray-800 text-gray-400',
  running: 'bg-cyan-900/40 text-cyan-300',
  done: 'bg-green-900/40 text-green-300',
  error: 'bg-red-900/40 text-red-400',
  cancelled: 'bg-gray-800 text-gray-500',
};

const NEVER_RUN_BADGE = 'bg-gray-800 text-gray-500';
const SCHEDULE_ACTIVE_BADGE = 'bg-green-900/40 text-green-300';
const SCHEDULE_PAUSED_BADGE = 'bg-gray-800 text-gray-500';

type ActiveFilter = '' | 'active' | 'paused';

export default function ResearchOverview() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { showError, showSuccess } = useToast();
  const [topics, setTopics] = useState<ResearchTopic[]>([]);
  const [artifactCounts, setArtifactCounts] = useState<Record<string, number>>({});
  const [projects, setProjects] = useState<Project[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>('');
  const [q, setQ] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [fetchedTopics, fetchedProjects, fetchedCustomers] = await Promise.all([
        api.researchTopics.list({
          active: activeFilter === '' ? undefined : activeFilter === 'active',
          q: q.trim() || undefined,
        }),
        api.projects.list({ active: true }),
        api.customers.list(),
      ]);
      setTopics(fetchedTopics);
      setProjects(fetchedProjects);
      setCustomers(fetchedCustomers);

      // Artifact counts aren't part of the list payload — fetch per topic in
      // parallel, tolerating individual failures so one broken topic doesn't
      // blank out the whole grid.
      const results = await Promise.allSettled(
        fetchedTopics.map((topic) => api.researchTopics.artifactsList(topic._id)),
      );
      const counts: Record<string, number> = {};
      results.forEach((result, i) => {
        if (result.status === 'fulfilled') counts[fetchedTopics[i]._id] = result.value.length;
      });
      setArtifactCounts(counts);
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFilter]);

  const handleDelete = async (topic: ResearchTopic) => {
    if (!window.confirm(t('researchTopics.deleteConfirm', { title: topic.title }))) return;
    setDeletingId(topic._id);
    try {
      await api.researchTopics.delete(topic._id);
      setTopics((prev) => prev.filter((x) => x._id !== topic._id));
      showSuccess(t('researchTopics.deleted'));
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : t('researchTopics.deleteFailed'));
    } finally {
      setDeletingId(null);
    }
  };

  const handleToggleActive = async (topic: ResearchTopic, nextActive: boolean) => {
    setTogglingId(topic._id);
    try {
      const updated = await api.researchTopics.update(topic._id, {
        schedule: {
          frequency: topic.schedule.frequency,
          hour: topic.schedule.hour,
          dayOfWeek: topic.schedule.dayOfWeek,
          dayOfMonth: topic.schedule.dayOfMonth,
          month: topic.schedule.month,
          active: nextActive,
        },
      });
      setTopics((prev) => prev.map((x) => (x._id === topic._id ? updated : x)));
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : t('researchTopics.toggleFailed'));
    } finally {
      setTogglingId(null);
    }
  };

  if (loading) return <LoadingText />;

  return (
    <div>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <h1 className="text-xl sm:text-2xl font-bold font-grimoire">{t('researchTopics.overviewTitle')}</h1>
        <Button variant="primary" size="lg" onClick={() => setShowCreate(true)}>
          {t('researchTopics.newTopic')}
        </Button>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-6">
        <input
          type="text"
          placeholder={t('researchTopics.searchPlaceholder')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') load();
          }}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500 w-full sm:w-64"
        />
        <select
          value={activeFilter}
          onChange={(e) => setActiveFilter(e.target.value as ActiveFilter)}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-violet-500"
        >
          <option value="">{t('researchTopics.filterAll')}</option>
          <option value="active">{t('researchTopics.filterActive')}</option>
          <option value="paused">{t('researchTopics.filterPaused')}</option>
        </select>
      </div>

      {topics.length === 0 ? (
        <EmptyState message={t('researchTopics.noTopics')} />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {topics.map((topic) => (
            <div
              key={topic._id}
              className="group relative bg-gray-900 border border-gray-800 rounded-lg hover:border-violet-500 transition-colors flex flex-col"
            >
              <Link to={`/research/${topic._id}`} className="block p-5 pb-3">
                <div className="flex items-center justify-between mb-2 pr-7">
                  <span className="text-xs text-gray-500 font-mono">{topic.displayNumber}</span>
                  <div className="flex items-center gap-1.5 flex-wrap justify-end">
                    <Badge color="bg-gray-800 text-gray-300" rounded="full">
                      {t(`recurringTasks.freq_${topic.schedule.frequency}`)}
                    </Badge>
                    <Badge
                      color={topic.schedule.active ? SCHEDULE_ACTIVE_BADGE : SCHEDULE_PAUSED_BADGE}
                      rounded="full"
                    >
                      {topic.schedule.active ? t('common.active') : t('common.inactive')}
                    </Badge>
                  </div>
                </div>
                <h2 className="text-lg font-semibold mb-3">{topic.title}</h2>

                <div className="flex flex-wrap gap-1 mb-3">
                  {renderScopeChips(topic.scope, t)}
                </div>

                <div className="space-y-1.5 text-xs text-gray-500">
                  <p>
                    {t('researchTopics.nextRun')}:{' '}
                    {topic.schedule.nextRun
                      ? new Date(topic.schedule.nextRun).toLocaleString()
                      : t('researchTopics.noNextRun')}
                  </p>
                  <p className="flex items-center gap-1.5">
                    {t('researchTopics.lastRun')}:
                    {topic.schedule.lastRun ? (
                      <Badge
                        color={
                          isRunStatus(topic.schedule.lastRunStatus)
                            ? RUN_STATUS_COLORS[topic.schedule.lastRunStatus]
                            : NEVER_RUN_BADGE
                        }
                        rounded="full"
                      >
                        {isRunStatus(topic.schedule.lastRunStatus)
                          ? t(`researchTopics.runStatus_${topic.schedule.lastRunStatus}`)
                          : topic.schedule.lastRunStatus}
                      </Badge>
                    ) : (
                      <Badge color={NEVER_RUN_BADGE} rounded="full">{t('researchTopics.neverRun')}</Badge>
                    )}
                  </p>
                  <p>{t('researchTopics.artifactCount', { count: artifactCounts[topic._id] ?? 0 })}</p>
                </div>
              </Link>

              <div className="mt-auto flex items-center justify-between gap-2 px-5 py-3 border-t border-gray-800/70">
                <div className="flex items-center gap-2">
                  <Switch
                    checked={topic.schedule.active}
                    onChange={(next) => handleToggleActive(topic, next)}
                    disabled={togglingId === topic._id}
                    label={t('researchTopics.toggleActive')}
                  />
                  <span className="text-xs text-gray-500">{t('researchTopics.toggleActive')}</span>
                </div>
                <Button
                  type="button"
                  variant="accent"
                  size="xs"
                  onClick={() => navigate(`/research/${topic._id}`)}
                >
                  {t('researchTopics.runNow')}
                </Button>
              </div>

              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  handleDelete(topic);
                }}
                disabled={deletingId === topic._id}
                aria-label={t('researchTopics.delete')}
                title={t('researchTopics.delete')}
                className="absolute top-3 right-3 p-1.5 rounded text-gray-500 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-red-500/10 hover:text-red-400 transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      {showCreate && (
        <CreateTopicDialog
          projects={projects}
          customers={customers}
          onCancel={() => setShowCreate(false)}
          onCreated={(id) => navigate(`/research/${id}`)}
        />
      )}
    </div>
  );
}

function isRunStatus(status: string | undefined): status is ResearchRunStatus {
  return !!status && status in RUN_STATUS_COLORS;
}

/**
 * Renders count-based scope chips (all/selected + project/customer counts +
 * global inclusion) — deliberately not resolving entity names here, only
 * counts, to keep the card compact. A fully resolved scope listing belongs
 * on the detail page (Task 20).
 */
function renderScopeChips(scope: ResearchScope, t: (key: string, opts?: Record<string, unknown>) => string) {
  const chips: { key: string; label: string; color: string }[] = [];

  if (scope.mode === 'all') {
    chips.push({ key: 'all', label: t('researchTopics.scopeAll'), color: SCOPE_GLOBAL_BADGE });
  } else {
    if (scope.projectIds.length > 0) {
      chips.push({
        key: 'projects',
        label: t('researchTopics.scopeProjectsCount', { count: scope.projectIds.length }),
        color: SCOPE_PROJECT_BADGE,
      });
    }
    if (scope.customerIds.length > 0) {
      chips.push({
        key: 'customers',
        label: t('researchTopics.scopeCustomersCount', { count: scope.customerIds.length }),
        color: SCOPE_PROJECT_BADGE,
      });
    }
    if (scope.projectIds.length === 0 && scope.customerIds.length === 0) {
      chips.push({ key: 'none', label: t('researchTopics.scopeNoneSelected'), color: SCOPE_PROJECT_BADGE });
    }
  }

  if (scope.includeGlobal) {
    chips.push({ key: 'global', label: t('researchTopics.scopeIncludesGlobal'), color: SCOPE_GLOBAL_BADGE });
  }

  return chips.map((chip) => (
    <Badge key={chip.key} color={chip.color} rounded="full">{chip.label}</Badge>
  ));
}
