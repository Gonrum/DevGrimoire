import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, LogEntry, LogStats, Project } from '../api/client';
import EmptyState from './ui/EmptyState';
import Badge from './ui/Badge';
import Card from './ui/Card';
import { LoadingText } from './ui/LoadingSpinner';

const LEVEL_COLORS: Record<string, string> = {
  debug: 'bg-gray-800 text-gray-400',
  info: 'bg-blue-900/40 text-blue-300',
  warn: 'bg-yellow-900/40 text-yellow-300',
  error: 'bg-red-900/40 text-red-300',
};

const LEVEL_DOT: Record<string, string> = {
  debug: 'bg-gray-500',
  info: 'bg-blue-400',
  warn: 'bg-yellow-400',
  error: 'bg-red-400',
};

function formatTime(dateStr: string, locale: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) return locale === 'de' ? 'gerade eben' : 'just now';
  if (diffMin < 60) return `${diffMin}m`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h`;
  return date.toLocaleString(locale === 'de' ? 'de-DE' : 'en-US', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface LogListProps {
  /** Per-project mode. When undefined, the component runs in global mode. */
  projectId?: string;
  /** T-338: required in global mode — for project filter + per-row project label. */
  projects?: Project[];
}

export default function LogList({ projectId, projects }: LogListProps) {
  const { i18n } = useTranslation();
  const globalMode = !projectId;
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [stats, setStats] = useState<LogStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [levelFilter, setLevelFilter] = useState<string | null>(null);
  const [serviceFilter, setServiceFilter] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [searchActive, setSearchActive] = useState('');
  // T-338: multi-project filter for global mode.
  const [projectFilter, setProjectFilter] = useState<string[]>([]);
  const projectsById = useMemo(() => {
    const map: Record<string, Project> = {};
    for (const p of projects ?? []) map[p._id] = p;
    return map;
  }, [projects]);

  const loadLogs = () => {
    setLoading(true);
    const fetch = globalMode
      ? api.logs.listGlobal({
          projectIds: projectFilter.length > 0 ? projectFilter : undefined,
          level: levelFilter || undefined,
          service: serviceFilter || undefined,
          search: searchActive || undefined,
          limit: 100,
        })
      : api.logs.list(projectId!, {
          level: levelFilter || undefined,
          service: serviceFilter || undefined,
          search: searchActive || undefined,
          limit: 100,
        });
    fetch
      .then(setLogs)
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    // Stats are per-project only — skip in global mode.
    if (globalMode) { setStats(null); return; }
    api.logs.stats(projectId!).then(setStats).catch(() => {});
  }, [projectId, globalMode]);

  useEffect(() => {
    loadLogs();
  }, [projectId, levelFilter, serviceFilter, searchActive, projectFilter.join(',')]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSearchActive(search);
  };

  const de = i18n.language === 'de';

  return (
    <div className="space-y-4">
      {/* Stats overview */}
      {stats && stats.total > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {(['error', 'warn', 'info', 'debug'] as const).map((level) => (
            <button
              key={level}
              type="button"
              onClick={() => setLevelFilter(levelFilter === level ? null : level)}
              className={`rounded-lg border p-3 text-center transition-colors ${
                levelFilter === level
                  ? 'border-cyan-700 bg-gray-800'
                  : 'border-gray-800 bg-gray-900 hover:bg-gray-800/50'
              }`}
            >
              <div className="text-2xl font-bold text-gray-200">
                {stats.byLevel[level] || 0}
              </div>
              <div className="text-xs text-gray-500 uppercase tracking-wide">{level}</div>
            </button>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <form onSubmit={handleSearchSubmit} className="flex-1 min-w-[200px]">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={de ? 'Logs durchsuchen...' : 'Search logs...'}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-violet-600"
          />
        </form>
        {!globalMode && stats && stats.byService.length > 0 && (
          <select
            value={serviceFilter || ''}
            onChange={(e) => setServiceFilter(e.target.value || null)}
            className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-gray-300 focus:outline-none focus:border-violet-600"
          >
            <option value="">{de ? 'Alle Services' : 'All services'}</option>
            {stats.byService.map((s) => (
              <option key={s.service} value={s.service}>
                {s.service} ({s.count})
              </option>
            ))}
          </select>
        )}
        {globalMode && (
          <input
            type="text"
            value={serviceFilter || ''}
            onChange={(e) => setServiceFilter(e.target.value || null)}
            placeholder={de ? 'Service-Name' : 'Service name'}
            className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-gray-300 focus:outline-none focus:border-violet-600"
            style={{ width: '160px' }}
          />
        )}
        {(['error', 'warn', 'info', 'debug'] as const).map((level) => (
          <button
            key={level}
            type="button"
            onClick={() => setLevelFilter(levelFilter === level ? null : level)}
            className={`rounded px-2 py-1 text-xs uppercase tracking-wide ${
              levelFilter === level ? `${LEVEL_COLORS[level]} ring-1 ring-cyan-500` : 'bg-gray-800 text-gray-500 hover:text-gray-300'
            }`}
          >
            {level}
          </button>
        ))}
        {(levelFilter || serviceFilter || searchActive || projectFilter.length > 0) && (
          <button
            type="button"
            onClick={() => { setLevelFilter(null); setServiceFilter(null); setSearch(''); setSearchActive(''); setProjectFilter([]); }}
            className="text-xs text-gray-500 hover:text-gray-300 px-2 py-1"
          >
            {de ? 'Filter zurücksetzen' : 'Clear filters'}
          </button>
        )}
      </div>

      {/* T-338: project multi-select for global mode */}
      {globalMode && projects && projects.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-gray-500 mr-1">{de ? 'Projekte:' : 'Projects:'}</span>
          {projects.map((p) => {
            const sel = projectFilter.includes(p._id);
            return (
              <button
                key={p._id}
                type="button"
                onClick={() => setProjectFilter((prev) => sel ? prev.filter((id) => id !== p._id) : [...prev, p._id])}
                className={`text-xs rounded-full px-2 py-0.5 transition-colors ${sel ? 'bg-cyan-700 text-cyan-100' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
              >
                {p.name}
              </button>
            );
          })}
          {projectFilter.length > 0 && (
            <span className="text-xs text-gray-500">({projectFilter.length} {de ? 'aktiv' : 'active'})</span>
          )}
        </div>
      )}

      {/* Log entries */}
      {loading ? (
        <LoadingText />
      ) : logs.length === 0 ? (
        <EmptyState
          message={
            stats && stats.total === 0
              ? de
                ? 'Noch keine Logs. Sende Logs per API Key an POST /api/logs'
                : 'No logs yet. Send logs via API key to POST /api/logs'
              : de
                ? 'Keine Logs mit diesen Filtern gefunden'
                : 'No logs match these filters'
          }
        />
      ) : (
        <Card padding="none">
          <div className="divide-y divide-gray-800/50">
            {logs.map((log) => (
              <div key={log._id} className="px-4 py-2.5 hover:bg-gray-800/30 transition-colors">
                <div className="flex items-start gap-3">
                  <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${LEVEL_DOT[log.level]}`} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-200 font-mono break-all leading-relaxed">
                      {log.message}
                    </p>
                    <div className="flex flex-wrap items-center gap-2 mt-1">
                      <Badge color={LEVEL_COLORS[log.level]} rounded="full">
                        {log.level}
                      </Badge>
                      {log.service && (
                        <span className="text-xs text-gray-500">{log.service}</span>
                      )}
                      {log.area && (
                        <span className="text-xs text-gray-600">{log.area}</span>
                      )}
                      {log.environment && (
                        <Badge color="bg-gray-800 text-gray-400" rounded="full">
                          {log.environment}
                        </Badge>
                      )}
                      {log.tags?.map((tag) => (
                        <Badge key={tag} color="bg-violet-900/30 text-violet-300" rounded="full">
                          {tag}
                        </Badge>
                      ))}
                      {globalMode && log.projectId && projectsById[log.projectId] && (
                        <Link
                          to={`/projects/${log.projectId}?tab=logs`}
                          className="text-xs text-cyan-400 hover:text-cyan-300"
                        >
                          {projectsById[log.projectId].name}
                        </Link>
                      )}
                      <span className="text-xs text-gray-600 ml-auto shrink-0">
                        {formatTime(log.createdAt, i18n.language)}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Info footer */}
      {stats && stats.total > 0 && (
        <p className="text-xs text-gray-600 text-center">
          {stats.total} {de ? 'Einträge gesamt' : 'total entries'} &middot;{' '}
          {de ? 'Automatische Löschung nach 5 Tagen' : 'Auto-deleted after 5 days'}
        </p>
      )}
    </div>
  );
}
