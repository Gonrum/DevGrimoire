import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { api, Project } from '../api/client';

const TEMPLATE_INSTRUCTIONS = `## Arbeitsweise
1. Immer erst Planen und einen Überblick verschaffen
2. Plan mit dem Nutzer abstimmen
3. Plan implementieren
4. Code Review durchführen
5. Tests schreiben/ausführen
6. Ergebnisse dokumentieren

## Konventionen
- Commit-Messages auf Deutsch
- TypeScript strict mode
- Keine \`any\` Typen
- JSDoc für öffentliche Methoden

## Prioritäten
- Sicherheit vor Features
- Lesbarkeit vor Kürze
- Einfachheit vor Abstraktion`;

export default function ProjectSettings() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [path, setPath] = useState('');
  const [repository, setRepository] = useState('');
  const [techStack, setTechStack] = useState('');
  const [active, setActive] = useState(true);
  const [instructions, setInstructions] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    api.projects
      .get(id)
      .then((p) => {
        setProject(p);
        setName(p.name);
        setDescription(p.description || '');
        setPath(p.path || '');
        setRepository(p.repository || '');
        setTechStack(p.techStack.join(', '));
        setActive(p.active);
        setInstructions(p.instructions || '');
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [id]);

  const handleSave = async () => {
    if (!id || !name.trim()) return;
    setSaving(true);
    setSaved(false);
    try {
      const updated = await api.projects.update(id, {
        name: name.trim(),
        description: description.trim() || undefined,
        path: path.trim() || undefined,
        repository: repository.trim() || undefined,
        techStack: techStack.split(',').map((t) => t.trim()).filter(Boolean),
        active,
        instructions,
      });
      setProject(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fehler beim Speichern');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!id) return;
    if (deleting) {
      await api.projects.delete(id);
      navigate('/');
    } else {
      setDeleting(true);
    }
  };

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

  return (
    <div className="max-w-3xl">
      <Link
        to={`/projects/${id}`}
        className="text-sm text-gray-500 hover:text-gray-300 mb-4 inline-block"
      >
        &larr; {project.name}
      </Link>

      <div className="mb-8">
        <h1 className="text-2xl font-bold mb-1">Einstellungen</h1>
        <p className="text-gray-400 text-sm">{project.name}</p>
      </div>

      <section className="mb-8 space-y-4">
        <h2 className="text-lg font-semibold text-blue-400">Projektdaten</h2>

        <div>
          <label className="block text-xs text-gray-500 mb-1">Name *</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full bg-gray-900 border border-gray-800 rounded-lg px-4 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500"
          />
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-1">Beschreibung</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="w-full bg-gray-900 border border-gray-800 rounded-lg px-4 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500 resize-none"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Pfad</label>
            <input
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/home/user/project"
              className="w-full bg-gray-900 border border-gray-800 rounded-lg px-4 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Repository</label>
            <input
              type="text"
              value={repository}
              onChange={(e) => setRepository(e.target.value)}
              placeholder="https://github.com/..."
              className="w-full bg-gray-900 border border-gray-800 rounded-lg px-4 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-1">Tech Stack (kommagetrennt)</label>
          <input
            type="text"
            value={techStack}
            onChange={(e) => setTechStack(e.target.value)}
            placeholder="React, Node.js, MongoDB"
            className="w-full bg-gray-900 border border-gray-800 rounded-lg px-4 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
          />
        </div>

        <div className="flex items-center gap-3">
          <label className="text-xs text-gray-500">Status:</label>
          <button
            type="button"
            onClick={() => setActive(!active)}
            className={`text-xs px-3 py-1 rounded-full transition-colors ${
              active
                ? 'bg-green-900 text-green-300 hover:bg-green-800'
                : 'bg-gray-800 text-gray-500 hover:bg-gray-700'
            }`}
          >
            {active ? 'aktiv' : 'inaktiv'}
          </button>
        </div>
      </section>

      <section className="mb-8">
        <div className="mb-3">
          <h2 className="text-lg font-semibold text-blue-400">
            Anweisungen für Claude
          </h2>
          <p className="text-gray-500 text-sm mt-1">
            Diese Anweisungen werden Claude über MCP zur Verfügung gestellt, wenn
            es an diesem Projekt arbeitet.
          </p>
        </div>

        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          rows={16}
          placeholder="z.B. 1. Immer erst Planen 2. Plan implementieren 3. Code Review..."
          className="w-full bg-gray-900 border border-gray-800 rounded-lg px-4 py-3 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500 resize-y font-mono leading-relaxed"
        />

        {!instructions.trim() && (
          <button
            type="button"
            onClick={() => setInstructions(TEMPLATE_INSTRUCTIONS)}
            className="mt-2 px-3 py-1.5 text-sm bg-gray-800 hover:bg-gray-700 text-gray-400 rounded-lg transition-colors"
          >
            Vorlage einfügen
          </button>
        )}
      </section>

      <div className="flex items-center gap-3 mb-8">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !name.trim()}
          className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors"
        >
          {saving ? 'Speichern...' : 'Alle Änderungen speichern'}
        </button>
        {saved && (
          <span className="text-sm text-green-400">Gespeichert!</span>
        )}
      </div>

      <section className="border-t border-gray-800 pt-6 mb-8">
        <h2 className="text-lg font-semibold text-red-400 mb-2">Gefahrenzone</h2>
        <p className="text-gray-500 text-sm mb-3">
          Das Löschen eines Projekts entfernt alle zugehörigen Daten (Todos, Sessions, Wissen).
        </p>
        <button
          type="button"
          onClick={handleDelete}
          onBlur={() => setDeleting(false)}
          className={`px-4 py-2 text-sm rounded-lg transition-colors ${
            deleting
              ? 'bg-red-700 hover:bg-red-600 text-white'
              : 'bg-gray-800 hover:bg-gray-700 text-red-400'
          }`}
        >
          {deleting ? 'Wirklich löschen?' : 'Projekt löschen'}
        </button>
      </section>

      <section className="bg-gray-900/50 border border-gray-800 rounded-lg p-4">
        <h3 className="text-sm font-medium text-gray-300 mb-2">
          Wie nutzt Claude die Anweisungen?
        </h3>
        <p className="text-gray-500 text-sm leading-relaxed">
          Wenn Claude über MCP auf dieses Projekt zugreift (z.B. mit{' '}
          <code className="text-gray-400 bg-gray-800 px-1 py-0.5 rounded text-xs">project_get</code>),
          erhält es die Anweisungen als Teil der Projektdaten. Du kannst Claude
          dann bitten, sich an die Anweisungen zu halten, oder sie in die{' '}
          <code className="text-gray-400 bg-gray-800 px-1 py-0.5 rounded text-xs">CLAUDE.md</code>{' '}
          des Projekts einbauen.
        </p>
      </section>
    </div>
  );
}
