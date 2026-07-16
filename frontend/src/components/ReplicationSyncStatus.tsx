import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ReplSyncStatus, ReplDirectionHealth, ReplDeadletter } from '../api/client';
import { wsEventBus, isProjectChangeEvent } from '../api/wsEventBus';
import Button from './ui/Button';
import ConfirmButton from './ui/ConfirmButton';

/** Direction-health → badge classes, mirroring the Observatorium/Monitoring
 *  status colors so health reads the same across the app. */
const HEALTH_COLORS: Record<string, string> = {
  healthy: 'bg-green-900/50 text-green-300 border-green-800/40',
  degraded: 'bg-yellow-900/50 text-yellow-300 border-yellow-800/40',
  error: 'bg-red-900/50 text-red-300 border-red-800/40',
  paused: 'bg-gray-800 text-gray-500 border-gray-700',
};

/** Change-stream log engine: sync status (per-direction health, cursors, lag,
 *  heartbeat) + deadletter management. Admin-only (rendered under the admin-
 *  gated Replikation tab; destructive actions are also @Roles(ADMIN) server-side). */
export default function ReplicationSyncStatus() {
  const { t, i18n } = useTranslation();
  const dateLocale = i18n.language === 'de' ? 'de-DE' : 'en-US';

  const [status, setStatus] = useState<ReplSyncStatus | null>(null);
  const [deadletters, setDeadletters] = useState<ReplDeadletter[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [st, dl] = await Promise.all([
        api.replication.getSyncStatus(),
        api.replication.listDeadletters(),
      ]);
      setStatus(st);
      setDeadletters(dl.items);
    } catch (err) {
      setMsg({ kind: 'err', text: (err as Error).message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Live refresh on replication-status pushes (debounced) + when the tab regains
  // focus — same pattern as the legacy status card.
  const timer = useRef<number | null>(null);
  useEffect(() => {
    const schedule = () => {
      if (timer.current !== null) return;
      timer.current = window.setTimeout(() => { timer.current = null; load(); }, 300);
    };
    const unsub = wsEventBus.subscribe({ kind: 'global' }, (event) => {
      if (isProjectChangeEvent(event) && event.entity === 'replication-status') schedule();
    });
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      unsub();
      document.removeEventListener('visibilitychange', onVisible);
      if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
    };
  }, [load]);

  const flash = (kind: 'ok' | 'err', text: string) => {
    setMsg({ kind, text });
    setTimeout(() => setMsg(null), 4000);
  };

  const syncNow = async () => {
    setBusy('sync'); setMsg(null);
    try {
      const r = await api.replication.syncNow();
      flash('ok', r.skippedReason
        ? t('replication.syncNowSkipped', { reason: r.skippedReason })
        : t('replication.syncNowDone', { pushed: r.pushed, applied: r.applied }));
      load();
    } catch (err) { flash('err', (err as Error).message); }
    finally { setBusy(null); }
  };

  const runGc = async () => {
    setBusy('gc'); setMsg(null);
    try {
      const r = await api.replication.runGc();
      flash('ok', t('replication.gcDone', { deleted: r.deleted }));
      load();
    } catch (err) { flash('err', (err as Error).message); }
    finally { setBusy(null); }
  };

  const replay = async (id: string) => {
    setBusy(id); setMsg(null);
    try {
      const r = await api.replication.replayDeadletter(id);
      flash(r.ok ? 'ok' : 'err', r.ok
        ? t('replication.deadletterReplayed')
        : (r.reason || t('replication.deadletterReplayFailed')));
      load();
    } catch (err) { flash('err', (err as Error).message); }
    finally { setBusy(null); }
  };

  const discard = async (id: string) => {
    setBusy(id); setMsg(null);
    try {
      await api.replication.discardDeadletter(id);
      flash('ok', t('replication.deadletterDiscarded'));
      load();
    } catch (err) { flash('err', (err as Error).message); }
    finally { setBusy(null); }
  };

  const renderDirection = (label: string, h: ReplDirectionHealth, meta: string) => (
    <div className="bg-gray-800/40 border border-gray-700/60 rounded px-3 py-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-gray-300">{label}</span>
        <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border ${HEALTH_COLORS[h.state] ?? HEALTH_COLORS.paused}`}>
          {t(`replication.health_${h.state}`)}
        </span>
      </div>
      <div className="text-[11px] text-gray-500 font-mono">{meta}</div>
      {h.consecutiveFailures > 0 && (
        <div className="text-[11px] text-amber-400/80 mt-0.5">
          {t('replication.consecutiveFailures', { n: h.consecutiveFailures })}
          {h.nextAttemptAt && (
            <> · {t('replication.nextAttempt')} {new Date(h.nextAttemptAt).toLocaleTimeString(dateLocale)}</>
          )}
        </div>
      )}
    </div>
  );

  const renderHeartbeat = (iso: string | null) => {
    if (!iso) return <span className="text-gray-500">—</span>;
    const stale = Date.now() - new Date(iso).getTime() > 90_000;
    return (
      <span className={stale ? 'text-amber-400' : 'text-green-400'}>
        {new Date(iso).toLocaleTimeString(dateLocale)}
        {stale && ` (${t('replication.heartbeatStale')})`}
      </span>
    );
  };

  if (loading) return null;

  return (
    <div className="bg-gray-900 border border-gray-700 rounded-lg p-4 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-gray-300">{t('replication.syncEngineTitle')}</h2>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="xs" onClick={load}>⟳</Button>
          <Button variant="secondary" size="xs" onClick={syncNow} disabled={busy === 'sync'}>
            {busy === 'sync' ? '…' : t('replication.syncNow')}
          </Button>
          <ConfirmButton
            onConfirm={runGc}
            label={t('replication.gcRun')}
            confirmLabel={t('replication.gcConfirm')}
            variant="secondary"
            confirmVariant="danger"
            size="xs"
          />
        </div>
      </div>

      <p className="text-xs text-gray-500">{t('replication.syncEngineHint')}</p>

      {msg && (
        <div className={`px-3 py-2 rounded text-sm ${
          msg.kind === 'ok'
            ? 'bg-green-900/30 border border-green-700 text-green-300'
            : 'bg-red-900/50 border border-red-700 text-red-300'
        }`}>
          {msg.text}
        </div>
      )}

      {status && (
        <>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs">
            <span>
              <span className="text-gray-500">{t('replication.driver')}:</span>{' '}
              <span className="text-gray-300">{status.driver}</span>
              {status.running && <span className="ml-1 text-cyan-300">({t('replication.running')})</span>}
            </span>
            <span>
              <span className="text-gray-500">{t('replication.lastCycle')}:</span>{' '}
              <span className="text-gray-300">
                {status.lastCycleAt ? new Date(status.lastCycleAt).toLocaleTimeString(dateLocale) : '—'}
              </span>
            </span>
            <span>
              <span className="text-gray-500">{t('replication.heartbeat')}:</span>{' '}
              {renderHeartbeat(status.lastHeartbeatAt)}
            </span>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            {renderDirection(
              t('replication.directionPush'),
              status.outbound,
              `${t('replication.cursorOut')} ${status.outboundCursor} · ${t('replication.lag')} ${status.outboundLag}`,
            )}
            {renderDirection(
              t('replication.directionPull'),
              status.inbound,
              `${t('replication.cursorIn')} ${status.inboundCursor}`,
            )}
          </div>

          <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-gray-500">
            <span>{t('replication.localMaxSeq')}: <span className="text-gray-300">{status.localMaxSeq}</span></span>
            <span>{t('replication.batchLimit')}: <span className="text-gray-300">{status.outboundBatchLimit}</span></span>
            <span>
              {t('replication.deadletterCount')}:{' '}
              <span className={status.deadletterCount > 0 ? 'text-red-300' : 'text-gray-300'}>{status.deadletterCount}</span>
            </span>
          </div>
        </>
      )}

      {deadletters.length > 0 && (
        <div className="border-t border-gray-800 pt-3 space-y-1.5">
          <h3 className="text-xs font-medium text-gray-400">{t('replication.deadletterTitle')}</h3>
          {deadletters.map((d) => (
            <div key={d._id} className="flex items-center gap-2 text-xs bg-gray-800/50 rounded px-2 py-1.5">
              <span className={`uppercase tracking-wide text-[10px] px-1.5 py-0.5 rounded border ${
                d.direction === 'inbound' ? 'text-cyan-300 border-cyan-800/40' : 'text-violet-300 border-violet-800/40'
              }`}>
                {d.direction === 'inbound' ? t('replication.directionPull') : t('replication.directionPush')}
              </span>
              <span className="text-gray-300 font-mono truncate flex-1" title={d.reason}>
                {d.collection}/{d.documentId.slice(0, 8)} · {d.reason}
              </span>
              <span className="text-gray-500 shrink-0">{t('replication.deadletterAttempts', { n: d.attempts })}</span>
              <Button variant="ghost" size="xs" onClick={() => replay(d._id)} disabled={busy === d._id}>
                {t('replication.deadletterReplay')}
              </Button>
              <ConfirmButton
                onConfirm={() => discard(d._id)}
                label={t('replication.deadletterDiscard')}
                confirmLabel={t('replication.deadletterDiscardConfirm')}
                variant="secondary"
                confirmVariant="danger"
                size="xs"
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
