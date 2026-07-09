import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Play } from 'lucide-react';
import { api, Customer, Project, ResearchRunStatus, ResearchTopicDetail } from '../api/client';
import { useToast } from '../components/Toast';
import { LoadingText } from '../components/ui/LoadingSpinner';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import Switch from '../components/ui/Switch';
import { SCOPE_GLOBAL_BADGE, SCOPE_PROJECT_BADGE } from '../components/ui/badge-tokens';
import ArtifactList from '../components/research/ArtifactList';
import RunLog, { RunLogHandle } from '../components/research/RunLog';
import TopicSettings from '../components/research/TopicSettings';

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

function isRunStatus(status: string | undefined): status is ResearchRunStatus {
  return !!status && status in RUN_STATUS_COLORS;
}

type TopicTab = 'artifacts' | 'runs' | 'settings';
const TABS: TopicTab[] = ['artifacts', 'runs', 'settings'];

/**
 * Header scope chips, resolved to project/customer names (unlike the
 * overview grid's compact count-only chips — this page already loads the
 * full project/customer lists for `TopicSettings`, so showing names here is
 * free and more useful on a detail page).
 */
function ScopeChips({
  topic,
  projectsById,
  customersById,
}: {
  topic: ResearchTopicDetail;
  projectsById: Map<string, Project>;
  customersById: Map<string, Customer>;
}) {
  const { t } = useTranslation();
  const chips: { key: string; label: string; color: string }[] = [];

  if (topic.scope.mode === 'all') {
    chips.push({ key: 'all', label: t('researchTopics.scopeAll'), color: SCOPE_GLOBAL_BADGE });
  } else {
    for (const pid of topic.scope.projectIds) {
      chips.push({ key: `p-${pid}`, label: projectsById.get(pid)?.name ?? pid, color: SCOPE_PROJECT_BADGE });
    }
    for (const cid of topic.scope.customerIds) {
      chips.push({ key: `c-${cid}`, label: customersById.get(cid)?.name ?? cid, color: SCOPE_PROJECT_BADGE });
    }
    if (topic.scope.projectIds.length === 0 && topic.scope.customerIds.length === 0) {
      chips.push({ key: 'none', label: t('researchTopics.scopeNoneSelected'), color: SCOPE_PROJECT_BADGE });
    }
  }
  if (topic.scope.includeGlobal) {
    chips.push({ key: 'global', label: t('researchTopics.scopeIncludesGlobal'), color: SCOPE_GLOBAL_BADGE });
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {chips.map((chip) => (
        <Badge key={chip.key} color={chip.color} rounded="full">{chip.label}</Badge>
      ))}
    </div>
  );
}

