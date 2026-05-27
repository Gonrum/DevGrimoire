import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ReplicationConfig, ReplicationStatus, ReplicationProjectEntry, RemoteProjectEntry } from '../api/client';
import { wsEventBus, isProjectChangeEvent } from '../api/wsEventBus';
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

  // Remote project browser (T-96)
  const [remoteProjects, setRemoteProjects] = useState<RemoteProjectEntry[] | null>(null);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [importingIds, setImportingIds] = useState<Set<string>>(new Set());

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

  // T-351: Live-Push statt 5s-Polling. Backend emittet `replication-status`
  // bei Statuswechsel (push/pull/full-sync, Queue-Mutation, Config-Save).
  // Tab-visible-Refresh fängt verpasste Events ab (Reconnect-Gap, kalter Start).
  const refetchTimer = useRef<number | null>(null);
  useEffect(() => {
    if (role === 'standalone') return;

    const refetch = () => {
      api.replication.getStatus().then(setStatus).catch(() => {});
    };
    // Debounce auf 300ms — Backend kann während Push/Pull-Bursts mehrere
    // Events feuern (Enqueue + processQueue + lastSync). Ein einziger
    // /status-Call reicht.
    const scheduleRefetch = () => {
      if (refetchTimer.current !== null) return;
      refetchTimer.current = window.setTimeout(() => {
        refetchTimer.current = null;
        refetch();
      }, 300);
    };

    const unsub = wsEventBus.subscribe({ kind: 'global' }, (event) => {
      if (isProjectChangeEvent(event) && event.entity === 'replication-status') {
        scheduleRefetch();
      }
    });

    const onVisible = () => {
      if (document.visibilityState === 'visible') refetch();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      unsub();
      document.removeEventListener('visibilitychange', onVisible);
      if (refetchTimer.current !== null) {
        window.clearTimeout(refetchTimer.current);
        refetchTimer.current = null;
      }
    };
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

  /** Per-project in-flight sync tracker. Keyed by projectId, value = start ts
   *  of the most recent trigger. UI shows a spinner until ~2s after start. */
  const [syncingProjects, setSyncingProjects] = useState<Record<string, number>>({});

  const toggleProjectReplication = async (id: string, enabled: boolean) => {
    // Optimistic update
    setProjects((prev) => prev?.map((p) => p._id === id ? { ...p, replicationEnabled: enabled } : p) ?? null);
    try {
      await api.replication.setProjectReplication(id, enabled);
      // Auto-sync when a project is being enabled so its existing data (todos,
      // knowledge, etc.) flows to the peer without the user having to hunt for
      // a separate button. Fire-and-forget — the backend fullSync runs async.
      if (enabled) {
        setSyncingProjects((prev) => ({ ...prev, [id]: Date.now() }));
        api.replication.triggerFullSync(id)
          .catch(() => {
            // Silent — status card will show the next lastFullSync update either way
          })
          .finally(() => {
            setTimeout(() => {
              setSyncingProjects((prev) => {
                const next = { ...prev };
                delete next[id];
                return next;
              });
            }, 2500);
          });
      }
    } catch (err) {
      // Roll back on failure
      setProjects((prev) => prev?.map((p) => p._id === id ? { ...p, replicationEnabled: !enabled } : p) ?? null);
      setError((err as Error).message);
    }
  };

  const syncSingleProject = async (id: string) => {
    setSyncingProjects((prev) => ({ ...prev, [id]: Date.now() }));
    try {
      await api.replication.triggerFullSync(id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setTimeout(() => {
        setSyncingProjects((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
      }, 2500);
    }
  };

  const loadRemoteProjects = useCallback(async () => {
    setRemoteLoading(true);
    setError(null);
    try {
      const list = await api.replication.listRemoteProjects();
      setRemoteProjects(list);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRemoteLoading(false);
    }
  }, []);

  const importRemoteProject = async (id: string) => {
    setImportingIds((prev) => new Set(prev).add(id));
    setError(null);
    try {
      await api.replication.importProjectFromPeer(id);
      setSuccess(t('replication.remoteProjectImported'));
      setTimeout(() => setSuccess(null), 4000);
      // Give the peer's auto-sync a moment, then refresh both lists
      setTimeout(() => {
        loadRemoteProjects().catch(() => {});
        loadProjects().catch(() => {});
      }, 2500);
    } catch (err) {
      setError(`${t('replication.remoteProjectImportFailed')}: ${(err as Error).message}`);
    } finally {
      setTimeout(() => {
        setImportingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }, 2500);
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

  const triggerPull = async () => {
    setError(null);
    setSuccess(null);
    try {
      const result = await api.replication.triggerPull();
      if (result.error) {
        setError(`${t('replication.pullFailed')}: ${result.error}`);
      } else {
        setSuccess(t('replication.pullDone', {
          applied: result.applied,
          skipped: result.skipped,
        }));
        setTimeout(() => setSuccess(null), 5000);
        api.replication.getStatus().then(setStatus).catch(() => {});
      }
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
          <div className="flex gap-2 flex-wrap">
            <Button variant="primary" onClick={testConnection}>{t('replication.testConnection')}</Button>
            <Button variant="secondary" onClick={triggerSync}>{t('replication.triggerSync')}</Button>
            <Button variant="secondary" onClick={triggerPull}>{t('replication.triggerPull')}</Button>
          </div>
          <p className="text-xs text-gray-500 mt-1">{t('replication.pullHint')}</p>
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
            {role === 'peer' && (
              <div>
                <span className="text-gray-500">{t('replication.lastPull')}:</span>
                <span className="ml-2 text-gray-300">
                  {status.lastPull ? new Date(status.lastPull).toLocaleString(dateLocale) : '-'}
                </span>
              </div>
            )}
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
              {projects.map((p) => {
                const isSyncing = !!syncingProjects[p._id];
                return (
                  <div
                    key={p._id}
                    className="flex items-center gap-3 px-2 py-1.5 rounded hover:bg-gray-800"
                  >
                    <input
                      type="checkbox"
                      id={`repl-${p._id}`}
                      checked={p.replicationEnabled}
                      onChange={(e) => toggleProjectReplication(p._id, e.target.checked)}
                      className="w-4 h-4 accent-violet-600 cursor-pointer"
                    />
                    <label htmlFor={`repl-${p._id}`} className="text-sm text-gray-200 flex-1 truncate cursor-pointer">
                      {p.name}
                    </label>
                    {p.favorite && <span className="text-xs text-amber-400">★</span>}
                    {p.replicationEnabled && !isSyncing && (
                      <span className="text-[10px] uppercase tracking-wide text-emerald-400 bg-emerald-900/20 border border-emerald-800/40 rounded px-1.5 py-0.5">
                        {t('replication.projectSyncOn')}
                      </span>
                    )}
                    {isSyncing && (
                      <span className="text-[10px] uppercase tracking-wide text-cyan-300 bg-cyan-900/20 border border-cyan-800/40 rounded px-1.5 py-0.5 inline-flex items-center gap-1">
                        <span className="animate-spin">⟳</span> {t('replication.projectSyncing')}
                      </span>
                    )}
                    {p.replicationEnabled && (
                      <button
                        type="button"
                        onClick={() => syncSingleProject(p._id)}
                        disabled={isSyncing}
                        className="text-xs text-gray-500 hover:text-cyan-400 disabled:opacity-40 disabled:cursor-not-allowed px-1"
                        title={t('replication.projectSyncNow')}
                        aria-label={t('replication.projectSyncNow')}
                      >
                        ↻
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-xs text-gray-600">{t('replication.projectSelectionEmpty')}</p>
          )}
        </div>
      )}

      {/* Remote project browser (T-96) — only useful when counterparty is configured */}
      {role !== 'standalone' && (role === 'master' ? !!slaveUrl : !!peerUrl) && (
        <div className="bg-gray-900 border border-gray-700 rounded-lg p-4">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-sm font-medium text-gray-300">{t('replication.remoteProjectsTitle')}</h2>
            <Button
              variant="ghost"
              size="xs"
              onClick={loadRemoteProjects}
              disabled={remoteLoading}
            >
              {remoteLoading ? '…' : (remoteProjects ? '⟳' : t('replication.remoteProjectsLoad'))}
            </Button>
          </div>
          <p className="text-xs text-gray-500 mb-3">{t('replication.remoteProjectsHint')}</p>
          {remoteProjects === null ? (
            <p className="text-xs text-gray-600">—</p>
          ) : remoteProjects.length === 0 ? (
            <p className="text-xs text-gray-600">{t('replication.remoteProjectsEmpty')}</p>
          ) : (
            <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
              {remoteProjects.map((rp) => {
                const isImporting = importingIds.has(rp._id);
                const fullyMirrored = rp.existsLocally && rp.localReplicationEnabled;
                return (
                  <div
                    key={rp._id}
                    className="flex items-center gap-3 px-2 py-1.5 rounded hover:bg-gray-800"
                  >
                    <span className="text-sm text-gray-200 flex-1 truncate">
                      {rp.name}
                    </span>
                    {rp.favorite && <span className="text-xs text-amber-400">★</span>}
                    {fullyMirrored ? (
                      <span className="text-[10px] uppercase tracking-wide text-emerald-400 bg-emerald-900/20 border border-emerald-800/40 rounded px-1.5 py-0.5">
                        {t('replication.remoteProjectSynced')}
                      </span>
                    ) : rp.existsLocally ? (
                      <span className="text-[10px] uppercase tracking-wide text-gray-400 bg-gray-800/60 border border-gray-700 rounded px-1.5 py-0.5">
                        {t('replication.remoteProjectLocal')}
                      </span>
                    ) : null}
                    {!fullyMirrored && (
                      <Button
                        variant="secondary"
                        size="xs"
                        onClick={() => importRemoteProject(rp._id)}
                        disabled={isImporting}
                      >
                        {isImporting
                          ? t('replication.remoteProjectImportPending')
                          : t('replication.remoteProjectImport')}
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
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
