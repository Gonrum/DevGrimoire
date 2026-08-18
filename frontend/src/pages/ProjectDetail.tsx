import { useEffect, useState, useCallback } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, Project, Todo, Session, Knowledge, ChangelogEntry, Milestone, Activity, ResearchEntry, Environment, SecretListItem, SchemaObject, Dependency, Feature, Manual, RecurringTask, Snippet, Attachment, LogStats, Release, Workspace } from '../api/client';
import TodoBoard from '../components/TodoBoard';
import PendingQuestionsWidget from '../components/dashboard/PendingQuestionsWidget';
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
import HarnessView from '../components/HarnessView';
import { harnessSectionCount } from '../lib/harness';
import CommitList from '../components/CommitList';
import RecurringTaskList from '../components/RecurringTaskList';
import SnippetList from '../components/SnippetList';
import WorkspaceList from '../components/WorkspaceList';
import AttachmentList from '../components/AttachmentList';
import LogList from '../components/LogList';
import ReleaseList from '../components/ReleaseList';
import DocsHealthList from '../components/DocsHealthList';
import KnowledgeGraphView from '../components/knowledge-graph/KnowledgeGraphView';
import OracleView from '../components/OracleView';
import { useProjectEvents, ProjectChangeEvent } from '../hooks/useProjectEvents';
import { LoadingText } from '../components/ui/LoadingSpinner';
import ProjectTabShell from '../components/ui/ProjectTabShell';
import { WorkflowProjectTab } from '../components/workflows/WorkflowProjectTab';
import { workflowsApi } from '../api/workflows';
import SshConnectionsTab from '../components/ssh/SshConnectionsTab';
import ProjectAccessTab from '../components/projects/ProjectAccessTab';
import ProjectHeader from '../components/projects/ProjectHeader';
import HttpRequestsTab from '../components/HttpRequestsTab';
import ProjectOverview from '../components/projects/overview/ProjectOverview';
import { useAuth } from '../hooks/useAuth';
import { TAB_ICON, type Tab, type NavGroup } from '../components/projects/tabs';
import ProjectSidebar from '../components/projects/ProjectSidebar';
import { errorMessage } from '../lib/narrow';

/**
 * `?tab=` kommt aus der URL und ist damit beliebiger Text.
 *
 * Vorher stand hier `searchParams.get('tab') as Tab`. Die Behauptung liess
 * jeden Wert durch — und ein unbekannter Wert trifft *keinen* der
 * `tab === …`-Blöcke weiter unten: die Seite rendert dann Kopf und Sidebar,
 * aber einen leeren Inhaltsbereich. `TAB_ICON` ist ein `Record<Tab, …>` und
 * damit die einzige Stelle, an der die gültigen Keys tatsächlich stehen.
 */
function isTab(value: string): value is Tab {
  return Object.prototype.hasOwnProperty.call(TAB_ICON, value);
}

/**
 * Hintergrund-Aktualisierung: SSE-Refetch oder das `onUpdate` eines Kindes.
 *
 * Ein Fehlschlag darf hier weder die bereits gerenderte Seite durch eine
 * Fehlerbox ersetzen (der Nutzer hat gerade etwas anderes getan) noch eine
 * unbehandelte Rejection erzeugen — genau das war vorher der Fall, ein Teil
 * dieser Aufrufe hatte gar kein `catch`.
 */
function backgroundRefresh(p: Promise<unknown>): void {
  void p.catch(() => undefined);
}

