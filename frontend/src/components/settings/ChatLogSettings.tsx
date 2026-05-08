import { Fragment, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  api,
  ChatActivityEntry,
  ChatActivityOutcome,
  ChatActivityStats,
  Project,
} from '../../api/client';
import { useToast } from '../Toast';
import Button from '../ui/Button';
import { SettingsSection, SettingsTabHeader } from '../ui/SettingsShell';
import { LoadingText } from '../ui/LoadingSpinner';

const PAGE_SIZE = 50;
const STATS_DAYS = 30;

/**
 * Admin-only chat-log viewer. Shows every chat invocation (server- and
 * browser-mode) with its endpoint, model, tools used, token/s and any error.
 * Used to diagnose flaky endpoints, broken tool-calls, and cost.
 */
export default function ChatLogSettings() {
  const { t, i18n } = useTranslation();
  const { showError } = useToast();
  const dateLocale = i18n.language === 'de' ? 'de-DE' : 'en-US';

  const [items, setItems] = useState<ChatActivityEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<ChatActivityStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [outcomeFilter, setOutcomeFilter] = useState<ChatActivityOutcome | ''>('');
  const [projectFilter, setProjectFilter] = useState<string>('');
  const [search, setSearch] = useState('');
  const [searchDraft, setSearchDraft] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    api.projects.list({ active: true })
      .then(setProjects)
      .catch(() => setProjects([]));
  }, []);

  const load = async (resetOffset: boolean) => {
    setLoading(true);
    const nextOffset = resetOffset ? 0 : offset;
    try {
      const [list, statsRes] = await Promise.all([
        api.chatActivity.list({
          outcome: outcomeFilter || undefined,
          projectId: projectFilter || undefined,
          search: search || undefined,
          limit: PAGE_SIZE,
          offset: nextOffset,
        }),
        api.chatActivity.stats({
          projectId: projectFilter || undefined,
          days: STATS_DAYS,
        }),
      ]);
      setItems((prev) => (resetOffset ? list.items : [...prev, ...list.items]));
      setTotal(list.total);
      setStats(statsRes);
      if (resetOffset) setOffset(PAGE_SIZE);
      else setOffset(nextOffset + PAGE_SIZE);
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  // Reload when filters change
  useEffect(() => {
    load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcomeFilter, projectFilter, search]);

  const projectMap = useMemo(() => {
    const m = new Map<string, string>();
    projects.forEach((p) => m.set(p._id, p.name));
    return m;
  }, [projects]);

  const successRate = stats && stats.total > 0
    ? Math.round((stats.completed / stats.total) * 100)
    : null;

  const formatTime = (iso: string) => new Date(iso).toLocaleString(dateLocale, {
    year: '2-digit', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });

  const formatDuration = (ms?: number) => {
    if (ms == null) return '—';
    if (ms < 1000) return `${ms} ms`;
    return `${(ms / 1000).toFixed(1)} s`;
  };

  const outcomeBadge = (outcome: ChatActivityOutcome) => {
    const map: Record<ChatActivityOutcome, { label: string; cls: string }> = {
      completed: { label: t('chatLog.outcomeCompleted'), cls: 'bg-emerald-900/30 text-emerald-300 border-emerald-800/50' },
      failed: { label: t('chatLog.outcomeFailed'), cls: 'bg-red-900/30 text-red-300 border-red-800/50' },
      aborted: { label: t('chatLog.outcomeAborted'), cls: 'bg-amber-900/20 text-amber-300 border-amber-800/50' },
      no_endpoint: { label: t('chatLog.outcomeNoEndpoint'), cls: 'bg-rose-950/30 text-rose-300 border-rose-900/60' },
    };
    const m = map[outcome];
    return (
      <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[11px] ${m.cls}`}>
        {m.label}
      </span>
    );
  };

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <>
      <SettingsTabHeader description={t('chatLog.description')} />

      <SettingsSection title={t('chatLog.summary', { days: STATS_DAYS })}>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard label={t('chatLog.totalRuns')} value={stats?.total ?? '—'} />
          <StatCard
            label={t('chatLog.successRate')}
            value={successRate !== null ? `${successRate}%` : '—'}
            tone={successRate !== null && successRate < 80 ? 'warn' : 'ok'}
          />
          <StatCard
            label={t('chatLog.avgTokensPerSec')}
            value={stats?.avgTokensPerSecond != null ? `${stats.avgTokensPerSecond}` : '—'}
          />
          <StatCard
            label={t('chatLog.avgFirstToken')}
            value={stats?.avgFirstTokenMs != null ? formatDuration(stats.avgFirstTokenMs) : '—'}
          />
        </div>

        {stats && (stats.byProvider.length > 0 || stats.byTool.length > 0) && (
          <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
            {stats.byProvider.length > 0 && (
              <div className="bg-gray-900/50 border border-gray-800 rounded p-3">
                <div className="text-xs text-gray-400 uppercase tracking-wider mb-2">{t('chatLog.byProvider')}</div>
                <ul className="space-y-1 text-sm">
                  {stats.byProvider.map((p) => (
                    <li key={p.provider} className="flex justify-between font-mono text-xs">
                      <span className="text-gray-300">{p.provider}</span>
                      <span className="text-gray-500">
                        {p.count}
                        {p.failures > 0 && (
                          <span className="text-red-400"> ({p.failures} fail)</span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {stats.byTool.length > 0 && (
              <div className="bg-gray-900/50 border border-gray-800 rounded p-3">
                <div className="text-xs text-gray-400 uppercase tracking-wider mb-2">{t('chatLog.byTool')}</div>
                <ul className="space-y-1 text-sm">
                  {stats.byTool.slice(0, 12).map((tl) => (
                    <li key={tl.name} className="flex justify-between font-mono text-xs">
                      <span className="text-gray-300 truncate">{tl.name}</span>
                      <span className="text-gray-500">
                        {tl.count}
                        {tl.errors > 0 && (
                          <span className="text-red-400"> ({tl.errors} err)</span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </SettingsSection>

      <SettingsSection title={t('chatLog.title')} className="mt-6">
        <div className="flex flex-wrap gap-2 mb-3">
          <select
            value={outcomeFilter}
            onChange={(e) => setOutcomeFilter(e.target.value as ChatActivityOutcome | '')}
            className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200 focus:outline-none focus:ring-1 focus:ring-violet-500"
          >
            <option value="">{t('chatLog.filterAll')}</option>
            <option value="completed">{t('chatLog.filterCompleted')}</option>
            <option value="failed">{t('chatLog.filterFailed')}</option>
            <option value="aborted">{t('chatLog.filterAborted')}</option>
            <option value="no_endpoint">{t('chatLog.filterNoEndpoint')}</option>
          </select>
          <select
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200 focus:outline-none focus:ring-1 focus:ring-violet-500"
          >
            <option value="">{t('chatLog.filterProject')}</option>
            {projects.map((p) => (
              <option key={p._id} value={p._id}>{p.name}</option>
            ))}
          </select>
          <form
            className="flex-1 min-w-[200px]"
            onSubmit={(e) => {
              e.preventDefault();
              setSearch(searchDraft.trim());
            }}
          >
            <input
              type="search"
              placeholder={t('chatLog.filterSearch')}
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200 focus:outline-none focus:ring-1 focus:ring-violet-500"
            />
          </form>
          <Button size="sm" onClick={() => load(true)} disabled={loading}>
            {t('chatLog.refresh')}
          </Button>
        </div>

        {loading && items.length === 0 ? (
          <LoadingText text={t('chatLog.loading')} />
        ) : items.length === 0 ? (
          <div className="text-center text-gray-500 text-sm py-8 border border-dashed border-gray-800 rounded">
            {t('chatLog.noEntries')}
          </div>
        ) : (
          <div className="overflow-x-auto border border-gray-800 rounded">
            <table className="w-full text-sm">
              <thead className="bg-gray-900/70 text-gray-400">
                <tr>
                  <th className="text-left px-2 py-1.5 font-medium text-xs uppercase tracking-wider">{t('chatLog.tableTime')}</th>
                  <th className="text-left px-2 py-1.5 font-medium text-xs uppercase tracking-wider">{t('chatLog.tableMode')}</th>
                  <th className="text-left px-2 py-1.5 font-medium text-xs uppercase tracking-wider">{t('chatLog.tableModel')}</th>
                  <th className="text-left px-2 py-1.5 font-medium text-xs uppercase tracking-wider">{t('chatLog.tableOutcome')}</th>
                  <th className="text-right px-2 py-1.5 font-medium text-xs uppercase tracking-wider">{t('chatLog.tableTokens')}</th>
                  <th className="text-right px-2 py-1.5 font-medium text-xs uppercase tracking-wider">{t('chatLog.tableTps')}</th>
                  <th className="text-right px-2 py-1.5 font-medium text-xs uppercase tracking-wider">{t('chatLog.tableDuration')}</th>
                  <th className="text-left px-2 py-1.5 font-medium text-xs uppercase tracking-wider">{t('chatLog.tableTools')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => {
                  const isExpanded = expanded.has(it._id);
                  const projectName = it.projectId ? projectMap.get(it.projectId) : undefined;
                  return (
                    <Fragment key={it._id}>
                      <tr
                        onClick={() => toggleExpand(it._id)}
                        className={`border-t border-gray-800 cursor-pointer hover:bg-gray-800/30 ${
                          it.outcome === 'failed' || it.outcome === 'no_endpoint' ? 'bg-red-950/10' : ''
                        }`}
                      >
                        <td className="px-2 py-1.5 font-mono text-xs text-gray-400 whitespace-nowrap">
                          {formatTime(it.createdAt)}
                        </td>
                        <td className="px-2 py-1.5 text-xs text-gray-400">
                          {it.mode === 'server' ? t('chatLog.modeServer') : t('chatLog.modeBrowser')}
                        </td>
                        <td className="px-2 py-1.5 font-mono text-xs text-gray-300 truncate max-w-[180px]" title={it.model}>
                          {it.model || '—'}
                        </td>
                        <td className="px-2 py-1.5">{outcomeBadge(it.outcome)}</td>
                        <td className="px-2 py-1.5 font-mono text-xs text-gray-400 text-right">
                          {it.outputTokens != null ? `${it.estimated ? '≈ ' : ''}${it.outputTokens}` : '—'}
                        </td>
                        <td className="px-2 py-1.5 font-mono text-xs text-gray-400 text-right">
                          {it.tokensPerSecond != null ? it.tokensPerSecond.toFixed(1) : '—'}
                        </td>
                        <td className="px-2 py-1.5 font-mono text-xs text-gray-400 text-right whitespace-nowrap">
                          {formatDuration(it.durationMs)}
                        </td>
                        <td className="px-2 py-1.5 text-xs text-gray-400">
                          {it.toolsUsed && it.toolsUsed.length > 0 ? (
                            <span className="font-mono">
                              {it.toolsUsed.reduce((sum, t) => sum + t.count, 0)}
                              {it.toolsUsed.some((t) => t.errors > 0) && (
                                <span className="text-red-400"> *</span>
                              )}
                            </span>
                          ) : '—'}
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr className="bg-gray-900/40">
                          <td colSpan={8} className="px-3 py-2">
                            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-xs">
                              {projectName && (
                                <div className="flex gap-2">
                                  <dt className="text-gray-500 w-32 shrink-0">Project:</dt>
                                  <dd className="text-gray-300 font-mono truncate">{projectName}</dd>
                                </div>
                              )}
                              {it.provider && (
                                <div className="flex gap-2">
                                  <dt className="text-gray-500 w-32 shrink-0">Provider:</dt>
                                  <dd className="text-gray-300 font-mono">{it.provider}</dd>
                                </div>
                              )}
                              {it.endpointUrl && (
                                <div className="flex gap-2 col-span-full">
                                  <dt className="text-gray-500 w-32 shrink-0">Endpoint:</dt>
                                  <dd className="text-gray-300 font-mono truncate">{it.endpointUrl}</dd>
                                </div>
                              )}
                              {it.firstTokenMs != null && (
                                <div className="flex gap-2">
                                  <dt className="text-gray-500 w-32 shrink-0">TTF:</dt>
                                  <dd className="text-gray-300 font-mono">{formatDuration(it.firstTokenMs)}</dd>
                                </div>
                              )}
                              {it.userMessageLength != null && (
                                <div className="flex gap-2">
                                  <dt className="text-gray-500 w-32 shrink-0">Input length:</dt>
                                  <dd className="text-gray-300 font-mono">{it.userMessageLength} chars</dd>
                                </div>
                              )}
                              {it.hadImages && (
                                <div className="flex gap-2">
                                  <dt className="text-gray-500 w-32 shrink-0">Images:</dt>
                                  <dd className="text-gray-300">yes</dd>
                                </div>
                              )}
                              {it.toolsUsed && it.toolsUsed.length > 0 && (
                                <div className="col-span-full">
                                  <dt className="text-gray-500 mb-1">Tools:</dt>
                                  <dd className="flex flex-wrap gap-1.5">
                                    {it.toolsUsed.map((tl) => (
                                      <span
                                        key={tl.name}
                                        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-mono text-[10px] border ${
                                          tl.errors > 0
                                            ? 'bg-red-900/30 border-red-800/50 text-red-200'
                                            : 'bg-gray-800 border-gray-700 text-gray-300'
                                        }`}
                                      >
                                        {tl.name} ×{tl.count}
                                        {tl.errors > 0 && <span className="text-red-300">{tl.errors} err</span>}
                                      </span>
                                    ))}
                                  </dd>
                                </div>
                              )}
                              {it.errorMessage && (
                                <div className="col-span-full">
                                  <dt className="text-red-400 mb-1">{t('chatLog.tableError')}:</dt>
                                  <dd className="text-red-300 font-mono text-xs whitespace-pre-wrap break-words bg-red-950/30 border border-red-900/40 rounded p-2">
                                    {it.errorMessage}
                                  </dd>
                                </div>
                              )}
                            </dl>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {items.length < total && (
          <div className="mt-3 text-center">
            <Button size="sm" onClick={() => load(false)} disabled={loading}>
              {loading ? t('chatLog.loading') : t('chatLog.loadMore')} ({items.length} / {total})
            </Button>
          </div>
        )}
      </SettingsSection>
    </>
  );
}

function StatCard({ label, value, tone }: { label: string; value: string | number; tone?: 'ok' | 'warn' }) {
  const valueClass = tone === 'warn' ? 'text-amber-300' : 'text-violet-200';
  return (
    <div className="bg-gray-900/50 border border-gray-800 rounded p-3">
      <div className="text-xs text-gray-500 uppercase tracking-wider">{label}</div>
      <div className={`text-2xl font-semibold mt-1 ${valueClass}`}>{value}</div>
    </div>
  );
}
