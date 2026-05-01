import { useEffect, useState, useCallback } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, Project, Todo, Session, Knowledge, ChangelogEntry, Milestone, Activity, ResearchEntry, Environment, SecretListItem, SchemaObject, Dependency, Feature, Manual, Soul, RecurringTask, Snippet, Attachment, LogStats, Release, Workspace } from '../api/client';
import TodoBoard from '../components/TodoBoard';
import SessionList from '../components/SessionList';
import KnowledgeList from '../components/KnowledgeList';
import ChangelogList from '../components/ChangelogList';
import MilestoneList from '../components/MilestoneList';
import ActivityList from '../components/ActivityList';
import EnvironmentList, { SecretsList } from '../components/EnvironmentList';
import ManualView from '../components/ManualView';
import ResearchList from '../components/ResearchList';
import SchemaList from '../components/SchemaList';
import DependencyList from '../components/DependencyList';
import FeatureList from '../components/FeatureList';
import SoulView from '../components/SoulView';
import CommitList from '../components/CommitList';
import RecurringTaskList from '../components/RecurringTaskList';
import SnippetList from '../components/SnippetList';
import WorkspaceList from '../components/WorkspaceList';
import AttachmentList from '../components/AttachmentList';
import LogList from '../components/LogList';
import ReleaseList from '../components/ReleaseList';
import GitRepoWidget from '../components/GitRepoWidget';
import Markdown from '../components/Markdown';
import { useProjectEvents, ProjectChangeEvent } from '../hooks/useProjectEvents';
import Badge from '../components/ui/Badge';
import { LoadingText } from '../components/ui/LoadingSpinner';
import ProjectTabShell from '../components/ui/ProjectTabShell';

type Tab = 'todos' | 'soul' | 'milestones' | 'sessions' | 'knowledge' | 'changelog' | 'activity' | 'environments' | 'secrets' | 'manual' | 'research' | 'schemas' | 'dependencies' | 'features' | 'commits' | 'recurring-tasks' | 'snippets' | 'files' | 'logs' | 'releases' | 'workspaces';

