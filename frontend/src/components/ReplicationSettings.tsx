import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ReplicationConfig, ReplicationStatus, ReplicationProjectEntry } from '../api/client';
import Button from './ui/Button';
import ConfirmButton from './ui/ConfirmButton';

export default function ReplicationSettings() {
  const { t, i18n } = useTranslation();
  const dateLocale = i18n.language === 'de' ? 'de-DE' : 'en-US';

  const [config, setConfig] = useState<ReplicationConfig | null>(null);
  const [status, setStatus] = useState<ReplicationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Editable fields
  const [role, setRole] = useState<ReplicationConfig['role']>('standalone');
  const [slaveUrl, setSlaveUrl] = useState('');
  const [slaveApiKey, setSlaveApiKey] = useState('');
  const [peerUrl, setPeerUrl] = useState('');
  const [peerApiKey, setPeerApiKey] = useState('');
  const [fullSyncCron, setFullSyncCron] = useState('0 3 * * *');

  // Per-project replication opt-in (T-80)
  const [projects, setProjects] = useState<ReplicationProjectEntry[] | null>(null);
  const [projectsLoading, setProjectsLoading] = useState(false);

  const loadProjects = useCallback(async () => {
    setProjectsLoading(true);
    try {
      const list = await api.replication.listProjects();
      setProjects(list);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [cfg, sts] = await Promise.all([
        api.replication.getConfig(),
        api.replication.getStatus(),
      ]);
      setConfig(cfg);
      setStatus(sts);
      setRole(cfg.role);
      setSlaveUrl(cfg.slaveUrl || '');
      setSlaveApiKey('');
      setPeerUrl(cfg.peerUrl || '');
      setPeerApiKey('');
      setFullSyncCron(cfg.fullSyncCron);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Load project list when role isn't standalone
  useEffect(() => {
    if (role !== 'standalone') {
      loadProjects();
    } else {
      setProjects(null);
    }
  }, [role, loadProjects]);

  // Poll status every 5s when actively replicating, so the queue counter and
  // lastSync timestamp tick down/up live without forcing a manual refresh.
  useEffect(() => {
    if (role === 'standalone') return;
    const tick = () => {
      api.replication.getStatus().then(setStatus).catch(() => {});
    };
    const id = window.setInterval(tick, 5000);
    return () => window.clearInterval(id);
  }, [role]);

  const save = async () => {
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const data: Partial<ReplicationConfig> = { role, fullSyncCron };
      if (role === 'master') {
        data.slaveUrl = slaveUrl;
        if (slaveApiKey) data.slaveApiKey = slaveApiKey;
      } else if (role === 'peer') {
        data.peerUrl = peerUrl;
        if (peerApiKey) data.peerApiKey = peerApiKey;
      }
      const updated = await api.replication.updateConfig(data);
      setConfig(updated);
      setSuccess(t('common.saved'));
      setTimeout(() => setSuccess(null), 3000);
      // Refresh status
      api.replication.getStatus().then(setStatus).catch(() => {});
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const toggleProjectReplication = async (id: string, enabled: boolean) => {
    // Optimistic update
    setProjects((prev) => prev?.map((p) => p._id === id ? { ...p, replicationEnabled: enabled } : p) ?? null);
    try {
      await api.replication.setProjectReplication(id, enabled);
    } catch (err) {
      // Roll back on failure
      setProjects((prev) => prev?.map((p) => p._id === id ? { ...p, replicationEnabled: !enabled } : p) ?? null);
      setError((err as Error).message);
    }
  };

  const testConnection = async () => {
    setError(null);
    setSuccess(null);
    try {
      const result = await api.replication.testConnection();
      if (result.success) {
        setSuccess(`${t('replication.connectionOk')} (${result.latency}ms)`);
      } else {
        setError(`${t('replication.connectionFailed')}: ${result.error || 'Unknown'}`);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const triggerSync = async () => {
    try {
      await api.replication.triggerFullSync();
      setSuccess(t('replication.syncStarted'));
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const promote = async () => {
    try {
      await api.replication.promote();
      setSuccess(t('replication.promoted'));
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const clearFailed = async () => {
    try {
      const result = await api.replication.clearFailed();
      setSuccess(`${result.cleared} ${t('replication.cleared')}`);
      api.replication.getStatus().then(setStatus).catch(() => {});
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (loading) return <p className="text-gray-500 py-10 text-center">{t('common.loading')}</p>;

  return (
    <div className="space-y-6">
      <p className="text-gray-400">{t('replication.description')}</p>

      {error && (
        <div className="bg-red-900/50 border border-red-700 text-red-300 px-4 py-2 rounded">
          {error}
        </div>
      )}
      {success && (
        <div className="bg-green-900/30 border border-green-700 text-green-300 px-4 py-2 rounded">
          {success}
        </div>
      )}

      {/* Role Selector */}
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-4">
        <h2 className="text-sm font-medium text-gray-300 mb-3">{t('replication.role')}</h2>
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as ReplicationConfig['role'])}
          className="bg-gray-800 border border-gray-600 text-gray-200 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-violet-500"
        >
          <option value="standalone">Standalone</option>
          <option value="master">Master</option>
          <option value="slave">Slave</option>
          <option value="peer">{t('replication.rolePeer')}</option>
        </select>
        {role === 'peer' && (
          <p className="text-xs text-gray-500 mt-2">{t('replication.peerHint')}</p>
        )}
      </div>

      {/* Master Config */}
      {role === 'master' && (
        <div className="bg-gray-900 border border-gray-700 rounded-lg p-4 space-y-4">
          <h2 className="text-sm font-medium text-gray-300">{t('replication.masterConfig')}</h2>
          <div>
            <label className="block text-xs text-gray-500 mb-1">{t('replication.slaveUrl')}</label>
            <input
              type="text"
              value={slaveUrl}
              onChange={(e) => setSlaveUrl(e.target.value)}
              placeholder="https://backup.example.com"
              className="w-full bg-gray-800 border border-gray-600 text-gray-200 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-violet-500"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">{t('replication.slaveApiKey')}</label>
            <input
              type="password"
              value={slaveApiKey}
              onChange={(e) => setSlaveApiKey(e.target.value)}
              placeholder={config?.slaveApiKey ? '***' : 'cv_...'}
              className="w-full bg-gray-800 border border-gray-600 text-gray-200 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-violet-500"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">{t('replication.fullSyncCron')}</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={fullSyncCron}
                onChange={(e) => setFullSyncCron(e.target.value)}
                className="flex-1 bg-gray-800 border border-gray-600 text-gray-200 rounded px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-violet-500"
              />
              <Button variant="secondary" size="sm" onClick={() => setFullSyncCron('0 3 * * *')}>
                3:00
              </Button>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="primary" onClick={testConnection}>{t('replication.testConnection')}</Button>
            <Button variant="secondary" onClick={triggerSync}>{t('replication.triggerSync')}</Button>
          </div>
        </div>
      )}

      {/* Peer Config */}
      {role === 'peer' && (
        <div className="bg-gray-900 border border-gray-700 rounded-lg p-4 space-y-4">
          <h2 className="text-sm font-medium text-gray-300">{t('replication.peerConfig')}</h2>
          <div>
            <label className="block text-xs text-gray-500 mb-1">{t('replication.peerUrl')}</label>
            <input
              type="text"
              value={peerUrl}
              onChange={(e) => setPeerUrl(e.target.value)}
              placeholder="https://office.example.com"
              className="w-full bg-gray-800 border border-gray-600 text-gray-200 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-violet-500"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">{t('replication.peerApiKey')}</label>
            <input
              type="password"
              value={peerApiKey}
              onChange={(e) => setPeerApiKey(e.target.value)}
              placeholder={config?.peerApiKey ? '***' : 'cv_...'}
              className="w-full bg-gray-800 border border-gray-600 text-gray-200 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-violet-500"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">{t('replication.fullSyncCron')}</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={fullSyncCron}
                onChange={(e) => setFullSyncCron(e.target.value)}
                className="flex-1 bg-gray-800 border border-gray-600 text-gray-200 rounded px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-violet-500"
              />
              <Button variant="secondary" size="sm" onClick={() => setFullSyncCron('0 3 * * *')}>
                3:00
              </Button>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="primary" onClick={testConnection}>{t('replication.testConnection')}</Button>
            <Button variant="secondary" onClick={triggerSync}>{t('replication.triggerSync')}</Button>
          </div>
        </div>
      )}

      {/* Slave Info */}
      {role === 'slave' && (
        <div className="bg-gray-900 border border-gray-700 rounded-lg p-4 space-y-4">
          <div className="bg-amber-900/30 border border-amber-700 text-amber-300 px-4 py-2 rounded text-sm">
            {t('replication.readonlyWarning')}
          </div>
          {config?.masterUrl && (
            <div>
              <label className="block text-xs text-gray-500 mb-1">Master URL</label>
              <p className="text-sm text-gray-300 font-mono">{config.masterUrl}</p>
            </div>
          )}
          <ConfirmButton
            onConfirm={promote}
            label={t('replication.promote')}
            confirmLabel={t('replication.promoteConfirm')}
            variant="danger"
            confirmVariant="danger-solid"
            size="md"
          />
        </div>
      )}

      {/* Status Card */}
      {status && role !== 'standalone' && (
        <div className="bg-gray-900 border border-gray-700 rounded-lg p-4">
          <h2 className="text-sm font-medium text-gray-300 mb-3">Status</h2>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <span className="text-gray-500">{t('replication.instanceId')}:</span>
              <span className="ml-2 text-gray-300 font-mono text-xs">{status.instanceId.slice(0, 8)}...</span>
            </div>
            {(role === 'master' || role === 'peer') && (
              <>
                <div>
                  <span className="text-gray-500">{t('replication.connection')}:</span>
                  <span className={`ml-2 ${status.connected ? 'text-green-400' : 'text-red-400'}`}>
                    {status.connected ? t('replication.connected') : t('replication.disconnected')}
                  </span>
                </div>
                <div>
                  <span className="text-gray-500">{t('replication.queue')}:</span>
                  <span className={`ml-2 ${status.queueSize === 0 ? 'text-emerald-400' : 'text-amber-300'}`}>
                    {status.queueSize}
                    {status.queueSize === 0 && (
                      <span className="ml-1 text-[10px] uppercase tracking-wide">{t('replication.synced')}</span>
                    )}
                  </span>
                </div>
                <div>
                  <span className="text-gray-500">{t('replication.failed')}:</span>
                  <span className={`ml-2 ${status.failedCount > 0 ? 'text-red-400' : 'text-gray-300'}`}>
                    {status.failedCount}
                  </span>
                  {status.failedCount > 0 && (
                    <Button variant="ghost" size="xs" className="ml-2" onClick={clearFailed}>
                      {t('replication.clearFailed')}
                    </Button>
                  )}
                </div>
              </>
            )}
            <div>
              <span className="text-gray-500">{t('replication.lastSync')}:</span>
              <span className="ml-2 text-gray-300">
                {status.lastSync ? new Date(status.lastSync).toLocaleString(dateLocale) : '-'}
              </span>
            </div>
            <div>
              <span className="text-gray-500">{t('replication.lastFullSync')}:</span>
              <span className="ml-2 text-gray-300">
                {status.lastFullSync ? new Date(status.lastFullSync).toLocaleString(dateLocale) : '-'}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Per-project replication opt-in (T-80) */}
      {role !== 'standalone' && (
        <div className="bg-gray-900 border border-gray-700 rounded-lg p-4">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-sm font-medium text-gray-300">{t('replication.projectSelectionTitle')}</h2>
            <Button variant="ghost" size="xs" onClick={loadProjects} disabled={projectsLoading}>
              ⟳
            </Button>
          </div>
          <p className="text-xs text-gray-500 mb-3">{t('replication.projectSelectionHint')}</p>
          {projectsLoading && !projects ? (
            <p className="text-xs text-gray-600">{t('common.loading')}</p>
          ) : projects && projects.length > 0 ? (
            <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
              {projects.map((p) => (
                <label
                  key={p._id}
                  className="flex items-center gap-3 px-2 py-1.5 rounded hover:bg-gray-800 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={p.replicationEnabled}
                    onChange={(e) => toggleProjectReplication(p._id, e.target.checked)}
                    className="w-4 h-4 accent-violet-600"
                  />
                  <span className="text-sm text-gray-200 flex-1 truncate">{p.name}</span>
                  {p.favorite && <span className="text-xs text-amber-400">★</span>}
                  {p.replicationEnabled && (
                    <span className="text-[10px] uppercase tracking-wide text-emerald-400 bg-emerald-900/20 border border-emerald-800/40 rounded px-1.5 py-0.5">
                      {t('replication.projectSyncOn')}
                    </span>
                  )}
                </label>
              ))}
            </div>
          ) : (
            <p className="text-xs text-gray-600">{t('replication.projectSelectionEmpty')}</p>
          )}
        </div>
      )}

      {/* Save Button */}
      <div className="flex gap-3">
        <Button variant="primary" size="lg" onClick={save} disabled={saving}>
          {saving ? t('common.saving') : t('common.save')}
        </Button>
      </div>
    </div>
  );
}
