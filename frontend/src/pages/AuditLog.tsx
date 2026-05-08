import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import { useToast } from '../components/Toast';
import Card from '../components/ui/Card';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import { LoadingText } from '../components/ui/LoadingSpinner';

interface AuditEntry {
  _id: string;
  action: string;
  actorUserId?: string;
  actorUsername?: string;
  actorRole?: string;
  actorApiKeyId?: string;
  entityType?: string;
  entityId?: string;
  meta?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  timestamp: string;
}

const PAGE_SIZE = 50;

/**
 * Admin-only audit-log viewer. Lists events newest-first with action + actor
 * filters. Backend endpoint already enforces RolesGuard(ADMIN), so showing
 * this in the UI is just an UX nicety — direct curl with a non-admin token
 * is still 403.
 */
export default function AuditLog() {
  const { t, i18n } = useTranslation();
  const { showError } = useToast();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [actions, setActions] = useState<string[]>([]);
  const [actionFilter, setActionFilter] = useState<string>('');
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const dateLocale = i18n.language === 'de' ? 'de-DE' : 'en-US';

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.auditLog.list({
        action: actionFilter || undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });
      setEntries(res.items as AuditEntry[]);
      setTotal(res.total);
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [actionFilter, page]);
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

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <h1 className="text-xl sm:text-2xl font-bold mb-4 font-grimoire">{t('auditLog.title')}</h1>
      <p className="text-sm text-gray-500 mb-4">{t('auditLog.description')}</p>

      <div className="flex flex-col sm:flex-row gap-3 mb-4 items-start sm:items-center">
        <select
          value={actionFilter}
          onChange={(e) => { setActionFilter(e.target.value); setPage(0); }}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-violet-500 w-full sm:w-72"
        >
          <option value="">{t('auditLog.allActions')}</option>
          {actions.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
        <span className="text-xs text-gray-500">
          {t('auditLog.totalEntries', { count: total })}
        </span>
      </div>

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
            onClick={() => setPage((p) => Math.max(0, p - 1))}
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
            onClick={() => setPage((p) => p + 1)}
          >
            {t('auditLog.next')}
          </Button>
        </div>
      )}
    </div>
  );
}