export default function ProjectDetail() {
  const { t, i18n } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [project, setProject] = useState<Project | null>(null);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [knowledge, setKnowledge] = useState<Knowledge[]>([]);
  const [changelog, setChangelog] = useState<ChangelogEntry[]>([]);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [research, setResearch] = useState<ResearchEntry[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [secrets, setSecrets] = useState<SecretListItem[]>([]);
  const [schemas, setSchemas] = useState<SchemaObject[]>([]);
  const [dependencies, setDependencies] = useState<Dependency[]>([]);
  const [features, setFeatures] = useState<Feature[]>([]);
  const [manuals, setManuals] = useState<Manual[]>([]);
  const [soul, setSoul] = useState<Soul | null>(null);
  const [recurringTasks, setRecurringTasks] = useState<RecurringTask[]>([]);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [commitCount, setCommitCount] = useState(0);
  const [storageEnabled, setStorageEnabled] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [releases, setReleases] = useState<Release[]>([]);
  const [workspaceCount, setWorkspaceCount] = useState(0);
  const [logStats, setLogStats] = useState<LogStats | null>(null);
  const [logsKey, setLogsKey] = useState(0);
  const [envKey, setEnvKey] = useState(0);
  const [commitsKey, setCommitsKey] = useState(0);
  const [secretsKey, setSecretsKey] = useState(0);
  const [tab, setTab] = useState<Tab>(() => (searchParams.get('tab') as Tab) || 'todos');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  useEffect(() => {
    if (searchParams.has('tab')) {
      setTab(searchParams.get('tab') as Tab);
      searchParams.delete('tab');
      setSearchParams(searchParams, { replace: true });
    }
  }, [searchParams]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;

    const controller = new AbortController();
    setLoading(true);
    setError(null);

    Promise.all([
      api.projects.get(id),
      api.todos.list({ projectId: id }),
      api.sessions.list(id, 20),
      api.knowledge.list(id),
      api.changelog.list(id),
      api.milestones.list(id),
      api.activities.list(id, 100),
      api.research.list(id),
      api.environments.list(id),
      api.secrets.list(id),
      api.schemas.list(id),
      api.dependencies.list(id),
      api.features.list(id),
      api.manuals.list(id),
      api.souls.get(id),
      api.commits.count(id),
      api.recurringTasks.list({ projectId: id }),
      api.snippets.list(id),
      api.attachments.storageStatus(),
      api.logs.stats(id),
      api.releases.list(id),
      api.workspaces.list(id, 'active').catch(() => [] as Workspace[]),
    ])
      .then(([p, t, s, k, cl, ms, act, res, env, sec, sch, deps, feat, man, sl, cc, rts, snip, storage, ls, rels, wss]) => {
        if (controller.signal.aborted) return;
        setProject(p);
        setTodos(t);
        setSessions(s);
        setKnowledge(k);
        setChangelog(cl);
        setMilestones(ms);
        setActivities(act);
        setResearch(res);
        setEnvironments(env);
        setSecrets(sec);
        setSchemas(sch);
        setDependencies(deps);
        setFeatures(feat);
        setManuals(man);
        setSoul(sl);
        setCommitCount(cc?.count || 0);
        setRecurringTasks(rts);
        setSnippets(snip);
        setStorageEnabled(storage.enabled);
        setLogStats(ls);
        setReleases(rels);
        setWorkspaceCount(wss.length);
        if (storage.enabled) {
          api.attachments.list(id).then(setAttachments).catch(() => {});
        }
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setError(err.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [id]);

  const handleSSEEvent = useCallback(
    (event: ProjectChangeEvent) => {
      if (!id) return;
      const refetchers: Record<string, () => void> = {
        todo: () => api.todos.list({ projectId: id }).then(setTodos),
        session: () => api.sessions.list(id, 20).then(setSessions),
        knowledge: () => api.knowledge.list(id).then(setKnowledge),
        changelog: () => api.changelog.list(id).then(setChangelog),
        milestone: () => api.milestones.list(id).then(setMilestones),
        project: () => api.projects.get(id).then(setProject),
        manual: () => api.manuals.list(id).then(setManuals),
        research: () => api.research.list(id).then(setResearch),
        environment: () => { api.environments.list(id).then(setEnvironments); setEnvKey((k) => k + 1); },
        secret: () => { api.secrets.list(id).then(setSecrets); setSecretsKey((k) => k + 1); },
        schema: () => api.schemas.list(id).then(setSchemas),
        dependency: () => api.dependencies.list(id).then(setDependencies),
        feature: () => api.features.list(id).then(setFeatures),
        soul: () => api.souls.get(id!).then(setSoul),
        'recurring-task': () => api.recurringTasks.list({ projectId: id }).then(setRecurringTasks),
        snippet: () => api.snippets.list(id).then(setSnippets),
        attachment: () => api.attachments.list(id).then(setAttachments),
        release: () => api.releases.list(id).then(setReleases),
        log: () => { api.logs.stats(id).then(setLogStats); setLogsKey((k) => k + 1); },
        commit: () => { api.commits.count(id).then((c) => setCommitCount(c.count)); setCommitsKey((k) => k + 1); },
        workspace: () => api.workspaces.list(id, 'active').then((wss) => setWorkspaceCount(wss.length)).catch(() => undefined),
      };
      refetchers[event.entity]?.();
      // Cross-dependencies: todo changes affect milestone progress and vice versa
      if (event.entity === 'todo') {
        api.milestones.list(id).then(setMilestones);
      } else if (event.entity === 'milestone') {
        api.todos.list({ projectId: id }).then(setTodos);
      }
      api.activities.list(id, 100).then(setActivities);
    },
    [id],
  );

  useProjectEvents(id, handleSSEEvent);

  const dateFmtLocale = i18n.language === 'de' ? 'de-DE' : 'en-US';

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

  const navGroups: { label: string; items: { key: Tab; label: string; count: number }[] }[] = [
    {
      label: t('sidebar.core'),
      items: [
        { key: 'todos', label: 'Quests', count: todos.filter((t) => t.status !== 'done').length },
        { key: 'milestones', label: i18n.language === 'de' ? 'Artefakte' : 'Artifacts', count: milestones.filter((m) => m.status !== 'done' && !m.archived).length },
        { key: 'sessions', label: i18n.language === 'de' ? 'Rituale' : 'Rituals', count: sessions.length },
        { key: 'activity', label: i18n.language === 'de' ? 'Spuren' : 'Traces', count: activities.length },
      ],
    },
    {
      label: t('sidebar.knowledge'),
      items: [
        { key: 'knowledge', label: t('searchTypes.knowledge'), count: knowledge.length },
        { key: 'changelog', label: i18n.language === 'de' ? 'Chroniken' : 'Chronicles', count: changelog.length },
        { key: 'manual', label: i18n.language === 'de' ? 'Foliant' : 'Tome', count: manuals.length },
        { key: 'research', label: i18n.language === 'de' ? 'Studien' : 'Studies', count: research.length },
        { key: 'snippets', label: i18n.language === 'de' ? 'Runen' : 'Runes', count: snippets.length },
        ...(storageEnabled ? [{ key: 'files' as Tab, label: i18n.language === 'de' ? 'Pergamente' : 'Scrolls', count: attachments.length }] : []),
      ],
    },
    {
      label: t('sidebar.catalog'),
      items: [
        { key: 'features', label: i18n.language === 'de' ? 'Fähigkeiten' : 'Abilities', count: features.length },
        { key: 'schemas', label: i18n.language === 'de' ? 'Blaupausen' : 'Blueprints', count: schemas.length },
        { key: 'dependencies', label: i18n.language === 'de' ? 'Zutaten' : 'Reagents', count: dependencies.length },
        { key: 'releases', label: 'Releases', count: releases.length },
      ],
    },
    {
      label: t('sidebar.system'),
      items: [
        { key: 'soul', label: t('soul.title'), count: (['vision', 'principles', 'conventions', 'communication', 'boundaries', 'workflow', 'quality'] as const).filter((k) => soul?.[k]?.trim()).length },
        { key: 'workspaces', label: i18n.language === 'de' ? 'Werkstätten' : 'Workshops', count: workspaceCount },
        { key: 'environments', label: i18n.language === 'de' ? 'Reiche' : 'Realms', count: environments.length },
        { key: 'secrets', label: i18n.language === 'de' ? 'Siegel' : 'Seals', count: secrets.length },
        { key: 'recurring-tasks', label: i18n.language === 'de' ? 'Riten' : 'Rites', count: recurringTasks.filter((rt) => rt.active).length },
        { key: 'commits', label: i18n.language === 'de' ? 'Vermerke' : 'Inscriptions', count: commitCount },
        { key: 'logs', label: i18n.language === 'de' ? 'Orakel' : 'Oracles', count: logStats?.total || 0 },
      ],
    },
  ];

  const allTabs = navGroups.flatMap((g) => g.items);
  const currentTab = allTabs.find((i) => i.key === tab);
  const currentTabLabel = currentTab?.label || tab;
  const currentTabCount = currentTab?.count;

  const TAB_DESCRIPTIONS: Partial<Record<Tab, string>> = {
    todos: t('projectDetail.tabDesc.todos'),
    milestones: t('projectDetail.tabDesc.milestones'),
    sessions: t('projectDetail.tabDesc.sessions'),
    knowledge: t('projectDetail.tabDesc.knowledge'),
    changelog: t('projectDetail.tabDesc.changelog'),
    research: t('projectDetail.tabDesc.research'),
    snippets: t('projectDetail.tabDesc.snippets'),
    features: t('projectDetail.tabDesc.features'),
    schemas: t('projectDetail.tabDesc.schemas'),
    dependencies: t('projectDetail.tabDesc.dependencies'),
    releases: t('projectDetail.tabDesc.releases'),
    workspaces: t('projectDetail.tabDesc.workspaces'),
    environments: t('projectDetail.tabDesc.environments'),
    secrets: t('projectDetail.tabDesc.secrets'),
    'recurring-tasks': t('projectDetail.tabDesc.recurringTasks'),
    commits: t('projectDetail.tabDesc.commits'),
    files: t('projectDetail.tabDesc.files'),
    logs: t('projectDetail.tabDesc.logs'),
    activity: t('projectDetail.tabDesc.activity'),
    manual: t('projectDetail.tabDesc.manual'),
    soul: t('projectDetail.tabDesc.soul'),
  };
  const currentTabDescription = TAB_DESCRIPTIONS[tab];

  const sidebarNav = (onSelect?: () => void) => (
    <nav className="space-y-5">
      {navGroups.map((group) => (
        <div key={group.label}>
          <h3 className="text-[10px] font-semibold uppercase tracking-wider text-gray-600 px-3 mb-1.5">
            {group.label}
          </h3>
          <ul className="space-y-0.5">
            {group.items.map((item) => (
              <li key={item.key}>
                <button
                  type="button"
                  onClick={() => { setTab(item.key); onSelect?.(); }}
                  className={`w-full text-left px-3 py-1.5 text-sm rounded-lg flex justify-between items-center transition-colors ${
                    tab === item.key
                      ? 'bg-gray-800 text-cyan-400 font-medium'
                      : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'
                  }`}
                >
                  <span className="truncate">{item.label}</span>
                  <span className={`text-xs px-1.5 py-0.5 rounded-full shrink-0 ml-2 ${
                    tab === item.key ? 'bg-gray-700 text-cyan-400' : 'bg-gray-800/80 text-gray-500'
                  }`}>
                    {item.count}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );

  return (
    <div>
      <Link to="/" className="text-sm text-gray-500 hover:text-gray-300 mb-4 inline-block">
        &larr; {t('common.allProjects')}
      </Link>

      <div className="mb-6">
        <div className="flex flex-wrap items-center gap-2 sm:gap-3 mb-2">
          <h1 className="text-xl sm:text-2xl font-bold font-grimoire">{project.name}</h1>
          <Badge color={project.active ? 'bg-green-900 text-green-300' : 'bg-gray-800 text-gray-500'} rounded="full">
            {project.active ? t('common.active') : t('common.inactive')}
          </Badge>
          <Link
            to={`/projects/${id}/settings`}
            className="text-xs px-2 py-0.5 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 rounded-full transition-colors"
          >
            {t('nav.settings')}
          </Link>
        </div>
        {project.description && (
          <div className="mb-2 text-gray-400">
            <Markdown>{project.description}</Markdown>
          </div>
        )}
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs sm:text-sm text-gray-500">
          {project.path && <span>{t('projects.path')}: {project.path}</span>}
          {project.repository && <span>{t('projects.repo')}: {project.repository}</span>}
          <span>{t('common.created')}: {new Date(project.createdAt).toLocaleDateString(dateFmtLocale)}</span>
          <span>{t('common.updated')}: {new Date(project.updatedAt).toLocaleDateString(dateFmtLocale)}</span>
        </div>
        {project.techStack.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {project.techStack.map((t) => (
              <Badge key={t} color="bg-violet-900/40 text-cyan-300">
                {t}
              </Badge>
            ))}
          </div>
        )}
        {project.components && project.components.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-2">
            {project.components.map((c) => (
              <Badge key={c.name} color="bg-purple-900/40 text-purple-300">
                {c.name} <span className="text-purple-400 font-mono">v{c.version}</span>
                {c.path && <span className="text-purple-500 ml-1">({c.path})</span>}
              </Badge>
            ))}
          </div>
        )}
        {project.gitRepositories && project.gitRepositories.length > 0 && (
          <GitRepoWidget
            projectId={id!}
            gitRepositories={project.gitRepositories}
            onNavigateToCommits={() => setTab('commits')}
          />
        )}
      </div>

      {/* Mobile: Sidebar toggle */}
      <button
        type="button"
        onClick={() => setSidebarOpen(true)}
        className="lg:hidden mb-4 flex items-center gap-2 text-sm text-gray-400 hover:text-gray-200 bg-gray-800 hover:bg-gray-700 px-3 py-2 rounded-lg transition-colors"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
          <line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="18" x2="21" y2="18" />
        </svg>
        <span>{currentTabLabel}</span>
      </button>

      {/* Mobile: Sidebar drawer overlay */}
      {sidebarOpen && (
        <>
          <div className="fixed inset-0 bg-black/50 z-40 lg:hidden" onClick={() => setSidebarOpen(false)} />
          <div className="fixed inset-y-0 left-0 w-64 bg-gray-900 border-r border-gray-800 z-50 lg:hidden overflow-y-auto" style={{ paddingTop: 'max(1rem, var(--sat))', paddingBottom: 'max(1rem, var(--sab))', paddingLeft: 'max(0.75rem, var(--sal))' }}>
            <div className="flex items-center justify-between px-3 mb-4 pr-4">
              <span className="text-sm font-semibold text-gray-300">{project.name}</span>
              <button
                type="button"
                onClick={() => setSidebarOpen(false)}
                className="text-gray-500 hover:text-gray-300 p-1"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            {sidebarNav(() => setSidebarOpen(false))}
          </div>
        </>
      )}

      <div className="flex gap-6">
        {/* Desktop: Fixed sidebar */}
        <div className="hidden lg:block shrink-0 w-52 sticky top-4 self-start max-h-[calc(100vh-2rem)] overflow-y-auto">
          {sidebarNav()}
        </div>

        {/* Content area */}
        <div className="flex-1 min-w-0">
          <ProjectTabShell title={currentTabLabel} description={currentTabDescription} count={currentTabCount}>
            {tab === 'todos' && (
              <TodoBoard
                todos={todos}
                milestones={milestones}
                projectId={id!}
                onUpdate={() => api.todos.list({ projectId: id }).then(setTodos)}
              />
            )}
            {tab === 'soul' && <SoulView projectId={id!} soul={soul} onUpdate={() => api.souls.get(id!).then(setSoul)} />}
            {tab === 'milestones' && (
              <MilestoneList
                milestones={milestones}
                todos={todos}
                projectId={id!}
                onUpdate={() => api.milestones.list(id!).then(setMilestones)}
              />
            )}
            {tab === 'sessions' && <SessionList sessions={sessions} />}
            {tab === 'knowledge' && <KnowledgeList entries={knowledge} projectId={id!} onUpdate={() => api.knowledge.list(id!).then(setKnowledge)} />}
            {tab === 'changelog' && <ChangelogList entries={changelog} projectId={id!} project={project} onUpdate={() => api.changelog.list(id!).then(setChangelog)} />}
            {tab === 'manual' && <ManualView projectId={id!} entries={manuals} onUpdate={() => api.manuals.list(id!).then(setManuals)} />}
            {tab === 'features' && <FeatureList entries={features} projectId={id!} />}
            {tab === 'schemas' && <SchemaList entries={schemas} projectId={id!} />}
            {tab === 'dependencies' && <DependencyList entries={dependencies} projectId={id!} />}
            {tab === 'snippets' && <SnippetList entries={snippets} projectId={id!} />}
            {tab === 'workspaces' && <WorkspaceList projectId={id!} />}
            {tab === 'research' && <ResearchList entries={research} projectId={id!} onUpdate={() => api.research.list(id!).then(setResearch)} />}
            {tab === 'environments' && <EnvironmentList key={envKey} projectId={id!} />}
            {tab === 'secrets' && <SecretsList key={secretsKey} projectId={id!} />}
            {tab === 'recurring-tasks' && <RecurringTaskList entries={recurringTasks} projectId={id!} />}
            {tab === 'commits' && <CommitList key={commitsKey} projectId={id!} gitRepositories={project.gitRepositories} />}
            {tab === 'files' && <AttachmentList projectId={id!} showUpload />}
            {tab === 'releases' && <ReleaseList entries={releases} projectId={id!} />}
            {tab === 'logs' && <LogList key={logsKey} projectId={id!} />}
            {tab === 'activity' && <ActivityList activities={activities} />}
          </ProjectTabShell>
        </div>
      </div>
    </div>
  );
}
