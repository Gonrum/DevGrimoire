import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, Project, Todo } from '../api/client';
import { useDashboardEvents } from '../hooks/useProjectEvents';
import { useToast } from '../components/Toast';
import { STATUS_LABELS, STATUS_COLORS, PRIORITY_COLORS, PRIORITY_LABELS } from '../components/todo-utils';
import Badge from '../components/ui/Badge';
import { LoadingText } from '../components/ui/LoadingSpinner';

export default function Dashboard() {
  const { t, i18n } = useTranslation();
  const [favorites, setFavorites] = useState<Project[]>([]);
  const [activeTodos, setActiveTodos] = useState<Todo[]>([]);
  const [projectMap, setProjectMap] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { showError } = useToast();

  const loadData = async () => {
    try {
      const [favProjects, allProjects, todos] = await Promise.all([
        api.projects.list({ favorite: true }),
        api.projects.list(),
        api.todos.list({ status: 'in_progress,review' }),
      ]);
      setFavorites(favProjects);
      // Build project name map for todo display
      const map: Record<string, string> = {};
      for (const p of allProjects) map[p._id] = p.name;
      setProjectMap(map);
      setActiveTodos(todos);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const toggleFavorite = async (e: React.MouseEvent, project: Project) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await api.projects.update(project._id, { favorite: !project.favorite });
      loadData();
    } catch (err: any) {
      showError(err.message || t('dashboard.favoriteError'));
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  useDashboardEvents(() => loadData());

  const dateLocale = i18n.language === 'de' ? 'de-DE' : 'en-US';

  if (loading) return <LoadingText />;
  if (error) {
    return (
      <div className="bg-red-900/20 border border-red-800 rounded-lg p-4">
        <p className="text-red-400">{t('common.errorLoading', { error })}</p>
      </div>
    );
  }

  return (
    <div>
      {/* Favoriten-Projekte */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-2xl font-bold font-grimoire">{t('dashboard.title')}</h1>
          <Link
            to="/projects"
            className="text-sm text-gray-400 hover:text-cyan-400 transition-colors"
          >
            {t('dashboard.allProjects')}
          </Link>
        </div>

        {favorites.length === 0 ? (
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 text-center">
            <p className="text-gray-500 mb-2">{t('dashboard.noFavorites')}</p>
            <Link
              to="/projects"
              className="text-sm text-cyan-400 hover:text-cyan-300"
            >
              {t('dashboard.markFavorites')}
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {favorites.map((p) => (
              <Link
                key={p._id}
                to={`/projects/${p._id}`}
                className="block bg-gray-900 border border-gray-800 rounded-lg p-5 hover:border-violet-500 transition-colors"
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={(e) => toggleFavorite(e, p)}
                      className="text-lg leading-none text-yellow-400 hover:text-yellow-300 transition-colors"
                      title={t('dashboard.removeFavorite')}
                      aria-label={t('dashboard.removeFavorite')}
                    >
                      &#9733;
                    </button>
                    <h2 className="text-lg font-semibold">{p.name}</h2>
                  </div>
                  <Badge color={p.active ? 'bg-green-900 text-green-300' : 'bg-gray-800 text-gray-500'} rounded="full">
                    {p.active ? t('common.active') : t('common.inactive')}
                  </Badge>
                </div>
                {p.description && (
                  <p className="text-sm text-gray-400 mb-3 line-clamp-2">
                    {p.description}
                  </p>
                )}
                {p.techStack.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {p.techStack.map((tech) => (
                      <Badge key={tech} color="bg-gray-800 text-gray-300">
                        {tech}
                      </Badge>
                    ))}
                  </div>
                )}
                <p className="text-xs text-gray-600 mt-3">
                  {t('common.updated')}: {new Date(p.updatedAt).toLocaleDateString(dateLocale)}
                </p>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Aktive Tasks */}
      <div>
        <h2 className="text-xl font-bold mb-4">{t('dashboard.activeTasks')}</h2>
        {activeTodos.length === 0 ? (
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 text-center">
            <p className="text-gray-500">{t('dashboard.noActiveTasks')}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {activeTodos.map((todo) => (
              <Link
                key={todo._id}
                to={`/projects/${todo.projectId}?tab=todos`}
                className="flex items-center gap-3 bg-gray-900 border border-gray-800 rounded-lg px-4 py-3 hover:border-violet-500 transition-colors"
              >
                <Badge color={STATUS_COLORS[todo.status]} rounded="full" className="whitespace-nowrap">
                  {STATUS_LABELS[todo.status]()}
                </Badge>
                <span
                  className={`text-xs whitespace-nowrap ${PRIORITY_COLORS[todo.priority]}`}
                >
                  {PRIORITY_LABELS[todo.priority]()}
                </span>
                <span className="text-sm text-gray-200 truncate flex-1">
                  {todo.title}
                </span>
                <span className="text-xs text-gray-600 whitespace-nowrap">
                  {projectMap[todo.projectId] || t('common.unknown')}
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
