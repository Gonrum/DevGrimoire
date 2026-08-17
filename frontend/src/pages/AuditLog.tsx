import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, AuditLogFilters, AuditLogItem } from '../api/client';
import { useToast } from '../components/Toast';
import Card from '../components/ui/Card';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import { LoadingText } from '../components/ui/LoadingSpinner';
import { errorMessage, matchOption } from '../lib/narrow';

const PAGE_SIZE = 50;

/**
 * Die Akteurstypen als Laufzeit-Liste. Der Wert kommt aus der URL bzw. einem
 * `<select>` — beides `string`. Ein `as AuditLogFilters['actorType']` haette das
 * behauptet und einen fremden `?actorType=`-Parameter unveraendert an das
 * Backend weitergegeben; geprueft wird er jetzt zu `undefined`.
 */
const ACTOR_TYPES = ['user', 'apikey', 'system'] as const;

/**
 * Admin-only audit-log viewer. Lists events newest-first with action, actor,
 * type and timeframe filters. Filters are URL-shareable (T-339). Backend
 * endpoint enforces RolesGuard(ADMIN) so direct curl is still 403.
 */
export default function AuditLog() {
  const { t, i18n } = useTranslation();
  const { showError, showSuccess } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  // T-339: hydrate filters from URL on mount, write them back on change.
  const filters: AuditLogFilters = useMemo(() => ({
    action: searchParams.get('action') || undefined,
    actionPrefix: searchParams.get('actionPrefix') || undefined,
    actorType: matchOption(searchParams.get('actorType') ?? '', ACTOR_TYPES),
    since: searchParams.get('since') || undefined,
    until: searchParams.get('until') || undefined,
  }), [searchParams]);
  const page = parseInt(searchParams.get('page') || '0', 10) || 0;

  const updateFilter = (patch: Partial<AuditLogFilters & { page: number }>) => {
    const next = new URLSearchParams(searchParams);
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === null || v === '') next.delete(k);
      else next.set(k, String(v));
    }
    // Reset to page 0 when any filter changes (except pagination itself).
    if (patch.page === undefined && Object.keys(patch).some((k) => k !== 'page')) {
      next.delete('page');
    }
    setSearchParams(next);
  };

  const [entries, setEntries] = useState<AuditLogItem[]>([]);
  const [total, setTotal] = useState(0);
  const [actions, setActions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const dateLocale = i18n.language === 'de' ? 'de-DE' : 'en-US';

  /*
   * Der Ladevorgang liegt im Effekt statt in einer `load`-Funktion daneben:
   * damit kann der Cleanup ihn als veraltet markieren. Vorher konnten zwei
   * schnell aufeinanderfolgende Filterwechsel in umgekehrter Reihenfolge
   * zurueckkommen und die aeltere Antwort die neuere ueberschreiben — die Liste
   * passte dann nicht zu den angezeigten Filtern.
   *
   * Die frueher unterdrueckte Dep-Liste zaehlte die Filterfelder einzeln auf.
   * `filters` selbst ist `useMemo`-stabil (Abhaengigkeit `searchParams`), die
   * vollstaendige Liste dreht also keine Schleife.
   */
  useEffect(() => {
    let cancelled = false;
    async function run() {
      setLoading(true);
      try {
        const res = await api.auditLog.list({
          ...filters,
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
        });
        if (cancelled) return;
        setEntries(res.items);
        setTotal(res.total);
      } catch (err) {
        if (!cancelled) showError(errorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void run();
    return () => { cancelled = true; };
  }, [filters, page, showError]);
  useEffect(() => {
    api.auditLog.actions().then(setActions).catch(() => setActions([]));
  }, []);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const res = await api.auditLog.exportAll(filters);
      const blob = new Blob([JSON.stringify(res.items, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      a.download = `audit-log-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showSuccess(
        res.truncated
          ? t('auditLog.exportTruncated', { count: res.items.length })
          : t('auditLog.exportSuccess', { count: res.items.length }),
      );
    } catch (err) {
      showError(errorMessage(err));
    } finally {
      setExporting(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const actionPrefixes = useMemo(() => {
    const set = new Set<string>();
    for (const a of actions) {
      const dot = a.indexOf('.');
      if (dot > 0) set.add(a.slice(0, dot));
    }
    return Array.from(set).sort();
  }, [actions]);

  return (
    <div>
      <div className="flex items-start justify-between mb-4 flex-wrap gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold font-grimoire">{t('auditLog.title')}</h1>
          <p className="text-sm text-gray-500 mt-1">{t('auditLog.description')}</p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => { void handleExport(); }} disabled={exporting}>
          {exporting ? t('auditLog.exportRunning') : t('auditLog.exportButton')}
        </Button>
      </div>

      <div className="flex flex-wrap gap-2 mb-2">
        <select
          value={filters.action || ''}
          onChange={(e) => updateFilter({ action: e.target.value || undefined })}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-violet-500 min-w-[200px]"
        >
          <option value="">{t('auditLog.allActions')}</option>
          {actions.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
        <select
          value={filters.actionPrefix || ''}
          onChange={(e) => updateFilter({ actionPrefix: e.target.value || undefined })}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-violet-500"
          disabled={!!filters.action}
          title={filters.action ? t('auditLog.prefixDisabled') : undefined}
        >
          <option value="">{t('auditLog.allDomains')}</option>
          {actionPrefixes.map((p) => (
            <option key={p} value={p}>{p}.*</option>
          ))}
        </select>
        <select
          value={filters.actorType || ''}
          onChange={(e) => updateFilter({ actorType: matchOption(e.target.value, ACTOR_TYPES) })}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-violet-500"
        >
          <option value="">{t('auditLog.allActors')}</option>
          <option value="user">{t('auditLog.actorUser')}</option>
          <option value="apikey">{t('auditLog.actorApiKey')}</option>
          <option value="system">{t('auditLog.actorSystem')}</option>
        </select>
        <input
          type="datetime-local"
          value={filters.since ? filters.since.slice(0, 16) : ''}
          onChange={(e) => updateFilter({ since: e.target.value ? new Date(e.target.value).toISOString() : undefined })}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-violet-500"
          title={t('auditLog.since')}
        />
        <input
          type="datetime-local"
          value={filters.until ? filters.until.slice(0, 16) : ''}
          onChange={(e) => updateFilter({ until: e.target.value ? new Date(e.target.value).toISOString() : undefined })}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-violet-500"
          title={t('auditLog.until')}
        />
        {(filters.action || filters.actionPrefix || filters.actorType || filters.since || filters.until) && (
          <button
            type="button"
            onClick={() => setSearchParams(new URLSearchParams())}
            className="text-xs text-gray-500 hover:text-gray-300 px-2 py-1"
          >
            {t('auditLog.clearFilters')}
          </button>
        )}
      </div>

      <p className="text-xs text-gray-500 mb-4">{t('auditLog.totalEntries', { count: total })}</p>

      {loading ? (
        <LoadingText />
      ) : entries.length === 0 ? (
        <Card padding="md">
          <p className="text-sm text-gray-500">{t('auditLog.empty')}</p>
        </Card>
      ) : (
        <div className="space-y-2">
          {entries.map((entry) => {
            const isOpen = expanded.has(entry._id);
            return (
              <Card key={entry._id} padding="none" className="px-4 py-3">
                <div className="flex items-start gap-3 flex-wrap">
                  <div className="text-xs text-gray-500 whitespace-nowrap min-w-[140px]">
                    {new Date(entry.timestamp).toLocaleString(dateLocale)}
                  </div>
                  <Badge color="bg-violet-900/40 text-violet-200 border border-violet-800/50">
                    {entry.action}
                  </Badge>
                  {entry.actorUsername && (
                    <Badge color="bg-gray-800 text-gray-300">
                      {entry.actorUsername}
                      {entry.actorRole === 'admin' && <span className="ml-1 text-purple-300">★</span>}
                      {entry.actorApiKeyId && <span className="ml-1 text-amber-300">⚙</span>}
                    </Badge>
                  )}
                  {!entry.actorUsername && !entry.actorApiKeyId && (
                    <Badge color="bg-gray-800 text-gray-500">{t('auditLog.actorSystem')}</Badge>
                  )}
                  {entry.entityType && (
                    <Badge color="bg-gray-800 text-gray-400">
                      {entry.entityType}
                      {entry.entityId && ` · ${entry.entityId.slice(-6)}`}
                    </Badge>
                  )}
                  {entry.meta && Object.keys(entry.meta).length > 0 && (
                    <button
                      type="button"
                      onClick={() => toggle(entry._id)}
                      className="ml-auto text-xs text-violet-300 hover:text-violet-200"
                    >
                      {isOpen ? t('auditLog.hideDetails') : t('auditLog.showDetails')}
                    </button>
                  )}
                </div>
                {isOpen && entry.meta && (
                  <pre className="mt-2 text-[11px] bg-gray-950 border border-gray-800 rounded p-2 overflow-x-auto text-gray-300">
                    {JSON.stringify(entry.meta, null, 2)}
                  </pre>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex justify-between items-center mt-4 text-sm text-gray-400">
          <Button
            variant="secondary"
            size="sm"
            disabled={page === 0}
            onClick={() => updateFilter({ page: Math.max(0, page - 1) })}
          >
            {t('auditLog.prev')}
          </Button>
          <span className="text-xs">
            {t('auditLog.page', { current: page + 1, total: totalPages })}
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={page + 1 >= totalPages}
            onClick={() => updateFilter({ page: page + 1 })}
          >
            {t('auditLog.next')}
          </Button>
        </div>
      )}
    </div>
  );
}
