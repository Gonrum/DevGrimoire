import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api, Environment, SecretType } from '../api/client';
import { useToast } from '../components/Toast';

const SECRET_TYPES: { value: SecretType; label: string; description: string; icon: string }[] = [
  { value: 'variable', label: 'Variable', description: 'Umgebungsvariable (Key-Value)', icon: '{ }' },
  { value: 'password', label: 'Passwort', description: 'Passwort oder Zugangsdaten', icon: '***' },
  { value: 'token', label: 'Token / API Key', description: 'API-Token, Bearer-Token, API Key', icon: 'key' },
  { value: 'ssh_key', label: 'SSH Key', description: 'Privater oder öffentlicher SSH-Schlüssel', icon: 'ssh' },
  { value: 'certificate', label: 'Zertifikat', description: 'TLS/SSL-Zertifikat oder private Key', icon: 'ssl' },
  { value: 'file', label: 'Datei', description: 'Beliebiger Dateiinhalt (z.B. .env, Config)', icon: 'doc' },
];

export default function SecretCreatePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { showError } = useToast();
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<SecretType>('variable');
  const [environmentId, setEnvironmentId] = useState('');
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (id) api.environments.list(id).then(setEnvironments).catch(() => {});
  }, [id]);

  const isMultiline = type === 'ssh_key' || type === 'certificate' || type === 'file';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id || !key.trim() || !value) return;
    setSaving(true);
    try {
      await api.secrets.create({
        projectId: id,
        key: key.trim(),
        value,
        description: description.trim() || undefined,
        type,
        environmentId: environmentId || undefined,
      });
      navigate(`/projects/${id}?tab=secrets`);
    } catch (err: any) {
      showError(err.message || 'Fehler beim Erstellen');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <Link to={`/projects/${id}?tab=secrets`} className="text-sm text-gray-500 hover:text-gray-300 mb-6 inline-block">&larr; Zurück zum Projekt</Link>

      <h1 className="text-xl font-bold mb-6">Neues Secret</h1>

      <form onSubmit={handleSubmit} className="max-w-3xl mx-auto space-y-6">
        {/* Type selection */}
        <div>
          <label className="block text-xs text-gray-500 mb-2">Typ *</label>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {SECRET_TYPES.map((t) => (
              <button key={t.value} type="button" onClick={() => setType(t.value)}
                className={`text-left p-3 rounded-lg border transition-colors ${type === t.value
                  ? 'border-blue-500 bg-blue-900/20'
                  : 'border-gray-700 bg-gray-800/50 hover:border-gray-600'}`}>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-mono text-gray-500 bg-gray-800 px-1.5 py-0.5 rounded">{t.icon}</span>
                  <span className={`text-sm font-medium ${type === t.value ? 'text-blue-400' : 'text-gray-300'}`}>{t.label}</span>
                </div>
                <p className="text-xs text-gray-500">{t.description}</p>
              </button>
            ))}
          </div>
        </div>

        {/* Key */}
        <div>
          <label className="block text-xs text-gray-500 mb-1">Key *</label>
          <input type="text" value={key} onChange={(e) => setKey(e.target.value)}
            placeholder={type === 'ssh_key' ? 'z.B. DEPLOY_SSH_KEY' : type === 'token' ? 'z.B. API_TOKEN' : type === 'password' ? 'z.B. DB_PASSWORD' : 'z.B. DATABASE_URL'}
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm font-mono text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500" autoFocus />
        </div>

        {/* Value */}
        <div>
          <label className="block text-xs text-gray-500 mb-1">Wert *</label>
          {isMultiline ? (
            <textarea value={value} onChange={(e) => setValue(e.target.value)} rows={8}
              placeholder={type === 'ssh_key' ? '-----BEGIN OPENSSH PRIVATE KEY-----\n...' : type === 'certificate' ? '-----BEGIN CERTIFICATE-----\n...' : 'Dateiinhalt einfügen...'}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm font-mono text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500 resize-y" />
          ) : (
            <input type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Geheimer Wert"
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500" />
          )}
        </div>

        {/* Description */}
        <div>
          <label className="block text-xs text-gray-500 mb-1">Beschreibung</label>
          <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Kurze Beschreibung (optional)"
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500" />
        </div>

        {/* Environment scope */}
        <div>
          <label className="block text-xs text-gray-500 mb-1">Umgebung</label>
          <select value={environmentId} onChange={(e) => setEnvironmentId(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500">
            <option value="">Global (alle Umgebungen)</option>
            {environments.map((env) => (
              <option key={env._id} value={env._id}>{env.name}</option>
            ))}
          </select>
          <p className="text-xs text-gray-600 mt-1">Globale Secrets gelten für alle Umgebungen. Umgebungsspezifische Secrets nur für die gewählte.</p>
        </div>

        <div className="flex gap-2 pt-2">
          <button type="submit" disabled={saving || !key.trim() || !value}
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors">
            {saving ? 'Erstellen...' : 'Secret erstellen'}
          </button>
          <button type="button" onClick={() => navigate(`/projects/${id}?tab=secrets`)}
            className="px-4 py-2 text-sm bg-gray-800 hover:bg-gray-700 text-gray-400 rounded-lg transition-colors">
            Abbrechen
          </button>
        </div>
      </form>
    </div>
  );
}
