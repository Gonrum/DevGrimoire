import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, Project, Todo, Session, Knowledge, ChangelogEntry } from '../api/client';
import TodoBoard from '../components/TodoBoard';
import SessionList from '../components/SessionList';
import KnowledgeList from '../components/KnowledgeList';
import ChangelogList from '../components/ChangelogList';

type Tab = 'todos' | 'sessions' | 'knowledge' | 'changelog';

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [knowledge, setKnowledge] = useState<Knowledge[]>([]);
  const [changelog, setChangelog] = useState<ChangelogEntry[]>([]);
  const [tab, setTab] = useState<Tab>('todos');
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
    ])
      .then(([p, t, s, k, cl]) => {
        if (controller.signal.aborted) return;
        setProject(p);
        setTodos(t);
        setSessions(s);
        setKnowledge(k);
        setChangelog(cl);
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

  if (loading) return <p className="text-gray-500">Laden...</p>;
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
    { key: 'sessions', label: 'Sessions', count: sessions.length },
    { key: 'knowledge', label: 'Wissen', count: knowledge.length },
    { key: 'changelog', label: 'Changelog', count: changelog.length },
  ];

  return (
    <div>
      <Link to="/" className="text-sm text-gray-500 hover:text-gray-300 mb-4 inline-block">
        &larr; Alle Projekte
      </Link>

      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <h1 className="text-2xl font-bold">{project.name}</h1>
          <span
            className={`text-xs px-2 py-0.5 rounded-full ${
              project.active
                ? 'bg-green-900 text-green-300'
                : 'bg-gray-800 text-gray-500'
            }`}
          >
            {project.active ? 'aktiv' : 'inaktiv'}
          </span>
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
        <div className="flex flex-wrap gap-2 text-sm text-gray-500">
          {project.path && <span>Pfad: {project.path}</span>}
          {project.repository && <span>Repo: {project.repository}</span>}
          <span>Erstellt: {new Date(project.createdAt).toLocaleDateString('de-DE')}</span>
          <span>Aktualisiert: {new Date(project.updatedAt).toLocaleDateString('de-DE')}</span>
        </div>
        {project.techStack.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {project.techStack.map((t) => (
              <span
                key={t}
                className="text-xs bg-blue-900/40 text-blue-300 px-2 py-0.5 rounded"
              >
                {t}
              </span>
            ))}
          </div>
        )}
        {project.components && project.components.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-2">
            {project.components.map((c) => (
              <span
                key={c.name}
                className="text-xs bg-purple-900/40 text-purple-300 px-2 py-0.5 rounded"
              >
                {c.name} <span className="text-purple-400 font-mono">v{c.version}</span>
                {c.path && <span className="text-purple-500 ml-1">({c.path})</span>}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="border-b border-gray-800 mb-6">
        <nav className="flex gap-6">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
                tab === t.key
                  ? 'border-blue-500 text-blue-400'
                  : 'border-transparent text-gray-500 hover:text-gray-300'
              }`}
            >
              {t.label}
              <span className="ml-1.5 text-xs bg-gray-800 px-1.5 py-0.5 rounded-full">
                {t.count}
              </span>
            </button>
          ))}
        </nav>
      </div>

      {tab === 'todos' && (
        <TodoBoard
          todos={todos}
          projectId={id!}
          onUpdate={() => api.todos.list({ projectId: id }).then(setTodos)}
        />
      )}
      {tab === 'sessions' && <SessionList sessions={sessions} />}
      {tab === 'knowledge' && <KnowledgeList entries={knowledge} />}
      {tab === 'changelog' && <ChangelogList entries={changelog} />}
    </div>
  );
}
