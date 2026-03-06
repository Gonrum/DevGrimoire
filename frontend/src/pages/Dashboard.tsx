import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, Project } from '../api/client';

export default function Dashboard() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.projects
      .list()
      .then(setProjects)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="text-gray-500">Laden...</p>;
  if (error) {
    return (
      <div className="bg-red-900/20 border border-red-800 rounded-lg p-4">
        <p className="text-red-400">Fehler beim Laden: {error}</p>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Projekte</h1>
      {projects.length === 0 ? (
        <p className="text-gray-500">
          Noch keine Projekte. Claude kann welche per MCP anlegen.
        </p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {projects.map((p) => (
            <Link
              key={p._id}
              to={`/projects/${p._id}`}
              className="block bg-gray-900 border border-gray-800 rounded-lg p-5 hover:border-blue-500 transition-colors"
            >
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-lg font-semibold">{p.name}</h2>
                <span
                  className={`text-xs px-2 py-0.5 rounded-full ${
                    p.active
                      ? 'bg-green-900 text-green-300'
                      : 'bg-gray-800 text-gray-500'
                  }`}
                >
                  {p.active ? 'aktiv' : 'inaktiv'}
                </span>
              </div>
              {p.description && (
                <p className="text-sm text-gray-400 mb-3 line-clamp-2">
                  {p.description}
                </p>
              )}
              {p.techStack.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {p.techStack.map((t) => (
                    <span
                      key={t}
                      className="text-xs bg-gray-800 text-gray-300 px-2 py-0.5 rounded"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              )}
              <p className="text-xs text-gray-600 mt-3">
                Aktualisiert: {new Date(p.updatedAt).toLocaleDateString('de-DE')}
              </p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
