import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
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
  /**
   * Zweitspur zu `projectNames`: der Effekt unten liest nur, ob ein Name schon
   * bekannt ist. Als State gelesen müsste `projectNames` in die Dep-Liste — und
   * damit hinge der Sucheffekt an einem Objekt, das er selbst neu setzt. Für
   * eine projectId, die `api.projects.list()` nicht (mehr) liefert, wäre das
   * eine Endlosschleife aus Suche → setProjectNames → Suche.
   */
  const knownProjectNames = useRef<Record<string, string>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const location = useLocation();

  // Detect current project from URL
  const projectMatch = location.pathname.match(/^\/projects\/([a-f0-9]{24})/);
  const currentProjectId = projectMatch?.[1];

  /**
   * Der Suchbereich ist **abgeleitet**, nicht gespeichert: Standard ist „aktuelles
   * Projekt, wenn wir in einem sind". Der Umschalt-Button überschreibt das — aber
   * nur für das Projekt, in dem er gedrückt wurde. Beim Navigieren in ein anderes
   * Projekt greift wieder der Standard.
   *
   * Vorher stand hier ein `useEffect(() => setScopeProject(!!currentProjectId))`.
   * Das ist genau der abgeleitete Zustand, den React nicht in einem Effekt sehen
   * will: der erste Render nach einem Projektwechsel zeigte noch den alten
   * Bereich, und der Sucheffekt lief mit dem alten Wert einmal umsonst.
   */
  const [scopeOverride, setScopeOverride] = useState<{ projectId?: string; value: boolean } | null>(
    null,
  );
  const scopeProject =
    scopeOverride && scopeOverride.projectId === currentProjectId
      ? scopeOverride.value
      : !!currentProjectId;
  const toggleScope = () =>
    setScopeOverride({ projectId: currentProjectId, value: !scopeProject });

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
      // `EventTarget` ist kein `Node` — `instanceof` prüft das, statt es wie
      // vorher mit `e.target as Node` nur zu behaupten.
      const target = e.target;
      if (containerRef.current && target instanceof Node && !containerRef.current.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Debounced search
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) return;

    /*
     * `cancelled` statt `AbortController`: `api.search.query` nimmt kein Signal
     * (die Signatur liegt in `api/client.ts`), die laufende Anfrage lässt sich
     * also nicht abbrechen. Ihr Ergebnis zu verwerfen genügt aber für das, was
     * hier schiefgehen kann — zwei überlappende Suchen, deren Antworten in
     * umgekehrter Reihenfolge eintreffen und die ältere die neuere überschreibt.
     */
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      try {
        const projectId = scopeProject ? currentProjectId : undefined;
        const data = await api.search.query(trimmed, projectId);
        if (cancelled) return;
        setResults(data);
        setSelectedIndex(-1);

        // Build project name map
        if (!scopeProject) {
          const ids = [...new Set(data.map((r) => r.projectId))];
          const missing = ids.filter((id) => !knownProjectNames.current[id]);
          if (missing.length > 0) {
            const projects = await api.projects.list();
            if (cancelled) return;
            const map: Record<string, string> = { ...knownProjectNames.current };
            for (const p of projects) map[p._id] = p.name;
            knownProjectNames.current = map;
            setProjectNames(map);
          }
        }
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    const timer = setTimeout(() => {
      void run();
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, scopeProject, currentProjectId]);

  const navigateToResult = useCallback(
    (result: SearchResult) => {
      // `navigate` liefert unter React Router 7 ein Promise, das nur bei einer
      // abgebrochenen/blockierten Navigation ablehnt — dafür ist der Router
      // zuständig, nicht diese Trefferliste.
      void navigate(getResultUrl(result));
      setOpen(false);
      setQuery('');
      inputRef.current?.blur();
    },
    [navigate],
  );

  /*
   * Gruppierung nach Typ, mit `Map` statt `Record<string, …>`: der Schlüssel
   * behält damit den Typ `SearchResult['type']` und die Kopfzeile unten braucht
   * kein `type as SearchResult['type']` mehr, um in `TYPE_LABELS` zu greifen.
   * Die Einfügereihenfolge der Map entspricht der bisherigen von
   * `Object.entries`, die Anzeige ändert sich also nicht.
   *
   * Bei leerer Eingabe wird nicht gruppiert: `results` behält den letzten
   * Treffersatz (das Feld leert der Nutzer, das Dropdown ist dann ohnehin zu),
   * die Tastaturnavigation soll aber nicht auf verwaisten Treffern laufen.
   */
  const groups = useMemo(() => {
    if (!query.trim()) return [];
    const byType = new Map<SearchResult['type'], SearchResult[]>();
    for (const r of results) {
      const bucket = byType.get(r.type);
      if (bucket) bucket.push(r);
      else byType.set(r.type, [r]);
    }
    return [...byType].map(([type, items]) => ({ type, items }));
  }, [results, query]);

  /**
   * Die Trefferliste **in Anzeigereihenfolge**.
   *
   * Das war ein echter Fehler: die Pfeiltasten liefen über `results` (Reihenfolge
   * der API-Antwort), die Anzeige zählte ihren Index aber über die
   * *gruppierten* Treffer. Sobald die Antwort Typen mischte — [todo, wissen,
   * todo] — markierte die Liste einen anderen Eintrag als den, den Enter
   * öffnete.
   */
  const ordered = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open || ordered.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev < ordered.length - 1 ? prev + 1 : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : ordered.length - 1));
    } else if (e.key === 'Enter' && selectedIndex >= 0) {
      e.preventDefault();
      const result = ordered[selectedIndex];
      if (result) navigateToResult(result);
    }
  };

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
            onClick={toggleScope}
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
        <div className="absolute top-full mt-1 right-0 w-[calc(100vw-2rem)] sm:w-96 md:w-[28rem] max-h-[24rem] overflow-y-auto bg-gray-900 border border-gray-700 rounded-lg shadow-xl z-50">
          {ordered.length === 0 && !loading && (
            <div className="px-4 py-6 text-center text-gray-500 text-sm">
              {t('common.noResults', { query })}
            </div>
          )}
          {ordered.length === 0 && loading && (
            <div className="px-4 py-6 text-center text-gray-500 text-sm">
              {t('common.searching')}
            </div>
          )}
          {groups.map(({ type, items }) => (
            <div key={type}>
              <div className="px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider bg-gray-900/80 sticky top-0">
                {TYPE_LABELS[type]()} ({items.length})
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
