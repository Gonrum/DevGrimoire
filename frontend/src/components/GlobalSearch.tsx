import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, SearchResult } from '../api/client';
import { TYPE_LABELS, TYPE_COLORS } from '../constants/colors';
import LoadingSpinner from './ui/LoadingSpinner';

function getResultUrl(result: SearchResult): string {
  switch (result.type) {
    case 'todo':
      return `/projects/${result.projectId}?tab=todos`;
    case 'knowledge':
      return `/projects/${result.projectId}?tab=knowledge`;
    case 'changelog':
      return `/projects/${result.projectId}?tab=changelog`;
    case 'research':
      return `/projects/${result.projectId}?tab=research`;
    case 'milestone':
      return `/projects/${result.projectId}?tab=milestones`;
  }
}

export default function GlobalSearch() {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [projectNames, setProjectNames] = useState<Record<string, string>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const location = useLocation();

  // Detect current project from URL
  const projectMatch = location.pathname.match(/^\/projects\/([a-f0-9]{24})/);
  const currentProjectId = projectMatch?.[1];
  const [scopeProject, setScopeProject] = useState(!!currentProjectId);

  // Update scope when navigating
  useEffect(() => {
    setScopeProject(!!currentProjectId);
  }, [currentProjectId]);

  // Ctrl+K shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
      if (e.key === 'Escape') {
        setOpen(false);
        inputRef.current?.blur();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Click outside to close
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Debounced search
  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const projectId = scopeProject ? currentProjectId : undefined;
        const data = await api.search.query(query.trim(), projectId);
        setResults(data);
        setSelectedIndex(-1);

        // Build project name map
        if (!scopeProject) {
          const ids = [...new Set(data.map((r) => r.projectId))];
          const missing = ids.filter((id) => !projectNames[id]);
          if (missing.length > 0) {
            const projects = await api.projects.list();
            const map: Record<string, string> = { ...projectNames };
            for (const p of projects) map[p._id] = p.name;
            setProjectNames(map);
          }
        }
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query, scopeProject, currentProjectId]);

  const navigateToResult = useCallback(
    (result: SearchResult) => {
      navigate(getResultUrl(result));
      setOpen(false);
      setQuery('');
      inputRef.current?.blur();
    },
    [navigate],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open || results.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev < results.length - 1 ? prev + 1 : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : results.length - 1));
    } else if (e.key === 'Enter' && selectedIndex >= 0) {
      e.preventDefault();
      navigateToResult(results[selectedIndex]);
    }
  };

  // Group results by type
  const grouped = results.reduce(
    (acc, r) => {
      if (!acc[r.type]) acc[r.type] = [];
      acc[r.type].push(r);
      return acc;
    },
    {} as Record<string, SearchResult[]>,
  );

  let flatIndex = -1;

  return (
    <div ref={containerRef} className="relative">
      <div className="flex items-center gap-1.5">
        <div className="relative">
          <input
            ref={inputRef}
            type="text"
            placeholder={t('common.search')}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
            }}
            onFocus={() => {
              if (query.trim()) setOpen(true);
            }}
            onKeyDown={handleKeyDown}
            className="w-48 sm:w-64 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-violet-500 transition-colors"
          />
          {loading && (
            <div className="absolute right-2 top-1/2 -translate-y-1/2">
              <LoadingSpinner size="sm" />
            </div>
          )}
        </div>
        {currentProjectId && (
          <button
            type="button"
            onClick={() => setScopeProject((prev) => !prev)}
            className={`text-xs px-2 py-1 rounded transition-colors whitespace-nowrap ${
              scopeProject
                ? 'bg-violet-900 text-cyan-300 hover:bg-violet-800'
                : 'bg-gray-800 text-gray-500 hover:bg-gray-700'
            }`}
            title={scopeProject ? t('search.projectScope') : t('search.globalScope')}
          >
            {scopeProject ? t('search.project') : t('search.global')}
          </button>
        )}
      </div>

      {open && query.trim() && (
        <div className="absolute top-full mt-1 right-0 w-[28rem] max-h-[24rem] overflow-y-auto bg-gray-900 border border-gray-700 rounded-lg shadow-xl z-50">
          {results.length === 0 && !loading && (
            <div className="px-4 py-6 text-center text-gray-500 text-sm">
              {t('common.noResults', { query })}
            </div>
          )}
          {results.length === 0 && loading && (
            <div className="px-4 py-6 text-center text-gray-500 text-sm">
              {t('common.searching')}
            </div>
          )}
          {Object.entries(grouped).map(([type, items]) => (
            <div key={type}>
              <div className="px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider bg-gray-900/80 sticky top-0">
                {TYPE_LABELS[type as SearchResult['type']]()} ({items.length})
              </div>
              {items.map((result) => {
                flatIndex++;
                const idx = flatIndex;
                return (
                  <button
                    key={`${result.type}-${result.id}`}
                    type="button"
                    onClick={() => navigateToResult(result)}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    className={`w-full text-left px-3 py-2 flex items-start gap-2 transition-colors ${
                      selectedIndex === idx
                        ? 'bg-gray-800'
                        : 'hover:bg-gray-800/50'
                    }`}
                  >
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded mt-0.5 shrink-0 ${TYPE_COLORS[result.type]}`}
                    >
                      {TYPE_LABELS[result.type]()}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-gray-200 truncate">
                        {result.title}
                      </div>
                      {result.snippet && (
                        <div className="text-xs text-gray-500 truncate">
                          {result.snippet}
                        </div>
                      )}
                    </div>
                    {!scopeProject && projectNames[result.projectId] && (
                      <span className="text-[10px] text-gray-600 shrink-0 mt-0.5">
                        {projectNames[result.projectId]}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
