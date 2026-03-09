import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, Project } from '../api/client';
import { useDashboardEvents } from '../hooks/useProjectEvents';
import { useToast } from '../components/Toast';

function ProjectCreateForm({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [path, setPath] = useState('');
  const [repository, setRepository] = useState('');
  const [techStack, setTechStack] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      await api.projects.create({
        name: name.trim(),
        description: description.trim() || undefined,
        path: path.trim() || undefined,
        repository: repository.trim() || undefined,
        techStack: techStack.split(',').map((t) => t.trim()).filter(Boolean),
      });
      setName('');
      setDescription('');
      setPath('');
      setRepository('');
      setTechStack('');
      setOpen(false);
      onCreated();
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mb-6 px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
      >
        + Neues Projekt
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mb-6 bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-3 max-w-xl">
      <h3 className="text-sm font-semibold text-gray-300">Neues Projekt anlegen</h3>
      <input
        type="text"
        placeholder="Projektname *"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
        autoFocus
      />
      <textarea
        placeholder="Beschreibung (optional)"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={2}
        className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500 resize-none"
      />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <input
          type="text"
          placeholder="Pfad (optional)"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
        />
        <input
          type="text"
          placeholder="Repository URL (optional)"
          value={repository}
          onChange={(e) => setRepository(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
        />
      </div>
      <input
        type="text"
        placeholder="Tech Stack (kommagetrennt, z.B. React, Node.js)"
        value={techStack}
        onChange={(e) => setTechStack(e.target.value)}
        className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
      />
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={saving || !name.trim()}
          className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded transition-colors"
        >
          {saving ? 'Speichern...' : 'Erstellen'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="px-3 py-1.5 text-sm bg-gray-800 hover:bg-gray-700 text-gray-400 rounded transition-colors"
        >
          Abbrechen
        </button>
      </div>
    </form>
  );
}

export default function ProjectsOverview() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const { showError } = useToast();

  const loadProjects = () => {
    api.projects
      .list()
      .then(setProjects)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  const toggleFavorite = async (e: React.MouseEvent, project: Project) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await api.projects.update(project._id, { favorite: !project.favorite });
      loadProjects();
    } catch (err: any) {
      showError(err.message || 'Favorit konnte nicht geändert werden');
    }
  };

  const filteredProjects = [...projects]
    .filter((p) => {
      if (!search.trim()) return true;
      const q = search.toLowerCase();
      return (
        p.name.toLowerCase().includes(q) ||
        p.description?.toLowerCase().includes(q) ||
        p.techStack.some((t) => t.toLowerCase().includes(q))
      );
    })
    .sort((a, b) => {
      if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });

  useEffect(() => {
    loadProjects();
  }, []);

  useDashboardEvents(() => loadProjects());

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
      <h1 className="text-2xl font-bold mb-6">Projektübersicht</h1>
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-6">
        <ProjectCreateForm onCreated={loadProjects} />
        <input
          type="text"
          placeholder="Projekte suchen..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500 w-full sm:w-64"
        />
      </div>
      {projects.length === 0 ? (
        <p className="text-gray-500">
          Noch keine Projekte. Lege eins über das Formular oder per MCP an.
        </p>
      ) : filteredProjects.length === 0 ? (
        <p className="text-gray-500">Keine Projekte gefunden für "{search}".</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredProjects.map((p) => (
            <Link
              key={p._id}
              to={`/projects/${p._id}`}
              className="block bg-gray-900 border border-gray-800 rounded-lg p-5 hover:border-blue-500 transition-colors"
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={(e) => toggleFavorite(e, p)}
                    className={`text-lg leading-none transition-colors ${
                      p.favorite
                        ? 'text-yellow-400 hover:text-yellow-300'
                        : 'text-gray-700 hover:text-yellow-400'
                    }`}
                    title={p.favorite ? 'Favorit entfernen' : 'Als Favorit markieren'}
                    aria-label={p.favorite ? 'Favorit entfernen' : 'Als Favorit markieren'}
                  >
                    {p.favorite ? '\u2605' : '\u2606'}
                  </button>
                  <h2 className="text-lg font-semibold">{p.name}</h2>
                </div>
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
                Erstellt: {new Date(p.createdAt).toLocaleDateString('de-DE')}
                {' · '}
                Aktualisiert: {new Date(p.updatedAt).toLocaleDateString('de-DE')}
              </p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
