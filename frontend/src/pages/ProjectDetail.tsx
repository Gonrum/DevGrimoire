import { useEffect, useState, useCallback } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { api, Project, Todo, Session, Knowledge, ChangelogEntry, Milestone, Activity, ResearchEntry, Environment, SecretListItem, SchemaObject } from '../api/client';
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
import { useProjectEvents, ProjectChangeEvent } from '../hooks/useProjectEvents';
import Badge from '../components/ui/Badge';
import { LoadingText } from '../components/ui/LoadingSpinner';

type Tab = 'todos' | 'milestones' | 'sessions' | 'knowledge' | 'changelog' | 'activity' | 'environments' | 'secrets' | 'manual' | 'research' | 'schemas';

export default function ProjectDetail() {
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
  const [manualKey, setManualKey] = useState(0);
  const [tab, setTab] = useState<Tab>(() => (searchParams.get('tab') as Tab) || 'todos');
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
    ])
      .then(([p, t, s, k, cl, ms, act, res, env, sec, sch]) => {
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
        manual: () => setManualKey((k) => k + 1),
        research: () => api.research.list(id).then(setResearch),
        environment: () => api.environments.list(id).then(setEnvironments),
        secret: () => api.secrets.list(id).then(setSecrets),
        schema: () => api.schemas.list(id).then(setSchemas),
      };
      refetchers[event.entity]?.();
      api.activities.list(id, 100).then(setActivities);
    },
    [id],
  );

  useProjectEvents(id, handleSSEEvent);

  if (loading) return <LoadingText />;
  if (error) {
    return (
      <div>
        <Link to="/" className="text-sm text-gray-500 hover:text-gray-300 mb-4 inline-block">
          &larr; Alle Projekte
        </Link>
        <div className="bg-red-900/20 border border-red-800 rounded-lg p-4">
          <p className="text-red-400">Fehler: {error}</p>
        </div>
      </div>
    );
  }
  if (!project) return <p className="text-red-400">Projekt nicht gefunden.</p>;

  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: 'todos', label: 'Todos', count: todos.filter((t) => t.status !== 'done').length },
    { key: 'milestones', label: 'Milestones', count: milestones.filter((m) => m.status !== 'done' && !m.archived).length },
    { key: 'sessions', label: 'Sessions', count: sessions.length },
    { key: 'knowledge', label: 'Wissen', count: knowledge.length },
    { key: 'changelog', label: 'Changelog', count: changelog.length },
    { key: 'manual', label: 'Handbuch', count: 0 },
    { key: 'schemas', label: 'Schemas', count: schemas.length },
    { key: 'research', label: 'Recherche', count: research.length },
    { key: 'environments', label: 'Umgebungen', count: environments.length },
    { key: 'secrets', label: 'Secrets', count: secrets.length },
    { key: 'activity', label: 'Aktivität', count: activities.length },
  ];

  return (
    <div>
      <Link to="/" className="text-sm text-gray-500 hover:text-gray-300 mb-4 inline-block">
        &larr; Alle Projekte
      </Link>

      <div className="mb-8">
        <div className="flex flex-wrap items-center gap-2 sm:gap-3 mb-2">
          <h1 className="text-xl sm:text-2xl font-bold">{project.name}</h1>
          <Badge color={project.active ? 'bg-green-900 text-green-300' : 'bg-gray-800 text-gray-500'} rounded="full">
            {project.active ? 'aktiv' : 'inaktiv'}
          </Badge>
          <Link
            to={`/projects/${id}/settings`}
            className="text-xs px-2 py-0.5 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 rounded-full transition-colors"
          >
            Einstellungen
          </Link>
        </div>
        {project.description && (
          <p className="text-gray-400 mb-2">{project.description}</p>
        )}
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs sm:text-sm text-gray-500">
          {project.path && <span>Pfad: {project.path}</span>}
          {project.repository && <span>Repo: {project.repository}</span>}
          <span>Erstellt: {new Date(project.createdAt).toLocaleDateString('de-DE')}</span>
          <span>Aktualisiert: {new Date(project.updatedAt).toLocaleDateString('de-DE')}</span>
        </div>
        {project.techStack.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {project.techStack.map((t) => (
              <Badge key={t} color="bg-blue-900/40 text-blue-300">
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
      </div>

      <div className="border-b border-gray-800 mb-6 -mx-4 sm:mx-0 px-4 sm:px-0 overflow-x-auto">
        <nav className="flex gap-4 sm:gap-6 min-w-max">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`pb-3 text-xs sm:text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${
                tab === t.key
                  ? 'border-blue-500 text-blue-400'
                  : 'border-transparent text-gray-500 hover:text-gray-300'
              }`}
            >
              {t.label}
              <span className="ml-1 sm:ml-1.5 text-xs bg-gray-800 px-1 sm:px-1.5 py-0.5 rounded-full">
                {t.count}
              </span>
            </button>
          ))}
        </nav>
      </div>

      {tab === 'todos' && (
        <TodoBoard
          todos={todos}
          milestones={milestones}
          projectId={id!}
          onUpdate={() => api.todos.list({ projectId: id }).then(setTodos)}
        />
      )}
      {tab === 'milestones' && (
        <MilestoneList
          milestones={milestones}
          todos={todos}
          projectId={id!}
          onUpdate={() => api.milestones.list(id!).then(setMilestones)}
        />
      )}
      {tab === 'sessions' && <SessionList sessions={sessions} />}
      {tab === 'knowledge' && <KnowledgeList entries={knowledge} />}
      {tab === 'changelog' && <ChangelogList entries={changelog} />}
      {tab === 'manual' && <ManualView key={manualKey} projectId={id!} />}
      {tab === 'schemas' && <SchemaList entries={schemas} projectId={id!} />}
      {tab === 'research' && <ResearchList entries={research} />}
      {tab === 'environments' && <EnvironmentList projectId={id!} />}
      {tab === 'secrets' && <SecretsList projectId={id!} />}
      {tab === 'activity' && <ActivityList activities={activities} />}
    </div>
  );
}
