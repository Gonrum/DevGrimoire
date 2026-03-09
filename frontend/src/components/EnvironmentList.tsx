import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api, Environment, SecretListItem } from '../api/client';
import { useToast } from './Toast';
import Button from './ui/Button';
import Card from './ui/Card';
import Badge from './ui/Badge';
import ConfirmButton from './ui/ConfirmButton';
import EmptyState from './ui/EmptyState';
import { ENV_COLORS, SECRET_TYPE_LABELS } from '../constants/colors';

function EnvBadge({ name }: { name: string }) {
  const color = ENV_COLORS[name.toLowerCase()] || 'bg-gray-800 text-gray-300';
  return <Badge color={color} rounded="full">{name}</Badge>;
}

function SecretTypeBadge({ type }: { type: string }) {
  const info = SECRET_TYPE_LABELS[type] || SECRET_TYPE_LABELS.variable;
  return <Badge color={info.color}>{info.label}</Badge>;
}

function SecretRow({ secret, onDelete }: { secret: SecretListItem; onDelete: () => void }) {
  const { showError } = useToast();
  const [revealed, setRevealed] = useState<string | null>(null);

  const handleReveal = async () => {
    if (revealed) { setRevealed(null); return; }
    try {
      const s = await api.secrets.get(secret._id);
      setRevealed(s.value);
      setTimeout(() => setRevealed(null), 10000);
    } catch (err: any) {
      showError(err.message || 'Secret konnte nicht entschlüsselt werden');
    }
  };

  const handleCopy = () => {
    if (revealed) navigator.clipboard.writeText(revealed);
  };

  return (
    <div className="flex items-center gap-3 py-2 border-b border-gray-800 last:border-0">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-mono text-gray-200">{secret.key}</span>
          <SecretTypeBadge type={secret.type || 'variable'} />
          {secret.description && <span className="text-xs text-gray-500 truncate">{secret.description}</span>}
        </div>
        {revealed && (
          <div className="mt-1 flex items-center gap-2">
            <code className="text-xs bg-gray-800 text-green-400 px-2 py-0.5 rounded font-mono break-all">{revealed}</code>
            <button type="button" onClick={handleCopy} className="text-xs text-gray-500 hover:text-gray-300" title="Kopieren">
              Kopieren
            </button>
          </div>
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button type="button" size="xs" onClick={handleReveal}>{revealed ? 'Verbergen' : 'Anzeigen'}</Button>
        <ConfirmButton onConfirm={async () => { try { await api.secrets.delete(secret._id); onDelete(); } catch (err: any) { showError(err.message); } }} label="X" confirmLabel="Sicher?" size="xs" />
      </div>
    </div>
  );
}

function ServerInfo({ env }: { env: Environment }) {
  const hasServer = env.host || env.port || env.user || env.url;
  if (!hasServer) return null;

  return (
    <div className="mb-3">
      <h4 className="text-xs font-medium text-gray-500 uppercase mb-2">Server</h4>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        {env.host && (
          <div className="flex gap-2">
            <span className="text-gray-500">Host:</span>
            <span className="font-mono text-gray-300">{env.host}</span>
          </div>
        )}
        {env.port && (
          <div className="flex gap-2">
            <span className="text-gray-500">Port:</span>
            <span className="font-mono text-gray-300">{env.port}</span>
          </div>
        )}
        {env.user && (
          <div className="flex gap-2">
            <span className="text-gray-500">User:</span>
            <span className="font-mono text-gray-300">{env.user}</span>
          </div>
        )}
        {env.url && (
          <div className="flex gap-2 col-span-2">
            <span className="text-gray-500">URL:</span>
            <a href={env.url} target="_blank" rel="noopener noreferrer" className="font-mono text-blue-400 hover:text-blue-300 truncate">{env.url}</a>
          </div>
        )}
      </div>
    </div>
  );
}

function EnvironmentCard({ env, projectId, onUpdate }: { env: Environment; projectId: string; onUpdate: () => void }) {
  const { showError } = useToast();
  const [secrets, setSecrets] = useState<SecretListItem[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [editingVars, setEditingVars] = useState(false);
  const [vars, setVars] = useState(env.variables);

  const loadSecrets = () => { api.secrets.list(projectId, env._id).then(setSecrets).catch(() => {}); };
  useEffect(() => { if (expanded) loadSecrets(); }, [expanded]);

  const handleToggleActive = async () => {
    try { await api.environments.update(env._id, { active: !env.active }); onUpdate(); } catch (err: any) { showError(err.message); }
  };

  const handleSaveVars = async () => {
    try { await api.environments.update(env._id, { variables: vars }); setEditingVars(false); onUpdate(); } catch (err: any) { showError(err.message); }
  };

  const addVar = () => setVars([...vars, { key: '', value: '' }]);
  const removeVar = (i: number) => setVars(vars.filter((_, idx) => idx !== i));
  const updateVar = (i: number, field: 'key' | 'value', val: string) => {
    const next = [...vars];
    next[i] = { ...next[i], [field]: val };
    setVars(next);
  };

  return (
    <Card padding="none" className="overflow-hidden">
      <div className="flex items-center gap-3 p-4 cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <span className="text-gray-500 text-xs">{expanded ? '\u25BC' : '\u25B6'}</span>
        <EnvBadge name={env.name} />
        {env.description && <span className="text-xs text-gray-500 truncate hidden sm:inline">{env.description}</span>}
        <span className="text-sm text-gray-400">
          {env.variables.length} Variablen
        </span>
        <div className="ml-auto flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          <button type="button" onClick={handleToggleActive} className={`text-xs px-2 py-0.5 rounded-full ${env.active ? 'bg-green-900/40 text-green-300' : 'bg-gray-800 text-gray-500'}`}>
            {env.active ? 'aktiv' : 'inaktiv'}
          </button>
          <ConfirmButton onConfirm={async () => { try { await api.environments.delete(env._id); onUpdate(); } catch (err: any) { showError(err.message); } }} label="Entfernen" size="xs" />
        </div>
      </div>

      {expanded && (
        <div className="border-t border-gray-800 p-4 space-y-4">
          <ServerInfo env={env} />

          <div>
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-xs font-medium text-gray-500 uppercase">Variablen</h4>
              {!editingVars ? (
                <button type="button" onClick={() => { setVars(env.variables); setEditingVars(true); }} className="text-xs text-blue-400 hover:text-blue-300">Bearbeiten</button>
              ) : (
                <div className="flex gap-2">
                  <button type="button" onClick={handleSaveVars} className="text-xs text-blue-400 hover:text-blue-300">Speichern</button>
                  <button type="button" onClick={() => { setVars(env.variables); setEditingVars(false); }} className="text-xs text-gray-500">Abbrechen</button>
                </div>
              )}
            </div>
            {editingVars ? (
              <div className="space-y-1">
                {vars.map((v, i) => (
                  <div key={i} className="flex gap-2 items-center">
                    <input type="text" value={v.key} onChange={(e) => updateVar(i, 'key', e.target.value)} placeholder="KEY" className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs font-mono text-gray-200 focus:outline-none focus:border-blue-500" />
                    <input type="text" value={v.value} onChange={(e) => updateVar(i, 'value', e.target.value)} placeholder="Value" className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-blue-500" />
                    <button type="button" onClick={() => removeVar(i)} className="text-gray-600 hover:text-red-400 text-xs">X</button>
                  </div>
                ))}
                <button type="button" onClick={addVar} className="text-xs text-blue-400 hover:text-blue-300">+ Variable</button>
              </div>
            ) : (
              env.variables.length > 0 ? (
                <div className="space-y-1">
                  {env.variables.map((v, i) => (
                    <div key={i} className="flex gap-2 text-xs">
                      <span className="font-mono text-gray-300">{v.key}</span>
                      <span className="text-gray-600">=</span>
                      <span className="text-gray-400 break-all">{v.value}</span>
                    </div>
                  ))}
                </div>
              ) : <p className="text-xs text-gray-600">Keine Variablen</p>
            )}
          </div>

          <div>
            <h4 className="text-xs font-medium text-gray-500 uppercase mb-2">Secrets (verschlüsselt)</h4>
            {secrets.length > 0 ? (
              <div>
                {secrets.map((s) => (
                  <SecretRow key={s._id} secret={s} onDelete={loadSecrets} />
                ))}
              </div>
            ) : <p className="text-xs text-gray-600">Keine Secrets</p>}
            <Link to={`/projects/${projectId}/secrets/new?environmentId=${env._id}`} className="inline-block mt-2 text-xs text-blue-400 hover:text-blue-300">+ Secret</Link>
          </div>
        </div>
      )}
    </Card>
  );
}

export function SecretsList({ projectId }: { projectId: string }) {
  const [secrets, setSecrets] = useState<SecretListItem[]>([]);

  const load = () => { api.secrets.list(projectId, '').then(setSecrets).catch(() => {}); };
  useEffect(() => { load(); }, [projectId]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 mb-4">
        <Link to={`/projects/${projectId}/secrets/new`} className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors">
          + Neues Secret
        </Link>
      </div>
      {secrets.length > 0 ? (
        <Card>
          {secrets.map((s) => (
            <SecretRow key={s._id} secret={s} onDelete={load} />
          ))}
        </Card>
      ) : <EmptyState message="Noch keine Secrets. Lege eines an oder nutze MCP (secret_set)." />}
    </div>
  );
}

export default function EnvironmentList({ projectId }: { projectId: string }) {
  const [environments, setEnvironments] = useState<Environment[]>([]);

  const load = () => {
    api.environments.list(projectId).then(setEnvironments).catch(() => {});
  };

  useEffect(() => { load(); }, [projectId]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 mb-4">
        <Link to={`/projects/${projectId}/environments/new`} className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors">
          + Neue Umgebung
        </Link>
      </div>

      {environments.map((env) => (
        <EnvironmentCard key={env._id} env={env} projectId={projectId} onUpdate={load} />
      ))}

      {environments.length === 0 && (
        <EmptyState message="Noch keine Umgebungen. Lege eine an oder nutze MCP (environment_create)." />
      )}
    </div>
  );
}