export default function ResearchTopicPage() {
  const { id } = useParams<{ id: string }>();
  const { t, i18n } = useTranslation();
  const { showError } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const [topic, setTopic] = useState<ResearchTopicDetail | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [togglingActive, setTogglingActive] = useState(false);

  // Bumped after a run finishes so `ArtifactList` reloads (a run may have
  // created/updated artifacts out-of-band, without ArtifactList's own
  // knowledge).
  const [artifactsRefreshToken, setArtifactsRefreshToken] = useState(0);

  const runLogRef = useRef<RunLogHandle>(null);

  const tabParam = searchParams.get('tab') as TopicTab | null;
  const activeTab: TopicTab = tabParam && TABS.includes(tabParam) ? tabParam : 'artifacts';
  const setActiveTab = (tab: TopicTab) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('tab', tab);
      return next;
    }, { replace: true });
  };

  const projectsById = useMemo(() => new Map(projects.map((p) => [p._id, p])), [projects]);
  const customersById = useMemo(() => new Map(customers.map((c) => [c._id, c])), [customers]);

  const load = async () => {
    if (!id) return;
    setLoading(true);
    try {
      const [t0, p, c] = await Promise.all([
        api.researchTopics.get(id),
        api.projects.list({ active: true }),
        api.customers.list(),
      ]);
      setTopic(t0);
      setProjects(p);
      setCustomers(c);
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : String(err));
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (!id) return null;
  if (loading) return <LoadingText />;
  if (notFound || !topic) {
    return (
      <div>
        <Link to="/research" className="text-sm text-gray-500 hover:text-gray-300 mb-4 inline-block">
          &larr; {t('researchTopics.backToOverview')}
        </Link>
        <div className="bg-red-900/20 border border-red-800 rounded-lg p-4">
          <p className="text-red-400">{t('researchTopics.notFound')}</p>
        </div>
      </div>
    );
  }

  const saveTitle = async () => {
    if (!titleDraft.trim() || titleDraft === topic.title) {
      setEditingTitle(false);
      return;
    }
    try {
      const updated = await api.researchTopics.update(id, { title: titleDraft.trim() });
      setTopic(updated);
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : t('researchTopics.titleSaveFailed'));
    } finally {
      setEditingTitle(false);
    }
  };

  const toggleActive = async () => {
    setTogglingActive(true);
    try {
      const updated = await api.researchTopics.update(id, {
        schedule: {
          frequency: topic.schedule.frequency,
          hour: topic.schedule.hour,
          dayOfWeek: topic.schedule.dayOfWeek,
          dayOfMonth: topic.schedule.dayOfMonth,
          month: topic.schedule.month,
          active: !topic.schedule.active,
        },
      });
      setTopic(updated);
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : t('researchTopics.toggleFailed'));
    } finally {
      setTogglingActive(false);
    }
  };

  const handleRunNow = () => {
    setActiveTab('runs');
    runLogRef.current?.startRun();
  };

  const locale = i18n.language === 'de' ? 'de-DE' : 'en-US';

  return (
    <div className="max-w-6xl mx-auto">
      <div className="mb-4">
        <Link to="/research" className="text-sm text-gray-500 hover:text-gray-300">
          &larr; {t('researchTopics.backToOverview')}
        </Link>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <span className="text-sm font-mono text-gray-500 shrink-0">{topic.displayNumber}</span>
          {editingTitle ? (
            <input
              autoFocus
              type="text"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveTitle();
                if (e.key === 'Escape') setEditingTitle(false);
              }}
              className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-lg font-semibold text-gray-200 focus:outline-none focus:border-violet-500"
            />
          ) : (
            <h1
              className="text-lg sm:text-xl font-semibold font-grimoire cursor-pointer hover:text-violet-300 truncate"
              onClick={() => {
                setTitleDraft(topic.title);
                setEditingTitle(true);
              }}
            >
              {topic.title}
            </h1>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Switch checked={topic.schedule.active} onChange={toggleActive} disabled={togglingActive} label={t('researchTopics.toggleActive')} />
          <span className="text-xs text-gray-500 mr-2">{t('researchTopics.toggleActive')}</span>
          <Button type="button" variant="primary" size="sm" onClick={handleRunNow}>
            <Play className="w-3.5 h-3.5 inline -mt-0.5 mr-1" />
            {t('researchTopics.runNow')}
          </Button>
        </div>
      </div>

      <div className="space-y-2 mb-5">
        <ScopeChips topic={topic} projectsById={projectsById} customersById={customersById} />
        <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
          <Badge color="bg-gray-800 text-gray-300" rounded="full">{t(`recurringTasks.freq_${topic.schedule.frequency}`)}</Badge>
          <Badge color={topic.schedule.active ? SCHEDULE_ACTIVE_BADGE : SCHEDULE_PAUSED_BADGE} rounded="full">
            {topic.schedule.active ? t('common.active') : t('common.inactive')}
          </Badge>
          <span>
            {t('researchTopics.nextRun')}: {topic.schedule.nextRun ? new Date(topic.schedule.nextRun).toLocaleString(locale) : t('researchTopics.noNextRun')}
          </span>
          <span className="flex items-center gap-1.5">
            {t('researchTopics.lastRun')}:
            {topic.schedule.lastRun ? (
              <Badge color={isRunStatus(topic.schedule.lastRunStatus) ? RUN_STATUS_COLORS[topic.schedule.lastRunStatus] : NEVER_RUN_BADGE} rounded="full">
                {isRunStatus(topic.schedule.lastRunStatus) ? t(`researchTopics.runStatus_${topic.schedule.lastRunStatus}`) : topic.schedule.lastRunStatus}
              </Badge>
            ) : (
              <Badge color={NEVER_RUN_BADGE} rounded="full">{t('researchTopics.neverRun')}</Badge>
            )}
          </span>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-800 mb-5 -mx-1 px-1 overflow-x-auto">
        {TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={`px-3 py-2 text-sm whitespace-nowrap transition-colors border-b-2 -mb-px ${
              activeTab === tab
                ? 'border-violet-500 text-violet-300 font-medium'
                : 'border-transparent text-gray-500 hover:text-gray-300 hover:border-gray-700'
            }`}
          >
            {t(`researchTopics.tab${tab.charAt(0).toUpperCase()}${tab.slice(1)}` as never)}
          </button>
        ))}
      </div>

      {/* Tab panels — kept mounted (hidden via CSS, not unmounted) so
          RunLog's SSE connection survives switching tabs. */}
      <div className={activeTab === 'artifacts' ? 'block' : 'hidden'}>
        <ArtifactList key={id} topicId={id} refreshToken={artifactsRefreshToken} />
      </div>
      <div className={activeTab === 'runs' ? 'block' : 'hidden'}>
        <RunLog key={id} ref={runLogRef} topicId={id} onRunFinished={() => setArtifactsRefreshToken((n) => n + 1)} />
      </div>
      <div className={activeTab === 'settings' ? 'block' : 'hidden'}>
        <TopicSettings key={id} topic={topic} projects={projects} customers={customers} onSaved={setTopic} />
      </div>
    </div>
  );
}
