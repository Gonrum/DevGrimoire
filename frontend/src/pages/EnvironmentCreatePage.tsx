import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../api/client';
import { useToast } from '../components/Toast';

const ENV_PRESETS = [
  { name: 'development', label: 'Development', color: 'bg-green-900/40 text-green-300' },
  { name: 'staging', label: 'Staging', color: 'bg-yellow-900/40 text-yellow-300' },
  { name: 'production', label: 'Production', color: 'bg-red-900/40 text-red-300' },
];

export default function EnvironmentCreatePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { showError } = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('');
  const [user, setUser] = useState('');
  const [url, setUrl] = useState('');
  const [variables, setVariables] = useState<{ key: string; value: string }[]>([]);
  const [saving, setSaving] = useState(false);

  const addVar = () => setVariables([...variables, { key: '', value: '' }]);
  const removeVar = (i: number) => setVariables(variables.filter((_, idx) => idx !== i));
  const updateVar = (i: number, field: 'key' | 'value', val: string) => {
    const next = [...variables];
    next[i] = { ...next[i], [field]: val };
    setVariables(next);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id || !name.trim()) return;
    setSaving(true);
    try {
      const validVars = variables.filter((v) => v.key.trim());
      await api.environments.create({
        projectId: id,
        name: name.trim(),
        description: description.trim() || undefined,
        host: host.trim() || undefined,
        port: port ? Number(port) : undefined,
        user: user.trim() || undefined,
        url: url.trim() || undefined,
        variables: validVars.length > 0 ? validVars : undefined,
      });
      navigate(`/projects/${id}?tab=environments`);
    } catch (err: any) {
      showError(err.message || 'Fehler beim Erstellen');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <Link to={`/projects/${id}?tab=environments`} className="text-sm text-gray-500 hover:text-gray-300 mb-6 inline-block">&larr; Zurück zum Projekt</Link>

      <h1 className="text-xl font-bold mb-6">Neue Umgebung</h1>

      <form onSubmit={handleSubmit} className="max-w-3xl mx-auto space-y-6">
        {/* Name with presets */}
        <div>
          <label className="block text-xs text-gray-500 mb-1">Name *</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="z.B. development, staging, production"
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500" autoFocus />
          <div className="flex gap-2 mt-2">
            {ENV_PRESETS.map((preset) => (
              <button key={preset.name} type="button" onClick={() => setName(preset.name)}
                className={`text-xs px-2.5 py-1 rounded-full transition-colors ${name === preset.name ? preset.color : 'bg-gray-800 text-gray-500 hover:text-gray-300'}`}>
                {preset.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-1">Beschreibung</label>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="Kurze Beschreibung der Umgebung (optional)"
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500 resize-none" />
        </div>

        {/* Server data */}
        <div>
          <h2 className="text-sm font-medium text-gray-400 mb-3">Serverdaten</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Host</label>
              <input type="text" value={host} onChange={(e) => setHost(e.target.value)} placeholder="z.B. 192.168.1.100 oder server.example.com"
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm font-mono text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Port</label>
              <input type="number" value={port} onChange={(e) => setPort(e.target.value)} placeholder="z.B. 22, 3000, 443"
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm font-mono text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Benutzer</label>
              <input type="text" value={user} onChange={(e) => setUser(e.target.value)} placeholder="z.B. deploy, root, www-data"
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm font-mono text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">URL</label>
              <input type="text" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="z.B. https://staging.example.com"
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm font-mono text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500" />
            </div>
          </div>
        </div>

        {/* Variables */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-medium text-gray-400">Variablen</h2>
            <button type="button" onClick={addVar} className="text-xs px-2.5 py-1 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 rounded transition-colors">
              + Variable
            </button>
          </div>
          {variables.length > 0 ? (
            <div className="space-y-2">
              {variables.map((v, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <input type="text" value={v.key} onChange={(e) => updateVar(i, 'key', e.target.value)} placeholder="KEY"
                    className="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm font-mono text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500" />
                  <input type="text" value={v.value} onChange={(e) => updateVar(i, 'value', e.target.value)} placeholder="Value"
                    className="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500" />
                  <button type="button" onClick={() => removeVar(i)} className="text-gray-600 hover:text-red-400 text-sm px-2 py-2 transition-colors">X</button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-gray-600">Keine Variablen. Variablen können auch später hinzugefügt werden.</p>
          )}
        </div>

        <div className="flex gap-2 pt-2">
          <button type="submit" disabled={saving || !name.trim()}
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors">
            {saving ? 'Erstellen...' : 'Umgebung erstellen'}
          </button>
          <button type="button" onClick={() => navigate(`/projects/${id}?tab=environments`)}
            className="px-4 py-2 text-sm bg-gray-800 hover:bg-gray-700 text-gray-400 rounded-lg transition-colors">
            Abbrechen
          </button>
        </div>
      </form>
    </div>
  );
}