export default function ProjectDetail() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const { user, authEnabled } = useAuth();
  const isAdmin = authEnabled && user?.role === 'admin';
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
  const [httpRequestCount, setHttpRequestCount] = useState(0);
  const [sshCount, setSshCount] = useState(0);
  const [workflowCount, setWorkflowCount] = useState(0);
  const [schemas, setSchemas] = useState<SchemaObject[]>([]);
  const [dependencies, setDependencies] = useState<Dependency[]>([]);
  const [features, setFeatures] = useState<Feature[]>([]);
  const [manuals, setManuals] = useState<Manual[]>([]);
  // Zählt die Abschnitte der EIGENEN Ebene — die Entsprechung zum früheren
  // "wie viele Soul-Felder sind hier gefüllt". Geerbtes zählt nicht mit,
  // sonst zeigte jedes Projekt dieselbe Zahl.
  const [harnessSections, setHarnessSections] = useState(0);
  const [recurringTasks, setRecurringTasks] = useState<RecurringTask[]>([]);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [commitCount, setCommitCount] = useState(0);
  const [storageEnabled, setStorageEnabled] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [releases, setReleases] = useState<Release[]>([]);
  const [workspaceCount, setWorkspaceCount] = useState(0);
  const [logStats, setLogStats] = useState<LogStats | null>(null);
  const [openDocProposalsCount, setOpenDocProposalsCount] = useState(0);
  const [openOracleCount, setOpenOracleCount] = useState(0);
  const [logsKey, setLogsKey] = useState(0);
  const [envKey, setEnvKey] = useState(0);
  const [commitsKey, setCommitsKey] = useState(0);
  const [secretsKey, setSecretsKey] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  /*
   * Der aktive Tab wird aus der URL *abgeleitet* statt in State kopiert.
   *
   * Vorher hielt ein `useState` den Tab, und ein Effect schrieb `?tab=` in
   * diesen State und löschte den Parameter danach aus der URL — Kopieren per
   * Effect, genau das Muster hinter `set-state-in-effect`. Der Effect mutierte
   * dabei auch die von `useSearchParams` gelieferte Instanz
   * (`searchParams.delete(...)`), statt eine neue zu bauen.
   *
   * Sichtbarer Unterschied jetzt: `?tab=` bleibt in der Adresszeile stehen.
   * Damit überlebt der Tab einen Reload — vorher landete man nach F5 wieder
   * auf "overview", obwohl man dem Deep-Link gerade erst gefolgt war.
   */
  const tabParam = searchParams.get('tab');
  const tab: Tab = tabParam !== null && isTab(tabParam) ? tabParam : 'overview';
  const setTab = useCallback(
    (next: Tab) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          if (next === 'overview') params.delete('tab');
          else params.set('tab', next);
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );
  useEffect(() => {
    if (id) api.httpRequests.listRequests(id).then((r) => setHttpRequestCount(r.length)).catch(() => {});
  }, [id]);
  // Kept out of the big Promise.all: the SSH list can 403 for users without
  // access, and that must not take the whole project page down.
  useEffect(() => {
    if (id) api.ssh.listForProject(id).then((c) => setSshCount(c.length)).catch(() => {});
  }, [id]);
  // Same filter WorkflowProjectTab uses, so the badge can never disagree with
  // the list it labels (archived ones are excluded server-side by default).
  useEffect(() => {
    if (id) workflowsApi.list({ scope: 'project', projectId: id }).then((w) => setWorkflowCount(w.length)).catch(() => {});
  }, [id]);
  /*
   * `loading` und `error` werden abgeleitet statt im Effect-Rumpf gesetzt
   * (`set-state-in-effect`). `loadedId` hält, zu welchem Projekt die aktuell
   * angezeigten Daten gehören — solange das nicht die Route-`id` ist, wird
   * geladen. Der Fehler trägt seine `id` mit, damit beim Wechsel auf ein
   * anderes Projekt nicht die Fehlerbox des vorigen stehen bleibt.
   */
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ id: string; message: string } | null>(null);
  const loading = id !== undefined && loadedId !== id;
  const error = failure !== null && failure.id === id ? failure.message || t('common.error') : null;

  useEffect(() => {
    if (!id) return;

    const controller = new AbortController();

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
      api.harness.get({ scope: 'project', projectId: id }),
      api.commits.count(id),
      api.recurringTasks.list({ projectId: id }),
      api.snippets.list(id),
      api.attachments.storageStatus(),
      api.logs.stats(id),
      api.releases.list(id),
      api.workspaces.list(id, 'active').catch(() => [] as Workspace[]),
      api.docUpdateProposals.list({ projectId: id, status: 'open', limit: 200 }).catch(() => []),
      api.oracle.list({ projectId: id, status: 'open', limit: 500 }).catch(() => []),
    ])
      .then(([p, t, s, k, cl, ms, act, res, env, sec, sch, deps, feat, man, sl, cc, rts, snip, storage, ls, rels, wss, dprops, oracleOpen]) => {
        if (controller.signal.aborted) return;
        setFailure(null);
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
        setHarnessSections(harnessSectionCount(sl));
        setCommitCount(cc?.count || 0);
        setRecurringTasks(rts);
        setSnippets(snip);
        setStorageEnabled(storage.enabled);
        setLogStats(ls);
        setReleases(rels);
        setWorkspaceCount(wss.length);
        setOpenDocProposalsCount(dprops.length);
        setOpenOracleCount(oracleOpen.length);
        if (storage.enabled) {
          backgroundRefresh(api.attachments.list(id).then(setAttachments));
        }
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        // Leerer Fallback: die lokalisierte Ersatzmeldung setzt das Rendering
        // ein, damit `t` keine Dependency dieses Effects werden muss.
        setFailure({ id, message: errorMessage(err, '') });
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadedId(id);
      });

    return () => controller.abort();
  }, [id]);

  const handleSSEEvent = useCallback(
    (event: ProjectChangeEvent) => {
      if (!id) return;
      const refetchers: Record<string, () => void> = {
        todo: () => backgroundRefresh(api.todos.list({ projectId: id }).then(setTodos)),
        session: () => backgroundRefresh(api.sessions.list(id, 20).then(setSessions)),
        knowledge: () => backgroundRefresh(api.knowledge.list(id).then(setKnowledge)),
        changelog: () => backgroundRefresh(api.changelog.list(id).then(setChangelog)),
        milestone: () => backgroundRefresh(api.milestones.list(id).then(setMilestones)),
        project: () => backgroundRefresh(api.projects.get(id).then(setProject)),
        manual: () => backgroundRefresh(api.manuals.list(id).then(setManuals)),
        research: () => backgroundRefresh(api.research.list(id).then(setResearch)),
        environment: () => { backgroundRefresh(api.environments.list(id).then(setEnvironments)); setEnvKey((k) => k + 1); },
        secret: () => { backgroundRefresh(api.secrets.list(id).then(setSecrets)); setSecretsKey((k) => k + 1); },
        schema: () => backgroundRefresh(api.schemas.list(id).then(setSchemas)),
        dependency: () => backgroundRefresh(api.dependencies.list(id).then(setDependencies)),
        feature: () => backgroundRefresh(api.features.list(id).then(setFeatures)),
        harness: () => backgroundRefresh(api.harness.get({ scope: 'project', projectId: id }).then((h) => { setHarnessSections(harnessSectionCount(h)); })),
        'recurring-task': () => backgroundRefresh(api.recurringTasks.list({ projectId: id }).then(setRecurringTasks)),
        snippet: () => backgroundRefresh(api.snippets.list(id).then(setSnippets)),
        attachment: () => backgroundRefresh(api.attachments.list(id).then(setAttachments)),
        release: () => backgroundRefresh(api.releases.list(id).then(setReleases)),
        log: () => { backgroundRefresh(api.logs.stats(id).then(setLogStats)); setLogsKey((k) => k + 1); },
        commit: () => { backgroundRefresh(api.commits.count(id).then((c) => setCommitCount(c.count))); setCommitsKey((k) => k + 1); },
        workspace: () => backgroundRefresh(api.workspaces.list(id, 'active').then((wss) => setWorkspaceCount(wss.length))),
        'ssh-connection': () => backgroundRefresh(api.ssh.listForProject(id).then((c) => setSshCount(c.length))),
        'workflow-definition': () => backgroundRefresh(workflowsApi.list({ scope: 'project', projectId: id }).then((w) => setWorkflowCount(w.length))),
        'doc-update-proposal': () => backgroundRefresh(api.docUpdateProposals.list({ projectId: id, status: 'open', limit: 200 }).then((d) => setOpenDocProposalsCount(d.length))),
        oracle: () => backgroundRefresh(api.oracle.list({ projectId: id, status: 'open', limit: 500 }).then((d) => setOpenOracleCount(d.length))),
      };
      refetchers[event.entity]?.();
      // Cross-dependencies: todo changes affect milestone progress and vice versa
      if (event.entity === 'todo') {
        backgroundRefresh(api.milestones.list(id).then(setMilestones));
      } else if (event.entity === 'milestone') {
        backgroundRefresh(api.todos.list({ projectId: id }).then(setTodos));
      }
      backgroundRefresh(api.activities.list(id, 100).then(setActivities));
    },
    [id],
  );

  useProjectEvents(id, handleSSEEvent);

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

  const navGroups: NavGroup[] = [
    {
      label: t('sidebar.core'),
      items: [
        { key: 'overview', label: t('projectDetail.tab.overview') },
        { key: 'todos', label: t('projectDetail.tab.todos'), count: todos.filter((t) => t.status !== 'done' && !t.archived).length },
        { key: 'milestones', label: t('projectDetail.tab.milestones'), count: milestones.filter((m) => m.status !== 'done' && !m.archived).length },
        { key: 'sessions', label: t('projectDetail.tab.sessions'), count: sessions.length },
        { key: 'activity', label: t('projectDetail.tab.activity'), count: activities.length },
      ],
    },
    {
      label: t('sidebar.knowledge'),
      items: [
        { key: 'knowledge', label: t('projectDetail.tab.knowledge'), count: knowledge.length },
        { key: 'changelog', label: t('projectDetail.tab.changelog'), count: changelog.length },
        { key: 'manual', label: t('projectDetail.tab.manual'), count: manuals.length },
        { key: 'docs-health', label: t('projectDetail.tab.docsHealth'), count: openDocProposalsCount },
        { key: 'research', label: t('projectDetail.tab.research'), count: research.length },
        { key: 'snippets', label: t('projectDetail.tab.snippets'), count: snippets.length },
        ...(storageEnabled ? [{ key: 'files' as Tab, label: t('projectDetail.tab.files'), count: attachments.length }] : []),
      ],
    },
    {
      label: t('sidebar.catalog'),
      items: [
        { key: 'features', label: t('projectDetail.tab.features'), count: features.length },
        { key: 'graph', label: t('projectDetail.tab.graph'), count: 0 },
        { key: 'oracle', label: t('projectDetail.tab.oracle'), count: openOracleCount },
        { key: 'schemas', label: t('projectDetail.tab.schemas'), count: schemas.length },
        { key: 'dependencies', label: t('projectDetail.tab.dependencies'), count: dependencies.length },
        { key: 'releases', label: t('projectDetail.tab.releases'), count: releases.length },
      ],
    },
    {
      label: t('sidebar.system'),
      items: [
        { key: 'soul', label: t('projectDetail.tab.soul'), count: harnessSections },
        { key: 'workspaces', label: t('projectDetail.tab.workspaces'), count: workspaceCount },
        { key: 'environments', label: t('projectDetail.tab.environments'), count: environments.length },
        { key: 'secrets', label: t('projectDetail.tab.secrets'), count: secrets.length },
        { key: 'http-requests', label: t('projectDetail.tab.httpRequests'), count: httpRequestCount },
        { key: 'ssh', label: t('projectDetail.tab.ssh'), count: sshCount },
        { key: 'recurring-tasks', label: t('projectDetail.tab.recurringTasks'), count: recurringTasks.filter((rt) => rt.active).length },
        { key: 'workflows', label: t('nav.workflows'), count: workflowCount },
        { key: 'commits', label: t('projectDetail.tab.commits'), count: commitCount },
        { key: 'logs', label: t('projectDetail.tab.logs'), count: logStats?.total || 0 },
        // T-337: admin-only "who can access this" view.
        ...(isAdmin ? [{ key: 'access' as Tab, label: t('projectDetail.tab.access'), count: 0 }] : []),
      ],
    },
  ];

  const allTabs = navGroups.flatMap((g) => g.items);
  const currentTab = allTabs.find((i) => i.key === tab);
  const currentTabLabel = currentTab?.label || tab;
  const currentTabCount = currentTab?.count;

  const TAB_DESCRIPTIONS: Partial<Record<Tab, string>> = {
    overview: t('projectDetail.tabDesc.overview'),
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
    'http-requests': t('projectDetail.tabDesc.httpRequests'),
    ssh: t('projectDetail.tabDesc.ssh'),
    'recurring-tasks': t('projectDetail.tabDesc.recurringTasks'),
    commits: t('projectDetail.tabDesc.commits'),
    files: t('projectDetail.tabDesc.files'),
    logs: t('projectDetail.tabDesc.logs'),
    activity: t('projectDetail.tabDesc.activity'),
    manual: t('projectDetail.tabDesc.manual'),
    'docs-health': t('projectDetail.tabDesc.docsHealth'),
    graph: t('projectDetail.tabDesc.graph'),
    oracle: t('projectDetail.tabDesc.oracle'),
    soul: t('projectDetail.tabDesc.soul'),
  };
  const currentTabDescription = TAB_DESCRIPTIONS[tab];

  return (
    <div>
      <ProjectHeader project={project} id={id!} />

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
            <ProjectSidebar
              groups={navGroups}
              activeTab={tab}
              onSelect={(k) => { setTab(k); setSidebarOpen(false); }}
              variant="drawer"
            />
          </div>
        </>
      )}

      <div className="flex gap-6">
        {/* Desktop: Fixed sidebar */}
        <div className="hidden lg:block shrink-0 sticky top-4 self-start max-h-[calc(100vh-2rem)] overflow-y-auto">
          <ProjectSidebar groups={navGroups} activeTab={tab} onSelect={setTab} />
        </div>

        {/* Content area */}
        <div className="flex-1 min-w-0">
          <ProjectTabShell title={currentTabLabel} description={currentTabDescription} count={currentTabCount}>
            {tab === 'overview' && (
              <ProjectOverview
                project={project}
                id={id!}
                todos={todos}
                milestones={milestones}
                activities={activities}
                sessions={sessions}
                environments={environments}
                openOracleCount={openOracleCount}
                openDocProposalsCount={openDocProposalsCount}
                onNavigate={setTab}
              />
            )}
            {tab === 'todos' && (
              <>
                <PendingQuestionsWidget projectId={id} className="mb-4" />
                <TodoBoard
                  todos={todos}
                  milestones={milestones}
                  projectId={id}
                  onUpdate={() => { backgroundRefresh(api.todos.list({ projectId: id }).then(setTodos)); }}
                />
              </>
            )}
            {/*
              Harness ersetzt Soul an dieser Stelle (T-444). Der Tab-Schlüssel
              bleibt `soul`, damit bestehende Deep-Links und gespeicherte
              `?tab=`-Werte weiter funktionieren; die Beschriftung kommt aus
              der Tab-Tabelle.
            */}
            {tab === 'soul' && (
              <HarnessView owner={{ scope: 'project', projectId: id }} resolveProjectId={id} />
            )}
            {tab === 'milestones' && (
              <MilestoneList
                milestones={milestones}
                todos={todos}
                projectId={id!}
                onUpdate={() => { backgroundRefresh(api.milestones.list(id!).then(setMilestones)); }}
              />
            )}
            {tab === 'sessions' && <SessionList sessions={sessions} />}
            {tab === 'knowledge' && <KnowledgeList entries={knowledge} projectId={id} onUpdate={() => { backgroundRefresh(api.knowledge.list(id).then(setKnowledge)); }} />}
            {tab === 'changelog' && <ChangelogList entries={changelog} projectId={id} project={project} onUpdate={() => { backgroundRefresh(api.changelog.list(id!).then(setChangelog)); }} />}
            {tab === 'manual' && <ManualView projectId={id} entries={manuals} onUpdate={() => { backgroundRefresh(api.manuals.list(id!).then(setManuals)); }} />}
            {tab === 'docs-health' && <DocsHealthList projectId={id!} basePath={`/projects/${id!}`} />}
            {tab === 'graph' && <KnowledgeGraphView projectId={id!} basePath={`/projects/${id!}`} />}
            {tab === 'oracle' && <OracleView projectId={id!} basePath={`/projects/${id!}`} />}
            {tab === 'features' && <FeatureList entries={features} projectId={id!} />}
            {tab === 'schemas' && <SchemaList entries={schemas} projectId={id!} />}
            {tab === 'dependencies' && <DependencyList entries={dependencies} projectId={id!} />}
            {tab === 'snippets' && <SnippetList entries={snippets} projectId={id} />}
            {tab === 'workspaces' && <WorkspaceList projectId={id!} />}
            {tab === 'research' && <ResearchList entries={research} projectId={id} onUpdate={() => { backgroundRefresh(api.research.list(id!).then(setResearch)); }} />}
            {tab === 'environments' && <EnvironmentList key={envKey} projectId={id} />}
            {tab === 'secrets' && <SecretsList key={secretsKey} projectId={id} />}
            {tab === 'http-requests' && <HttpRequestsTab projectId={id!} />}
            {tab === 'ssh' && <SshConnectionsTab scope={{ projectId: id! }} />}
            {tab === 'recurring-tasks' && <RecurringTaskList entries={recurringTasks} projectId={id} />}
            {tab === 'workflows' && (
              <WorkflowProjectTab scope="project" projectId={id} />
            )}
            {tab === 'commits' && <CommitList key={commitsKey} projectId={id!} gitRepositories={project.gitRepositories} />}
            {tab === 'files' && <AttachmentList projectId={id!} showUpload />}
            {tab === 'releases' && <ReleaseList entries={releases} projectId={id!} />}
            {tab === 'logs' && <LogList key={logsKey} projectId={id} />}
            {tab === 'activity' && <ActivityList activities={activities} />}
            {tab === 'access' && isAdmin && <ProjectAccessTab projectId={id!} />}
          </ProjectTabShell>
        </div>
      </div>
    </div>
  );
}
